import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('legacy typed and literal consumers preserve v1 while explicit v2 exposes its distinct placement',()=>{
  const cwd=fileURLToPath(new URL('../../',import.meta.url));
  const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','test/postgres/routing.types.tsconfig.json'],
    {cwd,encoding:'utf8',timeout:20000,maxBuffer:1024*1024,windowsHide:true});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);
});
