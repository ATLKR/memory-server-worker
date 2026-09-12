import type { RoutingDecision } from '../../routing/policy.ts';
import type { SeoulKeywordSearchResult } from '../../routing/capabilities.ts';
import type { PgOutcome } from '../connection.ts';
import type { SeoulLifecycleRepository, SeoulLifecycleResult } from './lifecycle-types.ts';

export type { SeoulKeywordSearchResult };
export type SeoulRequestOptions = Readonly<{ signal?: AbortSignal }>;
export type SeoulIngestInput = Readonly<{
  spaceId: string;
  operationId: string;
  routing: RoutingDecision;
  messages: readonly Readonly<{
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp?: string;
  }>[];
  sessionId?: string;
}>;
export type SeoulSearchInput = Readonly<{
  spaceId: string;
  routing: RoutingDecision;
  query: string;
  limit?: number;
  mode?: 'keyword';
}>;
export type SeoulArchiveReceipt = Readonly<{
  spaceId: string;
  operationId: string;
  archiveId: string;
  state: 'stored';
  extraction: 'none';
  messageCount: number;
  sourceBytes: number;
  replayed: boolean;
}>;

export interface SeoulRepository {
  /** Present only when the exact version-5 lifecycle deployment is selected. */
  readonly lifecycle?: Readonly<SeoulLifecycleRepository>;
  /** Fresh deployment and serving-privilege check; no content access. */
  probe(options?: SeoulRequestOptions): Promise<void>;
  /** Pre-body credential check, never a grant for a later content operation. */
  preauthenticatePat(tokenDigest: string, options?: SeoulRequestOptions): Promise<void>;
  ingest(tokenDigest: string, input: SeoulIngestInput, options?: SeoulRequestOptions): Promise<SeoulArchiveReceipt>;
  search(tokenDigest: string, input: SeoulSearchInput, options?: SeoulRequestOptions): Promise<SeoulKeywordSearchResult>;
  /** Call on the original result immediately before final response disclosure. */
  assertDisclosure(result: SeoulArchiveReceipt | SeoulKeywordSearchResult | SeoulLifecycleResult): void;
}

export type SeoulErrorCode =
  | 'seoul_input_invalid'
  | 'seoul_pat_denied'
  | 'seoul_space_denied'
  | 'seoul_processing_denied'
  | 'seoul_operation_conflict'
  | 'seoul_archive_erased'
  | 'seoul_revision_conflict'
  | 'seoul_quota_exceeded'
  | 'seoul_authority_expired'
  | 'seoul_response_invalid'
  | 'seoul_unavailable'
  | 'seoul_write_outcome_unknown';

/** Machine-readable and content-free. A committed/unknown write must not be retried automatically. */
export class SeoulRepositoryError extends Error {
  readonly code: SeoulErrorCode;
  readonly outcome: PgOutcome;
  constructor(code: SeoulErrorCode, outcome: PgOutcome = 'not_started') {
    super(code);
    this.name = 'SeoulRepositoryError';
    this.code = code;
    this.outcome = outcome;
  }
}
