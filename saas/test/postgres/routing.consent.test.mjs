import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMedicalCloudflareConsent, parseCloudflareMedicalConsent, revokeCloudflareMedicalConsent } from '../../src/routing/consent.ts';

const record = { id: 'standing-1', version: 7, organizationId: 'org-1', spaceScope: { kind: 'all-spaces' },
  provider: 'cloudflare-agent-memory', classification: 'medical',
  scopes: ['ingest', 'storage', 'extraction', 'embedding', 'recall'], validFromMs: 1000,
  status: 'granted', approvedBy: 'admin-1', evidenceRef: 'ledger:evidence-1' };
const context = { organizationId: 'org-1', accountId: 'employee-1', spaceId: 'space-1',
  membership: { organizationId: 'org-1', accountId: 'employee-1', status: 'active' }, spaceAuthorized: true,
  operation: 'memory_ingest', record, now: 10000 };

test('current organization standing consent permits an authorized employee without a reference or reconfirmation', () => {
  assert.deepEqual(assertMedicalCloudflareConsent(context), { consentId: 'standing-1', version: 7,
    organizationId: 'org-1', accountId: 'employee-1', spaceId: 'space-1', provider: 'cloudflare-agent-memory',
    classification: 'medical', operation: 'memory_ingest', checkedAtMs: 10000, validUntilMs: 70000 });
});

test('organization membership never substitutes for independent Space authorization', () => {
  for (const change of [{ spaceAuthorized: false }, { membership: { ...context.membership, status: 'suspended' } },
    { membership: { ...context.membership, status: 'removed' } }, { accountId: 'other-employee' },
    { membership: { ...context.membership, organizationId: 'parent-org' } }]) {
    assert.throws(() => assertMedicalCloudflareConsent({ ...context, ...change }), { code: 'routing_consent_scope_denied' });
  }
  assert.throws(() => assertMedicalCloudflareConsent({ ...context, membership: undefined }), { code: 'routing_consent_context_invalid' });
});

test('a child or unrelated organization cannot inherit the selected organization grant', () => {
  for (const organizationId of ['child-org', 'other-org']) {
    assert.throws(() => assertMedicalCloudflareConsent({ ...context, organizationId,
      membership: { ...context.membership, organizationId } }), { code: 'routing_consent_scope_denied' });
  }
});

test('explicit Space scope accepts listed Spaces and rejects all others', () => {
  const scoped = { ...record, spaceScope: { kind: 'spaces', spaceIds: ['space-1', 'space-2'] } };
  assert.equal(assertMedicalCloudflareConsent({ ...context, record: scoped }).spaceId, 'space-1');
  assert.throws(() => assertMedicalCloudflareConsent({ ...context, spaceId: 'space-3', record: scoped }), { code: 'routing_consent_scope_denied' });
});

test('optional content reference must match the current record ID and exact version', () => {
  assert.equal(assertMedicalCloudflareConsent({ ...context, reference: { consentId: 'standing-1', version: 7 } }).version, 7);
  for (const reference of [{ consentId: 'standing-2', version: 7 }, { consentId: 'standing-1', version: 6 },
    { consentId: 'standing-1', version: 8 }]) {
    assert.throws(() => assertMedicalCloudflareConsent({ ...context, reference }), { code: 'routing_consent_reference_mismatch' });
  }
  assert.throws(() => assertMedicalCloudflareConsent({ ...context, reference: { mode: 'organization' } }));
});

test('missing, revoked, not-yet-valid and expired current records cannot grant access', () => {
  for (const current of [null, undefined, { ...record, status: 'revoked', revokedAtMs: 9000 },
    { ...record, validFromMs: 10001 }, { ...record, expiresAtMs: 10000 }, { ...record, expiresAtMs: 9999 }]) {
    assert.throws(() => assertMedicalCloudflareConsent({ ...context, record: current }), { code: 'routing_consent_unavailable' });
  }
  assert.equal(assertMedicalCloudflareConsent({ ...context, now: 1000 }).checkedAtMs, 1000);
});

test('permit expiry is bounded by the grant and never extends its lifetime', () => {
  const permit = assertMedicalCloudflareConsent({ ...context, record: { ...record, expiresAtMs: 10001 } });
  assert.equal(permit.validUntilMs, 10001);
  assert.equal(Object.isFrozen(permit), true);
  assert.equal('record' in permit, false);
  assert.equal('evidenceRef' in permit, false);
});

test('ingest requires each raw-storage and processing scope', () => {
  for (const scope of ['ingest', 'storage', 'extraction', 'embedding']) {
    assert.throws(() => assertMedicalCloudflareConsent({ ...context, record: { ...record,
      scopes: record.scopes.filter(s => s !== scope) } }), { code: 'routing_consent_scope_denied' });
  }
  assert.doesNotThrow(() => assertMedicalCloudflareConsent({ ...context,
    record: { ...record, scopes: ['ingest', 'storage', 'extraction', 'embedding'] } }));
});

test('search independently requires stored-content, embedding and recall permission', () => {
  const current = { ...record, scopes: ['storage', 'embedding', 'recall'] };
  assert.equal(assertMedicalCloudflareConsent({ ...context, operation: 'memory_search', record: current }).operation, 'memory_search');
  for (const scope of ['storage', 'embedding', 'recall']) {
    assert.throws(() => assertMedicalCloudflareConsent({ ...context, operation: 'memory_search',
      record: { ...current, scopes: current.scopes.filter(s => s !== scope) } }), { code: 'routing_consent_scope_denied' });
  }
});

test('record parser rejects other providers, purposes, duplicate scopes and unbounded or contradictory fields', () => {
  for (const change of [{ provider: 'cloudflare-vectorize' }, { classification: 'general' }, { version: 0 },
    { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { expiresAtMs: 1000 }, { validFromMs: -1 },
    { validFromMs: Infinity }, { revokedAtMs: 5000 }, { status: 'revoked' }, { approvedBy: '' }, { evidenceRef: '' },
    { rawContent: 'must-not-be-retained' }, { scopes: ['storage', 'storage'] },
    { spaceScope: { kind: 'spaces', spaceIds: [] } }, { spaceScope: { kind: 'spaces', spaceIds: ['space-1', 'space-1'] } }]) {
    assert.throws(() => parseCloudflareMedicalConsent({ ...record, ...change }), { code: 'routing_consent_unavailable' });
  }
});

test('untrusted extra context, malformed identity, clock and operation cannot authorize', () => {
  for (const change of [{ approved: true }, { now: NaN }, { now: -1 }, { now: Number.MAX_SAFE_INTEGER },
    { operation: 'delete' }, { spaceId: '' }, { accountId: 'employee\n1' }, { organizationId: '' }]) {
    assert.throws(() => assertMedicalCloudflareConsent({ ...context, ...change }), { code: 'routing_consent_context_invalid' });
  }
});

test('parsed records snapshot and freeze nested scope arrays', () => {
  const mutable = structuredClone({ ...record, spaceScope: { kind: 'spaces', spaceIds: ['space-1'] } });
  const parsed = parseCloudflareMedicalConsent(mutable);
  mutable.scopes.length = 0; mutable.spaceScope.spaceIds[0] = 'another-space';
  assert.equal(parsed.scopes.length, 5);
  assert.deepEqual(parsed.spaceScope.spaceIds, ['space-1']);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.scopes), true);
  assert.equal(Object.isFrozen(parsed.spaceScope), true);
  assert.equal(Object.isFrozen(parsed.spaceScope.spaceIds), true);
});

test('revocation advances version once, preserves the earliest tombstone and never regrants', () => {
  const revoked = revokeCloudflareMedicalConsent(record, { now: 11000, expectedVersion: 7 });
  assert.equal(revoked.status, 'revoked'); assert.equal(revoked.version, 8); assert.equal(revoked.revokedAtMs, 11000);
  assert.equal(record.status, 'granted'); assert.equal(record.version, 7);
  const repeated = revokeCloudflareMedicalConsent(revoked, { now: 12000, expectedVersion: 8 });
  assert.deepEqual(repeated, revoked);
  assert.equal(Object.isFrozen(repeated), true);
  assert.throws(() => assertMedicalCloudflareConsent({ ...context, now: 12000, record: repeated }), { code: 'routing_consent_unavailable' });
});

test('a scheduled grant can be revoked before it becomes effective', () => {
  const scheduled = { ...record, validFromMs: 20000 };
  const revoked = revokeCloudflareMedicalConsent(scheduled, { now: 10000, expectedVersion: 7 });
  assert.equal(revoked.status, 'revoked'); assert.equal(revoked.revokedAtMs, 10000); assert.equal(revoked.version, 8);
  assert.throws(() => assertMedicalCloudflareConsent({ ...context, now: 25000, record: revoked }), { code: 'routing_consent_unavailable' });
});

test('revocation rejects stale expected version, backward tombstone clock and version overflow', () => {
  for (const options of [{ now: 11000, expectedVersion: 6 }]) {
    assert.throws(() => revokeCloudflareMedicalConsent(record, options), { code: 'routing_consent_transition_invalid' });
  }
  assert.throws(() => revokeCloudflareMedicalConsent({ ...record, version: Number.MAX_SAFE_INTEGER },
    { now: 11000, expectedVersion: Number.MAX_SAFE_INTEGER }), { code: 'routing_consent_transition_invalid' });
  assert.throws(() => revokeCloudflareMedicalConsent({ ...record, status: 'revoked', revokedAtMs: 11000 },
    { now: 10000, expectedVersion: 7 }), { code: 'routing_consent_transition_invalid' });
});
