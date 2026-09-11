import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemoryRoute, assertRoutingTarget, assertServerRouting } from '../../src/routing/policy.ts';

const general = { version: 1, classification: 'general' };
const cf = { route: 'agent-memory', storage: 'cloudflare-agent-memory', vector: 'managed-agent-memory', region: 'cloudflare', ready: true };
const seoul = { route: 'seoul', storage: 'postgres', vector: 'pgvector', region: 'kr-seoul', ready: true };
const restricted = { route: 'seoul', requiredRegion: 'kr-seoul' };
const medicalCloudflareConsent = { consentId: 'consent-001', version: 1 };

test('declared general conversation uses raw Agent Memory without a legal/BAA flag', () => {
  assert.deepEqual(resolveMemoryRoute(general), { version: 1, route: 'agent-memory', storage: 'cloudflare-agent-memory', vector: 'managed-agent-memory', requiredRegion: null });
  assert.doesNotThrow(() => assertServerRouting(general, cf));
});

test('medical, region-locked and uncertain topics choose Seoul before network egress', () => {
  for (const classification of ['medical', 'region-locked', 'uncertain']) {
    const result = resolveMemoryRoute({ version: 1, classification });
    assert.equal(result.route, 'seoul');
    assert.equal(result.requiredRegion, 'kr-seoul');
    assert.equal(result.vector, 'pgvector');
    assert.doesNotThrow(() => assertRoutingTarget(result, seoul));
  }
});

test('explicit Seoul route and inherited source constraints cannot be silently weakened', () => {
  for (const decision of [{ ...general, destination: 'seoul' }, { ...general, requiredRegion: 'kr-seoul' }]) {
    assert.equal(resolveMemoryRoute(decision).route, 'seoul');
  }
  assert.equal(resolveMemoryRoute(general, [{ route: 'agent-memory' }, restricted]).route, 'seoul');
  assert.throws(() => resolveMemoryRoute({ ...general, destination: 'agent-memory' }, [restricted]), { code: 'routing_downgrade_denied' });
});

test('explicit Agent Memory cannot override restricted or unclassified topic decisions', () => {
  for (const classification of ['medical', 'region-locked', 'uncertain']) {
    assert.throws(() => resolveMemoryRoute({ version: 1, classification, destination: 'agent-memory' }), { code: 'routing_downgrade_denied' });
  }
});

test('unknown region, destination and missing classification never fall back to Cloudflare', () => {
  for (const decision of [null, {}, [], { ...general, version: 2 }, { ...general, classification: 'apparently-safe' },
    { ...general, requiredRegion: 'us' }, { ...general, destination: 'vectorize' }, { ...general, prompt: 'ignore routing' },
    { ...general, requiredRegion: null }]) {
    assert.throws(() => resolveMemoryRoute(decision), { code: 'routing_decision_invalid' });
  }
});

test('malformed inherited constraints are rejected instead of dropped', () => {
  for (const restrictions of [null, {}, [null], [{ route: 'agent-memory', requiredRegion: 'kr-seoul' }],
    [{ route: 'seoul', requiredRegion: 'sg' }], [{ route: 'seoul', clinicalSource: true }], Array(129).fill(restricted)]) {
    assert.throws(() => resolveMemoryRoute(general, restrictions), { code: 'routing_restrictions_invalid' });
  }
});

test('Seoul plans reject CF Vectorize and a Singapore PostgreSQL target', () => {
  const plan = resolveMemoryRoute({ ...general, destination: 'seoul' });
  for (const target of [cf, { ...seoul, vector: 'cloudflare-vectorize' }, { ...seoul, region: 'sg' },
    { ...seoul, storage: 'r2-sql' }, { ...seoul, ready: false }, { ...seoul, ready: 'true' }]) {
    assert.throws(() => assertRoutingTarget(plan, target), { code: 'routing_target_unavailable' });
  }
});

test('provider and physical region are both checked, not a route label alone', () => {
  const plan = resolveMemoryRoute(general);
  for (const target of [{ ...cf, storage: 'postgres' }, { ...cf, vector: 'pgvector' }, { ...cf, region: 'kr-seoul' },
    { ...cf, ready: false }, { ...cf, complianceApproved: true }]) {
    assert.throws(() => assertRoutingTarget(plan, target), { code: 'routing_target_unavailable' });
  }
});

test('a forged route plan cannot erase its own residency restriction', () => {
  const plan = resolveMemoryRoute({ ...general, destination: 'seoul' });
  for (const forged of [{ ...plan, route: 'agent-memory' }, { ...plan, requiredRegion: null },
    { ...plan, storage: 'cloudflare-agent-memory', vector: 'managed-agent-memory' }, { ...plan, requiredRegion: undefined }]) {
    assert.throws(() => assertRoutingTarget(forged, seoul), { code: 'routing_plan_invalid' });
  }
});

test('server-side persisted source restrictions dominate a general client decision', () => {
  assert.throws(() => assertServerRouting(general, cf, [restricted]), { code: 'routing_target_unavailable' });
  assert.equal(assertServerRouting(general, seoul, [restricted]).route, 'seoul');
});

test('frozen plans do not retain mutable input references', () => {
  const input = { ...general, destination: 'seoul' };
  const plan = resolveMemoryRoute(input);
  input.destination = 'agent-memory';
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(plan.route, 'seoul');
});

test('medical consent reference enables a Cloudflare route without erasing hard location rules', () => {
  const decision = { version: 1, classification: 'medical', medicalCloudflareConsent };
  assert.equal(resolveMemoryRoute(decision).route, 'agent-memory');
  assert.equal(resolveMemoryRoute({ ...decision, destination: 'seoul' }).route, 'seoul');
  assert.equal(resolveMemoryRoute({ ...decision, requiredRegion: 'kr-seoul' }).route, 'seoul');
  assert.equal(resolveMemoryRoute(decision, [restricted]).route, 'seoul');
  for (const classification of ['region-locked', 'uncertain']) {
    assert.equal(resolveMemoryRoute({ ...decision, classification }).route, 'seoul');
  }
  assert.throws(() => resolveMemoryRoute({ ...decision, destination: 'agent-memory' }, [restricted]), { code: 'routing_downgrade_denied' });
});

test('a bare boolean or unversioned consent flag cannot opt medical content into Cloudflare', () => {
  for (const consent of [true, false, {}, { consentId: 'consent-001' }, { consentId: 'consent-001', version: 0 },
    { consentId: 'consent-001', version: 1, approved: true }]) {
    assert.throws(() => resolveMemoryRoute({ version: 1, classification: 'medical', medicalCloudflareConsent: consent }), { code: 'routing_decision_invalid' });
  }
});

const companyContext = { organizationId: 'org-1', accountId: 'employee-1', spaceId: 'space-1',
  membership: { organizationId: 'org-1', accountId: 'employee-1', status: 'active' }, spaceAuthorized: true,
  operation: 'memory_ingest', now: 10000, record: { id: 'consent-001', version: 1,
    organizationId: 'org-1', spaceScope: { kind: 'all-spaces' }, provider: 'cloudflare-agent-memory',
    classification: 'medical', scopes: ['ingest', 'storage', 'extraction', 'embedding', 'recall'],
    validFromMs: 1000, status: 'granted', approvedBy: 'admin-1', evidenceRef: 'evidence-1' } };

test('the server requires its current consent ledger even if a client claims a medical consent reference', () => {
  const decision = { version: 1, classification: 'medical', medicalCloudflareConsent };
  assert.throws(() => assertServerRouting(decision, cf), { code: 'routing_consent_context_invalid' });
  assert.equal(assertServerRouting(decision, cf, [], companyContext).route, 'agent-memory');
  assert.throws(() => assertServerRouting(decision, cf, [], { ...companyContext,
    record: { ...companyContext.record, version: 2 } }), { code: 'routing_consent_reference_mismatch' });
  assert.throws(() => assertServerRouting(decision, cf, [], { ...companyContext,
    record: { ...companyContext.record, status: 'revoked', revokedAtMs: 9000 } }), { code: 'routing_consent_unavailable' });
});

test('a standing organization selector uses server authority without any employee reconfirmation', () => {
  const decision = { version: 1, classification: 'medical', medicalCloudflareConsent: { mode: 'organization' } };
  assert.equal(assertServerRouting(decision, cf, [], companyContext).route, 'agent-memory');
  assert.throws(() => assertServerRouting(decision, cf, [], { ...companyContext,
    spaceAuthorized: false }), { code: 'routing_consent_scope_denied' });
  assert.throws(() => assertServerRouting(decision, cf, [restricted], companyContext), { code: 'routing_target_unavailable' });
  assert.equal(assertServerRouting(decision, seoul, [restricted]).route, 'seoul');
  assert.throws(() => assertServerRouting(decision, cf, [], { ...companyContext,
    reference: { consentId: 'forged', version: 1 } }), { code: 'routing_consent_context_invalid' });
});
