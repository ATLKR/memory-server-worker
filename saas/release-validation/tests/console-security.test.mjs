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
 w.TextEncoder=TextEncoder;
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

for(const transition of ['space','account','logout','refresh'])test('a stale outbound page cannot refill the view after '+transition,async t=>{
 const late=deferred();let account='alice',reads=0;const w=await page(t,path=>path==='/v1/workspace'?json({account:{id:account,emails:[]},organizations:[]}):path.startsWith('/v1/spaces/s1/shares?')?(++reads===1?late.promise:json({results:[{id:'new-row',recipientEmail:'new@example.org',createdAt:1,expiresAt:2,acceptedAt:null,revokedAt:null}],nextCursor:null})):path==='/auth/logout'?new Response(null,{status:204}):undefined);
 w.document.getElementById('outbound-shares-refresh').click();await tick();
 if(transition==='space'){const select=w.document.getElementById('space');select.value='s2';select.dispatchEvent(new w.Event('change'));}
 if(transition==='account'){account='bob';w.document.getElementById('reload').click();}
 if(transition==='logout')w.document.getElementById('logout').click();
 if(transition==='refresh')w.document.getElementById('outbound-shares-refresh').click();await tick();await tick();
 late.resolve(json({results:[{id:'STALE-ROW',recipientEmail:'OLD-PRIVATE@example.org',createdAt:1,expiresAt:2}],nextCursor:'old-cursor'}));await tick();await tick();
 assert.doesNotMatch(w.document.getElementById('outbound-shares').textContent,/STALE-ROW|OLD-PRIVATE/);assert.equal(w.document.getElementById('outbound-shares-more').hidden,true);
 if(transition==='refresh')assert.match(w.document.getElementById('outbound-shares').textContent,/new-row/);
});

test('outbound failed next page retains its cursor and rows for an incremental retry',async t=>{
 let reads=0;const w=await page(t,path=>path.startsWith('/v1/spaces/s1/shares?')?(++reads===2?Promise.reject(Error('Network failure')):json({results:[{id:reads===1?'first':'last',recipientEmail:'recipient@example.org',createdAt:1,expiresAt:2}],nextCursor:reads===1?'next+/=':null})):undefined);
 w.document.getElementById('outbound-shares-refresh').click();await tick();await tick();w.document.getElementById('outbound-shares-more').click();await tick();await tick();
 assert.equal(w.document.getElementById('outbound-shares').children.length,1);assert.equal(w.document.getElementById('outbound-shares-more').hidden,false);assert.equal(w.document.getElementById('outbound-shares-more').disabled,false);
 w.document.getElementById('outbound-shares-more').click();await tick();await tick();assert.equal(w.document.getElementById('outbound-shares').children.length,2);assert.equal(reads,3);
});

test('outbound row revocation cannot refresh a subsequently selected Space',async t=>{
 const pending=deferred(),calls=[];const w=await page(t,(path,init)=>{calls.push(path);if(path==='/v1/spaces/s1/shares/old-share'&&init.method==='DELETE')return pending.promise;if(path.startsWith('/v1/spaces/s1/shares?'))return json({results:[{id:'old-share',recipientEmail:'old@example.org',createdAt:1,expiresAt:2}],nextCursor:null});});
 w.document.getElementById('outbound-shares-refresh').click();await tick();await tick();w.document.getElementById('outbound-shares').querySelector('button').click();await tick();
 const select=w.document.getElementById('space');select.value='s2';select.dispatchEvent(new w.Event('change'));await tick();pending.resolve(new Response(null,{status:204}));await tick();await tick();
 assert.equal(w.document.getElementById('outbound-shares').children.length,0);assert.equal(calls.some(path=>path.startsWith('/v1/spaces/s2/shares')),false);
});

test('known read-only Space permissions disable sent-share listing and mutation controls',async t=>{
 const w=await page(t,path=>path==='/v1/workspace'?json({account:{id:'alice',emails:[]},spaces:[{id:'s1',canWrite:false}],organizations:[]}):undefined);
 for(const selector of ['#outbound-shares-refresh','#outbound-shares-more','#share-form button','#share-revoke button'])assert.equal(w.document.querySelector(selector).disabled,true,selector);
});

for(const state of ['cancelled','approved','failed','expired'])test('extraction controls follow the newer detail state '+state,async t=>{
 const w=await page(t,path=>path==='/v1/spaces/s1/ingests'?json({results:[{id:'changing-job',state:'review'}]}):path==='/v1/spaces/s1/ingests/changing-job'?json({id:'changing-job',state,proposals:[]}):undefined);
 w.document.getElementById('ingests').click();await tick();await tick();const panel=w.document.getElementById('proposals');assert.match(panel.textContent,new RegExp(state));
 assert.equal([...panel.querySelectorAll('button')].some(button=>button.textContent.includes('승인')),false);assert.equal([...panel.querySelectorAll('button')].some(button=>button.textContent.includes('취소')),state==='failed');
});

test('failed management logout disables standalone actions while leaving retry available',async t=>{
 const w=await page(t,path=>path==='/auth/logout'?Promise.reject(Error('Failed to fetch')):undefined);w.document.getElementById('logout').click();await tick();await tick();
 for(const button of w.document.querySelectorAll('main button'))assert.equal(button.disabled,true,button.id||button.textContent);
 assert.equal(w.document.getElementById('logout').disabled,false);assert.equal(w.document.getElementById('reload').disabled,false);
});

for(const transition of ['space','organization','refresh','account','clear','logout'])test('outbound share identifiers survive only safe '+transition+' transitions',async t=>{
 const pending=deferred();let account='alice';const w=await page(t,path=>path==='/v1/workspace'?json({account:{id:account,emails:[]},organizations:[{id:'org',name:'Org',role:'owner'}]}):path==='/v1/spaces/s1/shares'?pending.promise:path==='/auth/logout'?new Response(null,{status:204}):undefined);
 w.document.getElementById('share-form').elements.email.value='recipient@example.org';w.document.getElementById('share-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 if(transition==='space'){const select=w.document.getElementById('space');select.value='s2';select.dispatchEvent(new w.Event('change'));}
 if(transition==='organization'){const select=w.document.getElementById('organization');select.value='org';select.dispatchEvent(new w.Event('change'));}
 if(transition==='refresh')w.document.getElementById('reload').click();
 if(transition==='account'){account='bob';w.document.getElementById('reload').click();}
 if(transition==='clear')w.document.getElementById('clear-result').click();
 if(transition==='logout')w.document.getElementById('logout').click();
 await tick();await tick();pending.resolve(json({id:'share-original',expiresAt:9999999999}));await tick();await tick();
 assert.equal(w.document.getElementById('mutation-receipts').textContent.includes('share-original'),['space','organization','refresh'].includes(transition));
 if(['space','organization','refresh'].includes(transition))assert.match(w.document.getElementById('mutation-receipts').textContent,/alice.*s1.*읽기 공유/);
});

test('non-secret follow-up identifiers outlive secret timers and explicit clearing removes both',async t=>{
 let shares=0;const w=await page(t,path=>path==='/v1/spaces/s1/shares'?json({id:'durable-share-id-'+(++shares)}):path==='/v1/keys'?json({id:'key-id',token:'mem_TEMPORARY_SECRET'}):undefined),timers=[];
 const original=w.setTimeout.bind(w);w.setTimeout=(fn,ms)=>ms===60000?(timers.push(fn),-timers.length):original(fn,ms);
 for(const id of ['share-form','share-form','key-form']){w.document.getElementById(id).dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();}
 for(const timer of timers)timer();assert.match(w.document.getElementById('mutation-receipts').textContent,/durable-share-id-1/);assert.match(w.document.getElementById('mutation-receipts').textContent,/durable-share-id-2/);assert.doesNotMatch(w.document.getElementById('mutation-receipts').textContent,/mem_TEMPORARY_SECRET/);
 w.document.getElementById('clear-result').click();assert.equal(w.document.getElementById('mutation-receipts').hidden,true);assert.equal(w.document.getElementById('receipt-list').children.length,0);
});

test('DNS challenge proof expires from both the receipt and the common result',async t=>{
 const w=await page(t,path=>path==='/v1/workspace'?json({account:{id:'alice',emails:[]},organizations:[{id:'org',name:'Org',role:'owner'}]}):path==='/v1/organizations/org/domains'?json({id:'challenge-id',name:'_memory-verification.example.org',type:'TXT',value:'memory-verification=PRIVATE_DNS_PROOF',expiresAt:9999999999}):undefined),timers=new Map();let next=0;
 const originalSet=w.setTimeout.bind(w),originalClear=w.clearTimeout.bind(w);w.setTimeout=(fn,delay)=>delay===60000?(timers.set(--next,fn),next):originalSet(fn,delay);w.clearTimeout=id=>id<0?timers.delete(id):originalClear(id);
 const select=w.document.getElementById('organization');select.value='org';select.dispatchEvent(new w.Event('change'));
 const form=w.document.getElementById('domain-start');form.elements.domain.value='example.org';form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
 assert.match(w.document.getElementById('result').textContent,/PRIVATE_DNS_PROOF/);assert.match(w.document.getElementById('mutation-receipts').textContent,/PRIVATE_DNS_PROOF/);
 for(const fn of [...timers.values()])fn();
 assert.doesNotMatch(w.document.body.textContent,/PRIVATE_DNS_PROOF/);assert.equal(w.document.getElementById('mutation-receipts').hidden,true);
});

for(const [control,path,response]of [['add-form','/v1/spaces/s1/memories',{id:'memory-receipt',spaceId:'s1',body:'PRIVATE MEMORY BODY',revision:1}],['ingest-form','/v1/spaces/s1/ingests',{id:'ingest-receipt',state:'queued'}],['email-complete','/v1/account/emails/verify',{emailId:'email-receipt'}],['export','/v1/spaces/s1/exports',{id:'export-receipt',expiresAt:9999999999}],['checkout-form','/v1/spaces/s1/billing/checkout',{url:'https://billing.example/session-receipt'}],['portal','/v1/spaces/s1/billing/portal',{url:'https://billing.example/portal-receipt'}]])test(control+' retains its follow-up identity without continuing a previous Space action',async t=>{
 const pending=deferred(),calls=[];const w=await page(t,(url,init)=>{calls.push(url);if(url==='/v1/release/config')return json({prices:{price_one:{plan:'Pilot'}},features:{ingestion:true,billing:true}});if(url===path&&init.method==='POST')return pending.promise;});
 w.document.getElementById('add-form').elements.body.value='PRIVATE MEMORY BODY';w.document.getElementById('ingest-form').elements.messages.value=JSON.stringify([{id:'source',role:'user',content:'PRIVATE SOURCE'}]);
 const el=w.document.getElementById(control);if(el.tagName==='FORM')el.dispatchEvent(new w.Event('submit',{cancelable:true}));else el.click();await tick();
 const select=w.document.getElementById('space');select.value='s2';select.dispatchEvent(new w.Event('change'));await tick();await tick();pending.resolve(json(response));await tick();await tick();
 const receipt=w.document.getElementById('mutation-receipts').textContent;assert.ok(receipt.includes(response.id||response.emailId||response.url));assert.doesNotMatch(receipt,/PRIVATE MEMORY BODY|PRIVATE SOURCE/);assert.match(receipt,/alice.*s1/);
 assert.equal(w.document.getElementById('result').textContent,'');if(control==='export')assert.equal(calls.some(url=>url.includes('/exports/export-receipt')),false);
});

for(const transition of ['space','account','clear','logout'])test('late issuance receipt remains bound across '+transition,async t=>{
 const late=deferred();let account='alice';const w=await page(t,path=>path==='/v1/workspace'?json({account:{id:account,emails:[]},organizations:[]}):path==='/v1/keys'?late.promise:path==='/auth/logout'?new Response(null,{status:204}):undefined);
 const form=w.document.getElementById('key-form');form.elements.label.value='Late scoped key';form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 if(transition==='space'){const select=w.document.getElementById('space');select.value='s2';select.dispatchEvent(new w.Event('change'));}
 if(transition==='account'){account='bob';w.document.getElementById('reload').click();}
 if(transition==='clear')w.document.getElementById('clear-result').click();
 if(transition==='logout')w.document.getElementById('logout').click();
 await tick();await tick();late.resolve(json({id:'key-late',token:'mem_BOUND_RECEIPT'}));await tick();await tick();
 assert.equal(w.document.body.textContent.includes('mem_BOUND_RECEIPT'),transition==='space');
 if(transition==='space'){assert.match(w.document.getElementById('mutation-receipts').textContent,/s1|Personal A/);assert.equal(w.document.getElementById('space').value,'s2');}
});

test('late SCIM issuance retains its original organization scope after another organization is selected',async t=>{
 const late=deferred();const w=await page(t,path=>path==='/v1/workspace'?json({account:{id:'alice',emails:[]},organizations:[{id:'org-one',name:'One',role:'owner'},{id:'org-two',name:'Two',role:'owner'}]}):path.endsWith('/scim-keys')?late.promise:undefined);
 const select=w.document.getElementById('organization');select.value='org-one';select.dispatchEvent(new w.Event('change'));w.document.getElementById('scim-key').click();await tick();
 select.value='org-two';select.dispatchEvent(new w.Event('change'));late.resolve(json({token:'scim_ORIGINAL_SCOPE'}));await tick();await tick();
 assert.match(w.document.getElementById('mutation-receipts').textContent,/org-one.*SCIM/);assert.match(w.document.getElementById('mutation-receipts').textContent,/scim_ORIGINAL_SCOPE/);
 assert.equal(select.value,'org-two');
});

test('issuance receipts expire and both independent credentials remain copyable until then',async t=>{
 let count=0;const w=await page(t,path=>path==='/v1/keys'?json({id:'key-'+(++count),token:'mem_RECEIPT_'+count}):undefined),timers=new Map();let next=0;
 const originalSet=w.setTimeout.bind(w),originalClear=w.clearTimeout.bind(w);w.setTimeout=(fn,delay)=>delay===60000?(timers.set(--next,fn),next):originalSet(fn,delay);w.clearTimeout=id=>id<0?timers.delete(id):originalClear(id);
 const form=w.document.getElementById('key-form');for(let i=0;i<2;i++){form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();}
 assert.match(w.document.getElementById('mutation-receipts').textContent,/mem_RECEIPT_1/);assert.match(w.document.getElementById('mutation-receipts').textContent,/mem_RECEIPT_2/);
 for(const fn of [...timers.values()])fn();
 assert.doesNotMatch(w.document.body.textContent,/mem_RECEIPT_/);assert.equal(w.document.getElementById('mutation-receipts').hidden,true);
});

for(const [formId,path,field,response]of [['reauth-start','/v1/account/reauth','reauth-id',{id:'challenge'}],['email-start','/v1/account/emails','email-challenge',{challengeId:'challenge'}]])test(formId+' binds challenge fields and result to the initiating task',async t=>{
 const old=deferred();let hold=false;
 const w=await page(t,(url,init)=>url==='/v1/release/config'?json({prices:{},features:{mail:true}}):url===path?(hold?old.promise:json(response)):url==='/v1/keys'?json({id:'key',token:'mem_NEW_SECRET'}):undefined);
 const submit=id=>w.document.getElementById(id).dispatchEvent(new w.Event('submit',{cancelable:true}));
 submit(formId);await tick();await tick();assert.equal(w.document.getElementById(field).value,'challenge');
 w.document.getElementById(field).value='Keep newer user input';hold=true;submit(formId);await tick();submit('key-form');await tick();await tick();
 const displayed=w.document.getElementById('result').textContent;assert.match(displayed,/mem_NEW_SECRET/);
 old.resolve(json(response));await tick();await tick();
 assert.equal(w.document.getElementById('result').textContent,displayed);assert.equal(w.document.getElementById(field).value,'Keep newer user input');
});

for(const [formId,path]of [['reauth-complete','/v1/account/reauth/complete'],['email-complete','/v1/account/emails/verify']])test(formId+' preserves a replacement proof typed while its prior request is pending',async t=>{
 const old=deferred();const w=await page(t,url=>url===path?old.promise:undefined),form=w.document.getElementById(formId);
 form.elements.proof.value='Submitted proof';form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 form.elements.proof.value='New proof typed meanwhile';old.resolve(json({verified:true}));await tick();await tick();
 assert.equal(form.elements.proof.value,'New proof typed meanwhile');
});

for(const [startId,completeId,path,response]of [['reauth-start','reauth-complete','/v1/account/reauth',{id:'new-challenge'}],['email-start','email-complete','/v1/account/emails',{challengeId:'new-challenge'}]])for(const edit of ['proof-only','restored-pair','untouched'])test(startId+' handles '+edit+' challenge fields without mixing proofs',async t=>{
 const pending=deferred(),w=await page(t,url=>url==='/v1/release/config'?json({prices:{},features:{mail:true}}):url===path?pending.promise:undefined),form=w.document.getElementById(completeId);
 form.elements.challengeId.value='original-challenge';form.elements.proof.value='original-proof';w.document.getElementById(startId).dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 if(edit==='proof-only'){form.elements.proof.value='new-proof';form.elements.proof.dispatchEvent(new w.Event('input',{bubbles:true}));}
 if(edit==='restored-pair'){for(const value of ['temporary-choice','original-challenge']){form.elements.challengeId.value=value;form.elements.challengeId.dispatchEvent(new w.Event('input',{bubbles:true}));}}
 pending.resolve(json(response));await tick();await tick();
 assert.equal(form.elements.challengeId.value,edit==='untouched'?'new-challenge':'original-challenge');assert.equal(form.elements.proof.value,edit==='untouched'?'':edit==='proof-only'?'new-proof':'original-proof');assert.match(w.document.getElementById('mutation-receipts').textContent,/new-challenge/);
});

for(const [formId,path]of [['reauth-complete','/v1/account/reauth/complete'],['email-complete','/v1/account/emails/verify']])test(formId+' preserves its proof when the challenge choice changes during completion',async t=>{
 const pending=deferred(),w=await page(t,url=>url===path?pending.promise:undefined),form=w.document.getElementById(formId);
 form.elements.challengeId.value='submitted-challenge';form.elements.proof.value='proof-to-keep';form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 form.elements.challengeId.value='new-choice';form.elements.challengeId.dispatchEvent(new w.Event('input',{bubbles:true}));pending.resolve(json({verified:true}));await tick();await tick();
 assert.equal(form.elements.challengeId.value,'new-choice');assert.equal(form.elements.proof.value,'proof-to-keep');
});

test('management obsolete failures cannot replace a newer search result or status',async t=>{
 let active=false;const old=deferred();const w=await page(t,path=>active&&path.includes('/memories?limit=')?old.promise:path.includes('/memories?query=')?json({results:[{id:'latest',body:'New success',revision:1}]}):undefined);
 active=true;w.document.getElementById('refresh-memories').click();await tick();
 const form=w.document.getElementById('search-form');form.elements.query.value='new';form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
 old.resolve(new Response('{"error":"obsolete_failure"}',{status:500}));await tick();await tick();
 assert.equal(w.document.getElementById('status').textContent,'완료');assert.doesNotMatch(w.document.getElementById('result').textContent,/obsolete/);
});

test('domain organization changes preserve the selected Space memory panel',async t=>{
 const w=await page(t,path=>path==='/v1/workspace'?json({account:{id:'alice',emails:[]},organizations:[{id:'org',name:'Org',role:'owner'}]}):path.includes('/memories?')?json({results:[{id:'m',body:'Keep displayed memory',revision:1}]}):undefined);
 const select=w.document.getElementById('organization');select.value='org';select.dispatchEvent(new w.Event('change'));await tick();await tick();
 assert.match(w.document.getElementById('memories').textContent,/Keep displayed memory/);
});

test('known member permissions disable administration export jobs and write PAT capabilities',async t=>{
 const w=await page(t,path=>path==='/v1/workspace'?json({account:{id:'alice',emails:[]},spaces:[{id:'s1',canWrite:false}],organizations:[{id:'org',name:'Org',role:'member'}]}):path.startsWith('/v1/spaces?')?json({results:[{id:'s1',name:'Team',organizationId:'org'}]}):undefined);
 w.document.getElementById('organization').value='org';w.document.getElementById('organization').dispatchEvent(new w.Event('change'));
 for(const id of ['jobs','export','scim-key'])assert.equal(w.document.getElementById(id).disabled,true,id);
 for(const input of w.document.querySelectorAll('#key-form input[name="cap"]'))if(input.value!=='read'){assert.equal(input.disabled,true);assert.equal(input.checked,false);}
});

test('checkout expiry offers an explicit fresh attempt while ordinary retry keeps its operation',async t=>{
 const ids=[];const w=await page(t,(path,init)=>path==='/v1/release/config'?json({prices:{price_test:{plan:'test',monthlyUnits:1}},features:{billing:true}}):path.endsWith('/billing/checkout')?(ids.push(JSON.parse(init.body).operationId),new Response('{"error":"checkout_expired"}',{status:409})):undefined);
 const form=w.document.getElementById('checkout-form'),submit=async()=>{form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();};
 await submit();await submit();assert.equal(ids[0],ids[1]);
 const button=w.document.getElementById('checkout-new-attempt');assert.ok(button);assert.equal(button.hidden,false);button.click();await tick();await tick();
 await submit();assert.notEqual(ids.at(-1),ids[0]);
});

test('composer accepts 16384 ASCII bytes and rejects UTF8 overflow before posting',async t=>{
 const bodies=[];const w=await page(t,(path,init)=>init.method==='POST'&&path.endsWith('/memories')?(bodies.push(JSON.parse(init.body).body),json({id:'saved'})):undefined);
 const form=w.document.getElementById('add-form');assert.equal(form.elements.body.maxLength,16384);
 const send=async body=>{form.elements.body.value=body;form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();};
 await send('a'.repeat(16384));assert.equal(bodies[0].length,16384);
 await send('가'.repeat(6000));assert.equal(bodies.length,1);assert.match(w.document.getElementById('status').textContent,/16,384|16384/);
});

test('received shares load incrementally and a stale next page cannot refill refreshed invitations',async t=>{
 const calls=[],old=deferred();let refresh=false;const w=await page(t,path=>{if(path.startsWith('/v1/shares')){calls.push(path);if(path.includes('cursor='))return old.promise;return json({results:[{id:refresh?'fresh':'first'}],nextCursor:refresh?null:'next+/='});}});
 w.document.getElementById('invitations').click();await tick();await tick();assert.equal(calls.length,1);
 const more=w.document.getElementById('shares-more');assert.ok(more);assert.equal(more.hidden,false);more.click();await tick();assert.match(calls[1],/cursor=next%2B%2F%3D/);
 refresh=true;w.document.getElementById('invitations').click();await tick();await tick();old.resolve(json({results:[{id:'stale'}],nextCursor:null}));await tick();await tick();
 assert.match(w.document.getElementById('shares').textContent,/fresh/);assert.doesNotMatch(w.document.getElementById('shares').textContent,/stale/);
});
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
test('management extraction drafts stay in their Space and clear across accounts and logout',async t=>{
 let account='alice';const posted=[];
 const w=await page(t,(path,init)=>{
  if(path==='/v1/workspace')return json({account:{id:account,emails:[]},organizations:[]});
  if(path==='/v1/release/config')return json({prices:{},features:{ingestion:true}});
  if(path.endsWith('/ingests')&&init.method==='POST'){posted.push({path,messages:JSON.parse(init.body).messages});return json({id:'queued'});}
  if(path==='/auth/logout')return new Response(null,{status:204});
 });
 const form=w.document.getElementById('ingest-form'),select=w.document.getElementById('space');
 const personal=[{id:'m1',role:'user',content:'PRIVATE PERSONAL CONVERSATION'}];
 const team=[{id:'m2',role:'user',content:'TEAM CONVERSATION'}];
 const switchTo=async id=>{select.value=id;select.dispatchEvent(new w.Event('change'));await tick();await tick();};
 const submit=async()=>{form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();};
 form.elements.messages.value=JSON.stringify(personal);
 await switchTo('s2');assert.equal(form.elements.messages.value,'');
 await submit();assert.equal(posted.length,0,'A blank destination form cannot send the previous Space conversation');
 form.elements.messages.value=JSON.stringify(team);await submit();
 await switchTo('s1');assert.equal(form.elements.messages.value,JSON.stringify(personal));await submit();
 assert.deepEqual(posted,[{path:'/v1/spaces/s2/ingests',messages:team},{path:'/v1/spaces/s1/ingests',messages:personal}]);
 account='bob';w.document.getElementById('reload').click();await tick();await tick();await tick();
 assert.equal(form.elements.messages.value,'');await switchTo('s2');assert.equal(form.elements.messages.value,'');
 form.elements.messages.value='PRIVATE BOB DRAFT';w.document.getElementById('logout').click();await tick();
 assert.equal(form.elements.messages.value,'');
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

test('management clears prior account drafts and proof fields after the browser account changes',async t=>{
 let account='alice';
 const w=await page(t,path=>path==='/v1/workspace'?json({account:{id:account,emails:[{id:'email-'+account,address:account+'@example.org'}]},organizations:[]}):undefined);
 const form=w.document.getElementById('add-form');
 form.elements.body.value='PRIVATE ALICE UNSAVED DRAFT';
 w.document.getElementById('reauth-complete').elements.proof.value='PRIVATE ALICE PROOF';
 w.document.getElementById('reauth-id').value='alice-challenge';
 w.document.getElementById('key-form').elements.label.value='Alice private key label';
 account='bob';w.document.getElementById('reload').click();await tick();await tick();await tick();
 assert.equal(form.elements.body.value,'');
 assert.equal(w.document.getElementById('reauth-complete').elements.proof.value,'');
 assert.equal(w.document.getElementById('reauth-id').value,'');
 assert.equal(w.document.getElementById('key-form').elements.label.value,'');
 assert.equal(w.document.getElementById('email-select').value,'email-bob');
 assert.equal(w.document.getElementById('status').textContent,'완료');
});

test('management retains typing made while its workspace refresh is pending',async t=>{
 let refresh=false;const late=deferred();
 const w=await page(t,path=>refresh&&path==='/v1/workspace'?late.promise:undefined);
 const form=w.document.getElementById('add-form');form.elements.body.value='original draft';
 refresh=true;w.document.getElementById('reload').click();await tick();
 form.elements.body.value='new text typed during refresh';
 late.resolve(json({account:{id:'alice',emails:[]},organizations:[]}));await tick();await tick();
 assert.equal(form.elements.body.value,'new text typed during refresh');
});

test('management ignores an older ingest refresh after a newer refresh finishes',async t=>{
 let reads=0;const old=deferred();
 const w=await page(t,path=>path==='/v1/spaces/s1/ingests'?(++reads===1?old.promise:json({results:[{id:'current-ingest',state:'queued'}]})):undefined);
 w.document.getElementById('ingests').click();await tick();
 w.document.getElementById('ingests').click();await tick();await tick();
 old.resolve(json({results:[{id:'stale-ingest',state:'queued'}]}));await tick();await tick();
 assert.match(w.document.getElementById('proposals').textContent,/current-ingest/);
 assert.doesNotMatch(w.document.getElementById('proposals').textContent,/stale-ingest/);
});

test('management ignores an older invitation refresh after a newer refresh finishes',async t=>{
 let reads=0;const old=deferred();
 const w=await page(t,path=>path.startsWith('/v1/shares?')?(++reads===1?old.promise:json({results:[{id:'current-invite'}]})):undefined);
 w.document.getElementById('invitations').click();await tick();
 w.document.getElementById('invitations').click();await tick();await tick();
 old.resolve(json({results:[{id:'stale-invite'}]}));await tick();await tick();
 assert.match(w.document.getElementById('shares').textContent,/current-invite/);
 assert.doesNotMatch(w.document.getElementById('shares').textContent,/stale-invite/);
});

test('management offers source cancellation for a failed extraction job',async t=>{
 const w=await page(t,(path,init)=>{
  if(path==='/v1/spaces/s1/ingests')return json({results:[{id:'failed-ingest',state:'failed'}]});
  if(path==='/v1/spaces/s1/ingests/failed-ingest'&&init.method==='DELETE')return new Response(null,{status:204});
 });
 w.document.getElementById('ingests').click();await tick();await tick();
 const proposals=w.document.getElementById('proposals');
 const cancel=[...proposals.querySelectorAll('button')].find(button=>button.textContent.includes('원문 제거'));
 assert.ok(cancel,'A failed extraction still holds encrypted source until cancellation or expiry');
 cancel.click();await tick();await tick();
 assert.match(proposals.textContent,/취소 완료/);
});
