import { runGeneration } from '../ai/aiCaller.js';
import { buildCoordinatorQueryHint, runOmbreCoordinator } from './geminiCoordinator.js';
import { NO_RELEVANT_INFO } from './ombreCoordinatorPrompt.js';
import {
    clipDebugValue,
    debugError,
    fullPromptDebugEnabled,
    fullPromptDebugLimit,
    logAgentEvent,
    listAgentEvents,
    summarizeMessages,
} from './agentDebug.js';

const RELEVANT_INFO_HEADER = '[Relevant info that could help as context]';
const COORDINATOR_ERROR_PREFIX = '【coordinator报错】';

class CoordinatorUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CoordinatorUnavailableError';
    }
}

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

export function buildCoordinatorConfig(env) {
    return {
        apiKey: envValue(env, ['AGENT_COORDINATOR_API_KEY', 'AGENT_GATEWAY_API_KEY', 'OMBRE_GATEWAY_TOKEN'], ''),
        baseUrl: envValue(env, ['AGENT_COORDINATOR_BASE_URL', 'AGENT_GATEWAY_BASE_URL', 'OMBRE_GATEWAY_BASE_URL'], ''),
        authType: envValue(env, ['AGENT_COORDINATOR_AUTH_TYPE'], 'bearer'),
        model: envValue(env, ['AGENT_COORDINATOR_MODEL'], 'gemini-3.5-flash'),
        sessionId: envValue(env, ['AGENT_COORDINATOR_SESSION_ID'], 'relay-coordinator'),
        timeoutMs: envNumber(env, ['AGENT_COORDINATOR_TIMEOUT_MS'], 600_000),
        maxToolRounds: Math.max(1, Math.min(32, envNumber(env, ['AGENT_MAX_TOOL_ROUNDS'], 8))),
    };
}

export function buildFinalSettings(env, body = {}) {
    const finalSessionId = envValue(env, ['AGENT_FINAL_OMBRE_SESSION_ID', 'AGENT_FINAL_SESSION_ID'], '');
    const currentQuery = buildCoordinatorQueryHint(body?.messages || []);
    return {
        mainApiUrl: envValue(env, ['AGENT_FINAL_API_URL', 'AGENT_FINAL_BASE_URL', 'CLAUDE_PROXY_BASE_URL'], ''),
        mainApiKey: envValue(env, ['AGENT_FINAL_API_KEY', 'CLAUDE_PROXY_API_KEY'], ''),
        mainApiModel: envValue(env, ['AGENT_FINAL_MODEL', 'CLAUDE_PROXY_MODEL'], 'claude-opus-4-8'),
        apiType: envValue(env, ['AGENT_FINAL_API_TYPE'], 'openai'),
        extraHeaders: finalSessionId ? { 'X-Ombre-Session-Id': finalSessionId } : undefined,
        currentQuery,
        temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
        reasoningEffort: body.reasoning_effort || body.reasoningEffort || undefined,
        autoRetryEnabled: body.auto_retry_enabled !== false,
        maxRetries: typeof body.max_retries === 'number' ? body.max_retries : 1,
        secondaryFallbackEnabled: false,
    };
}

export function appendRelevantInfoMessage(messages, relevantInfo) {
    const text = String(relevantInfo || '').trim();
    if (!text || text === NO_RELEVANT_INFO) return Array.isArray(messages) ? messages : [];
    return [
        ...(Array.isArray(messages) ? messages : []),
        {
            role: 'system',
            content: `${RELEVANT_INFO_HEADER}\n${text}`,
        },
    ];
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

function coordinatorErrorContent(error) {
    const message = String(error?.message || error || 'unknown coordinator error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
    return JSON.stringify({
        t: 'text',
        c: `${COORDINATOR_ERROR_PREFIX}${message ? ` ${message}` : ''}`,
    });
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

    const coordinatorConfig = buildCoordinatorConfig(c.env);
    const mcpServer = buildMcpServerConfig(c.env);
    const debugFull = fullPromptDebugEnabled(c.env);
    const debugCharLimit = fullPromptDebugLimit(c.env);
    let relevantInfo = '';
    let coordinatorDebug = { skipped: '' };
    let coordinatorError = null;

    if (coordinatorConfig.apiKey && coordinatorConfig.baseUrl && mcpServer?.url) {
        try {
            const result = await runOmbreCoordinator({
                messages: body.messages,
                mcpServer,
                ...coordinatorConfig,
                debugFull,
                debugCharLimit,
            });
            relevantInfo = result.relevantInfo || '';
            coordinatorDebug = result.debug || coordinatorDebug;
        } catch (error) {
            coordinatorError = error;
            coordinatorDebug = error?.coordinatorDebug || coordinatorDebug;
            console.warn('[agentRelay] coordinator failed:', error?.message || error);
        }
    } else {
        coordinatorDebug = {
            skipped: !coordinatorConfig.apiKey
                ? 'missing coordinator api key'
                : !coordinatorConfig.baseUrl
                    ? 'missing coordinator base url'
                    : 'missing mcp server url',
        };
        coordinatorError = new CoordinatorUnavailableError(coordinatorDebug.skipped);
    }

    if (coordinatorError) {
        const finalSettings = buildFinalSettings(c.env, body);
        const id = makeCompletionId();
        const created = Math.floor(Date.now() / 1000);
        const content = coordinatorErrorContent(coordinatorError);
        const model = finalSettings.mainApiModel || body.model || 'agent-relay';
        await logAgentEvent(c.env, {
            type: 'agent_chat',
            ok: false,
            stage: 'coordinator',
            request: summarizeMessages(body.messages),
            coordinator: coordinatorDebug,
            coordinator_error: debugError(coordinatorError),
            final: {
                model,
                skipped: true,
                reason: 'coordinator_error',
                hasRelevantInfo: false,
                relevantInfoChars: 0,
                responseChars: content.length,
            },
            ...(debugFull ? {
                full: {
                    original_messages: clipDebugValue(body.messages, debugCharLimit),
                    response: clipDebugValue(content, debugCharLimit),
                },
            } : {}),
            durationMs: Date.now() - startedAt,
        });
        if (body.stream === true) {
            return streamCompletionPayload({ id, created, model, content });
        }
        return c.json(buildCompletionPayload({ id, created, model, content }));
    }

    const finalSettings = buildFinalSettings(c.env, body);
    if (!finalSettings.mainApiUrl || !finalSettings.mainApiKey) {
        await logAgentEvent(c.env, {
            type: 'agent_chat',
            ok: false,
            stage: 'config',
            request: summarizeMessages(body.messages),
            coordinator: coordinatorDebug,
            error: { message: 'AGENT_FINAL_API_URL / AGENT_FINAL_API_KEY not configured on server' },
            durationMs: Date.now() - startedAt,
        });
        return c.json({
            error: {
                message: 'AGENT_FINAL_API_URL / AGENT_FINAL_API_KEY not configured on server',
                type: 'agent_relay_config_error',
            },
        }, 500);
    }

    const finalMessages = appendRelevantInfoMessage(body.messages, relevantInfo);
    const fullDebugPayload = debugFull
        ? {
            original_messages: clipDebugValue(body.messages, debugCharLimit),
            relevant_info: clipDebugValue(relevantInfo, debugCharLimit),
            final_messages: clipDebugValue(finalMessages, debugCharLimit),
        }
        : undefined;
    const maxTokens = body.max_tokens || body.max_completion_tokens || body.maxTokens || null;
    let content;
    try {
        content = await runGeneration(finalSettings, finalMessages, maxTokens);
    } catch (error) {
        await logAgentEvent(c.env, {
            type: 'agent_chat',
            ok: false,
            stage: 'final',
            request: summarizeMessages(body.messages),
            coordinator: coordinatorDebug,
            coordinator_error: debugError(coordinatorError),
            final: {
                model: finalSettings.mainApiModel,
                apiType: finalSettings.apiType,
                hasRelevantInfo: !!relevantInfo,
                relevantInfoChars: relevantInfo.length,
            },
            error: debugError(error),
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
        coordinator: coordinatorDebug,
        coordinator_error: debugError(coordinatorError),
        final: {
            model,
            apiType: finalSettings.apiType,
            hasRelevantInfo: !!relevantInfo,
            relevantInfoChars: relevantInfo.length,
            responseChars: String(content || '').length,
        },
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
