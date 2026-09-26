import test from 'node:test';
import assert from 'node:assert/strict';
import { createObjectStore, objectStoreFromEnv } from '../../scripts/postgres-object-store.mjs';

const CFG = { url: 'https://ref.supabase.co', serviceKey: 'sk-test', bucket: 'bkt' };

/** Swap global fetch for the duration of a test. */
function withFetch(t, handler) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return handler(String(url), init);
    };
    t.after(() => { globalThis.fetch = original; });
    return calls;
}

const jsonResp = (status, body) => new Response(JSON.stringify(body ?? {}),
    { status, headers: { 'content-type': 'application/json' } });

test('config validation rejects malformed input', () => {
    assert.throws(() => createObjectStore({}), /object_store_config_invalid/);
    assert.throws(() => createObjectStore({ ...CFG, bucket: 'bad name!' }), /object_store_config_invalid/);
    assert.throws(() => createObjectStore({ ...CFG, url: 7 }), /object_store_config_invalid/);
});

test('get returns bytes, null on 404/400, and throws on other errors', async t => {
    const calls = withFetch(t, url =>
        url.endsWith('/storage/v1/object/bkt/a.bin') ? new Response(new Uint8Array([1, 2, 3])) :
        url.endsWith('/storage/v1/object/bkt/missing') ? jsonResp(404, { message: 'not found' }) :
        jsonResp(500, {}));
    const store = createObjectStore(CFG);
    assert.deepEqual([...(await store.get('a.bin'))], [1, 2, 3]);
    assert.equal(await store.get('missing'), null);
    await assert.rejects(() => store.get('boom'), /object_get_500/);
    assert.ok(calls[0].init.headers.authorization === 'Bearer sk-test');
});

test('put tolerates pre-existing objects but fails other errors', async t => {
    withFetch(t, url => url.includes('/dup')
        ? jsonResp(400, { error: 'Duplicate', message: 'The resource already exists' })
        : url.includes('/conflict') ? jsonResp(409, {}) :
        url.includes('/ok') ? jsonResp(200, { Key: 'ok' }) : jsonResp(403, {}));
    const store = createObjectStore(CFG);
    await store.put('ok', new Uint8Array([9]));
    await store.put('dup', new Uint8Array([9]));
    await store.put('conflict', new Uint8Array([9]));
    await assert.rejects(() => store.put('denied', new Uint8Array([9])), /object_put_403/);
});

test('ensureBucket tolerates already-exists, fails other errors', async t => {
    withFetch(t, (_url, init) => init.method === 'POST' ? jsonResp(400, { message: 'Bucket already exists' }) : jsonResp(500, {}));
    await createObjectStore(CFG).ensureBucket();
    withFetch(t, () => jsonResp(401, { message: 'denied' }));
    await assert.rejects(() => createObjectStore(CFG).ensureBucket(), /bucket_create_401/);
});

test('env wiring: unconfigured → null, configured → store', () => {
    assert.equal(objectStoreFromEnv({}, 'SRC'), null);
    // Partial config is invalid — no silent half-store.
    assert.throws(() => objectStoreFromEnv({ PAYLOAD_SRC_SUPABASE_URL: 'https://x.supabase.co' }, 'SRC'),
        /object_store_config_invalid/);
    const store = objectStoreFromEnv({ PAYLOAD_SRC_SUPABASE_URL: 'https://x.supabase.co',
        PAYLOAD_SRC_SERVICE_KEY: 'k', PAYLOAD_SRC_BUCKET: 'b' }, 'SRC');
    assert.ok(store && typeof store.get === 'function');
});
