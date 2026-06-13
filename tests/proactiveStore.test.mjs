import assert from 'node:assert/strict';
import { KvProactiveStore, MemoryProactiveStore, mergeProactiveRecord } from '../src/store/proactiveStore.js';

class FakeKv {
    constructor() {
        this.map = new Map();
        this.putCalls = [];
    }

    async get(key) {
        return this.map.get(key) ?? null;
    }

    async put(key, value) {
        this.putCalls.push({ key, value });
        this.map.set(key, value);
    }

    async delete(key) {
        this.map.delete(key);
    }
}

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
    assert.equal(merged.lifeState.unansweredStreak, 2);
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

function testMergeAllowsStreakResetAfterUserReply() {
    const merged = mergeProactiveRecord({
        lastInteractionAt: 10_000,
        lastFiredAt: 30_000,
        lifeState: {
            unansweredStreak: 2,
            lastImpulseAt: 30_000,
            lastProactiveSentAt: 30_000,
        },
    }, {
        lastInteractionAt: 50_000,
        lifeState: {
            unansweredStreak: 0,
            lastImpulseAt: 30_000,
            lastProactiveSentAt: 30_000,
        },
    }, 60_000);

    assert.equal(merged.lastInteractionAt, 50_000);
    assert.equal(merged.lifeState.unansweredStreak, 0);
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

async function testPatchKeepsNewerServerTiming() {
    const store = new MemoryProactiveStore();
    await store.upsert({
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        proactiveEnabledAt: 1_000,
        lastInteractionAt: 30_000,
        lastFiredAt: 30_000,
        lifeState: {
            lastImpulseAt: 30_000,
            lastProactiveSentAt: 30_000,
            unansweredStreak: 1,
        },
    });

    await store.patch('inbox', 'user', 'char', {
        lastInteractionAt: 0,
        lifeState: {
            lastImpulseAt: 5_000,
            lastProactiveSentAt: 5_000,
            unansweredStreak: 0,
        },
    });

    const rec = await store.get('inbox', 'user', 'char');
    assert.equal(rec.lastInteractionAt, 30_000);
    assert.equal(rec.lastFiredAt, 30_000);
    assert.equal(rec.lifeState.lastImpulseAt, 30_000);
    assert.equal(rec.lifeState.lastProactiveSentAt, 30_000);
    assert.equal(rec.lifeState.unansweredStreak, 1);
}

async function testKvListUsesFireAtMirror() {
    const kv = new FakeKv();
    const store = new KvProactiveStore(kv);
    const rec = {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        enabled: true,
        lastFiredAt: 30_000,
    };

    await store.upsert(rec);
    await kv.put('p:inbox:user:char', JSON.stringify({ ...rec, lastFiredAt: 5_000 }));

    const rows = await store.listByInbox('inbox');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lastFiredAt, 30_000);
}

async function testKvFireAtMirrorIsMonotonic() {
    const kv = new FakeKv();
    const store = new KvProactiveStore(kv);
    const rec = {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        enabled: true,
        lastFiredAt: 5_000,
    };

    await store.upsert(rec);
    await kv.put('pf:inbox:user:char', '30000');
    kv.putCalls = [];
    await store.patch('inbox', 'user', 'char', { notifPrivacy: true });

    assert.equal(await kv.get('pf:inbox:user:char'), '30000');
    assert.equal(kv.putCalls.some((call) => call.key === 'pf:inbox:user:char'), false);
}

testMergeKeepsNewerServerTiming();
testMergeAcceptsNewerClientTiming();
testMergeAllowsStreakResetAfterUserReply();
testMergeInitializesNewRecordEnabledAt();
await testPatchKeepsNewerServerTiming();
await testKvListUsesFireAtMirror();
await testKvFireAtMirrorIsMonotonic();
console.log('proactiveStore tests passed');
