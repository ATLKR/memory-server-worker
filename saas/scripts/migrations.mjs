import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Migrations 0001..0004 are already applied remotely. Their byte hashes are
// frozen; neither --check nor sync is allowed to rewrite an existing migration.
// Future changes belong in a new source and a new forward migration.
const deployedHashes = [
  '23abb696f982dc3956dadb052fb28b73b6576b77c13422721d7639229a0bf6ee',
  'f8ddda6903ec2d30ef7d0f5b34550b2bf29db0e5d91df75d091d728ae6a3d880',
  'ac437c62f25c90abad9716f913d08e859e4de7038fc1aee067d6a15ac631c0d4',
  '9e147360a59d427ca14de5f131ae7878afd961521aa1abf27d2df68872ff50ee',
];
const sources = ['schema.sql', 'memory-schema.sql', 'product-schema.sql', 'auth-schema.sql', 'hierarchy-schema.sql'];
const out = new URL('../migrations/', import.meta.url);
await mkdir(out, { recursive: true });
for (const [index, source] of sources.entries()) {
  const phase = index < deployedHashes.length ? 'Initial' : 'Forward';
  const content = `-- ${phase} SaaS migration ${index + 1}: ${source}\n` + await readFile(new URL(`../${source}`, import.meta.url), 'utf8');
  const target = new URL(`${String(index + 1).padStart(4, '0')}_${source}`, out);
  let existing;
  try { existing = await readFile(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (index < deployedHashes.length && (!existing || createHash('sha256').update(existing).digest('hex') !== deployedHashes[index]))
    throw new Error(`Deployed migration changed or is missing: ${source}. Restore its exact original bytes and add a forward migration.`);
  if (existing) {
    if (existing.toString('utf8') !== content) throw new Error(`Migration does not match reviewed source: ${source}. Existing migrations cannot be rewritten.`);
  } else if (process.argv.includes('--check')) {
    throw new Error(`Missing forward migration: ${source}. Run npm run migrations:sync.`);
  } else await writeFile(target, content, { flag: 'wx' });
}
process.stdout.write('Migrations match schema sources; deployed baseline bytes are unchanged.\n');
