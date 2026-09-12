import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeoulRepository } from '../../src/postgres/seoul/repository.ts';
import { createSeoulFixture, SEOUL_DIGEST, OTHER_DIGEST, seoulIngest, seoulSearch } from './seoul-fixture.mjs';

const schemas = ['memory_control', 'memory_identity', 'memory_content', 'memory_search', 'memory_jobs', 'memory_ops'];
const expected = () => ({ region: 'kr-seoul', deploymentId: 'memory-seoul', processingPolicyId: 'kr-primary-storage-v1', schemaVersion: 4 });
const target = () => ({ region: 'kr-seoul', provider: 'supabase', host: 'db.abcdefghijklmnopqrst.supabase.co', port: 5432,
  database: 'postgres', user: 'memory_seoul_runtime', password: 'synthetic-test-only', expectedRole: 'memory_seoul_runtime',
  deploymentId: 'memory-seoul', applicationSchemas: [...schemas], connectionMode: 'direct' });
async function native(t) {
  const f = await createSeoulFixture(t), log = [], hooks = {};
  const initialRole = (await f.db.query('SELECT session_user AS role')).rows[0].role;
  const restoreRole = 'SET SESSION AUTHORIZATION "' + initialRole.replaceAll('"', '""') + '"';
  const config = target(); config.database = (await f.db.query('SELECT current_database() AS name')).rows[0].name;
  const metadata = expected();
  const clientFactory = () => ({
    async connect() { log.push('CONNECT'); await f.db.exec('SET SESSION AUTHORIZATION memory_seoul_runtime'); await hooks.connect?.(); },
    async query(query) {
      log.push(query.text); await hooks.before?.(query);
      const result = await f.db.query(query.text, query.values);
      return await hooks.after?.(query, { rows: result.rows, rowCount: result.affectedRows ?? null })
        ?? { rows: result.rows, rowCount: result.affectedRows ?? null };
    },
    // PGlite RESET SESSION AUTHORIZATION retains the last committed SET. Restore
    // the actual initial engine identity explicitly; this simulates a closed socket.
    async end() { log.push('END'); await f.db.exec('ROLLBACK'); await f.db.exec(restoreRole); await hooks.end?.(); },
    on() {},
  });
  const make = options => createSeoulRepository(config, metadata, { clientFactory, ...options });
  return { ...f, config, metadata, log, hooks, make };
}
const isCommand = (sql, name) => sql.startsWith(`SELECT ${name === 'seoul_pat_check' ? 'memory_identity' : 'memory_content'}.${name}(`);
const commandCount = (f, name) => f.log.filter(sql => isCommand(sql, name)).length;
const privateFree = error => {
  assert.equal(error.message, error.code); assert.equal(error.cause, undefined); assert.equal(error.detail, undefined);
  assert.ok(!JSON.stringify(error).includes('synthetic-secret')); return true;
};

test('constructor restricts fixed Seoul profile and schemas without opening a connection', () => {
  const options = { clientFactory() { assert.fail('invalid configuration reached client'); } };
  for (const [change, wanted] of [[{ region: 'sg' }, {}], [{ provider: 'neon' }, {}], [{ deploymentId: 'other-seoul' }, {}],
    [{ applicationSchemas: ['memory_control'] }, {}], [{ applicationSchemas: [...schemas, 'extra'] }, {}],
    [{}, { schemaVersion: 3 }], [{}, { region: 'sg' }], [{}, { processingPolicyId: 'strict-korean-processing' }]])
    assert.throws(() => createSeoulRepository({ ...target(), ...change }, { ...expected(), ...wanted }, options), { code: 'seoul_unavailable' });
  assert.throws(() => createSeoulRepository(target(), expected(), { get monotonicNow() { throw new Error('synthetic-secret config'); } }),
    error => { assert.equal(error.code, 'seoul_unavailable'); return privateFree(error); });
  assert.throws(() => createSeoulRepository(target(), expected(), null), { code: 'seoul_unavailable' });
});
test('invalid digest and direct native input fail before any connection, including semantic and NUL', async () => {
  const repo = createSeoulRepository(target(), expected(), { clientFactory() { assert.fail('invalid input reached client'); } });
  await assert.rejects(repo.preauthenticatePat('bad'), { code: 'seoul_input_invalid' });
  await assert.rejects(repo.ingest(SEOUL_DIGEST, seoulIngest({ messages: [{ role: 'user', content: 'secret\0value' }] })), { code: 'seoul_input_invalid' });
  await assert.rejects(repo.search(SEOUL_DIGEST, seoulSearch({ mode: 'semantic' })), { code: 'seoul_input_invalid' });
});
test('native repository composes real deployment/catalog checks and command SQL for archive, replay and literal search', async t => {
  const f = await native(t), repo = f.make();
  await repo.probe(); await repo.preauthenticatePat(SEOUL_DIGEST);
  const source = seoulIngest(), receipt = await repo.ingest(SEOUL_DIGEST, source);
  assert.equal(receipt.state, 'stored'); assert.equal(receipt.extraction, 'none'); assert.equal(receipt.messageCount, 2);
  assert.equal('admission' in receipt, false);
  assert.deepEqual(await repo.ingest(SEOUL_DIGEST, source), { ...receipt, replayed: true });
  const result = await repo.search(SEOUL_DIGEST, seoulSearch());
  assert.equal(result.matches[0].excerpt, source.messages[0].content); assert.equal(result.mode, 'keyword');
  assert.equal('admission' in result, false);
  await assert.rejects(repo.search(OTHER_DIGEST, seoulSearch()), { code: 'seoul_space_denied', outcome: 'rolled_back' });
  await assert.rejects(repo.ingest(SEOUL_DIGEST, seoulIngest({ messages: [{ role: 'user', content: 'changed' }] })),
    { code: 'seoul_operation_conflict', outcome: 'rolled_back' });
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM memory_ops.meter_events')).rows[0].count, 1);
  assert.equal(f.log.filter(sql => sql.includes('FROM memory_control.deployment_identity')).length, 7);
  assert.equal(f.log.filter(sql => sql.includes('SELECT version, name FROM memory_control.schema_migrations')).length, 7);
});
test('preauthentication does not authorize after current PAT revocation', async t => {
  const f = await native(t), repo = f.make(); await repo.preauthenticatePat(SEOUL_DIGEST);
  await f.asOwner(() => f.db.exec("UPDATE memory_identity.credentials SET revoked_at=1 WHERE id='pat:a'"));
  await assert.rejects(repo.ingest(SEOUL_DIGEST, seoulIngest()), { code: 'seoul_pat_denied', outcome: 'rolled_back' });
});
test('caller input and fixed target expectations are snapshotted before first await', async t => {
  const f = await native(t), repo = f.make(), source = seoulIngest();
  source.messages = source.messages.map(message => ({ ...message })); source.routing = { ...source.routing };
  f.hooks.connect = () => { source.messages[0].content = 'changed'; source.routing.destination = 'agent-memory'; };
  f.metadata.deploymentId = 'foreign-seoul'; f.config.expectedRole = 'foreign_runtime'; f.config.applicationSchemas.length = 0;
  const result = await repo.ingest(SEOUL_DIGEST, source);
  assert.equal(result.sourceBytes, Buffer.byteLength(seoulIngest().messages[0].content));
  assert.equal((await f.db.query('SELECT content FROM memory_content.archive_messages WHERE message_index=0')).rows[0].content,
    seoulIngest().messages[0].content);
});
test('malformed private envelope or mismatched metadata rolls back a native ingest before COMMIT', async t => {
  const f = await native(t), repo = f.make();
  f.hooks.after = (query, response) => {
    if (isCommand(query.text, 'seoul_archive_ingest')) response.rows[0].value.result.sourceBytes++;
    return response;
  };
  await assert.rejects(repo.ingest(SEOUL_DIGEST, seoulIngest()), { code: 'seoul_response_invalid', outcome: 'rolled_back' });
  assert.equal(f.log.includes('COMMIT'), false);
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM memory_content.archives')).rows[0].count, 0);
});
test('monotonic admission TTL includes connection time and causes pre-COMMIT rollback', async t => {
  const f = await native(t); let now = 100;
  const repo = f.make({ monotonicNow: () => now });
  f.hooks.connect = () => { now = 131; };
  f.hooks.after = (query, response) => {
    if (isCommand(query.text, 'seoul_archive_ingest')) {
      const a = response.rows[0].value.admission; a.expiresAtMs = a.issuedAtMs + 30;
    }
    return response;
  };
  await assert.rejects(repo.ingest(SEOUL_DIGEST, seoulIngest()), { code: 'seoul_authority_expired', outcome: 'rolled_back' });
  assert.equal(f.log.includes('COMMIT'), false);
});
test('post-COMMIT expiry suppresses read data and a committed write receipt without claiming rollback', async t => {
  const f = await native(t); let now = 100;
  const repo = f.make({ monotonicNow: () => now });
  f.hooks.after = (query, response) => { if (query.text === 'COMMIT') now += 30000; return response; };
  await assert.rejects(repo.ingest(SEOUL_DIGEST, seoulIngest()), { code: 'seoul_write_outcome_unknown', outcome: 'committed' });
  assert.equal(commandCount(f, 'seoul_archive_ingest'), 1);
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM memory_content.archives')).rows[0].count, 1);
  await assert.rejects(repo.search(SEOUL_DIGEST, seoulSearch()), { code: 'seoul_authority_expired', outcome: 'committed' });
});
test('observed monotonic regression fails closed and cannot return native results', async t => {
  const f = await native(t); let now = 100;
  const repo = f.make({ monotonicNow: () => now });
  f.hooks.connect = () => { now = 200; };
  f.hooks.after = (query, response) => { if (isCommand(query.text, 'seoul_pat_check')) now = 150; return response; };
  await assert.rejects(repo.preauthenticatePat(SEOUL_DIGEST), { code: 'seoul_authority_expired', outcome: 'rolled_back' });
});
test('unknown COMMIT and known committed cleanup failures are redacted and never retry writes', async t => {
  const f = await native(t), repo = f.make();
  f.hooks.after = (query, response) => { if (query.text === 'COMMIT') throw new Error('synthetic-secret commit response'); return response; };
  await assert.rejects(repo.ingest(SEOUL_DIGEST, seoulIngest()), error => {
    assert.equal(error.code, 'seoul_write_outcome_unknown'); assert.equal(error.outcome, 'unknown'); return privateFree(error);
  });
  assert.equal(commandCount(f, 'seoul_archive_ingest'), 1);
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM memory_content.archives')).rows[0].count, 1);
  delete f.hooks.after;
  f.hooks.end = () => { throw new Error('synthetic-secret close response'); };
  await assert.rejects(repo.ingest(SEOUL_DIGEST, seoulIngest({ operationId: 'op:second' })), error => {
    assert.equal(error.code, 'seoul_write_outcome_unknown'); assert.equal(error.outcome, 'committed'); return privateFree(error);
  });
  assert.equal(commandCount(f, 'seoul_archive_ingest'), 2);
});
test('fixed SQLSTATE business errors survive sanitization, unknown provider diagnostics do not', async t => {
  const f = await native(t), repo = f.make();
  for (const [sqlState, code] of [['PA001', 'seoul_input_invalid'], ['PA002', 'seoul_pat_denied'], ['PA003', 'seoul_space_denied'],
    ['PA004', 'seoul_processing_denied'], ['PA005', 'seoul_operation_conflict'], ['PA006', 'seoul_quota_exceeded'],
    ['PA007', 'seoul_authority_expired'], ['XX000', 'seoul_unavailable']]) {
    f.hooks.before = query => { if (isCommand(query.text, 'seoul_archive_ingest')) throw Object.assign(new Error('synthetic-secret SQL'), { code: sqlState }); };
    await assert.rejects(repo.ingest(SEOUL_DIGEST, seoulIngest()), error => {
      assert.equal(error.code, code); assert.equal(error.outcome, 'rolled_back'); return privateFree(error);
    });
  }
});
test('fresh deployment and privilege drift blocks commands, and aborted calls never open clients', async t => {
  const f = await native(t), repo = f.make();
  await repo.probe();
  await f.db.exec('GRANT SELECT(content) ON memory_content.archive_messages TO memory_seoul_runtime');
  await assert.rejects(repo.search(SEOUL_DIGEST, seoulSearch()), { code: 'seoul_unavailable' });
  assert.equal(commandCount(f, 'seoul_keyword_search'), 0);
  const controller = new AbortController(); controller.abort(); const before = f.log.length;
  await assert.rejects(repo.search(SEOUL_DIGEST, seoulSearch(), { signal: controller.signal }), { code: 'seoul_unavailable' });
  assert.equal(f.log.length, before);
});
test('final disclosure requires original repository result identity and a current private lease', async t => {
  const f = await native(t); let now = 100;
  const repo = f.make({ monotonicNow: () => now });
  const stored = await repo.ingest(SEOUL_DIGEST, seoulIngest());
  const found = await repo.search(SEOUL_DIGEST, seoulSearch());
  assert.equal(repo.assertDisclosure(stored), undefined); assert.equal(repo.assertDisclosure(found), undefined);
  assert.throws(() => repo.assertDisclosure({ ...found }), { code: 'seoul_response_invalid' });
  assert.deepEqual(Object.keys(found).sort(), ['count', 'matches', 'mode', 'spaceId']);
  now = 30100;
  assert.throws(() => repo.assertDisclosure(found), { code: 'seoul_authority_expired', outcome: 'committed' });
  assert.throws(() => repo.assertDisclosure(stored), { code: 'seoul_write_outcome_unknown', outcome: 'committed' });
  now = 101;
  assert.throws(() => repo.assertDisclosure(found), { code: 'seoul_authority_expired' });
});
test('final disclosure refuses cancellation after the native transaction returned', async t => {
  const f = await native(t), repo = f.make(), controller = new AbortController();
  await repo.ingest(SEOUL_DIGEST, seoulIngest());
  const found = await repo.search(SEOUL_DIGEST, seoulSearch(), { signal: controller.signal });
  controller.abort();
  assert.throws(() => repo.assertDisclosure(found), { code: 'seoul_authority_expired', outcome: 'committed' });
});
test('native response row shape and malformed admission cannot escape the transaction', async t => {
  const f = await native(t), repo = f.make();
  for (const mutate of [
    response => { response.rows.push(response.rows[0]); },
    response => { response.rows[0].extra = 'synthetic-secret'; },
    response => { response.rows[0].value.admission.expiresAtMs = '9999999999999'; },
    response => { response.rows[0].value.result = { authenticated: true, credential: 'synthetic-secret' }; },
  ]) {
    f.hooks.after = (query, response) => { if (isCommand(query.text, 'seoul_pat_check')) mutate(response); return response; };
    await assert.rejects(repo.preauthenticatePat(SEOUL_DIGEST), error => {
      assert.equal(error.code, 'seoul_response_invalid'); assert.equal(error.outcome, 'rolled_back'); return privateFree(error);
    });
  }
  assert.equal(f.log.includes('COMMIT'), false);
});
test('transport failure is sanitized with no connection retry or alternate destination', async () => {
  let connections = 0;
  const repo = createSeoulRepository(target(), expected(), { clientFactory(config) {
    connections++; assert.equal(config.host, target().host);
    return { connect() { return Promise.reject(new Error('synthetic-secret transport')); },
      query() { assert.fail('failed connection queried'); }, end: async () => {}, on() {} };
  } });
  await assert.rejects(repo.preauthenticatePat(SEOUL_DIGEST), error => {
    assert.equal(error.code, 'seoul_unavailable'); return privateFree(error);
  });
  assert.equal(connections, 1);
});
