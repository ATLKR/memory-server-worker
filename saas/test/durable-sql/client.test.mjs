import test from 'node:test';
import assert from 'node:assert/strict';

const implementation = await import('../../src/durable-sql/client.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const identity = { deploymentId: 'staging', databaseId: 'control', kind: 'control', epoch: 1 };
const output = rows => [{ success: true, results: rows, meta: { changes: 0 } }];
function fixture(handler = request => output([{ value: request.statements[0].values[0] ?? 1 }])) {
  assert.equal(typeof implementation.createDurableDatabase, 'function', 'The durable SQL client must be implemented');
  const calls = [];
  const stub = { async execute(request) { calls.push(request); return handler(request); } };
  return { db: implementation.createDurableDatabase(stub, identity), calls, stub };
}

test('prepared bindings and configured identity are snapshots, and primary reads use the exact stub', async () => {
  const f = fixture();
  const source = { ...identity };
  const db = implementation.createDurableDatabase(f.stub, source);
  source.epoch = 2;
  const unbound = db.prepare('SELECT ? AS value');
  const first = unbound.bind('first');
  const second = first.bind('second');
  assert.deepEqual(await first.first(), { value: 'first' });
  assert.deepEqual(await second.all(), { success: true, results: [{ value: 'second' }], meta: { changes: 0 } });
  assert.deepEqual(await db.withSession('first-primary').prepare('SELECT 1').first(), { value: 1 });
  assert.ok(f.calls.every(call => call.identity.epoch === 1));
  assert.deepEqual(f.calls.map(call => call.statements[0].mode), ['first', 'all', 'first']);
  assert.throws(() => db.withSession('first-unconstrained'), /durable_sql_input_invalid/);
});

test('foreign and fabricated statements are rejected before any batch dispatch', async () => {
  const first = fixture(), second = fixture();
  await assert.rejects(first.db.batch([second.db.prepare('SELECT 1')]), /durable_sql_statement_owner/);
  await assert.rejects(first.db.batch([{ sql: 'SELECT 1' }]), /durable_sql_statement_owner/);
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 0);
});

test('batch is one ordered RPC and caller mutation cannot alter its prepared values', async () => {
  let finish;
  const f = fixture(request => new Promise(resolve => { finish = () => resolve(request.statements.map(statement => ({ success: true, results: [{ value: statement.values[0] }], meta: { changes: 1 } }))); }));
  const statements = [f.db.prepare('SELECT ? AS value').bind('a'), f.db.prepare('SELECT ? AS value').bind('b')];
  const pending = f.db.batch(statements);
  statements.reverse(); statements.length = 0;
  finish();
  assert.deepEqual((await pending).map(result => result.results[0].value), ['a', 'b']);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].statements.map(statement => statement.mode), ['all', 'all']);
});

test('unknown write outcomes are not retried or silently sent to another backend', async () => {
  const f = fixture(() => { throw new Error('response lost after commit'); });
  await assert.rejects(f.db.prepare('INSERT INTO records VALUES(?)').bind('value').run(), /response lost after commit/);
  assert.equal(f.calls.length, 1);
});

test('invalid identities, values and over-limit batches do not dispatch', async () => {
  const f = fixture();
  for (const invalid of [{ ...identity, deploymentId: 'stage:control' }, { ...identity, epoch: 0 }, { ...identity, kind: 'unknown' }, { ...identity, surprise: 1 }])
    assert.throws(() => implementation.createDurableDatabase(f.stub, invalid), /durable_sql_input_invalid/);
  for (const value of [undefined, true, {}, Infinity, NaN, 1n])
    assert.throws(() => f.db.prepare('SELECT ?').bind(value), /durable_sql_input_invalid/);
  await assert.rejects(f.db.batch(Array.from({ length: 101 }, () => f.db.prepare('SELECT 1'))), /durable_sql_limit/);
  assert.equal(f.calls.length, 0);
});

test('client rejects malformed or excessive provider results without exposing them', async () => {
  for (const value of [[], [{ success: false, results: [], meta: {} }], [{ success: true, results: [{}], meta: { changes: -1 } }],
    [{ success: true, results: [{ value: 'x'.repeat(4 * 1024 * 1024) }], meta: { changes: 0 } }]]) {
    const f = fixture(() => value);
    await assert.rejects(f.db.prepare('SELECT 1').all(), /durable_sql_(result_invalid|limit)/);
    assert.equal(f.calls.length, 1);
  }
});
