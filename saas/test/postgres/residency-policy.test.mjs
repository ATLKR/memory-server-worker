import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDataPolicy, assertRegionalStorageAdmission, assertSameStorageRegion, deriveDataPolicy, selectStoragePlacement } from '../../src/postgres/residency-policy.ts';

const general = { policyVersion: 1, residency: 'sg', profile: 'standard', processingBoundary: 'approved-processors',
  dataClass: 'general', classificationStatus: 'declared', sensitivityTags: [], placementEpoch: 1 };
const seoul = { ...general, residency: 'kr-seoul', profile: 'kr-primary-storage' };

test('explicit general SG and Seoul storage profiles can pass the regional ingress policy check', () => {
  for (const policy of [general, seoul]) assert.doesNotThrow(() => assertRegionalStorageAdmission(policy, {
    databaseRegion: policy.residency, credentialRegion: policy.residency, tenantRegion: policy.residency,
  }));
});
test('missing placement or unknown policy fields never infer a region from IP or email', () => {
  for (const data of [{ ...general, residency: undefined }, { ...general, residency: 'apac' },
    { ...general, email: 'person@example.kr' }, { ...general, sourceIp: '127.0.0.1' }, { ...general, placementEpoch: 0 }]) {
    assert.throws(() => parseDataPolicy(data), { code: 'data_policy_invalid' });
  }
});
test('unclassified data cannot enter a content-processing path', () => {
  assert.throws(() => assertRegionalStorageAdmission({ ...general, classificationStatus: 'unclassified' }, {
    databaseRegion: 'sg', credentialRegion: 'sg', tenantRegion: 'sg',
  }), { code: 'classification_required' });
});
test('medical and strict storage admission stays in Seoul without claiming processing approval', () => {
  const context = { databaseRegion: 'kr-seoul', credentialRegion: 'kr-seoul', tenantRegion: 'kr-seoul' };
  for (const dataClass of ['health', 'clinical', 'restricted']) assert.doesNotThrow(() => assertRegionalStorageAdmission({ ...seoul, dataClass }, context));
  for (const sensitivityTags of [['health'], ['clinical-origin'], ['government-id'], ['credential']]) {
    assert.doesNotThrow(() => assertRegionalStorageAdmission({ ...seoul, sensitivityTags }, context));
  }
  assert.doesNotThrow(() => assertRegionalStorageAdmission({ ...seoul, profile: 'medical-strict', processingBoundary: 'kr' }, context));
});
test('general placement consolidates in Singapore; medical and strict cannot select Singapore', () => {
  for (const dataClass of ['general', 'personal']) assert.deepEqual(selectStoragePlacement({ dataClass }), { residency: 'sg', profile: 'standard' });
  for (const dataClass of ['health', 'clinical', 'restricted']) {
    assert.deepEqual(selectStoragePlacement({ dataClass }), { residency: 'kr-seoul', profile: 'kr-primary-storage' });
    assert.throws(() => selectStoragePlacement({ dataClass, profile: 'general' }), { code: 'sensitive_storage_requires_seoul' });
    assert.throws(() => assertRegionalStorageAdmission({ ...general, dataClass }, { databaseRegion: 'sg', credentialRegion: 'sg', tenantRegion: 'sg' }), { code: 'sensitive_storage_requires_seoul' });
  }
  assert.deepEqual(selectStoragePlacement({ dataClass: 'general', profile: 'strict' }), { residency: 'kr-seoul', profile: 'medical-strict' });
  assert.deepEqual(selectStoragePlacement({ dataClass: 'general', profile: 'medical' }), { residency: 'kr-seoul', profile: 'kr-primary-storage' });
  assert.deepEqual(selectStoragePlacement({ dataClass: 'general', sensitivityTags: ['clinical-origin'] }), { residency: 'kr-seoul', profile: 'kr-primary-storage' });
});
test('storage profile cannot claim a strict processing boundary or use the wrong physical region', () => {
  for (const p of [{ ...seoul, processingBoundary: 'kr-seoul' }, { ...general, profile: 'kr-primary-storage' },
    { ...seoul, profile: 'standard' }, { ...general, profile: 'medical-strict', processingBoundary: 'kr' }]) {
    assert.throws(() => parseDataPolicy(p), { code: 'data_policy_invalid' });
  }
});
test('credential, tenant and execution database must each match the persisted Space region', () => {
  for (const field of ['databaseRegion', 'credentialRegion', 'tenantRegion']) {
    assert.throws(() => assertRegionalStorageAdmission(seoul, { databaseRegion: 'kr-seoul', credentialRegion: 'kr-seoul', tenantRegion: 'kr-seoul', [field]: 'sg' }), { code: 'storage_region_mismatch' });
  }
});
test('cross-region destinations and missing targets fail without suggesting a fallback', () => {
  assert.doesNotThrow(() => assertSameStorageRegion(seoul, 'kr-seoul'));
  for (const target of ['sg', undefined, 'apac']) assert.throws(() => assertSameStorageRegion(seoul, target), { code: 'storage_region_mismatch' });
});
test('contradictory Singapore medical placement is rejected by every shared policy entry point', () => {
  for (const change of [{ dataClass: 'clinical' }, { dataClass: 'health' }, { dataClass: 'restricted' }, { sensitivityTags: ['clinical-origin'] }]) {
    const policy = { ...general, ...change };
    for (const action of [() => parseDataPolicy(policy), () => deriveDataPolicy([policy]), () => assertSameStorageRegion(policy, 'sg')]) {
      assert.throws(action, { code: 'sensitive_storage_requires_seoul' });
    }
  }
});
test('derived restrictions preserve clinical origin even when the result is also restricted', () => {
  const policy = deriveDataPolicy([{ ...seoul, dataClass: 'clinical' }, { ...seoul, dataClass: 'restricted', sensitivityTags: ['government-id'] }]);
  assert.equal(policy.dataClass, 'restricted');
  assert.deepEqual(policy.sensitivityTags, ['clinical-origin', 'government-id', 'health']);
  assert.throws(() => assertRegionalStorageAdmission(policy, { databaseRegion: 'kr-seoul', credentialRegion: 'kr-seoul', tenantRegion: 'kr-seoul' }), { code: 'classification_required' });
});
test('derivation cannot broaden region, processing scope, placement epoch or classification assurance', () => {
  for (const sources of [[], [general, seoul], [general, { ...general, placementEpoch: 2 }],
    [seoul, { ...seoul, profile: 'medical-strict', processingBoundary: 'kr' }]]) {
    assert.throws(() => deriveDataPolicy(sources), { code: 'derived_policy_conflict' });
  }
  assert.equal(deriveDataPolicy([{ ...general, classificationStatus: 'verified' }, { ...general, classificationStatus: 'unclassified' }]).classificationStatus, 'unclassified');
  assert.equal(deriveDataPolicy([{ ...general, dataClass: 'personal' }, general]).dataClass, 'personal');
});
test('validated policy and derived tags cannot be weakened through a retained mutable input', () => {
  const input = { ...seoul, dataClass: 'clinical', sensitivityTags: ['government-id'] };
  const policy = parseDataPolicy(input);
  input.sensitivityTags.length = 0;
  assert.deepEqual(policy.sensitivityTags, ['clinical-origin', 'government-id', 'health']);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.sensitivityTags), true);
});
test('verified inputs cannot classify newly generated content without examining that output', () => {
  const derived = deriveDataPolicy([{ ...general, classificationStatus: 'verified' }]);
  assert.equal(derived.classificationStatus, 'unclassified');
  assert.throws(() => assertRegionalStorageAdmission(derived, { databaseRegion: 'sg', credentialRegion: 'sg', tenantRegion: 'sg' }), { code: 'classification_required' });
});
