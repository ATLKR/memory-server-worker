import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const origin = 'https://memory.example.test', issuer = 'https://auth.example.test';
const now = 1788868800000;
const session = 'synthetic-runtime-session-' + 'a'.repeat(40);
const settings = { origin, issuer, authorizationEndpoint: issuer + '/oauth/authorize',
  tokenEndpoint: issuer + '/oauth/token', jwksUri: issuer + '/.well-known/jwks.json', clientId: 'runtime-browser-client' };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'runtime-key', alg: 'RS256', use: 'sig' };
const accessToken = await new SignJWT({ token_use: 'access', client_id: settings.clientId, azp: settings.clientId,
  scope: 'openid profile email memory:read memory:write memory:delete', email: 'synthetic@example.test', emailVerified: true })
  .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: jwk.kid }).setIssuer(issuer).setAudience(origin)
  .setSubject('synthetic-runtime-user').setJti('synthetic-runtime-jti').setIssuedAt(now / 1000).setExpirationTime(now / 1000 + 900).sign(privateKey);
const { outputFiles } = await build({ stdin: {
  contents: `import {createAuthController} from './src/auth.ts';
    import {remoteJson} from './src/release/util.ts';
    export default {async fetch(request,env) {
      if(new URL(request.url).pathname==='/provider') {
        try {return Response.json(await remoteJson(fetch,'https://provider.example.test/api',{
          method:'POST',headers:{authorization:'Bearer synthetic-provider-token','content-type':'application/json'},body:'{}'}));}
        catch(error){return Response.json({error:error.code??'runtime_failure'},{status:error.status??500});}
      }
      return await createAuthController(env.DB,${JSON.stringify(settings)},async principal=>({
        token:${JSON.stringify(session)},accountId:'synthetic-account',expiresAt:principal.expiresAt
      }),{clock:()=>${now}}).handle(request)??new Response(null,{status:404});
    }}`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'auth-runtime-test-worker.mjs', loader: 'js',
}, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });

async function fixture(t, handler) {
  const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'auth-runtime-test', modules: true,
    compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], script: outputFiles[0].text,
    d1Databases: ['DB'], outboundService: async request => {
      calls.push({ url: request.url, method: request.method, body: await request.text() });
      return handler(request);
    },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  // auth_flows has no dependencies; native D1 validates the claim/erase path.
  const schema = new DatabaseSync(':memory:');
  try {
    schema.exec(readFileSync(new URL('../auth-schema.sql', import.meta.url), 'utf8'));
    for (const { sql } of schema.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid').all())
      await db.prepare(sql).run();
  } finally { schema.close(); }
  const begin = async () => {
    const login = await mf.dispatchFetch(origin + '/auth/login', { redirect: 'manual' });
    assert.equal(login.status, 302);
    return { url: new URL(login.headers.get('location')), cookie: login.headers.get('set-cookie').split(';')[0] };
  };
  const callback = flow => mf.dispatchFetch(origin + '/auth/callback?' + new URLSearchParams({
    code: 'synthetic-authorization-code', state: flow.url.searchParams.get('state'), iss: issuer,
  }), { redirect: 'manual', headers: { cookie: flow.cookie } });
  return { mf, db, calls, begin, callback };
}

test('native workerd completes PKCE token exchange and remote JWKS verification', async t => {
  const f = await fixture(t, request => request.url === settings.tokenEndpoint
    ? Response.json({ access_token: accessToken, token_type: 'Bearer' }) : Response.json({ keys: [jwk] }));
  const flow = await f.begin();
  const response = await f.callback(flow);
  assert.equal(response.status, 303, await response.text());
  assert.match(response.headers.get('set-cookie'), new RegExp('__Host-memory_session=' + session));
  assert.deepEqual(f.calls.map(call => call.url), [settings.tokenEndpoint, settings.jwksUri]);
  const body = new URLSearchParams(f.calls[0].body);
  assert.equal(body.get('resource'), origin);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), flow.url.searchParams.get('code_challenge'));
  assert.equal((await f.db.prepare('SELECT verifier FROM auth_flows').first()).verifier, null);
  assert.equal((await f.callback(flow)).status, 400);
  assert.equal(f.calls.length, 2);
});

test('native workerd rejects token and JWKS redirects without following credentials', async t => {
  for (const target of ['token', 'jwks']) await t.test(target, async t => {
    const f = await fixture(t, request => target === 'jwks' && request.url === settings.tokenEndpoint
      ? Response.json({ access_token: accessToken, token_type: 'Bearer' })
      : new Response(null, { status: 307, headers: { location: 'https://untrusted.example.test/collect' } }));
    const response = await f.callback(await f.begin());
    assert.equal(response.status, 400);
    assert.doesNotMatch(response.headers.get('set-cookie') ?? '', /__Host-memory_session=/);
    assert.equal(f.calls.length, target === 'token' ? 1 : 2);
    assert.ok(f.calls.every(call => new URL(call.url).origin === issuer));
  });
});

test('native workerd provider JSON transport succeeds and rejects redirects', async t => {
  for (const redirected of [false, true]) await t.test(String(redirected), async t => {
    const f = await fixture(t, () => redirected
      ? new Response(null, { status: 302, headers: { location: 'https://untrusted.example.test/collect' } })
      : Response.json({ ok: true }));
    const response = await f.mf.dispatchFetch(origin + '/provider');
    assert.equal(response.status, redirected ? 502 : 200);
    assert.deepEqual(await response.json(), redirected ? { error: 'provider_unavailable' } : { ok: true });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://provider.example.test/api');
  });
});
