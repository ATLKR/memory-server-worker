import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/stdio.mjs', import.meta.url));
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'native-test', version: '1' } } };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const rpc = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
async function run(messages, environment = {}, preload = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MEMORY_')) delete env[key];
  Object.assign(env, environment);
  const args = ['--experimental-strip-types'];
  args.push('--import', new URL(preload ? './routing-fetch-fixture.mjs' : './offline-fetch-fixture.mjs', import.meta.url).href);
  const child = spawn(process.execPath, [...args, entry], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const timer = setTimeout(() => child.kill(), 10000);
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  child.stdin.on('error', () => {});
  child.stdin.end(messages.map(m => typeof m === 'string' ? m : JSON.stringify(m)).join('\n') + '\n');
  const code = await closed; clearTimeout(timer);
  assert.equal(code, 0, stderr);
  return { messages: stdout.trim().split('\n').filter(Boolean).map(s => JSON.parse(s)), stderr, stdout };
}

test('stdio initializes and lists exactly five explicit tools without credentials', async () => {
  const result = await run([initialize, initialized, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].result.protocolVersion, '2025-11-25');
  assert.deepEqual(result.messages[1].result.tools.map(t => t.name), ['memory_route', 'memory_ingest', 'memory_search','memory_clear_space','memory_usage']);
  const clear=result.messages[1].result.tools.find(t=>t.name==='memory_clear_space');
  assert.equal(clear.annotations.destructiveHint,true);assert.equal(clear.annotations.readOnlyHint,false);
  assert.match(clear.description,/ALL general/);
});

test('local routing chooses Cloudflare for general and Seoul for uncertain/medical/locked', async () => {
  const classes = ['general', 'uncertain', 'medical', 'region-locked'];
  const result = await run([initialize, initialized, ...classes.map((classification, i) => rpc(i + 2, 'memory_route', { routing: { version: 1, classification } }))]);
  assert.deepEqual(result.messages.slice(1).map(r => r.result.structuredContent.route), ['agent-memory', 'seoul', 'seoul', 'seoul']);
});

test('operator Seoul lock is applied before local planning or target selection', async () => {
  const result = await run([initialize, initialized,
    rpc(2, 'memory_route', { routing: { version: 1, classification: 'general' } }),
    rpc(3, 'memory_route', { routing: { version: 1, classification: 'general', destination: 'agent-memory' } }),
    rpc(4, 'memory_search', { routing: { version: 1, classification: 'general' }, query: 'topic' })], {
    MEMORY_ROUTING_RESTRICTION: 'seoul', MEMORY_CF_SPACE_ID: 'general', MEMORY_CF_PAT: 'must-not-use',
  });
  assert.equal(result.messages[1].result.structuredContent.route, 'seoul');
  assert.equal(result.messages[2].result.structuredContent.error, 'routing_downgrade_denied');
  assert.equal(result.messages[3].result.structuredContent.error, 'route_configuration_missing');
});

test('medical consent reference requests Cloudflare locally but never overrides a hard Seoul lock', async () => {
  const routing = { version: 1, classification: 'medical', medicalCloudflareConsent: { consentId: 'existing-record', version: 1 } };
  const result = await run([initialize, initialized, rpc(2, 'memory_route', { routing })]);
  assert.equal(result.messages[1].result.structuredContent.route, 'agent-memory');
  const locked = await run([initialize, initialized, rpc(2, 'memory_route', { routing })], { MEMORY_ROUTING_RESTRICTION: 'seoul' });
  assert.equal(locked.messages[1].result.structuredContent.route, 'seoul');
});

test('one-time organization policy selects consent lookup for medical inputs while hard locks remain', async () => {
  const routing = { version: 1, classification: 'medical' };
  const env = { MEMORY_MEDICAL_CONSENT_MODE: 'organization' };
  const result = await run([initialize, initialized, rpc(2, 'memory_route', { routing })], env);
  assert.equal(result.messages[1].result.structuredContent.route, 'agent-memory');
  const locked = await run([initialize, initialized, rpc(2, 'memory_route', { routing })], { ...env, MEMORY_ROUTING_RESTRICTION: 'seoul' });
  assert.equal(locked.messages[1].result.structuredContent.route, 'seoul');
  const region = await run([initialize, initialized, rpc(2, 'memory_route', { routing: { ...routing, requiredRegion: 'kr-seoul' } })], env);
  assert.equal(region.messages[1].result.structuredContent.route, 'seoul');
});

for (const consent of ['allow', 'deny']) test(`organization policy ${consent} uses the server record before a medical upload`, async () => {
  const result = await run([initialize, initialized, rpc(2, 'memory_ingest', {
    routing: { version: 1, classification: 'medical' }, operationId: 'company-fixture-1',
    messages: [{ role: 'user', content: 'private medical fixture' }],
  })], { MEMORY_MEDICAL_CONSENT_MODE: 'organization', MEMORY_TEST_ORGANIZATION_CONSENT: consent,
    MEMORY_CF_ORIGIN: 'https://cf.fixture.test', MEMORY_CF_SPACE_ID: 'general', MEMORY_CF_PAT: 'cf-token' }, true);
  const response = result.messages.find(message => message.id === 2).result;
  if (consent === 'allow') {
    assert.equal(response.structuredContent.routing.route, 'agent-memory');
    assert.equal(response.content[0].text, 'fixture result');
  } else {
    assert.equal(response.structuredContent.error, 'routing_consent_unavailable');
    assert.equal(response.isError, true);
  }
  assert.equal(result.stdout.includes('private medical fixture'), false);
});

test('a server denied general Space check stops raw content in the packaged stdio flow',async()=>{
  const marker='server-locked-private-content';
  const result=await run([initialize,initialized,rpc(2,'memory_ingest',{
    routing:{version:1,classification:'general'},operationId:'locked-operation',messages:[{role:'user',content:marker}],
  })],{MEMORY_TEST_GENERAL_CHECK:'deny',MEMORY_CF_ORIGIN:'https://cf.fixture.test',MEMORY_CF_SPACE_ID:'general',MEMORY_CF_PAT:'cf-token'},true);
  const response=result.messages.find(message=>message.id===2).result;
  assert.equal(response.structuredContent.error,'routing_preflight_unavailable');assert.equal(response.isError,true);
  assert.equal(result.stdout.includes(marker),false);assert.equal(result.stderr.includes(marker),false);
});

test('invalid routing and unconfigured remote calls never echo private arguments', async () => {
  const marker = 'DO-NOT-ECHO-private-medical-note';
  const result = await run([initialize, initialized,
    rpc(2, 'memory_route', { routing: { version: 1, classification: 'medical', destination: 'agent-memory' } }),
    rpc(3, 'memory_route', { routing: { version: 1, classification: marker } }),
    rpc(4, 'memory_ingest', { routing: { version: 1, classification: 'medical' }, operationId: 'a', messages: [{ role: 'user', content: marker }] }),
    rpc(5, 'memory_search', { routing: { version: 1, classification: 'general' }, query: marker })]);
  assert.equal(result.messages.length, 5);
  assert.ok(result.messages.slice(1).every(r => r.result.isError === true));
  assert.equal(result.stdout.includes(marker), false);
  assert.equal(result.stderr.includes(marker), false);
});

test('malformed protocol and tool notifications cannot perform operations', async () => {
  const result = await run(['{bad json', [], rpc(2, 'memory_route', { routing: { version: 1, classification: 'general' } }), initialize, initialized,
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'memory_ingest', arguments: {} } },
    rpc(3, 'unknown', {}), rpc(4, 'memory_route', { routing: { version: 1, classification: 'general' }, trustedRestrictions: [] }),
    { jsonrpc: '2.0', id: 5, method: 'ping' }]);
  assert.equal(result.messages.length, 7);
  assert.deepEqual(result.messages.slice(0, 3).map(r => r.error.code), [-32700, -32600, -32000]);
  assert.equal(result.messages[4].error.code, -32602);
  assert.equal(result.messages[5].result.isError, true);
  assert.deepEqual(result.messages[6].result, {});
});

test('oversized input is discarded once and the next complete message is parsed', async () => {
  const result = await run(['x'.repeat(8 * 1024 * 1024 + 1), initialize, initialized, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0].error.code, -32600);
  assert.deepEqual(result.messages[2].result, {});
});

test('independent route-safe searches can be in flight together with route-specific tokens', async () => {
  const result = await run([initialize, initialized,
    rpc(2, 'memory_search', { routing: { version: 1, classification: 'general' }, query: 'public topic' }),
    rpc(3, 'memory_search', { routing: { version: 1, classification: 'medical' }, query: 'clinical topic' })], {
    MEMORY_CF_ORIGIN: 'https://cf.fixture.test', MEMORY_CF_SPACE_ID: 'general', MEMORY_CF_PAT: 'cf-token',
    MEMORY_SEOUL_ORIGIN: 'https://seoul.fixture.test', MEMORY_SEOUL_SPACE_ID: 'clinical', MEMORY_SEOUL_SSO_TOKEN: 'seoul-token',
  }, true);
  assert.equal(result.messages.length, 3);
  assert.deepEqual(result.messages.slice(1).map(r => r.result.structuredContent.routing.route).sort(), ['agent-memory', 'seoul']);
  assert.ok(result.messages.slice(1).every(r => r.result.content[0].text === 'fixture result'));
});

async function cancellationClient(t, phase) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MEMORY_') || key === 'NODE_OPTIONS') delete env[key];
  Object.assign(env, { MEMORY_TEST_CANCEL_PHASE: phase, MEMORY_CF_ORIGIN: 'https://cf.fixture.test',
    MEMORY_CF_SPACE_ID: 'general', MEMORY_CF_PAT: 'cf-token' });
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', new URL('./routing-fetch-fixture.mjs', import.meta.url).href, entry],
    { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { child.kill(); });
  const responses = [], events = [], observers = new Set();
  let buffer = '', stderr = '';
  const notify = () => { for (const observe of observers) observe(); };
  child.stdout.setEncoding('utf8').on('data', data => {
    buffer += data;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); responses.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
    }
    notify();
  });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  child.on('message', event => { events.push(event); notify(); });
  child.stdin.on('error', () => {});
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  const wait = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observers.delete(observe); reject(new Error('Cancellation was not processed while the provider was held. ' + stderr)); }, 2000);
    const observe = () => { if (predicate()) { clearTimeout(timer); observers.delete(observe); resolve(); } };
    observers.add(observe); observe();
  });
  const send = messages => child.stdin.write(messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  const ingest = id => rpc(id, 'memory_ingest', { routing: { version: 1, classification: 'general' }, operationId: 'op-' + id,
    messages: [{ role: 'user', content: 'private fixture content' }] });
  const cancel = requestId => ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'user cancellation' } });
  send([initialize, initialized]);
  return { send, wait, ingest, cancel, responses, events, async finish() {
    child.send({ release: true }); child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    const code = await closed; clearTimeout(timer); assert.equal(code, 0, stderr);
  } };
}

test('cancellation during held metadata prevents the subsequent upload', async t => {
  const client = await cancellationClient(t, 'metadata');
  client.send([client.ingest(2)]);
  await client.wait(() => client.events.some(event => event.phase === 'metadata'));
  client.send([client.cancel(2), { jsonrpc: '2.0', id: 99, method: 'ping' }]);
  await client.wait(() => client.responses.some(response => response.id === 2) && client.responses.some(response => response.id === 99));
  assert.equal(client.responses.find(response => response.id === 2).result.structuredContent.error, 'routing_request_aborted');
  await client.finish();
  assert.equal(client.events.filter(event => event.phase === 'post').length, 0);
  assert.equal(client.events.filter(event => event.phase === 'general-check').length, 0);
});

test('queue-full cancellation immediately removes queued uploads and aborts an active request', async t => {
  const client = await cancellationClient(t, 'metadata');
  client.send([2, 3, 4, 5].map(client.ingest));
  await client.wait(() => client.events.filter(event => event.phase === 'metadata').length === 4);
  const queuedIds = Array.from({ length: 16 }, (_, index) => index + 6);
  client.send([...queuedIds.map(client.ingest), client.ingest(22), ...queuedIds.map(client.cancel),
    client.cancel(2), { jsonrpc: '2.0', id: 99, method: 'ping' }]);
  await client.wait(() => [2, ...queuedIds, 22, 99].every(id => client.responses.some(response => response.id === id)));
  assert.equal(client.responses.find(response => response.id === 22).error.message, 'Request queue full');
  for (const id of [2, ...queuedIds]) assert.equal(client.responses.find(response => response.id === id).result.structuredContent.error, 'routing_request_aborted');
  assert.equal(client.events.filter(event => event.phase === 'metadata').length, 4);
  await client.finish();
  assert.equal(client.events.filter(event => event.phase === 'general-check').length, 3);
  assert.deepEqual(client.events.filter(event => event.phase === 'post').map(event => event.operationId).sort(), ['op-3', 'op-4', 'op-5']);
});

test('cancelling an already-dispatched upload preserves the unknown write outcome', async t => {
  const client = await cancellationClient(t, 'post');
  client.send([client.ingest(2)]);
  await client.wait(() => client.events.some(event => event.phase === 'post'));
  client.send([client.cancel(2)]);
  await client.wait(() => client.responses.some(response => response.id === 2));
  assert.equal(client.responses.find(response => response.id === 2).result.structuredContent.error, 'routing_write_outcome_unknown');
  await client.finish();
  assert.equal(client.events.filter(event => event.phase === 'general-check').length, 1);
  assert.equal(client.events.filter(event => event.phase === 'post').length, 1);
});
