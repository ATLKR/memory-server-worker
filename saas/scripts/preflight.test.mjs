import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(project, 'scripts/preflight.mjs');
const production = parse(await readFile(join(project, 'wrangler.jsonc'), 'utf8'));
const cleanSource = async () => ({ revision: 'a'.repeat(40), dirty: false });

function stagingConfig() {
  const config = structuredClone(production);
  config.name = 'memory-target-test-staging';
  config.vars.DEPLOYMENT_ENVIRONMENT = 'staging';
  config.vars.PUBLIC_ORIGIN = 'https://memory-staging.example.org';
  config.routes = [{ pattern: 'memory-staging.example.org', custom_domain: true }];
  config.d1_databases = [{ binding: 'DB', database_name: 'memory-target-test-staging', database_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', migrations_dir: 'migrations' }];
  config.r2_buckets = [{ binding: 'ARCHIVE', bucket_name: 'memory-target-test-staging-archive' }];
  return config;
}

function shardedConfig() {
  const config = stagingConfig();
  config.vars.STORAGE_MODE = 'sharded';
  config.vars.STORAGE_SHARDS_JSON = JSON.stringify([{ id: 'hot-a', binding: 'HOT_A', mode: 'active' }, { id: 'hot-b', binding: 'HOT_B', mode: 'draining' }]);
  config.d1_databases.push(
    { binding: 'HOT_A', database_name: 'memory-hot-a-staging', database_id: '11111111-2222-4333-8444-555555555555', migrations_dir: 'shard-migrations' },
    { binding: 'HOT_B', database_name: 'memory-hot-b-staging', database_id: '22222222-3333-4444-8555-666666666666', migrations_dir: 'shard-migrations' });
  config.r2_buckets = [{ binding: 'MEMORY_PAYLOADS', bucket_name: 'memory-payloads-staging' }];
  return config;
}

async function fixture(t, config = stagingConfig()) {
  const dir = await mkdtemp(join(tmpdir(), 'memory deployment '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'staging config.jsonc');
  await writeFile(path, typeof config === 'string' ? config : JSON.stringify(config));
  return { dir, path };
}

function preflight(args = [], cwd = project) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], { cwd, encoding: 'utf8' });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

test('default production preflight remains compatible', () => {
  assert.equal(preflight().status, 0);
});

test('explicit valid staging config is identified, including a path containing spaces', async t => {
  const { path } = await fixture(t);
  const result = preflight(['--config', path]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /staging/);
  assert.doesNotMatch(result.output, new RegExp(production.vars.SSO_CLIENT_ID));
});

for (const [name, mutate, message] of [
  ['production database ID', c => { c.d1_databases[0].database_id = production.d1_databases[0].database_id; }, /production.*D1|D1.*production/i],
  ['production database name', c => { c.d1_databases[0].database_name = production.d1_databases[0].database_name; }, /production.*D1|D1.*production/i],
  ['production domain', c => { c.vars.PUBLIC_ORIGIN = production.vars.PUBLIC_ORIGIN; c.routes = production.routes; }, /production.*origin|origin.*production/i],
  ['production worker name', c => { c.name = production.name; }, /production.*Worker|Worker.*production/i],
  ['extra public route', c => c.routes.push({ pattern: 'unexpected.example.org', custom_domain: true }), /route|domain/i],
  ['duplicate DB binding', c => c.d1_databases.push({ ...c.d1_databases[0], database_id: '11111111-2222-4333-8444-555555555555' }), /duplicate.*binding/i],
  ['cross-service duplicate binding', c => { c.r2_buckets[0].binding = 'DB'; }, /duplicate.*binding/i],
  ['AI duplicate binding', c => { c.ai = { binding: 'DB' }; }, /duplicate.*binding/i],
  ['nonstandard public HTTPS port', c => { c.vars.PUBLIC_ORIGIN += ':444'; }, /origin|port/i],
  ['unrestricted email binding', c => { delete c.send_email[0].allowed_sender_addresses; }, /EMAIL/],
  ['invalid environment', c => { c.vars.DEPLOYMENT_ENVIRONMENT = 'stagng'; }, /DEPLOYMENT_ENVIRONMENT/],
  ['missing custom environment', c => { delete c.vars.DEPLOYMENT_ENVIRONMENT; }, /DEPLOYMENT_ENVIRONMENT/],
  ['placeholder resource ID', c => { c.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000'; }, /D1/],
  ['malformed binding collection', c => { c.d1_databases = { DB: {} }; }, /D1|d1_databases/],
]) {
  test(`staging refuses ${name}`, async t => {
    const config = stagingConfig(); mutate(config);
    const { path } = await fixture(t, config);
    const result = preflight(['--config', path]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, message);
  });
}

for (const [name, contents] of [
  ['invalid JSONC', '{ "vars": '],
  ['duplicate JSON keys', '{ "name":"first", "name":"second" }'],
  ['non-object JSON', 'null'],
]) {
  test(`selected config rejects ${name} instead of falling back to production`, async t => {
    const { path } = await fixture(t, contents);
    const result = preflight(['--config', path]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /configuration|JSON|duplicate/i);
  });
}

test('missing selected config fails without exposing its path or falling back', async t => {
  const { dir } = await fixture(t);
  const result = preflight(['--config', join(dir, 'private-token-do-not-print.jsonc')]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /configuration/);
  assert.doesNotMatch(result.output, /private-token-do-not-print/);
});

for (const args of [
  ['--env', 'staging'], ['-e', 'staging'], ['--env=staging'],
  ['--config'], ['--config', '--env=staging'], ['--config', 'one', '--config', 'two'],
  ['--api-token=private-token-do-not-print'], ['--', '--config', 'other'], ['unexpected-private-token-do-not-print'],
]) {
  test(`arguments are rejected safely: ${args[0].split('=')[0]}`, () => {
    const result = preflight(args);
    assert.equal(result.status, 1, result.output);
    assert.doesNotMatch(result.output, /private-token-do-not-print/);
  });
}

test('staging checks all production D1/R2 resources, including preview targets', async t => {
  const { loadDeploymentConfiguration } = await import('./deployment-config.mjs');
  const { dir, path } = await fixture(t);
  const baseline = structuredClone(production);
  baseline.d1_databases.push({ binding: 'OTHER_DB', database_name: 'other-production-db', database_id: '22222222-3333-4444-8555-666666666666', preview_database_id: '33333333-4444-4555-8666-777777777777' });
  baseline.r2_buckets = [{ binding: 'ARCHIVE', bucket_name: 'production-archive', preview_bucket_name: 'production-preview-archive' }];
  const productionConfigPath = join(dir, 'production.jsonc');
  await writeFile(productionConfigPath, JSON.stringify(baseline));
  for (const mutate of [
    c => { c.d1_databases[0].database_id = baseline.d1_databases[1].database_id; },
    c => { c.d1_databases[0].preview_database_id = baseline.d1_databases[1].database_id; },
    c => { c.d1_databases[0].database_id = baseline.d1_databases[1].preview_database_id; },
    c => { c.d1_databases[0].database_name = baseline.d1_databases[1].database_name; },
    c => { c.r2_buckets[0].bucket_name = 'production-archive'; },
    c => { c.r2_buckets[0].preview_bucket_name = 'production-archive'; },
    c => { c.r2_buckets[0].bucket_name = 'production-preview-archive'; },
  ]) {
    const config = stagingConfig(); mutate(config);
    await writeFile(path, JSON.stringify(config));
    await assert.rejects(loadDeploymentConfiguration({ configPath: path, productionConfigPath }), /production (D1|R2)/);
  }
});

test('standalone JSONC supports comments, trailing commas and relative config paths', async t => {
  const { dir, path } = await fixture(t, JSON.stringify(stagingConfig()).replace(/}$/, ', // trailing comment\n}'));
  const result = preflight(['--config=staging config.jsonc'], dir);
  assert.equal(result.status, 0, result.output);
  const { loadDeploymentConfiguration } = await import('./deployment-config.mjs');
  const target = await loadDeploymentConfiguration({ configPath: 'staging config.jsonc', cwd: dir });
  assert.equal(target.path, path);
  assert.equal(target.settings.auth.issuer, 'https://auth-api.allen.company');
  assert.equal(target.settings.auth.authorizationEndpoint, 'https://auth-api.allen.company/oauth/authorize');
});

for (const operation of ['build', 'db:local', 'db:remote', 'deploy']) {
  test(`${operation} uses the exact preflighted config without shell interpolation`, async t => {
    const { runDeploymentCommand } = await import('./deployment-command.mjs');
    const { dir, path } = await fixture(t);
    const calls = [];
    await runDeploymentCommand([operation, '--config', path], {
      cwd: dir,
      inspectSource: cleanSource,
      npmCliPath: join(dir, 'npm-cli.js'),
      runner: async (command, args, options) => calls.push({ command, args, options }),
    });
    assert.equal(calls.length, operation === 'deploy' ? 2 : 1);
    const last = calls.at(-1);
    assert.equal(last.command, process.execPath);
    assert.match(last.args[0], /[/\\]wrangler[/\\]bin[/\\]wrangler\.js$/);
    assert.deepEqual(last.args.slice(-2), ['--config', path]);
    assert.equal(last.options.shell, false);
    assert.equal(last.options.cwd, project);
    if (operation === 'deploy') assert.deepEqual(calls[0].args, [join(dir, 'npm-cli.js'), 'run', 'check']);
    if (operation.startsWith('db:')) assert.deepEqual(last.args.slice(1, -2), ['d1', 'migrations', 'apply', 'DB', operation === 'db:local' ? '--local' : '--remote']);
    if (operation === 'build') {
      assert.deepEqual(last.args.slice(1, 4), ['deploy', '--dry-run', '--outdir']);
      assert.equal(last.args[4], join(project, '.local/build'));
    }
  });
}

test('invalid targets and unknown arguments execute no child and never forward credentials', async t => {
  const { runDeploymentCommand } = await import('./deployment-command.mjs');
  const config = stagingConfig(); config.d1_databases[0] = production.d1_databases[0];
  const { path } = await fixture(t, config);
  const calls = [];
  const runner = async (...args) => calls.push(args);
  for (const argv of [
    ['deploy', '--config', path], ['db:remote', '--env', 'staging'],
    ['build', '--api-token', 'private-token-do-not-print'], ['--config', path],
    ['delete', '--config', path], ['build', '--config', path, '--', 'private-token-do-not-print'],
  ]) {
    await assert.rejects(runDeploymentCommand(argv, { runner }), error => !error.message.includes('private-token-do-not-print'));
  }
  assert.equal(calls.length, 0);
});

test('failed repository checks prevent deploy and preserve the failure', async t => {
  const { runDeploymentCommand } = await import('./deployment-command.mjs');
  const { path } = await fixture(t);
  const calls = [];
  const failure = new Error('checks failed');
  await assert.rejects(runDeploymentCommand(['deploy', '--config', path], {
    npmCliPath: 'npm-cli.js', inspectSource: cleanSource, runner: async (...args) => { calls.push(args); throw failure; },
  }), error => error === failure);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['npm-cli.js', 'run', 'check']);
});

test('actual local child exit and spawn failures reject without leaking arguments', async t => {
  const { runProcess } = await import('./deployment-command.mjs');
  const { dir } = await fixture(t);
  const child = join(dir, 'local child.mjs');
  await writeFile(child, 'process.exit(Number(process.argv[2]));');
  await runProcess(process.execPath, [child, '0'], { cwd: dir, stdio: 'pipe' });
  await assert.rejects(runProcess(process.execPath, [child, '7', 'private-token-do-not-print'], { cwd: dir, stdio: 'pipe' }), /exit code 7/);
  await assert.rejects(runProcess(join(dir, 'missing-executable'), ['private-token-do-not-print'], { cwd: dir, stdio: 'pipe' }), error => !error.message.includes('private-token-do-not-print'));
});

test('ambient Wrangler target overrides cannot change the preflighted deployment target', async t => {
  const { loadDeploymentConfiguration } = await import('./deployment-config.mjs');
  const { path } = await fixture(t);
  for (const variable of ['CLOUDFLARE_ENV', 'WRANGLER_CI_OVERRIDE_NAME']) {
    await assert.rejects(loadDeploymentConfiguration({ configPath: path, processEnvironment: { [variable]: 'private-target-do-not-print' } }), error => /override|environment/i.test(error.message) && !error.message.includes('private-target-do-not-print'));
  }
});

test('a target changed while checks run is not deployed', async t => {
  const { runDeploymentCommand } = await import('./deployment-command.mjs');
  const { path } = await fixture(t);
  const calls = [];
  await assert.rejects(runDeploymentCommand(['deploy', '--config', path], {
    npmCliPath: 'npm-cli.js', inspectSource: cleanSource,
    runner: async (...args) => {
      calls.push(args);
      const changed = stagingConfig(); changed.name = 'another-staging-worker';
      await writeFile(path, JSON.stringify(changed));
    },
  }), /configuration changed/i);
  assert.equal(calls.length, 1);
});

test('deployment CLI does not print or forward rejected secret arguments', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', join(project, 'scripts/deployment-command.mjs'), 'deploy', '--api-token=private-token-do-not-print'], { cwd: project, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported deployment argument/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-token-do-not-print|wrangler deploy|npm run check/);
});

test('deployment refuses dirty source before any check or Wrangler child runs', async t => {
  const { runDeploymentCommand } = await import('./deployment-command.mjs');
  const { path } = await fixture(t);
  const calls = [];
  await assert.rejects(runDeploymentCommand(['deploy', '--config', path], {
    npmCliPath: 'npm-cli.js', inspectSource: async () => ({ revision: 'a'.repeat(40), dirty: true }),
    runner: async (...args) => calls.push(args),
  }), /clean|uncommitted/i);
  assert.equal(calls.length, 0);
});

test('build pins source and resource fingerprints with argument arrays; dirty dry-run is unreleased', async t => {
  const { runDeploymentCommand } = await import('./deployment-command.mjs');
  const { path } = await fixture(t);
  for (const dirty of [false, true]) {
    let invocation;
    await runDeploymentCommand(['build', '--config', path], {
      inspectSource: async () => ({ revision: 'a'.repeat(40), dirty }),
      runner: async (...args) => { invocation = args; },
    });
    assert.ok(invocation[1].includes('BUILD_SOURCE_REVISION:' + JSON.stringify(dirty ? 'unreleased' : 'a'.repeat(40))));
    assert.ok(invocation[1].some(arg => /^BUILD_RESOURCE_FINGERPRINT:"[a-f\d]{64}"$/.test(arg)));
  }
});

test('source changed during check is never deployed', async t => {
  const { runDeploymentCommand } = await import('./deployment-command.mjs');
  const { path } = await fixture(t);
  for (const changed of [{ revision: 'b'.repeat(40), dirty: false }, { revision: 'a'.repeat(40), dirty: true }]) {
    let inspections = 0; const calls = [];
    await assert.rejects(runDeploymentCommand(['deploy', '--config', path], {
      npmCliPath: 'npm-cli.js', inspectSource: async () => ++inspections === 1 ? cleanSource() : changed,
      runner: async (...args) => calls.push(args),
    }), /source|clean/i);
    assert.equal(calls.length, 1);
  }
});

test('resource fingerprint ignores promotion/attestation and formatting, but binds material configuration', async () => {
  const { deploymentFingerprint } = await import('./deployment-config.mjs');
  const first = stagingConfig();
  const promoted = JSON.parse(JSON.stringify(first));
  promoted.vars.RELEASE_MODE = 'ga'; promoted.vars.SOURCE_REVISION = 'a'.repeat(40);
  promoted.vars.LIVE_ACCEPTANCE_ID = 'approved'; promoted.vars.LIVE_ACCEPTANCE_JWS = 'private-proof';
  promoted.vars.LIVE_ACCEPTANCE_PUBLIC_KEY = 'public-key';
  assert.equal(deploymentFingerprint(first), deploymentFingerprint(promoted));
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(deploymentFingerprint(first), deploymentFingerprint(reordered));
  for (const mutate of [
    c => { c.account_id = 'another-cloudflare-account'; },
    c => { c.d1_databases[0].database_id = '11111111-2222-4333-8444-555555555555'; },
    c => { c.r2_buckets[0].bucket_name = 'another-private-bucket'; },
    c => { c.vars.GA_PROFILE = 'another-profile'; },
    c => { c.vars.BACKGROUND_JOBS_ENABLED = 'true'; },
    c => { c.vars.PUBLIC_ORIGIN = 'https://another.example.org'; },
    c => { c.vectorize = [{ binding: 'MEMORY_INDEX', index_name: 'another-index' }]; },
  ]) {
    const changed = structuredClone(first); mutate(changed);
    assert.notEqual(deploymentFingerprint(first), deploymentFingerprint(changed));
  }
});

test('resource fingerprint permits display-only rebranding while binding auth, contact, budget and shards', async () => {
  const { deploymentFingerprint } = await import('./deployment-config.mjs');
  const first = shardedConfig();
  const fingerprint = deploymentFingerprint(first);
  const displayChanges = {
    PRODUCT_NAME: 'Renamed Memory', PRODUCT_SHORT_NAME: 'Renamed',
    PRODUCT_DESCRIPTION: 'A new description', PRODUCT_ACCENT_COLOR: '#123456',
  };
  for (const [key, value] of Object.entries(displayChanges)) {
    const changed = structuredClone(first); changed.vars[key] = value;
    assert.equal(deploymentFingerprint(changed), fingerprint, key);
    delete changed.vars[key];
    assert.equal(deploymentFingerprint(changed), fingerprint, `optional ${key}`);
  }
  const renamed = structuredClone(first); Object.assign(renamed.vars, displayChanges);
  assert.equal(deploymentFingerprint(renamed), fingerprint);
  for (const [name, mutate] of [
    ['SSO client', c => { c.vars.SSO_CLIENT_ID = 'another-client'; }],
    ['origin', c => { c.vars.PUBLIC_ORIGIN = 'https://another.example.org'; }],
    ['support contact', c => { c.vars.PRODUCT_SUPPORT_EMAIL = 'new-support@example.org'; }],
    ['AI budget', c => { c.vars.AI_MONTHLY_BUDGET_MICROUSD = '100001'; }],
    ['shard assignment', c => { const registry = JSON.parse(c.vars.STORAGE_SHARDS_JSON); registry[0].id = 'hot-renamed'; c.vars.STORAGE_SHARDS_JSON = JSON.stringify(registry); }],
    ['physical shard', c => { c.d1_databases[1].database_id = '33333333-4444-4555-8666-777777777777'; }],
  ]) {
    const changed = structuredClone(renamed); mutate(changed);
    assert.notEqual(deploymentFingerprint(changed), fingerprint, name);
  }
});

for (const [name, mutate] of [
  ['one hot shard', c => { c.d1_databases.pop(); c.vars.STORAGE_SHARDS_JSON = JSON.stringify([{ id: 'hot-a', binding: 'HOT_A', mode: 'active' }]); }],
  ['physical database alias', c => { c.d1_databases[2].database_id = c.d1_databases[1].database_id; }],
  ['central database alias', c => { c.d1_databases[1].database_id = c.d1_databases[0].database_id; }],
  ['wrong hot migrations directory', c => { c.d1_databases[1].migrations_dir = 'migrations'; }],
  ['wrong central migrations directory', c => { c.d1_databases[0].migrations_dir = 'shard-migrations'; }],
  ['missing payload bucket', c => { c.r2_buckets = []; }],
  ['malformed registry JSON', c => { c.vars.STORAGE_SHARDS_JSON = '{'; }],
  ['unregistered D1 binding', c => { c.d1_databases[2].binding = 'HOT_OTHER'; }],
  ['duplicate shard identifier', c => { const registry = JSON.parse(c.vars.STORAGE_SHARDS_JSON); registry[1].id = registry[0].id; c.vars.STORAGE_SHARDS_JSON = JSON.stringify(registry); }],
  ['unknown registry property', c => { const registry = JSON.parse(c.vars.STORAGE_SHARDS_JSON); registry[0].unexpected = true; c.vars.STORAGE_SHARDS_JSON = JSON.stringify(registry); }],
  ['no active shard', c => { c.vars.STORAGE_SHARDS_JSON = c.vars.STORAGE_SHARDS_JSON.replace('active', 'draining'); }],
]) {
  test(`sharded deployment rejects ${name}`, async t => {
    const config = shardedConfig(); mutate(config); const { path } = await fixture(t, config);
    const result = preflight(['--config', path]); assert.equal(result.status, 1, result.output);
    assert.match(result.output, /shard|D1|MEMORY_PAYLOADS|migration/i);
  });
}

for (const operation of ['db:local', 'db:remote']) {
  test(`${operation} migrates every active/draining hot database before the central database`, async t => {
    const { runDeploymentCommand } = await import('./deployment-command.mjs');
    const { path } = await fixture(t, shardedConfig()), calls = [];
    await runDeploymentCommand([operation, '--config', path], { runner: async (...args) => calls.push(args) });
    assert.deepEqual(calls.map(call => call[1][4]), ['HOT_A', 'HOT_B', 'DB']);
    assert.ok(calls.every(call => call[1].at(-1) === path && call[1].includes(operation === 'db:local' ? '--local' : '--remote')));
    const failed = [];
    await assert.rejects(runDeploymentCommand([operation, '--config', path], { runner: async (...args) => { failed.push(args); throw new Error('shard migration failed'); } }));
    assert.equal(failed.length, 1);
  });
}

test('migration sequence stops if the selected config changes after the first hot database', async t => {
  const { runDeploymentCommand } = await import('./deployment-command.mjs');
  const config = shardedConfig(), { path } = await fixture(t, config), calls = [];
  await assert.rejects(runDeploymentCommand(['db:remote', '--config', path], { runner: async (...args) => {
    calls.push(args); config.name = 'another-worker'; await writeFile(path, JSON.stringify(config));
  } }), /configuration changed/);
  assert.equal(calls.length, 1);
});

test('staging rejects production Vectorize and Analytics Engine resources', async t => {
  const { loadDeploymentConfiguration } = await import('./deployment-config.mjs');
  const { dir, path } = await fixture(t);
  const reference = structuredClone(production);
  reference.vectorize = [{ binding: 'MEMORY_INDEX', index_name: 'memory-production-vectors' }];
  reference.analytics_engine_datasets = [{ binding: 'METRICS', dataset: 'memory_production_metrics' }];
  const productionConfigPath = join(dir, 'production.jsonc'); await writeFile(productionConfigPath, JSON.stringify(reference));
  for (const key of ['vectorize', 'analytics_engine_datasets']) {
    const config = stagingConfig(); config[key] = reference[key]; await writeFile(path, JSON.stringify(config));
    await assert.rejects(loadDeploymentConfiguration({ configPath: path, productionConfigPath }), /production.*(Vectorize|Analytics)/);
  }
});
