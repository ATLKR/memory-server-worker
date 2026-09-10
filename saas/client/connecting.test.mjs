import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPair, SignJWT } from 'jose';
import { DB, fixture, at } from '../release-validation/tests/db.mjs';
import { Admin } from '../src/release/admin.ts';
import { createRelease } from '../src/release/extension.ts';
import { createApplication } from '../src/app.ts';
import { AUTH_ISSUER, SERVICE_ID, readSettings } from '../src/config.ts';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const config = read('./claude.pat.json').mcpServers['allenlabs-memory'];
const examples = read('./mcp-examples.json');
async function jsonRpc(response) {
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6))
    : JSON.parse(text);
}

test('PAT request and native HTTP template work with the actual local SaaS MCP contract', async () => {
  const { db, token } = await fixture();
  try {
    const env = { DB: db, PUBLIC_ORIGIN: new URL(config.url).origin };
    const request = { ...read('./pat-request.personal.json'), spaceIds: ['s1'] };
    const issued = await new Admin(env, () => at).issueKey(token, request);
    const headers = Object.fromEntries(Object.entries(config.headers).map(([name, value]) => [name, value.replace('${MEMORY_SAAS_PAT}', issued.token)]));
    const app = createApplication(db, readSettings({ PUBLIC_ORIGIN: env.PUBLIC_ORIGIN }), { clock: () => at, release: createRelease(env, { clock: () => at }) });
    let rpcId = 0;
    const rpc = (method, params) => app(new Request(config.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })).then(jsonRpc);
    const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'template-validation', version: '1' } });
    assert.equal(initialized.result.serverInfo.name, SERVICE_ID);
    const tools = (await rpc('tools/list', {})).result.tools;
    for (const example of Object.values(examples)) {
      const tool = tools.find(tool => tool.name === example.name);
      assert.ok(tool, 'Documented MCP tool must exist: ' + example.name);
      for (const key of tool.inputSchema.required ?? []) assert.ok(key in example.arguments, 'Missing documented argument: ' + key);
      for (const key of Object.keys(example.arguments)) assert.ok(key in tool.inputSchema.properties, 'Unknown documented argument: ' + key);
    }
    const call = async (example, substitutions = {}) => {
      const result = (await rpc('tools/call', { ...example, arguments: { ...example.arguments, ...substitutions } })).result;
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    assert.deepEqual((await call(examples.listSpaces)).results.map(space => space.id), ['s1']);
    const created = await call(examples.add, { spaceId: 's1', operationId: 'template-create' });
    const memory = await call(examples.get, { spaceId: 's1', memoryId: created.id });
    assert.equal(memory.body, examples.add.arguments.body);
    const updated = await call(examples.update, { spaceId: 's1', memoryId: created.id, expectedRevision: memory.revision, operationId: 'template-update' });
    assert.equal(updated.revision, 2);
    const orgInput = { ...read('./pat-request.organization.json'), spaceIds: ['so'], organizationId: 'org' };
    assert.deepEqual((await new Admin(env, () => at).issueKey(token, orgInput)).spaceIds, ['so']);
  } finally { db.close(); }
});

test('SSO template relies on protected resource discovery and carries no token or console client ID', async () => {
  const { db } = await fixture();
  try {
    const server = read('./claude.sso.json').mcpServers[SERVICE_ID];
    assert.deepEqual(Object.keys(server).sort(), ['oauth', 'type', 'url']);
    assert.equal(server.type, 'http');
    assert.equal(server.url, config.url);
    assert.equal(typeof server.oauth.scopes, 'string');
    const app = createApplication(db, readSettings({ PUBLIC_ORIGIN: new URL(server.url).origin }), { clock: () => at });
    const response = await app(new Request(server.url, { method: 'POST' }));
    assert.equal(response.status, 401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(response.headers.get('www-authenticate'))[1];
    const metadata = await (await app(new Request(metadataUrl))).json();
    assert.equal(metadata.resource, new URL(server.url).origin);
    assert.deepEqual(metadata.authorization_servers, [AUTH_ISSUER]);
    assert.ok(metadata.scopes_supported.includes('memory:read'));
  } finally { db.close(); }
});

test('SSO template requests scopes that permit memory writes after a read-only challenge', async () => {
  const db = new DB(); db.migrate();
  try {
    const server = read('./claude.sso.json').mcpServers[SERVICE_ID];
    const origin = new URL(server.url).origin;
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const env = { DB: db, PUBLIC_ORIGIN: origin, SSO_CLIENT_ID: 'browser-only-client' };
    const app = createApplication(db, readSettings(env), {
      clock: () => at, auth: { jwks: async () => publicKey }, release: createRelease(env, { clock: () => at }),
    });
    const challenge = await app(new Request(server.url, { method: 'POST' }));
    assert.equal(challenge.status, 401);
    const challengeScope = /(?:^|[, ])scope="([^"]+)"/.exec(challenge.headers.get('www-authenticate'))[1];
    assert.equal(challengeScope, 'memory:read');
    // Claude Code uses pinned oauth.scopes first, then the challenge scope.
    // With the original template this grants read only, so memory_add fails.
    const requestedScope = server.oauth?.scopes ?? challengeScope;
    const sign = scope => new SignJWT({ token_use: 'access', client_id: 'template-client', azp: 'template-client', scope,
      email: 'template-user@example.test', emailVerified: true })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).setIssuer(AUTH_ISSUER).setAudience(origin)
      .setSubject('template-user').setJti(crypto.randomUUID()).setIssuedAt(at / 1000).setExpirationTime(at / 1000 + 900).sign(privateKey);
    const accessToken = await sign(requestedScope);
    let rpcId = 0;
    const request = (token, name, args = {}) => app(new Request(server.url, { method: 'POST', headers: {
        authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) }));
    const call = async (token, name, args = {}) => {
      const reply = await jsonRpc(await request(token, name, args));
      return { failed: reply.result.isError === true, value: JSON.parse(reply.result.content[0].text) };
    };
    const spaces = await call(accessToken, 'memory_spaces');
    assert.equal(spaces.failed, false);
    const spaceId = spaces.value.results[0].id;
    const created = await call(accessToken, 'memory_add', { spaceId, body: 'Template-authorized write', operationId: 'sso-template-create' });
    assert.equal(created.failed, false, JSON.stringify(created.value));
    const memoryId = created.value.id;
    assert.equal((await call(accessToken, 'memory_get', { spaceId, memoryId })).value.body, 'Template-authorized write');
    const updated = await call(accessToken, 'memory_update', { spaceId, memoryId, body: 'Updated', expectedRevision: 1, operationId: 'sso-template-update' });
    assert.equal(updated.failed, false, JSON.stringify(updated.value));
    const readOnlyToken = await sign('memory:read');
    assert.equal((await call(readOnlyToken, 'memory_get', { spaceId, memoryId })).failed, false);
    const denied = await request(readOnlyToken, 'memory_add', { spaceId, body: 'Denied', operationId: 'sso-template-denied' });
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get('www-authenticate'), /Bearer.*error="insufficient_scope"/);
    assert.match(denied.headers.get('www-authenticate'), /scope="memory:read memory:write"/);
    assert.deepEqual(await denied.json(), { error: 'insufficient_scope' });
    assert.equal((await call(accessToken, 'memory_delete', { spaceId, memoryId, expectedRevision: 2, operationId: 'sso-template-delete' })).failed, false);
  } finally { db.close(); }
});
