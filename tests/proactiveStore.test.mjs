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

    async list({ prefix = '' } = {}) {
        return {
            keys: [...this.map.keys()]
                .filter((name) => name.startsWith(prefix))
                .sort()
                .map((name) => ({ name })),
            list_complete: true,
        };
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

function testMergeResetsStreakWhenUserReplyWindowOmitsReset() {
    const merged = mergeProactiveRecord({
        lastInteractionAt: 30_000,
        lastFiredAt: 30_000,
        recentMessages: [
            { sender: 'me', text: 'before' },
            { sender: 'char', text: 'server proactive' },
        ],
        lifeState: {
            unansweredStreak: 1,
            lastImpulseAt: 30_000,
            lastProactiveSentAt: 30_000,
        },
    }, {
        lastInteractionAt: 50_000,
        recentMessages: [
            { sender: 'me', text: 'before' },
            { sender: 'char', text: 'server proactive' },
            { sender: 'me', text: 'user replied' },
        ],
    }, 60_000);

    assert.equal(merged.lastInteractionAt, 50_000);
    assert.equal(merged.lifeState.unansweredStreak, 0);
}

function testMergeResetsStreakForNewUserMessageWithStaleTimestamp() {
    const merged = mergeProactiveRecord({
        lastInteractionAt: 30_000,
        lastFiredAt: 30_000,
        recentMessages: [
            { sender: 'me', text: 'old user message' },
            { sender: 'char', text: 'server proactive' },
        ],
        lifeState: {
            unansweredStreak: 1,
            lastImpulseAt: 30_000,
            lastProactiveSentAt: 30_000,
        },
    }, {
        lastInteractionAt: 30_000,
        recentMessages: [
            { sender: 'me', text: 'old user message' },
            { sender: 'char', text: 'server proactive' },
            { sender: 'me', text: 'new user reply after proactive' },
        ],
        lifeState: { unansweredStreak: 0 },
    }, 60_000);

    assert.equal(merged.lastInteractionAt, 60_000);
    assert.equal(merged.lifeState.unansweredStreak, 0);
    assert.equal(merged.recentMessages.at(-1).text, 'new user reply after proactive');
}

function testMergeKeepsResetForRepeatedCurrentUserWindow() {
    const window = [
        { sender: 'me', text: 'before' },
        { sender: 'char', text: 'server proactive' },
        { sender: 'me', text: 'user replied' },
    ];
    const merged = mergeProactiveRecord({
        lastInteractionAt: 50_000,
        lastFiredAt: 50_000,
        recentMessages: window,
        lifeState: {
            unansweredStreak: 2,
            lastImpulseAt: 50_000,
            lastProactiveSentAt: 50_000,
        },
    }, {
        lastInteractionAt: 40_000,
        recentMessages: window,
        lifeState: { unansweredStreak: 0 },
    }, 60_000);

    assert.equal(merged.lastInteractionAt, 60_000);
    assert.equal(merged.lifeState.unansweredStreak, 0);
    assert.deepEqual(merged.recentMessages, window);
}

function testMergeTreatsReplyGenerationClaimAsUserSignal() {
    const merged = mergeProactiveRecord({
        lastInteractionAt: 50_000,
        lastFiredAt: 50_000,
        lifeState: {
            unansweredStreak: 2,
            lastImpulseAt: 50_000,
            lastProactiveSentAt: 50_000,
        },
    }, {
        lastInteractionAt: 40_000,
        generationClaimId: 'reply_req-user-reply_40000',
        lifeState: { unansweredStreak: 0 },
    }, 60_000);

    assert.equal(merged.lastInteractionAt, 60_000);
    assert.equal(merged.lifeState.unansweredStreak, 0);
}

function testMergeDoesNotTreatStaleClientWindowAsUserReply() {
    const prevWindow = [
        { sender: 'me', text: 'old user message' },
        { sender: 'char', text: 'server proactive' },
    ];
    const staleWindow = [{ sender: 'me', text: 'old user message' }];
    const merged = mergeProactiveRecord({
        lastInteractionAt: 30_000,
        lastFiredAt: 30_000,
        recentMessages: prevWindow,
        lifeState: { unansweredStreak: 1 },
    }, {
        lastInteractionAt: 30_000,
        recentMessages: staleWindow,
        lifeState: { unansweredStreak: 0 },
    }, 60_000);

    assert.equal(merged.lastInteractionAt, 30_000);
    assert.equal(merged.lifeState.unansweredStreak, 1);
    assert.deepEqual(merged.recentMessages, prevWindow);
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

function testMergePendingCommitmentsPreservesExistingRelayItems() {
    const now = 90_000;
    const merged = mergeProactiveRecord({
        pendingCommitments: [{
            t: 'commitment',
            kind: 'activity',
            at: '+5min',
            hint: '换衣服',
            dueAt: now + 5 * 60_000,
            createdAt: now,
        }],
    }, {
        pendingCommitments: [{
            t: 'commitment',
            kind: 'promise',
            at: '+2h',
            hint: '晚点发照片',
            createdAt: now + 1,
        }],
    }, now);

    assert.equal(merged.pendingCommitments.length, 2);
    assert.deepEqual(merged.pendingCommitments.map((item) => item.hint), ['换衣服', '晚点发照片']);
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

async function testKvPatchReplyGenerationClaimClearsFireMirrorStreak() {
    const kv = new FakeKv();
    const store = new KvProactiveStore(kv);
    const rec = {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        enabled: true,
        lastFiredAt: 30_000,
        lastInteractionAt: 30_000,
        lifeState: {
            unansweredStreak: 1,
            lastImpulseAt: 30_000,
            lastProactiveSentAt: 30_000,
        },
    };

    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    await kv.put('pf:inbox:user:char', '50000');

    const result = await store.patch('inbox', 'user', 'char', {
        lastInteractionAt: 40_000,
        generationClaimId: 'reply_req-user-reply_40000',
        lifeState: { unansweredStreak: 0 },
    });

    assert.equal(result.changed, true);
    const stored = JSON.parse(await kv.get('p:inbox:user:char'));
    assert.equal(stored.lastFiredAt, 50_000);
    assert.equal(stored.lastInteractionAt > 50_000, true);
    assert.equal(stored.lifeState.lastImpulseAt, 50_000);
    assert.equal(stored.lifeState.lastProactiveSentAt, 50_000);
    assert.equal(stored.lifeState.unansweredStreak, 0);
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

async function testKvPatchRepairsStaleRuntimeStateFromFireMirror() {
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
        lastFiredAt: 10_000,
        lastInteractionAt: 40_000,
        generationStartedAt: 30_000,
        generationClaimId: 'stale-claim',
        lifeState: {
            unansweredStreak: 0,
            lastImpulseAt: 10_000,
            lastProactiveSentAt: 10_000,
        },
    };

    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    await kv.put('pf:inbox:user:char', '30000');
    kv.putCalls = [];

    const result = await store.patch('inbox', 'user', 'char', { notifPrivacy: true });
    assert.equal(result.changed, true);

    const stored = JSON.parse(await kv.get('p:inbox:user:char'));
    assert.equal(stored.lastFiredAt, 30_000);
    assert.equal(stored.lastInteractionAt, 40_000);
    assert.equal(stored.generationStartedAt, 0);
    assert.equal(stored.generationClaimId, null);
    assert.equal(stored.lifeState.unansweredStreak, 0);
    assert.equal(stored.lifeState.lastImpulseAt, 30_000);
    assert.equal(stored.lifeState.lastProactiveSentAt, 30_000);
    assert.equal(stored.notifPrivacy, true);
    assert.equal(kv.putCalls.some((call) => call.key === 'p:inbox:user:char'), true);
}

async function testKvPatchRepairsRuntimeStateWhenFireAlreadyMirrored() {
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
        lastFiredAt: 30_000,
        lastInteractionAt: 20_000,
        generationStartedAt: 30_000,
        generationClaimId: 'stale-claim',
        lifeState: {
            unansweredStreak: 0,
            lastImpulseAt: 10_000,
            lastProactiveSentAt: 10_000,
        },
    };

    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    await kv.put('pf:inbox:user:char', '30000');
    kv.putCalls = [];

    const result = await store.patch('inbox', 'user', 'char', { notifPrivacy: true });
    assert.equal(result.changed, true);

    const stored = JSON.parse(await kv.get('p:inbox:user:char'));
    assert.equal(stored.lastFiredAt, 30_000);
    assert.equal(stored.lastInteractionAt, 30_000);
    assert.equal(stored.generationStartedAt, 0);
    assert.equal(stored.generationClaimId, null);
    assert.equal(stored.lifeState.unansweredStreak, 1);
    assert.equal(stored.lifeState.lastImpulseAt, 30_000);
    assert.equal(stored.lifeState.lastProactiveSentAt, 30_000);
    assert.equal(stored.notifPrivacy, true);
}

async function testKvNoopPatchRepairsStaleRuntimeStateFromFireMirror() {
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
        notifPrivacy: false,
        lastFiredAt: 10_000,
        lastInteractionAt: 40_000,
        generationStartedAt: 30_000,
        generationClaimId: 'stale-claim',
        lifeState: {
            unansweredStreak: 0,
            lastImpulseAt: 10_000,
            lastProactiveSentAt: 10_000,
        },
    };

    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    await kv.put('pf:inbox:user:char', '30000');
    kv.putCalls = [];

    const result = await store.patch('inbox', 'user', 'char', { notifPrivacy: false });
    assert.equal(result.changed, true);

    const stored = JSON.parse(await kv.get('p:inbox:user:char'));
    assert.equal(stored.notifPrivacy, false);
    assert.equal(stored.lastFiredAt, 30_000);
    assert.equal(stored.generationStartedAt, 0);
    assert.equal(stored.generationClaimId, null);
    assert.equal(stored.lifeState.lastImpulseAt, 30_000);
    assert.equal(stored.lifeState.lastProactiveSentAt, 30_000);
    assert.equal(kv.putCalls.some((call) => call.key === 'p:inbox:user:char'), true);
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

async function testKvListRepairsOrphanedProactivePair() {
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

    const rows = await store.listByInbox('inbox');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].charId, 'char');
    assert.equal(kv.putCalls.some((call) => call.key === 'pidx'), true);
    assert.deepEqual(JSON.parse(await kv.get('pidx')), ['inbox:user:char']);
}

async function testKvListDoesNotRemoveIndexedPairOnTransientMiss() {
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

    await kv.put('pidx', JSON.stringify(['inbox:user:char']));
    await kv.put('p:inbox:user:char', JSON.stringify(rec));

    const originalGet = kv.get.bind(kv);
    let missed = false;
    kv.get = async (key) => {
        if (key === 'p:inbox:user:char' && !missed) {
            missed = true;
            return null;
        }
        return originalGet(key);
    };
    kv.putCalls = [];

    const rows = await store.listByInbox('inbox');
    assert.equal(rows.length, 0);
    assert.deepEqual(JSON.parse(await kv.get('pidx')), ['inbox:user:char']);
    assert.equal(kv.putCalls.some((call) => call.key === 'pidx'), false);

    const recovered = await store.listByInbox('inbox');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].charId, 'char');
}

async function testKvGetAppliesFireMirror() {
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
        lastFiredAt: 5_000,
        lastInteractionAt: 0,
        lifeState: { unansweredStreak: 0 },
    };

    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    await kv.put('pf:inbox:user:char', '30000');

    const stored = await store.get('inbox', 'user', 'char');
    assert.equal(stored.lastFiredAt, 30_000);
    assert.equal(stored.lastInteractionAt, 30_000);
    assert.equal(stored.lifeState.unansweredStreak, 1);
}

async function testKvPatchRepairsMissingIndexWhenChanged() {
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

    const result = await store.patch('inbox', 'user', 'char', { avatarUrl: '/avatar/char' });
    assert.equal(result.changed, true);
    assert.equal(kv.putCalls.some((call) => call.key === 'p:inbox:user:char'), true);
    assert.equal(kv.putCalls.some((call) => call.key === 'pidx'), true);

    const rows = await store.listByInbox('inbox');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].avatarUrl, '/avatar/char');
}

async function testKvPatchRepairsMissingIndexWhenUnchanged() {
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
        avatarUrl: '/avatar/char',
    };

    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    kv.putCalls = [];

    const result = await store.patch('inbox', 'user', 'char', { avatarUrl: '/avatar/char' });
    assert.equal(result.changed, false);
    assert.equal(kv.putCalls.some((call) => call.key === 'p:inbox:user:char'), false);
    assert.equal(kv.putCalls.some((call) => call.key === 'pidx'), true);

    const rows = await store.listByInbox('inbox');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].avatarUrl, '/avatar/char');
}

async function testKvNoopFirePatchRepairsRuntimeMirrors() {
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
        lastFiredAt: 30_000,
    };

    await kv.put('p:inbox:user:char', JSON.stringify(rec));
    kv.putCalls = [];

    const result = await store.patch('inbox', 'user', 'char', { lastFiredAt: 30_000 });
    assert.equal(result.changed, false);
    assert.equal(kv.putCalls.some((call) => call.key === 'p:inbox:user:char'), false);
    assert.equal(kv.putCalls.some((call) => call.key === 'pidx'), true);
    assert.equal(kv.putCalls.some((call) => call.key === 'pf:inbox:user:char'), true);
    assert.equal(await kv.get('pf:inbox:user:char'), '30000');
}

testMergeKeepsNewerServerTiming();
testMergeAcceptsNewerClientTiming();
testMergeAllowsStreakResetAfterUserReply();
testMergeResetsStreakWhenUserReplyWindowOmitsReset();
testMergeResetsStreakForNewUserMessageWithStaleTimestamp();
testMergeKeepsResetForRepeatedCurrentUserWindow();
testMergeTreatsReplyGenerationClaimAsUserSignal();
testMergeDoesNotTreatStaleClientWindowAsUserReply();
testMergeKeepsServerWindowUntilUserReply();
testMergeInitializesNewRecordEnabledAt();
testMergePendingCommitmentsPreservesExistingRelayItems();
await testPatchKeepsNewerServerTiming();
await testPatchAcceptsServerWindowAtFireTimestamp();
await testKvListUsesFireAtMirror();
await testKvFireMirrorRepairsRuntimeStateWhenUnanswered();
await testKvFireMirrorKeepsUserReplyReset();
await testKvPatchReplyGenerationClaimClearsFireMirrorStreak();
await testKvFireMirrorCountsOneMissedFire();
await testKvFireAtMirrorIsMonotonic();
await testKvPatchRepairsStaleRuntimeStateFromFireMirror();
await testKvPatchRepairsRuntimeStateWhenFireAlreadyMirrored();
await testKvNoopPatchRepairsStaleRuntimeStateFromFireMirror();
await testKvDuplicateUpsertRepairsMissingIndex();
await testKvListRepairsOrphanedProactivePair();
await testKvListDoesNotRemoveIndexedPairOnTransientMiss();
await testKvGetAppliesFireMirror();
await testKvPatchRepairsMissingIndexWhenChanged();
await testKvPatchRepairsMissingIndexWhenUnchanged();
await testKvNoopFirePatchRepairsRuntimeMirrors();
console.log('proactiveStore tests passed');
