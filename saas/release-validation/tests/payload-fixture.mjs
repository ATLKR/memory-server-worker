import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { digest } from '../../src/release/util.ts';

export function payloadShard() {
  const raw = new DatabaseSync(':memory:'); raw.exec(readFileSync(new URL('../../shard-schema.sql', import.meta.url), 'utf8'));
  const db = { raw, prepare(sql) { let values = []; return {
    bind(...bound) { values = bound; return this; },
    async first() { return raw.prepare(sql).get(...values) ?? null; },
    async all() { return { success: true, results: raw.prepare(sql).all(...values), meta: {} }; },
    async run() { return { success: true, results: [], meta: { changes: Number(raw.prepare(sql).run(...values).changes) } }; },
  }; }, withSession() { return this; }, async batch(statements) {
    raw.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.all()); raw.exec('COMMIT'); return results; }
    catch (error) { raw.exec('ROLLBACK'); throw error; }
  } };
  return db;
}
export function payloadBucket() {
  const objects = new Map(); let sequence = 0;
  const api = { objects, calls: [], beforePut: null,
    async head(key) { api.calls.push(['head', key]); const row = objects.get(key); return row ? { ...row, body: undefined } : null; },
    async get(key) { api.calls.push(['get', key]); const row = objects.get(key); return row ? { ...row, body: new Response(row.text).body } : null; },
    async put(key, value, options = {}) {
      api.calls.push(['put', key]); if (api.beforePut) await api.beforePut(key, value, options);
      if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      if (options.sha256 && options.sha256 !== await digest(text)) throw Error('checksum_mismatch');
      const row = { text, size: new TextEncoder().encode(text).length, etag: 'etag-' + ++sequence, customMetadata: options.customMetadata ?? {} };
      objects.set(key, row); return { ...row };
    },
  }; return api;
}
