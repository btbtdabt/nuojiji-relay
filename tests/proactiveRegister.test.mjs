import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

class FakeKv {
    constructor() {
        this.map = new Map();
        this.putCalls = [];
        this.deleteCalls = [];
    }

    async get(key) {
        return this.map.get(key) ?? null;
    }

    async put(key, value, options) {
        this.putCalls.push({ key, value, options });
        this.map.set(key, value);
    }

    async delete(key) {
        this.deleteCalls.push({ key });
        this.map.delete(key);
    }

    async list({ prefix = '', cursor } = {}) {
        assert.equal(cursor, undefined);
        return {
            keys: [...this.map.keys()]
                .filter((name) => name.startsWith(prefix))
                .sort()
                .map((name) => ({ name })),
            list_complete: true,
        };
    }
}

const env = (kv) => ({ OUTBOX: kv, RELAY_SECRET: 'test-secret' });

function registerPayload(overrides = {}) {
    return {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        promptTemplate: 'system prompt {{RECENT_MESSAGES}} {{IMPULSE_REASON}} {{MEMORY_CONTEXT}}',
        proactiveProfile: {
            threshold: 0.45,
            quietHours: [23, 8],
            randomLifeChancePerDay: 4,
            silenceSaturationHours: 8,
            weights: { silence: 0.6, timeOfDay: 0.85, mood: 0.4, pendingQuestion: 0.45, randomLife: 0.85 },
        },
        lifeState: { unansweredStreak: 0, moodIntensity: 0.65 },
        intensity: 'normal',
        proactiveBias: 0,
        recentMessages: [{ sender: 'me', text: 'hello' }],
        aiSettings: {
            mainApiUrl: 'https://relay.example/v1',
            mainApiKey: 'secret',
            mainApiModel: 'model',
            apiType: 'custom',
        },
        quietHours: [23, 8],
        charUtcOffsetSeconds: null,
        proactiveEnabledAt: 1_000,
        lastInteractionAt: 2_000,
        enabled: true,
        mode: 'impulse',
        interval: 60,
        intervalUnit: 'minutes',
        probability: 'medium',
        timeSpec: { charName: 'Aki', userUtcOffsetSeconds: -14400 },
        mcpContextServers: [],
        avatarUrl: 'https://relay.example/avatar/char',
        notifPrivacy: false,
        ...overrides,
    };
}

async function postRegister(app, kv, payload) {
    const res = await app.fetch(new Request('https://relay.example/proactive/register', {
        method: 'POST',
        headers: {
            authorization: 'Bearer test-secret',
            'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
    }), env(kv));
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    return data;
}

async function testDuplicateRegisterDoesNotWriteKvOrDebug() {
    const kv = new FakeKv();
    const app = createApp();

    const first = await postRegister(app, kv, registerPayload({ proactiveEnabledAt: 1_000 }));
    assert.equal(first.changed, true);
    assert.ok(kv.putCalls.some((call) => call.key === 'p:inbox:user:char'));
    assert.ok(kv.putCalls.some((call) => call.key.startsWith('dbg:agent:')));

    kv.putCalls = [];
    const duplicate = await postRegister(app, kv, registerPayload({ proactiveEnabledAt: 99_000 }));
    assert.equal(duplicate.changed, false);
    assert.equal(kv.putCalls.length, 0);

    const stored = JSON.parse(await kv.get('p:inbox:user:char'));
    assert.equal(stored.proactiveEnabledAt, 1_000);
}

async function testMeaningfulRegisterChangeStillWrites() {
    const kv = new FakeKv();
    const app = createApp();

    await postRegister(app, kv, registerPayload());
    kv.putCalls = [];

    const changed = await postRegister(app, kv, registerPayload({ proactiveBias: -0.3 }));
    assert.equal(changed.changed, true);
    assert.ok(kv.putCalls.some((call) => call.key === 'p:inbox:user:char'));
    assert.ok(kv.putCalls.some((call) => call.key.startsWith('dbg:agent:')));

    const stored = JSON.parse(await kv.get('p:inbox:user:char'));
    assert.equal(stored.proactiveBias, -0.3);
}

async function testPrivacyNoopDoesNotOvercountUpdates() {
    const kv = new FakeKv();
    const app = createApp();

    await postRegister(app, kv, registerPayload({ notifPrivacy: false }));
    kv.putCalls = [];

    const res = await app.fetch(new Request('https://relay.example/proactive/privacy', {
        method: 'POST',
        headers: {
            authorization: 'Bearer test-secret',
            'content-type': 'application/json',
        },
        body: JSON.stringify({ inboxId: 'inbox', notifPrivacy: false }),
    }), env(kv));
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(data, { ok: true, updated: 0 });
    assert.equal(kv.putCalls.length, 0);
}

await testDuplicateRegisterDoesNotWriteKvOrDebug();
await testMeaningfulRegisterChangeStillWrites();
await testPrivacyNoopDoesNotOvercountUpdates();
console.log('proactiveRegister tests passed');
