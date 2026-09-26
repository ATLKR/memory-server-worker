import { snapshotCanonical, snapshotHash } from './snapshot.ts';
import { durableSqlObjectName } from './types.ts';
import type { DurableSqlIdentity, DurableSqlStorage } from './types.ts';
import type { SnapshotPlan } from './snapshot.ts';
import { collectRecoverySnapshot, finalizeRecoverySnapshot, readCollectedChunk } from './recovery-export.ts';
import { initializeRecoveryMetadata, readRecoveryState } from './recovery-state.ts';
import { parseRecoveryFreeze, parseRecoveryScope, parseRecoveryRelease, parseRecoveryGrant,
  recoveryDigest, recoveryInteger, recoveryReject, recoveryScopeOf } from './recovery-types.ts';
import { parseRecoveryManifest, parseRecoveryChunk } from './recovery-types.ts';
import type { RecoveryAction, RecoveryFreezeInput, RecoveryFreezeReceipt, RecoveryGrant, RecoveryScope,
  RecoveryStatus, RecoveryReleaseInput, RecoveryReleaseReceipt } from './recovery-types.ts';
import type { DurableSqlRecoveryStub, RecoveryExportSummary, RecoveryManifestInput, RecoveryManifestPage, RecoveryChunkInput, RecoveryChunk } from './recovery-types.ts';

export interface SqlRecoveryOptions { storage: DurableSqlStorage; objectName: string; publicKey: string; clock?: () => number }
const enc = new TextEncoder();
const same = (a: unknown, b: unknown): boolean => snapshotCanonical(a) === snapshotCanonical(b);
function decode(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length !== Math.ceil(length * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) recoveryReject('recovery_authorization');
  try {
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
    if (bytes.length !== length || btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== value) recoveryReject('recovery_authorization');
    return bytes;
  } catch { return recoveryReject('recovery_authorization'); }
}
/** A grant authorizes one exact request. Awaited cryptography never reserves a
 * cut: the source identity, grant time and lock are checked in the transaction. */
export class SqlRecoveryController implements DurableSqlRecoveryStub {
  private readonly options: SqlRecoveryOptions;
  private readonly storage: DurableSqlStorage;
  constructor(options: SqlRecoveryOptions) { this.options = { ...options }; this.storage = options.storage; }
  initialize(): void { initializeRecoveryMetadata(this.storage); }
  private time(grant: RecoveryGrant): number {
    const now = (this.options.clock ?? Date.now)();
    if (!recoveryInteger(now) || now < grant.notBeforeMs || now >= grant.expiresAtMs) recoveryReject('recovery_authorization');
    return now;
  }
  private async authorize(action: RecoveryAction, input: { identity: DurableSqlIdentity; runId: string }, grant: RecoveryGrant): Promise<void> {
    this.time(grant);
    if (grant.action !== action || !same(input.identity, grant.identity) || input.runId !== grant.runId) recoveryReject('recovery_authorization');
    const keyBytes = decode(this.options.publicKey, 44), signature = decode(grant.signature, 64);
    if (grant.requestHash !== await snapshotHash(input)) recoveryReject('recovery_authorization');
    try {
      const key = await crypto.subtle.importKey('spki', keyBytes, { name: 'Ed25519' }, false, ['verify']);
      const { signature: unused, ...payload } = grant;
      if (!await crypto.subtle.verify('Ed25519', key, signature, enc.encode(snapshotCanonical(payload)))) recoveryReject('recovery_authorization');
    } catch { recoveryReject('recovery_authorization'); }
    this.time(grant);
  }
  private transaction<T>(grant: RecoveryGrant, callback: (now: number) => T): T {
    try { return this.storage.transactionSync(() => callback(this.time(grant))); }
    catch (error) {
      if (error instanceof Error && /^recovery_(input|authorization|identity|not_ready|conflict|closed|capacity|part|source_changed|metadata_invalid)$/.test(error.message)) throw error;
      return recoveryReject('recovery_metadata_invalid');
    }
  }
  private ready(identity: DurableSqlIdentity): string {
    if (this.options.objectName !== durableSqlObjectName(identity)) recoveryReject('recovery_identity');
    const rows = this.storage.sql.exec('SELECT * FROM durable_sql_state LIMIT 2').toArray(), row = rows[0];
    if (!row || rows.length !== 1) recoveryReject('recovery_not_ready');
    if (row.singleton !== 1 || row.deployment_id !== identity.deploymentId || row.database_id !== identity.databaseId || row.kind !== identity.kind || row.epoch !== identity.epoch) recoveryReject('recovery_identity');
    if (row.status !== 'ready' || !recoveryDigest(row.schema_hash) || !recoveryDigest(row.snapshot_hash)) recoveryReject('recovery_not_ready');
    const imports = this.storage.sql.exec('SELECT plan_hash,sealed_at_ms FROM durable_sql_import LIMIT 2').toArray(), imported = imports[0];
    if (imports.length !== 1 || !imported || !recoveryDigest(imported.plan_hash) || !recoveryInteger(imported.sealed_at_ms)) recoveryReject('recovery_not_ready');
    return imported!.plan_hash as string;
  }
  private scoped(input: RecoveryScope) {
    this.ready(input.identity);
    const state = readRecoveryState(this.storage), run = state.runs.get(input.runId);
    if (run && !same(recoveryScopeOf(run.receipt), input)) recoveryReject('recovery_conflict');
    return { ...state, run };
  }
  private frozen(input: RecoveryScope) {
    const { run, active } = this.scoped(input);
    if (!run) recoveryReject('recovery_conflict');
    if (run.releaseHash !== null) recoveryReject('recovery_closed');
    if (active !== input.runId) recoveryReject('recovery_conflict');
    return run;
  }
  private prepared(input: RecoveryScope & { planHash: string }) {
    const run = this.frozen(recoveryScopeOf(input));
    if (!run.summary || !run.planJson) recoveryReject('recovery_not_ready');
    if (run.summary.planHash !== input.planHash) recoveryReject('recovery_part');
    return { ...run, summary: run.summary, planJson: run.planJson, plan: JSON.parse(run.planJson) as SnapshotPlan };
  }
  async freezeRecovery(input: RecoveryFreezeInput, authorization: RecoveryGrant): Promise<RecoveryFreezeReceipt> {
    const value = parseRecoveryFreeze(input), grant = parseRecoveryGrant(authorization);
    await this.authorize('freeze', value, grant);
    return this.transaction(grant, now => {
      const importPlanHash = this.ready(value.identity), state = readRecoveryState(this.storage), prior = state.runs.get(value.runId);
      if (prior) {
        if (prior.receipt.freezeRequestHash !== grant.requestHash || !same(prior.receipt.identity, value.identity)) recoveryReject('recovery_conflict');
        if (prior.releaseHash !== null) recoveryReject('recovery_closed');
        return prior.receipt;
      }
      if (state.active !== null) recoveryReject('recovery_conflict');
      if (state.runs.size >= 128) recoveryReject('recovery_capacity');
      const receipt: RecoveryFreezeReceipt = { ...value, freezeRequestHash: grant.requestHash, frozenAtMs: now, importPlanHash };
      this.storage.sql.exec('INSERT INTO durable_sql_recovery_runs VALUES(?,?,?,NULL,NULL,NULL,NULL)', value.runId, grant.requestHash, snapshotCanonical(receipt)).toArray();
      this.storage.sql.exec('INSERT INTO durable_sql_recovery_active VALUES(1,?)', value.runId).toArray();
      return receipt;
    });
  }
  async recoveryStatus(input: RecoveryScope, authorization: RecoveryGrant): Promise<RecoveryStatus> {
    const value = parseRecoveryScope(input), grant = parseRecoveryGrant(authorization);
    await this.authorize('status', value, grant);
    return this.transaction(grant, () => {
      const { run, active } = this.scoped(value);
      if (active !== null && active !== value.runId) recoveryReject('recovery_conflict');
      if (!run) { if (active !== null) recoveryReject('recovery_conflict'); return { version: 1, state: 'absent', scope: value }; }
      if (run.releaseHash !== null) return { version: 1, state: 'released', receipt: run.receipt, exportSummary: run.summary, releaseRequestHash: run.releaseHash, releasedAtMs: run.releasedAtMs! };
      return { version: 1, state: 'frozen', receipt: run.receipt, exportSummary: run.summary };
    });
  }
  async prepareRecoveryExport(input: RecoveryScope, authorization: RecoveryGrant): Promise<RecoveryExportSummary> {
    const value = parseRecoveryScope(input), grant = parseRecoveryGrant(authorization);
    await this.authorize('prepare-export', value, grant);
    const collected = this.transaction(grant, () => collectRecoverySnapshot(this.storage, this.frozen(value).receipt));
    let finalized: Awaited<ReturnType<typeof finalizeRecoverySnapshot>>;
    try { finalized = await finalizeRecoverySnapshot(collected); }
    catch { return recoveryReject('recovery_source_changed'); }
    return this.transaction(grant, () => {
      const run = this.frozen(value), planJson = snapshotCanonical(finalized.plan), summaryJson = snapshotCanonical(finalized.summary);
      if (!same(run.receipt, collected.receipt)) recoveryReject('recovery_source_changed');
      if (run.summary !== null) {
        if (run.planJson !== planJson || !same(run.summary, finalized.summary)) recoveryReject('recovery_source_changed');
        return run.summary;
      }
      this.storage.sql.exec('UPDATE durable_sql_recovery_runs SET plan_json=?,summary_json=? WHERE run_id=?', planJson, summaryJson, value.runId).toArray();
      return finalized.summary;
    });
  }
  async readRecoveryManifest(input: RecoveryManifestInput, authorization: RecoveryGrant): Promise<RecoveryManifestPage> {
    const value = parseRecoveryManifest(input), grant = parseRecoveryGrant(authorization);
    await this.authorize('manifest-page', value, grant);
    const pinned = this.transaction(grant, () => {
      const run = this.prepared(value);
      if (value.pageIndex >= run.summary.manifestPages) recoveryReject('recovery_part');
      return run;
    });
    const bytes = enc.encode(pinned.planJson).slice(value.pageIndex * 262144, (value.pageIndex + 1) * 262144);
    if (await snapshotHash(pinned.plan) !== value.planHash) recoveryReject('recovery_source_changed');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const sha256 = Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    const result: RecoveryManifestPage = { ...value, version: 1, bytes: bytes.length, sha256,
      data: btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') };
    return this.transaction(grant, () => {
      const current = this.prepared(value);
      if (!same(current.receipt, pinned.receipt) || current.planJson !== pinned.planJson || !same(current.summary, pinned.summary)) recoveryReject('recovery_source_changed');
      return result;
    });
  }
  async readRecoveryChunk(input: RecoveryChunkInput, authorization: RecoveryGrant): Promise<RecoveryChunk> {
    const value = parseRecoveryChunk(input), grant = parseRecoveryGrant(authorization);
    await this.authorize('chunk', value, grant);
    const pinned = this.transaction(grant, () => {
      const run = this.prepared(value);
      if (!run.plan.chunks[value.index]) recoveryReject('recovery_part');
      return { ...run, rows: readCollectedChunk(this.storage, run.plan, value.index) };
    });
    if (await snapshotHash(pinned.plan) !== value.planHash) recoveryReject('recovery_source_changed');
    const hash = await snapshotHash(pinned.rows);
    if (hash !== pinned.plan.chunks[value.index]!.hash) recoveryReject('recovery_source_changed');
    const result: RecoveryChunk = { ...value, version: 1, rows: pinned.rows, hash };
    if (enc.encode(snapshotCanonical(result)).byteLength > 600 * 1024) recoveryReject('recovery_capacity');
    return this.transaction(grant, () => {
      const current = this.prepared(value);
      if (!same(current.receipt, pinned.receipt) || current.planJson !== pinned.planJson || !same(current.summary, pinned.summary)) recoveryReject('recovery_source_changed');
      return result;
    });
  }
  async releaseRecovery(input: RecoveryReleaseInput, authorization: RecoveryGrant): Promise<RecoveryReleaseReceipt> {
    const value = parseRecoveryRelease(input), grant = parseRecoveryGrant(authorization);
    await this.authorize('release', value, grant);
    return this.transaction(grant, now => {
      const { run, active } = this.scoped(recoveryScopeOf(value));
      if (!run) recoveryReject('recovery_conflict');
      if (run!.releaseHash !== null) {
        if (run!.releaseHash !== grant.requestHash) recoveryReject('recovery_conflict');
        return { ...recoveryScopeOf(value), version: 1, releaseRequestHash: run!.releaseHash!, releasedAtMs: run!.releasedAtMs! };
      }
      if (active !== value.runId || value.expectedPlanHash !== (run!.summary?.planHash ?? null)
        || (value.decision === 'backup-verified' && run!.summary === null)) recoveryReject('recovery_conflict');
      if (now < run!.receipt.frozenAtMs) recoveryReject('recovery_authorization');
      this.storage.sql.exec('UPDATE durable_sql_recovery_runs SET release_request_hash=?,released_at_ms=?,plan_json=NULL WHERE run_id=?', grant.requestHash, now, value.runId).toArray();
      this.storage.sql.exec('DELETE FROM durable_sql_recovery_active WHERE singleton=1 AND run_id=?', value.runId).toArray();
      return { ...recoveryScopeOf(value), version: 1, releaseRequestHash: grant.requestHash, releasedAtMs: now };
    });
  }
}
