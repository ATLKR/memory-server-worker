import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse } from 'jsonc-parser';
import { runDeploymentCommand } from './deployment-command.mjs';
import { PROJECT_DIRECTORY, deploymentFingerprint } from './deployment-config.mjs';

const production = parse(await readFile(join(PROJECT_DIRECTORY, 'wrangler.jsonc'), 'utf8'));
const entry = join(PROJECT_DIRECTORY, 'src/worker.ts');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'memory source binding '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = structuredClone(production);
  config.main = entry;
  const path = join(directory, 'external target.jsonc');
  const calls = [];
  return { config, path, directory, calls, async run(operation = 'deploy') {
    await writeFile(path, JSON.stringify(config));
    return runDeploymentCommand([operation, '--config', path], {
      npmCliPath: 'npm-cli.js', inspectSource: async () => ({ revision: 'a'.repeat(40), dirty: false }),
      runner: async (...args) => calls.push(args),
    });
  } };
}

test('external Worker content cannot inherit the reviewed checkout revision', async t => {
  const f = await fixture(t);
  f.config.main = join(f.directory, 'unreviewed-worker.mjs');
  await writeFile(f.config.main, 'export default {fetch(){return new Response("unreviewed")}}');
  const fingerprint = deploymentFingerprint(f.config);
  await writeFile(f.config.main, 'export default {fetch(){return new Response("different")}}');
  assert.equal(deploymentFingerprint(f.config), fingerprint, 'configuration alone does not bind external bytes');
  await assert.rejects(f.run(), /reviewed.*(entry|source)|entry.*reviewed/i);
  assert.equal(f.calls.length, 0);
});

for (const main of ['src/worker.ts', null, 123, '']) test('external configuration never silently rebases main: ' + JSON.stringify(main), async t => {
  const f = await fixture(t); f.config.main = main;
  await assert.rejects(f.run('build'), /reviewed.*(entry|source)|entry.*reviewed/i);
  assert.equal(f.calls.length, 0);
});

for (const [key, value] of Object.entries({
  build: { command: 'node external-generator.mjs' }, alias: { './app': '/private/app.ts' },
  assets: { directory: '/private/assets' }, site: { bucket: '/private/site' },
  wasm_modules: { MODULE: '/private/module.wasm' }, text_blobs: { TEXT: '/private/content.txt' },
  data_blobs: { DATA: '/private/data.bin' }, rules: [{ type: 'Text', globs: ['**/*.txt'] }],
  find_additional_modules: true, base_dir: '/private', no_bundle: true,
  tsconfig: '/private/tsconfig.json', define: { BUILD_SOURCE_REVISION: '"forged"' },
  jsx_factory: 'unreviewed.create', jsx_fragment: 'unreviewed.fragment',
})) test('reviewed build refuses configurable source override: ' + key, async t => {
  const f = await fixture(t); f.config[key] = value;
  await assert.rejects(f.run(), /source.*override|override.*source/i);
  assert.equal(f.calls.length, 0);
});

for (const mode of ['absolute', 'relative']) test('standalone configuration may explicitly select reviewed Memory source: ' + mode, async t => {
  const f = await fixture(t);
  if (mode === 'relative') f.config.main = relative(f.directory, entry);
  await f.run();
  assert.equal(f.calls.length, 2);
  const args = f.calls[1][1], at = args.indexOf('--tsconfig');
  assert.notEqual(at, -1);
  assert.equal(args[at + 1], join(PROJECT_DIRECTORY, 'tsconfig.json'));
  assert.ok(args.includes('BUILD_SOURCE_REVISION:' + JSON.stringify('a'.repeat(40))));
});

test('another tracked module is not substituted for the Memory entry point', async t => {
  const f = await fixture(t); f.config.main = join(PROJECT_DIRECTORY, 'src/auth.ts');
  await assert.rejects(f.run(), /reviewed.*(entry|source)|entry.*reviewed/i);
  assert.equal(f.calls.length, 0);
});
