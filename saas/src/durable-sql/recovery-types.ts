import { parseDurableSqlIdentity, durableSqlReject } from './types.ts';
import type { DurableSqlIdentity } from './types.ts';
import type { SnapshotValue } from './snapshot.ts';

export type Digest = string;
export type RunId = string;
export type Revision = string;
export type RecoveryAction = 'freeze' | 'status' | 'prepare-export' | 'manifest-page' | 'chunk' | 'release';
export interface RecoveryFreezeInput { version: 1; identity: DurableSqlIdentity; runId: RunId; sourceRevision: Revision }
export interface RecoveryScope { identity: DurableSqlIdentity; runId: RunId; freezeRequestHash: Digest }
export interface RecoveryGrant {
  domain: 'memory-sql-recovery-v1'; action: RecoveryAction; identity: DurableSqlIdentity; runId: RunId;
  requestHash: Digest; notBeforeMs: number; expiresAtMs: number; signature: string;
}
export interface RecoveryFreezeReceipt extends RecoveryScope {
  version: 1; sourceRevision: Revision; frozenAtMs: number; importPlanHash: Digest;
}
export interface RecoveryExportSummary extends RecoveryScope {
  version: 1; planHash: Digest; schemaHash: Digest; snapshotHash: Digest; planBytes: number;
  manifestPages: number; chunkCount: number; rowCount: number; rowBytes: number; sourceFrozenAtMs: number;
}
export type RecoveryStatus = { version: 1; state: 'absent'; scope: RecoveryScope }
  | { version: 1; state: 'frozen'; receipt: RecoveryFreezeReceipt; exportSummary: RecoveryExportSummary | null }
  | { version: 1; state: 'released'; receipt: RecoveryFreezeReceipt; exportSummary: RecoveryExportSummary | null; releaseRequestHash: Digest; releasedAtMs: number };
export interface RecoveryManifestInput extends RecoveryScope { planHash: Digest; pageIndex: number }
export interface RecoveryManifestPage extends RecoveryManifestInput { version: 1; bytes: number; sha256: Digest; data: string }
export interface RecoveryChunkInput extends RecoveryScope { planHash: Digest; index: number }
export interface RecoveryChunk extends RecoveryChunkInput { version: 1; rows: SnapshotValue[][]; hash: Digest }
export interface RecoveryReleaseInput extends RecoveryScope { expectedPlanHash: Digest | null; decision: 'backup-verified' | 'operator-abort'; evidenceHash: Digest }
export interface RecoveryReleaseReceipt extends RecoveryScope { version: 1; releaseRequestHash: Digest; releasedAtMs: number }
export interface DurableSqlRecoveryStub {
  freezeRecovery(input: RecoveryFreezeInput, grant: RecoveryGrant): Promise<RecoveryFreezeReceipt>;
  recoveryStatus(input: RecoveryScope, grant: RecoveryGrant): Promise<RecoveryStatus>;
  prepareRecoveryExport(input: RecoveryScope, grant: RecoveryGrant): Promise<RecoveryExportSummary>;
  readRecoveryManifest(input: RecoveryManifestInput, grant: RecoveryGrant): Promise<RecoveryManifestPage>;
  readRecoveryChunk(input: RecoveryChunkInput, grant: RecoveryGrant): Promise<RecoveryChunk>;
  releaseRecovery(input: RecoveryReleaseInput, grant: RecoveryGrant): Promise<RecoveryReleaseReceipt>;
}
export function recoveryReject(code: string): never { return durableSqlReject(code); }
export const recoveryDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const recoveryInteger = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export function recoveryExact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key)?.get === undefined);
}
const invalid = (): never => recoveryReject('recovery_input');
const runId = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) ? value : invalid();
function identity(value: unknown): DurableSqlIdentity {
  if (!recoveryExact(value, ['deploymentId', 'databaseId', 'kind', 'epoch'])) invalid();
  try { return parseDurableSqlIdentity(value); } catch { return invalid(); }
}
function scope(value: Record<string, unknown>): RecoveryScope {
  if (!recoveryDigest(value.freezeRequestHash)) invalid();
  return { identity: identity(value.identity), runId: runId(value.runId), freezeRequestHash: value.freezeRequestHash as string };
}
export function parseRecoveryFreeze(value: unknown): RecoveryFreezeInput {
  if (!recoveryExact(value, ['version', 'identity', 'runId', 'sourceRevision']) || value.version !== 1
    || typeof value.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceRevision)) invalid();
  const v = value as Record<string, unknown>;
  return { version: 1, identity: identity(v.identity), runId: runId(v.runId), sourceRevision: v.sourceRevision as string };
}
export function parseRecoveryScope(value: unknown): RecoveryScope {
  if (!recoveryExact(value, ['identity', 'runId', 'freezeRequestHash'])) invalid();
  return scope(value as Record<string, unknown>);
}
export function parseRecoveryManifest(value: unknown): RecoveryManifestInput {
  if (!recoveryExact(value, ['identity', 'runId', 'freezeRequestHash', 'planHash', 'pageIndex'])
    || !recoveryDigest(value.planHash) || !recoveryInteger(value.pageIndex, 0, 3)) invalid();
  const v = value as Record<string, unknown>;
  return { ...scope(v), planHash: v.planHash as string, pageIndex: v.pageIndex as number };
}
export function parseRecoveryChunk(value: unknown): RecoveryChunkInput {
  if (!recoveryExact(value, ['identity', 'runId', 'freezeRequestHash', 'planHash', 'index'])
    || !recoveryDigest(value.planHash) || !recoveryInteger(value.index, 0, 999)) invalid();
  const v = value as Record<string, unknown>;
  return { ...scope(v), planHash: v.planHash as string, index: v.index as number };
}
export function parseRecoveryRelease(value: unknown): RecoveryReleaseInput {
  if (!recoveryExact(value, ['identity', 'runId', 'freezeRequestHash', 'expectedPlanHash', 'decision', 'evidenceHash'])
    || (value.expectedPlanHash !== null && !recoveryDigest(value.expectedPlanHash)) || !recoveryDigest(value.evidenceHash)
    || !['backup-verified', 'operator-abort'].includes(value.decision as string)) invalid();
  const v = value as Record<string, unknown>;
  return { ...scope(v), expectedPlanHash: v.expectedPlanHash as string | null, decision: v.decision as RecoveryReleaseInput['decision'], evidenceHash: v.evidenceHash as string };
}
export function parseRecoveryReceipt(value: unknown): RecoveryFreezeReceipt {
  if (!recoveryExact(value, ['identity', 'runId', 'freezeRequestHash', 'version', 'sourceRevision', 'frozenAtMs', 'importPlanHash'])
    || value.version !== 1 || !recoveryInteger(value.frozenAtMs) || !recoveryDigest(value.importPlanHash)
    || typeof value.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceRevision)) invalid();
  const v = value as Record<string, unknown>;
  return { ...scope(v), version: 1, sourceRevision: v.sourceRevision as string, frozenAtMs: v.frozenAtMs as number, importPlanHash: v.importPlanHash as string };
}
export function parseRecoverySummary(value: unknown): RecoveryExportSummary {
  if (!recoveryExact(value, ['identity','runId','freezeRequestHash','version','planHash','schemaHash','snapshotHash','planBytes','manifestPages','chunkCount','rowCount','rowBytes','sourceFrozenAtMs'])
    || value.version !== 1 || ![value.planHash,value.schemaHash,value.snapshotHash].every(recoveryDigest)
    || !recoveryInteger(value.planBytes,1,1048576) || !recoveryInteger(value.manifestPages,1,4)
    || value.manifestPages !== Math.ceil(Number(value.planBytes)/262144) || !recoveryInteger(value.chunkCount,0,1000)
    || !recoveryInteger(value.rowCount,0,100000) || !recoveryInteger(value.rowBytes,0,16777216) || !recoveryInteger(value.sourceFrozenAtMs)) invalid();
  return { ...(value as unknown as RecoveryExportSummary), ...scope(value as Record<string, unknown>) };
}
export function parseRecoveryGrant(value: unknown): RecoveryGrant {
  try {
    if (!recoveryExact(value, ['domain','action','identity','runId','requestHash','notBeforeMs','expiresAtMs','signature'])
      || value.domain !== 'memory-sql-recovery-v1' || !['freeze','status','prepare-export','manifest-page','chunk','release'].includes(value.action as string)
      || !recoveryDigest(value.requestHash) || !recoveryInteger(value.notBeforeMs) || !recoveryInteger(value.expiresAtMs,1)
      || Number(value.expiresAtMs) <= Number(value.notBeforeMs) || Number(value.expiresAtMs)-Number(value.notBeforeMs)>1800000
      || typeof value.signature !== 'string') invalid();
    const v = value as Record<string, unknown>;
    return { domain:'memory-sql-recovery-v1',action:v.action as RecoveryAction,identity:identity(v.identity),runId:runId(v.runId),requestHash:v.requestHash as string,notBeforeMs:v.notBeforeMs as number,expiresAtMs:v.expiresAtMs as number,signature:v.signature as string };
  } catch { return recoveryReject('recovery_authorization'); }
}
export const recoveryScopeOf = (receipt: RecoveryScope): RecoveryScope => ({ identity: { ...receipt.identity }, runId: receipt.runId, freezeRequestHash: receipt.freezeRequestHash });
