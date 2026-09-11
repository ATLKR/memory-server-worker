import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ConsentLedger } from '../../src/routing/ledger.ts';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const storage = { sql: { exec(query, ...values) {
    if (!values.length && query.includes(';')) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    return { toArray: () => statement.all(...values) };
  } }, transactionSync(callback) { db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const ledger = new ConsentLedger(storage, { now: () => 100000 }); ledger.initialize();
  return { ledger, db };
}
test('new organization standing grant has server identity and monotonic version', async t => {
  const { ledger } = fixture(t);
  const record = await ledger.grant({ organizationId: 'org', approvedBy: 'admin', expectedVersion: 0,
    grant: { spaceScope: { kind: 'all-spaces' }, scopes: ['ingest','storage','extraction','embedding','recall'], validFromMs: 0, evidenceRef: 'evidence' } });
  assert.equal(record.organizationId, 'org'); assert.equal(record.version, 1);
  assert.match(record.id, /^[A-Za-z0-9._:-]+$/); assert.equal(record.status, 'granted');
});
