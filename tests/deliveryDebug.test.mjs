import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

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
        return {
            keys: [...this.map.keys()]
                .filter((name) => name.startsWith(prefix))
                .sort()
                .map((name) => ({ name })),
            list_complete: true,
        };
    }
}

const env = (kv) => ({
    OUTBOX: kv,
    RELAY_SECRET: 'test-secret',
    RELAY_DELIVERY_DEBUG: '1',
});

function authHeaders() {
    return {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
    };
}

async function postJson(app, kv, path, body) {
    return app.fetch(new Request(`https://relay.example${path}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
    }), env(kv));
}

async function getJson(app, kv, path) {
    const res = await app.fetch(new Request(`https://relay.example${path}`, {
        headers: { authorization: 'Bearer test-secret' },
    }), env(kv));
    return res.json();
}

async function debugEvents(kv) {
    const index = JSON.parse(await kv.get('dbg:agent:index') || '[]');
    const events = [];
    for (const row of index) {
        const raw = await kv.get(`dbg:agent:${row.id}`);
        if (raw) events.push(JSON.parse(raw));
    }
    return events;
}

async function testOutboxDebugShowsItemsHiddenBySince() {
    const app = createApp();
    const kv = new FakeKv();
    const originalNow = Date.now;
    const originalFetch = globalThis.fetch;
    Date.now = () => 10_000;
    globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"t":"text","c":"ok"}' } }],
    }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

    try {
        const generate = await postJson(app, kv, '/generate', {
            requestId: 'req-hidden',
            inboxId: 'inbox',
            messages: [{ role: 'user', content: 'hello' }],
            settings: {
                mainApiUrl: 'https://api.openai.example',
                mainApiKey: 'test-key',
                mainApiModel: 'test-model',
                apiType: 'openai',
                autoRetryEnabled: false,
                secondaryFallbackEnabled: false,
            },
        });
        assert.equal(generate.status, 202);

        const listed = await getJson(app, kv, '/outbox?inboxId=inbox&since=10000');
        assert.deepEqual(listed.items, []);

        const outboxDebug = (await debugEvents(kv)).find((event) => event.type === 'relay_outbox_list');
        assert.ok(outboxDebug);
        assert.equal(outboxDebug.itemCount, 0);
        assert.equal(outboxDebug.hiddenBySince, 1);
    } finally {
        Date.now = originalNow;
        globalThis.fetch = originalFetch;
    }
}

async function testProactiveSyncDebugRecordsLatestUserMessage() {
    const app = createApp();
    const kv = new FakeKv();

    const register = await postJson(app, kv, '/proactive/register', {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        promptTemplate: 'Recent:\n{{RECENT_MESSAGES}}',
        proactiveProfile: { threshold: 0.5, quietHours: [23, 7] },
        lifeState: {},
        recentMessages: [],
        aiSettings: {
            mainApiUrl: 'https://api.openai.example',
            mainApiKey: 'test-key',
            mainApiModel: 'test-model',
            apiType: 'openai',
        },
        enabled: true,
    });
    assert.equal(register.status, 200);

    const sync = await postJson(app, kv, '/proactive/sync-messages', {
        inboxId: 'inbox',
        userId: 'user',
        charId: 'char',
        recentMessages: [{ sender: 'me', text: '我刚刚回了' }],
        lastInteractionAt: 20_000,
    });
    assert.equal(sync.status, 200);

    const syncDebug = (await debugEvents(kv)).find((event) => event.type === 'proactive_sync');
    assert.ok(syncDebug);
    assert.equal(syncDebug.windowSize, 1);
    assert.equal(syncDebug.latest.sender, 'me');
    assert.equal(syncDebug.latest.preview, '我刚刚回了');
    assert.equal(syncDebug.lastInteractionAt, 20_000);
}

await testOutboxDebugShowsItemsHiddenBySince();
await testProactiveSyncDebugRecordsLatestUserMessage();
console.log('deliveryDebug tests passed');
