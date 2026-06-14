import assert from 'node:assert/strict';
import { createSubStore, subKey } from '../src/store/subStore.js';

class FakeKv {
    constructor({ hideList = false, rejectUndefinedCursor = false } = {}) {
        this.map = new Map();
        this.putCalls = [];
        this.deleteCalls = [];
        this.hideList = hideList;
        this.rejectUndefinedCursor = rejectUndefinedCursor;
    }

    async get(key) {
        return this.map.get(key) ?? null;
    }

    async put(key, value) {
        this.putCalls.push({ key, value });
        this.map.set(key, value);
    }

    async delete(key) {
        this.deleteCalls.push({ key });
        this.map.delete(key);
    }

    async list(options = {}) {
        if (this.rejectUndefinedCursor && Object.hasOwn(options, 'cursor') && options.cursor === undefined) {
            throw new Error('cursor must be omitted when empty');
        }
        const { prefix = '' } = options;
        if (this.hideList) return { keys: [], list_complete: true };
        return {
            keys: [...this.map.keys()]
                .filter((name) => name.startsWith(prefix))
                .sort()
                .map((name) => ({ name })),
            list_complete: true,
        };
    }
}

async function testKvSubscriptionListUsesStrongIndex() {
    const kv = new FakeKv({ hideList: true });
    const store = await createSubStore({ OUTBOX: kv });
    const sub = { channel: 'apns', token: 'token-1' };

    await store.add('inbox', sub);
    kv.putCalls = [];

    const listed = await store.list('inbox');
    assert.deepEqual(listed, [sub]);
    assert.deepEqual(JSON.parse(await kv.get('sidx:inbox')), ['token-1']);
    assert.equal(kv.putCalls.some((call) => call.key === 'sidx:inbox'), false);
}

async function testKvSubscriptionRemoveUpdatesIndex() {
    const kv = new FakeKv({ hideList: true });
    const store = await createSubStore({ OUTBOX: kv });
    const first = { channel: 'apns', token: 'token-1' };
    const second = { channel: 'apns', token: 'token-2' };

    await store.add('inbox', first);
    await store.add('inbox', second);
    await store.remove('inbox', first);

    const listed = await store.list('inbox');
    assert.deepEqual(listed, [second]);
    assert.deepEqual(JSON.parse(await kv.get('sidx:inbox')), ['token-2']);
}

async function testKvSubscriptionPruneUpdatesIndex() {
    const kv = new FakeKv({ hideList: true });
    const store = await createSubStore({ OUTBOX: kv });
    const oldApns = { channel: 'apns', token: 'old-token' };
    const newApns = { channel: 'apns', token: 'new-token' };
    const web = { channel: 'web', sub: { endpoint: 'https://push.example/web-1' } };

    await store.add('inbox', oldApns);
    await store.add('inbox', newApns);
    await store.add('inbox', web);
    await store.pruneChannel('inbox', 'apns', subKey(newApns));

    const listed = await store.list('inbox');
    assert.deepEqual(listed, [newApns, web]);
    assert.deepEqual(JSON.parse(await kv.get('sidx:inbox')), ['new-token', 'https://push.example/web-1']);
    assert.equal(await kv.get('s:inbox:old-token'), null);
}

async function testKvSubscriptionListRepairsLegacyPrefixRows() {
    const kv = new FakeKv();
    const store = await createSubStore({ OUTBOX: kv });
    const legacy = { channel: 'fcm', token: 'legacy-token' };

    await kv.put('s:inbox:legacy-token', JSON.stringify(legacy));

    const listed = await store.list('inbox');
    assert.deepEqual(listed, [legacy]);
    assert.deepEqual(JSON.parse(await kv.get('sidx:inbox')), ['legacy-token']);
}

async function testKvSubscriptionLegacyRepairOmitsEmptyCursor() {
    const kv = new FakeKv({ rejectUndefinedCursor: true });
    const store = await createSubStore({ OUTBOX: kv });
    const legacy = { channel: 'apns', token: 'legacy-token' };

    await kv.put('s:inbox:legacy-token', JSON.stringify(legacy));

    assert.deepEqual(await store.list('inbox'), [legacy]);
}

function testSubKeyReadsNestedTokens() {
    assert.equal(subKey({ channel: 'apns', sub: { token: 'nested-token' } }), 'nested-token');
}

await testKvSubscriptionListUsesStrongIndex();
await testKvSubscriptionRemoveUpdatesIndex();
await testKvSubscriptionPruneUpdatesIndex();
await testKvSubscriptionListRepairsLegacyPrefixRows();
await testKvSubscriptionLegacyRepairOmitsEmptyCursor();
testSubKeyReadsNestedTokens();
console.log('subStore tests passed');
