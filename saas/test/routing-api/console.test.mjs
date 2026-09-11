import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { managementHtml, managementScript } from '../../src/release/console.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const json=value=>Response.json(value);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{resolve,promise};};
function record(org='org-one',version=3){return{id:'consent-'+org,organizationId:org,version,provider:'cloudflare-agent-memory',classification:'medical',status:'granted',
  spaceScope:{kind:'all-spaces'},scopes:['ingest','storage','extraction','embedding','recall'],validFromMs:Date.now()+3600000,evidenceRef:'company-approval-'+org,approvedBy:'alice'};}
async function page(t,custom=()=>undefined){
  let account='alice';const calls=[];
  const dom=new JSDOM(managementHtml,{url:'https://memory.allenlabs.org/manage',runScripts:'outside-only',virtualConsole:new VirtualConsole()});t.after(()=>dom.window.close());
  const w=dom.window;w.TextEncoder=TextEncoder;w.confirm=()=>{throw Error('Unexpected employee confirmation');};
  w.fetch=async(path,init={})=>{calls.push({path,init});const out=custom(path,init);if(out!==undefined)return out;
    if(path==='/v1/workspace')return json({account:{id:account,emails:[]},organizations:[{id:'org-one',name:'One',role:'owner'},{id:'org-two',name:'Two',role:'admin'}]});
    if(path.startsWith('/v1/spaces?'))return json({results:[{id:'so1',name:'One space',organizationId:'org-one'},{id:'so2',name:'Two space',organizationId:'org-two'}],nextCursor:null});
    if(path==='/v1/release/config')return json({prices:{},features:{}});
    if(path.endsWith('/medical-cloudflare-consent'))return json(record(path.includes('/org-one/')?'org-one':'org-two'));
    if(path.includes('/memories?'))return json({results:[],nextCursor:null});return json({});};
  w.eval(managementScript);await tick();await tick();await tick();
  const el=id=>w.document.getElementById(id);
  const select=org=>{el('organization').value=org;el('organization').dispatchEvent(new w.Event('change'));};
  select('org-one');
  const load=async()=>{assert.ok(el('consent-load'),'consent controls must exist');el('consent-load').click();await tick();await tick();};
  return {w,el,calls,select,load,changeAccount(value){account=value;el('reload').click();}};
}

test('admin loads current consent and submits selected org scope with its exact CAS version',async t=>{
  let submitted;const f=await page(t,(path,init)=>{if(init.method==='PUT'){submitted=JSON.parse(init.body);return json({...record(),version:4,...submitted.grant});}});
  await f.load();assert.match(f.el('consent-status').textContent,/3/);
  const form=f.el('consent-form');form.elements.evidenceRef.value='approved-change';form.elements.spaceScope.value='spaces';
  f.el('consent-space-list').querySelector('input').checked=true;
  form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();await tick();
  assert.equal(submitted.expectedVersion,3);assert.equal(submitted.grant.evidenceRef,'approved-change');
  assert.deepEqual(submitted.grant.spaceScope,{kind:'spaces',spaceIds:['so1']});
  assert.equal(submitted.approvedBy,undefined);assert.equal(submitted.organizationId,undefined);
  assert.match(f.el('consent-status').textContent,/4/);
});

test('a future standing grant can be revoked without prompting employees',async t=>{
  let submitted;const f=await page(t,(_path,init)=>{if(init.method==='DELETE'){submitted=JSON.parse(init.body);return json({...record(),version:4,status:'revoked',revokedAtMs:Date.now()});}});
  await f.load();assert.equal(f.el('consent-revoke').disabled,false);f.el('consent-revoke').click();await tick();await tick();
  assert.deepEqual(submitted,{expectedVersion:3});assert.match(f.el('consent-status').textContent,/철회/);
});

for(const transition of ['organization','account'])test('late consent save cannot display another '+transition+' record',async t=>{
  const late=deferred();const f=await page(t,(_path,init)=>init.method==='PUT'?late.promise:undefined);
  await f.load();f.el('consent-form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();
  if(transition==='organization')f.select('org-two');else f.changeAccount('bob');
  await tick();await tick();late.resolve(json({...record(),version:4,evidenceRef:'PRIVATE-OLD-CONSENT'}));await tick();await tick();
  assert.equal(f.w.document.body.textContent.includes('PRIVATE-OLD-CONSENT'),false);
  assert.equal(f.el('consent-form').elements.evidenceRef.value.includes('PRIVATE-OLD-CONSENT'),false);
  assert.equal(f.el('consent-save').disabled,true);
});

test('an uncertain save requires explicit current-state reload and never automatically retries',async t=>{
  let writes=0;const f=await page(t,(_path,init)=>{if(init.method==='PUT'){writes++;return Promise.reject(Error('synthetic lost response'));}});
  await f.load();f.el('consent-form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();await tick();
  assert.equal(writes,1);assert.match(f.el('consent-status').textContent,/결과.*확인|확인.*결과/);assert.equal(f.el('consent-save').disabled,true);
  f.el('consent-form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();assert.equal(writes,1);
  await f.load();assert.equal(f.el('consent-save').disabled,false);
});
