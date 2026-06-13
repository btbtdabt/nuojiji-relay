// 持久主动状态（Node，RELAY_STORE=sqlite）。整条 record 以 JSON 存一列，简单可靠。

import { createRequire } from 'node:module';
import { makePairKey, mergeProactiveRecord } from './proactiveStore.js';

// 计算式 require：阻止 esbuild/wrangler 把 better-sqlite3(Node-only)静态打进 Workers bundle。
function loadSqlite() {
    const require = createRequire(import.meta.url);
    return require(['better', 'sqlite3'].join('-'));
}

export class SqliteProactiveStore {
    constructor(path = './outbox.db') {
        this.kind = 'sqlite';
        const Database = loadSqlite();
        this.db = new Database(path);
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS proactive (
                pairKey  TEXT PRIMARY KEY,
                inboxId  TEXT NOT NULL,
                enabled  INTEGER NOT NULL DEFAULT 0,
                data     TEXT NOT NULL,
                updatedAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_proactive_enabled ON proactive(enabled);
            CREATE INDEX IF NOT EXISTS idx_proactive_inbox ON proactive(inboxId);
            CREATE TABLE IF NOT EXISTS proactive_pause (
                inboxId     TEXT PRIMARY KEY,
                pausedUntil INTEGER NOT NULL
            );
        `);
    }
    // inbox 级暂停：走线下剧情时手机端调 /proactive/pause，tick 跳过该 inbox 的所有 pair。
    async setPause(inboxId, pausedUntil) {
        if (pausedUntil && pausedUntil > Date.now()) {
            this.db.prepare('INSERT OR REPLACE INTO proactive_pause (inboxId, pausedUntil) VALUES (?,?)')
                .run(inboxId, pausedUntil);
        } else {
            this.db.prepare('DELETE FROM proactive_pause WHERE inboxId = ?').run(inboxId);
        }
    }
    async getPausedUntil(inboxId) {
        const row = this.db.prepare('SELECT pausedUntil FROM proactive_pause WHERE inboxId = ?').get(inboxId);
        const until = row ? Number(row.pausedUntil) : 0;
        if (until && until <= Date.now()) {
            this.db.prepare('DELETE FROM proactive_pause WHERE inboxId = ?').run(inboxId);
            return 0;
        }
        return until;
    }
    async upsert(rec) {
        const key = makePairKey(rec.inboxId, rec.userId, rec.charId);
        const prevRow = this.db.prepare('SELECT data FROM proactive WHERE pairKey = ?').get(key);
        const prev = prevRow ? JSON.parse(prevRow.data) : {};
        const merged = mergeProactiveRecord(prev, rec);
        this.db.prepare(
            'INSERT OR REPLACE INTO proactive (pairKey, inboxId, enabled, data, updatedAt) VALUES (?,?,?,?,?)'
        ).run(key, merged.inboxId, merged.enabled ? 1 : 0, JSON.stringify(merged), merged.updatedAt);
    }
    async patch(inboxId, userId, charId, patch) {
        const key = makePairKey(inboxId, userId, charId);
        const row = this.db.prepare('SELECT data FROM proactive WHERE pairKey = ?').get(key);
        if (!row) return false;
        const merged = mergeProactiveRecord(JSON.parse(row.data), patch);
        this.db.prepare('UPDATE proactive SET enabled=?, data=?, updatedAt=? WHERE pairKey=?')
            .run(merged.enabled ? 1 : 0, JSON.stringify(merged), merged.updatedAt, key);
        return true;
    }
    async remove(inboxId, userId, charId) {
        this.db.prepare('DELETE FROM proactive WHERE pairKey = ?').run(makePairKey(inboxId, userId, charId));
    }
    async listEnabled() {
        return this.db.prepare('SELECT data FROM proactive WHERE enabled = 1').all().map(r => JSON.parse(r.data));
    }
    async listByInbox(inboxId) {
        return this.db.prepare('SELECT data FROM proactive WHERE inboxId = ?').all(inboxId).map(r => JSON.parse(r.data));
    }
    async get(inboxId, userId, charId) {
        const row = this.db.prepare('SELECT data FROM proactive WHERE pairKey = ?').get(makePairKey(inboxId, userId, charId));
        return row ? JSON.parse(row.data) : null;
    }
}
