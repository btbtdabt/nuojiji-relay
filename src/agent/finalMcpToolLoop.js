import { runGeneration } from '../ai/aiCaller.js';
import {
    assertSafeApiUrl,
    buildApiHeaders,
    buildChatEndpoint,
    buildChatRequestBody,
    isAnthropicRequest,
} from '../ai/requestBuilder.js';
import { createMcpSession, mcpContentToText } from '../mcp/mcpClient.js';
import { clipDebugValue } from './agentDebug.js';
import { isOmbreMcpServerUrl, withOmbreMcpPolicySystem } from './ombreMcpPolicy.js';

const DEFAULT_MCP_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOOL_ROUNDS = 8;

function normalizeTimeoutMs(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function utf8Base64(text) {
    const bytes = new TextEncoder().encode(String(text || ''));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function withCurrentQueryHeader(headers, currentQuery) {
    const query = String(currentQuery || '').trim();
    if (!query) return headers;
    if (headers['X-Ombre-Current-Query'] || headers['X-Ombre-Current-Query-B64']) return headers;
    return {
        ...headers,
        'X-Ombre-Current-Query-B64': utf8Base64(query.slice(0, 4000)),
    };
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

export function supportsFinalMcpToolLoop(settings) {
    return isAnthropicRequest(settings?.mainApiUrl, settings?.apiType);
}

function makeAnthropicToolName(rawName, used = new Set()) {
    const raw = String(rawName || 'tool');
    let base = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
    if (!/^[A-Za-z]/.test(base)) base = `tool_${base}`;
    base = base.slice(0, 64) || 'tool';

    let name = base;
    let suffix = 2;
    while (used.has(name)) {
        const tail = `_${suffix++}`;
        name = `${base.slice(0, 64 - tail.length)}${tail}`;
    }
    used.add(name);
    return name;
}

function prepareAnthropicTools(mcpTools) {
    const used = new Set();
    const nameMap = new Map();
    const tools = [];
    for (const tool of Array.isArray(mcpTools) ? mcpTools : []) {
        const originalName = String(tool?.name || '').trim();
        if (!originalName) continue;
        const name = makeAnthropicToolName(originalName, used);
        nameMap.set(name, originalName);
        const description = [
            String(tool?.description || '').trim(),
            name === originalName ? '' : `Original MCP tool name: ${originalName}`,
        ].filter(Boolean).join('\n');
        tools.push({
            name,
            ...(description ? { description } : {}),
            input_schema: tool?.inputSchema || tool?.parameters || { type: 'object', properties: {} },
        });
    }
    return { tools, nameMap };
}

function normalizeAnthropicContent(content) {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (!Array.isArray(content)) return [];
    return content
        .filter((block) => block && typeof block === 'object')
        .map((block) => cloneJson(block));
}

function extractText(content) {
    return normalizeAnthropicContent(content)
        .map((block) => (block.type === 'text' && typeof block.text === 'string') ? block.text : '')
        .filter(Boolean)
        .join('')
        .trim();
}

function extractToolUses(content) {
    return normalizeAnthropicContent(content)
        .filter((block) => block.type === 'tool_use' && block.id && block.name);
}

function parseJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function appendSseDataEvent(events, eventText) {
    const lines = String(eventText || '').split(/\r?\n/);
    const data = [];
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    const payloadText = data.join('\n').trim();
    if (!payloadText || payloadText === '[DONE]') return;
    try {
        const payload = JSON.parse(payloadText);
        if (payload && typeof payload === 'object') events.push(payload);
    } catch {
        // Ignore malformed keepalive/debug chunks.
    }
}

function parseAnthropicStreamText(rawText) {
    const events = [];
    const normalized = String(rawText || '').replace(/\r\n/g, '\n');
    for (const eventText of normalized.split(/\n\n+/)) appendSseDataEvent(events, eventText);

    const content = [];
    let stopReason = '';
    const ensureBlock = (index) => {
        const safeIndex = Number.isInteger(index) && index >= 0 ? index : content.length;
        if (!content[safeIndex]) content[safeIndex] = { type: 'text', text: '' };
        return content[safeIndex];
    };

    for (const payload of events) {
        if (payload.type === 'message_start' && payload.message?.stop_reason) {
            stopReason = payload.message.stop_reason;
            continue;
        }
        if (payload.type === 'content_block_start') {
            const index = Number.isInteger(payload.index) ? payload.index : content.length;
            const block = cloneJson(payload.content_block || {});
            if (block.type === 'tool_use') {
                block.input = isPlainObject(block.input) ? block.input : {};
                block.__partial_json = '';
            }
            content[index] = block;
            continue;
        }
        if (payload.type === 'content_block_delta') {
            const block = ensureBlock(payload.index);
            const delta = payload.delta || {};
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                block.type = 'text';
                block.text = String(block.text || '') + delta.text;
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                block.type = 'tool_use';
                block.__partial_json = String(block.__partial_json || '') + delta.partial_json;
            }
            continue;
        }
        if (payload.type === 'content_block_stop') {
            const block = content[payload.index];
            if (block?.type === 'tool_use') {
                if (!isPlainObject(block.input) || Object.keys(block.input).length === 0) {
                    block.input = parseJsonObject(block.__partial_json);
                }
                delete block.__partial_json;
            }
            continue;
        }
        if (payload.type === 'message_delta' && payload.delta?.stop_reason) {
            stopReason = payload.delta.stop_reason;
        }
    }

    return {
        content: content.filter(Boolean).map((block) => {
            if (block && typeof block === 'object') {
                const clean = cloneJson(block);
                delete clean.__partial_json;
                return clean;
            }
            return block;
        }),
        stop_reason: stopReason || '',
    };
}

async function parseAnthropicResponse(response) {
    const rawText = await response.text();
    const contentType = response.headers?.get?.('content-type') || '';
    if (/text\/event-stream/i.test(contentType) || /^\s*(?:event:|data:|:)/m.test(rawText)) {
        return parseAnthropicStreamText(rawText);
    }
    let data;
    try {
        data = JSON.parse(rawText);
    } catch {
        throw new Error(`Anthropic final returned invalid JSON: ${rawText.slice(0, 300)}`);
    }
    if (data?.error) {
        throw new Error(`Anthropic final error: ${data.error.message || data.error.type || JSON.stringify(data.error).slice(0, 300)}`);
    }
    return {
        content: Array.isArray(data?.content) ? data.content : [],
        stop_reason: data?.stop_reason || '',
    };
}

async function callAnthropicMessagesOnce({
    settings,
    body,
    timeoutMs,
    fetchImpl = fetch,
}) {
    assertSafeApiUrl(settings.mainApiUrl);
    const endpoint = buildChatEndpoint(settings.mainApiUrl, settings.apiType);
    const headers = withCurrentQueryHeader(
        buildApiHeaders(settings.mainApiUrl, settings.mainApiKey, settings.extraHeaders, settings.apiType),
        settings.currentQuery
    );
    const requestTimeoutMs = normalizeTimeoutMs(timeoutMs);
    const controller = requestTimeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), requestTimeoutMs) : null;
    let response;
    try {
        const init = {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        };
        if (controller) init.signal = controller.signal;
        response = await fetchImpl(endpoint, init);
    } finally {
        if (timer) clearTimeout(timer);
    }
    const parsed = await parseAnthropicResponse(response);
    if (!response.ok) {
        const detail = extractText(parsed.content) || JSON.stringify(parsed).slice(0, 500);
        const error = new Error(`Anthropic final HTTP ${response.status}: ${detail}`);
        error.status = response.status;
        throw error;
    }
    return parsed;
}

async function executeMcpTool({
    mcp,
    name,
    args,
    nameMap,
    debug,
    debugFull,
    debugCharLimit,
}) {
    const originalName = nameMap.get(name) || name;
    const callDebug = { name: originalName, ok: false, result_chars: 0 };
    if (debugFull) callDebug.args = clipDebugValue(args, debugCharLimit);
    const startedAt = Date.now();
    try {
        const result = await mcp.callTool(originalName, isPlainObject(args) ? args : {});
        const text = mcpContentToText(result.content);
        callDebug.ok = !result.isError;
        callDebug.is_error = !!result.isError;
        callDebug.result_chars = text.length;
        if (debugFull) callDebug.result_text = clipDebugValue(text, debugCharLimit);
        return {
            text,
            isError: !!result.isError,
        };
    } catch (error) {
        const message = String(error?.message || error);
        callDebug.error = message.slice(0, 300);
        debug.errors.push(callDebug.error);
        return {
            text: `Error calling ${originalName}: ${message}`,
            isError: true,
        };
    } finally {
        callDebug.duration_ms = Date.now() - startedAt;
        debug.calls.push(callDebug);
    }
}

export async function runAnthropicFinalWithMcpTools({
    settings,
    messages,
    maxTokens,
    mcpServer,
    mcpTimeoutMs = DEFAULT_MCP_TIMEOUT_MS,
    maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
    requestTimeoutMs,
    debugFull = false,
    debugCharLimit = 200_000,
    fetchImpl,
}) {
    const startedAt = Date.now();
    const debug = {
        enabled: true,
        tool_count: 0,
        rounds: 0,
        calls: [],
        errors: [],
        timings: {},
    };

    const mcpSessionStartedAt = Date.now();
    const mcp = await createMcpSession(mcpServer, { timeoutMs: mcpTimeoutMs });
    debug.timings.mcp_session_ms = Date.now() - mcpSessionStartedAt;

    const listToolsStartedAt = Date.now();
    const rawTools = await mcp.listTools();
    debug.timings.mcp_list_tools_ms = Date.now() - listToolsStartedAt;

    const { tools, nameMap } = prepareAnthropicTools(rawTools);
    debug.tool_count = tools.length;
    if (debugFull) {
        debug.full = {
            tools: clipDebugValue(rawTools.map((tool) => ({
                name: tool?.name || '',
                description: tool?.description || '',
                inputSchema: tool?.inputSchema || tool?.parameters || {},
            })), debugCharLimit),
        };
    }
    if (tools.length === 0) {
        debug.skipped = 'no mcp tools';
        debug.timings.total_ms = Date.now() - startedAt;
        return { content: await runGeneration(settings, messages, maxTokens), debug };
    }

    const initialBody = buildChatRequestBody({
        apiUrl: settings.mainApiUrl,
        apiType: settings.apiType,
        model: settings.mainApiModel,
        messages,
        temperature: settings.temperature,
        reasoningEffort: settings.reasoningEffort,
        stream: true,
        maxTokens,
    });
    initialBody.system = withOmbreMcpPolicySystem(initialBody.system, mcpServer);
    debug.ombre_policy_injected = isOmbreMcpServerUrl(mcpServer?.url);
    const workingMessages = Array.isArray(initialBody.messages) ? cloneJson(initialBody.messages) : [];

    for (let round = 0; round <= maxToolRounds; round++) {
        debug.rounds = round + 1;
        const body = {
            ...initialBody,
            messages: workingMessages,
            tools,
        };
        const roundStartedAt = Date.now();
        const parsed = await callAnthropicMessagesOnce({
            settings,
            body,
            timeoutMs: requestTimeoutMs ?? settings.requestTimeoutMs,
            fetchImpl,
        });
        debug.timings[`round_${round + 1}_ai_ms`] = Date.now() - roundStartedAt;

        const content = normalizeAnthropicContent(parsed.content);
        const toolUses = extractToolUses(content);
        if (toolUses.length === 0 || parsed.stop_reason !== 'tool_use') {
            const text = extractText(content);
            debug.response_chars = text.length;
            debug.timings.total_ms = Date.now() - startedAt;
            return { content: text, debug };
        }

        if (round === maxToolRounds) {
            throw new Error(`Anthropic final MCP tool loop exceeded max rounds (${maxToolRounds})`);
        }

        workingMessages.push({ role: 'assistant', content });
        const toolResults = [];
        for (const toolUse of toolUses) {
            const result = await executeMcpTool({
                mcp,
                name: toolUse.name,
                args: toolUse.input,
                nameMap,
                debug,
                debugFull,
                debugCharLimit,
            });
            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: result.text,
                ...(result.isError ? { is_error: true } : {}),
            });
        }
        workingMessages.push({ role: 'user', content: toolResults });
    }

    debug.timings.total_ms = Date.now() - startedAt;
    return { content: '', debug };
}
