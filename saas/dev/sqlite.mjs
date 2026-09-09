import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Local adapter only; production must supply a primary-consistent D1 adapter. */
export function openLocalDatabase({ workspace = false, release = false } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;');
  raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../memory-schema.sql', import.meta.url), 'utf8'));
  if (workspace) for (const schema of ['product-schema.sql', 'auth-schema.sql', 'hierarchy-schema.sql'])
    raw.exec(readFileSync(new URL(`../${schema}`, import.meta.url), 'utf8'));
  if (release) {
    if (!workspace) throw Error('Release demo requires the workspace schemas');
    raw.exec(readFileSync(new URL('../release-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../maintenance-schema.sql', import.meta.url), 'utf8'));
  }
  function prepare(sql) {
    const statement = raw.prepare(sql);
    function bound(values) {
      return {
        bind(...next) { return bound(next); },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { success: true, results: statement.all(...values) }; },
        async run() {
          const result = statement.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
    }
    return bound([]);
  }
  const db = { prepare, async batch(statements) {
    raw.exec('BEGIN IMMEDIATE');
    try { const results = []; for (const statement of statements) results.push(await statement.all()); raw.exec('COMMIT'); return results; }
    catch (error) { raw.exec('ROLLBACK'); throw error; }
  }, withSession(constraint) {
    if (constraint !== 'first-primary') throw new Error('Unsupported consistency constraint');
    return { prepare };
  } };
  return { raw, db, close: () => raw.close() };
}
