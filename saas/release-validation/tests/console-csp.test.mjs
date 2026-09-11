import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM,VirtualConsole} from 'jsdom';
import {fixture,at} from './db.mjs';
import {createApplication} from '../../src/app.ts';
import {createRelease} from '../../src/release/extension.ts';
import {readSettings,PUBLIC_ORIGIN} from '../../src/config.ts';
import {SESSION_COOKIE} from '../../src/auth.ts';

async function application(t){
 const f=await fixture();t.after(()=>f.db.close());
 const env={DB:f.db,SSO_CLIENT_ID:'synthetic-client',REQUEST_LIMITER:{limit:async()=>({success:true})}};
 return {...f,app:createApplication(f.db,readSettings(env),{clock:()=>at,release:createRelease(env,{clock:()=>at})})};
}
const directives=response=>Object.fromEntries(response.headers.get('content-security-policy').split(';').map(value=>value.trim().split(/\s+/)).map(([name,...values])=>[name,values]));
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const until=async(predicate,message)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(message());};

test('management response forbids native form navigation before any script runs, including billing return URLs',async t=>{
 const f=await application(t);
 for(const path of ['/manage','/manage?billing=success','/manage?billing=cancel']){
  const response=await f.app(new Request(PUBLIC_ORIGIN+path));assert.equal(response.status,200);
  const dom=new JSDOM(await response.text(),{url:PUBLIC_ORIGIN+path,runScripts:'outside-only'});t.after(()=>dom.window.close());
  const memory=dom.window.document.querySelector('#add-form'),proof=dom.window.document.querySelector('#reauth-complete');
  // These GET defaults would put memory/proof in the URL if the response CSP
  // allowed native submission while JavaScript was blocked or still loading.
  assert.equal(memory.method,'get');assert.ok(memory.elements.body);assert.ok(proof.elements.proof);
  assert.deepEqual(directives(response)['form-action'],["'none'"]);
  assert.deepEqual(directives(response)['connect-src'],["'self'"]);
  assert.ok(dom.window.document.querySelector('a[href="/auth/login"]'));
 }
 const home=await f.app(new Request(PUBLIC_ORIGIN+'/'));
 assert.deepEqual(directives(home)['form-action'],["'self'"]);
});

test('management script still submits memory and proof through same-origin JSON fetch without form navigation',async t=>{
 const f=await application(t),response=await f.app(new Request(PUBLIC_ORIGIN+'/manage'));
 const dom=new JSDOM(await response.text(),{url:PUBLIC_ORIGIN+'/manage',runScripts:'outside-only',virtualConsole:new VirtualConsole()});t.after(()=>dom.window.close());
 const w=dom.window,calls=[];w.TextEncoder=TextEncoder;
 w.fetch=async(path,options={})=>{
  const headers=new Headers(options.headers);headers.set('cookie',`${SESSION_COOKIE}=${f.token}`);headers.set('origin',PUBLIC_ORIGIN);
  calls.push({path,method:options.method??'GET',body:options.body,contentType:headers.get('content-type')});
  return f.app(new Request(new URL(path,PUBLIC_ORIGIN),{...options,headers}));
 };
 const script=await f.app(new Request(PUBLIC_ORIGIN+'/assets/release.js'));w.eval(await script.text());
 await until(()=>!w.document.querySelector('#add-form button').disabled,()=>w.document.querySelector('#status').textContent);await settle();
 const memory=w.document.querySelector('#add-form');assert.equal(memory.querySelector('button').disabled,false);
 memory.elements.body.value='SYNTHETIC_PRIVATE_MEMORY';memory.elements.source.value='synthetic source';
 const submit=new w.Event('submit',{bubbles:true,cancelable:true});assert.equal(memory.dispatchEvent(submit),false);
 await until(()=>!memory.querySelector('button').disabled,()=>w.document.querySelector('#status').textContent);await settle();
 const created=calls.find(call=>call.method==='POST'&&call.path==='/v1/spaces/s1/memories');
 assert.ok(created);assert.equal(created.contentType,'application/json');assert.equal(JSON.parse(created.body).body,'SYNTHETIC_PRIVATE_MEMORY');
 assert.equal(f.db.raw.prepare("SELECT count(*) n FROM memories WHERE body='SYNTHETIC_PRIVATE_MEMORY'").get().n,1);
 const proof=w.document.querySelector('#reauth-complete');proof.elements.challengeId.value='synthetic-challenge';proof.elements.proof.value='SYNTHETIC_PRIVATE_PROOF';
 assert.equal(proof.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})),false);
 await until(()=>!proof.querySelector('button').disabled,()=>w.document.querySelector('#status').textContent);await settle();
 const verification=calls.find(call=>call.path==='/v1/account/reauth/complete');assert.ok(verification);assert.equal(verification.method,'POST');assert.equal(JSON.parse(verification.body).proof,'SYNTHETIC_PRIVATE_PROOF');
 assert.ok(calls.every(call=>!call.path.includes('SYNTHETIC_PRIVATE')));assert.equal(w.location.href,PUBLIC_ORIGIN+'/manage');
 assert.deepEqual(directives(response)['connect-src'],["'self'"]);
});
