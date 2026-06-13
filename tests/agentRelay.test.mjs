import assert from 'node:assert/strict';
import {
    appendRelevantInfoMessage,
    buildCoordinatorConfig,
    buildFinalSettings,
    buildMcpServerConfig,
} from '../src/agent/agentRelay.js';
import {
    buildGeminiFunctionResponseContent,
    buildFunctionResponsePart,
    formatMessagesForCoordinator,
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
        AGENT_COORDINATOR_API_KEY: 'gemini-key',
        AGENT_FINAL_API_URL: 'https://claude-proxy.example.com',
        AGENT_FINAL_API_KEY: 'final-key',
    };

    assert.deepEqual(buildMcpServerConfig(env), {
        url: 'https://brain.example.com/mcp',
        auth: { type: 'bearer', value: 'secret' },
    });
    assert.equal(buildCoordinatorConfig(env).apiKey, 'gemini-key');
    assert.equal(buildFinalSettings(env).mainApiModel, 'claude-opus-4-8');
}

function testCoordinatorMessageFormatting() {
    const text = formatMessagesForCoordinator([
        { role: 'system', content: 'persona' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
    ]);

    assert.match(text, /Original request transcript/);
    assert.match(text, /\[1\] system:\npersona/);
    assert.match(text, /\[2\] user:\nhi\n\[image attachment: image\/png/);
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
testCoordinatorMessageFormatting();
testGeminiFunctionResponseUsesUserRole();
await testDebugEventStore();
testSummarizeAiSettingsMasksKeys();
testFullDebugHelpers();
console.log('agentRelay tests passed');
