import assert from 'node:assert/strict';
import { extractPushBodies } from '../src/util/ids.js';

function testExtractPushBodiesIncludesReplyBubbles() {
    const bodies = extractPushBodies([
        '{"t":"reply","quote":"你自己也开不了","c":"对 这点你戳穿了"}',
        '{"t":"text","s":"N","c":"我在服务器里 手伸不进你电脑"}',
        '{"t":"xinsheng","innerVoice":"silent"}',
    ].join('\n'));

    assert.deepEqual(bodies, [
        '回复「你自己也开不了」：对 这点你戳穿了',
        '我在服务器里 手伸不进你电脑',
    ]);
}

function testExtractPushBodiesReplyFallsBackToContentWithoutQuote() {
    const bodies = extractPushBodies('{"t":"reply","c":"直接接这句"}');

    assert.deepEqual(bodies, ['直接接这句']);
}

testExtractPushBodiesIncludesReplyBubbles();
testExtractPushBodiesReplyFallsBackToContentWithoutQuote();
console.log('ids tests passed');
