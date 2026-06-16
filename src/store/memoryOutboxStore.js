// 内存 outbox（Node 默认）。重启即清空——对中继场景可接受（TTL 本就只几十分钟）。

import { DEFAULT_TTL_MS } from './outboxStore.js';

export class MemoryOutboxStore {
    constructor(ttlMs = DEFAULT_TTL_MS) {
        this.ttlMs = ttlMs;
        this.kind = 'memory';
        // inboxId -> Map<id, item>
        this.byInbox = new Map();
        // requestId -> { createdAt, status }（去重）
        this.requestIds = new Map();
        // 定时清扫
        this._timer = setInterval(() => this.sweep(), 60_000);
        if (this._timer.unref) this._timer.unref();
    }

    // 已见过该 requestId（且未过期）→ true
    seenRequest(requestId) {
        const mark = this.getRequestMark(requestId);
        return !!mark?.seen;
    }

    getRequestMark(requestId) {
        const raw = this.requestIds.get(requestId);
        if (raw == null) return { seen: false };
        const mark = (raw && typeof raw === 'object')
            ? raw
            : { createdAt: Number(raw) || 0, status: 'completed' };
        const createdAt = Number(mark.createdAt) || 0;
        if (!createdAt || Date.now() - createdAt > this.ttlMs) {
            this.requestIds.delete(requestId);
            return { seen: false };
        }
        return {
            seen: true,
            createdAt,
            status: mark.status === 'started' ? 'started' : 'completed',
        };
    }

    markRequest(requestId, status = 'started') {
        this.requestIds.set(requestId, {
            createdAt: Date.now(),
            status: status === 'completed' ? 'completed' : 'started',
        });
    }

    async put(inboxId, item) {
        if (!this.byInbox.has(inboxId)) this.byInbox.set(inboxId, new Map());
        this.byInbox.get(inboxId).set(item.id, item);
        this.markRequest(item.requestId, 'completed');
    }

    async list(inboxId, sinceTs = 0) {
        const m = this.byInbox.get(inboxId);
        if (!m) return [];
        return [...m.values()]
            .filter((it) => it.createdAt > sinceTs)
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    async ack(inboxId, ids = []) {
        const m = this.byInbox.get(inboxId);
        if (!m) return 0;
        let n = 0;
        for (const id of ids) if (m.delete(id)) n++;
        if (m.size === 0) this.byInbox.delete(inboxId);
        return n;
    }

    sweep() {
        const cutoff = Date.now() - this.ttlMs;
        for (const [inboxId, m] of this.byInbox) {
            for (const [id, it] of m) if (it.createdAt < cutoff) m.delete(id);
            if (m.size === 0) this.byInbox.delete(inboxId);
        }
        for (const [rid, raw] of this.requestIds) {
            const ts = raw && typeof raw === 'object' ? Number(raw.createdAt) || 0 : Number(raw) || 0;
            if (ts < cutoff) this.requestIds.delete(rid);
        }
    }
}
