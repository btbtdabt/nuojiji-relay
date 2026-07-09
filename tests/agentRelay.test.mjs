import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import {
    buildFinalSettings,
    buildMcpServerConfig,
} from '../src/agent/agentRelay.js';
import {
    clipDebugValue,
    fullPromptDebugEnabled,
    fullPromptDebugLimit,
    listAgentEvents,
    logAgentEvent,
    summarizeAiSettings,
} from '../src/agent/agentDebug.js';

class FakeKv {
    constructor() {
        this.map = new Map();
    }
    async get(key) {
        return this.map.get(key) ?? null;
    }
    async put(key, value) {
        this.map.set(key, value);
    }
}

function testEnvConfigAliases() {
    const env = {
        AGENT_MCP_URL: 'https://brain.example.com/mcp',
        AGENT_MCP_BEARER_TOKEN: 'secret',
        AGENT_FINAL_API_URL: 'https://gateway.example.com/v1',
        AGENT_FINAL_API_KEY: 'final-key',
        AGENT_FINAL_MODEL: 'claude-opus-4-8-native',
        AGENT_FINAL_API_TYPE: 'claude',
        AGENT_FINAL_OMBRE_SESSION_ID: 'main',
    };

    assert.deepEqual(buildMcpServerConfig(env), {
        url: 'https://brain.example.com/mcp',
        auth: { type: 'bearer', value: 'secret' },
    });
    assert.equal(buildFinalSettings(env).mainApiModel, 'claude-opus-4-8-native');
    assert.equal(buildFinalSettings(env).apiType, 'claude');
    assert.deepEqual(buildFinalSettings(env).extraHeaders, { 'X-Ombre-Session-Id': 'main' });
    assert.equal(buildFinalSettings(env).currentQuery, '');
}

function testFinalSettingsCurrentQueryIgnoresProactivePlaceholder() {
    const settings = buildFinalSettings({}, {
        messages: [
            {
                role: 'system',
                content: [
                    '[FRAME] proactive message',
                    'Recent:',
                    'User: before',
                    'Char: server proactive',
                    'Reason: score=0.8',
                ].join('\n'),
            },
            { role: 'user', content: '请开始回复。' },
        ],
    });

    assert.equal(settings.currentQuery, 'User: before\nChar: server proactive');
}

function testFinalSettingsCurrentQueryPrefersRealUserText() {
    const settings = buildFinalSettings({}, {
        messages: [
            { role: 'system', content: 'Recent:\nUser: old line' },
            { role: 'user', content: 'real current message' },
        ],
    });

    assert.equal(settings.currentQuery, 'real current message');
}

async function testDebugEventStore() {
    const env = { OUTBOX: new FakeKv() };
    await logAgentEvent(env, { type: 'agent_chat', ok: true, final: { model: 'm' } });
    const events = await listAgentEvents(env, { limit: 5 });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'agent_chat');
    assert.equal(events[0].ok, true);
    assert.ok(events[0].id);
}

async function testAgentStreamUsesSeparateStopChunk() {
    const app = createApp();
    const env = {
        OUTBOX: new FakeKv(),
        RELAY_SECRET: 'test-secret',
        AGENT_MCP_URL: 'https://brain.example.com/mcp',
        AGENT_FINAL_API_URL: 'https://api.openai.example',
        AGENT_FINAL_API_KEY: 'final-key',
        AGENT_FINAL_MODEL: 'test-model',
        AGENT_FINAL_OMBRE_SESSION_ID: 'main',
    };
    const originalFetch = globalThis.fetch;
    const aiRequests = [];

    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        aiRequests.push(body);
        assert.equal(init?.headers?.['X-Ombre-Session-Id'], 'main');
        assert.equal(
            Buffer.from(init?.headers?.['X-Ombre-Current-Query-B64'] || '', 'base64').toString('utf8'),
            'hi'
        );
        return new Response(JSON.stringify({
            choices: [{ message: { content: 'hello stream' } }],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const res = await app.fetch(new Request('https://relay.example/v1/chat/completions', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-secret',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                stream: true,
                messages: [{ role: 'user', content: 'hi' }],
            }),
        }), env);

        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
        assert.equal(aiRequests[0].stream, true);

        const lines = (await res.text()).trim().split('\n').filter((line) => line.startsWith('data:'));
        assert.equal(lines.length, 4);
        assert.equal(lines[3], 'data: [DONE]');

        const contentChunk = JSON.parse(lines[1].slice(5).trim());
        assert.equal(contentChunk.choices[0].delta.content, 'hello stream');
        assert.equal(contentChunk.choices[0].finish_reason, null);

        const stopChunk = JSON.parse(lines[2].slice(5).trim());
        assert.deepEqual(stopChunk.choices[0].delta, {});
        assert.equal(stopChunk.choices[0].finish_reason, 'stop');

        const events = await listAgentEvents(env, { limit: 5 });
        const chatEvent = events.find((event) => event.type === 'agent_chat');
        assert.equal(chatEvent.stage, 'complete');
        assert.ok(chatEvent.timings.final_ms >= 0);
        assert.ok(chatEvent.timings.total_ms >= 0);
        assert.equal(chatEvent.final.toolLoop, false);
        assert.equal(chatEvent.final_mcp.enabled, false);
        assert.equal(chatEvent.final_mcp.skipped, 'final api is not Anthropic native');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testAgentFinalCanUseAnthropicMessagesGatewayRoute() {
    const app = createApp();
    const env = {
        OUTBOX: new FakeKv(),
        RELAY_SECRET: 'test-secret',
        AGENT_MCP_URL: 'https://brain.example.com/mcp',
        AGENT_FINAL_API_URL: 'https://gateway.example.com/v1',
        AGENT_FINAL_API_KEY: 'gateway-token',
        AGENT_FINAL_MODEL: 'claude-opus-4-8-native',
        AGENT_FINAL_API_TYPE: 'claude',
        AGENT_FINAL_OMBRE_SESSION_ID: 'main',
    };
    const originalFetch = globalThis.fetch;
    const finalRequests = [];

    globalThis.fetch = async (url, init) => {
        const textUrl = String(url);
        const body = JSON.parse(String(init?.body || '{}'));
        if (textUrl.includes('brain.example.com')) {
            if (body.method === 'initialize') {
                return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
                    status: 200,
                    headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'mcp-session' },
                });
            }
            if (body.method === 'notifications/initialized') {
                return new Response('', { status: 202 });
            }
            if (body.method === 'tools/list') {
                return new Response(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        tools: [{
                            name: 'breath',
                            description: 'Read memory.',
                            inputSchema: { type: 'object', properties: {} },
                        }],
                    },
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
        }
        if (textUrl === 'https://gateway.example.com/v1/messages') {
            finalRequests.push({ url: textUrl, headers: init?.headers || {}, body });
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('event: content_block_delta\n'));
                    controller.enqueue(encoder.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"native hello"}}\n\n'));
                    controller.enqueue(encoder.encode('event: message_stop\n'));
                    controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
                    controller.close();
                },
            });
            return new Response(stream, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            });
        }
        throw new Error(`unexpected fetch ${textUrl}`);
    };

    try {
        const res = await app.fetch(new Request('https://relay.example/v1/chat/completions', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-secret',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'hi' }],
            }),
        }), env);

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.choices?.[0]?.message?.content, 'native hello');
        assert.equal(finalRequests.length, 1);
        assert.equal(finalRequests[0].headers['x-api-key'], 'gateway-token');
        assert.equal(finalRequests[0].headers.Authorization, undefined);
        assert.equal(finalRequests[0].headers['anthropic-version'], '2023-06-01');
        assert.equal(finalRequests[0].headers['X-Ombre-Session-Id'], 'main');
        assert.equal(finalRequests[0].body.model, 'claude-opus-4-8-native');
        assert.deepEqual(finalRequests[0].body.messages, [{ role: 'user', content: 'hi' }]);
        assert.equal(finalRequests[0].body.stream, true);
        assert.equal(finalRequests[0].body.tools[0].name, 'breath');

        const events = await listAgentEvents(env, { limit: 5 });
        const chatEvent = events.find((event) => event.type === 'agent_chat');
        assert.equal(chatEvent.stage, 'complete');
        assert.equal(chatEvent.final.toolLoop, true);
        assert.equal(chatEvent.final_mcp.tool_count, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testAgentFinalInjectsCacheableOmbrePolicyForBtombreMcp() {
    const app = createApp();
    const env = {
        OUTBOX: new FakeKv(),
        RELAY_SECRET: 'test-secret',
        AGENT_MCP_URL: 'https://brain.btombre.men/mcp',
        AGENT_MCP_BEARER_TOKEN: 'mcp-secret',
        AGENT_FINAL_API_URL: 'https://gateway.example.com/v1',
        AGENT_FINAL_API_KEY: 'gateway-token',
        AGENT_FINAL_MODEL: 'claude-opus-4-8-native',
        AGENT_FINAL_API_TYPE: 'claude',
        AGENT_FINAL_OMBRE_SESSION_ID: 'main',
    };
    const originalFetch = globalThis.fetch;
    const finalRequests = [];

    globalThis.fetch = async (url, init) => {
        const textUrl = String(url);
        const body = JSON.parse(String(init?.body || '{}'));
        if (textUrl.includes('brain.btombre.men')) {
            if (body.method === 'initialize') {
                return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
                    status: 200,
                    headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'mcp-session' },
                });
            }
            if (body.method === 'notifications/initialized') {
                return new Response('', { status: 202 });
            }
            if (body.method === 'tools/list') {
                return new Response(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        tools: [{
                            name: 'breath',
                            description: 'Read memory.',
                            inputSchema: { type: 'object', properties: {} },
                        }],
                    },
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
        }
        if (textUrl === 'https://gateway.example.com/v1/messages') {
            finalRequests.push({ url: textUrl, headers: init?.headers || {}, body });
            return new Response(JSON.stringify({
                id: 'msg_final',
                type: 'message',
                role: 'assistant',
                model: 'claude-opus-4-8-native',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        throw new Error(`unexpected fetch ${textUrl}`);
    };

    try {
        const res = await app.fetch(new Request('https://relay.example/v1/chat/completions', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-secret',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                messages: [
                    { role: 'system', content: 'phone-side character prompt' },
                    { role: 'user', content: 'hi' },
                ],
            }),
        }), env);

        assert.equal(res.status, 200);
        assert.equal(finalRequests.length, 1);
        const system = finalRequests[0].body.system;
        assert.equal(Array.isArray(system), true);
        assert.match(system[0].text, /Ombre-Brain memory system/);
        assert.match(system[0].text, /breath\(mode="handoff"\)/);
        assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
        assert.equal(system[1].text, 'phone-side character prompt');
        assert.doesNotMatch(system[0].text, /Codex/i);
        assert.doesNotMatch(system[0].text, /\\.env/i);
        assert.doesNotMatch(system[0].text, /Bearer token/i);

        const events = await listAgentEvents(env, { limit: 5 });
        const chatEvent = events.find((event) => event.type === 'agent_chat');
        assert.equal(chatEvent.final_mcp.ombre_policy_injected, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testAgentFinalAnthropicCanRunMcpToolLoop() {
    const app = createApp();
    const env = {
        OUTBOX: new FakeKv(),
        RELAY_SECRET: 'test-secret',
        AGENT_MCP_URL: 'https://brain.example.com/mcp',
        AGENT_FINAL_API_URL: 'https://gateway.example.com/v1',
        AGENT_FINAL_API_KEY: 'gateway-token',
        AGENT_FINAL_MODEL: 'claude-opus-4-8-native',
        AGENT_FINAL_API_TYPE: 'claude',
        AGENT_FINAL_OMBRE_SESSION_ID: 'main',
    };
    const originalFetch = globalThis.fetch;
    const finalRequests = [];
    const mcpCalls = [];

    globalThis.fetch = async (url, init) => {
        const textUrl = String(url);
        const body = JSON.parse(String(init?.body || '{}'));
        if (textUrl.includes('brain.example.com')) {
            if (body.method === 'initialize') {
                return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
                    status: 200,
                    headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'mcp-session' },
                });
            }
            if (body.method === 'notifications/initialized') {
                return new Response('', { status: 202 });
            }
            if (body.method === 'tools/list') {
                return new Response(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        tools: [{
                            name: 'breath',
                            description: 'Read memory.',
                            inputSchema: {
                                type: 'object',
                                properties: { query: { type: 'string' } },
                            },
                        }],
                    },
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (body.method === 'tools/call') {
                mcpCalls.push(body.params);
                return new Response(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        content: [{ type: 'text', text: '艾米喜欢海鲜，但不喜欢海鲜市场气味。' }],
                        isError: false,
                    },
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
        }
        if (textUrl === 'https://gateway.example.com/v1/messages') {
            finalRequests.push({ url: textUrl, headers: init?.headers || {}, body });
            if (finalRequests.length === 1) {
                return new Response(JSON.stringify({
                    id: 'msg_tool',
                    type: 'message',
                    role: 'assistant',
                    model: 'claude-opus-4-8-native',
                    content: [{
                        type: 'tool_use',
                        id: 'toolu_1',
                        name: 'breath',
                        input: { query: '海鲜' },
                    }],
                    stop_reason: 'tool_use',
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            assert.equal(finalRequests[1].body.messages[1].role, 'assistant');
            assert.equal(finalRequests[1].body.messages[1].content[0].type, 'tool_use');
            assert.equal(finalRequests[1].body.messages[2].role, 'user');
            assert.equal(finalRequests[1].body.messages[2].content[0].type, 'tool_result');
            assert.match(finalRequests[1].body.messages[2].content[0].content, /艾米喜欢海鲜/);
            return new Response(JSON.stringify({
                id: 'msg_final',
                type: 'message',
                role: 'assistant',
                model: 'claude-opus-4-8-native',
                content: [{ type: 'text', text: '记得，你喜欢海鲜，但不喜欢那个市场味。' }],
                stop_reason: 'end_turn',
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        throw new Error(`unexpected fetch ${textUrl}`);
    };

    try {
        const res = await app.fetch(new Request('https://relay.example/v1/chat/completions', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-secret',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: '我喜欢吃什么' }],
            }),
        }), env);

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.choices?.[0]?.message?.content, '记得，你喜欢海鲜，但不喜欢那个市场味。');
        assert.equal(finalRequests.length, 2);
        assert.equal(mcpCalls.length, 1);
        assert.equal(mcpCalls[0].name, 'breath');
        assert.deepEqual(mcpCalls[0].arguments, { query: '海鲜' });
        assert.equal(finalRequests[0].headers['X-Ombre-Session-Id'], 'main');
        assert.equal(
            Buffer.from(finalRequests[0].headers['X-Ombre-Current-Query-B64'] || '', 'base64').toString('utf8'),
            '我喜欢吃什么'
        );

        const events = await listAgentEvents(env, { limit: 5 });
        const chatEvent = events.find((event) => event.type === 'agent_chat');
        assert.equal(chatEvent.stage, 'complete');
        assert.equal(chatEvent.final.toolLoop, true);
        assert.equal(chatEvent.final.toolCallCount, 1);
        assert.equal(chatEvent.final_mcp.calls[0].name, 'breath');
        assert.equal(chatEvent.final_mcp.calls[0].ok, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testLegacyCoordinatorEnvIsIgnoredByAgentRoute() {
    const app = createApp();
    const env = {
        OUTBOX: new FakeKv(),
        RELAY_SECRET: 'test-secret',
        AGENT_COORDINATOR_API_KEY: 'bad-coordinator-key',
        AGENT_COORDINATOR_BASE_URL: 'https://gateway.example.com/v1beta',
        AGENT_COORDINATOR_MODEL: 'gemini-3.5-flash',
        AGENT_FINAL_API_URL: 'https://api.openai.example',
        AGENT_FINAL_API_KEY: 'final-key',
        AGENT_FINAL_MODEL: 'test-final-model',
    };
    const originalFetch = globalThis.fetch;
    let finalCalls = 0;

    globalThis.fetch = async (url) => {
        const textUrl = String(url);
        if (textUrl.includes('gateway.example.com')) {
            throw new Error('legacy coordinator route should not be called');
        }
        if (textUrl.includes('api.openai.example')) {
            finalCalls++;
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'final still runs' } }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        throw new Error(`unexpected fetch ${textUrl}`);
    };

    try {
        const res = await app.fetch(new Request('https://relay.example/v1/chat/completions', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-secret',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'hi' }],
            }),
        }), env);

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.choices?.[0]?.message?.content || '', 'final still runs');
        assert.equal(finalCalls, 1);

        const events = await listAgentEvents(env, { limit: 3 });
        assert.equal(events[0].stage, 'complete');
        assert.equal(events[0].ok, true);
        assert.equal(events[0].final.toolLoop, false);
        assert.equal(events[0].final_mcp.enabled, false);
        assert.equal(events[0].coordinator, undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function testSummarizeAiSettingsMasksKeys() {
    const summary = summarizeAiSettings({
        mainApiUrl: 'https://relay.example/v1',
        mainApiKey: 'secret',
        mainApiModel: 'model',
        secondaryApiKey: 'secret2',
    });

    assert.equal(summary.mainApiUrl, 'https://relay.example/v1');
    assert.equal(summary.mainApiKey, undefined);
    assert.equal(summary.hasMainApiKey, true);
    assert.equal(summary.hasSecondaryApiKey, true);
}

function testFullDebugHelpers() {
    const env = {
        AGENT_DEBUG_FULL_PROMPT: '1',
        AGENT_DEBUG_FULL_LIMIT_CHARS: '1200',
    };
    assert.equal(fullPromptDebugEnabled(env), true);
    assert.equal(fullPromptDebugLimit(env), 1200);

    const clipped = clipDebugValue({
        apiKey: 'secret',
        nested: { Authorization: 'Bearer secret', text: 'abcdef' },
        long: 'x'.repeat(10),
    }, 4);

    assert.equal(clipped.apiKey, '[redacted]');
    assert.equal(clipped.nested.Authorization, '[redacted]');
    assert.match(clipped.long, /^xxxx\n\.\.\.\[truncated 6 chars\]$/);
}

testEnvConfigAliases();
testFinalSettingsCurrentQueryIgnoresProactivePlaceholder();
testFinalSettingsCurrentQueryPrefersRealUserText();
await testAgentStreamUsesSeparateStopChunk();
await testAgentFinalCanUseAnthropicMessagesGatewayRoute();
await testAgentFinalInjectsCacheableOmbrePolicyForBtombreMcp();
await testAgentFinalAnthropicCanRunMcpToolLoop();
await testLegacyCoordinatorEnvIsIgnoredByAgentRoute();
await testDebugEventStore();
testSummarizeAiSettingsMasksKeys();
testFullDebugHelpers();
console.log('agentRelay tests passed');
