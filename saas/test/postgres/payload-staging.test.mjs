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
        '0007_workspace_regional.sql', '0008_regional_space.sql', '0009_payload_staging.sql']) {
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
const nowMs = () => Date.now();

test('installs as regional version 9 with the payload schema set', async t => {
    const { db } = await createFixture(t);
    assert.equal((await db.query(`SELECT version FROM memory_control.schema_migrations ORDER BY version DESC LIMIT 1`)).rows[0].version, 9);
    const tables = (await db.query(`SELECT table_name FROM information_schema.tables
        WHERE table_schema='memory_content' AND table_name LIKE 'payload%' ORDER BY 1`)).rows.map(r => r.table_name);
    assert.deepEqual(tables, ['payload_archive_permits', 'payload_archives', 'payload_intents', 'payload_stages']);
});

test('intent reserves budget and stages must fit item_count and bytes', async t => {
    const { db, asOwner, seed } = await createFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.payload_intents(id, account_id, space_id, client_key,
            request_hash, action, item_count, reserved_bytes, created_at, expires_at)
            VALUES ('intent:1','account:a','space:a','k1','h1','upsert',2,200,$1,$2)`, [NOW, MAX]);
    });
    assert.deepEqual((await db.query(`SELECT bytes, quantity FROM memory_ops.payload_stage_accounts`)).rows,
        [{ bytes: 200, quantity: 2 }]);
    // Second intent that exceeds the 8MiB account budget is rejected.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_content.payload_intents(id, account_id, space_id, client_key,
            request_hash, action, item_count, reserved_bytes, created_at, expires_at)
            VALUES ('intent:big','account:a','space:a','k2','h2','upsert',1,8388608,$1,$2)`, [NOW, MAX]);
    }), denied);
    // A stage over the item_count ordinal is rejected.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_content.payload_stages(id, intent_id, ordinal, memory_id,
            payload_shard_id, payload_object_key, payload_sha256, payload_bytes, logical_bytes, created_at)
            VALUES ('stage:bad','intent:1',2,'mem:x','shard','obj',$1,10,10,$2)`, [d(9), NOW]);
    }), denied);
    // A stage over the reserved byte budget is rejected.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_content.payload_stages(id, intent_id, ordinal, memory_id,
            payload_shard_id, payload_object_key, payload_sha256, payload_bytes, logical_bytes, created_at)
            VALUES ('stage:bad2','intent:1',0,'mem:x','shard','obj',$1,300,10,$2)`, [d(9), NOW]);
    }), denied);
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.payload_stages(id, intent_id, ordinal, memory_id,
            payload_shard_id, payload_object_key, payload_sha256, payload_bytes, logical_bytes, created_at)
            VALUES ('stage:1','intent:1',0,'mem:x','shard','obj',$1,100,10,$2)`, [d(9), NOW]);
    });
});

test('stage lifecycle: staging -> ready -> memory payload attach -> published', async t => {
    const { db, asOwner, seed } = await createFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.payload_intents(id, account_id, space_id, client_key,
            request_hash, action, item_count, reserved_bytes, created_at, expires_at)
            VALUES ('intent:1','account:a','space:a','k1','h1','upsert',1,200,$1,$2)`, [NOW, MAX]);
        await db.query(`INSERT INTO memory_content.payload_stages(id, intent_id, ordinal, memory_id,
            payload_shard_id, payload_object_key, payload_sha256, payload_bytes, logical_bytes, created_at)
            VALUES ('stage:1','intent:1',0,'mem:x','shard','obj',$1,100,10,$2)`, [d(9), NOW]);
        await db.query(`UPDATE memory_content.payload_stages SET state='ready' WHERE id='stage:1'`);
        // The matching operation row authorizes the ready-stage reference.
        await db.query(`INSERT INTO memory_ops.release_operations(id, account_id, space_id, client_key,
            request_hash, action, actor_credential_id, created_at, period, units)
            VALUES ('op:1','account:a','space:a','k1','h1','upsert','sess:a',$1,'2026-09',0)`, [NOW]);
        // The publish path attaches the payload at INSERT: '[external]' body,
        // empty provenance, fields matching the ready stage.
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, provenance, revision,
            created_at, updated_at, actor_credential_id, payload_id, payload_shard_id,
            payload_object_key, payload_sha256, payload_bytes, logical_bytes)
            VALUES ('mem:x','space:a','[external]','{}'::jsonb,1,$1,$1,'sess:a','stage:1','shard','obj',$2,100,10)`,
            [NOW, d(9)]);
    });
    await asOwner(async () => {
        await db.query(`UPDATE memory_content.payload_stages SET state='published' WHERE id='stage:1'`);
    });
    assert.equal((await db.query(`SELECT state FROM memory_content.payload_stages WHERE id='stage:1'`)).rows[0].state, 'published');
    // Publishing releases the intent's reservation… on the publish transition.
    await asOwner(async () => {
        await db.query(`UPDATE memory_content.payload_intents SET published_at=$1 WHERE id='intent:1'`, [NOW + 5]);
    });
    assert.deepEqual((await db.query(`SELECT bytes, quantity FROM memory_ops.payload_stage_accounts`)).rows,
        [{ bytes: 0, quantity: 0 }]);
});

test('memory payload attach requires matching inline fields and authorized stage', async t => {
    const { db, asOwner, seed } = await createFixture(t);
    await seed();
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.payload_intents(id, account_id, space_id, client_key,
            request_hash, action, item_count, reserved_bytes, created_at, expires_at)
            VALUES ('intent:1','account:a','space:a','k1','h1','upsert',1,200,$1,$2)`, [NOW, MAX]);
        await db.query(`INSERT INTO memory_content.payload_stages(id, intent_id, ordinal, memory_id,
            payload_shard_id, payload_object_key, payload_sha256, payload_bytes, logical_bytes, created_at)
            VALUES ('stage:1','intent:1',0,'mem:x','shard','obj',$1,100,10,$2)`, [d(9), NOW]);
    });
    const insertPayloadMemory = body => asOwner(async () => {
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, provenance, revision,
            created_at, updated_at, actor_credential_id, payload_id, payload_shard_id,
            payload_object_key, payload_sha256, payload_bytes, logical_bytes)
            VALUES ('mem:x','space:a',${body},'{}'::jsonb,1,$1,$1,'sess:a','stage:1','shard','obj',$2,100,10)`,
            [NOW, d(9)]);
    });
    // Stage still 'staging' — reference denied.
    await assert.rejects(() => insertPayloadMemory(`'[external]'`), denied);
    // Inline body must be '[external]'.
    await asOwner(async () => {
        await db.query(`UPDATE memory_content.payload_stages SET state='ready' WHERE id='stage:1'`);
        await db.query(`INSERT INTO memory_ops.release_operations(id, account_id, space_id, client_key,
            request_hash, action, actor_credential_id, created_at, period, units)
            VALUES ('op:1','account:a','space:a','k1','h1','upsert','sess:a',$1,'2026-09',0)`, [NOW]);
    });
    await assert.rejects(() => insertPayloadMemory(`'not-external'`), denied);
    // Mismatched bytes are denied even when the stage is ready.
    await assert.rejects(() => asOwner(async () => {
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, provenance, revision,
            created_at, updated_at, actor_credential_id, payload_id, payload_shard_id,
            payload_object_key, payload_sha256, payload_bytes, logical_bytes)
            VALUES ('mem:x','space:a','[external]','{}'::jsonb,1,$1,$1,'sess:a','stage:1','shard','obj',$2,99,10)`,
            [NOW, d(9)]);
    }), denied);
    // The archive path attaches a payload by UPDATE with a permit.
    await asOwner(async () => {
        await db.query(`INSERT INTO memory_content.memories(id, space_id, body, revision, created_at, updated_at, actor_credential_id)
            VALUES ('mem:y','space:a','inline',1,$1,$1,'sess:a')`, [NOW]);
        await db.query(`INSERT INTO memory_content.payload_intents(id, account_id, space_id, client_key,
            request_hash, action, item_count, reserved_bytes, created_at, expires_at)
            VALUES ('intent:arc','account:a','space:a','kA','hA','archive',1,200,$1,$2)`, [NOW, MAX]);
        await db.query(`INSERT INTO memory_content.payload_stages(id, intent_id, ordinal, memory_id,
            payload_shard_id, payload_object_key, payload_sha256, payload_bytes, logical_bytes, created_at)
            VALUES ('stage:arc','intent:arc',0,'mem:y','shard2','obj2',$1,50,28,$2)`, [d(8), NOW]);
        await db.query(`UPDATE memory_content.payload_stages SET state='ready' WHERE id='stage:arc'`);
        await db.query(`INSERT INTO memory_content.payload_archive_permits(payload_id, memory_id, revision, target, created_at)
            VALUES ('stage:arc','mem:y',1,'current',$1)`, [NOW]);
        await db.query(`UPDATE memory_content.memories SET payload_id='stage:arc', payload_shard_id='shard2',
            payload_object_key='obj2', payload_sha256=$1, payload_bytes=50, logical_bytes=28,
            body='[external]', provenance='{}'::jsonb WHERE id='mem:y'`, [d(8)]);
    });
    assert.equal((await db.query(`SELECT payload_id FROM memory_content.memories WHERE id='mem:y'`)).rows[0].payload_id, 'stage:arc');
    assert.equal((await db.query(`SELECT count(*)::int n FROM memory_content.payload_archives`)).rows[0].n, 1);
});
