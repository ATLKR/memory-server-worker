import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../../src/app.ts';
import { readSettings, PUBLIC_ORIGIN } from '../../src/config.ts';

const unavailableDatabase = { prepare() { throw Error('Health must not inspect application data'); } };
test('an unstamped health response cannot claim a deployable source', async () => {
  const app=createApplication(unavailableDatabase,readSettings({SSO_CLIENT_ID:'local'}));
  const response=await app(new Request(PUBLIC_ORIGIN+'/health'));
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).build,{sourceRevision:'unreleased',resourceFingerprint:'',payloadFormat:2});
  assert.equal(response.headers.get('cache-control'),'no-store');
});
test('health identifies actual compiled source and configuration independently of runtime variables', async () => {
  const sourceRevision='a'.repeat(40),resourceFingerprint='b'.repeat(64);
  const output=await build({entryPoints:[fileURLToPath(new URL('../../src/app.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent',
    define:{BUILD_SOURCE_REVISION:JSON.stringify(sourceRevision),BUILD_RESOURCE_FINGERPRINT:JSON.stringify(resourceFingerprint)}});
  const module=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
  const app=module.createApplication(unavailableDatabase,readSettings({SSO_CLIENT_ID:'local',SOURCE_REVISION:'forged-runtime',PAYLOAD_KEY:'never-public'}));
  const response=await app(new Request(PUBLIC_ORIGIN+'/health')),body=await response.json();
  assert.deepEqual(body.build,{sourceRevision,resourceFingerprint,payloadFormat:2});
  assert.ok(!JSON.stringify(body).includes('never-public'));
});
