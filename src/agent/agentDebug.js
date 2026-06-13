const DEBUG_INDEX_KEY = 'dbg:agent:index';
const DEBUG_ITEM_PREFIX = 'dbg:agent:';
const DEBUG_TTL_SEC = 48 * 60 * 60;
const DEBUG_CAP = 120;
const DEFAULT_FULL_DEBUG_CHARS = 30_000;

let memoryEvents = [];

function nowIso() {
    return new Date().toISOString();
}

function makeDebugId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clip(value, limit = 240) {
    const text = String(value || '');
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function envValue(env, keys, fallback = '') {
    for (const key of keys) {
        const value = env?.[key] ?? (typeof process !== 'undefined' ? process.env?.[key] : undefined);
        if (value != null && String(value).trim() !== '') return String(value).trim();
    }
    return fallback;
}

function envFlag(env, keys, fallback = false) {
    const raw = envValue(env, keys, '');
    if (!raw) return fallback;
    return /^(1|true|yes|on)$/i.test(raw);
}

function envNumber(env, keys, fallback) {
    const raw = envValue(env, keys, '');
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function sensitiveKey(key) {
    return /key|token|secret|authorization|password|credential/i.test(String(key || ''));
}

export function fullPromptDebugEnabled(env) {
    return envFlag(env, ['AGENT_DEBUG_FULL_PROMPT'], false);
}

export function fullPromptDebugLimit(env) {
    return Math.max(1_000, Math.min(200_000, envNumber(env, ['AGENT_DEBUG_FULL_LIMIT_CHARS'], DEFAULT_FULL_DEBUG_CHARS)));
}

export function clipDebugValue(value, limit = DEFAULT_FULL_DEBUG_CHARS, depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string') {
        if (value.length <= limit) return value;
        return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= 8) return '[max depth reached]';
    if (Array.isArray(value)) {
        const items = value.slice(0, 100).map((item) => clipDebugValue(item, limit, depth + 1));
        if (value.length > items.length) items.push(`[truncated ${value.length - items.length} items]`);
        return items;
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = sensitiveKey(key) ? '[redacted]' : clipDebugValue(item, limit, depth + 1);
        }
        return out;
    }
    return String(value);
}

function summarizeError(error) {
    if (!error) return null;
    return {
        name: error?.name || 'Error',
        message: clip(error?.message || error, 500),
    };
}

export function summarizeMessages(messages) {
    const safe = Array.isArray(messages) ? messages : [];
    const lastUser = [...safe].reverse().find((message) => String(message?.role || '').toLowerCase() === 'user');
    const roles = safe.map((message) => String(message?.role || 'unknown')).slice(-12);
    const content = lastUser?.content;
    let preview = '';
    if (typeof content === 'string') {
        preview = content;
    } else if (Array.isArray(content)) {
        preview = content
            .map((part) => typeof part?.text === 'string' ? part.text : (part?.type ? `[${part.type}]` : ''))
            .filter(Boolean)
            .join('\n');
    }
    return {
        count: safe.length,
        roles,
        last_user_preview: clip(preview, 240),
        last_user_chars: preview.length,
    };
}

export function summarizeAiSettings(settings) {
    const safe = settings || {};
    return {
        mainApiUrl: safe.mainApiUrl || '',
        mainApiModel: safe.mainApiModel || '',
        apiType: safe.apiType || '',
        secondaryFallbackEnabled: safe.secondaryFallbackEnabled !== false,
        secondaryApiUrl: safe.secondaryApiUrl || '',
        secondaryApiModel: safe.secondaryApiModel || '',
        hasMainApiKey: !!safe.mainApiKey,
        hasSecondaryApiKey: !!safe.secondaryApiKey,
    };
}

async function putKvEvent(kv, entry) {
    const itemKey = `${DEBUG_ITEM_PREFIX}${entry.id}`;
    await kv.put(itemKey, JSON.stringify(entry), { expirationTtl: DEBUG_TTL_SEC });

    let index = [];
    try {
        index = JSON.parse(await kv.get(DEBUG_INDEX_KEY) || '[]');
    } catch {
        index = [];
    }
    index.unshift({ id: entry.id, createdAt: entry.createdAt, type: entry.type });
    index = index.slice(0, DEBUG_CAP);
    await kv.put(DEBUG_INDEX_KEY, JSON.stringify(index), { expirationTtl: DEBUG_TTL_SEC });
}

export async function logAgentEvent(env, event) {
    const entry = {
        id: makeDebugId(),
        createdAt: Date.now(),
        time: nowIso(),
        ...event,
    };
    try {
        if (env?.OUTBOX && typeof env.OUTBOX.put === 'function') {
            await putKvEvent(env.OUTBOX, entry);
            return entry.id;
        }
        memoryEvents.unshift(entry);
        memoryEvents = memoryEvents.slice(0, DEBUG_CAP);
        return entry.id;
    } catch (error) {
        console.warn('[agentDebug] failed to write debug event:', error?.message || error);
        return '';
    }
}

export async function listAgentEvents(env, { limit = 30 } = {}) {
    const safeLimit = Math.max(1, Math.min(DEBUG_CAP, Number(limit) || 30));
    if (env?.OUTBOX && typeof env.OUTBOX.get === 'function') {
        let index = [];
        try {
            index = JSON.parse(await env.OUTBOX.get(DEBUG_INDEX_KEY) || '[]');
        } catch {
            index = [];
        }
        const items = [];
        for (const row of index.slice(0, safeLimit)) {
            const raw = await env.OUTBOX.get(`${DEBUG_ITEM_PREFIX}${row.id}`);
            if (!raw) continue;
            try { items.push(JSON.parse(raw)); } catch { /* skip */ }
        }
        return items;
    }
    return memoryEvents.slice(0, safeLimit);
}

export function debugError(error) {
    return summarizeError(error);
}
