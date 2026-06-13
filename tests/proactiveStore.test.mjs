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

function testMergeKeepsServerWindowUntilUserReply() {
    const prevWindow = [
        { sender: 'me', text: 'before' },
        { sender: 'char', text: 'server proactive' },
    ];
    const staleWindow = [{ sender: 'me', text: 'before' }];
    const freshWindow = [...prevWindow, { sender: 'me', text: 'reply' }];

    const stale = mergeProactiveRecord({
        lastFiredAt: 30_000,
        lastInteractionAt: 30_000,
        recentMessages: prevWindow,
        lifeState: { unansweredStreak: 1 },
    }, {
        lastInteractionAt: 20_000,
        recentMessages: staleWindow,
        lifeState: { unansweredStreak: 0 },
    }, 40_000);

    assert.deepEqual(stale.recentMessages, prevWindow);
    assert.equal(stale.lifeState.unansweredStreak, 1);

    const sameTimestampStale = mergeProactiveRecord({
        lastFiredAt: 30_000,
        lastInteractionAt: 30_000,
        recentMessages: prevWindow,
        lifeState: { unansweredStreak: 1 },
    }, {
        lastInteractionAt: 30_000,
        recentMessages: staleWindow,
        lifeState: { unansweredStreak: 0 },
    }, 40_000);

    assert.deepEqual(sameTimestampStale.recentMessages, prevWindow);
    assert.equal(sameTimestampStale.lifeState.unansweredStreak, 1);

    const fresh = mergeProactiveRecord(stale, {
        lastInteractionAt: 50_000,
        recentMessages: freshWindow,
        lifeState: { unansweredStreak: 0 },
    }, 60_000);

    assert.deepEqual(fresh.recentMessages, freshWindow);
    assert.equal(fresh.lifeState.unansweredStreak, 0);
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

async function testPatchAcceptsServerWindowAtFireTimestamp() {
    const store = new MemoryProactiveStore();
    const oldWindow = [{ sender: 'me', text: 'before' }];
    const serverWindow = [...oldWindow, { sender: 'char', text: 'server proactive' }];

    await store.upsert({
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        enabled: true,
        proactiveEnabledAt: 1_000,
        lastInteractionAt: 10_000,
        recentMessages: oldWindow,
        lifeState: { unansweredStreak: 0 },
    });

    await store.patch('inbox', 'user', 'char', { lastFiredAt: 30_000 });
    await store.patch('inbox', 'user', 'char', {
        lastFiredAt: 30_000,
        lastInteractionAt: 30_000,
        recentMessages: serverWindow,
        lifeState: { unansweredStreak: 1, lastImpulseAt: 30_000, lastProactiveSentAt: 30_000 },
    });

    const rec = await store.get('inbox', 'user', 'char');
    assert.deepEqual(rec.recentMessages, serverWindow);
    assert.equal(rec.lastInteractionAt, 30_000);
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

async function testKvFireMirrorRepairsRuntimeStateWhenUnanswered() {
    const kv = new FakeKv();
    const store = new KvProactiveStore(kv);
    const rec = {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        enabled: true,
        lastFiredAt: 10_000,
        lastInteractionAt: 15_000,
        lifeState: {
            unansweredStreak: 1,
            lastImpulseAt: 10_000,
            lastProactiveSentAt: 10_000,
        },
    };

    await store.upsert(rec);
    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    await kv.put('pf:inbox:user:char', '30000');

    const rows = await store.listByInbox('inbox');
    assert.equal(rows[0].lastFiredAt, 30_000);
    assert.equal(rows[0].lastInteractionAt, 30_000);
    assert.equal(rows[0].lifeState.lastImpulseAt, 30_000);
    assert.equal(rows[0].lifeState.lastProactiveSentAt, 30_000);
    assert.equal(rows[0].lifeState.unansweredStreak, 2);
}

async function testKvFireMirrorKeepsUserReplyReset() {
    const kv = new FakeKv();
    const store = new KvProactiveStore(kv);
    const rec = {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        enabled: true,
        lastFiredAt: 10_000,
        lastInteractionAt: 40_000,
        lifeState: {
            unansweredStreak: 0,
            lastImpulseAt: 10_000,
            lastProactiveSentAt: 10_000,
        },
    };

    await store.upsert(rec);
    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    await kv.put('pf:inbox:user:char', '30000');

    const rows = await store.listByInbox('inbox');
    assert.equal(rows[0].lastFiredAt, 30_000);
    assert.equal(rows[0].lastInteractionAt, 40_000);
    assert.equal(rows[0].lifeState.unansweredStreak, 0);
}

async function testKvFireMirrorCountsOneMissedFire() {
    const kv = new FakeKv();
    const store = new KvProactiveStore(kv);
    const rec = {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        enabled: true,
        lastFiredAt: 0,
        lastInteractionAt: 0,
        lifeState: { unansweredStreak: 0 },
    };

    await store.upsert(rec);
    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    await kv.put('pf:inbox:user:char', '30000');

    const rows = await store.listByInbox('inbox');
    assert.equal(rows[0].lifeState.unansweredStreak, 1);
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

async function testKvDuplicateUpsertRepairsMissingIndex() {
    const kv = new FakeKv();
    const store = new KvProactiveStore(kv);
    const rec = {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        enabled: true,
        proactiveEnabledAt: 1_000,
        updatedAt: 1_000,
        promptTemplate: 'prompt',
        aiSettings: { mainApiUrl: 'https://example.com', mainApiKey: 'k' },
    };

    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    kv.putCalls = [];

    const result = await store.upsert(rec);
    assert.equal(result.changed, false);
    assert.equal(kv.putCalls.some((call) => call.key === 'p:inbox:user:char'), false);
    assert.equal(kv.putCalls.some((call) => call.key === 'pidx'), true);

    const rows = await store.listByInbox('inbox');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].charId, 'char');
}

testMergeKeepsNewerServerTiming();
testMergeAcceptsNewerClientTiming();
testMergeAllowsStreakResetAfterUserReply();
testMergeKeepsServerWindowUntilUserReply();
testMergeInitializesNewRecordEnabledAt();
await testPatchKeepsNewerServerTiming();
await testPatchAcceptsServerWindowAtFireTimestamp();
await testKvListUsesFireAtMirror();
await testKvFireMirrorRepairsRuntimeStateWhenUnanswered();
await testKvFireMirrorKeepsUserReplyReset();
await testKvFireMirrorCountsOneMissedFire();
await testKvFireAtMirrorIsMonotonic();
await testKvDuplicateUpsertRepairsMissingIndex();
console.log('proactiveStore tests passed');
