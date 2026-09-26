// Supabase Storage REST adapter for cutover payload re-home/verify.
// Storage is pinned to the project region, so residency follows the project.
// Env contract (per side): PAYLOAD_{SRC,TGT}_SUPABASE_URL, _SERVICE_KEY, _BUCKET.

export function createObjectStore(cfg) {
    // cfg: { url: 'https://<ref>.supabase.co', serviceKey, bucket }
    if (!cfg || typeof cfg.url !== 'string' || typeof cfg.serviceKey !== 'string'
        || typeof cfg.bucket !== 'string' || !/^[A-Za-z0-9._-]{1,63}$/.test(cfg.bucket)) {
        throw new Error('object_store_config_invalid');
    }
    const base = cfg.url.replace(/\/+$/, '');
    const headers = () => ({ authorization: `Bearer ${cfg.serviceKey}`, apikey: cfg.serviceKey });
    return {
        async get(key) {
            const r = await fetch(`${base}/storage/v1/object/${cfg.bucket}/${encodeURI(key)}`,
                { headers: headers() });
            if (r.status === 404 || r.status === 400) return null;
            if (!r.ok) throw new Error(`object_get_${r.status}`);
            return new Uint8Array(await r.arrayBuffer());
        },
        async put(key, bytes, contentType = 'application/octet-stream') {
            const r = await fetch(`${base}/storage/v1/object/${cfg.bucket}/${encodeURI(key)}`,
                { method: 'POST', headers: { ...headers(), 'content-type': contentType,
                    'x-upsert': 'false' }, body: bytes });
            if (!r.ok) {
                // A pre-existing object is not a write failure — the seal
                // verify pass compares digests and catches any difference.
                const j = await r.json().catch(() => null);
                if (!(r.status === 409 || r.status === 400 && /exist|duplicate/i.test(j?.message ?? j?.error ?? '')))
                    throw new Error(`object_put_${r.status}`);
            }
        },
        async head(key) {
            const r = await fetch(`${base}/storage/v1/object/${cfg.bucket}/${encodeURI(key)}`,
                { method: 'HEAD', headers: headers() });
            return r.ok ? { size: Number(r.headers.get('content-length') ?? 0) } : null;
        },
        async ensureBucket() {
            const r = await fetch(`${base}/storage/v1/bucket`, { method: 'POST',
                headers: { ...headers(), 'content-type': 'application/json' },
                body: JSON.stringify({ id: cfg.bucket, name: cfg.bucket, public: false }) });
            if (!r.ok) { const j = await r.json().catch(() => null);
                if (!/already exists/i.test(j?.message ?? j?.error ?? '')) throw new Error(`bucket_create_${r.status}`); }
        },
    };
}

/** Store from env prefix, or null when unconfigured. */
export function objectStoreFromEnv(env, prefix) {
    const url = env[`PAYLOAD_${prefix}_SUPABASE_URL`];
    const serviceKey = env[`PAYLOAD_${prefix}_SERVICE_KEY`];
    const bucket = env[`PAYLOAD_${prefix}_BUCKET`];
    if (!url && !serviceKey && !bucket) return null;
    return createObjectStore({ url, serviceKey, bucket });
}
