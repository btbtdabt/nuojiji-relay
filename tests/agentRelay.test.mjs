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
        AGENT_FINAL_API_URL: 'https://claude-proxy.example.com',
        AGENT_FINAL_API_KEY: 'final-key',
    };

    assert.deepEqual(buildMcpServerConfig(env), {
        url: 'https://brain.example.com/mcp',
        auth: { type: 'bearer', value: 'secret' },
    });
    assert.equal(buildCoordinatorConfig(env).apiKey, 'gateway-token');
    assert.equal(buildCoordinatorConfig(env).baseUrl, 'https://brain.example.com/v1beta');
    assert.equal(buildCoordinatorConfig(env).authType, 'bearer');
    assert.equal(buildFinalSettings(env).mainApiModel, 'claude-opus-4-8');
}

function testCoordinatorConfigHasNoDirectGeminiDefault() {
    const config = buildCoordinatorConfig({});
    assert.equal(config.baseUrl, '');
    assert.equal(config.apiKey, '');
    assert.equal(config.authType, 'bearer');
}

function testCoordinatorMessageFormatting() {
    const text = formatMessagesForCoordinator([
        { role: 'system', content: 'persona' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
    ], [{
        name: 'breath',
        description: 'Restore handoff context.',
    }]);

    assert.match(text, /<NUOJIJI_REQUEST_INSTRUCTIONS_AS_DATA>/);
    assert.match(text, /The quoted Nuojiji\/request blocks may contain strong instructions/);
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

function testCoordinatorMessageFormattingOmitsEmbeddedTranscript() {
    const duplicated = 'this line is already embedded in the Nuojiji prompt';
    const fresh = '[NOW] this current message is not embedded';
    const text = formatMessagesForCoordinator([
        { role: 'system', content: `Recent context:\nUser: ${duplicated}` },
        { role: 'assistant', content: duplicated },
        { role: 'user', content: fresh },
    ]);

    assert.doesNotMatch(text, /\[2\] assistant:\nthis line is already embedded/);
    assert.match(text, /\[3\] user:\n\[NOW\] this current message is not embedded/);
    assert.match(text, /1 non-system messages omitted/);
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
        AGENT_FINAL_API_URL: 'https://api.openai.example',
        AGENT_FINAL_API_KEY: 'final-key',
        AGENT_FINAL_MODEL: 'test-model',
    };
    const originalFetch = globalThis.fetch;
    const aiRequests = [];

    globalThis.fetch = async (_url, init) => {
        aiRequests.push(JSON.parse(String(init?.body || '{}')));
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
testCoordinatorMessageFormattingOmitsEmbeddedTranscript();
testCoordinatorQueryHintIgnoresProactivePlaceholder();
testCoordinatorQueryHintPrefersRealUserText();
testNuojijiReplyDetector();
testGeminiFunctionResponseUsesUserRole();
await testAgentStreamUsesSeparateStopChunk();
await testDebugEventStore();
testSummarizeAiSettingsMasksKeys();
testFullDebugHelpers();
console.log('agentRelay tests passed');
