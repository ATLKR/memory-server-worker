// Native child-process test fixture. No real request is made, including on an unexpected URL.
import assert from 'node:assert/strict';
const pending = [];
const cancelPhase = process.env.MEMORY_TEST_CANCEL_PHASE;
const organizationConsent = process.env.MEMORY_TEST_ORGANIZATION_CONSENT;
let consentChecks = 0, consentUploads = 0;
if (organizationConsent) process.on('exit', () => {
  assert.equal(consentChecks, 1);
  assert.equal(consentUploads, organizationConsent === 'allow' ? 1 : 0);
});
const held = [];
if (cancelPhase) {
  process.on('message', message => { if (message?.release === true) for (const release of held.splice(0)) release(); });
  process.channel?.unref();
}
globalThis.fetch = async (url, init) => {
  const target = new URL(url);
  const cf = target.origin === 'https://cf.fixture.test';
  assert.ok(cf || target.origin === 'https://seoul.fixture.test');
  assert.equal(init.redirect, 'error');
  if (target.pathname === '/.well-known/memory-routing') {
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.body, undefined);
    if (cancelPhase) {
      process.send?.({ phase: 'metadata' });
      if (cancelPhase !== 'post') await new Promise(resolve => held.push(resolve));
    }
    return Response.json({ version: 1, protocol: 'memory-routing-v1', target: cf
      ? { route: 'agent-memory', storage: 'cloudflare-agent-memory', vector: 'managed-agent-memory', region: 'cloudflare', ready: true }
      : { route: 'seoul', storage: 'postgres', vector: 'pgvector', region: 'kr-seoul', ready: true } });
  }
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, cf ? 'Bearer cf-token' : 'Bearer seoul-token');
  const request = JSON.parse(init.body);
  if (organizationConsent && target.pathname === '/v1/routing/consent/check') {
    consentChecks++;
    assert.equal(cf, true);
    assert.deepEqual(Object.keys(request).sort(), ['consent', 'operation', 'requestId', 'spaceId', 'version']);
    assert.deepEqual(request.consent, { mode: 'organization' });
    assert.equal(request.spaceId, 'general');
    assert.equal(request.operation, 'memory_ingest');
    if (organizationConsent !== 'allow') return new Response(null, { status: 403 });
    return Response.json({ version: 1, allowed: true, requestId: request.requestId, spaceId: request.spaceId,
      consentId: 'server-company-record', consentVersion: 7, operation: request.operation,
      expiresAtMs: Date.now() + 60000, receipt: 'scoped-fixture-receipt' });
  }
  assert.equal(target.pathname, '/mcp');
  if (organizationConsent) {
    consentUploads++;
    assert.equal(organizationConsent, 'allow');
    assert.equal(consentChecks, 1);
    assert.equal(init.headers['x-memory-consent-receipt'], 'scoped-fixture-receipt');
    assert.deepEqual(request.params.arguments.routing.medicalCloudflareConsent, { consentId: 'server-company-record', version: 7 });
    assert.equal(request.params.arguments.messages[0].content, 'private medical fixture');
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'fixture result' }] } });
  }
  if (cancelPhase) {
    process.send?.({ phase: 'post', operationId: request.params.arguments.operationId });
    if (cancelPhase === 'post') await new Promise(resolve => held.push(resolve));
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'fixture result' }] } });
  }
  assert.equal(request.params.arguments.spaceId, cf ? 'general' : 'clinical');
  assert.equal(request.params.arguments.query, cf ? 'public topic' : 'clinical topic');
  return new Promise(resolve => {
    pending.push(() => resolve(Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'fixture result' }] } })));
    if (pending.length === 2) for (const release of pending) release();
  });
};
