import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgDatabaseFixture, createPgliteSession } from './pg-database-fixture.mjs';
import { createPostgresDatabase, translatePlaceholders } from '../../src/postgres/database.ts';
import { PostgresBoundaryError } from '../../src/postgres/connection.ts';

// Placeholder translation
test('translatePlaceholders rewrites bare ? in order', () => {
    assert.equal(translatePlaceholders('SELECT * FROM t WHERE a=? AND b=?'), 'SELECT * FROM t WHERE a=$1 AND b=$2');
    assert.equal(translatePlaceholders('SELECT 1'), 'SELECT 1');
});
test('translatePlaceholders skips string literals, identifiers, comments, dollar quotes', () => {
    const sql = `SELECT '?' AS q, "col?" FROM t WHERE a=? -- trailing ?
       AND body=$$has ? inside$$ AND note=$tag$also ?$tag$ /* block ? */`;
    assert.equal(translatePlaceholders(sql),
        `SELECT '?' AS q, "col?" FROM t WHERE a=$1 -- trailing ?
       AND body=$$has ? inside$$ AND note=$tag$also ?$tag$ /* block ? */`);
});
test('translatePlaceholders rejects unterminated spans and NUL', () => {
    for (const sql of [`SELECT 'x`, 'SELECT "x', 'SELECT /* x', 'SELECT $$x', 'SELECT \0']) {
        assert.throws(() => translatePlaceholders(sql), e => e instanceof PostgresBoundaryError && e.code === 'postgres_sql_invalid');
    }
});
test('translatePlaceholders leaves $n untouched; jsonb ? operators rejected', () => {
    assert.equal(translatePlaceholders('SELECT jsonb_exists(meta,$1)'), 'SELECT jsonb_exists(meta,$1)');
    for (const op of ['?|', '?&']) {
        assert.throws(() => translatePlaceholders(`SELECT meta ${op} $1::text[]`),
            e => e.code === 'postgres_sql_invalid');
    }
});

// Basic statement lifecycle
test('first/all/run round-trip with binds', async t => {
    const { db } = await createPgDatabaseFixture(t);
    await db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)').bind('a', 'body one', 100, 1, '{"k":1}', 1700000000000).run();
    await db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)').bind('b', 'body two', 200, 2, null, 1700000000001).run();
    const all = await db.prepare('SELECT id,body,amount,seq FROM items ORDER BY seq').all();
    assert.equal(all.success, true);
    assert.deepEqual(all.results, [
        { id: 'a', body: 'body one', amount: 100, seq: 1 },
        { id: 'b', body: 'body two', amount: 200, seq: 2 },
    ]);
    const first = await db.prepare('SELECT id FROM items WHERE seq=?').bind(2).first();
    assert.deepEqual(first, { id: 'b' });
    const missing = await db.prepare('SELECT id FROM items WHERE seq=?').bind(99).first();
    assert.equal(missing, null);
});
test('run reports meta.changes for writes', async t => {
    const { db } = await createPgDatabaseFixture(t);
    await db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)').bind('a', 'x', 1, 1, null, 1).run();
    await db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)').bind('b', 'x', 1, 2, null, 1).run();
    const r = await db.prepare("UPDATE items SET body='y' WHERE body=?").bind('x').run();
    assert.equal(r.meta.changes, 2);
    const d = await db.prepare('DELETE FROM items WHERE id=?').bind('a').run();
    assert.equal(d.meta.changes, 1);
});
test('statement is consumed after execution; bind after execute rejected', async t => {
    const { db } = await createPgDatabaseFixture(t);
    const s = db.prepare('SELECT 1 AS one');
    await s.first();
    assert.throws(() => s.bind(1), e => e.code === 'postgres_statement_consumed');
    await assert.rejects(() => s.first(), e => e.code === 'postgres_statement_consumed');
});
test('invalid bind values rejected', async t => {
    const { db } = await createPgDatabaseFixture(t);
    for (const v of [undefined, NaN, Infinity, {}, [], Symbol('s')]) {
        assert.throws(() => db.prepare('SELECT ?').bind(v), e => e.code === 'postgres_bind_invalid');
    }
});
test('bigint decodes to number; unsafe bigint rejected', async t => {
    const { db } = await createPgDatabaseFixture(t);
    const r = await db.prepare('SELECT 9007199254740991::bigint AS v').first();
    assert.deepEqual(r, { v: 9007199254740991 });
    await assert.rejects(() => db.prepare('SELECT 9007199254740992::bigint AS v').first(),
        e => e.code === 'postgres_numeric_unsafe');
});
test('sql errors propagate as boundary errors with sqlState', async t => {
    const { db } = await createPgDatabaseFixture(t);
    await assert.rejects(() => db.prepare('SELECT * FROM missing_table').all(), e => {
        assert.ok(e instanceof PostgresBoundaryError);
        assert.equal(e.code, 'postgres_operation_failed');
        assert.equal(e.sqlState, '42P01');
        return true;
    });
});

// batch: atomic transaction
test('batch runs statements in order in one transaction', async t => {
    const { db } = await createPgDatabaseFixture(t);
    const results = await db.batch([
        db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)').bind('a', 'one', 1, 1, null, 1),
        db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)').bind('b', 'two', 2, 2, null, 1),
        db.prepare('SELECT id FROM items ORDER BY seq'),
    ]);
    assert.equal(results.length, 3);
    assert.deepEqual(results[2].results, [{ id: 'a' }, { id: 'b' }]);
    assert.equal(results[0].meta.changes, 1);
});
test('batch rolls back all statements on failure', async t => {
    const { db } = await createPgDatabaseFixture(t);
    await assert.rejects(() => db.batch([
        db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)').bind('a', 'one', 1, 1, null, 1),
        db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)').bind('a', 'dup', 2, 2, null, 1),
    ]), e => e instanceof PostgresBoundaryError && e.outcome === 'rolled_back' && e.sqlState === '23505');
    const r = await db.prepare('SELECT count(*)::int AS n FROM items').first();
    assert.equal(r.n, 0);
});
test('batch commit failure reports unknown outcome', async t => {
    const { db, session } = await createPgDatabaseFixture(t);
    const orig = session.query;
    const flaky = {
        query: async (text, values) => {
            if (text === 'COMMIT') {
                const e = new Error('connection lost'); e.code = '08006'; throw e;
            }
            return orig(text, values);
        },
    };
    const flakyDb = createPostgresDatabase(flaky);
    await assert.rejects(() => flakyDb.batch([flakyDb.prepare('SELECT 1')]),
        e => e instanceof PostgresBoundaryError && e.outcome === 'unknown' && e.sqlState === '08006');
    await db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)').bind('a', 'x', 1, 1, null, 1).run();
});
test('batch rejects foreign, consumed and non-array statements', async t => {
    const { db } = await createPgDatabaseFixture(t);
    const other = createPostgresDatabase({ query: async () => ({ rows: [], rowCount: 0 }) });
    assert.equal(await db.batch([]).then(r => r.length), 0);
    await assert.rejects(() => db.batch([other.prepare('SELECT 1')]), e => e.code === 'postgres_batch_invalid');
    await assert.rejects(() => db.batch('nope'), e => e.code === 'postgres_batch_invalid');
    const used = db.prepare('SELECT 1');
    await used.first();
    await assert.rejects(() => db.batch([used]), e => e.code === 'postgres_statement_consumed');
});

// withSession
test('withSession first-primary shares the session', async t => {
    const { db } = await createPgDatabaseFixture(t);
    const s = db.withSession('first-primary');
    await s.prepare('INSERT INTO items VALUES(?,?,?,?,?,?)').bind('a', 'x', 1, 1, null, 1).run();
    const r = await s.prepare('SELECT id FROM items').first();
    assert.deepEqual(r, { id: 'a' });
    assert.throws(() => db.withSession('unconstrained'), e => e.code === 'postgres_session_invalid');
});
