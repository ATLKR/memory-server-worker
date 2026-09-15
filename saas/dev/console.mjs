import { createServer } from 'node:http';
import { openLocalDatabase } from './sqlite.mjs';
import { WorkspaceService } from '../src/workspace.ts';
import { MemoryService } from '../src/memory.ts';
import { createApplication } from '../src/app.ts';
import { readSettings, AUTH_ISSUER, PUBLIC_ORIGIN } from '../src/config.ts';
import { IdentityService } from '../src/identity.ts';
import { createRelease } from '../src/release/extension.ts';

// Synthetic localhost preview only. This module is not in the Worker bundle.
const port = Number(process.env.MEMORY_CONSOLE_PORT ?? 8792);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid console port');
const localOrigin = `http://127.0.0.1:${port}`;
const database = openLocalDatabase({ workspace: true, release: true });
const workspace = new WorkspaceService(database.db);
const session = await workspace.signIn({ issuer: AUTH_ISSUER, subject: 'synthetic-console', email: 'demo@example.org', emailVerified: true, expiresAt: Date.now() + 900000, permission: 'write' });
const snap = await workspace.snapshot(session.token);
const memory = new MemoryService(database.db);
for (const [body, source] of [
  ['프로젝트의 결정과 맥락을 에이전트와 함께 기억합니다.\n\n새 메모리를 저장하거나 기존 기록을 수정해 보세요.', '시작 가이드'],
  ['제품 이름은 브랜드 설정으로 변경할 수 있습니다. 계정, Space, API 키는 그대로 유지됩니다.', '제품 설계'],
  ['조직의 읽기 권한과 쓰기 권한은 분리됩니다. API 키는 생성한 화면에서 한 번만 표시됩니다.', '팀 운영'],
]) await memory.create(session.token, snap.spaces[0].id, { body, source });
const settings = readSettings({ PRODUCT_NAME: 'Memory by Allen Labs · 로컬 데모' });
const release = createRelease({ DB: database.db, PUBLIC_ORIGIN, PRODUCT_NAME: settings.brand.name,
  REQUEST_LIMITER: { limit: async () => ({ success: true }) } }, { identity: new IdentityService(database.db) });
const app = createApplication(database.db, settings, { release });

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== localOrigin) ||
        (!['GET', 'HEAD'].includes(req.method ?? 'GET') && req.headers.origin !== localOrigin)) {
      req.resume(); res.writeHead(403); res.end('Local origin required.'); return;
    }
    if (req.url?.startsWith('/auth/')) { req.resume(); res.writeHead(303, { location: '/' }); res.end(); return; }
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 24576) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
    headers.set('authorization', `Bearer ${session.token}`); headers.delete('cookie'); headers.delete('host');
    if (req.headers.origin) headers.set('origin', PUBLIC_ORIGIN);
    const method = req.method ?? 'GET';
    const request = new Request(new URL(req.url ?? '/', PUBLIC_ORIGIN), { method, headers,
      ...(!['GET', 'HEAD'].includes(method) && size ? { body: Buffer.concat(chunks) } : {}),
    });
    const result = await app(request);
    const outgoing = Object.fromEntries(result.headers); delete outgoing['strict-transport-security'];
    res.writeHead(result.status, outgoing); res.end(Buffer.from(await result.arrayBuffer()));
  } catch { if (!res.headersSent) res.writeHead(500); res.end('Preview failed.'); }
});
server.requestTimeout = 10000; server.headersTimeout = 5000;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
console.log(`Synthetic console: ${localOrigin} (15-minute local session; all data resets on restart)`);
const stop = () => { server.close(() => { database.close(); process.exit(0); }); server.closeAllConnections(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
