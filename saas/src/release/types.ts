import type { StorageEnv } from './payload-types.ts';
/** Small structural interfaces; production uses native Workers bindings. */
export type Value = string | number | null;
export interface Result<T = Record<string, unknown>> {
    success: boolean;
    results: T[];
    meta: {
        changes?: number;
    };
}
export interface Statement {
    bind(...values: Value[]): Statement;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<Result<T>>;
    run(): Promise<Result>;
}
export interface Database {
    prepare(sql: string): Statement;
    batch<T = Record<string, unknown>>(statements: Statement[]): Promise<Result<T>[]>;
    withSession(constraint: 'first-primary'): {
        prepare(sql: string): Statement;
    };
}
export type Capability = 'read' | 'create' | 'update' | 'delete' | 'export';
export interface Actor {
    id: string;
    accountId: string;
    kind: string;
    reauthenticatedAt: number | null;
}
export interface Provenance {
    originKind: 'user' | 'agent' | 'import';
    sourceEventId?: string;
    sourceMessageIds?: string[];
    extractorVersion?: string;
}
export interface Memory {
    id: string;
    spaceId: string;
    body: string;
    source: string | null;
    revision: number;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
    eventTime: number | null;
    kind: string;
    provenance: Provenance;
    supersedesMemoryId: string | null;
    erasedAt: number | null;
    /** Present on trash reads; retention facts do not imply update authority. */
    restoreUntil?: number | null;
    restoreExpired?: boolean;
}
export interface Vector {
    id: string;
    values: number[];
    namespace?: string;
    metadata?: Record<string, string | number | boolean>;
}
export interface VectorIndex {
    query(values: number[], options: {
        namespace: string;
        topK: number;
        returnMetadata: 'all';
    }): Promise<{
        matches: {
            id: string;
            score: number;
            metadata?: Record<string, unknown>;
        }[];
    }>;
    upsert(vectors: Vector[]): Promise<unknown>;
    deleteByIds(ids: string[]): Promise<unknown>;
    getByIds(ids: string[]): Promise<{
        id: string;
    }[]>;
}
export interface AI {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
export interface ReleaseEnv extends StorageEnv {
    DB: Database;
    MEMORY_SQL_BACKEND?: 'd1' | 'durable';
    /** HTTP/cron quiescence gate; SQL fences and in-flight draining are still
     * required before a migration snapshot can be considered frozen. */
    MEMORY_SQL_MAINTENANCE?: 'true' | 'false';
    MEMORY_SQL_DEPLOYMENT_ID?: string;
    MEMORY_SQL_EPOCH?: string;
    MEMORY_SQL_DATABASES_JSON?: string;
    MEMORY_SQL?: { getByName(name: string): import('../durable-sql/types.ts').DurableSqlStub };
    /** Transitional consent runtime: identity authority still uses DB. */
    MEMORY_CONSENT_LEDGER?: import('../routing/ledger-types.ts').RoutingLedger;
    MEMORY_ROUTING_ENABLED?: 'true' | 'false';
    MEMORY_GENERAL_ROUTING_ENABLED?: 'true' | 'false';
    MEMORY_AGENT_MEMORY_SPACES?: import('../routing/general-types.ts').GeneralSpaceNamespace;
    MEMORY_AGENT_MEMORY_BUDGET?: import('../routing/general-types.ts').RoutingBudgetNamespace;
    MEMORY_ROUTING_GENERAL_SPACES_JSON?: string;
    MEMORY_ROUTING_BUDGET_ID?: string;
    MEMORY_ROUTING_BUDGET_POLICY_JSON?: string;
    MEMORY_AGENT_MEMORY_ACCOUNT_ID?: string;
    MEMORY_AGENT_MEMORY_NAMESPACE?: string;
    MEMORY_AGENT_MEMORY_TOKEN?: string;
    /** Explicit operator admission while the complete regional runtime is pending. */
    MEMORY_ROUTING_MEDICAL_SPACES_JSON?: string;
    MEMORY_ROUTING_SEOUL_SPACES_JSON?: string;
    PUBLIC_ORIGIN?: string;
    SSO_CLIENT_ID?: string;
    PRODUCT_NAME?: string;
    PRODUCT_SUPPORT_EMAIL?: string;
    ENROLLMENT_MODE?: 'open' | 'invite';
    ENROLLMENT_EMAIL_HASHES_JSON?: string; // Operator-managed signup roster; store as a secret.
    AI_MONTHLY_BUDGET_MICROUSD?: string; // Conservative provider reservation, separate from user usage units.
    STORAGE_BACKFILL_ENABLED?: 'true' | 'false';
    GA_PROFILE?: string;
    DEPLOYMENT_ENVIRONMENT?: string;
    SOURCE_REVISION?: string;
    PAID_BILLING_ENABLED?: 'true' | 'false';
    LIVE_ACCEPTANCE_PUBLIC_KEY?: string;
    LIVE_ACCEPTANCE_JWS?: string;
    REQUEST_LIMITER: {
        limit(input: {
            key: string;
        }): Promise<{
            success: boolean;
        }>;
    };
    AI?: AI;
    MEMORY_INDEX?: VectorIndex;
    METRICS?: {
        writeDataPoint(point: {
            indexes: string[];
            blobs: string[];
            doubles: number[];
        }): void;
    };
    PAYLOAD_KEY?: string; // Base64url, exactly 32 random bytes; never returned by an API.
    EMAIL?: {
        send(message: { from: string; to: string; subject: string; text: string }): Promise<{ messageId: string }>;
    };
    MAIL_FROM?: string;
    IDENTITY_WEBHOOK_SECRET?: string;
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    STRIPE_API_VERSION?: string;
    BILLING_PRICES_JSON?: string;
    RELEASE_MODE?: 'pilot' | 'ga';
    BACKGROUND_JOBS_ENABLED?: 'true' | 'false'; // Provider processing is separately enabled from transient cleanup.
    AUTO_ERASURE_ENABLED?: 'true' | 'false'; // Explicit operator opt-in; absent/false preserves tombstones and history.
    LIVE_ACCEPTANCE_ID?: string; // Operator change record, not an automated certification.
    fetch?: typeof fetch;
}
/** Raw deployment bindings. resolveReleaseEnv supplies the mandatory internal
 * Database in durable mode even when the Worker has no D1 binding. */
export type WorkerEnv = Omit<ReleaseEnv, 'DB'> & { DB?: Database };
export interface Extension {
    identityLifecycle?: 2;
    beforeSignIn?(principal: unknown): Promise<void>;
    workspaceSpaceAccess?: import('../workspace.ts').WorkspaceSpaceAccess;
    publicRoute(request: Request): Promise<Response | null>;
    route(request: Request, token: string): Promise<Response | null>;
    signedIn(principal: unknown, session: {
        token: string;
    }, external: boolean): Promise<void>;
    scheduled(): Promise<void>;
}
