import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, seedCredential, NOW, tokens } from './helpers.mjs';

let implementation;
try { implementation = await import('../src/memory.ts'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

async function fixture(t) {
  assert.ok(implementation?.MemoryService, 'MemoryService implementation is required');
  const f = await createFixture({ memory: true });
  t.after(() => f.close());
  const service = new implementation.MemoryService(f.db, f.clock);
  const personal = await service.createSpace(tokens.alice, { name: 'Personal' });
  const organization = await service.createSpace(tokens.alice, { name: 'Organization', organizationId: 'org-one' });
  f.raw.exec(`INSERT INTO memberships(id,organization_id,account_id,email_id,role)
    VALUES ('m-bob','org-one','bob','e-bob','member')`);
  return { ...f, service, personal, organization, ...implementation };
}

test('personal spaces isolate canonical records and search to their account', async t => {
  const f = await fixture(t);
  const value = await f.service.create(tokens.alice, f.personal.id, { body: '  Original MEMORY body  ', source: 'source' });
  assert.match(value.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual({ ...value }, { id: value.id, spaceId: f.personal.id, body: '  Original MEMORY body  ', source: 'source', revision: 1, createdAt: NOW, updatedAt: NOW });
  assert.equal((await f.service.get(tokens.alice, f.personal.id, value.id)).body, value.body);
  assert.equal((await f.service.search(tokens.alice, f.personal.id, { query: 'memory' }))[0].id, value.id);
  for (const action of [
    () => f.service.get(tokens.bob, f.personal.id, value.id),
    () => f.service.search(tokens.bob, f.personal.id, { query: 'memory' }),
    () => f.service.create(tokens.bob, f.personal.id, { body: 'injected' }),
    () => f.service.update(tokens.bob, f.personal.id, value.id, { body: 'injected', expectedRevision: 1 }),
    () => f.service.remove(tokens.bob, f.personal.id, value.id, 1),
    () => f.service.get(tokens.alice, f.organization.id, value.id),
  ]) await assert.rejects(action, f.MemoryDenied);
});

test('organization members read while current owner/admin roles write', async t => {
  const f = await fixture(t);
  const value = await f.service.create(tokens.alice, f.organization.id, { body: 'Shared decision' });
  assert.equal((await f.service.get(tokens.bob, f.organization.id, value.id)).body, 'Shared decision');
  assert.equal((await f.service.search(tokens.bob, f.organization.id, { query: 'shared' })).length, 1);
  for (const action of [
    () => f.service.createSpace(tokens.bob, { name: 'Unauthorized', organizationId: 'org-one' }),
    () => f.service.create(tokens.bob, f.organization.id, { body: 'no' }),
    () => f.service.update(tokens.bob, f.organization.id, value.id, { body: 'no', expectedRevision: 1 }),
    () => f.service.remove(tokens.bob, f.organization.id, value.id, 1),
  ]) await assert.rejects(action, f.MemoryDenied);
  const updated = await f.service.update(tokens.admin, f.organization.id, value.id, { body: 'Admin correction', expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  f.raw.prepare("UPDATE memberships SET role='member' WHERE id='m-admin'").run();
  await assert.rejects(() => f.service.update(tokens.admin, f.organization.id, value.id, { body: 'Demoted', expectedRevision: 1 }), f.MemoryDenied);
  await assert.rejects(() => f.service.createSpace(tokens.bob, { name: 'Other', organizationId: 'org-two' }), f.MemoryDenied);
});

test('read-only and membership-scoped credentials cannot broaden authority', async t => {
  const f = await fixture(t);
  const readToken = 'read-only-key-000000000000000000000000000000';
  await seedCredential(f.raw, { id: 'k-read', accountId: 'alice', token: readToken, membershipId: 'm-work', emailId: 'e-work', permission: 'read' });
  const value = await f.service.create(tokens.key, f.organization.id, { body: 'Organization secret' });
  assert.equal((await f.service.get(readToken, f.organization.id, value.id)).id, value.id);
  const other = await f.service.createSpace(tokens.alice, { name: 'Other', organizationId: 'org-two' });
  for (const token of [tokens.key, readToken]) {
    await assert.rejects(() => f.service.createSpace(token, { name: 'Personal misuse' }), f.MemoryDenied);
    await assert.rejects(() => f.service.search(token, f.personal.id, { query: 'secret' }), f.MemoryDenied);
    await assert.rejects(() => f.service.create(token, other.id, { body: 'Cross organization' }), f.MemoryDenied);
    await assert.rejects(() => f.service.createSpace(token, { name: 'Other', organizationId: 'org-two' }), f.MemoryDenied);
  }
  await assert.rejects(() => f.service.createSpace(readToken, { name: 'No', organizationId: 'org-one' }), f.MemoryDenied);
  await assert.rejects(() => f.service.create(readToken, f.organization.id, { body: 'No' }), f.MemoryDenied);
  await assert.rejects(() => f.service.update(readToken, f.organization.id, value.id, { body: 'No', expectedRevision: 1 }), f.MemoryDenied);
  await assert.rejects(() => f.service.remove(readToken, f.organization.id, value.id, 1), f.MemoryDenied);
});

test('email revocation immediately removes organization access without removing personal data', async t => {
  const f = await fixture(t);
  const shared = await f.service.create(tokens.alice, f.organization.id, { body: 'Shared secret' });
  const personal = await f.service.create(tokens.alice, f.personal.id, { body: 'Personal survives' });
  await f.service.get(tokens.key, f.organization.id, shared.id);
  f.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE id=?').run(NOW, 'e-work');
  for (const token of [tokens.alice, tokens.key]) {
    await assert.rejects(() => f.service.get(token, f.organization.id, shared.id), f.MemoryDenied);
    await assert.rejects(() => f.service.search(token, f.organization.id, { query: 'secret' }), f.MemoryDenied);
    await assert.rejects(() => f.service.update(token, f.organization.id, shared.id, { body: 'No', expectedRevision: 1 }), f.MemoryDenied);
  }
  assert.equal((await f.service.get(tokens.alice, f.personal.id, personal.id)).body, 'Personal survives');
});

test('disabled accounts and organizations deny reads and writes immediately', async t => {
  const f = await fixture(t);
  const shared = await f.service.create(tokens.alice, f.organization.id, { body: 'Shared' });
  const personal = await f.service.create(tokens.alice, f.personal.id, { body: 'Personal' });
  f.raw.prepare("UPDATE organizations SET disabled_at=? WHERE id='org-one'").run(NOW);
  await assert.rejects(() => f.service.get(tokens.alice, f.organization.id, shared.id), f.MemoryDenied);
  await assert.rejects(() => f.service.create(tokens.admin, f.organization.id, { body: 'No' }), f.MemoryDenied);
  f.raw.prepare("UPDATE accounts SET disabled_at=? WHERE id='alice'").run(NOW);
  await assert.rejects(() => f.service.get(tokens.alice, f.personal.id, personal.id), f.MemoryDenied);
  await assert.rejects(() => f.service.create(tokens.alice, f.personal.id, { body: 'No' }), f.MemoryDenied);
});

test('credential and membership expiry use the injected current clock', async t => {
  const f = await fixture(t);
  const value = await f.service.create(tokens.alice, f.organization.id, { body: 'Expires' });
  f.raw.prepare("UPDATE memberships SET expires_at=? WHERE id='m-work'").run(NOW + 100);
  f.setNow(NOW + 100);
  for (const token of [tokens.alice, tokens.key]) {
    await assert.rejects(() => f.service.get(token, f.organization.id, value.id), f.MemoryDenied);
    await assert.rejects(() => f.service.create(token, f.organization.id, { body: 'Expired' }), f.MemoryDenied);
  }
  assert.deepEqual(await f.service.search(tokens.alice, f.personal.id, { query: 'anything' }), []);
  f.setNow(NOW + 3_600_000);
  await assert.rejects(() => f.service.search(tokens.alice, f.personal.id, { query: 'anything' }), f.MemoryDenied);
  await assert.rejects(() => f.service.createSpace(tokens.alice, { name: 'Expired' }), f.MemoryDenied);
});

test('optimistic updates preserve each prior version and prevent lost updates', async t => {
  const f = await fixture(t);
  const value = await f.service.create(tokens.alice, f.personal.id, { body: 'Original', source: 'original source' });
  f.setNow(NOW + 10);
  const outcomes = await Promise.allSettled([
    f.service.update(tokens.alice, f.personal.id, value.id, { body: 'Winner A', expectedRevision: 1 }),
    f.service.update(tokens.alice, f.personal.id, value.id, { body: 'Winner B', expectedRevision: 1 }),
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(outcomes.find(r => r.status === 'rejected').reason instanceof f.MemoryConflict);
  const current = await f.service.get(tokens.alice, f.personal.id, value.id);
  assert.equal(current.revision, 2);
  assert.equal(current.source, 'original source');
  assert.equal(current.createdAt, NOW);
  assert.equal(current.updatedAt, NOW + 10);
  const history = f.raw.prepare('SELECT revision,body,source FROM memory_versions WHERE memory_id=? ORDER BY revision').all(value.id);
  assert.deepEqual(history.map(r => ({ ...r })), [{ revision: 1, body: 'Original', source: 'original source' }]);
  const next = await f.service.update(tokens.alice, f.personal.id, value.id, { body: 'Explicit null source', source: null, expectedRevision: 2 });
  assert.equal(next.source, null);
  assert.equal(next.revision, 3);
});

test('soft deletion saves history, hides get/search, and cannot be repeated', async t => {
  const f = await fixture(t);
  const value = await f.service.create(tokens.alice, f.personal.id, { body: 'Find this secret' });
  await assert.rejects(() => f.service.remove(tokens.alice, f.personal.id, value.id, 2), f.MemoryConflict);
  f.setNow(NOW + 5);
  await f.service.remove(tokens.alice, f.personal.id, value.id, 1);
  await assert.rejects(() => f.service.get(tokens.alice, f.personal.id, value.id), f.MemoryDenied);
  await assert.rejects(() => f.service.remove(tokens.alice, f.personal.id, value.id, 2), f.MemoryDenied);
  await assert.rejects(() => f.service.update(tokens.alice, f.personal.id, value.id, { body: 'Revive', expectedRevision: 2 }), f.MemoryDenied);
  assert.deepEqual(await f.service.search(tokens.alice, f.personal.id, { query: 'secret' }), []);
  const row = f.raw.prepare('SELECT body,revision,deleted_at FROM memories WHERE id=?').get(value.id);
  assert.deepEqual({ ...row }, { body: 'Find this secret', revision: 2, deleted_at: NOW + 5 });
  assert.equal(f.raw.prepare('SELECT body FROM memory_versions WHERE memory_id=? AND revision=1').get(value.id).body, 'Find this secret');
});

test('keyword search is bounded, deterministic, and returns snippets without full-body fields', async t => {
  const f = await fixture(t);
  const created = [];
  for (let i = 0; i < 12; i++) {
    f.setNow(NOW + i);
    created.push(await f.service.create(tokens.alice, f.personal.id, { body: 'prefix '.repeat(100) + 'TARGET ' + 'suffix '.repeat(100), source: 'source-' + i }));
  }
  const hits = await f.service.search(tokens.alice, f.personal.id, { query: 'target' });
  assert.equal(hits.length, 10);
  assert.deepEqual(hits.map(h => h.id), created.slice(2).reverse().map(r => r.id));
  assert.equal((await f.service.search(tokens.alice, f.personal.id, { query: 'target', limit: 1 }))[0].id, created[11].id);
  for (const hit of hits) {
    assert.deepEqual(Object.keys(hit).sort(), ['id', 'revision', 'snippet', 'source', 'spaceId']);
    assert.ok(hit.snippet.length <= 500);
    assert.match(hit.snippet, /TARGET/);
  }
  assert.deepEqual(await f.service.search(tokens.alice, f.personal.id, { query: '%' }), []);
  assert.deepEqual(await f.service.search(tokens.alice, f.personal.id, { query: 'no such substring' }), []);
});

test('runtime validation rejects unsupported modes, malformed objects, IDs, and out-of-bounds input', async t => {
  const f = await fixture(t);
  for (const input of [null, [], {}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 1 }, { name: 'x', securityMode: 'zero_access' }, { name: 'x', securityMode: null }, { name: 'x', organizationId: null }, { name: 'x', organizationId: 'x'.repeat(257) }]) {
    await assert.rejects(() => f.service.createSpace(tokens.alice, input), f.MemoryInvalid);
  }
  for (const input of [null, [], {}, { body: 1 }, { body: '' }, { body: '\n\t  ' }, { body: '한'.repeat(5462) }, { body: 'x', source: '한'.repeat(683) }, { body: 'x', source: {} }]) {
    await assert.rejects(() => f.service.create(tokens.alice, f.personal.id, input), f.MemoryInvalid);
  }
  for (const input of [null, [], {}, { query: '' }, { query: ' ' }, { query: 1 }, { query: 'x'.repeat(257) }, { query: 'x', limit: 0 }, { query: 'x', limit: 51 }, { query: 'x', limit: 1.5 }, { query: 'x', limit: '1' }]) {
    await assert.rejects(() => f.service.search(tokens.alice, f.personal.id, input), f.MemoryInvalid);
  }
  for (const id of [null, '', [], 'x'.repeat(257), '../other', 'x\n']) {
    await assert.rejects(() => f.service.get(tokens.alice, id, 'missing'), f.MemoryInvalid);
    await assert.rejects(() => f.service.get(tokens.alice, f.personal.id, id), f.MemoryInvalid);
  }
  for (const revision of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => f.service.update(tokens.alice, f.personal.id, 'missing', { body: 'x', expectedRevision: revision }), f.MemoryInvalid);
    await assert.rejects(() => f.service.remove(tokens.alice, f.personal.id, 'missing', revision), f.MemoryInvalid);
  }
  await assert.rejects(() => f.service.get('invalid', f.personal.id, 'missing'), f.MemoryDenied);
  await assert.rejects(() => f.service.get(tokens.alice, f.personal.id, 'missing'), f.MemoryDenied);
  for (const time of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidClock = new f.MemoryService(f.db, () => time);
    await assert.rejects(() => invalidClock.createSpace(tokens.alice, { name: 'x' }), f.MemoryInvalid);
  }
});

test('inclusive body/source/name/query bounds succeed without trimming stored text', async t => {
  const f = await fixture(t);
  const space = await f.service.createSpace(tokens.alice, { name: 'n'.repeat(100), securityMode: 'managed' });
  const body = 'b'.repeat(16384);
  const memory = await f.service.create(tokens.alice, space.id, { body, source: 's'.repeat(2048) });
  assert.equal(memory.body, body);
  assert.equal(memory.source.length, 2048);
  assert.equal((await f.service.search(tokens.alice, space.id, { query: 'b'.repeat(256), limit: 50 })).length, 1);
});

function intercept(f, beforeRun, afterRun) {
  let armed = true;
  const original = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    const statement = original(sql);
    const run = statement.run.bind(statement);
    statement.run = async () => {
      if (!armed) return run();
      armed = false;
      beforeRun?.(sql);
      const result = await run();
      afterRun?.(sql);
      return result;
    };
    return statement;
  };
}

test('write-time authorization blocks state revoked after request begins', async t => {
  const f = await fixture(t);
  const value = await f.service.create(tokens.alice, f.organization.id, { body: 'Original' });
  intercept(f, () => f.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m-work'").run(NOW));
  await assert.rejects(() => f.service.update(tokens.alice, f.organization.id, value.id, { body: 'Unauthorized', expectedRevision: 1 }), f.MemoryDenied);
  assert.equal(f.raw.prepare('SELECT body FROM memories WHERE id=?').get(value.id).body, 'Original');
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS count FROM memory_versions').get().count, 0);
});

test('creation checks permission inside its insert after credential revocation', async t => {
  const f = await fixture(t);
  intercept(f, () => f.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='s-alice'").run(NOW));
  await assert.rejects(() => f.service.create(tokens.alice, f.personal.id, { body: 'Unauthorized' }), f.MemoryDenied);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
});

test('successful write rechecks authority before returning memory text', async t => {
  const f = await fixture(t);
  const value = await f.service.create(tokens.alice, f.personal.id, { body: 'Original' });
  intercept(f, undefined, () => f.raw.prepare("UPDATE credentials SET revoked_at=? WHERE id='s-alice'").run(NOW));
  await assert.rejects(() => f.service.update(tokens.alice, f.personal.id, value.id, { body: 'Written before revocation', expectedRevision: 1 }), f.MemoryDenied);
  assert.equal(f.raw.prepare('SELECT revision FROM memories WHERE id=?').get(value.id).revision, 2);
});

test('history and identifier-only audit are immutable and roll back together on failure', async t => {
  const f = await fixture(t);
  const value = await f.service.create(tokens.alice, f.personal.id, { body: 'private body', source: 'private source' });
  await f.service.update(tokens.alice, f.personal.id, value.id, { body: 'updated private body', expectedRevision: 1 });
  const audit = f.raw.prepare('SELECT * FROM memory_audit_events').all();
  assert.ok(audit.length >= 4);
  assert.ok(!JSON.stringify(audit).includes('private'));
  assert.throws(() => f.raw.exec("UPDATE memory_versions SET body='tampered'"));
  assert.throws(() => f.raw.exec('DELETE FROM memory_versions'));
  assert.throws(() => f.raw.exec("UPDATE memory_audit_events SET action='tampered'"));
  assert.throws(() => f.raw.exec('DELETE FROM memory_audit_events'));
  f.raw.exec(`CREATE TRIGGER fail_memory_audit BEFORE INSERT ON memory_audit_events
    WHEN NEW.action='memory_updated' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
  await assert.rejects(() => f.service.update(tokens.alice, f.personal.id, value.id, { body: 'must roll back', expectedRevision: 2 }));
  assert.equal(f.raw.prepare('SELECT revision FROM memories WHERE id=?').get(value.id).revision, 2);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS count FROM memory_versions WHERE memory_id=?').get(value.id).count, 1);
});

test('REPLACE cannot overwrite canonical ownership, revisions, history, or audit when recursive triggers are disabled', async t => {
  const f = await fixture(t);
  const value = await f.service.create(tokens.alice, f.personal.id, { body: 'Original' });
  await f.service.update(tokens.alice, f.personal.id, value.id, { body: 'Updated', expectedRevision: 1 });
  await f.service.create(tokens.alice, f.personal.id, { body: 'Unmodified record' });
  f.raw.exec('PRAGMA recursive_triggers=OFF');
  for (const table of ['spaces', 'memories', 'memory_versions', 'memory_audit_events']) {
    assert.throws(() => f.raw.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} ${table === 'memories' ? 'WHERE revision=1' : ''}`), undefined, table + ' must reject replacement');
  }
  assert.equal((await f.service.get(tokens.alice, f.personal.id, value.id)).revision, 2);
});

test('read-only personal sessions read records but cannot write or create spaces', async t => {
  const f = await fixture(t);
  const token = 'readonly-personal-session-00000000000000000000';
  await seedCredential(f.raw, { id: 's-read', accountId: 'alice', token, permission: 'read' });
  const value = await f.service.create(tokens.alice, f.personal.id, { body: 'Personal record' });
  assert.equal((await f.service.get(token, f.personal.id, value.id)).id, value.id);
  assert.equal((await f.service.search(token, f.personal.id, { query: 'record' })).length, 1);
  await assert.rejects(() => f.service.createSpace(token, { name: 'No' }), f.MemoryDenied);
  await assert.rejects(() => f.service.create(token, f.personal.id, { body: 'No' }), f.MemoryDenied);
  await assert.rejects(() => f.service.update(token, f.personal.id, value.id, { body: 'No', expectedRevision: 1 }), f.MemoryDenied);
  await assert.rejects(() => f.service.remove(token, f.personal.id, value.id, 1), f.MemoryDenied);
});

for (const [position, value] of [['leading', '\u0000hidden'], ['interior', 'before\u0000hidden']]) {
  for (const field of ['name', 'body', 'source', 'query']) {
    test(`${field} rejects ${position} NUL with MemoryInvalid before storing anything`, async t => {
      const f = await fixture(t);
      const operation = {
        name: () => f.service.createSpace(tokens.alice, { name: value }),
        body: () => f.service.create(tokens.alice, f.personal.id, { body: value }),
        source: () => f.service.create(tokens.alice, f.personal.id, { body: 'Valid body', source: value }),
        query: () => f.service.search(tokens.alice, f.personal.id, { query: value }),
      }[field];
      await assert.rejects(operation, f.MemoryInvalid);
      assert.equal(f.raw.prepare('SELECT COUNT(*) AS count FROM spaces').get().count, 2);
      assert.equal(f.raw.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
      assert.equal(f.raw.prepare('SELECT COUNT(*) AS count FROM memory_audit_events').get().count, 2);
    });
  }
}

test('updates reject NUL body/source without changing revision or history', async t => {
  const f = await fixture(t);
  const value = await f.service.create(tokens.alice, f.personal.id, { body: 'Original', source: 'Original source' });
  for (const invalid of ['\u0000hidden', 'before\u0000hidden']) {
    for (const change of [{ body: invalid }, { body: 'Valid body', source: invalid }]) {
      await assert.rejects(() => f.service.update(tokens.alice, f.personal.id, value.id, { ...change, expectedRevision: 1 }), f.MemoryInvalid);
    }
  }
  assert.equal((await f.service.get(tokens.alice, f.personal.id, value.id)).revision, 1);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS count FROM memory_versions').get().count, 0);
});

test('storage constraints reject leading/interior NUL in names, bodies, and sources', async t => {
  const f = await fixture(t);
  for (const value of ['\u0000hidden', 'before\u0000hidden']) {
    assert.throws(() => f.raw.prepare(`INSERT INTO spaces
      (id,name,account_id,security_mode,created_at,actor_credential_id) VALUES (?,?,'alice','managed',?,'s-alice')`)
      .run(crypto.randomUUID(), value, NOW));
    for (const [body, source] of [[value, null], ['Valid body', value]]) {
      assert.throws(() => f.raw.prepare(`INSERT INTO memories
        (id,space_id,body,source,revision,created_at,updated_at,actor_credential_id) VALUES (?,?,?,?,1,?,?,'s-alice')`)
        .run(crypto.randomUUID(), f.personal.id, body, source, NOW, NOW));
    }
  }
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS count FROM spaces').get().count, 2);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS count FROM memory_audit_events').get().count, 2);
});
