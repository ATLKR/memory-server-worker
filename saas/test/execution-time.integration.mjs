import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parse } from 'jsonc-parser';
import { WorkspaceService } from '../src/workspace.ts';
import { MemoryStore } from '../src/release/memory.ts';
import { Ingest } from '../src/release/ingest.ts';
import { Jobs } from '../src/release/jobs.ts';
import { digest } from '../src/release/util.ts';
import { applySql } from './apply-sql.mjs';

const config = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'saas-execution-time-integration', modules: true,
  scriptPath: fileURLToPath(new URL('../.local/build/worker.js', import.meta.url)),
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  d1Databases: ['DB'], bindings: config.vars,
}));
const parser = new DatabaseSync(':memory:');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const db = await mf.getD1Database('DB');
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  assert.equal(migrations.length, 21);
  for (const name of migrations) await applySql(parser, db, readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  const workspace = new WorkspaceService(db);
  async function setup(name, organization = false) {
    const actor = await workspace.signIn({ issuer: 'https://auth-api.allen.company', subject: name,
      email: name + '@example.org', emailVerified: true, permission: 'write', expiresAt: Date.now() + 900000 });
    const snapshot = await workspace.snapshot(actor.token);
    const credential = await db.prepare('SELECT id FROM credentials WHERE token_digest=?').bind(await digest(actor.token)).first();
    const org = organization ? await workspace.createOrganization(actor.token, { name, emailId: snapshot.account.emails[0].id }) : null;
    const spaceId = org?.spaceId ?? snapshot.spaces.find(space => space.organizationId === null).id;
    return { actor, credential, spaceId, org, store: new MemoryStore(db) };
  }
  function queuedDatabase(deadline, renew = false) {
    let queued = false;
    async function delay() {
      assert.equal(queued, false);
      assert.ok(Date.now() < deadline, 'The request must reach admission while still valid');
      queued = true;
      await sleep(Math.max(1, deadline + 40 - Date.now()));
      assert.ok(Date.now() > deadline);
    }
    return {
      get queued() { return queued; },
      prepare(sql) {
        if (!renew || !sql.startsWith('UPDATE release_jobs SET lease_until=')) return db.prepare(sql);
        let bound = db.prepare(sql);
        const wrapped = {
          bind(...values) { bound = bound.bind(...values); return wrapped; },
          first: (...args) => bound.first(...args), all: (...args) => bound.all(...args),
          async run() { await delay(); return bound.run(); },
        };
        return wrapped;
      },
      withSession: constraint => db.withSession(constraint),
      async batch(statements) { if (!renew) await delay(); return db.batch(statements); },
    };
  }
  async function retainedMemory(f, deletedAt) {
    const id = crypto.randomUUID(), body = 'Retained historical source';
    await db.prepare('INSERT INTO memories(id,space_id,body,revision,created_at,updated_at,actor_credential_id) VALUES(?,?,?,1,?,?,?)')
      .bind(id, f.spaceId, body, deletedAt, deletedAt, f.credential.id).run();
    await db.prepare('UPDATE memories SET revision=2,deleted_at=?,updated_at=? WHERE id=?').bind(deletedAt, deletedAt, id).run();
    return { id, body, revision: 2 };
  }
  const scenarios = ['credential', 'membership', 'proof', 'retention', 'ingest', 'lease'];
  await Promise.all(scenarios.map(async scenario => {
    const f = await setup('queued-' + scenario, scenario === 'membership');
    let memory;
    if (['membership', 'proof', 'lease'].includes(scenario)) memory = await f.store.create(f.actor.token, f.spaceId, { body: 'Must remain retained' }, 'seed');
    if (scenario === 'proof') await f.store.remove(f.actor.token, f.spaceId, memory.id, 1, 'seed-delete');
    const deadline = Date.now() + 10000;
    if (scenario === 'credential') await db.prepare('UPDATE credentials SET expires_at=? WHERE id=?').bind(deadline, f.credential.id).run();
    if (scenario === 'membership') await db.prepare('UPDATE memberships SET expires_at=? WHERE account_id=? AND organization_id=?').bind(deadline, f.actor.accountId, f.org.id).run();
    if (scenario === 'proof') await db.prepare('UPDATE credentials SET reauthenticated_at=? WHERE id=?').bind(deadline - 300000, f.credential.id).run();
    if (scenario === 'retention') memory = await retainedMemory(f, deadline - 30 * 86400000);
    let ingestId;
    if (scenario === 'ingest') {
      ingestId = crypto.randomUUID();
      await db.prepare("INSERT INTO release_jobs(id,space_id,revision,kind,state,available_at,created_at) VALUES(?,?,0,'ingest','done',?,?)").bind(ingestId, f.spaceId, Date.now(), Date.now()).run();
      await db.prepare("INSERT INTO release_ingests(id,account_id,space_id,actor_credential_id,ciphertext,proposals,state,expires_at,created_at) VALUES(?,?,?,?,'synthetic-source',?,'review',?,?)")
        .bind(ingestId, f.actor.accountId, f.spaceId, f.credential.id, JSON.stringify([{ body: 'Must not be approved late', kind: 'fact', sourceMessageId: 'message', quote: 'source quote' }]), deadline, Date.now()).run();
    }
    const queuedDb = queuedDatabase(deadline, scenario === 'lease');
    const before = (await db.prepare('SELECT * FROM memories WHERE space_id=? ORDER BY id').bind(f.spaceId).all()).results;
    const history = (await db.prepare('SELECT * FROM memory_versions WHERE space_id=? ORDER BY memory_id,revision').bind(f.spaceId).all()).results;
    const store = new MemoryStore(queuedDb);
    if (scenario === 'lease') {
      const jobId = memory.id + ':1', leaseToken = crypto.randomUUID();
      await db.prepare("UPDATE release_jobs SET state='leased',lease_token=?,lease_until=?,attempt=1 WHERE id=?").bind(leaseToken, deadline, jobId).run();
      let providerCalls = 0;
      const jobs = new Jobs({ DB: queuedDb,
        AI: { run: async () => { providerCalls++; return { data: [Array(1024).fill(0)] }; } },
        MEMORY_INDEX: { upsert: async () => { providerCalls++; }, deleteByIds: async () => { providerCalls++; }, getByIds: async () => [] },
      });
      await assert.rejects(() => jobs.index({ id: jobId, memoryId: memory.id, spaceId: f.spaceId, revision: 1, kind: 'upsert', attempt: 1, leaseToken }), /lease_lost/);
      assert.equal(providerCalls, 0);
      assert.deepEqual(await db.prepare('SELECT lease_until AS deadline,lease_token AS token,attempt FROM release_jobs WHERE id=?').bind(jobId).first(), { deadline, token: leaseToken, attempt: 1 });
    } else {
      const actions = {
        credential: () => store.create(f.actor.token, f.spaceId, { body: 'Must not be written late' }, 'late'),
        membership: () => store.remove(f.actor.token, f.spaceId, memory.id, 1, 'late'),
        proof: () => store.erase(f.actor.token, f.spaceId, memory.id, 2, memory.id, 'late'),
        retention: () => store.restore(f.actor.token, f.spaceId, memory.id, 2, 'late'),
        ingest: () => new Ingest({ DB: queuedDb }).approve(f.actor.token, f.spaceId, ingestId, [0], 'late'),
      };
      await assert.rejects(actions[scenario], error => {
        assert.ok(queuedDb.queued, scenario + ' failed before the queue: ' + error.message + ', remaining ms=' + (deadline - Date.now()));
        return [403, 409].includes(error.status);
      });
      assert.equal((await db.prepare("SELECT count(*) AS n FROM release_operations WHERE account_id=? AND client_key='late'").bind(f.actor.accountId).first()).n, 0);
      assert.deepEqual((await db.prepare('SELECT * FROM memories WHERE space_id=? ORDER BY id').bind(f.spaceId).all()).results, before);
      assert.deepEqual((await db.prepare('SELECT * FROM memory_versions WHERE space_id=? ORDER BY memory_id,revision').bind(f.spaceId).all()).results, history);
      if (scenario === 'ingest') assert.equal((await db.prepare('SELECT state FROM release_ingests WHERE id=?').bind(ingestId).first()).state, 'review');
    }
    assert.equal(queuedDb.queued, true);
    console.log('PASS native D1 execution-time admission: ' + scenario);
  }));
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
} finally { parser.close(); await mf.dispose(); }
