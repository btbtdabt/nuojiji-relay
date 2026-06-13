import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { runProactiveTick } from '../src/proactive/tick.js';
import { BACKEND_FIRE_COOLDOWN_MS } from '../src/store/proactiveStore.js';

class FakeKv {
    constructor() {
        this.map = new Map();
    }

    async get(key) {
        return this.map.get(key) ?? null;
    }

    async put(key, value) {
        this.map.set(key, value);
    }

    async delete(key) {
        this.map.delete(key);
    }

    async list({ prefix = '' } = {}) {
        const keys = [...this.map.keys()]
            .filter((name) => name.startsWith(prefix))
            .sort()
            .map((name) => ({ name }));
        return { keys, list_complete: true };
    }
}

function authHeaders() {
    return {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
    };
}

async function postJson(app, env, path, body) {
    return app.fetch(new Request(`https://relay.example${path}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
    }), env);
}

async function getJson(app, env, path) {
    const res = await app.fetch(new Request(`https://relay.example${path}`, {
        headers: { authorization: 'Bearer test-secret' },
    }), env);
    return res.json();
}

function parseStoredPair(kv) {
    return JSON.parse(kv.map.get('p:inbox:user:char'));
}

async function testTickPersistsGeneratedBubbleForNextContextAfterStaleSync() {
    const app = createApp();
    const kv = new FakeKv();
    const env = { OUTBOX: kv, RELAY_SECRET: 'test-secret' };
    const originalNow = Date.now;
    const originalRandom = Math.random;
    const originalFetch = globalThis.fetch;
    let now = 10_000_000;
    const aiRequests = [];
    const aiReplies = [
        JSON.stringify({ t: 'text', c: 'server proactive' }),
        JSON.stringify({ t: 'text', c: 'followup proactive' }),
    ];

    Date.now = () => now;
    Math.random = () => 0;
    globalThis.fetch = async (_url, init) => {
        aiRequests.push(JSON.parse(String(init?.body || '{}')));
        return new Response(JSON.stringify({
            choices: [{ message: { content: aiReplies[aiRequests.length - 1] } }],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const registerRes = await postJson(app, env, '/proactive/register', {
            inboxId: 'inbox',
            userId: 'user',
            charId: 'char',
            enabled: true,
            mode: 'impulse',
            promptTemplate: [
                'Recent:',
                '{{RECENT_MESSAGES}}',
                'Reason: {{IMPULSE_REASON}}',
                'Memory: {{MEMORY_CONTEXT}}',
            ].join('\n'),
            proactiveProfile: {
                weights: { silence: 1, timeOfDay: 0, mood: 0, pendingQuestion: 0, randomLife: 0 },
                silenceSaturationHours: 0.1,
                quietHours: [0, 0],
                threshold: 0.1,
                randomLifeChancePerDay: 0,
            },
            lifeState: { unansweredStreak: 0 },
            intensity: 'normal',
            proactiveBias: 0,
            recentMessages: [{ sender: 'me', text: 'before' }],
            aiSettings: {
                mainApiUrl: 'https://api.openai.example',
                mainApiKey: 'test-key',
                mainApiModel: 'test-model',
                apiType: 'openai',
                autoRetryEnabled: false,
                secondaryFallbackEnabled: false,
            },
            proactiveEnabledAt: now - 60 * 60_000,
            lastInteractionAt: now - 60 * 60_000,
            mcpContextServers: [],
        });
        assert.equal(registerRes.status, 200);

        const firstTick = await runProactiveTick(env);
        assert.deepEqual(firstTick, { pairs: 1, fired: 1 });
        assert.equal(aiRequests.length, 1);
        assert.match(aiRequests[0].messages[0].content, /User: before/);

        const firstOutbox = await getJson(app, env, '/outbox?inboxId=inbox');
        assert.equal(firstOutbox.items.length, 1);
        assert.equal(firstOutbox.items[0].content, aiReplies[0]);

        const afterFirstTick = parseStoredPair(kv);
        assert.deepEqual(afterFirstTick.recentMessages, [
            { sender: 'me', text: 'before' },
            { sender: 'char', text: 'server proactive' },
        ]);
        assert.equal(afterFirstTick.lastInteractionAt, now);
        assert.equal(afterFirstTick.lifeState.unansweredStreak, 1);

        const staleSyncRes = await postJson(app, env, '/proactive/sync-messages', {
            inboxId: 'inbox',
            userId: 'user',
            charId: 'char',
            lastInteractionAt: now,
            recentMessages: [{ sender: 'me', text: 'before' }],
            lifeState: { unansweredStreak: 0 },
        });
        assert.equal(staleSyncRes.status, 200);

        const afterStaleSync = parseStoredPair(kv);
        assert.deepEqual(afterStaleSync.recentMessages, afterFirstTick.recentMessages);
        assert.equal(afterStaleSync.lifeState.unansweredStreak, 1);

        now += BACKEND_FIRE_COOLDOWN_MS + 1_000;
        const secondTick = await runProactiveTick(env);
        assert.deepEqual(secondTick, { pairs: 1, fired: 1 });
        assert.equal(aiRequests.length, 2);
        assert.match(aiRequests[1].messages[0].content, /User: before/);
        assert.match(aiRequests[1].messages[0].content, /Char: server proactive/);
    } finally {
        Date.now = originalNow;
        Math.random = originalRandom;
        globalThis.fetch = originalFetch;
    }
}

async function testTickDropsGeneratedBubbleWhenUserRepliesDuringGeneration() {
    const app = createApp();
    const kv = new FakeKv();
    const env = { OUTBOX: kv, RELAY_SECRET: 'test-secret' };
    const originalNow = Date.now;
    const originalRandom = Math.random;
    const originalFetch = globalThis.fetch;
    let now = 20_000_000;
    const aiRequests = [];

    Date.now = () => now;
    Math.random = () => 0;
    globalThis.fetch = async (_url, init) => {
        aiRequests.push(JSON.parse(String(init?.body || '{}')));
        now += 1_000;
        const syncRes = await postJson(app, env, '/proactive/sync-messages', {
            inboxId: 'inbox',
            userId: 'user',
            charId: 'char',
            lastInteractionAt: now,
            recentMessages: [
                { sender: 'me', text: 'before' },
                { sender: 'me', text: 'user came back' },
            ],
            lifeState: { unansweredStreak: 0 },
        });
        assert.equal(syncRes.status, 200);
        return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ t: 'text', c: 'stale proactive' }) } }],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const registerRes = await postJson(app, env, '/proactive/register', {
            inboxId: 'inbox',
            userId: 'user',
            charId: 'char',
            enabled: true,
            mode: 'impulse',
            promptTemplate: [
                'Recent:',
                '{{RECENT_MESSAGES}}',
                'Reason: {{IMPULSE_REASON}}',
            ].join('\n'),
            proactiveProfile: {
                weights: { silence: 1, timeOfDay: 0, mood: 0, pendingQuestion: 0, randomLife: 0 },
                silenceSaturationHours: 0.1,
                quietHours: [0, 0],
                threshold: 0.1,
                randomLifeChancePerDay: 0,
            },
            lifeState: { unansweredStreak: 0 },
            intensity: 'normal',
            proactiveBias: 0,
            recentMessages: [{ sender: 'me', text: 'before' }],
            aiSettings: {
                mainApiUrl: 'https://api.openai.example',
                mainApiKey: 'test-key',
                mainApiModel: 'test-model',
                apiType: 'openai',
                autoRetryEnabled: false,
                secondaryFallbackEnabled: false,
            },
            proactiveEnabledAt: now - 60 * 60_000,
            lastInteractionAt: now - 60 * 60_000,
            mcpContextServers: [],
        });
        assert.equal(registerRes.status, 200);

        const tick = await runProactiveTick(env);
        assert.deepEqual(tick, { pairs: 1, fired: 0 });
        assert.equal(aiRequests.length, 1);

        const outbox = await getJson(app, env, '/outbox?inboxId=inbox');
        assert.equal(outbox.items.length, 0);

        const stored = parseStoredPair(kv);
        assert.deepEqual(stored.recentMessages, [
            { sender: 'me', text: 'before' },
            { sender: 'me', text: 'user came back' },
        ]);
        assert.equal(stored.lastInteractionAt, now);
        assert.equal(stored.lastFiredAt || 0, 0);
        assert.equal(stored.generationStartedAt || 0, 0);
        assert.equal(stored.generationClaimId ?? null, null);
        assert.equal(stored.lifeState.unansweredStreak, 0);
    } finally {
        Date.now = originalNow;
        Math.random = originalRandom;
        globalThis.fetch = originalFetch;
    }
}

async function testIntervalModeCanFireBelowBackendImpulseCooldown() {
    const app = createApp();
    const kv = new FakeKv();
    const env = { OUTBOX: kv, RELAY_SECRET: 'test-secret' };
    const originalNow = Date.now;
    const originalRandom = Math.random;
    const originalFetch = globalThis.fetch;
    let now = 30_000_000;
    const aiRequests = [];

    Date.now = () => now;
    Math.random = () => 0;
    globalThis.fetch = async (_url, init) => {
        aiRequests.push(JSON.parse(String(init?.body || '{}')));
        return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ t: 'text', c: `interval ${aiRequests.length}` }) } }],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const registerRes = await postJson(app, env, '/proactive/register', {
            inboxId: 'inbox',
            userId: 'user',
            charId: 'char',
            enabled: true,
            mode: 'interval',
            interval: 1,
            intervalUnit: 'minutes',
            probability: 'high',
            promptTemplate: 'Recent:\n{{RECENT_MESSAGES}}',
            lifeState: { unansweredStreak: 0 },
            recentMessages: [{ sender: 'me', text: 'before' }],
            aiSettings: {
                mainApiUrl: 'https://api.openai.example',
                mainApiKey: 'test-key',
                mainApiModel: 'test-model',
                apiType: 'openai',
                autoRetryEnabled: false,
                secondaryFallbackEnabled: false,
            },
            proactiveEnabledAt: now - 60 * 60_000,
            lastInteractionAt: now - 60 * 60_000,
            mcpContextServers: [],
        });
        assert.equal(registerRes.status, 200);

        assert.deepEqual(await runProactiveTick(env), { pairs: 1, fired: 1 });
        now += 61_000;
        assert.deepEqual(await runProactiveTick(env), { pairs: 1, fired: 1 });
        assert.equal(aiRequests.length, 2);

        const outbox = await getJson(app, env, '/outbox?inboxId=inbox');
        assert.equal(outbox.items.length, 2);
    } finally {
        Date.now = originalNow;
        Math.random = originalRandom;
        globalThis.fetch = originalFetch;
    }
}

async function testActiveGenerationClaimCoversSlowRetryBudget() {
    const app = createApp();
    const kv = new FakeKv();
    const env = { OUTBOX: kv, RELAY_SECRET: 'test-secret' };
    const originalNow = Date.now;
    const originalRandom = Math.random;
    const originalFetch = globalThis.fetch;
    const now = 40_000_000;
    const aiRequests = [];

    Date.now = () => now;
    Math.random = () => 0;
    globalThis.fetch = async (_url, init) => {
        aiRequests.push(JSON.parse(String(init?.body || '{}')));
        return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ t: 'text', c: 'should not start' }) } }],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const registerRes = await postJson(app, env, '/proactive/register', {
            inboxId: 'inbox',
            userId: 'user',
            charId: 'char',
            enabled: true,
            mode: 'interval',
            interval: 1,
            intervalUnit: 'minutes',
            probability: 'high',
            promptTemplate: 'Recent:\n{{RECENT_MESSAGES}}',
            lifeState: { unansweredStreak: 0 },
            recentMessages: [{ sender: 'me', text: 'before' }],
            aiSettings: {
                mainApiUrl: 'https://api.openai.example',
                mainApiKey: 'test-key',
                mainApiModel: 'test-model',
                apiType: 'openai',
                autoRetryEnabled: true,
                maxRetries: 3,
                secondaryFallbackEnabled: true,
                secondaryApiUrl: 'https://api2.openai.example',
                secondaryApiKey: 'test-key-2',
                secondaryApiModel: 'test-model',
            },
            proactiveEnabledAt: now - 60 * 60_000,
            lastInteractionAt: now - 60 * 60_000,
            mcpContextServers: [],
        });
        assert.equal(registerRes.status, 200);

        const stored = parseStoredPair(kv);
        stored.generationStartedAt = now - (16 * 60_000 - 1);
        stored.generationClaimId = 'still-running';
        await kv.put('p:inbox:user:char', JSON.stringify(stored));

        assert.deepEqual(await runProactiveTick(env), { pairs: 1, fired: 0 });
        assert.equal(aiRequests.length, 0);
    } finally {
        Date.now = originalNow;
        Math.random = originalRandom;
        globalThis.fetch = originalFetch;
    }
}

await testTickPersistsGeneratedBubbleForNextContextAfterStaleSync();
await testTickDropsGeneratedBubbleWhenUserRepliesDuringGeneration();
await testIntervalModeCanFireBelowBackendImpulseCooldown();
await testActiveGenerationClaimCoversSlowRetryBudget();
console.log('proactiveTick tests passed');
