import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { snapshotHash } from '../../src/durable-sql/snapshot.ts';
import { encryptSnapshotBackup, decryptSnapshotBackup, snapshotBackupKey } from '../../src/durable-sql/backup.ts';

async function fixture() {
  const identity = { deploymentId: 'test-stage', databaseId: 'control', kind: 'control', epoch: 1 };
  const schema = [{ type: 'table', name: 'records', tableName: 'records', sql: 'CREATE TABLE records(id TEXT PRIMARY KEY,body TEXT)' }];
  const rows = [[1, 'synthetic-id', 'synthetic confidential content']];
  const tables = [{ name: 'records', columns: ['rowid', 'id', 'body'], rowCount: 1 }];
  const chunks = [{ index: 0, table: 'records', start: 0, rowCount: 1, hash: await snapshotHash(rows) }];
  const plan = { version: 1, identity, schema, tables, chunks, schemaHash: await snapshotHash(schema), snapshotHash: await snapshotHash({ tables, chunks }), sourceRevision: 'a'.repeat(40), sourceFrozenAtMs: Date.now() };
  const expected = { runId: 'b'.repeat(24), identity, planHash: await snapshotHash(plan) };
  return { expected, secret: randomBytes(32).toString('base64url'), bundle: { plan, chunks: [{ planHash: expected.planHash, index: 0, rows }] } };
}
test('encrypted backup round-trips signed snapshot and never contains plaintext content', async () => {
  const f = await fixture(), encrypted = await encryptSnapshotBackup(f.secret, f.expected, f.bundle);
  assert.ok(!encrypted.includes('confidential')); assert.ok(!encrypted.includes('CREATE TABLE'));
  assert.deepEqual(await decryptSnapshotBackup(f.secret, f.expected, encrypted), f.bundle);
  assert.notEqual(await encryptSnapshotBackup(f.secret, f.expected, f.bundle), encrypted);
  assert.equal(snapshotBackupKey(f.expected), `memory-sql-migrations/test-stage/${'b'.repeat(24)}/control-1/${f.expected.planHash}.snapshot-v1.enc`);
});
test('backup rejects another deployment, run, signer plan, payload key, or modified ciphertext', async () => {
  const f = await fixture(), encrypted = await encryptSnapshotBackup(f.secret, f.expected, f.bundle);
  for (const expected of [{ ...f.expected, runId: 'c'.repeat(24) }, { ...f.expected, planHash: 'd'.repeat(64) }, { ...f.expected, identity: { ...f.expected.identity, deploymentId: 'prod' } }])
    await assert.rejects(decryptSnapshotBackup(f.secret, expected, encrypted));
  await assert.rejects(decryptSnapshotBackup(randomBytes(32).toString('base64url'), f.expected, encrypted));
  const tampered = JSON.parse(encrypted); tampered.ciphertext = (tampered.ciphertext[0] === 'a' ? 'b' : 'a') + tampered.ciphertext.slice(1);
  await assert.rejects(decryptSnapshotBackup(f.secret, f.expected, JSON.stringify(tampered)));
});
test('backup rejects tampered bundle, secret encoding and path injection before storage', async () => {
  const f = await fixture(); f.bundle.chunks[0].rows[0][2] = 'changed';
  await assert.rejects(encryptSnapshotBackup(f.secret, f.expected, f.bundle));
  const g = await fixture(); await assert.rejects(encryptSnapshotBackup(g.secret + '=', g.expected, g.bundle));
  assert.throws(() => snapshotBackupKey({ ...g.expected, identity: { ...g.expected.identity, databaseId: '../prod' } }));
});

test('backup rejects internally inconsistent schema and snapshot hashes even when the outer plan hash matches', async () => {
  for (const name of ['schemaHash', 'snapshotHash']) {
    const f = await fixture(); f.bundle.plan[name] = 'f'.repeat(64);
    f.expected.planHash = await snapshotHash(f.bundle.plan); f.bundle.chunks[0].planHash = f.expected.planHash;
    await assert.rejects(encryptSnapshotBackup(f.secret, f.expected, f.bundle));
  }
});

test('backup rejects rehashed rows that the signed importer cannot restore', async () => {
  for (const rows of [[[1, 'too-few-columns']], [[1, 'id', true]], [[1, 'id', { invalid: 'object' }]], [[1, 'id', 9007199254740992]]]) {
    const f = await fixture(); f.bundle.chunks[0].rows = rows;
    f.bundle.plan.chunks[0].hash = await snapshotHash(rows);
    f.bundle.plan.snapshotHash = await snapshotHash({ tables: f.bundle.plan.tables, chunks: f.bundle.plan.chunks });
    f.expected.planHash = await snapshotHash(f.bundle.plan); f.bundle.chunks[0].planHash = f.expected.planHash;
    await assert.rejects(encryptSnapshotBackup(f.secret, f.expected, f.bundle));
  }
});

test('backup identities reject coerced non-string path fields', async () => {
  const f = await fixture();
  for (const input of [{ ...f.expected, runId: [f.expected.runId] }, { ...f.expected, planHash: [f.expected.planHash] }]) {
    assert.throws(() => snapshotBackupKey(input));
  }
});

test('backup refuses a rehashed chunk exceeding the importer byte limit', async () => {
  const f = await fixture(); f.bundle.chunks[0].rows[0][2] = 'x'.repeat(524288);
  f.bundle.plan.chunks[0].hash = await snapshotHash(f.bundle.chunks[0].rows);
  f.bundle.plan.snapshotHash = await snapshotHash({ tables: f.bundle.plan.tables, chunks: f.bundle.plan.chunks });
  f.expected.planHash = await snapshotHash(f.bundle.plan); f.bundle.chunks[0].planHash = f.expected.planHash;
  await assert.rejects(encryptSnapshotBackup(f.secret, f.expected, f.bundle));
});
