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
export interface ReleaseEnv {
    DB: Database;
    PUBLIC_ORIGIN?: string;
    SSO_CLIENT_ID?: string;
    PRODUCT_NAME?: string;
    PRODUCT_SUPPORT_EMAIL?: string;
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
    AUTO_ERASURE_ENABLED?: 'true' | 'false'; // Explicit operator opt-in; absent/false preserves tombstones and history.
    LIVE_ACCEPTANCE_ID?: string; // Operator change record, not an automated certification.
    fetch?: typeof fetch;
}
export interface Extension {
    publicRoute(request: Request): Promise<Response | null>;
    route(request: Request, token: string): Promise<Response | null>;
    signedIn(principal: unknown, session: {
        token: string;
    }, external: boolean): Promise<void>;
    scheduled(): Promise<void>;
}
