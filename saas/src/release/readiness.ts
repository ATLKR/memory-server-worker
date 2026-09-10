import { importSPKI, jwtVerify } from 'jose';
import { readSettings, SERVICE_VERSION } from '../config.ts';
import { canonicalEmail } from '../identity.ts';
import type { ReleaseEnv } from './types.ts';
import { unbase64url } from './util.ts';
import { BUILD_FINGERPRINT, BUILD_REVISION } from './build-info.ts';

export const GA_PROFILE = 'managed-ai-metered';
export const ACCEPTANCE_ISSUER = 'urn:allenlabs:memory:live-acceptance';
export const MAX_ACCEPTANCE_SECONDS = 7 * 86400;
export const REQUIRED_ACCEPTANCE_GATES = [
  'source-validation', 'sso-session', 'mail-proof', 'workspace-authority',
  'identity-revocation', 'pat-mcp-clients', 'ai-retrieval', 'reviewed-ingestion',
  'sharing-export-erasure', 'metering-quotas', 'physical-storage', 'multi-store-recovery',
  'load-capacity', 'observability-response', 'operational-policy',
] as const;

export interface ReadinessEnvironment extends ReleaseEnv {
  GA_PROFILE?: string;
  DEPLOYMENT_ENVIRONMENT?: string;
  SOURCE_REVISION?: string;
  PAID_BILLING_ENABLED?: 'true' | 'false';
  LIVE_ACCEPTANCE_PUBLIC_KEY?: string;
  LIVE_ACCEPTANCE_JWS?: string;
}
export interface StorageReadiness {
  ready: boolean;
  hotSchemaVersion: number;
  /** SHA-256 of the canonical, validated target resource/config manifest. Never public. */
  resourceFingerprint: string;
}
export interface ReadinessOptions {
  centralSchemaVersion: number;
  hotSchemaVersion: number;
  /** The integration owns storage probing and resource identities, not the public endpoint. */
  inspectStorage(): Promise<StorageReadiness>;
  clock?: () => number;
}
export interface ReadinessResult {
  ready: boolean;
  stage: 'operator-enabled-ga' | 'release-candidate';
  profile: typeof GA_PROFILE;
  checks: Record<string, boolean>;
  acceptanceId?: string;
  notice: string;
}

const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{40}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const numericDate = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value * 1000) && Number.isInteger(value) && value > 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z\d._:-]{0,127}$/.test(value);
async function safe<T>(read: () => Promise<T>): Promise<T | null> { try { return await read(); } catch { return null; } }

async function acceptance(env: ReadinessEnvironment, options: ReadinessOptions, storage: StorageReadiness | null, clock: () => number): Promise<{ id: string; expiresAt: number } | null> {
  try {
    if (env.GA_PROFILE !== GA_PROFILE || !['production', 'staging'].includes(env.DEPLOYMENT_ENVIRONMENT ?? '') ||
        !revision(BUILD_REVISION) || (env.SOURCE_REVISION !== undefined && env.SOURCE_REVISION !== BUILD_REVISION) ||
        !sha256(BUILD_FINGERPRINT) || !storage || storage.resourceFingerprint !== BUILD_FINGERPRINT ||
        !env.LIVE_ACCEPTANCE_JWS || env.LIVE_ACCEPTANCE_JWS.length > 32768 ||
        !env.LIVE_ACCEPTANCE_PUBLIC_KEY || env.LIVE_ACCEPTANCE_PUBLIC_KEY.length > 8192) return null;
    const origin = readSettings(env).origin;
    if (env.PUBLIC_ORIGIN !== origin) return null;
    const key = await importSPKI(env.LIVE_ACCEPTANCE_PUBLIC_KEY, 'EdDSA');
    const { payload } = await jwtVerify(env.LIVE_ACCEPTANCE_JWS, key, {
      algorithms: ['EdDSA'], issuer: ACCEPTANCE_ISSUER, audience: origin,
      requiredClaims: ['iat', 'exp', 'jti'], currentDate: new Date(clock()),
    });
    const now = clock();
    if (payload.aud !== origin || !identifier(payload.jti) || !numericDate(payload.iat) || !numericDate(payload.exp) ||
        payload.iat * 1000 > now || payload.exp * 1000 <= now || payload.exp <= payload.iat || payload.exp - payload.iat > MAX_ACCEPTANCE_SECONDS ||
        payload.format !== 2 || payload.profile !== GA_PROFILE || payload.releaseVersion !== SERVICE_VERSION ||
        payload.sourceRevision !== BUILD_REVISION || payload.environment !== env.DEPLOYMENT_ENVIRONMENT ||
        payload.centralSchemaVersion !== options.centralSchemaVersion || payload.hotSchemaVersion !== options.hotSchemaVersion ||
        payload.resourceFingerprint !== storage.resourceFingerprint) return null;
    if (!Array.isArray(payload.gates) || payload.gates.length !== REQUIRED_ACCEPTANCE_GATES.length) return null;
    const seen = new Set<string>();
    for (const gate of payload.gates) {
      if (!object(gate) || typeof gate.id !== 'string' || seen.has(gate.id) ||
          !(REQUIRED_ACCEPTANCE_GATES as readonly string[]).includes(gate.id) || gate.status !== 'passed' ||
          !numericDate(gate.completedAt) || gate.completedAt > payload.iat || payload.exp - gate.completedAt > MAX_ACCEPTANCE_SECONDS || !sha256(gate.evidenceSha256) ||
          typeof gate.evidenceRef !== 'string' || !gate.evidenceRef.trim() || gate.evidenceRef.length > 512 ||
          /[\x00-\x1f\x7f]/.test(gate.evidenceRef)) return null;
      seen.add(gate.id);
    }
    return { id: payload.jti, expiresAt: payload.exp * 1000 };
  } catch { return null; }
}

/** Configuration and bounded primary probes plus signed operator evidence; never an external certification. */
export async function evaluateReadiness(env: ReadinessEnvironment, options: ReadinessOptions): Promise<ReadinessResult> {
  const clock = options.clock ?? Date.now;
  const [schema, heartbeat, meter, storage] = await Promise.all([
    safe(() => env.DB.withSession('first-primary').prepare('SELECT max(version) AS version FROM release_meta').first<{ version: number }>()),
    safe(() => env.DB.withSession('first-primary').prepare("SELECT last_success_at AS at FROM release_heartbeats WHERE name='maintenance'").first<{ at: number }>()),
    safe(() => env.DB.withSession('first-primary').prepare(`SELECT
      sum(type='table' AND name IN ('release_operations','release_usage_events','release_usage_counters','release_pools')) AS tables,
      sum(type='view' AND name='release_space_pools') AS views,
      sum(type='trigger' AND name IN ('release_operation_budget','release_operation_meter')) AS triggers
      FROM sqlite_master WHERE name IN ('release_operations','release_usage_events','release_usage_counters','release_pools','release_space_pools','release_operation_budget','release_operation_meter')`).first<{ tables: number; views: number; triggers: number }>()),
    safe(() => options.inspectStorage()),
  ]);
  let sso = false, mail = false, encryptedIngest = false, validRoster = false;
  try { const settings = readSettings(env); sso = Boolean(settings.auth.clientId && env.PUBLIC_ORIGIN === settings.origin); } catch {}
  try { mail = Boolean(env.EMAIL?.send && env.MAIL_FROM && canonicalEmail(env.MAIL_FROM).address === env.MAIL_FROM.toLowerCase()); } catch {}
  try { encryptedIngest = typeof env.AI?.run === 'function' && Boolean(env.PAYLOAD_KEY && unbase64url(env.PAYLOAD_KEY).length === 32); } catch {}
  try {
    const raw = env.ENROLLMENT_EMAIL_HASHES_JSON;
    if (raw === undefined || typeof raw === 'string') {
      const roster: unknown = JSON.parse(raw ?? '[]');
      validRoster = Array.isArray(roster) && roster.length <= 200 && roster.every(sha256);
    }
  } catch {}
  const attestation = await acceptance(env, options, storage, clock);
  const now = clock();
  const budget = env.AI_MONTHLY_BUDGET_MICROUSD ?? '';
  const budgetLimit = env.DEPLOYMENT_ENVIRONMENT === 'production' ? 20000000 : env.DEPLOYMENT_ENVIRONMENT === 'staging' ? 200000 : 0;
  const checks: Record<string, boolean> = {
    profile: env.GA_PROFILE === GA_PROFILE,
    schema: Number.isInteger(options.centralSchemaVersion) && options.centralSchemaVersion > 0 && schema?.version === options.centralSchemaVersion,
    sso,
    semantic: typeof env.AI?.run === 'function' && ['query', 'upsert', 'deleteByIds', 'getByIds'].every(method => typeof env.MEMORY_INDEX?.[method as keyof NonNullable<ReleaseEnv['MEMORY_INDEX']>] === 'function'),
    encryptedIngest,
    mail,
    deprovisioning: new TextEncoder().encode(env.IDENTITY_WEBHOOK_SECRET ?? '').length >= 32,
    metering: meter?.tables === 4 && meter.views === 1 && meter.triggers === 2,
    storage: Boolean(storage?.ready && Number.isInteger(options.hotSchemaVersion) && options.hotSchemaVersion > 0 && storage.hotSchemaVersion === options.hotSchemaVersion && sha256(storage.resourceFingerprint)),
    maintenance: Boolean(heartbeat && Number.isSafeInteger(heartbeat.at) && now >= heartbeat.at && now - heartbeat.at < 900000),
    backgroundJobs: env.BACKGROUND_JOBS_ENABLED === 'true',
    observability: typeof env.METRICS?.writeDataPoint === 'function',
    rateLimiting: typeof env.REQUEST_LIMITER?.limit === 'function',
    paidBillingDisabled: env.PAID_BILLING_ENABLED === 'false',
    inviteEnrollment: env.ENROLLMENT_MODE === 'invite' && validRoster,
    aiBudget: typeof budget === 'string' && /^[1-9]\d{0,8}$/.test(budget) && Number(budget) <= budgetLimit,
    operatorAcceptance: Boolean(attestation && attestation.expiresAt > now),
    gaMode: env.RELEASE_MODE === 'ga',
  };
  const ready = Object.values(checks).every(Boolean);
  return { ready, stage: ready ? 'operator-enabled-ga' : 'release-candidate', profile: GA_PROFILE, checks,
    ...(checks.operatorAcceptance && attestation ? { acceptanceId: attestation.id } : {}),
    notice: 'Readiness combines current configuration and bounded probes with signed operator acceptance. Paid billing is excluded. It is not an independent security or production certification.' };
}
