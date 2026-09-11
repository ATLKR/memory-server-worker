import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openLocalDatabase } from './sqlite.mjs';
import { digestToken } from '../src/identity.ts';
import { MemoryService } from '../src/memory.ts';
import { createMemoryApi } from '../src/api.ts';

const port = Number(process.env.MEMORY_DEV_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MEMORY_DEV_PORT');
const origin = `http://127.0.0.1:${port}`;
const database = openLocalDatabase();
const { raw, db } = database;
const now = Date.now();
const token = randomBytes(32).toString('hex');
raw.prepare('INSERT INTO accounts(id) VALUES (?)').run('local-demo');
raw.prepare(`INSERT INTO credentials(id,account_id,kind,token_digest,expires_at,reauthenticated_at)
  VALUES (?,?, 'session',?,?,?)`).run('local-session', 'local-demo', await digestToken(token), now + 24 * 60 * 60 * 1000, now);
const memories = new MemoryService(db);
const space = await memories.createSpace(token, { name: 'Local demo' });
await memories.create(token, space.id, { body: 'This is synthetic local demo memory. Data resets when the process stops.', source: 'local-demo' });
const api = createMemoryApi(db);

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > 24 * 1024) {
        rejected = true;
        chunks.length = 0;
        reject(Object.assign(new Error('request_too_large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  try {
    const expectedHost = `127.0.0.1:${port}`;
    if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== origin)) {
      request.resume();
      response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end('{"error":"access_denied"}');
      return;
    }
    const data = await readBody(request);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    }
    const method = request.method ?? 'GET';
    const req = new Request(new URL(request.url ?? '/', origin), {
      method, headers, ...(method !== 'GET' && method !== 'HEAD' && data.length ? { body: data } : {}),
    });
    const result = await api(req);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    response.writeHead(error.status === 413 ? 413 : 500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: error.status === 413 ? 'request_too_large' : 'internal_error' }));
  }
});
server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.maxRequestsPerSocket = 100;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
const local = new URL('../.local/', import.meta.url);
await mkdir(local, { recursive: true });
const credentials = new URL('demo.json', local);
await writeFile(credentials, JSON.stringify({ origin, spaceId: space.id, token, expiresAt: now + 24 * 60 * 60 * 1000 }, null, 2), { mode: 0o600 });
console.log(`Local Standard memory API: ${origin}`);
console.log(`Synthetic demo credentials: ${fileURLToPath(credentials)}`);
console.log('Memory is ephemeral. Stop with Ctrl+C. This server binds only to 127.0.0.1.');
function stop() {
  server.close(() => { database.close(); process.exit(0); });
  server.closeAllConnections();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
