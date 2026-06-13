import assert from 'node:assert/strict';
import { API_CONFIGS, API_TYPES } from '../src/ai/apiConfigs.js';
import { runGeneration } from '../src/ai/aiCaller.js';

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

testGeminiNonStreamJoinsAllTextParts();
testClaudeNonStreamJoinsAllTextBlocks();
await testSseFinalDataLineWithoutTrailingNewlineIsParsed();
console.log('aiParsing tests passed');
