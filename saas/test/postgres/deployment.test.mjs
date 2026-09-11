import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { verifyPostgresDeployment } from '../../src/postgres/deployment.ts';

const expected = { region: 'kr-seoul', deploymentId: 'memory-seoul-test', processingPolicyId: 'kr-storage-v1', schemaVersion: 3 };
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE SCHEMA memory_control;
    CREATE TABLE memory_control.deployment_identity(singleton smallint PRIMARY KEY, deployment_id text,
      storage_region text, processing_policy_id text, created_at_ms bigint);
    CREATE TABLE memory_control.schema_migrations(version integer PRIMARY KEY, name text, installed_at_ms bigint);
    INSERT INTO memory_control.deployment_identity VALUES(1,'memory-seoul-test','kr-seoul','kr-storage-v1',1789110000000);
    INSERT INTO memory_control.schema_migrations VALUES(1,'schemas',1789110000000),(2,'control',1789110000000),(3,'identity',1789110000000);`);
  return { db, session: { query: async (sql, values) => { const r = await db.query(sql, values); return { rows: r.rows, rowCount: r.affectedRows ?? null }; } } };
}
test('attests the selected region, deployment, processing policy and exact native schema version', async t => {
  const { session } = await fixture(t);
  assert.deepEqual(await verifyPostgresDeployment(session, expected), {
    region: 'kr-seoul', deploymentId: 'memory-seoul-test', processingPolicyId: 'kr-storage-v1', schemaVersion: 3,
  });
});
for (const [label, sql] of [
  ['another region', "UPDATE memory_control.deployment_identity SET storage_region='sg'"],
  ['another deployment', "UPDATE memory_control.deployment_identity SET deployment_id='memory-seoul-other'"],
  ['a weaker processing profile', "UPDATE memory_control.deployment_identity SET processing_policy_id='standard-v1'"],
  ['an uninitialized database', 'DELETE FROM memory_control.deployment_identity'],
  ['extra deployment identity', "INSERT INTO memory_control.deployment_identity VALUES(2,'memory-seoul-test','kr-seoul','kr-storage-v1',1789110000000)"],
  ['a future schema', "INSERT INTO memory_control.schema_migrations VALUES(4,'future',1789110000000)"],
  ['a migration gap', 'DELETE FROM memory_control.schema_migrations WHERE version=2'],
  ['no migration ledger', 'DELETE FROM memory_control.schema_migrations'],
  ['a malformed migration number', "INSERT INTO memory_control.schema_migrations VALUES(0,'zero',1789110000000)"],
]) test(`rejects ${label} before returning an attestation`, async t => {
  const { db, session } = await fixture(t);
  await db.exec(sql);
  await assert.rejects(verifyPostgresDeployment(session, expected), { code: 'postgres_deployment_mismatch' });
});
test('invalid expectations are rejected without accessing a database', async () => {
  const session = { query() { assert.fail('invalid expectation reached database'); } };
  for (const changes of [{ region: 'apac' }, { deploymentId: '' }, { processingPolicyId: '' }, { schemaVersion: 0 }, { schemaVersion: 1.5 }, { schemaVersion: 10001 }]) {
    await assert.rejects(verifyPostgresDeployment(session, { ...expected, ...changes }), { code: 'postgres_deployment_expectation_invalid' });
  }
});
test('provider errors never expose query detail, role names or connection information', async () => {
  const session = { query() { throw Object.assign(new Error('postgres://private-secret@db/internal'), { code: '42501', detail: 'sensitive' }); } };
  await assert.rejects(verifyPostgresDeployment(session, expected), error => {
    assert.equal(error.code, 'postgres_deployment_unavailable');
    assert.equal(error.message, 'postgres_deployment_unavailable');
    assert.equal(error.cause, undefined);
    return true;
  });
});
