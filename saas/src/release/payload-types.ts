import type { Database, Provenance } from './types.ts';

export interface PayloadContext { spaceId: string; memoryId: string }
export interface PayloadContent { body: string; source: string | null; provenance: Provenance }
export interface PayloadRef { id: string; shardId: string; objectKey: string; sha256: string; bytes: number }
export interface PayloadCandidate { payloadId: string; memoryId: string; score: number }
export interface PayloadPage { results: PayloadCandidate[]; nextCursor: string | null }
export type PayloadCandidatePage = PayloadPage;
export interface PayloadObject {
    size: number;
    etag: string;
    customMetadata?: Record<string, string>;
    body?: ReadableStream<Uint8Array>;
}
export interface PayloadBucket {
    head(key: string): Promise<PayloadObject | null>;
    get(key: string): Promise<PayloadObject | null>;
    put(key: string, value: string | Uint8Array, options?: {
        onlyIf?: { etagDoesNotMatch: string };
        sha256?: string;
        customMetadata?: Record<string, string>;
    }): Promise<PayloadObject | null>;
}
export interface StorageEnv {
    STORAGE_MODE?: 'inline' | 'sharded';
    STORAGE_SHARDS_JSON?: string;
    MEMORY_PAYLOADS?: PayloadBucket;
}
export interface PayloadShard { id: string; binding: string; mode: 'active' | 'draining'; db: Database }
