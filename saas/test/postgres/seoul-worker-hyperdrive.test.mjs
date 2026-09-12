import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {createSeoulWorkerApp} from '../../src/postgres/seoul/worker-config.ts';
import {createLifecycleFixture} from './seoul-lifecycle-fixture.mjs';

const origin='https://seoul-hyperdrive.example.test';
const binding=(database='template1')=>({connectionString:`postgres://proxy_user:synthetic_proxy@proxy.example.test:5432/${database}?sslmode=disable`,
 host:'proxy.example.test',port:5432,user:'proxy_user',password:'synthetic_proxy',database});
const environment=(database='template1')=>({MEMORY_SEOUL_ENABLED:'true',MEMORY_SEOUL_TRANSPORT:'hyperdrive',
 MEMORY_SEOUL_TARGET_JSON:JSON.stringify({database,expectedRole:'memory_seoul_runtime',deploymentId:'memory-seoul'}),
 SEOUL_HYPERDRIVE:binding(database)});
const discovery=app=>app.fetch(new Request(origin+'/.well-known/memory-routing-v2'));

test('Hyperdrive configuration rejects mixed, missing, malformed and accessor bindings before client construction',async()=>{
 let constructed=0,reads=0;
 const cases=[
  {...environment(),MEMORY_SEOUL_TRANSPORT:'unknown'},
  {...environment(),SEOUL_HYPERDRIVE:undefined},
  {...environment(),MEMORY_SEOUL_RUNTIME_PASSWORD:'synthetic_origin_password'},
  {...environment(),MEMORY_SEOUL_TLS_CA:'synthetic_origin_ca'},
  {...environment(),MEMORY_SEOUL_TARGET_JSON:JSON.stringify({database:'template1',expectedRole:'memory_seoul_runtime',deploymentId:'memory-seoul',host:'origin.example.test'})},
  {...environment(),SEOUL_HYPERDRIVE:{...binding(),connectionString:binding().connectionString+'&options=unsafe'}},
  {...environment(),SEOUL_HYPERDRIVE:{...binding(),database:'different'}},
 ];
 const accessor=environment();Object.defineProperty(accessor.SEOUL_HYPERDRIVE,'password',{get(){reads++;throw Error('private');}});cases.push(accessor);
 const envAccessor=environment();Object.defineProperty(envAccessor,'SEOUL_HYPERDRIVE',{get(){reads++;throw Error('private');}});cases.push(envAccessor);
 for(const env of cases){
  const app=createSeoulWorkerApp(env,{clientFactory(){constructed++;throw Error('private');}});
  assert.equal((await(await discovery(app)).json()).target.ready,false);
  assert.equal((await app.fetch(new Request(origin+'/mcp',{method:'POST',headers:{'x-memory-routing':'2'}}))).status,503);
 }
 assert.equal(constructed,0);assert.equal(reads,0);
});

test('Hyperdrive Hono composition snapshots proxy credentials and attests the distinct origin role before PAT body access',async t=>{
 const fixture=await createLifecycleFixture(t);
 const initial=(await fixture.db.query('SELECT current_database() AS database, session_user AS role')).rows[0];
 const env=environment(initial.database),plans=[];
 // Native bindings have a runtime prototype and additional fields. Only six
 // own primitive fields form the validated plain-data transport snapshot.
 Object.setPrototypeOf(env.SEOUL_HYPERDRIVE,{connect(){throw Error('must not call binding.connect');}});
 env.SEOUL_HYPERDRIVE.ip='240.0.0.1';
 const app=createSeoulWorkerApp(env,{clientFactory(plan){
  plans.push(plan);return {
   async connect(){await fixture.db.exec('SET SESSION AUTHORIZATION memory_seoul_runtime');},
   async query(query){const r=await fixture.db.query(query.text,query.values);return {rows:r.rows,rowCount:r.affectedRows??null};},
   async end(){await fixture.db.exec(`ROLLBACK; SET SESSION AUTHORIZATION "${initial.role.replaceAll('"','""')}"`);},on(){},
  };
 }});
 env.SEOUL_HYPERDRIVE.password='changed';env.SEOUL_HYPERDRIVE.connectionString='changed';
 env.MEMORY_SEOUL_TARGET_JSON='changed';
 assert.equal((await(await discovery(app)).json()).target.ready,true);
 assert.equal(plans.length,1);assert.equal(plans[0].transport,'hyperdrive');
 assert.equal(plans[0].config.connectionString,binding(initial.database).connectionString);
 assert.equal(plans[0].startup.user,'proxy_user');assert.equal(plans[0].config.ssl,undefined);
 assert.ok(Object.isFrozen(plans[0]));assert.ok(Object.isFrozen(plans[0].config));
 let bodyReads=0;
 const request=new Request(origin+'/mcp',{method:'POST',headers:{authorization:'Bearer '+'z'.repeat(40),
  'x-memory-routing':'2','content-type':'application/json'},duplex:'half',
  body:new ReadableStream({pull(){bodyReads++;}},{highWaterMark:0})});
 assert.equal((await app.fetch(request)).status,401);assert.equal(bodyReads,0);assert.equal(plans.length,2);
});

test('actual workerd Hyperdrive binding reaches the discriminated driver factory without a native password', {timeout:30000}, async()=>{
 const script=`import {createSeoulWorkerApp} from './src/postgres/seoul/worker-config.ts';
 export default {async fetch(request,env){let calls=0,valid=false;
 const app=createSeoulWorkerApp({...env,MEMORY_SEOUL_ENABLED:'true',MEMORY_SEOUL_TRANSPORT:'hyperdrive',
 MEMORY_SEOUL_TARGET_JSON:JSON.stringify({database:'template1',expectedRole:'memory_seoul_runtime',deploymentId:'memory-seoul'})},
 {clientFactory(plan){calls++;valid=plan.transport==='hyperdrive'&&typeof plan.config.connectionString==='string'
 &&plan.startup.user===env.SEOUL_HYPERDRIVE.user&&!('ssl'in plan.config);throw Error('synthetic_stop_before_connect');}});
 const response=await app.fetch(new Request('https://fixture.test/.well-known/memory-routing-v2'));
 return Response.json({calls,valid,ready:(await response.json()).target.ready});}}`;
 const built=await build({absWorkingDir:fileURLToPath(new URL('../../',import.meta.url)),stdin:{contents:script,resolveDir:fileURLToPath(new URL('../../',import.meta.url)),loader:'ts'},
 bundle:true,write:false,format:'esm',platform:'node',target:'es2022',conditions:['workerd','worker','browser'],
 banner:{js:"import {createRequire as _r}from'node:module';const require=_r('/worker/index.mjs');"}});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'hyperdrive-composition',modules:true,cf:false,host:'127.0.0.1',
 script:built.outputFiles[0].text,compatibilityDate:'2026-09-07',compatibilityFlags:['nodejs_compat'],log:new Log(LogLevel.NONE),
 hyperdrives:{SEOUL_HYPERDRIVE:'postgres://synthetic_role:synthetic_only@127.0.0.1:1/template1'}}));
 try{assert.deepEqual(await(await mf.dispatchFetch(origin)).json(),{calls:1,valid:true,ready:false});}
 finally{await mf.dispose();}
});
