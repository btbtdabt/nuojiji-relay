const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function pad2(value) {
    return String(value).padStart(2, '0');
}

function partsForOffset(nowMs, offsetSeconds) {
    const d = new Date(nowMs + offsetSeconds * 1000);
    return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        weekday: WEEKDAYS[d.getUTCDay()],
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
    };
}

function formatLocalDateTime(nowMs, offsetSeconds) {
    const p = partsForOffset(nowMs, offsetSeconds);
    return `${p.year}年${p.month}月${p.day}日 ${p.weekday} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

function extractBioNowDateTime(line) {
    const match = String(line || '').match(/\[BIO\]\s+NOW:\s*([^|]*?\d{1,2}:\d{2})/i);
    return match ? match[1].trim() : '';
}

function extractUserName(text) {
    const match = String(text || '').match(/^\[USER\]\s*([^|\n\[]+)/mi);
    const name = match ? match[1].trim() : '';
    return name || 'user';
}

function hasUserClock(text) {
    return /\bUSER_LOCAL_TIME\b|\bYOUR_LOCAL_TIME\b|\bUSER_CLOCK\b/i.test(String(text || ''));
}

function effectiveTimeSpec(timeSpec, fallback = {}) {
    const base = (timeSpec && typeof timeSpec === 'object') ? { ...timeSpec } : {};
    if (typeof base.charUtcOffsetSeconds !== 'number' && typeof fallback.charUtcOffsetSeconds === 'number') {
        base.charUtcOffsetSeconds = fallback.charUtcOffsetSeconds;
    }
    return base;
}

export function addUserClockToPrompt(text, { timeSpec = null, now = Date.now(), charUtcOffsetSeconds = null } = {}) {
    const source = String(text || '');
    if (!source || hasUserClock(source) || !/^\[BIO\]\s+NOW:/mi.test(source)) return source;

    const spec = effectiveTimeSpec(timeSpec, { charUtcOffsetSeconds });
    const userOff = typeof spec.userUtcOffsetSeconds === 'number' ? spec.userUtcOffsetSeconds : null;
    if (userOff == null) return source;

    const charOff = typeof spec.charUtcOffsetSeconds === 'number' ? spec.charUtcOffsetSeconds : null;
    const userName = extractUserName(source);

    return source.replace(/^(\[BIO\]\s+NOW:[^\n]*)(?:\n|$)/mi, (line) => {
        const trimmed = line.replace(/\r?\n$/, '');
        const bioDateTime = extractBioNowDateTime(trimmed);
        const userDateTime = (charOff != null && charOff !== userOff)
            ? formatLocalDateTime(now, userOff)
            : bioDateTime;
        if (!userDateTime) return line;
        const basis = (charOff != null && charOff !== userOff) ? 'USER_LOCAL_TIME' : 'NOW';
        return `${trimmed} | USER_LOCAL_TIME=${userDateTime} (judge ${userName}'s date, sleep, meals, and availability by ${basis})${line.endsWith('\n') ? '\n' : ''}`;
    });
}

export function addUserClockToMessages(messages, options = {}) {
    if (!Array.isArray(messages)) return [];
    return messages.map((message) => {
        const role = String(message?.role || '').toLowerCase();
        if (role !== 'system' && role !== 'developer') return message;
        if (typeof message?.content !== 'string') return message;
        const content = addUserClockToPrompt(message.content, options);
        return content === message.content ? message : { ...message, content };
    });
}
