import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createDurableDatabase } from '../../src/durable-sql/client.ts';
import { snapshotCanonical } from '../../src/durable-sql/snapshot.ts';
import { exportDurableSnapshot } from '../../scripts/durable-snapshot.mjs';
import { openLocalDatabase } from '../../dev/sqlite.mjs';
import { digestToken } from '../../src/identity.ts';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const hash = value => createHash('sha256').update(snapshotCanonical(value)).digest('hex');
const textHash = value => createHash('sha256').update(value).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const built = await build({ stdin: { contents: `
export {MemorySqlDatabase} from '../../src/durable-sql/object.ts';
export default {async fetch(request,env){
 const {identity,method,input,grant}=await request.json();
 if(!['execute','beginImport','appendImport','sealImport'].includes(method))return Response.json({error:'fixture_method'},{status:400});
 const stub=env.SQL.getByName('sql:'+identity.deploymentId+':'+identity.databaseId+':'+identity.epoch);
 try{return Response.json({value:await stub[method](input,grant)});}catch(error){return Response.json({error:error.message},{status:400});}
}}`, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'snapshot-native-operator.mjs' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'] });

function authorize(plan) {
  const payload = { planHash: hash(plan), notBeforeMs: Date.now() - 5000, expiresAtMs: Date.now() + 600000 };
  return { ...payload, signature: sign(null, Buffer.from(snapshotCanonical(payload)), keys.privateKey).toString('base64url') };
}
function readOnly(raw) {
  return { withSession(constraint) {
    assert.equal(constraint, 'first-primary');
    return { prepare(sql) {
      const values = [];
      const statement = { bind(...next) { values.splice(0, values.length, ...next); return statement; }, async all() {
        assert.match(sql, /^(SELECT|PRAGMA)\b/i);
        return { success: true, results: raw.prepare(sql).all(...values) };
      } };
      return statement;
    } };
  } };
}
async function native(t, kind = 'control', persist = false) {
  const identity = { deploymentId: 'snapshot-native', databaseId: kind, kind, epoch: 1 };
  const path = persist ? await mkdtemp(join(tmpdir(), 'memory-snapshot-native-')) : undefined;
  let mf;
  const start = () => { mf = new Miniflare(convertV4MiniflareOptions({ name: 'snapshot-native', modules: true,
    compatibilityDate: '2026-09-08', script: built.outputFiles[0].text,
    bindings: { MEMORY_SQL_IMPORT_PUBLIC_KEY: publicKey }, durableObjects: { SQL: { className: 'MemorySqlDatabase', useSQLite: true } },
    ...(path ? { resourcePersistencePath: path } : {}), outboundService: () => new Response('outbound disabled', { status: 503 }) })); };
  start();
  t.after(async () => { await mf.dispose(); if (path) {
    assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep)); assert.ok(resolve(path).includes('memory-snapshot-native-'));
    await rm(path, { recursive: true, force: true });
  } });
  const call = async (method, input, grant) => {
    const response = await mf.dispatchFetch('https://fixture.test', { method: 'POST', body: JSON.stringify({ identity, method, input, grant }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error); return body.value;
  };
  return { identity, call, db: createDurableDatabase({ execute: input => call('execute', input) }, identity),
    async restart() { await mf.dispose(); start(); },
    async export(raw, freeze = { confirmed: true, evidenceRef: 'fixture:all-writes-paused' }) { return exportDurableSnapshot(readOnly(raw), { identity, sourceRevision: 'a'.repeat(40),
      sourceFrozenAtMs: Date.now(), freeze }); },
    async restore(snapshot) { const grant = authorize(snapshot.plan); await call('beginImport', snapshot.plan, grant);
      for (const chunk of snapshot.chunks) await call('appendImport', chunk, grant);
      return call('sealImport', { planHash: hash(snapshot.plan) }, grant); },
  };
}

// Service products run on the PostgreSQL backend only; the durable engine is a
// retired storage target. Seeds below write the same command tables the product
// writes, so the imported rows exercise the identical trigger chain.
async function controlSource(t) {
  const base = Date.now() - 86400000;
  const source = openLocalDatabase({ workspace: true, release: true, clock: () => Date.now() });
  t.after(() => source.close());
  source.setClock(() => base);
  const tokenFor = key => 'token-' + key + '-' + '0'.repeat(20);
  const signIn = async (key, subject, at, expiresAt) => source.db.prepare(
    `INSERT INTO workspace_sign_ins(id,issuer,subject,new_account_id,credential_id,token_digest,expires_at,permission,email_id,address,domain,personal_space_id,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind('si-' + key, 'https://issuer.invalid', subject, 'acct-' + key, 'cred-' + key, await digestToken(tokenFor(key)),
      expiresAt, 'write', 'em-' + key, subject + '@fixture.example', 'fixture.example', 'sp-' + key, at).run();
  const operation = (id, action, memoryId, expected, committed, at) => source.db.prepare(
    `INSERT INTO release_operations(id,account_id,space_id,client_key,request_hash,action,memory_id,expected_revision,committed_revision,actor_credential_id,created_at,period,units)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, 'acct-expired', 'sp-expired', 'client-' + id, 'request-' + id, action, memoryId,
      expected, committed, 'cred-expired', at, '2026-09', 1).run();
  await signIn('expired', 'owner', base, base + 1000);
  await operation('op-create', 'create', 'mem-1', null, 1, base + 100);
  await source.db.prepare(`INSERT INTO memories(id,space_id,body,source,revision,created_at,updated_at,actor_credential_id,kind,provenance)
    VALUES('mem-1','sp-expired',?,?,?,?,?,'cred-expired','fact','{"originKind":"user"}')`)
    .bind('Historical memory alpha', 'synthetic-history', 1, base + 100, base + 100).run();
  await operation('op-update', 'update', 'mem-1', 1, 2, base + 500);
  await source.db.prepare("UPDATE memories SET body='Current memory beta',revision=2,updated_at=? WHERE id='mem-1'").bind(base + 500).run();
  const owner = { token: tokenFor('owner'), accountId: 'acct-expired' }, other = { token: tokenFor('other'), accountId: 'acct-other' };
  const now = Date.now();
  source.setClock(() => now);
  await signIn('owner', 'owner', now, now + 900000);
  await signIn('other', 'other', now, now + 900000);
  for (const [operation_, event] of [['insert', 'INSERT'], ['update', 'UPDATE'], ['delete', 'DELETE']])
    source.raw.exec(`CREATE TRIGGER memory_runtime_fixture_${operation_} BEFORE ${event} ON accounts WHEN ${event === 'DELETE' ? 'OLD' : 'NEW'}.id='blocked-fixture' BEGIN SELECT RAISE(ABORT,'fixture_runtime_guard'); END`);
  return { ...source, owner, other, expired: { token: tokenFor('expired'), credentialId: 'cred-expired' }, space: { id: 'sp-expired' }, memoryId: 'mem-1' };
}

test('native full populated snapshot preserves historical commands, exact runtime guards, quota, memory history and FTS before serving existing SSO authority', { timeout: 45000 }, async t => {
  const source = await controlSource(t), target = await native(t);
  const counters = () => Object.fromEntries(['workspace_sign_ins', 'workspace_audit_events', 'memory_versions', 'release_operations', 'release_usage_events', 'release_jobs']
    .map(name => [name, source.raw.prepare(`SELECT count(*) AS n FROM ${name}`).get().n]));
  const before = counters();
  assert.ok(before.workspace_sign_ins >= 3 && before.memory_versions >= 1 && before.release_usage_events >= 2);
  source.raw.exec("CREATE TRIGGER memory_cutover_fence BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT,'source_frozen'); END");
  const fenceSql = source.raw.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_cutover_fence'").get().sql;
  const snapshot = await target.export(source.raw, { confirmed: true, evidenceRef: 'fixture:source-fence',
    excludedTriggers: [{ name: 'memory_cutover_fence', sqlHash: textHash(fenceSql) }] });
  assert.deepEqual(counters(), before, 'Read-only export must not replay or mutate the source');
  assert.equal(snapshot.plan.schema.filter(item => item.type === 'trigger').length, 230);
  assert.throws(() => source.raw.prepare("INSERT INTO accounts(id) VALUES('still-frozen')").run(), /source_frozen/);
  await assert.rejects(target.db.prepare('SELECT 1').first(), /durable_sql_not_ready/);
  assert.equal((await target.restore(snapshot)).ready, true);
  for (const table of snapshot.plan.tables) {
    const actual = await target.db.prepare(`SELECT ${table.columns.map(column => `${quote(column)} AS ${quote(column)}`).join(',')} FROM ${quote(table.name)} ORDER BY rowid`).all();
    const expected = snapshot.chunks.filter(chunk => snapshot.plan.chunks[chunk.index].table === table.name).flatMap(chunk => chunk.rows);
    assert.deepEqual(actual.results.map(row => table.columns.map(column => row[column])), expected, table.name);
  }
  // The retired target still holds exact restored rows; product authority itself
  // now lives on the PostgreSQL service path.
  assert.equal((await target.db.prepare('SELECT account_id FROM credentials WHERE token_digest=?').bind(await digestToken(source.owner.token)).first()).account_id, source.owner.accountId);
  assert.equal((await target.db.prepare("SELECT body FROM memories WHERE id='mem-1'").first()).body, 'Current memory beta');
  assert.ok((await target.db.prepare("SELECT expires_at FROM credentials WHERE id='cred-expired'").first()).expires_at < Date.now());
  assert.equal((await target.db.prepare('SELECT memory_id FROM release_fts WHERE release_fts MATCH ?').bind('beta').first()).memory_id, source.memoryId);
  await assert.rejects(target.db.prepare("INSERT INTO accounts(id) VALUES('blocked-fixture')").run(), /fixture_runtime_guard/);
  const token = 'token-owner-again-0123456789abcdef0123456789';
  await target.db.prepare(`INSERT INTO workspace_sign_ins(id,issuer,subject,new_account_id,credential_id,token_digest,expires_at,permission,email_id,address,domain,personal_space_id,created_at)
    VALUES('si-again','https://issuer.invalid','owner','acct-unused','cred-again',?,?, 'write','em-again',NULL,NULL,'sp-again',?)`)
    .bind(await digestToken(token), Date.now() + 900000, Date.now()).run();
  assert.equal((await target.db.prepare('SELECT account_id FROM credentials WHERE token_digest=?').bind(await digestToken(token)).first()).account_id, source.owner.accountId);
  await target.db.prepare(`INSERT INTO workspace_sign_ins(id,issuer,subject,new_account_id,credential_id,token_digest,expires_at,permission,email_id,address,domain,personal_space_id,created_at)
    VALUES('si-new','https://issuer.invalid','post-cutover-account','acct-new','cred-new',?,?, 'write','em-new',NULL,NULL,'sp-new',?)`)
    .bind(await digestToken('token-new-0123456789abcdef0123456789abc'), Date.now() + 900000, Date.now()).run();
  assert.equal((await target.db.prepare('SELECT count(*) AS n FROM accounts WHERE id=?').bind('acct-new').first()).n, 1);
  await target.db.prepare(`INSERT INTO release_operations(id,account_id,space_id,client_key,request_hash,action,memory_id,expected_revision,committed_revision,actor_credential_id,created_at,period,units)
    VALUES('op-new','acct-expired','sp-expired','client-new','request-new','create','mem-new',NULL,1,'cred-again',?,'2026-09',1)`).bind(Date.now()).run();
  await target.db.prepare(`INSERT INTO memories(id,space_id,body,source,revision,created_at,updated_at,actor_credential_id,kind,provenance)
    VALUES('mem-new','sp-expired','Memory created after verified cutover',NULL,1,?,?,'cred-again','fact','{"originKind":"user"}')`).bind(Date.now(), Date.now()).run();
  assert.equal((await target.db.prepare('SELECT count(*) AS n FROM release_usage_events').first()).n, before.release_usage_events + 1);
  await target.db.prepare('UPDATE credentials SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').bind(Date.now(), source.owner.accountId).run();
  assert.ok((await target.db.prepare('SELECT revoked_at FROM credentials WHERE id=?').bind('cred-again').first()).revoked_at !== null);
});

test('native hot snapshot preserves deleted AUTOINCREMENT high-water, visible FTS content and permanent tombstones', { timeout: 30000 }, async t => {
  const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
  raw.exec(await readFile(new URL('../../shard-migrations/0001_payloads.sql', import.meta.url), 'utf8'));
  const content = JSON.stringify({ body: 'Synthetic searchable payload', source: null, provenance: { originKind: 'user' } });
  const insert = raw.prepare('INSERT INTO payloads(row_id,id,space_id,memory_id,content,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)');
  for (const [rowid, id] of [[4, 'live'], [90, 'retired']]) insert.run(rowid, id, 'space', id, content, textHash(content), Buffer.byteLength(content), Date.now());
  raw.prepare('INSERT INTO payload_tombstones VALUES(?,?,?,?)').run('retired', 'space', 'retired', Date.now());
  const target = await native(t, 'hot'), snapshot = await target.export(raw);
  assert.equal((await target.restore(snapshot)).ready, true);
  assert.equal((await target.db.prepare("SELECT row_id FROM payloads WHERE id='live'").first()).row_id, 4);
  assert.equal((await target.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='payloads'").first()).seq, 90);
  assert.equal((await target.db.prepare('SELECT payload_id FROM payload_fts WHERE payload_fts MATCH ?').bind('searchable').first()).payload_id, 'live');
  const statement = target.db.prepare('INSERT INTO payloads(id,space_id,memory_id,content,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?)');
  await assert.rejects(statement.bind('retired', 'space', 'retired', content, textHash(content), Buffer.byteLength(content), Date.now()).run(), /payload_retired/);
  await statement.bind('new', 'space', 'new', content, textHash(content), Buffer.byteLength(content), Date.now()).run();
  assert.equal((await target.db.prepare("SELECT row_id FROM payloads WHERE id='new'").first()).row_id, 91);
});

test('native signed import resumes exact chunks across restart and never serves a partial target', { timeout: 45000 }, async t => {
  const source = await controlSource(t), target = await native(t, 'control', true);
  const snapshot = await target.export(source.raw), grant = authorize(snapshot.plan), midpoint = Math.floor(snapshot.chunks.length / 2);
  assert.ok(midpoint > 0);
  await target.call('beginImport', snapshot.plan, grant);
  for (const chunk of snapshot.chunks.slice(0, midpoint)) await target.call('appendImport', chunk, grant);
  await target.restart();
  await assert.rejects(target.db.prepare('SELECT id FROM accounts').all(), /durable_sql_not_ready/);
  assert.equal((await target.call('appendImport', snapshot.chunks[midpoint - 1], grant)).replayed, true);
  for (const chunk of snapshot.chunks.slice(midpoint)) await target.call('appendImport', chunk, grant);
  await target.call('sealImport', { planHash: hash(snapshot.plan) }, grant);
  await target.restart();
  assert.equal((await target.db.prepare('SELECT account_id FROM credentials WHERE token_digest=?').bind(await digestToken(source.owner.token)).first()).account_id, source.owner.accountId);
  await assert.rejects(target.call('appendImport', snapshot.chunks[0], grant), /snapshot_closed/);
});
