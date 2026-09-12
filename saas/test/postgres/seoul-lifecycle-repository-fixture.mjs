import { createLifecycleFixture } from './seoul-lifecycle-fixture.mjs';
import { createSeoulRepository } from '../../src/postgres/seoul/repository.ts';

export const lifecycleExpected = () => ({ region: 'kr-seoul', deploymentId: 'memory-seoul',
  processingPolicyId: 'kr-primary-storage-v1', schemaVersion: 5 });
export const lifecycleTarget = () => ({ region: 'kr-seoul', provider: 'supabase',
  host: 'db.abcdefghijklmnopqrst.supabase.co', port: 5432, database: 'postgres',
  user: 'memory_seoul_runtime', expectedRole: 'memory_seoul_runtime', password: 'synthetic-only-no-network',
  deploymentId: 'memory-seoul', connectionMode: 'direct',
  applicationSchemas: ['memory_control', 'memory_identity', 'memory_content', 'memory_search', 'memory_jobs', 'memory_ops'] });

// Only the transport is replaced. Every deployment, role, catalog and command
// query runs in the engine. This fixture does not prove TCP/TLS or concurrency.
export async function lifecycleRepositoryFixture(t, options = {}) {
  const f = await createLifecycleFixture(t, options), log = [], hooks = {};
  const initial = (await f.db.query('SELECT current_database() AS database, session_user AS role')).rows[0];
  const restore = 'SET SESSION AUTHORIZATION "' + initial.role.replaceAll('"', '""') + '"';
  const config = { ...lifecycleTarget(), database: initial.database }, expected = lifecycleExpected();
  const clientFactory = () => ({
    async connect() { log.push('CONNECT'); await f.db.exec('SET SESSION AUTHORIZATION memory_seoul_runtime'); await hooks.connect?.(); },
    async query(query) {
      log.push(query.text); await hooks.before?.(query);
      const value = await f.db.query(query.text, query.values);
      const result = { rows: value.rows, rowCount: value.affectedRows ?? null };
      return await hooks.after?.(query, result) ?? result;
    },
    async end() { log.push('END'); await f.db.exec('ROLLBACK'); await f.db.exec(restore); await hooks.end?.(); },
    on() {},
  });
  return { ...f, log, hooks, config, expected,
    make: (settings = {}) => createSeoulRepository(config, expected, { clientFactory, ...settings }) };
}
