import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { unstable_splitSqlQuery } from 'wrangler';

test('forward migrations avoid the remote D1 bare trigger CASE parser failure', async () => {
  // Remote /query rejects a trigger SELECT CASE ... END; although local SQLite
  // accepts it. Parenthesize the expression, as documented in INTEGRATION.md.
  for (const directory of ['migrations', 'shard-migrations']) {
    const root = new URL(`../${directory}/`, import.meta.url);
    const files = (await readdir(root)).filter(name => name.endsWith('.sql')).sort();
    assert.ok(files.length > 0);
    for (const name of files) {
      const sql = await readFile(new URL(name, root), 'utf8');
      assert.doesNotMatch(sql, /\bSELECT\s+CASE\b/i, `${directory}/${name}: parenthesize trigger CASE expressions for the remote D1 parser`);
    }
  }
});

test('the installed Wrangler splitter produces executable central and hot migrations', async () => {
  for (const directory of ['migrations', 'shard-migrations']) {
    const db = new DatabaseSync(':memory:');
    try {
      const root = new URL(`../${directory}/`, import.meta.url);
      const files = (await readdir(root)).filter(name => name.endsWith('.sql')).sort();
      assert.ok(files.length > 0);
      for (const name of files) {
        const statements = unstable_splitSqlQuery(await readFile(new URL(name, root), 'utf8'));
        assert.ok(statements.length > 0);
        for (const sql of statements) db.exec(sql);
      }
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  }
});
