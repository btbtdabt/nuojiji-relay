// Cloudflare KV outbox（Workers）。KV 自带 expirationTtl 自动清理。
//
// ⚠️ KV 的 list() 是「最终一致」——刚 put 的 key 经常 list 不出来（全球同步延迟），
//    会导致手机刚生成的消息拉不到。但按 key 直接 get() 是强一致的。
//    所以这里不靠 list 扫 key，改为每个 inbox 维护一个索引 key `idx:<inboxId>`
//    （存 [{id, createdAt}] 数组），读取时 get 索引再逐个 get item —— 全程走强一致的 get。
//
// key 设计：
//   索引: `idx:<inboxId>`            → JSON [{id, createdAt}, ...]
//   item: `o:<inboxId>:<id>`         → JSON item
//   reqId: `r:<requestId>`           → 去重标记

import { resolveTtlMs } from './outboxStore.js';

export class KvOutboxStore {
    constructor(kv, env) {
        this.kv = kv;
        this.kind = 'kv';
        // TTL 可由 env.OUTBOX_TTL_MIN 覆盖（默认 6h）。索引剪枝与 KV expirationTtl 都用它。
        this.ttlMs = resolveTtlMs(env);
        this.ttlSec = Math.floor(this.ttlMs / 1000);
    }

    async seenRequest(requestId) {
        const v = await this.kv.get(`r:${requestId}`);
        return v != null;
    }

    async markRequest(requestId) {
        await this.kv.put(`r:${requestId}`, '1', { expirationTtl: this.ttlSec });
    }

    async _getIndex(inboxId) {
        const raw = await this.kv.get(`idx:${inboxId}`);
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
    }

    async _putIndex(inboxId, idx) {
        // 索引也按 TTL 过期；顺手剔除超 TTL 的条目，防止无限增长
        const cutoff = Date.now() - this.ttlMs;
        const pruned = idx.filter((e) => e.createdAt > cutoff);
        await this.kv.put(`idx:${inboxId}`, JSON.stringify(pruned), { expirationTtl: this.ttlSec });
    }

    async _listItemsByPrefix(inboxId) {
        if (!this.kv || typeof this.kv.list !== 'function') return [];

        const prefix = `o:${inboxId}:`;
        const out = [];
        let cursor;
        do {
            const options = cursor ? { prefix, cursor } : { prefix };
            const page = await this.kv.list(options);
            for (const key of page.keys || []) {
                const raw = await this.kv.get(key.name);
                if (!raw) continue;
                try {
                    const item = JSON.parse(raw);
                    const id = String(item.id || key.name.slice(prefix.length));
                    const createdAt = Number(item.createdAt) || 0;
                    if (id && createdAt > 0) out.push({ id, createdAt, item });
                } catch { /* skip corrupt */ }
            }
            cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
        return out;
    }

    async put(inboxId, item) {
        await this.kv.put(`o:${inboxId}:${item.id}`, JSON.stringify(item), { expirationTtl: this.ttlSec });
        const idx = await this._getIndex(inboxId);
        // 去重（同 id 不重复追加）
        if (!idx.some((e) => e.id === item.id)) idx.push({ id: item.id, createdAt: item.createdAt });
        await this._putIndex(inboxId, idx);
        await this.markRequest(item.requestId);
    }

    async list(inboxId, sinceTs = 0) {
        // ⚠️ 不能只信索引 idx:<inboxId>：put() 的「读索引→push→写索引」是非原子 read-modify-write，
        //    KV 无事务。两个 put 并发（如用户回复 + 同对 proactive tick，或连发两条）会互相覆盖索引：
        //    A 读到[]、B 读到[]、A 写[A]、B 写[B] → A 的索引条目丢失，但 o:inbox:A 数据还在 →
        //    list 永远返回不了 A → 「推送弹了、点进去没消息」（与网络无关，自有域名用户也中招）。
        //    修：除了走索引，再用 kv.list({prefix}) 兜底扫一遍 o:<inboxId>: 实际存在的 item key，
        //    两路按 id 去重合并。索引(强一致)抓最新刚 put 的；prefix-list(最终一致)抓被索引覆盖丢的。
        const idx = await this._getIndex(inboxId);
        const itemsById = new Map();
        const liveIndex = [];
        let indexChanged = false;

        for (const e of idx) {
            const raw = await this.kv.get(`o:${inboxId}:${e.id}`);
            if (raw) {
                try {
                    const item = JSON.parse(raw);
                    const id = String(item.id || e.id);
                    const createdAt = Number(item.createdAt) || Number(e.createdAt) || 0;
                    if (id && createdAt > 0) {
                        itemsById.set(id, { ...item, id, createdAt });
                        liveIndex.push({ id, createdAt });
                    }
                } catch { indexChanged = true; }
            } else {
                indexChanged = true;
            }
            // raw 为 null = item 已过期被 KV 清，但索引还在 → 下面 list 时不返回；ack/prune 会清索引
        }

        // KV prefix scans are quota-limited. Keep orphan repair off the hot path;
        // only try it when the index is empty, and never let quota exhaustion fail reads.
        if (idx.length === 0) {
            try {
                for (const entry of await this._listItemsByPrefix(inboxId)) {
                    if (itemsById.has(entry.id)) continue;
                    itemsById.set(entry.id, entry.item);
                    liveIndex.push({ id: entry.id, createdAt: entry.createdAt });
                    indexChanged = true;
                }
            } catch {
                // Indexed outbox reads still work when KV list quota is exhausted.
            }
        }

        if (indexChanged) {
            try { await this._putIndex(inboxId, liveIndex); } catch { /* best-effort repair */ }
        }

        const out = [...itemsById.values()]
            .filter((item) => (Number(item.createdAt) || 0) > sinceTs)
            .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
        return out;
    }

    async ack(inboxId, ids = []) {
        let n = 0;
        for (const id of ids) {
            await this.kv.delete(`o:${inboxId}:${id}`);
            n++;
        }
        // Do not rewrite idx here. KV has no compare-and-swap, so an ack racing
        // with put() can clobber freshly indexed items. list() tolerates stale
        // index entries by get()ing each item key and pruning best-effort.
        return n;
    }

    sweep() { /* KV TTL 自动清理 */ }
}
