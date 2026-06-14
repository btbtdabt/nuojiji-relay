// 主动消息状态存储（Phase 2）—— 按 pair 持久化后端代理主动生成所需的全部状态。
//
// pairKey = `${inboxId}:${userId}:${charId}`
// record  = {
//   inboxId, userId, charId,
//   promptTemplate,          // 手机端拼好的完整 system prompt，含 {{RECENT_MESSAGES}} / {{IMPULSE_REASON}} 占位
//   proactiveProfile,        // 纯数值 profile（weights/threshold/quietHours/...）
//   lifeState,               // {moodIntensity, pendingUserQuestion, lastImpulseAt, lastProactiveSentAt, chitchatCooldownUntil, ...}
//   intensity, proactiveBias,
//   recentMessages,          // 滑窗（cap 30），整窗替换
//   aiSettings,              // {mainApiUrl, mainApiKey, mainApiModel, apiType, temperature, maxTokens?}
//   quietHours, charUtcOffsetSeconds,
//   proactiveEnabledAt,
//   lastInteractionAt,
//   lastFiredAt,             // 后端上次 cron 触发发送时间（防重复 + 简单冷却）
//   enabled, updatedAt,
// }
//
// 🔒 promptTemplate 是手机端拼好的文本，后端只 String.replaceAll 占位符，不含任何提示词逻辑。

import { mergePendingCommitments } from '../util/commitments.js';

export const PROACTIVE_WINDOW_CAP = 30;
// 后端 cron 触发后的最小静默（防 1 分钟 cron 连发；与手机端冷却独立）
export const BACKEND_FIRE_COOLDOWN_MS = 20 * 60 * 1000;
// 单次生成可能经历主 API 重试 + fallback；claim 用来避免中途重入重复生成。
export const PROACTIVE_GENERATION_CLAIM_TTL_MS = 15 * 60 * 1000;
const PROACTIVE_RUNTIME_TTL_SEC = 7 * 24 * 60 * 60;

export function makePairKey(inboxId, userId, charId) {
    return `${inboxId}:${String(userId)}:${String(charId)}`;
}

function omitUndefined(obj) {
    return Object.fromEntries(Object.entries(obj || {}).filter(([, value]) => value !== undefined));
}

function maxNumber(a, b) {
    const aa = Number(a) || 0;
    const bb = Number(b) || 0;
    return Math.max(aa, bb);
}

function isUserMessage(message) {
    return message?.sender === 'me' || message?.role === 'user';
}

function latestMessageIsUser(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    return isUserMessage(messages[messages.length - 1]);
}

function cloneRecord(record) {
    if (!record || typeof record !== 'object') return {};
    return JSON.parse(JSON.stringify(record));
}

function normalizeForBehaviorCompare(value, key = '') {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => normalizeForBehaviorCompare(item));

    const out = {};
    for (const childKey of Object.keys(value).sort()) {
        if (key === '' && (childKey === 'updatedAt' || childKey === 'registerMeta')) continue;
        const normalized = normalizeForBehaviorCompare(value[childKey], childKey);
        if (normalized !== undefined) out[childKey] = normalized;
    }
    return out;
}

export function proactiveRecordsBehaviorallyEqual(a, b) {
    return JSON.stringify(normalizeForBehaviorCompare(a || {})) === JSON.stringify(normalizeForBehaviorCompare(b || {}));
}

function mergeLifeState(prevLifeState, nextLifeState, { allowStreakDecrease = true } = {}) {
    const prev = (prevLifeState && typeof prevLifeState === 'object') ? prevLifeState : {};
    const next = (nextLifeState && typeof nextLifeState === 'object') ? nextLifeState : {};
    const merged = { ...prev, ...next };

    for (const key of ['lastImpulseAt', 'lastProactiveSentAt', 'chitchatCooldownUntil']) {
        const value = maxNumber(prev[key], next[key]);
        if (value > 0) merged[key] = value;
    }

    if (!allowStreakDecrease) {
        const prevStreak = Number(prev.unansweredStreak) || 0;
        const nextStreak = Number(next.unansweredStreak) || 0;
        if (prevStreak > nextStreak) merged.unansweredStreak = prevStreak;
    }

    return merged;
}

function applyFireMirror(rec, firedAt) {
    const ts = Number(firedAt) || 0;
    if (ts <= 0) return rec;

    const lifeState = (rec.lifeState && typeof rec.lifeState === 'object') ? { ...rec.lifeState } : {};
    const userRepliedAfterFire = (Number(rec.lastInteractionAt) || 0) > ts;
    const lastProactiveSentAt = Number(lifeState.lastProactiveSentAt) || 0;
    const activeGenerationStartedAt = Number(rec.generationStartedAt) || 0;
    const mirroredFireIsCurrentClaim = activeGenerationStartedAt > 0 && activeGenerationStartedAt <= ts;
    const lastFiredAt = Number(rec.lastFiredAt) || 0;

    if (mirroredFireIsCurrentClaim) {
        rec.generationStartedAt = 0;
        rec.generationClaimId = null;
    }

    if (ts < lastFiredAt) {
        rec.lifeState = lifeState;
        return rec;
    }

    rec.lastFiredAt = Math.max(lastFiredAt, ts);
    lifeState.lastImpulseAt = Math.max(Number(lifeState.lastImpulseAt) || 0, ts);
    lifeState.lastProactiveSentAt = Math.max(lastProactiveSentAt, ts);

    if (!userRepliedAfterFire) {
        rec.lastInteractionAt = Math.max(Number(rec.lastInteractionAt) || 0, ts);
        if (ts > lastProactiveSentAt) {
            lifeState.unansweredStreak = (Number(lifeState.unansweredStreak) || 0) + 1;
        }
    }

    rec.lifeState = lifeState;
    return rec;
}

export function mergeProactiveRecord(prevRecord, nextRecord, now = Date.now()) {
    const prev = prevRecord || {};
    const next = omitUndefined(nextRecord);
    const merged = { ...prev, ...next };
    const incomingInteractionAt = Number(next.lastInteractionAt) || 0;
    const incomingFiredAt = Number(next.lastFiredAt) || 0;
    const prevLastFiredAt = Number(prev.lastFiredAt) || 0;

    if (next.lifeState !== undefined) {
        const allowStreakDecrease = !prevLastFiredAt || incomingInteractionAt > prevLastFiredAt;
        merged.lifeState = mergeLifeState(prev.lifeState, next.lifeState, { allowStreakDecrease });
    }

    if (next.pendingCommitments !== undefined) {
        const utcOffsetSeconds = typeof next.timeSpec?.userUtcOffsetSeconds === 'number'
            ? next.timeSpec.userUtcOffsetSeconds
            : (typeof next.charUtcOffsetSeconds === 'number'
                ? next.charUtcOffsetSeconds
                : (typeof prev.timeSpec?.userUtcOffsetSeconds === 'number'
                    ? prev.timeSpec.userUtcOffsetSeconds
                    : (typeof prev.charUtcOffsetSeconds === 'number' ? prev.charUtcOffsetSeconds : null)));
        merged.pendingCommitments = mergePendingCommitments(prev.pendingCommitments, next.pendingCommitments, { now, utcOffsetSeconds });
    }

    const isServerFireWindowPatch = incomingFiredAt > 0
        && incomingInteractionAt >= incomingFiredAt
        && incomingFiredAt >= prevLastFiredAt;
    if (next.recentMessages !== undefined
        && prevLastFiredAt
        && incomingInteractionAt <= prevLastFiredAt
        && !isServerFireWindowPatch) {
        merged.recentMessages = prev.recentMessages;
    }

    if (next.lastInteractionAt !== undefined || prev.lastInteractionAt !== undefined) {
        merged.lastInteractionAt = maxNumber(prev.lastInteractionAt, next.lastInteractionAt);
    }

    if (next.lastFiredAt !== undefined || prev.lastFiredAt !== undefined) {
        merged.lastFiredAt = maxNumber(prev.lastFiredAt, next.lastFiredAt);
    }

    if (latestMessageIsUser(next.recentMessages)
        && incomingInteractionAt > (Number(merged.lastFiredAt) || 0)) {
        const lifeState = (merged.lifeState && typeof merged.lifeState === 'object') ? { ...merged.lifeState } : {};
        lifeState.unansweredStreak = 0;
        merged.lifeState = lifeState;
    }

    const incomingEnabledAt = (typeof next.proactiveEnabledAt === 'number' && next.proactiveEnabledAt > 0)
        ? next.proactiveEnabledAt : 0;
    const reenabled = prev.enabled === false && next.enabled === true;
    if (!prev.proactiveEnabledAt || reenabled) {
        merged.proactiveEnabledAt = incomingEnabledAt || now;
    } else {
        merged.proactiveEnabledAt = prev.proactiveEnabledAt;
    }
    merged.updatedAt = next.updatedAt || now;
    return merged;
}

// Node 进程级单例：HTTP 路由和 cron tick 必须共享同一个内存/sqlite 实例，
// 否则各拿各的新实例 → 注册的数据 tick 看不到。Workers 每次 fetch 新 env，KV 本就共享，不缓存。
let _nodeSingleton = null;

export async function createProactiveStore(env) {
    if (env && env.OUTBOX && typeof env.OUTBOX.put === 'function') {
        return new KvProactiveStore(env.OUTBOX);
    }
    if (_nodeSingleton) return _nodeSingleton;
    const storeKind = (typeof process !== 'undefined' && process.env?.RELAY_STORE) || 'memory';
    if (storeKind === 'sqlite') {
        try {
            // 计算式路径：阻止 esbuild/wrangler 把 sqlite store(及其 better-sqlite3 依赖)静态打进 Workers bundle。
            // 该文件只在 Node + RELAY_STORE=sqlite 时才加载。
            const mod = await import(/* @vite-ignore */ './sqliteProactiveStore' + '.js');
            _nodeSingleton = new mod.SqliteProactiveStore(process.env.RELAY_SQLITE_PATH || './outbox.db');
            return _nodeSingleton;
        } catch (e) {
            console.warn('[proactive] sqlite 不可用，回退内存:', e?.message);
        }
    }
    _nodeSingleton = new MemoryProactiveStore();
    return _nodeSingleton;
}

// ===== 内存实现（Node 默认）=====
export class MemoryProactiveStore {
    constructor() { this.kind = 'memory'; this.map = new Map(); this.pauseMap = new Map(); }
    // inbox 级暂停：走线下剧情时手机端调 /proactive/pause，tick 跳过该 inbox 的所有 pair。
    // 存到点时间戳（pausedUntil），到点自动失效，防手机没发 resume 就永久哑火。
    async setPause(inboxId, pausedUntil) {
        if (pausedUntil && pausedUntil > Date.now()) this.pauseMap.set(inboxId, pausedUntil);
        else this.pauseMap.delete(inboxId);
    }
    async getPausedUntil(inboxId) {
        const until = this.pauseMap.get(inboxId) || 0;
        if (until && until <= Date.now()) { this.pauseMap.delete(inboxId); return 0; }
        return until;
    }
    async upsert(rec) {
        const key = makePairKey(rec.inboxId, rec.userId, rec.charId);
        const hadPrev = this.map.has(key);
        const prev = this.map.get(key) || {};
        const merged = mergeProactiveRecord(prev, rec);
        const changed = !hadPrev || !proactiveRecordsBehaviorallyEqual(prev, merged);
        if (changed) this.map.set(key, merged);
        return { changed, created: !hadPrev, record: changed ? merged : prev };
    }
    async patch(inboxId, userId, charId, patch) {
        const key = makePairKey(inboxId, userId, charId);
        const prev = this.map.get(key);
        if (!prev) return false;
        const merged = mergeProactiveRecord(prev, patch);
        const changed = !proactiveRecordsBehaviorallyEqual(prev, merged);
        if (changed) this.map.set(key, merged);
        return { changed, record: changed ? merged : prev };
    }
    async remove(inboxId, userId, charId) { this.map.delete(makePairKey(inboxId, userId, charId)); }
    async listEnabled() { return [...this.map.values()].filter(r => r.enabled); }
    async listByInbox(inboxId) { return [...this.map.values()].filter(r => r.inboxId === inboxId); }
    async get(inboxId, userId, charId) { return this.map.get(makePairKey(inboxId, userId, charId)) || null; }
}

// ===== Cloudflare KV 实现 =====
// key 前缀 `p:`；listEnabled 扫全前缀（pair 数量有限，可接受）
// ⚠️ 不用 kv.list(最终一致,刚注册的对 cron 可能扫不到)，改维护全局索引 key `pidx`(强一致 get)。
export class KvProactiveStore {
    constructor(kv) { this.kv = kv; this.kind = 'kv'; }
    // inbox 级暂停（同 Memory 实现说明）。用 KV 原生 TTL 兜底，pausedUntil 也写进 value 双保险。
    async setPause(inboxId, pausedUntil) {
        const key = `pause:${inboxId}`;
        if (pausedUntil && pausedUntil > Date.now()) {
            const ttlSec = Math.max(60, Math.ceil((pausedUntil - Date.now()) / 1000));
            await this.kv.put(key, String(pausedUntil), { expirationTtl: ttlSec });
        } else {
            await this.kv.delete(key);
        }
    }
    async getPausedUntil(inboxId) {
        const raw = await this.kv.get(`pause:${inboxId}`);
        const until = raw ? Number(raw) : 0;
        return (until && until > Date.now()) ? until : 0;
    }
    async _getIdx() {
        const raw = await this.kv.get('pidx');
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
    }
    async _putIdx(keys) { await this.kv.put('pidx', JSON.stringify(keys)); }
    async _getFireAt(pairKey) {
        const raw = await this.kv.get(`pf:${pairKey}`);
        return raw ? (Number(raw) || 0) : 0;
    }
    async _putFireAt(pairKey, firedAt) {
        const ts = Number(firedAt) || 0;
        if (ts <= 0) return;
        const key = `pf:${pairKey}`;
        const current = Number(await this.kv.get(key)) || 0;
        await this.kv.put(key, String(Math.max(current, ts)), { expirationTtl: PROACTIVE_RUNTIME_TTL_SEC });
    }
    async _addToIdx(pairKey) {
        const idx = await this._getIdx();
        if (!idx.includes(pairKey)) { idx.push(pairKey); await this._putIdx(idx); }
    }
    async _removeFromIdx(pairKey) {
        const idx = await this._getIdx();
        const next = idx.filter((k) => k !== pairKey);
        if (next.length !== idx.length) await this._putIdx(next);
    }
    async _listPairKeysByPrefix() {
        if (!this.kv || typeof this.kv.list !== 'function') return [];
        const out = [];
        let cursor;
        do {
            const res = await this.kv.list({ prefix: 'p:', cursor });
            for (const key of res.keys || []) {
                const name = String(key.name || '');
                if (name.startsWith('p:')) out.push(name.slice(2));
            }
            cursor = res.list_complete ? null : res.cursor;
        } while (cursor);
        return out;
    }
    async _applyFireMirror(pairKey, rec) {
        const firedAt = await this._getFireAt(pairKey);
        return applyFireMirror(rec, firedAt);
    }
    async upsert(rec) {
        const pairKey = makePairKey(rec.inboxId, rec.userId, rec.charId);
        const key = `p:${pairKey}`;
        const prevRaw = await this.kv.get(key);
        const rawPrev = prevRaw ? JSON.parse(prevRaw) : {};
        const prev = prevRaw ? await this._applyFireMirror(pairKey, cloneRecord(rawPrev)) : {};
        const merged = mergeProactiveRecord(prev, rec);
        const changed = !prevRaw || !proactiveRecordsBehaviorallyEqual(rawPrev, merged);
        if (!changed) {
            if (rec.lastFiredAt !== undefined) await this._putFireAt(pairKey, merged.lastFiredAt);
            await this._addToIdx(pairKey);
            return { changed: false, created: false, record: prev };
        }
        await this.kv.put(key, JSON.stringify(merged));
        if (rec.lastFiredAt !== undefined) await this._putFireAt(pairKey, merged.lastFiredAt);
        await this._addToIdx(pairKey);
        return { changed: true, created: !prevRaw, record: merged };
    }
    async patch(inboxId, userId, charId, patch) {
        const pairKey = makePairKey(inboxId, userId, charId);
        const key = `p:${pairKey}`;
        const prevRaw = await this.kv.get(key);
        if (!prevRaw) return false;
        const rawPrev = JSON.parse(prevRaw);
        const prev = await this._applyFireMirror(pairKey, cloneRecord(rawPrev));
        const merged = mergeProactiveRecord(prev, patch);
        const changed = !proactiveRecordsBehaviorallyEqual(rawPrev, merged);
        if (!changed) {
            if (patch.lastFiredAt !== undefined) await this._putFireAt(pairKey, merged.lastFiredAt);
            await this._addToIdx(pairKey);
            return { changed: false, record: prev };
        }
        await this.kv.put(key, JSON.stringify(merged));
        if (patch.lastFiredAt !== undefined) await this._putFireAt(pairKey, merged.lastFiredAt);
        await this._addToIdx(pairKey);
        return { changed: true, record: merged };
    }
    async remove(inboxId, userId, charId) {
        const pairKey = makePairKey(inboxId, userId, charId);
        await this.kv.delete(`p:${pairKey}`);
        await this.kv.delete(`pf:${pairKey}`);
        await this._removeFromIdx(pairKey);
    }
    async _all() {
        const idx = await this._getIdx();
        const pairKeys = [...idx];
        let indexChanged = false;
        for (const pairKey of await this._listPairKeysByPrefix()) {
            if (pairKeys.includes(pairKey)) continue;
            pairKeys.push(pairKey);
            indexChanged = true;
        }
        const out = [];
        for (const pairKey of pairKeys) {
            const raw = await this.kv.get(`p:${pairKey}`);
            if (raw) {
                try {
                    const rec = JSON.parse(raw);
                    const firedAt = await this._getFireAt(pairKey);
                    out.push(applyFireMirror(rec, firedAt));
                } catch { /* skip */ }
            }
        }
        if (indexChanged) {
            try { await this._putIdx(pairKeys); } catch { /* best-effort repair */ }
        }
        return out;
    }
    async listEnabled() { return (await this._all()).filter(r => r.enabled); }
    async listByInbox(inboxId) { return (await this._all()).filter(r => r.inboxId === inboxId); }
    async get(inboxId, userId, charId) {
        const pairKey = makePairKey(inboxId, userId, charId);
        const raw = await this.kv.get(`p:${pairKey}`);
        if (!raw) return null;
        const rec = JSON.parse(raw);
        const firedAt = await this._getFireAt(pairKey);
        return applyFireMirror(rec, firedAt);
    }
}
