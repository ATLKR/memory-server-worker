import { durableSqlObjectName, parseDurableSqlIdentity } from './types.ts';
import { snapshotCanonical, snapshotHash, validateSnapshotPlan } from './snapshot.ts';
import type { SnapshotIdentity, SnapshotPlan, SnapshotValue } from './snapshot.ts';

export interface SnapshotBundle { plan: SnapshotPlan; chunks: { planHash: string; index: number; rows: SnapshotValue[][] }[] }
export interface BackupIdentity { runId: string; identity: SnapshotIdentity; planHash: string }
interface BackupEnvelope extends BackupIdentity { version: 1; iv: string; ciphertext: string }
const enc = new TextEncoder(), LIMIT = 24 * 1024 * 1024;
const fail = (): never => { throw new Error('snapshot_backup_invalid'); };
function encode(bytes: Uint8Array): string {
  let value = ''; for (let index = 0; index < bytes.length; index += 8192) value += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value: string, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0)); } catch { return fail(); }
  if (bytes.length > maximum || encode(bytes) !== value) fail(); return bytes;
}
function validated(input: BackupIdentity): BackupIdentity {
  if (!input || typeof input.runId !== 'string' || typeof input.planHash !== 'string'
    || !/^[a-f0-9]{24}$/.test(input.runId) || !/^[a-f0-9]{64}$/.test(input.planHash)) fail();
  let identity: SnapshotIdentity; try { identity = parseDurableSqlIdentity(input.identity); } catch { return fail(); }
  return { runId: input.runId, identity, planHash: input.planHash };
}
function aad(identity: BackupIdentity): Uint8Array<ArrayBuffer> { return enc.encode(snapshotCanonical({ purpose: 'memory-sql-backup-v1', ...identity })); }
async function key(secret: string, identity: BackupIdentity): Promise<CryptoKey> {
  const bytes = decode(secret, 32); if (bytes.length !== 32) fail();
  const base = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(identity.runId), info: aad(identity) }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function validateBundle(bundle: SnapshotBundle, expected: BackupIdentity): Promise<void> {
  if (!bundle || Object.keys(bundle).sort().join(',') !== 'chunks,plan' || !Array.isArray(bundle.chunks)) fail();
  validateSnapshotPlan(bundle.plan, durableSqlObjectName(expected.identity));
  if (snapshotCanonical(bundle.plan.identity) !== snapshotCanonical(expected.identity)
    || await snapshotHash(bundle.plan) !== expected.planHash || bundle.chunks.length !== bundle.plan.chunks.length
    || await snapshotHash(bundle.plan.schema) !== bundle.plan.schemaHash
    || await snapshotHash({ tables: bundle.plan.tables, chunks: bundle.plan.chunks }) !== bundle.plan.snapshotHash) fail();
  let totalBytes = 0;
  for (const [index, chunk] of bundle.chunks.entries()) {
    const descriptor = bundle.plan.chunks[index]!;
    if (!chunk || Object.keys(chunk).sort().join(',') !== 'index,planHash,rows' || chunk.index !== index || chunk.planHash !== expected.planHash
      || !Array.isArray(chunk.rows) || chunk.rows.length !== descriptor.rowCount || await snapshotHash(chunk.rows) !== descriptor.hash) fail();
    const table = bundle.plan.tables.find(table => table.name === descriptor.table)!;
    const bytes = enc.encode(snapshotCanonical(chunk.rows)).byteLength; totalBytes += bytes;
    if (bytes > 524288 || totalBytes > 16 * 1024 * 1024 || chunk.rows.some(row => !Array.isArray(row) || row.length !== table.columns.length
      || row.some(value => value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)
        && (!Number.isInteger(value) || Number.isSafeInteger(value)))))) fail();
  }
}
/** Backups use the already escrowed deployment payload key with an independent
 * HKDF domain. The temporary import signer is not needed to decrypt a backup. */
export async function encryptSnapshotBackup(secret: string, input: BackupIdentity, supplied: SnapshotBundle): Promise<string> {
  const expected = validated(input), serialized = snapshotCanonical(supplied);
  const plaintext = enc.encode(serialized); if (plaintext.byteLength > LIMIT) fail();
  const bundle: SnapshotBundle = JSON.parse(serialized); await validateBundle(bundle, expected);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(expected) }, await key(secret, expected), plaintext));
  return snapshotCanonical({ version: 1, ...expected, iv: encode(iv), ciphertext: encode(ciphertext) });
}
export async function decryptSnapshotBackup(secret: string, input: BackupIdentity, serialized: string): Promise<SnapshotBundle> {
  const expected = validated(input);
  if (typeof serialized !== 'string' || serialized.length > Math.ceil((LIMIT + 16) * 4 / 3) + 2048) fail();
  let envelope: BackupEnvelope;
  try { envelope = JSON.parse(serialized); } catch { return fail(); }
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'ciphertext,identity,iv,planHash,runId,version' || envelope.version !== 1
    || snapshotCanonical(validated(envelope)) !== snapshotCanonical(expected)) fail();
  const iv = decode(envelope.iv, 12); if (iv.length !== 12) fail();
  let plaintext: ArrayBuffer;
  try { plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(expected) }, await key(secret, expected), decode(envelope.ciphertext, LIMIT + 16)); }
  catch { return fail(); }
  let bundle: SnapshotBundle; try { bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)); } catch { return fail(); }
  await validateBundle(bundle, expected); return bundle;
}
export function snapshotBackupKey(input: BackupIdentity): string {
  const value = validated(input);
  return `memory-sql-migrations/${value.identity.deploymentId}/${value.runId}/${value.identity.databaseId}-${value.identity.epoch}/${value.planHash}.snapshot-v1.enc`;
}
