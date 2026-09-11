import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const account = 'a'.repeat(32);
const { outputFiles } = await build({ stdin: {
  contents: `import {createAgentMemoryHttp} from './src/agent-memory/http.ts';
    export default {async fetch(request) {
      const provider=createAgentMemoryHttp({accountId:'${account}',namespace:'synthetic-runtime',token:'synthetic-provider-token'});
      try {
        if(new URL(request.url).pathname==='/ingest') {
          await provider.ingest('synthetic-profile',[{role:'user',content:'Synthetic fixture only.'}],'synthetic-session');
          return Response.json({accepted:true});
        }
        return Response.json(await provider.list('synthetic-profile'));
      } catch(error) {return Response.json({code:error.code,outcome:error.outcome},{status:502});}
    }}`,
  resolveDir: fileURLToPath(new URL('../../', import.meta.url)), sourcefile: 'provider-runtime.mjs', loader: 'js',
}, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });

async function fixture(t, handler) {
  const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-09-08',
    script: outputFiles[0].text, outboundService: async request => {
      calls.push({url:request.url,method:request.method});
      return handler(request);
    },
  }));
  t.after(() => mf.dispose());
  return { mf, calls };
}

test('actual workerd dispatches Agent Memory ingest with the fixed provider credential', async t => {
  const f = await fixture(t, async request => {
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-provider-token');
    assert.deepEqual(await request.json(), {messages:[{role:'user',content:'Synthetic fixture only.'}],sessionId:'synthetic-session'});
    return Response.json({success:true,errors:[],messages:[],result:null});
  });
  const response = await f.mf.dispatchFetch('https://memory.example.test/ingest');
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {accepted:true});
  assert.deepEqual(f.calls, [{url:`https://api.cloudflare.com/client/v4/accounts/${account}/agent-memory/namespaces/synthetic-runtime/profiles/synthetic-profile/ingest`,method:'POST'}]);
});

test('actual workerd never follows Agent Memory redirects or resubmits a write', async t => {
  const f = await fixture(t, () => new Response(null, {status:307,headers:{location:'https://untrusted.example.test/collect'}}));
  const response = await f.mf.dispatchFetch('https://memory.example.test/ingest');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {code:'agent_memory_http_error',outcome:'unknown'});
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.startsWith('https://api.cloudflare.com/'));
});
