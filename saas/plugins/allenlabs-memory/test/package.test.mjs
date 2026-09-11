import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { validatePackage } from '../scripts/validate-package.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'memory-plugin-package-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'allenlabs-memory');
  for (const path of ['.codex-plugin', 'scripts', 'skills/memory-routing']) await mkdir(join(root, path), { recursive: true });
  for (const file of ['.codex-plugin/plugin.json', '.mcp.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'skills/memory-routing/SKILL.md']) {
    await writeFile(join(root, file), await readFile(new URL('../' + file, import.meta.url)));
  }
  await writeFile(join(root, 'scripts/mcp-stdio.mjs'), 'process.stdin.resume();\n');
  return root;
}

test('accepts a package with self-contained runtime paths and no hooks', async t => {
  assert.deepEqual(await validatePackage(await fixture(t)), []);
});
test('missing build output prevents distribution', async t => {
  const root = await fixture(t);
  await rm(join(root, 'scripts/mcp-stdio.mjs'));
  assert.ok((await validatePackage(root)).includes('missing:scripts/mcp-stdio.mjs'));
});
test('automatic hook files are rejected even when omitted from plugin manifest', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'hooks.json'), '{"hooks":{}}');
  assert.ok((await validatePackage(root)).some(error => error.startsWith('unexpected:')));
});
test('a command or path change cannot silently bypass the reviewed stdio bundle', async t => {
  const root = await fixture(t);
  for (const server of [
    { command: 'npx', args: ['remote-package'] },
    { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/../../outside.mjs'] },
    { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp-stdio.mjs'], env: { MEMORY_CF_PAT: 'embedded-credential' } },
  ]) {
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'allenlabs-memory': server } }));
    assert.ok((await validatePackage(root)).includes('mcp_configuration_invalid'));
  }
});
test('unexpected local credentials and malformed manifests are rejected', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.env'), 'MEMORY_CF_PAT=private');
  await writeFile(join(root, '.codex-plugin/plugin.json'), '{}');
  const issues = await validatePackage(root);
  assert.ok(issues.includes('unexpected:.env'));
  assert.ok(issues.includes('plugin_manifest_invalid'));
});

test('built bundle runs from an isolated package copy without source checkout or npm modules', async t => {
  const root = await fixture(t);
  const bundle = await readFile(new URL('../scripts/mcp-stdio.mjs', import.meta.url));
  await writeFile(join(root, 'scripts/mcp-stdio.mjs'), bundle);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MEMORY_') || key === 'NODE_PATH' || key === 'NODE_OPTIONS') delete env[key];
  const child = spawn(process.execPath, [join(root, 'scripts/mcp-stdio.mjs')], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
  const timer = setTimeout(() => child.kill(), 5000);
  const exit = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  child.stdin.on('error', () => {});
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'package-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_route', arguments: { routing: { version: 1, classification: 'uncertain' } } } },
  ].map(m => JSON.stringify(m)).join('\n') + '\n');
  const code = await exit; clearTimeout(timer);
  assert.equal(code, 0, stderr);
  const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.equal(messages[1].result.structuredContent.route, 'seoul');
});
