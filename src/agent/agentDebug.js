const DEBUG_INDEX_KEY = 'dbg:agent:index';
const DEBUG_ITEM_PREFIX = 'dbg:agent:';
const DEBUG_TTL_SEC = 48 * 60 * 60;
const DEBUG_CAP = 120;

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
