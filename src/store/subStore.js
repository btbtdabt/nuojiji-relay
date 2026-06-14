// 推送订阅存储（按 inboxId）。一个 inbox 可有多个订阅（web/apns/fcm 多端）。
// 复用 outboxStore 的同后端：Workers 用同一个 KV，Node 用内存（订阅长期有效，
// 内存方案重启丢失 → 手机下次订阅会重新注册，可接受；持久需求走 sqlite 时一并落库）。
//
// 为简单起见，Phase 1 用独立的轻量实现，共享 createOutboxStore 选出的后端种类判断。

let _nodeSingleton = null;

export async function createSubStore(env) {
    if (env && env.OUTBOX && typeof env.OUTBOX.put === 'function') {
        return new KvSubStore(env.OUTBOX);
    }
    if (!_nodeSingleton) _nodeSingleton = new MemorySubStore();
    return _nodeSingleton;
}

const SUB_TTL_SEC = 60 * 60 * 24 * 60; // 60 天

class KvSubStore {
    constructor(kv) { this.kv = kv; }
    async _getIdx(inboxId) {
        const raw = await this.kv.get(`sidx:${inboxId}`);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string' && key) : [];
        } catch {
            return [];
        }
    }
    async _putIdx(inboxId, keys) {
        await this.kv.put(`sidx:${inboxId}`, JSON.stringify([...new Set(keys)]), { expirationTtl: SUB_TTL_SEC });
    }
    async _addToIdx(inboxId, key) {
        const idx = await this._getIdx(inboxId);
        if (!idx.includes(key)) {
            idx.push(key);
            await this._putIdx(inboxId, idx);
        }
    }
    async _removeFromIdx(inboxId, key) {
        const idx = await this._getIdx(inboxId);
        const next = idx.filter((item) => item !== key);
        if (next.length !== idx.length) await this._putIdx(inboxId, next);
    }
    async _listEntriesByPrefix(inboxId) {
        const out = [];
        let cursor;
        const prefix = `s:${inboxId}:`;
        do {
            const options = cursor ? { prefix, cursor } : { prefix };
            const res = await this.kv.list(options);
            for (const k of res.keys || []) {
                const raw = await this.kv.get(k.name);
                if (!raw) continue;
                try {
                    out.push({ key: k.name.slice(prefix.length), value: JSON.parse(raw) });
                } catch { /* skip corrupt */ }
            }
            cursor = res.list_complete ? null : res.cursor;
        } while (cursor);
        return out;
    }
    async _listEntries(inboxId) {
        const idx = await this._getIdx(inboxId);
        const byKey = new Map();
        const liveKeys = [];
        let indexChanged = false;

        for (const key of idx) {
            const raw = await this.kv.get(`s:${inboxId}:${key}`);
            if (!raw) {
                indexChanged = true;
                continue;
            }
            try {
                byKey.set(key, JSON.parse(raw));
                liveKeys.push(key);
            } catch {
                indexChanged = true;
            }
        }

        // Migration/repair path for subscriptions written before sidx existed.
        for (const entry of await this._listEntriesByPrefix(inboxId)) {
            if (byKey.has(entry.key)) continue;
            byKey.set(entry.key, entry.value);
            liveKeys.push(entry.key);
            indexChanged = true;
        }

        if (indexChanged) {
            try { await this._putIdx(inboxId, liveKeys); } catch { /* best-effort repair */ }
        }

        return [...byKey.entries()].map(([key, value]) => ({ key, value }));
    }
    async add(inboxId, subscription) {
        const key = subKey(subscription);
        await this.kv.put(`s:${inboxId}:${key}`, JSON.stringify(subscription), { expirationTtl: SUB_TTL_SEC });
        await this._addToIdx(inboxId, key);
    }
    async list(inboxId) {
        return (await this._listEntries(inboxId)).map((entry) => entry.value);
    }
    async remove(inboxId, subscription) {
        const key = subKey(subscription);
        await this.kv.delete(`s:${inboxId}:${key}`);
        await this._removeFromIdx(inboxId, key);
    }
    // 清掉同 inbox 同 channel 下、key 不等于 keepKey 的旧订阅。
    // apns/fcm 是「每设备单 token」语义：token 轮换（重装/系统更新/恢复备份）会注册出新 key，
    // 旧 token 行在 60 天 TTL 内仍残留 → 每条推送/自检都发两遍。注册新 token 时顺手清旧的。
    async pruneChannel(inboxId, channel, keepKey) {
        const entries = await this._listEntries(inboxId);
        const nextKeys = [];
        let deleted = false;
        for (const { key, value } of entries) {
            if (key === keepKey) {
                nextKeys.push(key);
                continue;
            }
            const ch = value?.channel || value?.sub?.channel || 'web';
            if (ch === channel) {
                await this.kv.delete(`s:${inboxId}:${key}`);
                deleted = true;
            } else {
                nextKeys.push(key);
            }
        }
        if (deleted) await this._putIdx(inboxId, nextKeys);
    }
}

class MemorySubStore {
    constructor() { this.byInbox = new Map(); }
    async add(inboxId, subscription) {
        if (!this.byInbox.has(inboxId)) this.byInbox.set(inboxId, new Map());
        this.byInbox.get(inboxId).set(subKey(subscription), subscription);
    }
    async list(inboxId) {
        const m = this.byInbox.get(inboxId);
        return m ? [...m.values()] : [];
    }
    async remove(inboxId, subscription) {
        const m = this.byInbox.get(inboxId);
        if (m) m.delete(subKey(subscription));
    }
    async pruneChannel(inboxId, channel, keepKey) {
        const m = this.byInbox.get(inboxId);
        if (!m) return;
        for (const [key, parsed] of [...m.entries()]) {
            if (key === keepKey) continue;
            const ch = parsed?.channel || parsed?.sub?.channel || 'web';
            if (ch === channel) m.delete(key);
        }
    }
}

// 订阅去重键：web 用 endpoint，apns/fcm 用 token
export function subKey(subscription) {
    const s = subscription?.sub || subscription;
    return s?.endpoint || s?.token || subscription?.token || subscription?.channel || 'default';
}
