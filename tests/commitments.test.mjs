import assert from 'node:assert/strict';
import {
    mergePendingCommitments,
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

function testMergeKeepsSoonestCommitmentsWhenCapped() {
    const now = 1_000_000;
    const incoming = Array.from({ length: 25 }, (_, index) => {
        const minute = index + 1;
        return {
            t: 'commitment',
            kind: 'promise',
            at: `+${minute}min`,
            hint: `promise ${minute}`,
            createdAt: now + minute,
        };
    });

    const merged = mergePendingCommitments([], incoming, { now });

    assert.equal(merged.length, 20);
    assert.equal(merged[0].hint, 'promise 1');
    assert.equal(merged[19].hint, 'promise 20');
}

function testClockCommitmentsUseProvidedTimezoneForBlocking() {
    const now = Date.UTC(2026, 5, 14, 1, 30, 0, 0);
    const commitment = {
        t: 'commitment',
        kind: 'promise',
        at: '22:00',
        hint: '晚点回来',
        createdAt: now,
    };

    assert.equal(
        pendingCommitmentBlockReason([commitment], { now, utcOffsetSeconds: -4 * 60 * 60 }),
        'pending_promise_commitment_due_in_30m'
    );
    assert.equal(pendingCommitmentBlockReason([commitment], { now, utcOffsetSeconds: 0 }), '');
}

testParsesRelativeCommitment();
testStoredDueAtDoesNotSlideForward();
testMergeKeepsSoonestCommitmentsWhenCapped();
testClockCommitmentsUseProvidedTimezoneForBlocking();
console.log('commitments tests passed');
