import type { SeoulRequestOptions } from './types.ts';

export type SeoulEraseInput = Readonly<{ spaceId: string; archiveId: string; expectedRevision: 1 | 2; operationId: string }>;
export type SeoulRetireInput = Readonly<{ spaceId: string; operationId: string }>;
export type SeoulRevokeSelfInput = Readonly<{ operationId: string }>;
export type SeoulLifecycleStatusInput = Readonly<
  { kind: 'archive'; spaceId: string; archiveId: string } | { kind: 'operation'; spaceId: string; operationId: string }
>;
export type SeoulEraseReceipt = Readonly<{
  spaceId: string; archiveId: string; operationId: string; revision: 2; state: 'primary_erased'; replayed: boolean;
  primaryRowsRemoved: true; removedMessages: number; removedSourceBytes: number; restoreAllowed: false;
  backupCleanup: 'not_confirmed'; physicalMediaCleanup: 'not_confirmed';
}>;
export type SeoulRetireReceipt = Readonly<{ spaceId: string; operationId: string; state: 'retired'; replayed: false }>;
export type SeoulRevokeSelfReceipt = Readonly<{ operationId: string; state: 'revoked'; replayed: false }>;
export type SeoulLifecycleStatusResult = Readonly<
  { kind: 'archive'; spaceId: string; archiveId: string; revision: 1 | 2; state: 'stored' | 'primary_erased' }
  | { kind: 'operation'; spaceId: string; operationId: string; receipt: SeoulEraseReceipt | null }
>;
export type SeoulLifecycleResult = SeoulEraseReceipt | SeoulRetireReceipt | SeoulRevokeSelfReceipt | SeoulLifecycleStatusResult;
export interface SeoulLifecycleRepository {
  eraseArchive(tokenDigest: string, input: SeoulEraseInput, options?: SeoulRequestOptions): Promise<SeoulEraseReceipt>;
  retireSpace(tokenDigest: string, input: SeoulRetireInput, options?: SeoulRequestOptions): Promise<SeoulRetireReceipt>;
  revokeSelf(tokenDigest: string, input: SeoulRevokeSelfInput, options?: SeoulRequestOptions): Promise<SeoulRevokeSelfReceipt>;
  status(tokenDigest: string, input: SeoulLifecycleStatusInput, options?: SeoulRequestOptions): Promise<SeoulLifecycleStatusResult>;
}
