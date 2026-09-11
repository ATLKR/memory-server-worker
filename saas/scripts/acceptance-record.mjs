import { open, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNodeValue, parseTree } from 'jsonc-parser';
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import { SERVICE_VERSION } from '../src/config.ts';
import { ACCEPTANCE_ISSUER, GA_PROFILE, MAX_ACCEPTANCE_SECONDS, REQUIRED_ACCEPTANCE_GATES } from '../src/release/readiness.ts';
import { deploymentFingerprint, loadDeploymentConfiguration, PROJECT_DIRECTORY } from './deployment-config.mjs';
import { inspectGitSource } from './deployment-command.mjs';

class AcceptanceError extends Error {}
const fail = message => { throw new AcceptanceError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
const date = value => typeof value === 'number' && Number.isSafeInteger(value * 1000) && Number.isInteger(value) && value > 0;
const safeText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

function context(target, source, schemas) {
  return { releaseVersion: SERVICE_VERSION, sourceRevision: source.dirty ? 'unreleased' : source.revision,
    environment: target.environment, origin: target.settings.origin, ...schemas, resourceFingerprint: deploymentFingerprint(target.config) };
}
export function createPendingAcceptance(target, source, schemas) {
  return { format: 2, id: 'REPLACE-WITH-RECORD-ID', profile: GA_PROFILE, ...context(target, source, schemas),
    gates: REQUIRED_ACCEPTANCE_GATES.map(id => ({ id, status: 'pending', completedAt: null, evidenceFile: '', evidenceRef: '', evidenceSha256: '' })) };
}

async function boundedRead(path, maximum) {
  let file;
  try {
    file = await open(path, 'r');
    if (!(await file.stat()).isFile()) fail('Evidence and records must be regular files.');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maximum) fail('Acceptance record or evidence exceeds its size limit.');
    return bytes.subarray(0, length);
  } catch (error) { if (error instanceof AcceptanceError) throw error; fail('Cannot read the acceptance record or evidence file.'); }
  finally { await file?.close(); }
}
function strictJSON(bytes) {
  const errors = [], tree = parseTree(bytes.toString('utf8'), errors, { disallowComments: true });
  if (errors.length || !tree || tree.type !== 'object') fail('Acceptance records and evidence must be valid JSON objects.');
  const visit = node => {
    if (node.type === 'object') {
      const names = new Set();
      for (const property of node.children ?? []) {
        const name = property.children[0].value;
        if (names.has(name)) fail('Duplicate JSON keys are not accepted in evidence.');
        names.add(name);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return getNodeValue(tree);
}

export async function signAcceptanceRecord({ record, target, source, schemas, privateKey, expiresAt, clock = Date.now, recordDirectory }) {
  const now = Math.floor(clock() / 1000), expected = context(target, source, schemas);
  if (source.dirty || !/^[a-f\d]{40}$/.test(source.revision)) fail('Signing requires clean, committed source.');
  if (!object(record) || record.format !== 2 || record.profile !== GA_PROFILE || record.id === 'REPLACE-WITH-RECORD-ID' || !/^[A-Za-z\d][A-Za-z\d._:-]{0,127}$/.test(record.id ?? '')) fail('Invalid acceptance record identity or profile.');
  if (Object.entries(expected).some(([key, value]) => record[key] !== value)) fail('Acceptance record does not match the current source, schemas or deployment target.');
  if (!date(schemas.centralSchemaVersion) || !date(schemas.hotSchemaVersion)) fail('Invalid acceptance schema versions.');
  const variables = target.config.vars;
  const budget = variables.AI_MONTHLY_BUDGET_MICROUSD ?? '';
  const cap = target.environment === 'production' ? 20000000 : target.environment === 'staging' ? 200000 : 0;
  if (variables.GA_PROFILE !== GA_PROFILE || variables.ENROLLMENT_MODE !== 'invite' || variables.PAID_BILLING_ENABLED !== 'false' || typeof budget !== 'string' || !/^[1-9]\d{0,8}$/.test(budget) || Number(budget) > cap)
    fail('The target must use invite enrollment, metered AI within its budget, and disabled paid billing.');
  if (!date(expiresAt) || expiresAt <= now || expiresAt - now > MAX_ACCEPTANCE_SECONDS) fail('Choose an explicit future acceptance deadline no more than seven days away.');
  if (!Array.isArray(record.gates) || record.gates.length !== REQUIRED_ACCEPTANCE_GATES.length) fail('Every required gate must have passed evidence.');
  const seen = new Set(), gates = [];
  for (const gate of record.gates) {
    if (!object(gate) || !REQUIRED_ACCEPTANCE_GATES.includes(gate.id) || seen.has(gate.id) || gate.status !== 'passed' ||
        !date(gate.completedAt) || gate.completedAt > now || expiresAt - gate.completedAt > MAX_ACCEPTANCE_SECONDS || !safeText(gate.evidenceFile, 4096) ||
        !safeText(gate.evidenceRef, 512) || !sha(gate.evidenceSha256)) fail('Every required gate must have explicit passed status, dated evidence and its SHA-256.');
    seen.add(gate.id);
    const bytes = await boundedRead(resolve(recordDirectory, gate.evidenceFile), 1048576);
    if (createHash('sha256').update(bytes).digest('hex') !== gate.evidenceSha256) fail('An evidence file no longer matches its recorded SHA-256.');
    const evidence = strictJSON(bytes);
    if (evidence.format !== 1 || evidence.gate !== gate.id || evidence.outcome !== 'passed' || evidence.observedAt !== gate.completedAt ||
        Object.entries(expected).some(([key, value]) => evidence[key] !== value) ||
        !Array.isArray(evidence.checks) || !evidence.checks.length || evidence.checks.length > 1000 ||
        evidence.checks.some(check => !object(check) || !safeText(check.name, 256) || check.outcome !== 'passed'))
      fail('Evidence must record passed checks for this exact gate, source, schema and target.');
    gates.push({ id: gate.id, status: 'passed', completedAt: gate.completedAt, evidenceRef: gate.evidenceRef, evidenceSha256: gate.evidenceSha256 });
  }
  if (!(typeof privateKey === 'string' && privateKey.length <= 8192 && privateKey.includes('BEGIN PRIVATE KEY'))) fail('Provide an Ed25519 private key through stdin or the designated environment variable.');
  try {
    const key = await importPKCS8(privateKey.trim(), 'EdDSA');
    const token = await new SignJWT({ format: 2, profile: GA_PROFILE, releaseVersion: expected.releaseVersion,
      sourceRevision: expected.sourceRevision, environment: expected.environment, centralSchemaVersion: schemas.centralSchemaVersion,
      hotSchemaVersion: schemas.hotSchemaVersion, resourceFingerprint: expected.resourceFingerprint, gates })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' }).setIssuer(ACCEPTANCE_ISSUER).setAudience(expected.origin)
      .setJti(record.id).setIssuedAt(now).setExpirationTime(expiresAt).sign(key);
    await jwtVerify(token, await importSPKI(variables.LIVE_ACCEPTANCE_PUBLIC_KEY ?? '', 'EdDSA'), {
      issuer: ACCEPTANCE_ISSUER, audience: expected.origin, algorithms: ['EdDSA'], currentDate: new Date(clock()),
    });
    if (clock() >= expiresAt * 1000) fail('The acceptance deadline elapsed while signing.');
    return token;
  } catch (error) { if (error instanceof AcceptanceError) throw error; fail('Signing key must match the target Ed25519 public key.'); }
}

function argumentsFor(argv) {
  const [mode, ...args] = argv;
  if (!['template', 'sign'].includes(mode)) fail('Choose template or sign.');
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const allowed = mode === 'template' ? ['--config', '--out'] : ['--config', '--record', '--out', '--expires-at', '--key-stdin'];
    if (!allowed.includes(arg) || Object.hasOwn(values, arg)) fail('Unsupported or duplicate acceptance argument. Private keys are accepted only through stdin or the designated environment variable.');
    if (arg === '--key-stdin') { values[arg] = true; continue; }
    const value = args[++index];
    if (!safeText(value, 4096) || value.startsWith('-')) fail('Missing acceptance argument value.');
    values[arg] = value;
  }
  if (!values['--config'] || !values['--out'] || (mode === 'sign' && (!values['--record'] || !values['--expires-at']))) fail('Specify an explicit --config and --out; signing also requires --record and --expires-at.');
  return { mode, values };
}

async function sourceSchemas() {
  const version = async directory => {
    const versions = (await readdir(resolve(PROJECT_DIRECTORY, directory))).filter(name => /^\d{4}_.+\.sql$/.test(name)).map(name => Number(name.slice(0, 4)));
    if (!versions.length) fail('No source migrations found for acceptance.');
    return Math.max(...versions);
  };
  return { centralSchemaVersion: await version('migrations'), hotSchemaVersion: await version('shard-migrations') };
}

async function privateOutput(path) {
  const repository = await realpath(resolve(PROJECT_DIRECTORY, '..')), directory = await realpath(dirname(path));
  const relation = relative(repository, directory);
  if (!relation || (!relation.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && relation !== '..' && !isAbsolute(relation)))
    fail('Keep acceptance output outside the public repository.');
}

export async function runAcceptanceCommand(argv, { cwd = process.cwd(), inspectSource = inspectGitSource, schemas, clock = Date.now, readKey, processEnvironment = process.env } = {}) {
  const { mode, values } = argumentsFor(argv), output = resolve(cwd, values['--out']);
  await privateOutput(output);
  const target = await loadDeploymentConfiguration({ configPath: values['--config'], cwd, processEnvironment });
  const source = await inspectSource(), versions = schemas ?? await sourceSchemas();
  if (mode === 'template') {
    await writeFile(output, JSON.stringify(createPendingAcceptance(target, source, versions), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { mode };
  }
  const iso = values['--expires-at'];
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso)) fail('Use an explicit UTC deadline: YYYY-MM-DDTHH:MM:SSZ.');
  const expiresAt = Date.parse(iso) / 1000, recordPath = resolve(cwd, values['--record']);
  if (values['--key-stdin'] && processEnvironment.MEMORY_ACCEPTANCE_PRIVATE_KEY) fail('Choose one private-key source: stdin or environment.');
  const privateKey = readKey ? await readKey() : values['--key-stdin'] ? await stdinKey() : processEnvironment.MEMORY_ACCEPTANCE_PRIVATE_KEY;
  const record = strictJSON(await boundedRead(recordPath, 131072));
  const token = await signAcceptanceRecord({ record, target, source, schemas: versions, privateKey, expiresAt, clock, recordDirectory: dirname(recordPath) });
  const latestSource = await inspectSource(), latestTarget = await loadDeploymentConfiguration({ configPath: values['--config'], cwd, processEnvironment });
  if (latestSource.dirty || latestSource.revision !== source.revision || deploymentFingerprint(latestTarget.config) !== deploymentFingerprint(target.config) ||
      latestTarget.config.vars.LIVE_ACCEPTANCE_PUBLIC_KEY !== target.config.vars.LIVE_ACCEPTANCE_PUBLIC_KEY) fail('Source or target changed while signing.');
  await writeFile(output, token + '\n', { flag: 'wx', mode: 0o600 });
  return { mode };
}

async function stdinKey() {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk.toString('utf8'); if (text.length > 8192) fail('Private key input exceeds its size limit.'); }
  return text;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runAcceptanceCommand(process.argv.slice(2));
    process.stdout.write(result.mode === 'template' ? 'Pending acceptance template written; no gate was marked passed.\n' : 'Signed acceptance written to the private output file. No live test was performed by this command.\n');
  } catch (error) {
    process.stderr.write((error instanceof AcceptanceError ? error.message : 'Acceptance command failed; no approval or fallback was created.') + '\n');
    process.exitCode = 1;
  }
}
