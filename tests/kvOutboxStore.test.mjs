import assert from 'node:assert/strict';
import { KvOutboxStore } from '../src/store/kvOutboxStore.js';

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

async function testListRepairsOrphanedItem() {
    const kv = new FakeKv();
    const store = new KvOutboxStore(kv);
    const inboxId = 'inbox';
    const item = {
        id: 'relay_1',
        requestId: 'round_1',
        content: '{"t":"text","c":"ok"}',
        error: null,
        createdAt: Date.now(),
    };

    await kv.put(`idx:${inboxId}`, '[]');
    await kv.put(`o:${inboxId}:${item.id}`, JSON.stringify(item));

    const listed = await store.list(inboxId, 0);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, item.id);

    const repairedIndex = JSON.parse(await kv.get(`idx:${inboxId}`));
    assert.deepEqual(repairedIndex, [{ id: item.id, createdAt: item.createdAt }]);
}

async function testListKeepsIndexedItems() {
    const kv = new FakeKv();
    const store = new KvOutboxStore(kv);
    const inboxId = 'inbox';
    const item = {
        id: 'relay_2',
        requestId: 'round_2',
        content: '{"t":"text","c":"ok"}',
        error: null,
        createdAt: Date.now(),
    };

    await store.put(inboxId, item);

    const listed = await store.list(inboxId, 0);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, item.id);
}

await testListRepairsOrphanedItem();
await testListKeepsIndexedItems();
console.log('kvOutboxStore tests passed');
