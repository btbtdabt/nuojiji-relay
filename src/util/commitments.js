export const PROMISE_SOON_MS = 60 * 60 * 1000;
const EXPIRED_KEEP_MS = 6 * 60 * 60 * 1000;
const MAX_PENDING_COMMITMENTS = 20;

function coerceText(value) {
    return String(value == null ? '' : value).trim();
}

function parseRelativeAt(rawAt, now) {
    const text = coerceText(rawAt).toLowerCase();
    const match = text.match(/^\+\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|分钟|分|h|hr|hrs|hour|hours|小时|d|day|days|天)$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = match[2].toLowerCase();
    if (['m', 'min', 'mins', 'minute', 'minutes', '分钟', '分'].includes(unit)) return now + amount * 60_000;
    if (['h', 'hr', 'hrs', 'hour', 'hours', '小时'].includes(unit)) return now + amount * 3_600_000;
    if (['d', 'day', 'days', '天'].includes(unit)) return now + amount * 86_400_000;
    return null;
}

function parseClockAt(rawAt, now, utcOffsetSeconds = null) {
    const text = coerceText(rawAt);
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    const offsetMs = typeof utcOffsetSeconds === 'number' && Number.isFinite(utcOffsetSeconds)
        ? utcOffsetSeconds * 1000
        : 0;
    const localNow = new Date(now + offsetMs);
    let due = Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate(),
        hour,
        minute,
        0,
        0
    ) - offsetMs;
    if (due <= now - 60_000) due += 86_400_000;
    return due;
}

export function parseCommitmentAt(rawAt, { now = Date.now(), utcOffsetSeconds = null } = {}) {
    const relative = parseRelativeAt(rawAt, now);
    if (relative) return relative;
    const clock = parseClockAt(rawAt, now, utcOffsetSeconds);
    if (clock) return clock;
    const parsed = Date.parse(coerceText(rawAt));
    return Number.isFinite(parsed) ? parsed : null;
}

function commitmentKey(commitment) {
    return `${commitment.kind || ''}|${coerceText(commitment.hint).toLowerCase()}`;
}

export function normalizeCommitment(input, { now = Date.now(), utcOffsetSeconds = null } = {}) {
    if (!input || typeof input !== 'object') return null;
    if (input.t !== 'commitment') return null;
    const kind = coerceText(input.kind).toLowerCase();
    if (!['activity', 'callback', 'promise'].includes(kind)) return null;
    const hint = coerceText(input.hint).slice(0, 120);
    const at = coerceText(input.at).slice(0, 80);
    if (!hint && !at) return null;
    const storedDueAt = Number(input.dueAt);
    const dueAt = Number.isFinite(storedDueAt) && storedDueAt > 0
        ? storedDueAt
        : parseCommitmentAt(at, { now, utcOffsetSeconds });
    const createdAt = Number(input.createdAt) || now;
    return {
        t: 'commitment',
        kind,
        at,
        hint,
        dueAt,
        createdAt,
    };
}

export function parseCommitmentsFromContent(content, options = {}) {
    if (!content || typeof content !== 'string') return [];
    const out = [];
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{') || !trimmed.includes('"commitment"')) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { continue; }
        const normalized = normalizeCommitment(obj, options);
        if (normalized) out.push(normalized);
    }
    return out;
}

export function mergePendingCommitments(existing, incoming, { now = Date.now(), utcOffsetSeconds = null } = {}) {
    const map = new Map();
    const add = (item) => {
        const normalized = normalizeCommitment(item, { now, utcOffsetSeconds });
        if (!normalized) return;
        if (normalized.dueAt && normalized.dueAt < now - EXPIRED_KEEP_MS) return;
        const key = commitmentKey(normalized);
        const prev = map.get(key);
        if (!prev || (Number(normalized.createdAt) || 0) >= (Number(prev.createdAt) || 0)) {
            map.set(key, normalized);
        }
    };
    for (const item of Array.isArray(existing) ? existing : []) add(item);
    for (const item of Array.isArray(incoming) ? incoming : []) add(item);
    return [...map.values()]
        .sort((a, b) => (Number(a.dueAt) || Number.MAX_SAFE_INTEGER) - (Number(b.dueAt) || Number.MAX_SAFE_INTEGER))
        .slice(0, MAX_PENDING_COMMITMENTS);
}

function commitmentTimingOptions(options) {
    if (typeof options === 'number') return { now: options, utcOffsetSeconds: null };
    return {
        now: options?.now ?? Date.now(),
        utcOffsetSeconds: options?.utcOffsetSeconds ?? null,
    };
}

export function pendingCommitmentBlockReason(pendingCommitments, options = {}) {
    const { now, utcOffsetSeconds } = commitmentTimingOptions(options);
    for (const item of Array.isArray(pendingCommitments) ? pendingCommitments : []) {
        const commitment = normalizeCommitment(item, { now, utcOffsetSeconds });
        if (!commitment?.dueAt || commitment.dueAt <= now) continue;
        const remainingMs = commitment.dueAt - now;
        if (commitment.kind === 'activity' || commitment.kind === 'callback') {
            return `pending_${commitment.kind}_commitment_due_in_${Math.ceil(remainingMs / 60_000)}m`;
        }
        if (commitment.kind === 'promise' && remainingMs <= PROMISE_SOON_MS) {
            return `pending_promise_commitment_due_in_${Math.ceil(remainingMs / 60_000)}m`;
        }
    }
    return '';
}

export function formatPendingCommitmentsForPrompt(pendingCommitments, options = {}) {
    const { now, utcOffsetSeconds } = commitmentTimingOptions(options);
    const lines = [];
    for (const item of Array.isArray(pendingCommitments) ? pendingCommitments : []) {
        const commitment = normalizeCommitment(item, { now, utcOffsetSeconds });
        if (!commitment?.dueAt || commitment.dueAt <= now) continue;
        const remainingMin = Math.max(1, Math.ceil((commitment.dueAt - now) / 60_000));
        lines.push(`- ${commitment.kind} due in ~${remainingMin}min — ${commitment.hint || commitment.at}`);
    }
    if (!lines.length) return '';
    return [
        '',
        '[PENDING_COMMITMENTS_FROM_RELAY]',
        'These commitments are not done yet. Do not complete a future commitment before its due time; acknowledge, delay, or continue naturally instead.',
        ...lines,
        '[/PENDING_COMMITMENTS_FROM_RELAY]',
    ].join('\n');
}
