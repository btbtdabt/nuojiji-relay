import assert from 'node:assert/strict';
import { mergeProactiveRecord } from '../src/store/proactiveStore.js';

function testMergeKeepsNewerServerTiming() {
    const prev = {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        proactiveEnabledAt: 1_000,
        lastInteractionAt: 20_000,
        lastFiredAt: 30_000,
        lifeState: {
            unansweredStreak: 2,
            lastImpulseAt: 30_000,
            lastProactiveSentAt: 30_000,
            moodIntensity: 0.4,
        },
    };

    const merged = mergeProactiveRecord(prev, {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        proactiveEnabledAt: undefined,
        lastInteractionAt: undefined,
        lifeState: {
            unansweredStreak: 0,
            lastImpulseAt: 5_000,
            lastProactiveSentAt: 5_000,
            moodIntensity: 0.8,
        },
    }, 40_000);

    assert.equal(merged.proactiveEnabledAt, 1_000);
    assert.equal(merged.lastInteractionAt, 20_000);
    assert.equal(merged.lastFiredAt, 30_000);
    assert.equal(merged.lifeState.unansweredStreak, 0);
    assert.equal(merged.lifeState.moodIntensity, 0.8);
    assert.equal(merged.lifeState.lastImpulseAt, 30_000);
    assert.equal(merged.lifeState.lastProactiveSentAt, 30_000);
}

function testMergeAcceptsNewerClientTiming() {
    const merged = mergeProactiveRecord({
        lastInteractionAt: 10_000,
        lastFiredAt: 15_000,
        lifeState: { lastImpulseAt: 15_000 },
    }, {
        lastInteractionAt: 50_000,
        lifeState: { lastImpulseAt: 55_000 },
    }, 60_000);

    assert.equal(merged.lastInteractionAt, 50_000);
    assert.equal(merged.lastFiredAt, 15_000);
    assert.equal(merged.lifeState.lastImpulseAt, 55_000);
}

function testMergeInitializesNewRecordEnabledAt() {
    const merged = mergeProactiveRecord({}, {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
    }, 70_000);

    assert.equal(merged.proactiveEnabledAt, 70_000);
    assert.equal(merged.updatedAt, 70_000);
}

testMergeKeepsNewerServerTiming();
testMergeAcceptsNewerClientTiming();
testMergeInitializesNewRecordEnabledAt();
console.log('proactiveStore tests passed');
