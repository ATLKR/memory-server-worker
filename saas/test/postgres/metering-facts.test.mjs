import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const NOW = 1758000000000;
const MAX = 9007199254740991;
const d = n => n.toString(16).padStart(64, '0');
const POLICY = { policyVersion: 1, residency: 'sg', profile: 'standard', processingBoundary: 'approved-processors',
    dataClass: 'general', classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 };

async function fixture(t) {
    const db = new PGlite();
    await db.waitReady;
    t.after(() => db.close());
    const dir = new URL('../../postgres/migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort())
        await db.exec(await readFile(new URL(name, dir), 'utf8'));
    await db.exec('SET ROLE memory_owner');
    await db.query(`INSERT INTO memory_control.deployment_identity(singleton, deployment_id, storage_region,
        processing_policy_id, created_at_ms) VALUES (1,'memory-sg','sg','standard-v1',1)`);
    await db.query(`INSERT INTO memory_identity.accounts(id) VALUES ('account:a')`);
    await db.query(`INSERT INTO memory_identity.credentials(id, account_id, kind, token_digest, expires_at)
        VALUES ('sess:a','account:a','session',$1,$2)`, [d(1), MAX]);
    await db.query(`INSERT INTO memory_control.spaces(id, owner_account_id, deployment_id, data_policy,
        source_byte_limit, message_limit, name, security_mode, created_at_ms, actor_credential_id)
        VALUES ('space:a','account:a','memory-sg',$1,67108864,100000,'Personal','managed',$2,'sess:a')`,
        [JSON.stringify(POLICY), NOW]);
    return db;
}

test('a committed operation writes a usage_facts row with physical dimensions', async t => {
    const db = await fixture(t);
    await db.query(`INSERT INTO memory_ops.release_operations(id, account_id, space_id, client_key,
        request_hash, action, memory_id, expected_revision, actor_credential_id, created_at, period, units, detail)
        VALUES ('op:1','account:a','space:a','k1','h','create',NULL,NULL,'sess:a',$1,'2026-09',1,
        '{"bytes":120,"items":1,"model":"test-embed"}'::jsonb)`, [NOW]);
    const fact = (await db.query(`SELECT pool_id, space_id, account_id, action, units, bytes, items, detail
        FROM memory_ops.usage_facts WHERE operation_id='op:1'`)).rows[0];
    assert.equal(fact.pool_id, 'account:account:a');
    assert.equal(fact.units, 1);
    assert.equal(fact.bytes, 120);
    assert.equal(fact.items, 1);
    assert.equal(fact.detail.model, 'test-embed');
    // Append-only.
    await assert.rejects(() => db.query(`DELETE FROM memory_ops.usage_facts`), e => String(e.code) === '55000');
});

test('memory writes record timestamped storage deltas for byte-hours', async t => {
    const db = await fixture(t);
    await db.query(`INSERT INTO memory_content.memories(id, space_id, body, revision, created_at, updated_at,
        actor_credential_id) VALUES ('mem:1','space:a','hello',1,$1,$1,'sess:a')`, [NOW]);
    const deltas = (await db.query(`SELECT delta FROM memory_ops.storage_byte_deltas
        WHERE space_id='space:a' ORDER BY id`)).rows;
    assert.equal(deltas.length, 1);
    assert.ok(deltas[0].delta > 0);
    const gauge = (await db.query(`SELECT bytes FROM memory_ops.space_storage_counters
        WHERE space_id='space:a'`)).rows[0];
    assert.equal(gauge.bytes, deltas[0].delta);
    // Delete transition writes a negative delta — byte-hours reconstructable.
    await db.query(`UPDATE memory_content.memories SET revision=2, updated_at=$1, deleted_at=$1
        WHERE id='mem:1'`, [NOW + 1]);
    await db.query(`INSERT INTO memory_ops.erasure_permits(memory_id, actor_credential_id, created_at)
        VALUES ('mem:1','sess:a',$1)`, [NOW + 1]);
    // Erasure re-bumps deleted_at=updated_at (memories_check1 demands equality).
    await db.query(`UPDATE memory_content.memories SET revision=3, updated_at=$1, deleted_at=$1,
        erased_at=$1, body='[erased]' WHERE id='mem:1'`, [NOW + 2]);
    const after = (await db.query(`SELECT delta FROM memory_ops.storage_byte_deltas
        WHERE space_id='space:a' ORDER BY id`)).rows;
    assert.ok(after.length >= 2, 'expected delta rows for each transition');
    assert.ok(after.at(-1).delta < 0, 'erasure delta is negative');
    // The gauge equals the sum of recorded deltas — byte-hours are derivable.
    const final = (await db.query(`SELECT bytes FROM memory_ops.space_storage_counters
        WHERE space_id='space:a'`)).rows[0];
    const sum = after.reduce((t, r) => t + Number(r.delta), 0);
    assert.equal(final.bytes, sum);
});
