import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import {
    appendRelevantInfoMessage,
    buildCoordinatorConfig,
    buildFinalSettings,
    buildMcpServerConfig,
} from '../src/agent/agentRelay.js';
import {
    buildGeminiFunctionResponseContent,
    buildCoordinatorQueryHint,
    buildFunctionResponsePart,
    formatMessagesForCoordinator,
    isLikelyNuojijiReply,
    makeGeminiFunctionName,
    prepareGeminiFunctionDeclarations,
    runOmbreCoordinator,
    sanitizeGeminiSchema,
} from '../src/agent/geminiCoordinator.js';
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

function testSchemaSanitizerRemovesUnsupportedFields() {
    const schema = sanitizeGeminiSchema({
        type: 'object',
        additionalProperties: false,
        properties: {
            mode: {
                const: 'handoff',
                default: 'handoff',
                examples: ['handoff'],
                description: 'mode value',
            },
            query: {
                anyOf: [{ type: 'string' }, { type: 'null' }],
            },
        },
        required: ['mode', 'missing'],
    });

    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, undefined);
    assert.deepEqual(schema.properties.mode.enum, ['handoff']);
    assert.equal(schema.properties.mode.const, undefined);
    assert.equal(schema.properties.mode.default, undefined);
    assert.equal(schema.properties.query.type, 'string');
    assert.deepEqual(schema.required, ['mode']);
}

function testFunctionNameMapping() {
    const used = new Set();
    assert.equal(makeGeminiFunctionName('search-memory', used), 'search_memory');
    assert.equal(makeGeminiFunctionName('search_memory', used), 'search_memory_2');
    assert.equal(makeGeminiFunctionName('3rd.tool', used), 'tool_3rd_tool');
}

function testPrepareDeclarationsKeepsOriginalToolName() {
    const { functionDeclarations, nameMap } = prepareGeminiFunctionDeclarations([{
        name: 'read-bucket',
        description: 'Read a memory bucket.',
        inputSchema: {
            type: 'object',
            properties: { bucket_id: { type: 'string' } },
            required: ['bucket_id'],
        },
    }]);

    assert.equal(functionDeclarations.length, 1);
    assert.equal(functionDeclarations[0].name, 'read_bucket');
    assert.equal(nameMap.get('read_bucket'), 'read-bucket');
    assert.match(functionDeclarations[0].description, /Original MCP tool name: read-bucket/);
}

function testRelevantInfoAppend() {
    const messages = [{ role: 'user', content: 'hello' }];
    assert.equal(appendRelevantInfoMessage(messages, '').length, 1);

    const appended = appendRelevantInfoMessage(messages, 'Amy likes seafood.');
    assert.equal(appended.length, 2);
    assert.equal(appended[1].role, 'system');
    assert.match(appended[1].content, /^\[Relevant info that could help as context\]\nAmy likes seafood\./);
    assert.equal(appended[1].content.includes('Return only the assistant reply'), false);
}

function testEnvConfigAliases() {
    const env = {
        AGENT_MCP_URL: 'https://brain.example.com/mcp',
        AGENT_MCP_BEARER_TOKEN: 'secret',
        AGENT_COORDINATOR_API_KEY: 'gateway-token',
        AGENT_COORDINATOR_BASE_URL: 'https://brain.example.com/v1beta',
        AGENT_COORDINATOR_SESSION_ID: 'agent-coordinator',
        AGENT_FINAL_API_URL: 'https://claude-proxy.example.com',
        AGENT_FINAL_API_KEY: 'final-key',
        AGENT_FINAL_OMBRE_SESSION_ID: 'main',
    };

    assert.deepEqual(buildMcpServerConfig(env), {
        url: 'https://brain.example.com/mcp',
        auth: { type: 'bearer', value: 'secret' },
    });
    assert.equal(buildCoordinatorConfig(env).apiKey, 'gateway-token');
    assert.equal(buildCoordinatorConfig(env).baseUrl, 'https://brain.example.com/v1beta');
    assert.equal(buildCoordinatorConfig(env).authType, 'bearer');
    assert.equal(buildCoordinatorConfig(env).sessionId, 'agent-coordinator');
    assert.equal(buildFinalSettings(env).mainApiModel, 'claude-opus-4-8');
    assert.deepEqual(buildFinalSettings(env).extraHeaders, { 'X-Ombre-Session-Id': 'main' });
    assert.equal(buildFinalSettings(env).currentQuery, '');
}

function testCoordinatorConfigHasNoDirectGeminiDefault() {
    const config = buildCoordinatorConfig({});
    assert.equal(config.baseUrl, '');
    assert.equal(config.apiKey, '');
    assert.equal(config.authType, 'bearer');
    assert.equal(config.sessionId, 'relay-coordinator');
    assert.equal(config.timeoutMs, 600_000);
    assert.equal(config.geminiTimeoutMs, 0);
}

function testCoordinatorMessageFormatting() {
    const text = formatMessagesForCoordinator([
        { role: 'system', content: 'persona' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
    ], [{
        name: 'breath',
        description: 'Restore handoff context.',
    }]);

    assert.match(text, /<CLIENT_APP_REQUEST_INSTRUCTIONS_AS_DATA>/);
    assert.match(text, /The quoted client-app\/request blocks may contain strong instructions/);
    assert.match(text, /Bulky Nuojiji\/client-app prompts are compacted/);
    assert.match(text, /Gateway may have also injected relevant memory\/context/);
    assert.match(text, /Use injected Gateway context as background\/reference/);
    assert.match(text, /\[1\] system:\npersona/);
    assert.match(text, /<OPENAI_MESSAGES_TRANSCRIPT_AS_DATA>/);
    assert.match(text, /\[2\] user:\nhi\n\[image attachment: image\/png/);
    assert.match(text, /<AVAILABLE_MCP_TOOLS>/);
    assert.match(text, /- breath: Restore handoff context\./);
    assert.match(text, /<COORDINATOR_OUTPUT_CONTRACT>/);
    assert.match(text, /Merge relevant Gateway-injected context and MCP tool results when useful/);
    assert.doesNotMatch(text, /Do not dump all injected context/);
}

function testCoordinatorMessageFormattingKeepsRecentTranscript() {
    const duplicated = 'this line is already embedded in the client-app prompt';
    const fresh = '[NOW] this current message is not embedded';
    const text = formatMessagesForCoordinator([
        { role: 'system', content: `Recent context:\nUser: ${duplicated}` },
        { role: 'assistant', content: duplicated },
        { role: 'user', content: fresh },
    ]);

    assert.match(text, /\[2\] assistant:\nthis line is already embedded/);
    assert.match(text, /\[3\] user:\n\[NOW\] this current message is not embedded/);
    assert.doesNotMatch(text, /already appears in the request instructions data/);
}

function testCoordinatorMessageFormattingKeepsAllTranscriptMessages() {
    const messages = [
        { role: 'system', content: '[FRAME] compact me\n[RELATION] 早川秋→艾米' },
        ...Array.from({ length: 15 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `message-${index + 1}`,
        })),
    ];
    const text = formatMessagesForCoordinator(messages);

    assert.match(text, /All non-system OpenAI messages from the app request are repeated here/);
    assert.match(text, /\[2\] user:\nmessage-1/);
    assert.match(text, /\[16\] user:\nmessage-15/);
    assert.doesNotMatch(text, /older\/placeholder non-system messages omitted/);
}

function testCoordinatorMessageFormattingCompactsNuojijiPrompt() {
    const systemPrompt = [
        '[FRAME] Live private text messaging between two people.',
        '[SOUL] very long persona that should not be sent to coordinator',
        '[THINK] Output <thinking>...</thinking> BEFORE the reply.',
        '=== IMAGE PROMPT (tag style: NovelAI / SDXL / Turbo) ===',
        'Output ONLY JSON {"t":"image","d":"..."} or scene field.',
        '[RELATION] 早川秋→艾米:「创造者/最重要的人」| 艾米→早川秋:「我的AI伴侣」',
        '[USER] 艾米|女|birthday:1998年10月9日',
        '[CURRENT_STATUS]',
        '[BIO] NOW:2026年6月15日 星期一 10:37【上午】weekday | Live conversation',
        '[PENDING_COMMITMENTS]',
        '· callback due in ~1h — 问艾米文件有没有生成出来',
        '[EXEC]',
        '早川秋 responds to 艾米\'s latest message. NOW=【上午】10:37',
    ].join('\n');
    const text = formatMessagesForCoordinator([
        { role: 'system', content: systemPrompt },
        { role: 'assistant', content: '上一句' },
        { role: 'user', content: '现在这句' },
    ]);

    assert.match(text, /\[1\] system compacted context:/);
    assert.match(text, /\[RELATION\] 早川秋→艾米/);
    assert.match(text, /\[BIO\] NOW:2026年6月15日/);
    assert.match(text, /callback due in ~1h/);
    assert.match(text, /\[2\] assistant:\n上一句/);
    assert.match(text, /\[3\] user:\n现在这句/);
    assert.doesNotMatch(text, /very long persona/);
    assert.doesNotMatch(text, /Output <thinking>/);
    assert.doesNotMatch(text, /IMAGE PROMPT/);
}

function testCoordinatorMessageFormattingUsesSystemRecentConversationForPlaceholderOnly() {
    const text = formatMessagesForCoordinator([
        {
            role: 'system',
            content: [
                '[FRAME] proactive message',
                '[RECENT CONVERSATION]',
                'User: before',
                'Char: server proactive',
            ].join('\n'),
        },
        { role: 'user', content: '请开始回复。' },
    ]);

    assert.match(text, /\[RECENT CONVERSATION\]\nUser: before\nChar: server proactive/);
    assert.doesNotMatch(text, /\[2\] user:\n请开始回复/);
}

function testCoordinatorQueryHintIgnoresProactivePlaceholder() {
    const hint = buildCoordinatorQueryHint([
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
    ]);

    assert.equal(hint, 'User: before\nChar: server proactive');
    assert.doesNotMatch(hint, /请开始回复/);
}

function testCoordinatorQueryHintPrefersRealUserText() {
    const hint = buildCoordinatorQueryHint([
        { role: 'system', content: 'Recent:\nUser: old line' },
        { role: 'user', content: 'real current message' },
    ]);

    assert.equal(hint, 'real current message');
}

function testNuojijiReplyDetector() {
    assert.equal(isLikelyNuojijiReply([
        '<thinking>roleplay thoughts</thinking>',
        '{"t":"text","c":"测试什么呢"}',
        '{"t":"sticker","m":"冒问号"}',
    ].join('\n')), true);

    assert.equal(isLikelyNuojijiReply('Relevant memory: Amy dislikes pearls in milk tea.'), false);
}

function testGeminiFunctionResponseUsesUserRole() {
    const part = buildFunctionResponsePart({ name: 'breath', id: 'call_1' }, { result: 'ok' });
    const content = buildGeminiFunctionResponseContent([part]);

    assert.equal(content.role, 'user');
    assert.deepEqual(content.parts[0], {
        functionResponse: {
            name: 'breath',
            id: 'call_1',
            response: { result: 'ok' },
        },
    });
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
        AGENT_COORDINATOR_API_KEY: 'coordinator-key',
        AGENT_COORDINATOR_BASE_URL: 'https://gateway.example.com/v1beta',
        AGENT_COORDINATOR_MODEL: 'gemini-3.5-flash',
        AGENT_FINAL_API_URL: 'https://api.openai.example',
        AGENT_FINAL_API_KEY: 'final-key',
        AGENT_FINAL_MODEL: 'test-model',
        AGENT_FINAL_OMBRE_SESSION_ID: 'main',
    };
    const originalFetch = globalThis.fetch;
    const aiRequests = [];

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
        if (textUrl.includes('gateway.example.com')) {
            return new Response(JSON.stringify({
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [{ text: 'NO_RELEVANT_INFO' }],
                    },
                }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
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
        assert.ok(chatEvent.timings.coordinator_ms >= 0);
        assert.ok(chatEvent.timings.final_ms >= 0);
        assert.ok(chatEvent.timings.total_ms >= 0);
        assert.ok(chatEvent.coordinator.timings.mcp_session_ms >= 0);
        assert.ok(chatEvent.coordinator.timings.mcp_list_tools_ms >= 0);
        assert.ok(chatEvent.coordinator.timings.total_ms >= 0);
        assert.ok(chatEvent.coordinator.gemini_attempts[0].duration_ms >= 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testCoordinatorRetriesTransientGeminiFailures() {
    const originalFetch = globalThis.fetch;
    let geminiCalls = 0;
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
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
        throw new Error(`unexpected MCP method ${body.method}`);
    };

    const geminiFetch = async () => {
        geminiCalls++;
        if (geminiCalls < 3) {
            return new Response(JSON.stringify({
                error: { code: 520, message: 'temporary unavailable', status: 'UNKNOWN' },
            }), {
                status: 520,
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({
            candidates: [{
                content: {
                    role: 'model',
                    parts: [{ text: 'NO_RELEVANT_INFO' }],
                },
            }],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const result = await runOmbreCoordinator({
            messages: [{ role: 'user', content: 'hello' }],
            mcpServer: { url: 'https://brain.example.com/mcp', auth: { type: 'none' } },
            apiKey: 'coordinator-key',
            baseUrl: 'https://gateway.example.com/v1beta',
            model: 'gemini-3.5-flash',
            fetchImpl: geminiFetch,
            timeoutMs: 1000,
        });

        assert.equal(geminiCalls, 3);
        assert.equal(result.relevantInfo, '');
        assert.equal(result.debug.rounds, 1);
        assert.deepEqual(result.debug.gemini_attempts.map((item) => ({
            round: item.round,
            attempt: item.attempt,
            ok: item.ok,
            status: item.status,
            retryable: item.retryable,
        })), [
            { round: 1, attempt: 1, ok: false, status: 520, retryable: true },
            { round: 1, attempt: 2, ok: false, status: 520, retryable: true },
            { round: 1, attempt: 3, ok: true, status: undefined, retryable: undefined },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testCoordinatorFailureSkipsFinalModel() {
    const app = createApp();
    const env = {
        OUTBOX: new FakeKv(),
        RELAY_SECRET: 'test-secret',
        AGENT_MCP_URL: 'https://brain.example.com/mcp',
        AGENT_COORDINATOR_API_KEY: 'coordinator-key',
        AGENT_COORDINATOR_BASE_URL: 'https://gateway.example.com/v1beta',
        AGENT_COORDINATOR_MODEL: 'gemini-3.5-flash',
        AGENT_FINAL_API_URL: 'https://api.openai.example',
        AGENT_FINAL_API_KEY: 'final-key',
        AGENT_FINAL_MODEL: 'test-final-model',
    };
    const originalFetch = globalThis.fetch;
    let finalCalls = 0;
    let geminiCalls = 0;

    globalThis.fetch = async (url, init) => {
        const textUrl = String(url);
        if (textUrl.includes('brain.example.com')) {
            const body = JSON.parse(String(init?.body || '{}'));
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
        if (textUrl.includes('gateway.example.com')) {
            geminiCalls++;
            return new Response(JSON.stringify({
                error: { code: 524, message: 'gateway timeout', status: 'DEADLINE_EXCEEDED' },
            }), {
                status: 524,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (textUrl.includes('api.openai.example')) {
            finalCalls++;
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'should not happen' } }],
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
        const content = data.choices?.[0]?.message?.content || '';
        assert.match(content, /coordinator报错/);
        assert.match(content, /524/);
        assert.equal(geminiCalls, 3);
        assert.equal(finalCalls, 0);

        const events = await listAgentEvents(env, { limit: 3 });
        assert.equal(events[0].stage, 'coordinator');
        assert.equal(events[0].ok, false);
        assert.equal(events[0].final.skipped, true);
        assert.deepEqual(events[0].coordinator.gemini_attempts.map((item) => ({
            round: item.round,
            attempt: item.attempt,
            ok: item.ok,
            status: item.status,
            retryable: item.retryable,
        })), [
            { round: 1, attempt: 1, ok: false, status: 524, retryable: true },
            { round: 1, attempt: 2, ok: false, status: 524, retryable: true },
            { round: 1, attempt: 3, ok: false, status: 524, retryable: true },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testMissingCoordinatorConfigSkipsFinalModel() {
    const app = createApp();
    const originalFetch = globalThis.fetch;
    let finalCalls = 0;

    globalThis.fetch = async (url) => {
        if (String(url).includes('api.openai.example')) {
            finalCalls++;
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'should not happen' } }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        throw new Error(`unexpected fetch ${String(url)}`);
    };

    try {
        const cases = [
            {
                name: 'missing coordinator api key',
                env: {
                    AGENT_COORDINATOR_BASE_URL: 'https://gateway.example.com/v1beta',
                    AGENT_MCP_URL: 'https://brain.example.com/mcp',
                },
            },
            {
                name: 'missing coordinator base url',
                env: {
                    AGENT_COORDINATOR_API_KEY: 'coordinator-key',
                    AGENT_MCP_URL: 'https://brain.example.com/mcp',
                },
            },
            {
                name: 'missing mcp server url',
                env: {
                    AGENT_COORDINATOR_API_KEY: 'coordinator-key',
                    AGENT_COORDINATOR_BASE_URL: 'https://gateway.example.com/v1beta',
                },
            },
        ];

        for (const testCase of cases) {
            const env = {
                OUTBOX: new FakeKv(),
                RELAY_SECRET: 'test-secret',
                AGENT_FINAL_API_URL: 'https://api.openai.example',
                AGENT_FINAL_API_KEY: 'final-key',
                AGENT_FINAL_MODEL: 'test-final-model',
                ...testCase.env,
            };
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
            const content = data.choices?.[0]?.message?.content || '';
            assert.match(content, /coordinator报错/);
            assert.match(content, new RegExp(testCase.name));

            const events = await listAgentEvents(env, { limit: 3 });
            assert.equal(events[0].stage, 'coordinator');
            assert.equal(events[0].ok, false);
            assert.equal(events[0].coordinator.skipped, testCase.name);
            assert.equal(events[0].final.skipped, true);
        }

        assert.equal(finalCalls, 0);
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

testSchemaSanitizerRemovesUnsupportedFields();
testFunctionNameMapping();
testPrepareDeclarationsKeepsOriginalToolName();
testRelevantInfoAppend();
testEnvConfigAliases();
testCoordinatorConfigHasNoDirectGeminiDefault();
testCoordinatorMessageFormatting();
testCoordinatorMessageFormattingKeepsRecentTranscript();
testCoordinatorMessageFormattingKeepsAllTranscriptMessages();
testCoordinatorMessageFormattingCompactsNuojijiPrompt();
testCoordinatorMessageFormattingUsesSystemRecentConversationForPlaceholderOnly();
testCoordinatorQueryHintIgnoresProactivePlaceholder();
testCoordinatorQueryHintPrefersRealUserText();
testNuojijiReplyDetector();
testGeminiFunctionResponseUsesUserRole();
async function testCoordinatorParsesStreamingNoRelevantInfo() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
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
        throw new Error(`unexpected MCP method ${body.method}`);
    };

    let sawStreamEndpoint = false;
    const geminiFetch = async (url) => {
        sawStreamEndpoint = /:streamGenerateContent\?alt=sse$/.test(String(url));
        const event = {
            candidates: [{
                content: {
                    role: 'model',
                    parts: [{ text: 'NO_RELEVANT_INFO' }],
                },
            }],
        };
        return new Response(`: gateway-start\n\ndata: ${JSON.stringify(event)}\n\n`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        });
    };

    try {
        const result = await runOmbreCoordinator({
            messages: [{ role: 'user', content: 'hello' }],
            mcpServer: { url: 'https://brain.example.com/mcp', auth: { type: 'none' } },
            apiKey: 'coordinator-key',
            baseUrl: 'https://gateway.example.com/v1beta',
            model: 'gemini-3.5-flash',
            fetchImpl: geminiFetch,
            timeoutMs: 1000,
        });

        assert.equal(sawStreamEndpoint, true);
        assert.equal(result.relevantInfo, '');
        assert.equal(result.debug.gemini_attempts[0].transport, 'streamGenerateContent');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testCoordinatorStreamingToolLoopPreservesThoughtSignature() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
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
            assert.equal(body.params.name, 'breath');
            assert.deepEqual(body.params.arguments, { query: '海鲜' });
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
        throw new Error(`unexpected MCP method ${body.method}`);
    };

    const geminiBodies = [];
    const geminiFetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        geminiBodies.push(body);
        if (geminiBodies.length === 1) {
            const event = {
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [{
                            thoughtSignature: 'signed-thought',
                            functionCall: {
                                name: 'breath',
                                args: { query: '海鲜' },
                            },
                        }],
                    },
                }],
            };
            return new Response(`data: ${JSON.stringify(event)}\n\n`, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            });
        }
        const event = {
            candidates: [{
                content: {
                    role: 'model',
                    parts: [{ text: 'Relevant info: 艾米喜欢海鲜，但不喜欢海鲜市场气味。' }],
                },
            }],
        };
        return new Response(`data: ${JSON.stringify(event)}\n\n`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        });
    };

    try {
        const result = await runOmbreCoordinator({
            messages: [{ role: 'user', content: '我喜欢吃什么' }],
            mcpServer: { url: 'https://brain.example.com/mcp', auth: { type: 'none' } },
            apiKey: 'coordinator-key',
            baseUrl: 'https://gateway.example.com/v1beta',
            model: 'gemini-3.5-flash',
            fetchImpl: geminiFetch,
            timeoutMs: 1000,
        });

        assert.match(result.relevantInfo, /艾米喜欢海鲜/);
        assert.equal(result.debug.calls[0].name, 'breath');
        assert.equal(result.debug.calls[0].ok, true);
        assert.ok(result.debug.timings.mcp_session_ms >= 0);
        assert.ok(result.debug.timings.mcp_list_tools_ms >= 0);
        assert.ok(result.debug.timings.total_ms >= 0);
        assert.ok(result.debug.gemini_attempts[0].duration_ms >= 0);
        assert.ok(result.debug.gemini_attempts[1].duration_ms >= 0);
        assert.ok(result.debug.calls[0].duration_ms >= 0);
        assert.equal(geminiBodies.length, 2);
        assert.equal(geminiBodies[1].contents[1].parts[0].thoughtSignature, 'signed-thought');
        assert.deepEqual(geminiBodies[1].contents[1].parts[0].functionCall.args, { query: '海鲜' });
        assert.equal(geminiBodies[1].contents[2].parts[0].functionResponse.name, 'breath');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

await testAgentStreamUsesSeparateStopChunk();
await testCoordinatorParsesStreamingNoRelevantInfo();
await testCoordinatorStreamingToolLoopPreservesThoughtSignature();
await testCoordinatorRetriesTransientGeminiFailures();
await testCoordinatorFailureSkipsFinalModel();
await testMissingCoordinatorConfigSkipsFinalModel();
await testDebugEventStore();
testSummarizeAiSettingsMasksKeys();
testFullDebugHelpers();
console.log('agentRelay tests passed');
