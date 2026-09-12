import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRouteConfiguration, loadRoutingRestrictions, applyOperatorRouting } from '../src/config.mjs';
import * as config from '../src/config.mjs';

test('selected route receives only its own target and credential', async () => {
  const env = { MEMORY_CF_SPACE_ID: 'general', MEMORY_CF_PAT: 'cf-secret',
    MEMORY_SEOUL_ORIGIN: 'https://seoul.example.test', MEMORY_SEOUL_SPACE_ID: 'clinical',
    MEMORY_SEOUL_SSO_TOKEN: 'seoul-secret', MEMORY_PAT: 'legacy-secret' };
  const cf = loadRouteConfiguration('agent-memory', env);
  assert.deepEqual(cf.targets, { 'agent-memory': { origin: 'https://memory.allenlabs.org', spaceId: 'general' } });
  assert.deepEqual(await cf.credential({ route: 'agent-memory', origin: 'https://memory.allenlabs.org' }), { kind: 'pat', token: 'cf-secret' });
  await assert.rejects(cf.credential({ route: 'seoul', origin: 'https://seoul.example.test' }), /credential_target_mismatch/);
  await assert.rejects(cf.credential({ route: 'agent-memory', origin: 'https://attacker.example.test' }), /credential_target_mismatch/);
  const seoul = loadRouteConfiguration('seoul', env);
  assert.deepEqual(await seoul.credential({ route: 'seoul', origin: 'https://seoul.example.test' }), { kind: 'sso', token: 'seoul-secret' });
});

test('Seoul never inherits a Cloudflare or legacy credential', () => {
  assert.throws(() => loadRouteConfiguration('seoul', { MEMORY_CF_PAT: 'cf', MEMORY_PAT: 'legacy' }), /route_configuration_missing/);
  assert.throws(() => loadRouteConfiguration('seoul', { MEMORY_SEOUL_ORIGIN: 'https://seoul.example.test', MEMORY_SEOUL_SPACE_ID: 'a', MEMORY_CF_PAT: 'cf' }), /route_credential_missing/);
});

test('rejects selected-route ambiguity and malformed target before network', () => {
  const base = { MEMORY_CF_SPACE_ID: 'space', MEMORY_CF_PAT: 'secret' };
  assert.throws(() => loadRouteConfiguration('agent-memory', { ...base, MEMORY_CF_SSO_TOKEN: 'other' }), /route_credential_conflict/);
  for (const origin of ['http://example.test', 'https://example.test/path', 'https://user:pass@example.test', 'https://example.test/?x=y', 'https://example.test/#fragment']) {
    assert.throws(() => loadRouteConfiguration('agent-memory', { ...base, MEMORY_CF_ORIGIN: origin }), /route_configuration_invalid/);
  }
  assert.throws(() => loadRouteConfiguration('agent-memory', { ...base, MEMORY_CF_PAT: 'secret\nvalue' }), /route_credential_invalid/);
  assert.throws(() => loadRouteConfiguration('unknown', base), /route_configuration_invalid/);
});

test('unselected route configuration does not block a configured route', () => {
  assert.doesNotThrow(() => loadRouteConfiguration('agent-memory', { MEMORY_CF_SPACE_ID: 'space', MEMORY_CF_PAT: 'secret', MEMORY_SEOUL_PAT: 'one', MEMORY_SEOUL_SSO_TOKEN: 'two' }));
});

test('Seoul protocol selection is metadata-only, exact and defaults to v1',()=>{
  assert.equal(typeof config.loadSeoulRoutingProtocol,'function');
  const env={};for(const key of ['MEMORY_SEOUL_PAT','MEMORY_SEOUL_SSO_TOKEN','MEMORY_SEOUL_ORIGIN','MEMORY_SEOUL_SPACE_ID'])
    Object.defineProperty(env,key,{get(){throw Error('sensitive configuration was read');}});
  assert.equal(config.loadSeoulRoutingProtocol(env),'memory-routing-v1');
  env.MEMORY_SEOUL_ROUTING_PROTOCOL='memory-routing-v2';assert.equal(config.loadSeoulRoutingProtocol(env),'memory-routing-v2');
  for(const protocol of [null,1,{},'', 'v2', 'memory-routing-v3', ' memory-routing-v2', 'memory-routing-v2 '])
    assert.throws(()=>config.loadSeoulRoutingProtocol({MEMORY_SEOUL_ROUTING_PROTOCOL:protocol}),/route_configuration_invalid/);
});

test('only an explicit Seoul v2 setting is attached to the selected remote endpoint',()=>{
  const env={MEMORY_CF_SPACE_ID:'general',MEMORY_CF_PAT:'cf-secret',MEMORY_SEOUL_ORIGIN:'https://seoul.example.test',MEMORY_SEOUL_SPACE_ID:'clinical',MEMORY_SEOUL_PAT:'seoul-secret',MEMORY_SEOUL_ROUTING_PROTOCOL:'memory-routing-v2'};
  assert.deepEqual(loadRouteConfiguration('seoul',env).targets,{seoul:{origin:'https://seoul.example.test',spaceId:'clinical',protocol:'memory-routing-v2'}});
  assert.deepEqual(loadRouteConfiguration('agent-memory',env).targets,{'agent-memory':{origin:'https://memory.allenlabs.org',spaceId:'general'}});
  env.MEMORY_SEOUL_ROUTING_PROTOCOL='invalid';assert.throws(()=>loadRouteConfiguration('seoul',env),/route_configuration_invalid/);
  assert.doesNotThrow(()=>loadRouteConfiguration('agent-memory',env));
});

test('operator routing restriction only accepts the known Seoul lock', () => {
  assert.deepEqual(loadRoutingRestrictions({}), []);
  assert.deepEqual(loadRoutingRestrictions({ MEMORY_ROUTING_RESTRICTION: 'seoul' }), [{ route: 'seoul', requiredRegion: 'kr-seoul' }]);
  for (const value of ['agent-memory', '', 'kr-seoul', 'unknown']) assert.throws(() => loadRoutingRestrictions({ MEMORY_ROUTING_RESTRICTION: value }), /routing_configuration_invalid/);
});

test('one-time organization consent mode only supplements absent medical selectors without changing input', () => {
  const medical = { version: 1, classification: 'medical' };
  const env = { MEMORY_MEDICAL_CONSENT_MODE: 'organization' };
  assert.deepEqual(applyOperatorRouting(medical), medical);
  assert.deepEqual(applyOperatorRouting(medical, env), { ...medical, medicalCloudflareConsent: { mode: 'organization' } });
  assert.deepEqual(medical, { version: 1, classification: 'medical' });
  const explicit = { ...medical, medicalCloudflareConsent: { consentId: 'existing', version: 2 } };
  assert.deepEqual(applyOperatorRouting(explicit, env), explicit);
  for (const classification of ['general', 'uncertain', 'region-locked']) {
    const input = { version: 1, classification };
    assert.deepEqual(applyOperatorRouting(input, env), input);
  }
  for (const mode of ['', 'yes', 'individual']) assert.throws(() => applyOperatorRouting(medical, { MEMORY_MEDICAL_CONSENT_MODE: mode }), /routing_configuration_invalid/);
});
