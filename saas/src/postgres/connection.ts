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
export interface PostgresTargetBase {
    region: PostgresRegion;
    provider: 'neon' | 'supabase';
    database: string;
    expectedRole: string;
    deploymentId: string;
    applicationSchemas: readonly string[];
    connectTimeoutMs?: number;
    queryTimeoutMs?: number;
    statementTimeoutMs?: number;
    operationTimeoutMs?: number;
    cleanupTimeoutMs?: number;
}
/** `transport` remains optional only for source compatibility with existing
 * native callers. Validation always normalizes it to the native discriminator. */
export interface NativePostgresTarget extends PostgresTargetBase {
    transport?: 'native';
    host: string;
    port: number;
    user: string;
    password: string;
    connectionMode: 'direct' | 'session-pooler' | 'transaction-pooler';
    ssl?: { rejectUnauthorized: true; ca?: string };
}
export interface HyperdriveBindingSnapshot {
    connectionString: string;
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}
export interface HyperdrivePostgresTarget extends PostgresTargetBase {
    transport: 'hyperdrive';
    provider: 'supabase';
    region: 'kr-seoul';
    hyperdrive: HyperdriveBindingSnapshot;
}
export type PostgresTarget = NativePostgresTarget | HyperdrivePostgresTarget;
export interface PgNativeDriverConfig {
    host: string; port: number; database: string; user: string; password: string;
    ssl: { rejectUnauthorized: true; servername: string; ca?: string };
    connectionTimeoutMillis: number; query_timeout: number; statement_timeout: number;
    lock_timeout: number; idle_in_transaction_session_timeout: number;
    application_name: string; options: string; client_encoding: string;
    sslnegotiation: 'postgres';
    types: { getTypeParser: typeof pgTypes.getTypeParser };
}
export type PgNativeConfig = PgNativeDriverConfig;
export interface PgHyperdriveDriverConfig {
    connectionString: string;
    connectionTimeoutMillis: number; query_timeout: number; statement_timeout: number;
    lock_timeout: number; idle_in_transaction_session_timeout: number;
    application_name: string; options: string; client_encoding: string;
    sslnegotiation: 'postgres';
    types: { getTypeParser: typeof pgTypes.getTypeParser };
}
export interface PgStartupExpectation {
    host: string; port: number; user: string; database: string;
    applicationName: 'memory-postgres-runtime';
}
export type PgClientPlan = Readonly<
    { transport: 'native'; config: Readonly<PgNativeDriverConfig>; startup: Readonly<PgStartupExpectation> }
    | { transport: 'hyperdrive'; config: Readonly<PgHyperdriveDriverConfig>; startup: Readonly<PgStartupExpectation> }
>;
type NativeCompatibilityPlan = Extract<PgClientPlan, { transport: 'native' }> & Readonly<PgNativeDriverConfig>;
export interface ConnectionOptions {
    /** Test-only injection. Native plans also expose legacy config fields at the
     * top level until existing native fixtures migrate to `plan.config`. */
    clientFactory?: ((plan: PgClientPlan | NativeCompatibilityPlan) => PgClient) | ((config: PgNativeConfig) => PgClient);
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
const encoder = new TextEncoder();
function limit(value: number | undefined, fallback: number, max: number): number {
    const n = value ?? fallback;
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw error('postgres_target_invalid');
    return n;
}
function plainData(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return typeof key === 'string' && descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function decodeUrl(value: string): string {
    try { return decodeURIComponent(value); } catch { throw error('postgres_target_invalid'); }
}
function validateTarget(input: PostgresTarget) {
    const fail = (): never => { throw error('postgres_target_invalid'); };
    if (!plainData(input)) fail();
    if (typeof input.expectedRole !== 'string' || !id.test(input.expectedRole)
        || /(^|_)(postgres|admin|owner|migrator|migration|service_role|anon|authenticated)($|_)/.test(input.expectedRole)) fail();
    if (typeof input.database !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(input.database)
        || typeof input.deploymentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(input.deploymentId)) fail();
    if (!Array.isArray(input.applicationSchemas) || !input.applicationSchemas.length || input.applicationSchemas.length > 32
        || input.applicationSchemas.some(x => typeof x !== 'string' || !id.test(x) || /^(pg_|public$|information_schema$)/.test(x))
        || new Set(input.applicationSchemas).size !== input.applicationSchemas.length) fail();
    const common = { connectTimeoutMs: limit(input.connectTimeoutMs, 5000, 30000), queryTimeoutMs: limit(input.queryTimeoutMs, 10000, 60000),
        statementTimeoutMs: limit(input.statementTimeoutMs, 9000, 60000), operationTimeoutMs: limit(input.operationTimeoutMs, 30000, 120000),
        cleanupTimeoutMs: limit(input.cleanupTimeoutMs, 2000, 5000) };
    if (input.transport === 'hyperdrive') {
        const allowed = ['transport', 'region', 'provider', 'database', 'expectedRole', 'deploymentId', 'applicationSchemas', 'hyperdrive',
            'connectTimeoutMs', 'queryTimeoutMs', 'statementTimeoutMs', 'operationTimeoutMs', 'cleanupTimeoutMs'];
        if (!plainData(input) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !allowed.includes(key))
            || input.provider !== 'supabase' || input.region !== 'kr-seoul' || !plainData(input.hyperdrive)
            || !exactKeys(input.hyperdrive, ['connectionString', 'host', 'port', 'user', 'password', 'database'])) fail();
        const binding = input.hyperdrive;
        if (typeof binding.connectionString !== 'string' || !binding.connectionString || binding.connectionString.includes('\0') || encoder.encode(binding.connectionString).length > 8192
            || typeof binding.host !== 'string' || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(binding.host)
            || typeof binding.port !== 'number' || !Number.isSafeInteger(binding.port) || binding.port < 1 || binding.port > 65535
            || typeof binding.user !== 'string' || !binding.user || binding.user.includes('\0') || encoder.encode(binding.user).length > 255
            || typeof binding.password !== 'string' || !binding.password || binding.password.includes('\0') || encoder.encode(binding.password).length > 4096
            || typeof binding.database !== 'string' || binding.database !== input.database) fail();
        let url: URL; try { url = new URL(binding.connectionString); } catch { return fail(); }
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search !== '?sslmode=disable' || url.hash || !url.port
            || url.hostname !== binding.host || Number(url.port) !== binding.port || decodeUrl(url.username) !== binding.user
            || decodeUrl(url.password) !== binding.password || url.pathname !== '/' + binding.database) fail();
        const snapshot = Object.freeze({ connectionString: binding.connectionString, host: binding.host, port: binding.port,
            user: binding.user, password: binding.password, database: binding.database });
        return Object.freeze({ transport: 'hyperdrive' as const, provider: 'supabase' as const, region: 'kr-seoul' as const,
            database: input.database, expectedRole: input.expectedRole, deploymentId: input.deploymentId,
            applicationSchemas: Object.freeze([...input.applicationSchemas]), hyperdrive: snapshot, ...common });
    }
    if (input.transport !== undefined && input.transport !== 'native') fail();
    const native = input as NativePostgresTarget;
    if (Object.hasOwn(native, 'hyperdrive') || !['direct', 'session-pooler', 'transaction-pooler'].includes(native.connectionMode)
        || typeof native.host !== 'string' || typeof native.password !== 'string' || !native.password.length || native.password.length > 4096 || native.password.includes('\0')) fail();
    const pooled = native.connectionMode !== 'direct';
    if (native.provider === 'neon' && native.region === 'sg') {
        if (!/^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ap-southeast-1\.aws\.neon\.tech$/.test(native.host)
            || /-pooler\./.test(native.host) !== pooled || native.connectionMode === 'session-pooler' || native.port !== 5432 || native.user !== native.expectedRole) fail();
    } else if (native.provider === 'supabase' && native.region === 'kr-seoul') {
        if (pooled ? !/^aws-[0-9]+-ap-northeast-2\.pooler\.supabase\.com$/.test(native.host)
            || native.port !== (native.connectionMode === 'session-pooler' ? 5432 : 6543) || !new RegExp(`^${native.expectedRole}\\.[a-z0-9]{20}$`).test(native.user)
            : !/^db\.[a-z0-9]{20}\.supabase\.co$/.test(native.host) || native.port !== 5432 || native.user !== native.expectedRole) fail();
    } else fail();
    if (native.ssl && (native.ssl.rejectUnauthorized !== true || (native.ssl.ca !== undefined && (typeof native.ssl.ca !== 'string' || !native.ssl.ca.includes('-----BEGIN CERTIFICATE-----'))))) fail();
    return Object.freeze({ ...native, transport: 'native' as const, applicationSchemas: Object.freeze([...native.applicationSchemas]),
        ssl: native.ssl ? Object.freeze({ ...native.ssl }) : undefined, ...common });
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
/** Transport-neutral adapter for the pinned pg 8.23.0 startup contract. These runtime surfaces are
 * present in pg/lib/client.js and connection-parameters.js but absent from @types.
 * Constructor options:'' falls back to PGOPTIONS, so normalize the new client's
 * parameters, never process.env or pg.defaults. Validate the real startup packet
 * fields before connect; poolers reject server GUC startup parameters. Recheck
 * this adapter and its real pg/pg-protocol tests when upgrading the driver. */
export function createPgClient(plan: PgClientPlan): PgClient {
    if (!plainData(plan) || !exactKeys(plan, ['transport', 'config', 'startup'])
        || !['native', 'hyperdrive'].includes(plan.transport) || !plainData(plan.config) || !plainData(plan.startup)
        || !exactKeys(plan.startup, ['host', 'port', 'user', 'database', 'applicationName'])) throw error('postgres_driver_contract');
    const config = plan.config;
    const commonKeys = ['connectionTimeoutMillis', 'query_timeout', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout',
        'application_name', 'options', 'client_encoding', 'types'];
    const keys = plan.transport === 'native' ? ['host', 'port', 'database', 'user', 'password', 'ssl', ...commonKeys, 'sslnegotiation']
        : ['connectionString', ...commonKeys, 'sslnegotiation'];
    if (!exactKeys(config, keys) || !plainData(config.types) || !exactKeys(config.types, ['getTypeParser'])
        || typeof config.types.getTypeParser !== 'function' || config.application_name !== 'memory-postgres-runtime'
        || config.options !== '' || config.client_encoding !== 'UTF8' || config.statement_timeout !== 0 || config.lock_timeout !== 0
        || config.idle_in_transaction_session_timeout !== 0 || !Number.isSafeInteger(config.connectionTimeoutMillis) || config.connectionTimeoutMillis < 1
        || !Number.isSafeInteger(config.query_timeout) || config.query_timeout < 1 || plan.startup.applicationName !== 'memory-postgres-runtime') throw error('postgres_driver_contract');
    if (plan.transport === 'native') {
        const nativeConfig = config as Readonly<PgNativeDriverConfig>;
        if (nativeConfig.host !== plan.startup.host || nativeConfig.port !== plan.startup.port || nativeConfig.user !== plan.startup.user
            || nativeConfig.database !== plan.startup.database || nativeConfig.sslnegotiation !== 'postgres' || !plainData(nativeConfig.ssl)
            || nativeConfig.ssl.rejectUnauthorized !== true || nativeConfig.ssl.servername !== plan.startup.host) throw error('postgres_driver_contract');
    } else {
        const hyperdriveConfig = config as Readonly<PgHyperdriveDriverConfig>;
        if (typeof hyperdriveConfig.connectionString !== 'string' || !hyperdriveConfig.connectionString
            || hyperdriveConfig.sslnegotiation !== 'postgres') throw error('postgres_driver_contract');
    }
    let client: (Client & {
        connectionParameters: Record<string, unknown>;
        getStartupConf(): Record<string, unknown>;
    }) | undefined;
    try {
        client = new Client(config) as typeof client;
        if (!client) throw error('postgres_driver_contract');
        const parameters = client.connectionParameters;
        if (!parameters || typeof client.getStartupConf !== 'function') throw error('postgres_driver_contract');
        if (parameters.host !== plan.startup.host || parameters.port !== plan.startup.port || parameters.user !== plan.startup.user
            || parameters.database !== plan.startup.database) throw error('postgres_driver_contract');
        if (plan.transport === 'hyperdrive' && (parameters.ssl !== false || parameters.sslnegotiation !== 'postgres')) throw error('postgres_driver_contract');
        for (const key of ['options', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'replication']) {
            if (Object.getOwnPropertyDescriptor(parameters, key)?.writable !== true) throw error('postgres_driver_contract');
            parameters[key] = key === 'options' ? '' : 0;
        }
        const startup = client.getStartupConf();
        if (Object.keys(startup).sort().join(',') !== 'application_name,database,user'
            || startup.user !== plan.startup.user || startup.database !== plan.startup.database
            || startup.application_name !== plan.startup.applicationName) throw error('postgres_driver_contract');
        return client as PgClient;
    } catch {
        if (client) void client.end().catch(() => {});
        throw error('postgres_driver_contract');
    }
}
/** Compatibility wrapper for native callers that still hold the old config. */
export function createNativePgClient(value: PgNativeConfig): PgClient {
    const config: Readonly<PgNativeDriverConfig> = Object.freeze({ host: value.host, port: value.port, database: value.database,
        user: value.user, password: value.password, ssl: Object.freeze({ ...value.ssl }), connectionTimeoutMillis: value.connectionTimeoutMillis,
        query_timeout: value.query_timeout, statement_timeout: value.statement_timeout, lock_timeout: value.lock_timeout,
        idle_in_transaction_session_timeout: value.idle_in_transaction_session_timeout, application_name: value.application_name,
        options: value.options, client_encoding: value.client_encoding, sslnegotiation: value.sslnegotiation, types: Object.freeze({ ...value.types }) });
    const startup: Readonly<PgStartupExpectation> = Object.freeze({ host: config.host, port: config.port, user: config.user,
        database: config.database, applicationName: 'memory-postgres-runtime' });
    return createPgClient(Object.freeze({ transport: 'native', config, startup }));
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

type NormalizedPostgresTarget = ReturnType<typeof validateTarget>;
function parserMap(): Readonly<{ getTypeParser: typeof pgTypes.getTypeParser }> {
    return Object.freeze({ getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
        if ([20, 1700, 1016, 1231].includes(oid) && format !== 'binary') return (text: string) => text;
        return pgTypes.getTypeParser(oid, format);
    }) as typeof pgTypes.getTypeParser });
}
function clientPlan(target: NormalizedPostgresTarget, duration: number): PgClientPlan {
    const common = { connectionTimeoutMillis: Math.min(target.connectTimeoutMs, duration), query_timeout: target.queryTimeoutMs,
        statement_timeout: 0, lock_timeout: 0, idle_in_transaction_session_timeout: 0,
        application_name: 'memory-postgres-runtime', options: '', client_encoding: 'UTF8', types: parserMap() } as const;
    if (target.transport === 'hyperdrive') {
        const config: Readonly<PgHyperdriveDriverConfig> = Object.freeze({ connectionString: target.hyperdrive.connectionString, ...common,
            sslnegotiation: 'postgres' });
        const startup: Readonly<PgStartupExpectation> = Object.freeze({ host: target.hyperdrive.host, port: target.hyperdrive.port,
            user: target.hyperdrive.user, database: target.hyperdrive.database, applicationName: 'memory-postgres-runtime' });
        return Object.freeze({ transport: 'hyperdrive', config, startup });
    }
    const config: Readonly<PgNativeDriverConfig> = Object.freeze({ host: target.host, port: target.port, database: target.database,
        user: target.user, password: target.password,
        ssl: Object.freeze({ rejectUnauthorized: true, servername: target.host, ...(target.ssl?.ca ? { ca: target.ssl.ca } : {}) }),
        ...common, sslnegotiation: 'postgres' });
    const startup: Readonly<PgStartupExpectation> = Object.freeze({ host: target.host, port: target.port, user: target.user,
        database: target.database, applicationName: 'memory-postgres-runtime' });
    return Object.freeze({ transport: 'native', config, startup });
}

/** One client and real transaction per operation, including withConnection and attestation.
 * Application SQL must qualify private schemas. No retries, ambient targets or session pool state.
 * A dispatched COMMIT cannot be recalled: cancellation after dispatch returns an unknown outcome. */
export function createPostgresConnection(input: PostgresTarget, options: ConnectionOptions) {
    const target = validateTarget(input);
    if (!options || typeof options.verifyDeployment !== 'function') throw error('postgres_target_invalid');
    const verify = options.verifyDeployment;
    const factory = options.clientFactory;
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
            const plan = clientPlan(target, duration);
            const supplied = plan.transport === 'native' ? Object.freeze({ ...plan.config, ...plan }) as NativeCompatibilityPlan : plan;
            client = factory ? (factory as (value: typeof supplied) => PgClient)(supplied) : createPgClient(plan);
            client.on('error', () => stop('postgres_connection_failed'));
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
