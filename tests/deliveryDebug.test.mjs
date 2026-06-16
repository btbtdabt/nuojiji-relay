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

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function waitFor(fn, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
}

function generatePayload(requestId = 'req-generate') {
    return {
        requestId,
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
    };
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

        const generateEvents = (await debugEvents(kv)).filter((event) => event.type === 'relay_generate');
        const startEvent = generateEvents.find((event) => event.stage === 'start');
        const completeEvent = generateEvents.find((event) => event.stage === 'complete');
        assert.ok(startEvent);
        assert.ok(completeEvent);
        assert.equal(startEvent.requestId, 'req-hidden');
        assert.equal(startEvent.request.last_user_preview, 'hello');
        assert.equal(startEvent.aiSettings.hasMainApiKey, true);
        assert.equal(startEvent.aiSettings.mainApiKey, undefined);
        assert.equal(completeEvent.requestId, 'req-hidden');

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

async function testDuplicateGenerateWhileInFlightReturnsPending() {
    const app = createApp();
    const kv = new FakeKv();
    const originalFetch = globalThis.fetch;
    const gate = deferred();
    globalThis.fetch = async () => {
        await gate.promise;
        return new Response(JSON.stringify({
            choices: [{ message: { content: '{"t":"text","c":"ok"}' } }],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const first = postJson(app, kv, '/generate', generatePayload('req-inflight'));
        assert.equal(await waitFor(async () => (await kv.get('r:req-inflight')) != null), true);

        const duplicate = await postJson(app, kv, '/generate', generatePayload('req-inflight'));
        const duplicateBody = await duplicate.json();
        assert.equal(duplicate.status, 202);
        assert.equal(duplicateBody.pending, true);
        assert.equal(duplicateBody.duplicate, true);

        gate.resolve();
        const firstRes = await first;
        assert.equal(firstRes.status, 202);
        const listed = await getJson(app, kv, '/outbox?inboxId=inbox&since=0');
        assert.equal(listed.items.length, 1);
        assert.equal(listed.items[0].requestId, 'req-inflight');
    } finally {
        globalThis.fetch = originalFetch;
        gate.resolve();
    }
}

async function testDuplicateGenerateAfterAckStillConflicts() {
    const app = createApp();
    const kv = new FakeKv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"t":"text","c":"ok"}' } }],
    }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

    try {
        const first = await postJson(app, kv, '/generate', generatePayload('req-acked'));
        assert.equal(first.status, 202);

        const listed = await getJson(app, kv, '/outbox?inboxId=inbox&since=0');
        assert.equal(listed.items.length, 1);
        const ack = await postJson(app, kv, '/ack', {
            inboxId: 'inbox',
            ids: [listed.items[0].id],
        });
        assert.equal(ack.status, 200);

        const duplicate = await postJson(app, kv, '/generate', generatePayload('req-acked'));
        assert.equal(duplicate.status, 409);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function testPushDiagDebugRecordsMaskedSubscriptions() {
    const app = createApp();
    const kv = new FakeKv();

    const subscribe = await postJson(app, kv, '/api/push/subscribe', {
        inboxId: 'inbox',
        subscription: { channel: 'apns', token: 'secret-token-f21a4f' },
    });
    assert.equal(subscribe.status, 200);

    const diag = await postJson(app, kv, '/api/push/diag', {
        inboxId: 'inbox',
        test: true,
    });
    assert.equal(diag.status, 200);
    const payload = await diag.json();
    assert.equal(payload.count, 1);
    assert.deepEqual(payload.channels, [{ channel: 'apns', idTail: '…f21a4f' }]);
    assert.equal(payload.dispatch[0].ok, null);

    const diagDebug = (await debugEvents(kv)).find((event) => event.type === 'push_diag');
    assert.ok(diagDebug);
    assert.equal(diagDebug.ok, true);
    assert.equal(diagDebug.count, 1);
    assert.deepEqual(diagDebug.channels, [{ channel: 'apns', idTail: '…f21a4f' }]);
    assert.doesNotMatch(JSON.stringify(diagDebug), /secret-token/);
}

await testOutboxDebugShowsItemsHiddenBySince();
await testProactiveSyncDebugRecordsLatestUserMessage();
await testDuplicateGenerateWhileInFlightReturnsPending();
await testDuplicateGenerateAfterAckStillConflicts();
await testPushDiagDebugRecordsMaskedSubscriptions();
console.log('deliveryDebug tests passed');
