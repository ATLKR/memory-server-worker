import { PGlite } from '@electric-sql/pglite';
import { createPostgresDatabase } from '../../src/postgres/database.ts';

/** Wraps a PGlite handle as a `PgSession` (`src/postgres/connection.ts`). */
export function createPgliteSession(db) {
    return {
        query: async (text, values = []) => {
            const r = await db.query(text, values);
            return { rows: r.rows, rowCount: typeof r.rowCount === 'number' ? r.rowCount : null };
        },
    };
}

/** A `Database` (`src/release/types.ts`) backed by in-memory PostgreSQL. */
export async function createPgDatabaseFixture(t, { schema = true } = {}) {
    const engine = new PGlite();
    await engine.waitReady;
    t.after(() => engine.close());
    if (schema) {
        await engine.exec(`CREATE TABLE items(
            id text PRIMARY KEY,
            body text NOT NULL,
            amount bigint NOT NULL,
            seq integer NOT NULL DEFAULT 0,
            meta jsonb,
            created_ms bigint NOT NULL)`);
    }
    const session = createPgliteSession(engine);
    return { engine, session, db: createPostgresDatabase(session) };
}
