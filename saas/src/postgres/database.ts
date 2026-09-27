import { PostgresBoundaryError, type PgSession, type PgValue } from './connection.ts';
import type { Database, Result, Statement, Value } from '../release/types.ts';

/** `Database` (`src/release/types.ts`) over a PostgreSQL session.
 *
 * Placeholders: source SQL keeps the existing `?` style; each `?` outside
 * literals, quoted identifiers, comments and dollar-quoted bodies becomes
 * `$1…$n` in bind order. The PostgreSQL jsonb operators `?`, `?|` and `?&`
 * are unreachable through this adapter — write `jsonb_exists`,
 * `jsonb_exists_any` and `jsonb_exists_all` instead.
 *
 * `batch` is one transaction on the session: statements run in order, the
 * first failure rolls back everything, and a failed COMMIT reports
 * `outcome: 'unknown'`. Callers must not share a session between concurrent
 * batches — the session is the serialization boundary, matching the
 * one-client-per-operation repository contract.
 *
 * `withSession('first-primary')` is a pass-through: PostgreSQL reads and
 * writes already reach one primary connection.
 *
 * int8/numeric results stay exact strings at the driver layer; this adapter
 * decodes `bigint` values to safe integers (the ported schema's integer
 * columns are all ms-epoch/smallint-sized). Text columns are never coerced.
 */

const fail = (code: string, outcome: 'not_started' | 'rolled_back' | 'committed' | 'unknown' = 'not_started',
    sqlState?: string, cause?: unknown): PostgresBoundaryError => {
    const e = new PostgresBoundaryError(code, outcome, sqlState);
    if (cause !== undefined) (e as { cause?: unknown }).cause = cause;
    return e;
};

/** Translates `?` placeholders to `$n`, skipping quoted spans. */
export function translatePlaceholders(sql: string): string {
    if (typeof sql !== 'string' || sql.includes('\0')) throw fail('postgres_sql_invalid');
    let out = '';
    let n = 0;
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (c === "'") {
            // Single-quoted literal; '' escapes.
            let j = i + 1;
            while (j < sql.length && (sql[j] !== "'" || sql[j + 1] === "'")) j += sql[j] === "'" ? 2 : 1;
            if (j >= sql.length) throw fail('postgres_sql_invalid');
            out += sql.slice(i, j + 1);
            i = j + 1;
        } else if (c === '"') {
            let j = i + 1;
            while (j < sql.length && (sql[j] !== '"' || sql[j + 1] === '"')) j += sql[j] === '"' ? 2 : 1;
            if (j >= sql.length) throw fail('postgres_sql_invalid');
            out += sql.slice(i, j + 1);
            i = j + 1;
        } else if (c === '-' && sql[i + 1] === '-') {
            const j = sql.indexOf('\n', i);
            if (j === -1) { out += sql.slice(i); break; }
            out += sql.slice(i, j + 1);
            i = j + 1;
        } else if (c === '/' && sql[i + 1] === '*') {
            const j = sql.indexOf('*/', i + 2);
            if (j === -1) throw fail('postgres_sql_invalid');
            out += sql.slice(i, j + 2);
            i = j + 2;
        } else if (c === '$') {
            // Dollar-quoted body ($$…$$ or $tag$…$tag$); a bare $n is not a tag.
            const m = /^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/.exec(sql.slice(i));
            if (m) {
                const tag = m[0];
                const j = sql.indexOf(tag, i + tag.length);
                if (j === -1) throw fail('postgres_sql_invalid');
                out += sql.slice(i, j + tag.length);
                i = j + tag.length;
            } else {
                out += c;
                i += 1;
            }
        } else if (c === '?') {
            // The jsonb existence operators would silently corrupt under
            // placeholder rewriting — reject them; callers must write the
            // jsonb_exists*/jsonb_exists_any/jsonb_exists_all functions.
            if (sql[i + 1] === '|' || sql[i + 1] === '&') throw fail('postgres_sql_invalid');
            n += 1;
            out += '$' + n;
            i += 1;
        } else {
            out += c;
            i += 1;
        }
    }
    return out;
}

function decodeValue(value: unknown): unknown {
    if (typeof value === 'bigint') {
        if (value > 9007199254740991n || value < -9007199254740991n) throw fail('postgres_numeric_unsafe');
        return Number(value);
    }
    if (Array.isArray(value)) return value.map(decodeValue);
    if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof Date)) {
        const row: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) row[k] = decodeValue(v);
        return row;
    }
    return value;
}

function bindValue(value: Value): PgValue {
    if (value === null || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw fail('postgres_bind_invalid');
}

class PostgresStatement implements Statement {
    private params: PgValue[] = [];
    private done = false;
    readonly db: PostgresDatabase;
    readonly sql: string;
    constructor(db: PostgresDatabase, sql: string) {
        this.db = db;
        this.sql = sql;
    }
    bind(...values: Value[]): Statement {
        if (this.done) throw fail('postgres_statement_consumed');
        this.params.push(...values.map(bindValue));
        return this;
    }
    private async execute<T>(take: 'first' | 'all' | 'run'): Promise<T | null | Result<T>> {
        if (this.done) throw fail('postgres_statement_consumed');
        this.done = true;
        return this.db.execute(this.sql, this.params, take) as Promise<T | null | Result<T>>;
    }
    async first<T = Record<string, unknown>>(): Promise<T | null> {
        return this.execute<T>('first') as Promise<T | null>;
    }
    async all<T = Record<string, unknown>>(): Promise<Result<T>> {
        return this.execute<T>('all') as Promise<Result<T>>;
    }
    async run(): Promise<Result> {
        return this.execute('run') as Promise<Result>;
    }
}

class PostgresDatabase implements Database {
    readonly session: PgSession;
    private batchSeq = 0;
    constructor(session: PgSession) {
        this.session = session;
    }
    prepare(sql: string): Statement {
        return new PostgresStatement(this, sql);
    }
    async execute(sql: string, params: readonly PgValue[], take: 'first' | 'all' | 'run'): Promise<unknown> {
        const text = translatePlaceholders(sql);
        let result;
        try {
            result = await this.session.query(text, params);
        } catch (e) {
            if (e instanceof PostgresBoundaryError) throw e;
            const state = e && typeof e === 'object' && 'code' in e ? String(e.code) : undefined;
            throw fail('postgres_operation_failed', 'not_started', state, e);
        }
        if (!result || !Array.isArray(result.rows)
            || (result.rowCount !== null && (typeof result.rowCount !== 'number' || !Number.isSafeInteger(result.rowCount) || result.rowCount < 0)))
            throw fail('postgres_result_invalid');
        const rows = result.rows.map(row => decodeValue(row)) as Record<string, unknown>[];
        if (take === 'first') return rows[0] ?? null;
        return { success: true, results: take === 'all' ? rows : [], meta: { changes: result.rowCount ?? 0 } };
    }
    async batch<T = Record<string, unknown>>(statements: Statement[]): Promise<Result<T>[]> {
        if (!Array.isArray(statements) || statements.some(s => !(s instanceof PostgresStatement) || s.db !== this))
            throw fail('postgres_batch_invalid');
        if (!statements.length) return [];
        for (const s of statements as PostgresStatement[]) {
            if (s['done']) throw fail('postgres_statement_consumed');
        }
        // Inside a guarded operation the session already runs one transaction:
        // the batch's atomicity is a savepoint, never nested BEGIN/COMMIT.
        // Unguarded sessions (fixtures) still open their own transaction.
        // Savepoint names are per-batch: the session serializes statements from
        // concurrent callers, and a shared name would let a sibling batch's
        // savepoint shadow this one's ROLLBACK TO target.
        const ambient = this.session.inTransaction === true;
        const savepoint = `memory_batch_${++this.batchSeq}`;
        await this.execute(ambient ? `SAVEPOINT ${savepoint}` : 'BEGIN', [], 'run');
        const out: Result<T>[] = [];
        try {
            for (const s of statements as PostgresStatement[]) {
                s['done'] = true;
                out.push(await this.execute(s.sql, s['params'], 'all') as Result<T>);
            }
        } catch (e) {
            try { await this.session.query(ambient ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK'); } catch { /* original error wins */ }
            if (e instanceof PostgresBoundaryError) {
                if (e.outcome === 'not_started') e.outcome = 'rolled_back';
                throw e;
            }
            const state = e && typeof e === 'object' && 'code' in e ? String(e.code) : undefined;
            throw fail('postgres_operation_failed', 'rolled_back', state, e);
        }
        try {
            await this.session.query(ambient ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
        } catch (e) {
            const state = e && typeof e === 'object' && 'code' in e ? String(e.code) : undefined;
            throw fail('postgres_operation_failed', ambient ? 'rolled_back' : 'unknown', state, e);
        }
        return out;
    }
    withSession(constraint: 'first-primary'): { prepare(sql: string): Statement } {
        if (constraint !== 'first-primary') throw fail('postgres_session_invalid');
        return { prepare: (sql: string) => this.prepare(sql) };
    }
}

export function createPostgresDatabase(session: PgSession): Database {
    if (!session || typeof session.query !== 'function') throw fail('postgres_session_invalid');
    return new PostgresDatabase(session);
}
