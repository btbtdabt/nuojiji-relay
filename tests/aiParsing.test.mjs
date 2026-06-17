import assert from 'node:assert/strict';
import { API_CONFIGS, API_TYPES } from '../src/ai/apiConfigs.js';
import { runGeneration } from '../src/ai/aiCaller.js';
import { buildChatRequestBody } from '../src/ai/requestBuilder.js';

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
testSystemOnlyOpenAiRequestIsNotGivenSyntheticUserText();
console.log('aiParsing tests passed');
