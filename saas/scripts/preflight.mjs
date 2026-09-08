import { readFile } from 'node:fs/promises';
import { parse } from 'jsonc-parser';
import { readSettings } from '../src/config.ts';

const errors = [];
const config = parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'), errors);
if (errors.length) throw new Error('Invalid Wrangler configuration');
const settings = readSettings(config.vars ?? {});
const failures = [];
if (!settings.auth.clientId) failures.push('SSO_CLIENT_ID must contain the registered public OAuth client ID.');
const db = config.d1_databases?.find(x => x.binding === 'DB');
if (!db || !/^[a-f0-9-]{36}$/.test(db.database_id) || /^0{8}-/.test(db.database_id)) failures.push('Provision the dedicated SaaS D1 database and set its real database_id.');
if (!config.routes?.some(x => x.pattern === new URL(settings.origin).hostname && x.custom_domain === true)) failures.push('Custom domain does not match PUBLIC_ORIGIN.');
if (config.workers_dev !== false || config.preview_urls !== false) failures.push('Disable alternate public Workers URLs to preserve the exact service origin.');
if (config.observability?.enabled !== false) failures.push('Keep invocation logging disabled: OAuth callback query strings carry authorization codes.');
if (failures.length) { process.stderr.write(failures.join('\n') + '\n'); process.exitCode = 1; }
else process.stdout.write('Local deployment configuration passes. Remote SSO allowlist, D1 migrations and domain ownership must also be verified.\n');
