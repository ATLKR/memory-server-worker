import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { loadDeploymentConfiguration, deploymentFingerprint, PROJECT_DIRECTORY } from '../../scripts/deployment-config.mjs';
import { runDeploymentCommand } from '../../scripts/deployment-command.mjs';

const base = parse(await readFile(join(PROJECT_DIRECTORY, 'wrangler.jsonc'), 'utf8'));
function durableConfig(environment = 'production') {
  const config = structuredClone(base);
  config.main = join(PROJECT_DIRECTORY, 'src/worker.ts');
  config.name = `memory-durable-fixture-${environment}`;
  config.vars.DEPLOYMENT_ENVIRONMENT = environment;
  config.vars.PUBLIC_ORIGIN = `https://memory-durable-${environment}.example.org`;
  config.routes = [{ pattern: new URL(config.vars.PUBLIC_ORIGIN).hostname, custom_domain: true }];
  config.vars.MEMORY_SQL_BACKEND = 'durable';
  config.vars.MEMORY_SQL_DEPLOYMENT_ID = `memory-${environment}-fixture`;
  config.vars.MEMORY_SQL_EPOCH = '1';
  config.vars.MEMORY_SQL_DATABASES_JSON = JSON.stringify({ DB: { databaseId: 'control', kind: 'control' },
    HOT_A: { databaseId: 'hot-a', kind: 'hot' }, HOT_B: { databaseId: 'hot-b', kind: 'hot' } });
  config.vars.STORAGE_MODE = 'sharded';
  config.vars.STORAGE_SHARDS_JSON = JSON.stringify([{ id: 'hot-b', binding: 'HOT_B', mode: 'draining' }, { id: 'hot-a', binding: 'HOT_A', mode: 'active' }]);
  delete config.d1_databases;
  config.r2_buckets = [{ binding: 'MEMORY_PAYLOADS', bucket_name: `memory-durable-${environment}-payloads` }];
  config.vectorize = [{ binding: 'MEMORY_INDEX', index_name: `memory-durable-${environment}-index` }];
  config.analytics_engine_datasets = [{ binding: 'METRICS', dataset: `memory_durable_${environment}_metrics` }];
  config.durable_objects = { bindings: [{ name: 'MEMORY_SQL', class_name: 'MemorySqlDatabase' }] };
  config.migrations = [{ tag: 'memory-sql-v1', new_sqlite_classes: ['MemorySqlDatabase'] }];
  return config;
}
async function fixture(t, config = durableConfig('staging'), production = durableConfig()) {
  const dir = await mkdtemp(join(tmpdir(), 'memory durable deployment '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'target.jsonc'), productionConfigPath = join(dir, 'production.jsonc');
  await writeFile(path, JSON.stringify(config)); await writeFile(productionConfigPath, JSON.stringify(production));
  return { dir, path, productionConfigPath, config,
    load: () => loadDeploymentConfiguration({ configPath: path, productionConfigPath, processEnvironment: {} }) };
}
function map(config, mutate) {
  const databases = JSON.parse(config.vars.MEMORY_SQL_DATABASES_JSON); mutate(databases);
  config.vars.MEMORY_SQL_DATABASES_JSON = JSON.stringify(databases);
}

test('durable deployment validates exact logical shards without any D1 binding', async t => {
  const f = await fixture(t), target = await f.load();
  assert.equal(target.sqlBackend, 'durable');
  assert.deepEqual(target.hotBindings, ['HOT_A', 'HOT_B']);
  assert.equal(target.config.d1_databases, undefined);
});
test('durable inline deployment supports exactly its control object', async t => {
  const config = durableConfig('staging'); config.vars.STORAGE_MODE = 'inline'; delete config.vars.STORAGE_SHARDS_JSON;
  map(config, value => { delete value.HOT_A; delete value.HOT_B; });
  assert.deepEqual((await (await fixture(t, config)).load()).hotBindings, []);
});
test('empty D1 collection is accepted in durable mode but never used', async t => {
  const config = durableConfig('staging'); config.d1_databases = [];
  assert.equal((await (await fixture(t, config)).load()).sqlBackend, 'durable');
});

for (const backend of ['d1', 'durable']) test(`${backend} SQL maintenance accepts only absent or canonical boolean strings`, async t => {
  function configuration() {
    const config = durableConfig('staging');
    if (backend === 'd1') {
      config.vars.MEMORY_SQL_BACKEND = 'd1';
      for (const key of ['MEMORY_SQL_DEPLOYMENT_ID', 'MEMORY_SQL_EPOCH', 'MEMORY_SQL_DATABASES_JSON']) delete config.vars[key];
      config.vars.STORAGE_MODE = 'inline'; delete config.vars.STORAGE_SHARDS_JSON;
      config.d1_databases = [{ binding: 'DB', database_name: 'legacy-fixture', database_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', migrations_dir: 'migrations' }];
    }
    return config;
  }
  for (const value of [undefined, 'false', 'true']) {
    const config = configuration();
    if (value === undefined) delete config.vars.MEMORY_SQL_MAINTENANCE;
    else config.vars.MEMORY_SQL_MAINTENANCE = value;
    assert.equal((await (await fixture(t, config)).load()).sqlBackend, backend);
  }
  for (const value of [null, false, true, 0, 1, '', 'TRUE', ' false', 'true ', 'yes', {}, []]) {
    const config = configuration(); config.vars.MEMORY_SQL_MAINTENANCE = value;
    await assert.rejects((await fixture(t, config)).load(), /MEMORY_SQL_MAINTENANCE/);
  }
});

test('SQL maintenance changes are bound into the deployment fingerprint', () => {
  const config = durableConfig('staging'); delete config.vars.MEMORY_SQL_MAINTENANCE;
  const absent = deploymentFingerprint(config); config.vars.MEMORY_SQL_MAINTENANCE = 'false';
  const inactive = deploymentFingerprint(config); config.vars.MEMORY_SQL_MAINTENANCE = 'true';
  assert.equal(new Set([absent, inactive, deploymentFingerprint(config)]).size, 3);
});

for (const [name, mutate] of [
  ['unknown backend', c => { c.vars.MEMORY_SQL_BACKEND = 'durabl'; }],
  ['null backend', c => { c.vars.MEMORY_SQL_BACKEND = null; }],
  ['D1 binding retained', c => { c.d1_databases = structuredClone(base.d1_databases); }],
  ['missing deployment ID', c => { delete c.vars.MEMORY_SQL_DEPLOYMENT_ID; }],
  ['colon in deployment ID', c => { c.vars.MEMORY_SQL_DEPLOYMENT_ID = 'stage:control'; }],
  ['dot in deployment ID', c => { c.vars.MEMORY_SQL_DEPLOYMENT_ID = 'stage.control'; }],
  ['oversized deployment ID', c => { c.vars.MEMORY_SQL_DEPLOYMENT_ID = 'a'.repeat(65); }],
  ['missing epoch', c => { delete c.vars.MEMORY_SQL_EPOCH; }],
  ['noncanonical epoch', c => { c.vars.MEMORY_SQL_EPOCH = '01'; }],
  ['unsafe epoch', c => { c.vars.MEMORY_SQL_EPOCH = '9007199254740992'; }],
  ['numeric epoch', c => { c.vars.MEMORY_SQL_EPOCH = 1; }],
  ['missing map', c => { delete c.vars.MEMORY_SQL_DATABASES_JSON; }],
  ['map duplicate key', c => { c.vars.MEMORY_SQL_DATABASES_JSON = '{"DB":{"databaseId":"control","kind":"control"},"DB":{"databaseId":"other","kind":"control"}}'; }],
  ['map duplicate nested key', c => { c.vars.MEMORY_SQL_DATABASES_JSON = c.vars.MEMORY_SQL_DATABASES_JSON.replace('"kind":"control"', '"kind":"hot","kind":"control"'); }],
  ['map comment', c => { c.vars.MEMORY_SQL_DATABASES_JSON = '/* no */' + c.vars.MEMORY_SQL_DATABASES_JSON; }],
  ['map unregistered shard', c => map(c, v => { v.HOT_OTHER = { databaseId: 'other', kind: 'hot' }; })],
  ['map missing shard', c => map(c, v => { delete v.HOT_B; })],
  ['map missing control', c => map(c, v => { delete v.DB; })],
  ['control kind wrong', c => map(c, v => { v.DB.kind = 'hot'; })],
  ['hot kind wrong', c => map(c, v => { v.HOT_A.kind = 'control'; })],
  ['duplicate physical database ID', c => map(c, v => { v.HOT_A.databaseId = v.DB.databaseId; })],
  ['invalid database ID', c => map(c, v => { v.DB.databaseId = 'control:other'; })],
  ['dot in database ID', c => map(c, v => { v.DB.databaseId = 'control.other'; })],
  ['unexpected map field', c => map(c, v => { v.DB.namespace = 'elsewhere'; })],
  ['logical native resource collision', c => { c.r2_buckets.push({ binding: 'HOT_A', bucket_name: 'collision' }); }],
  ['logical var collision', c => { c.vars.DB = 'unexpected'; }],
  ['non-hot logical shard', c => { c.vars.STORAGE_SHARDS_JSON = c.vars.STORAGE_SHARDS_JSON.replace('HOT_A', 'OTHER'); map(c, v => { v.OTHER = v.HOT_A; delete v.HOT_A; }); }],
  ['namespace missing', c => { delete c.durable_objects; }],
  ['namespace class wrong', c => { c.durable_objects.bindings[0].class_name = 'OtherDatabase'; }],
  ['namespace cross-script', c => { c.durable_objects.bindings[0].script_name = 'production-memory'; }],
  ['namespace cross-environment', c => { c.durable_objects.bindings[0].environment = 'production'; }],
  ['namespace explicit ID override', c => { c.durable_objects.bindings[0].namespace_id = 'a'.repeat(32); }],
  ['namespace alternate alias', c => { c.durable_objects.bindings.push({ name: 'OTHER_SQL', class_name: 'MemorySqlDatabase' }); }],
  ['unsafe binding override', c => { c.unsafe = { bindings: [{ name: 'MEMORY_SQL', type: 'durable_object_namespace', namespace_id: 'a'.repeat(32) }] }; }],
  ['missing class migration', c => { delete c.migrations; }],
  ['legacy class creation', c => { c.migrations[0] = { tag: 'memory-sql-v1', new_classes: ['MemorySqlDatabase'] }; }],
  ['repeated class creation', c => { c.migrations.push({ tag: 'again', new_sqlite_classes: ['MemorySqlDatabase'] }); }],
  ['duplicate migration tag', c => { c.migrations.push({ tag: 'memory-sql-v1', new_sqlite_classes: ['AnotherObject'] }); }],
  ['class deletion', c => { c.migrations.push({ tag: 'remove', deleted_classes: ['MemorySqlDatabase'] }); }],
  ['class rename', c => { c.migrations.push({ tag: 'rename', renamed_classes: [{ from: 'MemorySqlDatabase', to: 'OtherObject' }] }); }],
  ['class transfer', c => { c.migrations.push({ tag: 'transfer', transferred_classes: [{ from: 'OtherObject', from_script: 'elsewhere', to: 'MemorySqlDatabase' }] }); }],
]) test('durable configuration rejects ' + name, async t => {
  const config = durableConfig('staging'); mutate(config);
  await assert.rejects((await fixture(t, config)).load(), /backend|durable|SQL|database|binding|migration|D1|JSON/i);
});

test('staging cannot reuse production SQL deployment identity even with different epoch and database names', async t => {
  const production = durableConfig(), config = durableConfig('staging');
  config.vars.MEMORY_SQL_DEPLOYMENT_ID = production.vars.MEMORY_SQL_DEPLOYMENT_ID;
  config.vars.MEMORY_SQL_EPOCH = '2'; map(config, v => { for (const row of Object.values(v)) row.databaseId += '-different'; });
  await assert.rejects((await fixture(t, config, production)).load(), /production.*SQL|SQL.*production/i);
});
test('legacy D1 mode rejects dormant durable identity variables rather than hiding a future switch', async t => {
  for (const mutate of [c => { c.vars.MEMORY_SQL_BACKEND = 'd1'; }, c => { delete c.vars.MEMORY_SQL_BACKEND; }]) {
    const config = durableConfig('staging'); mutate(config);
    config.d1_databases = [{ binding: 'DB', database_name: 'legacy-fixture', database_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', migrations_dir: 'migrations' }];
    await assert.rejects((await fixture(t, config)).load(), /durable|SQL/i);
  }
});
test('D1 prepare phase can declare a local SQL namespace without activating durable identity', async t => {
  const config = durableConfig('staging'); config.vars.MEMORY_SQL_BACKEND = 'd1';
  for (const key of ['MEMORY_SQL_DEPLOYMENT_ID', 'MEMORY_SQL_EPOCH', 'MEMORY_SQL_DATABASES_JSON']) delete config.vars[key];
  config.vars.STORAGE_MODE = 'inline'; delete config.vars.STORAGE_SHARDS_JSON;
  config.d1_databases = [{ binding: 'DB', database_name: 'legacy-fixture', database_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', migrations_dir: 'migrations' }];
  assert.equal((await (await fixture(t, config)).load()).sqlBackend, 'd1');
});

test('durable migration commands never invoke D1, a deploy, or another runner', async t => {
  const f = await fixture(t);
  for (const operation of ['db:local', 'db:remote']) {
    const calls = [];
    await assert.rejects(runDeploymentCommand([operation, '--config', f.path], {
      productionConfigPath: f.productionConfigPath, processEnvironment: {}, runner: async (...args) => calls.push(args),
    }), /durable.*(import|migration)|D1.*durable/i);
    assert.deepEqual(calls, []);
  }
});
test('durable build is only a dry run and binds SQL source/resource facts', async t => {
  const f = await fixture(t), calls = [];
  await runDeploymentCommand(['build', '--config', f.path], {
    productionConfigPath: f.productionConfigPath, processEnvironment: {}, inspectSource: async () => ({ revision: 'a'.repeat(40), dirty: false }),
    runner: async (...args) => calls.push(args),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(1, 4), ['deploy', '--dry-run', '--outdir']);
  assert.ok(calls[0][1].includes('BUILD_RESOURCE_FINGERPRINT:' + JSON.stringify(deploymentFingerprint(f.config))));
  assert.ok(!calls[0][1].includes('d1'));
});
test('durable fingerprint canonicalizes map order but binds backend, identity, epoch, map and class', () => {
  const config = durableConfig('staging'), first = deploymentFingerprint(config);
  const reordered = structuredClone(config); map(reordered, v => { const control = v.DB; delete v.DB; v.DB = control; });
  assert.equal(deploymentFingerprint(reordered), first);
  for (const mutate of [c => { c.vars.MEMORY_SQL_BACKEND = 'd1'; }, c => { c.vars.MEMORY_SQL_DEPLOYMENT_ID += '-new'; },
    c => { c.vars.MEMORY_SQL_EPOCH = '2'; }, c => map(c, v => { v.HOT_A.databaseId += '-new'; }),
    c => { c.durable_objects.bindings[0].class_name = 'OtherDatabase'; }]) {
    const changed = structuredClone(config); mutate(changed); assert.notEqual(deploymentFingerprint(changed), first);
  }
});
