import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../plugins/allenlabs-memory/', import.meta.url);
const output = new URL('scripts/mcp-stdio.mjs', root);
if (process.argv.slice(2).some(arg => arg !== '--check')) throw Error('unsupported_build_option');
const built = await build({
  entryPoints: [fileURLToPath(new URL('src/stdio.mjs', root))],
  outfile: fileURLToPath(output), bundle: true, platform: 'node', format: 'esm',
  target: 'node22', minify: true, sourcemap: false, legalComments: 'inline', write: false,
});
const bytes = built.outputFiles[0].contents;
if (process.argv.includes('--check')) {
  let actual;
  try { actual = await readFile(output); } catch { throw Error('routing_plugin_bundle_missing_run_build'); }
  if (!actual.equals(Buffer.from(bytes))) throw Error('routing_plugin_bundle_stale_run_build');
  console.log('Routing plugin bundle matches its source.');
} else {
  await mkdir(new URL('scripts/', root), { recursive: true });
  await writeFile(output, bytes);
  console.log('Built standalone routing plugin (' + bytes.length + ' bytes).');
}
