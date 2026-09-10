import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNodeValue, parseTree } from 'jsonc-parser';
import { readSettings } from '../src/config.ts';
import { canonicalEmail } from '../src/identity.ts';

export const PROJECT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCTION_CONFIG_PATH = resolve(PROJECT_DIRECTORY, 'wrangler.jsonc');

export class DeploymentConfigurationError extends Error {}
const fail = message => { throw new DeploymentConfigurationError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const configured = value => typeof value === 'string' && value.length > 0 && !/[<>\s]/.test(value) && !/placeholder|replace[_-]?me|your[_-]/i.test(value);
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value) && !/^0{8}-/.test(value);

/** Deliberately do not forward unknown flags, credentials or named environments to Wrangler. */
export function parseDeploymentArguments(args) {
  let configPath;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--env' || arg === '-e' || arg.startsWith('--env=') || /^-e.+/.test(arg))
      fail('Named environments are not supported. Use --config with a complete standalone target configuration.');
    if (arg !== '--config' && !arg.startsWith('--config='))
      fail('Unsupported deployment argument. Only --config is accepted.');
    if (configPath !== undefined) fail('Specify --config only once.');
    const value = arg === '--config' ? args[++index] : arg.slice('--config='.length);
    if (!value || value.startsWith('-') || /[\x00-\x1f]/.test(value)) fail('--config requires a configuration file path.');
    configPath = value;
  }
  return { configPath };
}

function rejectDuplicateKeys(node) {
  if (node.type === 'object') {
    const names = new Set();
    for (const property of node.children ?? []) {
      const key = property.children[0].value;
      if (names.has(key)) fail('Duplicate JSON configuration key.');
      names.add(key);
    }
  }
  for (const child of node.children ?? []) rejectDuplicateKeys(child);
}

async function readConfiguration(path) {
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch { fail('Cannot read the selected deployment configuration. No fallback was attempted.'); }
  const errors = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true });
  if (errors.length || !tree || tree.type !== 'object') fail('Invalid JSONC deployment configuration.');
  rejectDuplicateKeys(tree);
  return getNodeValue(tree);
}

function list(config, name) {
  if (config[name] === undefined) return [];
  if (!Array.isArray(config[name]) || config[name].some(item => !object(item)))
    fail(`Invalid ${name} configuration.`);
  return config[name];
}

function resourceSets(config) {
  return {
    d1: new Set(list(config, 'd1_databases').flatMap(db => [db.database_id, db.preview_database_id, db.database_name]).filter(Boolean).map(value => String(value).toLowerCase())),
    r2: new Set(list(config, 'r2_buckets').flatMap(bucket => [bucket.bucket_name, bucket.preview_bucket_name]).filter(Boolean)),
    vectorize: new Set(list(config, 'vectorize').map(index => index.index_name).filter(Boolean)),
    analytics: new Set(list(config, 'analytics_engine_datasets').map(dataset => dataset.dataset).filter(Boolean)),
  };
}

function validate(config, production, isProductionFile) {
  if (!object(config.vars)) fail('Deployment configuration must define vars.');
  const environment = config.vars.DEPLOYMENT_ENVIRONMENT ?? (isProductionFile ? 'production' : undefined);
  if (!['production', 'staging'].includes(environment))
    fail('DEPLOYMENT_ENVIRONMENT must explicitly be production or staging for a custom configuration.');
  // Named-env inheritance is intentionally unsupported even when no --env flag was supplied.
  if (config.env !== undefined) fail('Named environments are not supported. Use a standalone deployment configuration.');
  if (!configured(config.name)) fail('Configure the target Worker name.');
  let settings;
  try { settings = readSettings(config.vars); }
  catch { fail('Invalid public origin, branding or central SSO configuration.'); }
  if (!configured(settings.auth.clientId)) fail('SSO_CLIENT_ID must contain the registered public OAuth client ID.');
  if (settings.auth.issuer !== 'https://auth-api.allen.company') fail('Use the central auth-api.allen.company issuer.');
  if (config.vars.PUBLIC_ORIGIN !== settings.origin) fail('Explicitly configure PUBLIC_ORIGIN for the selected target.');
  if (new URL(settings.origin).port) fail('PUBLIC_ORIGIN must use the standard HTTPS port for its custom domain.');
  const routes = list(config, 'routes');
  if (routes.length !== 1 || routes[0].pattern !== new URL(settings.origin).hostname || routes[0].custom_domain !== true)
    fail('Exactly one custom domain route must match PUBLIC_ORIGIN.');
  if (config.workers_dev !== false || config.preview_urls !== false)
    fail('Disable alternate public Workers URLs to preserve the exact service origin.');
  if (config.observability?.enabled !== false)
    fail('Keep invocation logging disabled: OAuth callback query strings carry authorization codes.');

  const bindings = new Set();
  const addBinding = value => {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) fail('Invalid resource binding name.');
    if (bindings.has(value) || Object.hasOwn(config.vars, value)) fail('Duplicate resource binding in deployment configuration.');
    bindings.add(value);
  };
  for (const [collection, key] of [['d1_databases', 'binding'], ['r2_buckets', 'binding'], ['send_email', 'name'], ['ratelimits', 'name'], ['kv_namespaces', 'binding'], ['vectorize', 'binding'], ['services', 'binding'], ['analytics_engine_datasets', 'binding'], ['mtls_certificates', 'binding']]) {
    for (const item of list(config, collection)) addBinding(item[key]);
  }
  for (const key of ['ai', 'browser', 'images', 'assets']) {
    if (config[key] === undefined) continue;
    if (!object(config[key])) fail('Invalid resource binding configuration.');
    if (key !== 'assets' || config[key].binding !== undefined) addBinding(config[key].binding);
  }
  for (const item of list(config.durable_objects ?? {}, 'bindings')) addBinding(item.name);
  for (const item of list(config.queues ?? {}, 'producers')) addBinding(item.binding);
  const databases = list(config, 'd1_databases');
  if (!databases.some(db => db.binding === 'DB') || databases.some(db => !uuid(db.database_id) || !configured(db.database_name) || (db.preview_database_id !== undefined && !uuid(db.preview_database_id))))
    fail('Provision each dedicated D1 database and configure its real database_id and database_name, including DB.');
  const buckets = list(config, 'r2_buckets');
  if (buckets.some(bucket => !configured(bucket.bucket_name) || (bucket.preview_bucket_name !== undefined && !configured(bucket.preview_bucket_name))))
    fail('Provision each R2 bucket and configure its bucket_name.');
  for (const [collection, key] of [['vectorize', 'index_name'], ['analytics_engine_datasets', 'dataset']])
    if (list(config, collection).some(value => !configured(value[key]))) fail('Configure explicit Vectorize index and Analytics dataset names.');
  if (config.vars.STORAGE_MODE !== undefined && !['inline', 'sharded'].includes(config.vars.STORAGE_MODE)) fail('Invalid storage mode.');
  let hotBindings = [];
  if (config.vars.STORAGE_MODE === 'sharded' || config.vars.STORAGE_SHARDS_JSON !== undefined) {
    const errors = [], tree = typeof config.vars.STORAGE_SHARDS_JSON === 'string' ? parseTree(config.vars.STORAGE_SHARDS_JSON, errors, { disallowComments: true }) : undefined;
    if (!tree || errors.length || tree.type !== 'array') fail('Invalid shard registry JSON.');
    rejectDuplicateKeys(tree);
    const shards = getNodeValue(tree);
    if (shards.length < (config.vars.STORAGE_MODE === 'sharded' ? 2 : 1) || shards.length > 16) fail('Sharded mode requires two to sixteen configured hot D1 shards.');
    const ids = new Set(), registered = new Set();
    for (const shard of shards) {
      if (!object(shard) || Object.keys(shard).sort().join(',') !== 'binding,id,mode' ||
          typeof shard.id !== 'string' || !/^[A-Za-z\d][A-Za-z\d._:-]{0,63}$/.test(shard.id) ||
          typeof shard.binding !== 'string' || !/^[A-Z][A-Z\d_]{0,63}$/.test(shard.binding) || shard.binding === 'DB' ||
          !['active', 'draining'].includes(shard.mode) || ids.has(shard.id) || registered.has(shard.binding)) fail('Invalid or duplicate shard registry entry.');
      ids.add(shard.id); registered.add(shard.binding);
    }
    if (config.vars.STORAGE_MODE === 'sharded' && !shards.some(shard => shard.mode === 'active')) fail('Sharded writes require an active hot shard.');
    if (databases.length !== shards.length + 1 || databases.some(db => db.binding !== 'DB' && !registered.has(db.binding))) fail('Shard registry must exactly match the configured hot D1 bindings.');
    if (new Set(databases.map(db => db.database_id.toLowerCase())).size !== databases.length || new Set(databases.map(db => db.database_name)).size !== databases.length)
      fail('Every central and hot D1 binding must use a distinct physical database ID and name.');
    if (databases.some(db => db.migrations_dir !== (db.binding === 'DB' ? 'migrations' : 'shard-migrations')))
      fail('Use migrations for DB and shard-migrations for every hot D1 binding.');
    if (buckets.filter(bucket => bucket.binding === 'MEMORY_PAYLOADS').length !== 1) fail('Configure the private MEMORY_PAYLOADS R2 binding; verify public access is disabled separately.');
    hotBindings = shards.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(shard => shard.binding);
  }
  const emails = list(config, 'send_email');
  const email = emails.find(item => item.name === 'EMAIL');
  let mailValid = false;
  try { mailValid = canonicalEmail(config.vars.MAIL_FROM).address === config.vars.MAIL_FROM.toLowerCase(); } catch {}
  if (emails.length !== 1 || !email || !mailValid || email.allowed_sender_addresses?.length !== 1 || email.allowed_sender_addresses[0] !== config.vars.MAIL_FROM || email.destination_address !== undefined || email.allowed_destination_addresses !== undefined)
    fail('Cloudflare EMAIL must be restricted only to the configured MAIL_FROM address. Verify its sending domain separately.');

  if (environment === 'staging') {
    if (isProductionFile) fail('Staging must use a separate configuration file from production.');
    if (config.name === production.name) fail('Staging must not reuse the production Worker name.');
    let productionOrigin;
    try { productionOrigin = readSettings(production.vars ?? {}).origin; } catch { fail('Invalid production reference configuration.'); }
    if (new URL(settings.origin).hostname === new URL(productionOrigin).hostname)
      fail('Staging must not reuse the production origin.');
    const reserved = resourceSets(production);
    const selected = resourceSets(config);
    if ([...selected.d1].some(value => reserved.d1.has(value))) fail('Staging must not reuse any production D1 database ID or name.');
    if ([...selected.r2].some(value => reserved.r2.has(value))) fail('Staging must not reuse any production R2 bucket name.');
    if ([...selected.vectorize].some(value => reserved.vectorize.has(value))) fail('Staging must not reuse any production Vectorize index name.');
    if ([...selected.analytics].some(value => reserved.analytics.has(value))) fail('Staging must not reuse any production Analytics dataset name.');
  }
  return { environment, settings, hotBindings };
}

export async function loadDeploymentConfiguration({ configPath, cwd = process.cwd(), productionConfigPath = PRODUCTION_CONFIG_PATH, processEnvironment = process.env } = {}) {
  if (processEnvironment.CLOUDFLARE_ENV || processEnvironment.WRANGLER_CI_OVERRIDE_NAME)
    fail('Remove ambient Wrangler environment/name overrides. Only the selected standalone configuration may choose the deployment target.');
  let path, productionPath;
  try {
    productionPath = await realpath(productionConfigPath);
    path = await realpath(configPath === undefined ? productionPath : resolve(cwd, configPath));
  } catch { fail('Cannot read the selected deployment configuration or production reference. No fallback was attempted.'); }
  const config = await readConfiguration(path);
  const production = path === productionPath ? config : await readConfiguration(productionPath);
  return { path, config, ...validate(config, production, path === productionPath) };
}

export function deploymentErrorMessage(error) {
  return error instanceof DeploymentConfigurationError ? error.message : 'Deployment command failed. No fallback was attempted.';
}

/** Canonical deployment facts; display branding, promotion and evidence are not resource/policy changes. */
export function deploymentFingerprint(config) {
  const selected = structuredClone(config);
  delete selected.$schema;
  if (object(selected.vars)) {
    for (const key of Object.keys(selected.vars)) {
      if (key === 'RELEASE_MODE' || key === 'SOURCE_REVISION' || key.startsWith('LIVE_ACCEPTANCE') ||
          ['PRODUCT_NAME', 'PRODUCT_SHORT_NAME', 'PRODUCT_DESCRIPTION', 'PRODUCT_ACCENT_COLOR'].includes(key)) delete selected.vars[key];
      else if (key.endsWith('_JSON') && typeof selected.vars[key] === 'string') {
        try { selected.vars[key] = JSON.parse(selected.vars[key]); } catch {}
      }
    }
  }
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(selected))).digest('hex');
}
