import { open, realpath, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNodeValue, parseTree } from 'jsonc-parser';
import { loadDeploymentConfiguration, deploymentFingerprint, PROJECT_DIRECTORY } from './deployment-config.mjs';
import { createOperationsPlan, OperationsError, fail } from './operations-plan.mjs';
import { assessOperations } from './operations-assess.mjs';

async function bounded(path, maximum) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > maximum) fail('Operational input exceeds its size limit.');
    const buffer = Buffer.alloc(stat.size + 1); let n = 0;
    while (n < buffer.length) { const result = await file.read(buffer, n, buffer.length - n, null); if (!result.bytesRead) break; n += result.bytesRead; }
    if (n !== stat.size) fail('Operational input changed while reading.'); return buffer.subarray(0, n);
  } finally { await file.close(); }
}
function json(bytes) {
  let tree; const errors = [];
  try { tree = parseTree(new TextDecoder('utf-8', { fatal: true }).decode(bytes), errors, { disallowComments: true }); } catch { fail('Invalid operational JSON.'); }
  if (errors.length || !tree || tree.type !== 'object') fail('Invalid operational JSON.');
  const visit = (node, depth) => { if (depth > 32) fail('Operational JSON nesting exceeds its limit.'); if (node.type === 'object') { const keys = new Set(); for (const property of node.children ?? []) { const key = property.children[0].value; if (keys.has(key)) fail('Duplicate operational JSON key.'); keys.add(key); } } for (const child of node.children ?? []) visit(child, depth + 1); };
  visit(tree, 0); return getNodeValue(tree);
}
async function output(path, value) {
  const directory = await realpath(dirname(path)), repository = await realpath(resolve(PROJECT_DIRECTORY, '..')), relation = relative(repository, directory);
  if (!relation || !isAbsolute(relation) && relation !== '..' && !relation.startsWith('..' + sep)) fail('Keep operational captures outside the public repository.');
  const temp = resolve(directory, '.operations-' + randomUUID() + '.tmp'); let file;
  try { file = await open(temp, 'wx', 0o600); await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); await file.close(); file = undefined; await link(temp, path); }
  finally { await file?.close(); await unlink(temp).catch(() => {}); }
}
export async function runOperationsCommand(argv, { cwd = process.cwd(), now = Date.now(), processEnvironment = process.env } = {}) {
  const [mode, ...args] = argv, values = {}, allowed = mode === 'plan' ? ['--config', '--out'] : mode === 'assess' ? ['--config', '--snapshot', '--policy', '--out'] : [];
  if (!allowed.length) fail('Choose plan or assess.');
  for (let i = 0; i < args.length; i++) { const key = args[i], value = args[++i]; if (!allowed.includes(key) || key in values || !value || value.startsWith('-') || /[\x00-\x1f]/.test(value)) fail('Unsupported or repeated operations argument. Values are not forwarded.'); values[key] = value; }
  if (!values['--config'] || mode === 'assess' && !values['--snapshot']) fail('Specify an explicit --config and --snapshot for assessment. No production fallback is used.');
  await bounded(resolve(cwd, values['--config']), 1048576);
  const load = () => loadDeploymentConfiguration({ configPath: values['--config'], cwd, processEnvironment }), target = await load();
  const report = mode === 'plan' ? createOperationsPlan(target, { now }) : assessOperations(target, json(await bounded(resolve(cwd, values['--snapshot']), 4 * 1048576)), { now, policy: values['--policy'] ? json(await bounded(resolve(cwd, values['--policy']), 16384)) : {} });
  if (deploymentFingerprint((await load()).config) !== deploymentFingerprint(target.config)) fail('Target changed during operational assessment.');
  if (values['--out']) await output(resolve(cwd, values['--out']), report);
  return { report, exitCode: mode === 'plan' ? 0 : report.exitCode };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const { report, exitCode } = await runOperationsCommand(process.argv.slice(2)); process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = exitCode; }
  catch (error) { process.stderr.write((error instanceof OperationsError ? error.message : 'Operational assessment failed; no provider action or alert delivery occurred.') + '\n'); process.exitCode = 1; }
}
