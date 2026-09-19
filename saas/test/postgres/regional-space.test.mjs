import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const NOW = 1758000000000;
const MAX = 9007199254740991;
const d = n => n.toString(16).padStart(64, '0');
const POLICY = { policyVersion: 1, residency: 'sg', profile: 'standard', processingBoundary: 'approved-processors',
    dataClass: 'general', classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 };

async function createFixture(t) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const initial = (await db.query('SELECT current_database() AS name,current_user AS role')).rows[0];
    const restore = 'SET SESSION AUTHORIZATION "' + initial.role.replaceAll('"', '""') + '"';
    await db.exec('CREATE ROLE fixture_provisioner LOGIN CREATEROLE');
    if (initial.name === 'template1') {
        await db.exec('GRANT "' + initial.role.replaceAll('"', '""') + '" TO fixture_provisioner WITH SET FALSE, INHERIT TRUE, ADMIN FALSE');
    } else {
        await db.exec(`GRANT CREATE ON DATABASE "${initial.name.replaceAll('"', '""')}" TO fixture_provisioner`);
    }
    await db.exec(`GRANT pg_read_all_data TO fixture_provisioner;
        SET SESSION AUTHORIZATION fixture_provisioner;
        SET createrole_self_grant='set, inherit';`);
    const migrations = new URL('../../postgres/migrations/', import.meta.url);
    for (const name of ['0001_private_namespaces.sql', '0002_deployment_identity.sql', '0003_identity_foundation.sql',
        '0004_seoul_pat_archive.sql', '0005_seoul_archive_lifecycle.sql', '0006_identity_authority.sql',
        '0007_workspace_regional.sql', '0008_regional_space.sql']) {
        await db.exec(await readFile(new URL(name, migrations), 'utf8'));
    }
    await db.exec(`RESET ROLE; ${restore}`);
    const asOwner = async fn => { await db.exec('SET ROLE memory_owner'); try { return await fn(db); } finally { await db.exec('ROLLBACK'); await db.exec('RESET ROLE'); } };
    await asOwner(() => db.query(`INSERT INTO memory_control.deployment_identity
        VALUES(1,'memory-sg','sg','standard-v1',1)`));
    const seed = () => asOwner(async () => {
        await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a')`);
        await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at)
            VALUES ('sess:a','account:a','session',$1,$2)`, [d(1), MAX]);
        await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, deployment_id, data_policy,
            source_byte_limit, message_limit, name, security_mode, created_at_ms, actor_credential_id)
            VALUES ('space:a','account:a','memory-sg',$1,67108864,100000,'Personal','managed',$2,'sess:a')`,
            [JSON.stringify(POLICY), NOW]);
    });
    return { db, asOwner, seed };
}

const denied = e => ['55000', '23505', '23514', '23503', '42501'].includes(String(e?.code ?? ''));

test('installs as regional version 8 with content/jobs/search/ops tables', async t => {
    const { db } = await createFixture(t);
    const rows = (await db.query('SELECT version, name FROM memory_control.schema_migrations ORDER BY version')).rows;
    assert.equal(rows.at(-1).version, 8);
    const tables = (await db.query(`SELECT table_schema||'.'||table_name t FROM information_schema.tables
        WHERE table_schema IN ('memory_content','memory_jobs','memory_search') ORDER BY 1`)).rows.map(r => r.t);
    for (const expected of ['memory_content.memories', 'memory_content.memory_versions',
        'memory_jobs.release_jobs', 'memory_search.fts_rows', 'memory_search.vector_refs']) {
        assert.ok(tables.includes(expected), expected);
    }
});

test('memory create/update/delete keeps versions, audit and jobs in sync', async t => {
    const { db, asOwner, seed } = await createFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, revision, created_at, updated_at, actor_credential_id)
            VALUES ('mem:1','space:a','hello',1,$1,$1,'sess:a')`, [NOW]);
    });
    assert.equal((await db.query(`SELECT count(*)::int n FROM memory_ops.memory_audit_events
        WHERE action='memory_created'`)).rows[0].n, 1);
    assert.equal((await db.query(`SELECT count(*)::int n FROM memory_search.fts_rows`)).rows[0].n, 1);
    assert.equal((await db.query(`SELECT kind FROM memory_jobs.release_jobs WHERE id='mem:1:1'`)).rows[0].kind, 'upsert');
    // Update: version archived, audit 'memory_updated', next job enqueued.
    await asOwner(async () => {
        await db.query(`UPDATE memory_content.memories SET revision=2, updated_at=$1, body='hello v2'
            WHERE id='mem:1'`, [NOW + 1]);
    });
    assert.equal((await db.query(`SELECT revision FROM memory_content.memory_versions WHERE memory_id='mem:1'`)).rows[0].revision, 1);
    assert.equal((await db.query(`SELECT kind FROM memory_jobs.release_jobs WHERE id='mem:1:2'`)).rows[0].kind, 'upsert');
    // Tombstone delete at next revision.
    await asOwner(async () => {
        await db.query(`UPDATE memory_content.memories SET revision=3, updated_at=$1, deleted_at=$1
            WHERE id='mem:1'`, [NOW + 2]);
    });
    assert.equal((await db.query(`SELECT kind FROM memory_jobs.release_jobs WHERE id='mem:1:3'`)).rows[0].kind, 'delete');
});

test('transition rules reject revision skips, body edits on delete and stray erasure', async t => {
    const { db, asOwner, seed } = await createFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, revision, created_at, updated_at, actor_credential_id)
            VALUES ('mem:1','space:a','hello',1,$1,$1,'sess:a')`, [NOW]);
    });
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_content.memories SET revision=3, updated_at=$1 WHERE id='mem:1'`, [NOW + 1]);
    }), denied);
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_content.memories SET revision=2, updated_at=$1, deleted_at=$1, body='changed'
            WHERE id='mem:1'`, [NOW + 1]);
    }), denied);
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_content.memories SET revision=2, updated_at=$1, erased_at=$1
            WHERE id='mem:1'`, [NOW + 1]);
    }), denied);
    // With an erasure permit the erase transition succeeds.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_ops.erasure_permits(memory_id, actor_credential_id, created_at)
            VALUES ('mem:1','sess:a',$1)`, [NOW]);
        await db.query(`UPDATE memory_content.memories SET revision=2, updated_at=$1, erased_at=$1
            WHERE id='mem:1'`, [NOW + 1]);
    });
    // The erasure permit is also the only bypass for history-row deletion.
    await asOwner(async () => {
        await db.query(`DELETE FROM memory_content.memory_versions WHERE memory_id='mem:1'`);
    });
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, revision, created_at, updated_at, actor_credential_id)
            VALUES ('mem:2','space:a','other',1,$1,$1,'sess:a')`, [NOW]);
        await db.query(`UPDATE memory_content.memories SET revision=2, updated_at=$1 WHERE id='mem:2'`, [NOW + 1]);
    });
    await assert.rejects(() => asOwner(async () => {
        await db.query(`DELETE FROM memory_content.memory_versions WHERE memory_id='mem:2'`);
    }), denied);
    // Live rows cannot be deleted at all — tombstone only.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`DELETE FROM memory_content.memories WHERE id='mem:1'`);
    }), denied);
});

test('operations enforce expected revision and meter usage per pool', async t => {
    const { db, asOwner, seed } = await createFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, revision, created_at, updated_at, actor_credential_id)
            VALUES ('mem:1','space:a','hello',1,$1,$1,'sess:a')`, [NOW]);
    });
    // Stale expected revision rejected.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_ops.release_operations(id, account_id, space_id, client_key,
            request_hash, action, memory_id, expected_revision, actor_credential_id, created_at, period, units)
            VALUES ('op:bad','account:a','space:a','k1','h','update','mem:1',9,'sess:a',$1,'2026-09',1)`, [NOW]);
    }), denied);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_ops.release_operations(id, account_id, space_id, client_key,
            request_hash, action, memory_id, expected_revision, actor_credential_id, created_at, period, units)
            VALUES ('op:1','account:a','space:a','k1','h','update','mem:1',1,'sess:a',$1,'2026-09',5)`, [NOW]);
    });
    assert.deepEqual((await db.query(`SELECT pool_id, period, units FROM memory_ops.usage_events`)).rows,
        [{ pool_id: 'account:account:a', period: '2026-09', units: 5 }]);
    assert.deepEqual((await db.query(`SELECT units FROM memory_ops.usage_counters WHERE pool_id='account:account:a'`)).rows,
        [{ units: 5 }]);
    // Storage counter tracks live bytes.
    const bytes = (await db.query(`SELECT bytes FROM memory_ops.space_storage_counters WHERE space_id='space:a'`)).rows[0].bytes;
    assert.ok(bytes > 0);
});

test('ingest approval requires a review-state ingest for the same space', async t => {
    const { db, asOwner, seed } = await createFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.release_ingests(id, account_id, space_id, actor_credential_id,
            state, expires_at, created_at) VALUES ('ing:1','account:a','space:a','sess:a','review',$1,$2)`, [MAX, NOW]);
        await db.query(`INSERT INTO memory_ops.release_operations(id, account_id, space_id, client_key,
            request_hash, action, actor_credential_id, created_at, period, units)
            VALUES ('op:1','account:a','space:a','k','h','ingest','sess:a',$1,'2026-09',0)`, [NOW]);
    });
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_jobs.ingest_approvals(operation_id, ingest_id, approval_hash, result_ids, created_at)
            VALUES ('op:1','ing:1','h1','[]',$1)`, [NOW]);
    });
    assert.equal((await db.query(`SELECT count(*)::int n FROM memory_jobs.ingest_approvals`)).rows[0].n, 1);
});

test('append-only ledgers and serving-identity immutability hold', async t => {
    const { db, asOwner, seed } = await createFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, revision, created_at, updated_at, actor_credential_id)
            VALUES ('mem:1','space:a','hello',1,$1,$1,'sess:a')`, [NOW]);
        await db.query(`INSERT INTO memory_ops.erasure_ledger(memory_id, space_id, erased_at)
            VALUES ('mem:1','space:a',$1)`, [NOW]);
    });
    await assert.rejects(() => asOwner(async () => {
        await db.query(`DELETE FROM memory_ops.erasure_ledger`);
    }), denied);
    await assert.rejects(() => asOwner(async () => {
        await db.query(`DELETE FROM memory_ops.memory_audit_events`);
    }), denied);
    // Serving identity columns are immutable; seoul-slice columns stay mutable.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET name='renamed' WHERE id='space:a'`);
    }), denied);
    await asOwner(async () => {
        await db.query(`UPDATE memory_control.spaces SET source_byte_limit=1 WHERE id='space:a'`);
    });
});
