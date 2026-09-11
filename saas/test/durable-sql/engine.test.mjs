import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const implementation = await import('../../src/durable-sql/engine.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const identity = { deploymentId: 'staging', databaseId: 'control', kind: 'control', epoch: 1 };
function fixture(t, name = 'sql:staging:control:1') {
  assert.equal(typeof implementation.SqlDatabaseEngine, 'function', 'The synchronous durable SQL engine must be implemented');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  const storage = {
    sql: { exec(sql, ...values) {
      const statement = raw.prepare(sql), rows = statement.all(...values);
      const readOnly = statement.columns().length > 0 && /^(SELECT|WITH|PRAGMA)\b/i.test(sql.trim());
      return { rowsWritten: readOnly ? 0 : Number(raw.prepare('SELECT changes() AS n').get().n),
        toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    transactionSync(callback) {
      raw.exec('BEGIN');
      try { const value = callback(); raw.exec('COMMIT'); return value; }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  const engine = new implementation.SqlDatabaseEngine(storage, { objectName: name });
  engine.initialize();
  raw.exec('CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT);CREATE TABLE effects(id INTEGER);CREATE TRIGGER audit_records AFTER INSERT ON records BEGIN INSERT INTO effects VALUES(NEW.id); END;');
  t.after(() => raw.close());
  function ready(status = 'ready') {
    raw.prepare('INSERT INTO durable_sql_state(singleton,deployment_id,database_id,kind,epoch,status,schema_hash,snapshot_hash) VALUES(1,?,?,?,?,?,?,?)')
      .run(identity.deploymentId, identity.databaseId, identity.kind, identity.epoch, status, 'a'.repeat(64), 'b'.repeat(64));
  }
  const execute = (statements, current = identity) => engine.execute({ identity: current, statements: statements.map(value => typeof value === 'string' ? { sql: value, values: [], mode: 'all' } : value) });
  return { raw, engine, ready, execute };
}

test('unbound/importing state and wrong named object cannot execute application SQL', t => {
  const f = fixture(t);
  assert.throws(() => f.execute(['SELECT 1']), /durable_sql_not_ready/);
  f.ready('importing');
  assert.throws(() => f.execute(['SELECT 1']), /durable_sql_not_ready/);
  assert.throws(() => f.execute(['SELECT 1'], { ...identity, epoch: 2 }), /durable_sql_identity_mismatch/);
  const random = fixture(t, ''); random.ready();
  assert.throws(() => random.execute(['SELECT 1']), /durable_sql_identity_mismatch/);
});

test('batch preserves order and rolls back every statement when a later statement fails', t => {
  const f = fixture(t); f.ready();
  assert.throws(() => f.execute(["INSERT INTO records VALUES(1,'first')", "INSERT INTO records VALUES(1,'duplicate')"]), /UNIQUE/);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM records').get().n, 0);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM effects').get().n, 0);
  const output = f.execute(["INSERT INTO records VALUES(1,'first')", 'SELECT value FROM records']);
  assert.equal(output[0].meta.changes, 1);
  assert.equal(output[1].meta.changes, 0);
  assert.deepEqual(output[1].results.map(row => ({ ...row })), [{ value: 'first' }]);
});

test('quoted SQL values/comments work but multi-statements and reserved metadata access are fenced', t => {
  const f = fixture(t); f.ready();
  const accepted = ["SELECT '; /* comment */ -- text' AS value; -- trailing", '/* head */ SELECT 1 AS value', 'WITH sample AS (SELECT 1 AS value) SELECT * FROM sample'];
  for (const sql of accepted) assert.equal(f.execute([sql])[0].success, true);
  for (const sql of ['SELECT 1; DELETE FROM records', 'SELECT 1;;', 'BEGIN', 'PRAGMA foreign_keys=OFF', 'CREATE TABLE bad(id)',
    'SELECT * FROM durable_sql_state', 'SELECT * FROM "DURABLE_SQL_state"', 'SELECT * FROM [durable_sql_state]',
    'SELECT * FROM `durable_sql_state`', "SELECT * FROM 'durable_sql_state'", 'SELECT * FROM main./* comment */durable_sql_state',
    "SELECT * FROM pragma_table_info('durable_sql_state')", '/* unterminated', "SELECT 'unterminated", 'SELECT 1\0'])
    assert.throws(() => f.execute([sql]), /durable_sql_(statement_invalid|metadata_access)/, sql);
});

test('tampered ready metadata does not release data', t => {
  const f = fixture(t); f.ready();
  f.raw.exec("UPDATE durable_sql_state SET snapshot_hash='not-sealed'");
  assert.throws(() => f.execute(['SELECT 1']), /durable_sql_not_ready/);
  f.raw.exec("UPDATE durable_sql_state SET snapshot_hash='" + 'b'.repeat(64) + "',kind='hot'");
  assert.throws(() => f.execute(['SELECT 1']), /durable_sql_identity_mismatch/);
});

test('first and run consume the statement completely and return only the requested result mode', t => {
  const f = fixture(t); f.ready();
  const output = f.execute([
    { sql: "INSERT INTO records VALUES(1,'a'),(2,'b') RETURNING id", values: [], mode: 'run' },
    { sql: 'SELECT id FROM records ORDER BY id', values: [], mode: 'first' },
  ]);
  assert.deepEqual(output[0], { success: true, results: [], meta: { changes: 2 } });
  assert.deepEqual(output[1].results.map(row => ({ ...row })), [{ id: 1 }]);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM effects').get().n, 2);
});

test('row and byte limits abort before commit, including a preceding write', t => {
  const f = fixture(t); f.ready();
  assert.throws(() => f.execute(["INSERT INTO records VALUES(1,'rollback')", 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001) SELECT x FROM n']), /durable_sql_limit/);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM records').get().n, 0);
  assert.throws(() => f.execute(["INSERT INTO records VALUES(1,'rollback')", "SELECT replace(hex(zeroblob(2200000)),'0','x') AS value"]), /durable_sql_limit/);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM records').get().n, 0);
});

test('input limits and unsupported values fail before any mutation', t => {
  const f = fixture(t); f.ready();
  for (const input of [Array.from({ length: 101 }, () => 'SELECT 1'), [{ sql: 'SELECT ?', values: [true], mode: 'all' }],
    [{ sql: 'SELECT ?', values: Array.from({ length: 101 }, () => 1), mode: 'all' }], [{ sql: 'SELECT 1 /*' + 'x'.repeat(100000) + '*/', values: [], mode: 'all' }],
    [{ sql: 'SELECT ?', values: ['x'.repeat(4 * 1024 * 1024)], mode: 'all' }]])
    assert.throws(() => f.execute(input), /durable_sql_(input_invalid|limit)/);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM records').get().n, 0);
});
