import assert from 'node:assert/strict';
import {
    normalizeCommitment,
    parseCommitmentsFromContent,
    pendingCommitmentBlockReason,
} from '../src/util/commitments.js';

function testParsesRelativeCommitment() {
    const now = 100_000;
    const [commitment] = parseCommitmentsFromContent([
        '普通文本',
        '{"t":"commitment","at":"+5min","kind":"activity","hint":"换衣服"}',
    ].join('\n'), { now });

    assert.equal(commitment.kind, 'activity');
    assert.equal(commitment.hint, '换衣服');
    assert.equal(commitment.dueAt, now + 5 * 60_000);
}

function testStoredDueAtDoesNotSlideForward() {
    const createdAt = 100_000;
    const dueAt = createdAt + 5 * 60_000;
    const later = createdAt + 10 * 60_000;
    const stored = {
        t: 'commitment',
        at: '+5min',
        kind: 'activity',
        hint: '换衣服',
        dueAt,
        createdAt,
    };

    assert.equal(normalizeCommitment(stored, { now: later }).dueAt, dueAt);
    assert.equal(pendingCommitmentBlockReason([stored], later), '');
}

testParsesRelativeCommitment();
testStoredDueAtDoesNotSlideForward();
console.log('commitments tests passed');
