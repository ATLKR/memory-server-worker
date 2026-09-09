import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, at } from '../release-validation/tests/db.mjs';
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
    assert.deepEqual(server, { type: 'http', url: config.url });
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
