import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sqliteClock } from './sqlite-clock.mjs';

/** Local adapter only; production must supply a primary-consistent D1 adapter. */
export function openLocalDatabase({ workspace = false, release = false, clock } = {}) {
  const raw = new DatabaseSync(':memory:');
  const setClock = sqliteClock(raw, clock);
  raw.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;');
  raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../memory-schema.sql', import.meta.url), 'utf8'));
  if (workspace) for (const schema of ['product-schema.sql', 'auth-schema.sql', 'hierarchy-schema.sql'])
    raw.exec(readFileSync(new URL(`../${schema}`, import.meta.url), 'utf8'));
  if (release) {
    if (!workspace) throw Error('Release demo requires the workspace schemas');
    raw.exec(readFileSync(new URL('../release-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../maintenance-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../checkout-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../job-progress-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../protocol-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../pagination-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../lookup-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../key-lookup-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../tenant-queue-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../workspace-lookup-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../retrieval-progress-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../vector-reconciliation-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../outbound-share-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../execution-time-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../domain-verification-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../domain-retention-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../payload-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../operational-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../lifecycle-schema.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../queue-episode-schema.sql', import.meta.url), 'utf8'));
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
  const db = { prepare, setClock, async batch(statements) {
    raw.exec('BEGIN IMMEDIATE');
    try { const results = []; for (const statement of statements) results.push(await statement.all()); raw.exec('COMMIT'); return results; }
    catch (error) { raw.exec('ROLLBACK'); throw error; }
  }, withSession(constraint) {
    if (constraint !== 'first-primary') throw new Error('Unsupported consistency constraint');
    return { prepare };
  } };
  return { raw, db, setClock, close: () => raw.close() };
}
