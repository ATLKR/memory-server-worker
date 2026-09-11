import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const required = ['.codex-plugin/plugin.json', '.mcp.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'skills/memory-routing/SKILL.md', 'scripts/mcp-stdio.mjs'];
const allowed = new Set([...required, 'src/config.mjs', 'src/stdio.mjs', 'scripts/validate-package.mjs',
  'test/config.test.mjs', 'test/stdio.test.mjs', 'test/package.test.mjs', 'test/routing-fetch-fixture.mjs', 'test/offline-fetch-fixture.mjs']);
const expectedMcp = { mcpServers: { 'allenlabs-memory': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp-stdio.mjs'] } } };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function validatePackage(directory) {
  const root = resolve(directory), issues = [], files = new Set();
  try {
    if ((await lstat(root)).isSymbolicLink()) return ['package_symlink'];
    const walk = async (relative = '') => {
      for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
        const path = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isSymbolicLink()) issues.push('symlink:' + path);
        else if (entry.isDirectory()) {
          if (![...allowed].some(file => file.startsWith(path + '/'))) issues.push('unexpected:' + path);
          else await walk(path);
        } else if (!entry.isFile() || !allowed.has(path)) issues.push('unexpected:' + path);
        else files.add(path);
      }
    };
    await walk();
  } catch { return ['package_unreadable']; }
  for (const path of required) if (!files.has(path)) issues.push('missing:' + path);
  try {
    const manifest = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
    const valid = basename(root) === 'allenlabs-memory' && isObject(manifest) && manifest.name === 'allenlabs-memory'
      && typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)
      && typeof manifest.description === 'string' && manifest.description.length > 0
      && manifest.author?.name && manifest.interface?.displayName
      && manifest.skills === './skills/' && manifest.mcpServers === './.mcp.json'
      && !('hooks' in manifest) && !('apps' in manifest)
      && !JSON.stringify(manifest).includes('[TODO:');
    if (!valid) issues.push('plugin_manifest_invalid');
  } catch { issues.push('plugin_manifest_invalid'); }
  try {
    const manifest = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
    if (!isDeepStrictEqual(manifest, expectedMcp)) issues.push('mcp_configuration_invalid');
  } catch { issues.push('mcp_configuration_invalid'); }
  try {
    const skill = await readFile(join(root, 'skills/memory-routing/SKILL.md'), 'utf8');
    if (!skill.startsWith('---\nname: memory-routing\n') || !skill.includes('\ndescription: ')
        || !skill.includes('\n---\n')) issues.push('skill_manifest_invalid');
  } catch { issues.push('skill_manifest_invalid'); }
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const issues = await validatePackage(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
  if (issues.length) { process.stderr.write(issues.join('\n') + '\n'); process.exitCode = 1; }
  else process.stdout.write('Allen Labs Memory package validation passed.\n');
}
