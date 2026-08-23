import { runGeneration } from '../ai/aiCaller.js';
import { runAnthropicFinalWithMcpTools, supportsFinalMcpToolLoop } from './finalMcpToolLoop.js';
import {
    clipDebugValue,
    debugError,
    fullPromptDebugEnabled,
    fullPromptDebugLimit,
    logAgentEvent,
    listAgentEvents,
    summarizeMessages,
} from './agentDebug.js';

function envValue(env, keys, fallback = '') {
    for (const key of keys) {
        const value = env?.[key] ?? (typeof process !== 'undefined' ? process.env?.[key] : undefined);
        if (value != null && String(value).trim() !== '') return String(value).trim();
    }
    return fallback;
}

function envNumber(env, keys, fallback) {
    const raw = envValue(env, keys, '');
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

export function buildMcpServerConfig(env) {
    const url = envValue(env, ['AGENT_MCP_URL', 'OMBRE_MCP_URL'], '');
    if (!url) return null;

    const bearer = envValue(env, ['AGENT_MCP_BEARER_TOKEN', 'OMBRE_MCP_BEARER_TOKEN', 'OMBRE_MCP_TOKEN'], '');
    if (bearer) return { url, auth: { type: 'bearer', value: bearer } };

    const headerName = envValue(env, ['AGENT_MCP_HEADER_NAME', 'OMBRE_MCP_HEADER_NAME'], '');
    const headerValue = envValue(env, ['AGENT_MCP_HEADER_VALUE', 'OMBRE_MCP_HEADER_VALUE'], '');
    if (headerName && headerValue) return { url, auth: { type: 'header', headerName, value: headerValue } };

    return { url, auth: { type: 'none' } };
}

function contentPartToText(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    if (typeof part.text === 'string') return part.text;
    if (part.type === 'image_url' || part.image_url || part.url) {
        const url = part.image_url?.url || part.url || '';
        if (String(url).startsWith('data:')) {
            const mimeEnd = String(url).indexOf(';');
            const mime = String(url).slice(5, mimeEnd > 0 ? mimeEnd : 30);
            return `[image attachment: ${mime || 'data'}; ${String(url).length} chars]`;
        }
        return `[image attachment: ${url}]`;
    }
    if (part.type) return `[${part.type} attachment]`;
    try { return JSON.stringify(part); } catch { return '[unserializable content part]'; }
}

function messageContentToText(message) {
    if (typeof message?.content === 'string') return message.content;
    if (Array.isArray(message?.content)) {
        return message.content.map(contentPartToText).filter(Boolean).join('\n');
    }
    if (message?.content != null) {
        try { return JSON.stringify(message.content); } catch { return '[unserializable content]'; }
    }
    return '';
}

function isPlaceholderUserText(text) {
    const compact = String(text || '').replace(/\s+/g, '').trim().toLowerCase();
    return compact === '请开始回复。'
        || compact === '请开始回复'
        || compact === 'pleasecontinue.'
        || compact === 'pleasecontinue';
}

function latestUserMessageText(messages) {
    for (let index = (Array.isArray(messages) ? messages.length : 0) - 1; index >= 0; index--) {
        const message = messages[index];
        if (String(message?.role || '').toLowerCase() !== 'user') continue;
        const text = messageContentToText(message).trim();
        if (text && !isPlaceholderUserText(text)) return text;
    }
    return '';
}

function transcriptQueryHintFromSystemMessages(messages) {
    const systemText = (Array.isArray(messages) ? messages : [])
        .filter((message) => {
            const role = String(message?.role || '').toLowerCase();
            return role === 'system' || role === 'developer';
        })
        .map((message) => messageContentToText(message))
        .join('\n');
    if (!systemText.trim()) return '';
    const transcriptLines = systemText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^(?:User|Char|Me|Assistant|用户|角色|助手)\s*[:：]/i.test(line))
        .filter((line) => !isPlaceholderUserText(line.replace(/^[^:：]+[:：]\s*/, '')));
    return transcriptLines.slice(-12).join('\n').slice(0, 4000).trim();
}

function buildCurrentQueryHint(messages) {
    return latestUserMessageText(messages) || transcriptQueryHintFromSystemMessages(messages);
}

function requestHeader(context, name) {
    if (typeof context?.req?.header === 'function') return context.req.header(name) || '';
    return context?.req?.raw?.headers?.get?.(name) || '';
}

export function buildFinalSettings(env, body = {}, requestContext = {}) {
    const finalSessionId = envValue(env, ['AGENT_FINAL_OMBRE_SESSION_ID', 'AGENT_FINAL_SESSION_ID'], '');
    const requestedSessionId = String(requestContext.sessionId || '').trim().slice(0, 200);
    const diagnosticProbe = (
        String(requestContext.diagnosticProbe || '').trim().toLowerCase() === 'production-alignment'
        && requestedSessionId.startsWith('production-alignment-')
    );
    const extraHeaders = {};
    if (diagnosticProbe || finalSessionId) {
        extraHeaders['X-Ombre-Session-Id'] = diagnosticProbe ? requestedSessionId : finalSessionId;
    }
    if (diagnosticProbe) extraHeaders['X-Ombre-Diagnostic-Probe'] = 'production-alignment';
    const currentQuery = buildCurrentQueryHint(body?.messages || []);
    const apiType = envValue(env, ['AGENT_FINAL_API_TYPE'], 'openai');
    const defaultModel = apiType === 'claude' || apiType === 'anthropic'
        ? 'claude-opus-5-native'
        : 'claude-opus-5';
    return {
        mainApiUrl: envValue(env, ['AGENT_FINAL_API_URL', 'AGENT_FINAL_BASE_URL', 'CLAUDE_PROXY_BASE_URL'], ''),
        mainApiKey: envValue(env, ['AGENT_FINAL_API_KEY', 'CLAUDE_PROXY_API_KEY'], ''),
        mainApiModel: envValue(env, ['AGENT_FINAL_MODEL', 'CLAUDE_PROXY_MODEL'], defaultModel),
        apiType,
        extraHeaders: Object.keys(extraHeaders).length ? extraHeaders : undefined,
        currentQuery,
        temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
        reasoningEffort: body.reasoning_effort || body.reasoningEffort || undefined,
        autoRetryEnabled: body.auto_retry_enabled !== false,
        maxRetries: typeof body.max_retries === 'number' ? body.max_retries : 1,
        secondaryFallbackEnabled: false,
    };
}

function makeCompletionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `chatcmpl_${crypto.randomUUID()}`;
    }
    return `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function buildCompletionPayload({ id, created, model, content }) {
    return {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
        }],
    };
}

function streamCompletionPayload({ id, created, model, content }) {
    const chunks = [
        {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        },
        {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
        },
        {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
    ];
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    }), {
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}

export async function handleAgentChatCompletions(c) {
    const startedAt = Date.now();
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: { message: 'invalid json' } }, 400); }
    if (!Array.isArray(body?.messages)) {
        return c.json({ error: { message: 'messages array required' } }, 400);
    }

    const mcpServer = buildMcpServerConfig(c.env);
    const debugFull = fullPromptDebugEnabled(c.env);
    const debugCharLimit = fullPromptDebugLimit(c.env);
    const timings = {};

    const finalSettings = buildFinalSettings(c.env, body, {
        diagnosticProbe: requestHeader(c, 'X-Ombre-Diagnostic-Probe'),
        sessionId: requestHeader(c, 'X-Ombre-Session-Id'),
    });
    if (!finalSettings.mainApiUrl || !finalSettings.mainApiKey) {
        await logAgentEvent(c.env, {
            type: 'agent_chat',
            ok: false,
            stage: 'config',
            request: summarizeMessages(body.messages),
            error: { message: 'AGENT_FINAL_API_URL / AGENT_FINAL_API_KEY not configured on server' },
            timings: { ...timings, total_ms: Date.now() - startedAt },
            durationMs: Date.now() - startedAt,
        });
        return c.json({
            error: {
                message: 'AGENT_FINAL_API_URL / AGENT_FINAL_API_KEY not configured on server',
                type: 'agent_relay_config_error',
            },
        }, 500);
    }

    const finalMessages = Array.isArray(body.messages) ? body.messages : [];
    const fullDebugPayload = debugFull
        ? {
            original_messages: clipDebugValue(body.messages, debugCharLimit),
            final_messages: clipDebugValue(finalMessages, debugCharLimit),
        }
        : undefined;
    const maxTokens = body.max_tokens || body.max_completion_tokens || body.maxTokens || null;
    let content;
    let finalMcpDebug = {
        enabled: false,
        skipped: !supportsFinalMcpToolLoop(finalSettings)
            ? 'final api is not Anthropic native'
            : !mcpServer?.url
                ? 'missing mcp server url'
                : '',
    };
    const finalStartedAt = Date.now();
    try {
        if (supportsFinalMcpToolLoop(finalSettings) && mcpServer?.url) {
            const result = await runAnthropicFinalWithMcpTools({
                settings: finalSettings,
                messages: finalMessages,
                maxTokens,
                mcpServer,
                mcpTimeoutMs: envNumber(c.env, ['AGENT_FINAL_MCP_TIMEOUT_MS', 'AGENT_MCP_TIMEOUT_MS'], 600_000),
                maxToolRounds: Math.max(1, Math.min(32, envNumber(c.env, ['AGENT_FINAL_MAX_TOOL_ROUNDS', 'AGENT_MAX_TOOL_ROUNDS'], 8))),
                requestTimeoutMs: envNumber(c.env, ['AGENT_FINAL_AI_TIMEOUT_MS', 'AGENT_FINAL_TIMEOUT_MS'], 0),
                debugFull,
                debugCharLimit,
            });
            content = result.content;
            finalMcpDebug = result.debug || finalMcpDebug;
        } else {
            content = await runGeneration(finalSettings, finalMessages, maxTokens);
        }
        if (!String(content || '').trim()) throw new Error('AI returned empty content after MCP tool loop');
        timings.final_ms = Date.now() - finalStartedAt;
    } catch (error) {
        timings.final_ms = Date.now() - finalStartedAt;
        await logAgentEvent(c.env, {
            type: 'agent_chat',
            ok: false,
            stage: 'final',
            request: summarizeMessages(body.messages),
            final: {
                model: finalSettings.mainApiModel,
                apiType: finalSettings.apiType,
                toolLoop: !!finalMcpDebug.enabled,
            },
            final_mcp: finalMcpDebug,
            error: debugError(error),
            timings: { ...timings, total_ms: Date.now() - startedAt },
            ...(fullDebugPayload ? { full: fullDebugPayload } : {}),
            durationMs: Date.now() - startedAt,
        });
        return c.json({
            error: {
                message: String(error?.message || error),
                type: 'agent_final_error',
            },
        }, 502);
    }

    const id = makeCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const model = finalSettings.mainApiModel;
    await logAgentEvent(c.env, {
        type: 'agent_chat',
        ok: true,
        stage: 'complete',
        request: summarizeMessages(body.messages),
        final: {
            model,
            apiType: finalSettings.apiType,
            toolLoop: !!finalMcpDebug.enabled,
            toolCount: finalMcpDebug.tool_count || 0,
            toolCallCount: Array.isArray(finalMcpDebug.calls) ? finalMcpDebug.calls.length : 0,
            responseChars: String(content || '').length,
        },
        final_mcp: finalMcpDebug,
        timings: { ...timings, total_ms: Date.now() - startedAt },
        ...(fullDebugPayload ? { full: fullDebugPayload } : {}),
        durationMs: Date.now() - startedAt,
    });
    if (body.stream === true) {
        return streamCompletionPayload({ id, created, model, content });
    }
    return c.json(buildCompletionPayload({ id, created, model, content }));
}

export function handleAgentModels(c) {
    const model = buildFinalSettings(c.env).mainApiModel;
    return c.json({
        object: 'list',
        data: [{
            id: model,
            object: 'model',
            created: 0,
            owned_by: 'nuojiji-relay',
        }],
    });
}

export async function handleAgentDebug(c) {
    const limit = c.req.query('limit') || 30;
    const items = await listAgentEvents(c.env, { limit });
    return c.json({ items, count: items.length });
}
