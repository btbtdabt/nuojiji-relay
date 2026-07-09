import assert from 'node:assert/strict';
import { API_CONFIGS, API_TYPES } from '../src/ai/apiConfigs.js';
import { runGeneration } from '../src/ai/aiCaller.js';
import { buildApiHeaders, buildChatEndpoint, buildChatRequestBody } from '../src/ai/requestBuilder.js';

function testGeminiNonStreamJoinsAllTextParts() {
    const content = API_CONFIGS[API_TYPES.GEMINI].extractContent({
        candidates: [{
            content: {
                parts: [
                    { inlineData: { mimeType: 'image/png', data: 'abc' } },
                    { text: 'first ' },
                    { text: 'second' },
                ],
            },
        }],
    });

    assert.equal(content, 'first second');
}

function testClaudeNonStreamJoinsAllTextBlocks() {
    const content = API_CONFIGS[API_TYPES.CLAUDE].extractContent({
        content: [
            { type: 'tool_use', id: 'toolu_1', name: 'noop', input: {} },
            { type: 'text', text: 'first ' },
            { type: 'text', text: 'second' },
        ],
    });

    assert.equal(content, 'first second');
}

async function testSseFinalDataLineWithoutTrailingNewlineIsParsed() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first "}}]}\n\n'));
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"final chunk"}}]}'));
                controller.close();
            },
        });
        return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        });
    };

    try {
        const content = await runGeneration({
            mainApiUrl: 'https://api.openai.example',
            mainApiKey: 'test-key',
            mainApiModel: 'test-model',
            apiType: 'openai',
            autoRetryEnabled: false,
            secondaryFallbackEnabled: false,
        }, [{ role: 'user', content: 'go' }]);

        assert.equal(content, 'first final chunk');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testRunGenerationAddsCurrentQueryHeaderWithoutChangingMessages() {
    const originalFetch = globalThis.fetch;
    let captured = null;
    const messages = [{ role: 'system', content: 'Generate one proactive message.' }];
    globalThis.fetch = async (_url, init) => {
        captured = {
            headers: init?.headers || {},
            body: JSON.parse(String(init?.body || '{}')),
        };
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            },
        });
        return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        });
    };

    try {
        const content = await runGeneration({
            mainApiUrl: 'https://gateway.example.com/v1',
            mainApiKey: 'test-key',
            mainApiModel: 'test-model',
            apiType: 'openai',
            currentQuery: 'Proactive: 海鲜偏好',
            autoRetryEnabled: false,
            secondaryFallbackEnabled: false,
        }, messages);

        assert.equal(content, 'ok');
        assert.deepEqual(captured.body.messages, messages);
        assert.equal(JSON.stringify(captured.body).includes('请开始回复'), false);
        const encoded = captured.headers['X-Ombre-Current-Query-B64'];
        assert.ok(encoded);
        assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'Proactive: 海鲜偏好');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testRunGenerationHasNoLocalAbortSignalByDefault() {
    const originalFetch = globalThis.fetch;
    let hasAbortSignal = true;
    globalThis.fetch = async (_url, init) => {
        hasAbortSignal = Object.prototype.hasOwnProperty.call(init || {}, 'signal');
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
                controller.close();
            },
        });
        return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        });
    };

    try {
        const content = await runGeneration({
            mainApiUrl: 'https://gateway.example.com/v1',
            mainApiKey: 'test-key',
            mainApiModel: 'test-model',
            apiType: 'openai',
            autoRetryEnabled: false,
            secondaryFallbackEnabled: false,
        }, [{ role: 'user', content: 'go' }]);

        assert.equal(content, 'ok');
        assert.equal(hasAbortSignal, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testClaudeApiTypeUsesAnthropicMessagesAgainstGateway() {
    const endpoint = buildChatEndpoint('https://gateway.example.com/v1', 'claude');
    assert.equal(endpoint, 'https://gateway.example.com/v1/messages');
    const headers = buildApiHeaders('https://gateway.example.com/v1', 'gateway-token', {}, 'claude');
    assert.equal(headers['x-api-key'], 'gateway-token');
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers['anthropic-version'], '2023-06-01');

    const body = buildChatRequestBody({
        apiUrl: 'https://gateway.example.com/v1',
        apiType: 'claude',
        model: 'claude-opus-4-8-native',
        messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'hi' },
        ],
        stream: true,
        maxTokens: 128,
    });
    assert.equal(body.model, 'claude-opus-4-8-native');
    assert.equal(body.system, 'system prompt');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(body.max_tokens, 128);
    assert.equal(body.stream, true);

    const originalFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
        captured = {
            url: String(url),
            headers: init?.headers || {},
            body: JSON.parse(String(init?.body || '{}')),
        };
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('event: message_start\n'));
                controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n'));
                controller.enqueue(encoder.encode('event: content_block_delta\n'));
                controller.enqueue(encoder.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello native"}}\n\n'));
                controller.enqueue(encoder.encode('event: message_stop\n'));
                controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
                controller.close();
            },
        });
        return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        });
    };

    try {
        const content = await runGeneration({
            mainApiUrl: 'https://gateway.example.com/v1',
            mainApiKey: 'gateway-token',
            mainApiModel: 'claude-opus-4-8-native',
            apiType: 'claude',
            currentQuery: 'hi',
            autoRetryEnabled: false,
            secondaryFallbackEnabled: false,
        }, [{ role: 'user', content: 'hi' }]);

        assert.equal(content, 'hello native');
        assert.equal(captured.url, 'https://gateway.example.com/v1/messages');
        assert.equal(captured.headers['x-api-key'], 'gateway-token');
        assert.equal(captured.headers.Authorization, undefined);
        assert.equal(captured.body.model, 'claude-opus-4-8-native');
        assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'hi' }]);
        assert.equal(captured.body.stream, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function testSystemOnlyOpenAiRequestIsNotGivenSyntheticUserText() {
    const messages = [{ role: 'system', content: 'Generate one proactive message.' }];
    const body = buildChatRequestBody({
        apiUrl: 'https://gemini.amydong.workers.dev/v1',
        model: 'gemini-3.5-flash',
        messages,
        temperature: 0.7,
        stream: true,
        maxTokens: 128,
    });

    assert.deepEqual(body.messages, messages);
    assert.equal(JSON.stringify(body).includes('请开始回复'), false);
}

testGeminiNonStreamJoinsAllTextParts();
testClaudeNonStreamJoinsAllTextBlocks();
await testSseFinalDataLineWithoutTrailingNewlineIsParsed();
await testRunGenerationAddsCurrentQueryHeaderWithoutChangingMessages();
await testRunGenerationHasNoLocalAbortSignalByDefault();
await testClaudeApiTypeUsesAnthropicMessagesAgainstGateway();
testSystemOnlyOpenAiRequestIsNotGivenSyntheticUserText();
console.log('aiParsing tests passed');
