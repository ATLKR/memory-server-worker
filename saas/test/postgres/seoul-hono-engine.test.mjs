import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSeoulApp } from '../../src/postgres/seoul/app.ts';
import { createSeoulRepository } from '../../src/postgres/seoul/repository.ts';
import { createRoutingClient } from '../../src/routing/client.ts';
import { createSeoulFixture, SEOUL_ROUTING, seoulIngest } from './seoul-fixture.mjs';

// Actual migration, catalogue/role checks, native transactions, Hono, MCP SDK
// and routing client. The adapter replaces only TCP/TLS with the local engine;
// this test makes no provider, physical residency, concurrency or TLS claim.
const origin = 'https://seoul-engine.example.test';
async function fixture(t, options = {}) {
  const f = await createSeoulFixture(t);
  const initial = (await f.db.query('SELECT current_database() AS database,session_user AS role')).rows[0];
  const restore = 'SET SESSION AUTHORIZATION "' + initial.role.replaceAll('"', '""') + '"';
  const actors = Object.fromEntries(['a', 'b'].map(actor => {
    const token = 'fixture-native-http-pat-' + actor + '-' + randomUUID();
    return [actor, { token, digest: createHash('sha256').update(token).digest('hex'), credentialId: 'pat:http:' + actor }];
  }));
  await f.asOwner(async () => {
    for (const [actor, credential] of Object.entries(actors)) {
      const expiry = Date.now() + 5 * 60 * 1000;
      await f.db.query(`INSERT INTO memory_identity.credentials(id,account_id,kind,token_digest,expires_at)
        VALUES($1,$2,'personal_key',$3,$4)`, [credential.credentialId, 'account:' + actor, credential.digest, expiry]);
      await f.db.query(`INSERT INTO memory_identity.pat_space_grants(credential_id,account_id,space_id,can_ingest,can_search,expires_at)
        VALUES($1,$2,$3,true,true,$4)`, [credential.credentialId, 'account:' + actor, 'space:' + actor, expiry]);
    }
  });
  const nativeCalls = [];
  const repository = createSeoulRepository({ region: 'kr-seoul', provider: 'supabase',
    host: 'db.abcdefghijklmnopqrst.supabase.co', port: 5432, database: initial.database,
    user: 'memory_seoul_runtime', expectedRole: 'memory_seoul_runtime', password: 'fixture-only-no-network',
    deploymentId: 'memory-seoul', connectionMode: 'direct',
    applicationSchemas: ['memory_control', 'memory_identity', 'memory_content', 'memory_search', 'memory_jobs', 'memory_ops'],
  }, { region: 'kr-seoul', deploymentId: 'memory-seoul', processingPolicyId: 'kr-primary-storage-v1', schemaVersion: 4 }, {
    ...options,
    clientFactory: config => {
      assert.equal(config.host, 'db.abcdefghijklmnopqrst.supabase.co');
      return {
        async connect() { await f.db.exec('SET SESSION AUTHORIZATION memory_seoul_runtime'); },
        async query(query) {
          nativeCalls.push(query.text);
          const result = await f.db.query(query.text, query.values);
          return { rows: result.rows, rowCount: result.affectedRows ?? null };
        },
        async end() { await f.db.exec('ROLLBACK'); await f.db.exec(restore); },
        on() {},
      };
    },
  });
  const app = createSeoulApp({ repository, enabled: true });
  const transportCalls = [];
  const client = (actor = 'a', spaceId = 'space:' + actor) => createRoutingClient({
    targets: { seoul: { origin, spaceId, protocol: 'memory-routing-v2' } },
    credential: async () => ({ kind: 'pat', token: actors[actor].token }),
    fetch: async (url, init) => {
      const request = new Request(url, init); transportCalls.push(new URL(request.url).pathname);
      const response = await app.fetch(request);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return response;
    },
  });
  return { ...f, actors, repository, app, client, nativeCalls, transportCalls };
}
function rpc(token, name, input, id = 'engine:one') {
  return new Request(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token,
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'x-memory-routing': '2', 'mcp-protocol-version': '2025-11-25' },
  body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: input } }) });
}
test('native Hono and routed client archive, search and replay exact source under a scoped PAT, then honor revocation', async t => {
  const f = await fixture(t), client = f.client(), source = seoulIngest();
  const { spaceId: _space, ...args } = source;
  const stored = await client.call('memory_ingest', args);
  const receipt = JSON.parse(stored.result.content[0].text);
  assert.equal(receipt.spaceId, 'space:a'); assert.equal(receipt.state, 'stored');
  assert.equal(receipt.extraction, 'none'); assert.equal(receipt.sourceBytes, Buffer.byteLength(source.messages[0].content));
  assert.equal(receipt.messageCount, 2); assert.equal(receipt.replayed, false);
  assert.ok(!JSON.stringify(stored).includes(source.messages[0].content));
  const rows = (await f.db.query(`SELECT id,revision,content,original_timestamp,source_bytes
    FROM memory_content.archive_messages WHERE space_id=$1 ORDER BY message_index`, ['space:a'])).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.content), source.messages.map(message => message.content));
  assert.deepEqual(rows.map(row => row.original_timestamp), source.messages.map(message => message.timestamp ?? null));
  assert.equal(Number(rows[0].source_bytes), Buffer.byteLength(source.messages[0].content));
  const found = await client.call('memory_search', { routing: SEOUL_ROUTING, query: 'cafe\u0301', limit: 5 });
  assert.deepEqual(found.result.structuredContent, { spaceId: 'space:a', mode: 'keyword',
    matches: [{ memoryId: rows[0].id, revision: rows[0].revision, excerpt: source.messages[0].content }], count: 1 });
  const replayed = JSON.parse((await client.call('memory_ingest', args)).result.content[0].text);
  assert.deepEqual(replayed, { ...receipt, replayed: true });
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.meter_events')).rows[0].n, 1);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_content.archives')).rows[0].n, 1);
  assert.deepEqual((await f.db.query(`SELECT source_bytes::int,message_count FROM memory_ops.space_usage WHERE space_id='space:a'`)).rows,
    [{ source_bytes: Buffer.byteLength(source.messages[0].content), message_count: 2 }]);
  await assert.rejects(f.client('b', 'space:a').call('memory_search', { routing: SEOUL_ROUTING, query: '서울' }), { code: 'routing_upstream_rejected' });
  await assert.rejects(f.client('a', 'space:b').call('memory_ingest', { ...args, operationId: 'foreign:operation' }), { code: 'routing_write_outcome_unknown' });
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_content.archives')).rows[0].n, 1);
  const independent = await f.client('b').call('memory_search', { routing: SEOUL_ROUTING, query: '서울' });
  assert.equal(independent.result.structuredContent.count, 0);
  await f.asOwner(() => f.db.query('UPDATE memory_identity.credentials SET revoked_at=$1 WHERE id=$2', [Date.now(), f.actors.a.credentialId]));
  await assert.rejects(client.call('memory_search', { routing: SEOUL_ROUTING, query: '서울' }), { code: 'routing_upstream_unavailable' });
  let reads = 0;
  const unreadBody = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
  const denied = await f.app.fetch(new Request(rpc(f.actors.a.token, 'memory_search', {}), { body: unreadBody, duplex: 'half' }));
  assert.equal(denied.status, 401); assert.equal(reads, 0);
  const denial = await denied.text(); assert.equal(denial.includes(f.actors.a.token), false);
  assert.equal(denial.includes(source.messages[0].content), false);
  assert.equal(f.transportCalls.every(path => ['/.well-known/memory-routing-v2', '/mcp'].includes(path)), true);
});

test('real repository disclosure guard fences the original read after SDK buffering', async t => {
  let now = 100, checks = 0, original;
  const f = await fixture(t, { monotonicNow: () => now });
  await f.repository.ingest(f.actors.a.digest, seoulIngest());
  const repository = { ...f.repository, async search(...args) { original = await f.repository.search(...args); return original; },
    assertDisclosure(result) {
      assert.equal(result, original);
      if (++checks === 2) now += 30000;
      f.repository.assertDisclosure(result);
    } };
  const app = createSeoulApp({ repository, enabled: true });
  const response = await app.fetch(rpc(f.actors.a.token, 'memory_search', { spaceId: 'space:a', routing: SEOUL_ROUTING, query: '서울' }));
  assert.equal(response.status, 403); assert.equal(checks, 2);
  assert.deepEqual(await response.json(), { error: 'seoul_authority_expired' });
});

test('real committed archive keeps its operation identity if final receipt disclosure expires', async t => {
  let now = 100, checks = 0, original;
  const f = await fixture(t, { monotonicNow: () => now });
  const repository = { ...f.repository, async ingest(...args) { original = await f.repository.ingest(...args); return original; },
    assertDisclosure(result) {
      assert.equal(result, original);
      if (++checks === 2) now += 30000;
      f.repository.assertDisclosure(result);
    } };
  const app = createSeoulApp({ repository, enabled: true });
  const response = await app.fetch(rpc(f.actors.a.token, 'memory_ingest', seoulIngest()));
  assert.equal(response.status, 503); assert.equal(checks, 2);
  assert.deepEqual(await response.json(), { error: 'operation_outcome_unknown', operationId: 'operation:one' });
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM memory_ops.meter_events')).rows[0].n, 1);
});

test('HTTP deadline still bounds a synchronous stall after a valid native search', async t => {
  const f = await fixture(t); await f.repository.ingest(f.actors.a.digest, seoulIngest());
  let searched = false;
  const repository = { ...f.repository, async search(...args) {
    const result = await f.repository.search(...args); searched = true;
    // A blocked event loop cannot fire the timer. The HTTP check must also
    // compare elapsed time before returning the already-buffered result.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    return result;
  } };
  const app = createSeoulApp({ repository, enabled: true, timeoutMs: 1000 });
  const response = await app.fetch(rpc(f.actors.a.token, 'memory_search', { spaceId: 'space:a', routing: SEOUL_ROUTING, query: '서울' }));
  assert.equal(searched, true); assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: 'seoul_deadline' });
});
