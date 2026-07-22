import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { MemoryKvStore } from '../src/store/kvStore.js';

async function testMemoryKvStoreHonorsJsonAndTtl() {
    const store = new MemoryKvStore();
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;

    try {
        await store.put('avatar', JSON.stringify({ mime: 'image/png', b64: 'YQ==' }), {
            expirationTtl: 2,
        });
        assert.deepEqual(await store.get('avatar', { type: 'json' }), {
            mime: 'image/png',
            b64: 'YQ==',
        });

        now += 2_001;
        assert.equal(await store.get('avatar'), null);
    } finally {
        Date.now = originalNow;
    }
}

async function testNodeAvatarRoutesUseFallbackStore() {
    const previousSecret = process.env.RELAY_SECRET;
    const previousStore = process.env.RELAY_STORE;
    process.env.RELAY_SECRET = 'test-secret';
    process.env.RELAY_STORE = 'memory';

    try {
        const app = createApp();
        const key = `node-avatar-${Date.now()}`;
        const bytes = Buffer.from('avatar-bytes');
        const upload = await app.fetch(new Request('https://relay.example/avatar', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-secret',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                key,
                dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
            }),
        }));

        assert.equal(upload.status, 200);
        assert.deepEqual(await upload.json(), { ok: true, url: `/avatar/${key}` });

        const download = await app.fetch(new Request(`https://relay.example/avatar/${key}`));
        assert.equal(download.status, 200);
        assert.equal(download.headers.get('content-type'), 'image/png');
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    } finally {
        if (previousSecret === undefined) delete process.env.RELAY_SECRET;
        else process.env.RELAY_SECRET = previousSecret;
        if (previousStore === undefined) delete process.env.RELAY_STORE;
        else process.env.RELAY_STORE = previousStore;
    }
}

await testMemoryKvStoreHonorsJsonAndTtl();
await testNodeAvatarRoutesUseFallbackStore();

console.log('avatar store tests passed');
