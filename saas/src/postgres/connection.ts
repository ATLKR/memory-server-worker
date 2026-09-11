import { Client, types as pgTypes } from 'pg';

export type PostgresRegion = 'sg' | 'kr-seoul';
export type PgValue = string | number | boolean | bigint | Uint8Array | null;
export interface PgResult<Row = Record<string, unknown>> { rows: Row[]; rowCount: number | null }
export interface PgSession { query<Row = Record<string, unknown>>(text: string, values?: readonly PgValue[]): Promise<PgResult<Row>> }
export interface PgQueryConfig { text: string; values: unknown[]; queryMode: 'extended'; query_timeout: number }
export interface PgClient {
    connect(): Promise<unknown>;
    query(config: PgQueryConfig): Promise<PgResult>;
    end(): Promise<unknown>;
    on(event: 'error', listener: (error: unknown) => void): unknown;
}
export interface PostgresTarget {
    region: PostgresRegion;
    provider: 'neon' | 'supabase';
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    expectedRole: string;
    deploymentId: string;
    applicationSchemas: readonly string[];
    connectionMode: 'direct' | 'session-pooler' | 'transaction-pooler';
    ssl?: { rejectUnauthorized: true; ca?: string };
    connectTimeoutMs?: number;
    queryTimeoutMs?: number;
    statementTimeoutMs?: number;
    operationTimeoutMs?: number;
    cleanupTimeoutMs?: number;
}
export interface PgNativeConfig {
    host: string; port: number; database: string; user: string; password: string;
    ssl: { rejectUnauthorized: true; servername: string; ca?: string };
    connectionTimeoutMillis: number; query_timeout: number; statement_timeout: number;
    lock_timeout: number; idle_in_transaction_session_timeout: number;
    application_name: string; options: string; client_encoding: string;
    sslnegotiation: 'postgres';
    types: { getTypeParser: typeof pgTypes.getTypeParser };
}
export interface ConnectionOptions {
    clientFactory?: (config: PgNativeConfig) => PgClient;
    /** Must read immutable deployment metadata through this connection. No provider/vault calls. */
    verifyDeployment: (session: PgSession) => Promise<{ region: PostgresRegion; deploymentId: string }>;
}
export interface OperationOptions { signal?: AbortSignal; timeoutMs?: number }
export type PgOutcome = 'not_started' | 'rolled_back' | 'committed' | 'unknown';
export class PostgresBoundaryError extends Error {
    readonly code: string;
    outcome: PgOutcome;
    readonly sqlState?: string;
    constructor(code: string, outcome: PgOutcome = 'not_started', sqlState?: string) {
        super(code); this.name = 'PostgresBoundaryError'; this.code = code; this.outcome = outcome;
        if (sqlState && /^[0-9A-Z]{5}$/.test(sqlState)) this.sqlState = sqlState;
    }
}
const error = (code: string) => new PostgresBoundaryError(code);
const id = /^[a-z][a-z0-9_]{0,62}$/;
function limit(value: number | undefined, fallback: number, max: number): number {
    const n = value ?? fallback;
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw error('postgres_target_invalid');
    return n;
}
function validateTarget(input: PostgresTarget) {
    const fail = () => { throw error('postgres_target_invalid'); };
    if (!input || !['direct', 'session-pooler', 'transaction-pooler'].includes(input.connectionMode)) fail();
    if (typeof input.host !== 'string' || typeof input.expectedRole !== 'string' || !id.test(input.expectedRole)
        || /(^|_)(postgres|admin|owner|migrator|migration|service_role|anon|authenticated)($|_)/.test(input.expectedRole)) fail();
    if (typeof input.database !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(input.database)
        || typeof input.password !== 'string' || !input.password.length || input.password.length > 4096 || input.password.includes('\0')
        || typeof input.deploymentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(input.deploymentId)) fail();
    if (!Array.isArray(input.applicationSchemas) || !input.applicationSchemas.length || input.applicationSchemas.length > 32
        || input.applicationSchemas.some(x => typeof x !== 'string' || !id.test(x) || /^(pg_|public$|information_schema$)/.test(x))
        || new Set(input.applicationSchemas).size !== input.applicationSchemas.length) fail();
    const pooled = input.connectionMode !== 'direct';
    if (input.provider === 'neon' && input.region === 'sg') {
        if (!/^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ap-southeast-1\.aws\.neon\.tech$/.test(input.host)
            || /-pooler\./.test(input.host) !== pooled || input.connectionMode === 'session-pooler' || input.port !== 5432 || input.user !== input.expectedRole) fail();
    } else if (input.provider === 'supabase' && input.region === 'kr-seoul') {
        if (pooled ? !/^aws-[0-9]+-ap-northeast-2\.pooler\.supabase\.com$/.test(input.host)
            || input.port !== (input.connectionMode === 'session-pooler' ? 5432 : 6543) || !new RegExp(`^${input.expectedRole}\\.[a-z0-9]{20}$`).test(input.user)
            : !/^db\.[a-z0-9]{20}\.supabase\.co$/.test(input.host) || input.port !== 5432 || input.user !== input.expectedRole) fail();
    } else fail();
    if (input.ssl && (input.ssl.rejectUnauthorized !== true || (input.ssl.ca !== undefined && (typeof input.ssl.ca !== 'string' || !input.ssl.ca.includes('-----BEGIN CERTIFICATE-----'))))) fail();
    return Object.freeze({ ...input, applicationSchemas: Object.freeze([...input.applicationSchemas]), ssl: input.ssl ? Object.freeze({ ...input.ssl }) : undefined,
        connectTimeoutMs: limit(input.connectTimeoutMs, 5000, 30000), queryTimeoutMs: limit(input.queryTimeoutMs, 10000, 60000),
        statementTimeoutMs: limit(input.statementTimeoutMs, 9000, 60000), operationTimeoutMs: limit(input.operationTimeoutMs, 30000, 120000),
        cleanupTimeoutMs: limit(input.cleanupTimeoutMs, 2000, 5000) });
}
/** Bigint/numeric values remain exact strings until a consumer explicitly requests safe integers. */
export function asSafeInteger(value: unknown): number {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value))) throw error('postgres_numeric_unsafe');
    const n = Number(value); if (!Number.isSafeInteger(n)) throw error('postgres_numeric_unsafe'); return n;
}
function numericSafety(value: unknown): void {
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw error('postgres_numeric_unsafe');
    if (Array.isArray(value)) value.forEach(numericSafety);
    else if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof Date)) Object.values(value).forEach(numericSafety);
}
function result<Row>(value: PgResult): PgResult<Row> {
    if (!value || !Array.isArray(value.rows) || (value.rowCount !== null && (typeof value.rowCount !== 'number' || !Number.isSafeInteger(value.rowCount) || value.rowCount < 0))) throw error('postgres_result_invalid');
    numericSafety(value.rows); return value as PgResult<Row>;
}
function sanitized(value: unknown, code = 'postgres_operation_failed'): PostgresBoundaryError {
    if (value instanceof PostgresBoundaryError) return value;
    const state = value && typeof value === 'object' && 'code' in value ? value.code : undefined;
    return new PostgresBoundaryError(code, 'not_started', typeof state === 'string' ? state : undefined);
}
/** Adapter for the pinned pg 8.23.0 startup contract. These runtime surfaces are
 * present in pg/lib/client.js and connection-parameters.js but absent from @types.
 * Constructor options:'' falls back to PGOPTIONS, so normalize the new client's
 * parameters, never process.env or pg.defaults. Validate the real startup packet
 * fields before connect; poolers reject server GUC startup parameters. Recheck
 * this adapter and its real pg/pg-protocol tests when upgrading the driver. */
export function createNativePgClient(config: PgNativeConfig): PgClient {
    const client = new Client(config) as Client & {
        connectionParameters: Record<string, unknown>;
        getStartupConf(): Record<string, unknown>;
    };
    try {
        const parameters = client.connectionParameters;
        if (!parameters || typeof client.getStartupConf !== 'function') throw error('postgres_driver_contract');
        for (const key of ['options', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'replication']) {
            if (Object.getOwnPropertyDescriptor(parameters, key)?.writable !== true) throw error('postgres_driver_contract');
            parameters[key] = key === 'options' ? '' : 0;
        }
        const startup = client.getStartupConf();
        if (Object.keys(startup).sort().join(',') !== 'application_name,database,user'
            || startup.user !== config.user || startup.database !== config.database || startup.application_name !== config.application_name) throw error('postgres_driver_contract');
        return client as PgClient;
    } catch {
        void client.end().catch(() => {});
        throw error('postgres_driver_contract');
    }
}
const ROLE_SQL = `SELECT current_user AS role, session_user AS "sessionRole", pg_catalog.current_database() AS database,
 r.rolsuper AS superuser, r.rolcreaterole AS "createRole", r.rolcreatedb AS "createDatabase", r.rolbypassrls AS "bypassRls", r.rolreplication AS replication,
 EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database() AND pg_catalog.pg_has_role(current_user,d.datdba,'MEMBER')) AS "databaseOwner",
 EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname=ANY($1::text[]) AND
   (pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE') OR pg_catalog.pg_has_role(current_user,n.nspowner,'MEMBER') OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid AND pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER')))) AS "schemaOwner",
 EXISTS(SELECT 1 FROM pg_catalog.pg_roles inherited WHERE pg_catalog.pg_has_role(current_user,inherited.oid,'MEMBER') AND
   (inherited.rolsuper OR inherited.rolcreaterole OR inherited.rolcreatedb OR inherited.rolbypassrls OR inherited.rolreplication OR
    inherited.rolname IN ('pg_read_all_data','pg_write_all_data','pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_signal_backend','pg_database_owner'))) AS "dangerousMembership"
 FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;

/** One client and real transaction per operation, including withConnection and attestation.
 * Application SQL must qualify private schemas. No retries, ambient targets or session pool state.
 * A dispatched COMMIT cannot be recalled: cancellation after dispatch returns an unknown outcome. */
export function createPostgresConnection(input: PostgresTarget, options: ConnectionOptions) {
    const target = validateTarget(input);
    if (!options || typeof options.verifyDeployment !== 'function') throw error('postgres_target_invalid');
    const verify = options.verifyDeployment;
    const factory = options.clientFactory ?? createNativePgClient;
    async function operation<T>(callback: (session: PgSession) => Promise<T> | T, request: OperationOptions = {}): Promise<T> {
        const duration = request.timeoutMs === undefined ? target.operationTimeoutMs : Math.min(target.operationTimeoutMs, limit(request.timeoutMs, target.operationTimeoutMs, 120000));
        const deadline = performance.now() + duration, cancellation = new AbortController();
        let client: PgClient | undefined, active = true, busy = false, closing = false, began = false, commitSent = false, transactionFailed = false;
        let failure: PostgresBoundaryError | undefined, outcome: PgOutcome = 'not_started';
        const stop = (code: string) => { failure ??= error(code); active = false; cancellation.abort(); };
        const externalAbort = () => stop('postgres_aborted');
        request.signal?.addEventListener('abort', externalAbort, { once: true });
        if (request.signal?.aborted) externalAbort();
        function check() {
            if (failure) throw failure;
            if (!active) throw error('postgres_connection_closed');
            if (performance.now() >= deadline) { stop('postgres_deadline'); throw failure!; }
        }
        async function bounded<R>(work: () => Promise<R> | R, ms: number): Promise<R> {
            check();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let abort: (() => void) | undefined;
            const interrupted = new Promise<never>((_resolve, reject) => {
                abort = () => reject(failure ?? error('postgres_aborted'));
                cancellation.signal.addEventListener('abort', abort, { once: true });
                timer = setTimeout(() => stop('postgres_deadline'), Math.max(1, Math.min(ms, deadline - performance.now())));
            });
            try { const value = await Promise.race([Promise.resolve().then(() => { check(); return work(); }), interrupted]); check(); return value; }
            finally { clearTimeout(timer); if (abort) cancellation.signal.removeEventListener('abort', abort); }
        }
        async function native(text: string, values: unknown[] = []): Promise<PgResult> {
            return bounded(() => client!.query({ text, values, queryMode: 'extended', query_timeout: Math.max(1, Math.ceil(Math.min(target.queryTimeoutMs, deadline - performance.now()))) }), target.queryTimeoutMs);
        }
        const session: PgSession = Object.freeze({ async query<Row>(text: string, values: readonly PgValue[] = []): Promise<PgResult<Row>> {
            if (!active) throw error('postgres_connection_closed'); check();
            if (transactionFailed) throw error('postgres_transaction_failed');
            // Extended protocol rejects multiple statements; callbacks cannot issue transaction control.
            if (typeof text !== 'string' || !/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|VALUES)\b/i.test(text)) throw error('postgres_transaction_control_denied');
            if (busy) throw error('postgres_concurrent_query');
            if (!Array.isArray(values) || values.some(x => x !== null && !['string', 'number', 'boolean', 'bigint'].includes(typeof x) && !(x instanceof Uint8Array))) throw error('postgres_parameter_invalid');
            numericSafety(values); busy = true;
            try {
                const statementMs = Math.max(1, Math.floor(Math.min(target.statementTimeoutMs, deadline - performance.now())));
                await native("SELECT pg_catalog.set_config('statement_timeout',$1,$2), pg_catalog.set_config('lock_timeout',$1,$2)", [String(statementMs), true]);
                check(); outcome = 'unknown'; return result<Row>(await native(text, [...values]));
            } catch (e) {
                if (began) transactionFailed = true;
                const safe = sanitized(e, 'postgres_query_failed'); safe.outcome = outcome; throw safe;
            }
            finally { busy = false; }
        }});
        try {
            check();
            const config: PgNativeConfig = { host: target.host, port: target.port, database: target.database, user: target.user, password: target.password,
                ssl: { rejectUnauthorized: true, servername: target.host, ...(target.ssl?.ca ? { ca: target.ssl.ca } : {}) },
                connectionTimeoutMillis: Math.min(target.connectTimeoutMs, duration), query_timeout: target.queryTimeoutMs,
                statement_timeout: 0, lock_timeout: 0, idle_in_transaction_session_timeout: 0,
                application_name: 'memory-postgres-runtime', options: '', client_encoding: 'UTF8', sslnegotiation: 'postgres',
                types: { getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
                    if ([20, 1700, 1016, 1231].includes(oid) && format !== 'binary') return (text: string) => text;
                    return pgTypes.getTypeParser(oid, format);
                }) as typeof pgTypes.getTypeParser } };
            client = factory(config); client.on('error', () => stop('postgres_connection_failed'));
            await bounded(() => {
                const connection = client!.connect();
                // end() can happen before an injected/transport connect resolves. Close that late socket too.
                void connection.then(() => { if (closing) void client!.end().catch(() => {}); }, () => {});
                return connection;
            }, target.connectTimeoutMs);
            await native('BEGIN'); began = true;
            await native("SELECT pg_catalog.set_config('statement_timeout',$1,$2), pg_catalog.set_config('lock_timeout',$1,$2), pg_catalog.set_config('search_path','pg_catalog',$2), pg_catalog.set_config('idle_in_transaction_session_timeout',$3,$2)",
                [String(Math.max(1, Math.floor(Math.min(target.statementTimeoutMs, deadline - performance.now())))), true, String(Math.max(1, Math.floor(deadline - performance.now())))]);
            const identity = result<Record<string, unknown>>(await native(ROLE_SQL, [[...target.applicationSchemas]])).rows;
            const r = identity[0];
            if (identity.length !== 1 || !r || r.role !== target.expectedRole || r.sessionRole !== target.expectedRole || r.database !== target.database
                || ['superuser', 'createRole', 'createDatabase', 'bypassRls', 'replication', 'databaseOwner', 'schemaOwner', 'dangerousMembership'].some(key => r[key] !== false)) throw error('postgres_role_denied');
            const metadata = await bounded(() => verify(session), target.queryTimeoutMs);
            if (!metadata || metadata.region !== target.region || metadata.deploymentId !== target.deploymentId) throw error('postgres_deployment_mismatch');
            if (busy) throw error('postgres_pending_query');
            const value = await bounded(() => callback(session), duration);
            if (busy) { stop('postgres_pending_query'); throw failure!; }
            if (transactionFailed) throw error('postgres_transaction_failed');
            check();
            commitSent = true;
            try { await native('COMMIT'); outcome = 'committed'; }
            catch { throw new PostgresBoundaryError('postgres_commit_unknown', 'unknown'); }
            return value;
        } catch (e) {
            const safe = sanitized(e);
            if (began && !commitSent && !failure && !busy) {
                try { await native('ROLLBACK'); outcome = 'rolled_back'; }
                catch { outcome = 'unknown'; }
            }
            safe.outcome = commitSent ? 'unknown' : outcome;
            throw safe;
        } finally {
            active = false; closing = true;
            request.signal?.removeEventListener('abort', externalAbort);
            if (client) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([Promise.resolve().then(() => client!.end()), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error('postgres_cleanup_failed')), target.cleanupTimeoutMs); })]);
                } catch { throw new PostgresBoundaryError('postgres_cleanup_failed', commitSent ? outcome : outcome === 'rolled_back' ? 'rolled_back' : 'unknown'); }
                finally { clearTimeout(timer); }
            }
        }
    }
    return Object.freeze({
        withConnection: <T>(callback: (session: PgSession) => Promise<T> | T, request?: OperationOptions) => operation(callback, request),
        transaction: <T>(callback: (session: PgSession) => Promise<T> | T, request?: OperationOptions) => operation(callback, request),
    });
}
