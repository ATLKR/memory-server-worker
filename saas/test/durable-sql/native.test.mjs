import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createDurableDatabase } from '../../src/durable-sql/client.ts';
import { WorkspaceService } from '../../src/workspace.ts';
import { MemoryService } from '../../src/memory.ts';

const directory = new URL('../../migrations/', import.meta.url);
const migrations = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
  .map(async name => ({ name, sql: await readFile(new URL(name, directory), 'utf8') })));
const authoritySchemaQuery = "SELECT type,name,tbl_name FROM sqlite_master WHERE type IN ('trigger','view') ORDER BY type,name";
// Compare the complete schema across SQLite engines so additive migrations do
// not leave the native restart check behind a stale aggregate count.
const expectedAuthoritySchema = (() => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const migration of migrations) db.exec(migration.sql);
    return db.prepare(authoritySchemaQuery).all().map(row => ({ ...row }));
  } finally { db.close(); }
})();
const shard = await readFile(new URL('../../shard-migrations/0001_payloads.sql', import.meta.url), 'utf8');
const built = await build({ stdin: { contents: `
import { MemorySqlDatabase } from '../../src/durable-sql/object.ts';
const migrations=${JSON.stringify(migrations)},shard=${JSON.stringify(shard)};
export class Fixture extends MemorySqlDatabase {
 bootstrap(identity){
  const sql=this.ctx.storage.sql;
  if(sql.exec('SELECT count(*) AS n FROM durable_sql_state').toArray()[0].n!==0)throw Error('fixture_already_bootstrapped');
  for(const migration of(identity.kind==='hot'?[{name:'hot',sql:shard}]:migrations))this.ctx.storage.transactionSync(()=>sql.exec(migration.sql).toArray());
  sql.exec('INSERT INTO durable_sql_state VALUES(1,?,?,?,?,?,?,?)',identity.deploymentId,identity.databaseId,identity.kind,identity.epoch,'ready','a'.repeat(64),'b'.repeat(64)).toArray();
  return sql.exec(${JSON.stringify(authoritySchemaQuery)}).toArray();
 }
 maintenance(input){
  if(input.operation==='pause'){this.ctx.storage.sql.exec("UPDATE durable_sql_state SET status='importing'").toArray();return null;}
  if(input.operation==='foreign-key-check')return this.ctx.storage.sql.exec('PRAGMA foreign_key_check').toArray();
  throw Error('fixture_invalid_operation');
 }
}
export default {async fetch(request,env){
 const {method,input,name,random}=await request.json();
 if(!['execute','bootstrap','maintenance'].includes(method))return new Response(null,{status:400});
 const stub=random?env.DATABASE.get(env.DATABASE.newUniqueId()):env.DATABASE.getByName(name);
 try{return Response.json({value:await stub[method](input)});}catch(error){return Response.json({error:error.message},{status:400});}
}}`, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'durable-sql-native-fixture.mjs' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'] });
const baseIdentity = { deploymentId: 'staging', databaseId: 'control', kind: 'control', epoch: 1 };
async function fixture(t, { kind = 'control', persist = false } = {}) {
  const identity = { ...baseIdentity, databaseId: kind, kind }, name = `sql:staging:${kind}:1`;
  const path = persist ? await mkdtemp(join(tmpdir(), 'memory-durable-sql-')) : undefined;
  let mf;
  const start = () => { mf = new Miniflare(convertV4MiniflareOptions({ name: 'durable-sql-native', modules: true,
    compatibilityDate: '2026-09-08', script: built.outputFiles[0].text,
    durableObjects: { DATABASE: { className: 'Fixture', useSQLite: true } },
    ...(path ? { resourcePersistencePath: path } : {}), outboundService: () => new Response('outbound disabled', { status: 503 }) })); };
  start();
  t.after(async () => { await mf.dispose(); if (path) {
    assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep));
    assert.ok(resolve(path).includes('memory-durable-sql-')); await rm(path, { recursive: true, force: true });
  } });
  const call = async (method, input = {}, options = {}) => {
    const response = await mf.dispatchFetch('https://fixture.test', { method: 'POST', body: JSON.stringify({ method, input, name, ...options }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error); return body.value;
  };
  const db = createDurableDatabase({ execute: input => call('execute', input) }, identity);
  return { db, call, identity, async bootstrap() { return call('bootstrap', identity); }, async restart() { await mf.dispose(); start(); } };
}

test('native named RPC stays unserved before activation and retains ready data across restart', { timeout: 30000 }, async t => {
  const f = await fixture(t, { persist: true });
  await assert.rejects(f.db.prepare('SELECT 1').first(), /durable_sql_not_ready/);
  assert.deepEqual(await f.bootstrap(), expectedAuthoritySchema);
  await f.db.prepare("INSERT INTO accounts(id) VALUES('retained')").run();
  await f.restart();
  assert.deepEqual(await f.db.withSession('first-primary').prepare("SELECT id FROM accounts WHERE id='retained'").first(), { id: 'retained' });
  const request = { identity: f.identity, statements: [{ sql: 'SELECT 1', values: [], mode: 'first' }] };
  await assert.rejects(f.call('execute', request, { name: 'sql:staging:other:1' }), /durable_sql_identity_mismatch/);
  await assert.rejects(f.call('execute', request, { random: true }), /durable_sql_identity_mismatch/);
  await f.call('maintenance', { operation: 'pause' });
  await assert.rejects(f.db.prepare('SELECT id FROM accounts').all(), /durable_sql_not_ready/);
});

test('native full-schema SSO command, exact account snapshot, memory authorization and revocation preserve product behavior', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.bootstrap();
  const workspace = new WorkspaceService(f.db, Date.now, { identityLifecycle: true });
  const memory = new MemoryService(f.db);
  const principal = subject => ({ issuer: 'https://issuer.invalid', subject, issuedAt: Date.now(), expiresAt: Date.now() + 900000, permission: 'write' });
  const owner = await workspace.signIn(principal('owner'));
  const other = await workspace.signIn(principal('other'));
  const snapshot = await workspace.snapshot(owner.token);
  assert.equal(snapshot.account.id, owner.accountId);
  assert.equal(snapshot.spaces.length, 1);
  const space = snapshot.spaces[0];
  const created = await memory.create(owner.token, space.id, { body: 'Native authority survives storage replacement' });
  assert.equal((await memory.list(owner.token, space.id)).results[0].id, created.id);
  await assert.rejects(memory.list(other.token, space.id), /Memory operation denied/);
  await f.db.prepare('UPDATE credentials SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').bind(Date.now(), owner.accountId).run();
  await assert.rejects(workspace.snapshot(owner.token), /Workspace operation denied/);
  await assert.rejects(memory.list(owner.token, space.id), /Memory operation denied/);
  assert.deepEqual(await f.call('maintenance', { operation: 'foreign-key-check' }), []);
});

test('native trigger effects are atomic while changes counts only the top-level statement', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.bootstrap();
  const now = Date.now();
  const signin = f.db.prepare(`INSERT INTO workspace_sign_ins(id,issuer,subject,new_account_id,credential_id,token_digest,
    expires_at,permission,email_id,address,domain,personal_space_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind('signin', 'https://issuer.invalid', 'subject', 'account', 'credential', 'a'.repeat(64),
    now + 900000, 'write', 'email', null, null, 'space', now);
  const result = await signin.run();
  assert.equal(result.meta.changes, 1);
  for (const table of ['accounts', 'credentials', 'spaces', 'release_pools'])
    assert.equal((await f.db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n, 1);
  await assert.rejects(f.db.batch([f.db.prepare("INSERT INTO accounts(id) VALUES('rollback')"), f.db.prepare("INSERT INTO accounts(id) VALUES('account')")]), /account ID already exists/);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM accounts WHERE id='rollback'").first()).n, 0);
  assert.equal((await f.db.prepare('SELECT 1').all()).meta.changes, 0);
});

test('native execution time rejects expired authority even with an earlier bound application time', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.bootstrap();
  const actual = Date.now(), earlier = actual - 900000;
  await assert.rejects(f.db.prepare(`INSERT INTO workspace_sign_ins(id,issuer,subject,new_account_id,credential_id,token_digest,
    expires_at,permission,email_id,address,domain,personal_space_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind('expired', 'https://issuer.invalid', 'subject', 'account', 'credential', 'a'.repeat(64), actual - 1,
      'write', 'email', null, null, 'space', earlier).run(), /workspace operation denied/);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM accounts').first()).n, 0);
});

test('native hot FTS, tenant prefix and irreversible tombstone fence are unchanged', { timeout: 30000 }, async t => {
  const f = await fixture(t, { kind: 'hot' }); await f.bootstrap();
  const prefix = '가'.repeat(31), body = prefix + '나 alpha';
  const content = JSON.stringify({ body, source: null, provenance: { originKind: 'user' } });
  const insert = f.db.prepare('INSERT INTO payloads(id,space_id,memory_id,content,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind('payload', 'space', 'memory', content, 'a'.repeat(64), new TextEncoder().encode(content).byteLength, Date.now());
  await insert.run();
  const search = f.db.prepare("SELECT payload_id,highlight(payload_fts,3,'[',']') AS marked FROM payload_fts WHERE payload_fts MATCH ?");
  assert.equal((await search.bind(`tenant:"t7370616365" AND body:("${prefix}"*)`).first()).payload_id, 'payload');
  assert.equal(await search.bind(`tenant:"t6f74686572" AND body:("${prefix}"*)`).first(), null);
  await f.db.prepare('INSERT INTO payload_tombstones VALUES(?,?,?,?)').bind('payload', 'space', 'memory', Date.now()).run();
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM payloads').first()).n, 0);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM payload_fts').first()).n, 0);
  await assert.rejects(insert.run(), /payload_retired/);
});

test('native guard and cumulative result limits reject a batch before any partial write can survive', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.bootstrap();
  for (const name of ['durable_sql_state', '"DURABLE_SQL_state"', '[durable_sql_state]', '`durable_sql_state`', "'durable_sql_state'"])
    await assert.rejects(f.db.prepare('SELECT * FROM ' + name).all(), /durable_sql_metadata_access/);
  await assert.rejects(f.db.batch([f.db.prepare("INSERT INTO accounts(id) VALUES('rollback')"),
    f.db.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001) SELECT x FROM n')]), /durable_sql_limit/);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM accounts WHERE id='rollback'").first()).n, 0);
  await assert.rejects(f.db.batch([f.db.prepare("INSERT INTO accounts(id) VALUES('rollback')"),
    f.db.prepare('WITH n(x) AS (VALUES(1),(2),(3),(4),(5)) SELECT hex(zeroblob(500000)) AS value FROM n')]), /durable_sql_limit/);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM accounts WHERE id='rollback'").first()).n, 0);
  await assert.rejects(f.db.prepare('SELECT 1; DELETE FROM accounts').all(), /durable_sql_statement_invalid/);
});
