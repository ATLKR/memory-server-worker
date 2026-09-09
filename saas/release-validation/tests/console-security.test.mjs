import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { managementHtml, managementScript } from '../../src/release/console.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve};};
const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
async function page(t,fetcher){
 const dom=new JSDOM(managementHtml,{url:'https://memory.allenlabs.org/manage',runScripts:'outside-only',virtualConsole:new VirtualConsole()});
 t.after(()=>dom.window.close());const w=dom.window;
 w.fetch=async(path,init)=>{
  const custom=fetcher(path,init);
  if(custom!==undefined)return custom;
  if(path==='/v1/workspace')return json({account:{id:'alice',emails:[{id:'email-one',address:'owner@example.org'}]},organizations:[]});
  if(path.startsWith('/v1/spaces?'))return json({results:[{id:'s1',name:'Personal A',organizationId:null},{id:'s2',name:'Personal B',organizationId:null}],nextCursor:null});
  if(path==='/v1/release/config')return json({prices:{}});
  if(path.includes('/memories?'))return json({results:[],nextCursor:null});
  return json({});
 };
 w.eval(managementScript);await tick();await tick();return w;
}
test('management ignores a slow previous Space list after the user selects another Space',async t=>{
 let active=false;const old=deferred();
 const w=await page(t,path=>active&&path.startsWith('/v1/spaces/s1/memories?')?old.promise:undefined);
 active=true;w.document.getElementById('refresh-memories').click();await tick();
 const select=w.document.getElementById('space');select.value='s2';select.dispatchEvent(new w.Event('change'));await tick();
 old.resolve(json({results:[{id:'old-memory',body:'PRIVATE OLD SPACE',revision:1}],nextCursor:null}));
 await tick();await tick();
 assert.equal(select.value,'s2');assert.doesNotMatch(w.document.getElementById('memories').textContent,/PRIVATE OLD SPACE/);
});
test('management clear result fences a pending newly issued credential',async t=>{
 const late=deferred();const w=await page(t,path=>path==='/v1/keys'?late.promise:undefined);
 const form=w.document.getElementById('key-form');form.elements.label.value='test';
 form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 w.document.getElementById('clear-result').click();
 late.resolve(json({id:'key:one',token:'mem_PRIVATE_TEST_TOKEN'}));await tick();await tick();
 assert.doesNotMatch(w.document.getElementById('result').textContent,/mem_PRIVATE_TEST_TOKEN/);
});
test('management logout clears displayed secrets immediately and rejects later key responses',async t=>{
 const late=deferred(),logout=deferred();const w=await page(t,path=>path==='/v1/keys'?late.promise:path==='/auth/logout'?logout.promise:undefined);
 w.document.getElementById('result').textContent='existing-private-token';
 const form=w.document.getElementById('key-form');form.elements.label.value='test';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 w.document.getElementById('logout').click();
 assert.doesNotMatch(w.document.getElementById('result').textContent,/existing-private-token/);
 late.resolve(json({id:'key:one',token:'mem_PRIVATE_LATE_TOKEN'}));await tick();await tick();
 assert.doesNotMatch(w.document.getElementById('result').textContent,/mem_PRIVATE_LATE_TOKEN/);
 logout.resolve(new Response(null,{status:204}));
});
test('management drafts stay with their Space and typing during save is retained',async t=>{
 const late=deferred();const w=await page(t,(path,init)=>path==='/v1/spaces/s1/memories'&&init.method==='POST'?late.promise:undefined);
 const form=w.document.getElementById('add-form'),select=w.document.getElementById('space');
 form.elements.body.value='personal draft';
 select.value='s2';select.dispatchEvent(new w.Event('change'));await tick();
 assert.equal(form.elements.body.value,'');
 form.elements.body.value='team draft';
 select.value='s1';select.dispatchEvent(new w.Event('change'));await tick();
 assert.equal(form.elements.body.value,'personal draft');
 form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 form.elements.body.value='new text typed while request is pending';
 late.resolve(json({id:'saved',body:'personal draft',revision:1}));await tick();await tick();
 assert.equal(form.elements.body.value,'new text typed while request is pending');
});
test('management finishes initial loading and ignores an older list after a search',async t=>{
 let active=false;const old=deferred();
 const w=await page(t,path=>active&&path.includes('/memories?limit=')?old.promise:path.includes('/memories?query=')?json({results:[{id:'search-result',body:'LATEST SEARCH RESULT',revision:1}],mode:'lexical'}):undefined);
 assert.equal(w.document.getElementById('status').textContent,'완료');
 active=true;w.document.getElementById('refresh-memories').click();await tick();
 const form=w.document.getElementById('search-form');form.elements.query.value='latest';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 old.resolve(json({results:[{id:'old-list',body:'STALE LIST DATA',revision:1}],nextCursor:null}));await tick();await tick();
 assert.match(w.document.getElementById('memories').textContent,/LATEST SEARCH RESULT/);
 assert.doesNotMatch(w.document.getElementById('memories').textContent,/STALE LIST DATA/);
});
test('PAT issuance derives tenant from the selected Space and preserves selected capabilities',async t=>{
 const issued=[];
 const w=await page(t,(path,init)=>{
  if(path==='/v1/workspace')return json({account:{id:'alice',emails:[]},organizations:[{id:'org-a',name:'Organization A',role:'owner'},{id:'org-b',name:'Organization B',role:'owner'}]});
  if(path.startsWith('/v1/spaces?'))return json({results:[{id:'personal',name:'Personal',organizationId:null},{id:'team',name:'Team',organizationId:'org-a'}],nextCursor:null});
  if(path==='/v1/keys'){issued.push(JSON.parse(init.body));return json({id:'key:'+issued.length});}
 });
 const form=w.document.getElementById('key-form'),select=w.document.getElementById('space');
 select.value='team';select.dispatchEvent(new w.Event('change'));await tick();
 w.document.getElementById('organization').value='org-b';
 form.elements.label.value='MCP connection';form.querySelector('input[value="create"]').checked=true;
 assert.equal(form.elements.singleSpace.checked,true);
 const submit=async()=>{form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();};
 await submit();
 assert.deepEqual(issued[0],{label:'MCP connection',capabilities:['read','create'],expiresInDays:30,spaceIds:['team'],organizationId:'org-a'});
 form.elements.singleSpace.checked=false;await submit();
 assert.deepEqual(issued[1],{label:'MCP connection',capabilities:['read','create'],expiresInDays:30,organizationId:'org-a'});
 select.value='personal';select.dispatchEvent(new w.Event('change'));await tick();
 await submit();
 assert.deepEqual(issued[2],{label:'MCP connection',capabilities:['read','create'],expiresInDays:30});
 assert.match(w.document.getElementById('key-form').closest('details').querySelector('summary').textContent,/PAT.*개인 액세스 토큰/);
 assert.match(w.document.getElementById('mcp-connection').textContent,/https:\/\/memory\.allenlabs\.org\/mcp/);
});

test('management disables unavailable provider actions and explains manual retention',async t=>{
 const w=await page(t,path=>path==='/v1/release/config'?json({prices:{},features:{semantic:false,ingestion:false,mail:true,billing:false,backgroundJobs:false},policy:{automaticErasure:false}}):undefined);
 for(const selector of ['#ingest-form button','#rebuild','#checkout-form button','#portal'])assert.equal(w.document.querySelector(selector).disabled,true,selector);
 assert.equal(w.document.querySelector('#reauth-start button').disabled,false);
 assert.match(w.document.getElementById('feature-status').textContent,/추출.*사용할 수 없/);
 assert.match(w.document.getElementById('retention-status').textContent,/자동.*꺼져/);
});
