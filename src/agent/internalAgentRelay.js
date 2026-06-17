import { handleAgentChatCompletions } from './agentRelay.js';

function originOf(value) {
    try {
        return new URL(String(value || '')).origin;
    } catch {
        return '';
    }
}

function envValue(env, keys, fallback = '') {
    for (const key of keys) {
        const value = env?.[key] ?? (typeof process !== 'undefined' ? process.env?.[key] : undefined);
        if (value != null && String(value).trim() !== '') return String(value).trim();
    }
    return fallback;
}

function isAgentRelayPath(pathname) {
    return /^\/v1(?:\/|$)/.test(String(pathname || ''));
}

export function isSelfAgentRelayUrl(apiUrl, { env, requestUrl, apiKey } = {}) {
    let target;
    try {
        target = new URL(String(apiUrl || ''));
    } catch {
        return false;
    }
    if (!isAgentRelayPath(target.pathname)) return false;

    const requestOrigin = originOf(requestUrl);
    if (requestOrigin && target.origin === requestOrigin) return true;

    const configuredOrigins = [
        envValue(env, ['RELAY_PUBLIC_URL', 'RELAY_BASE_URL', 'NUOJIJI_RELAY_URL'], ''),
    ].map(originOf).filter(Boolean);
    if (configuredOrigins.includes(target.origin)) return true;

    const relaySecret = envValue(env, ['RELAY_SECRET'], '');
    return !!relaySecret && !!apiKey && String(apiKey) === relaySecret;
}

export async function runInternalAgentRelayCompletion(env, settings, messages, maxTokens) {
    const agentBody = {
        model: settings?.mainApiModel || settings?.model,
        messages,
        stream: false,
        temperature: typeof settings?.temperature === 'number' ? settings.temperature : undefined,
        reasoning_effort: settings?.reasoningEffort || settings?.reasoning_effort || undefined,
        max_tokens: maxTokens ?? settings?.maxTokens ?? settings?.max_tokens ?? undefined,
        auto_retry_enabled: settings?.autoRetryEnabled,
        max_retries: settings?.maxRetries,
    };
    const response = await handleAgentChatCompletions({
        env,
        req: { json: async () => agentBody },
        json: (payload, status = 200) => new Response(JSON.stringify(payload), {
            status,
            headers: { 'content-type': 'application/json' },
        }),
    });
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
        throw new Error(payload?.error?.message || `internal agent relay HTTP ${response.status}`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (content == null || content === '') throw new Error('internal agent relay returned empty content');
    return content;
}
