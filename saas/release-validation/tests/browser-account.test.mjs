import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fixture, at } from './db.mjs';
import { createApplication } from '../../src/app.ts';
import { createRelease } from '../../src/release/extension.ts';
import { readSettings } from '../../src/config.ts';
import { appScript } from '../../src/ui.ts';
import { managementScript } from '../../src/release/console.ts';
import * as managementUi from '../../src/release/console.ts';
import { MemoryStore } from '../../src/release/memory.ts';
import { Transfers } from '../../src/release/transfer.ts';
import { Admin } from '../../src/release/admin.ts';
import { Ingest } from '../../src/release/ingest.ts';
import { Jobs } from '../../src/release/jobs.ts';
import { IdentityService } from '../../src/identity.ts';

async function browser(t, path, setup, variables = {}) {
  const f = await fixture();
  f.db.raw.exec("UPDATE memberships SET role='admin' WHERE id='m2'");
  const settings = readSettings(variables), env = { DB: f.db, PUBLIC_ORIGIN: settings.origin, ...variables };
  const app = createApplication(f.db, settings, { clock: () => at, release: createRelease(env, { clock: () => at, identity: new IdentityService(f.db, () => at) }) });
  const html = await (await app(new Request(settings.origin + path))).text();
  const dom = new JSDOM(html, { url: settings.origin + path, runScripts: 'outside-only' });
  const w = dom.window, active = new Set(), calls = [];
  let token = f.token, responseInterceptor, requestInterceptor;
  if (setup) token = await setup(f);
  w.TextEncoder = TextEncoder; w.confirm = () => true;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', '__Host-memory_session=' + token);
    if (!['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('origin', settings.origin);
    const request = new Request(settings.origin + url, { ...init, headers });
    const operation = (requestInterceptor ? Promise.resolve().then(() => requestInterceptor(url, init)).then(() => app(request)) : app(request)).then(response => {
      calls.push({ path: url, method: init.method ?? 'GET', status: response.status, data: init.body ? JSON.parse(init.body) : null });
      return responseInterceptor ? responseInterceptor(url, init, response) : response;
    });
    active.add(operation); operation.then(() => active.delete(operation), () => active.delete(operation)); return operation;
  };
  async function settle() {
    for (let i = 0; i < 12; i++) { await Promise.allSettled([...active]); await new Promise(resolve => setImmediate(resolve)); }
  }
  t.after(async () => { await settle(); dom.window.close(); f.db.close(); });
  w.eval(path === '/' ? appScript : managementScript); await settle();
  const byId = id => w.document.getElementById(id);
  const submit = id => byId(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  return { ...f, app, settings, w, byId, submit, settle, calls, switchAccount: () => { token = f.other; }, intercept: fn => { responseInterceptor = fn; }, beforeRequest: fn => { requestInterceptor = fn; } };
}

for(const dismissal of ['dialog-close','dialog-cancel','escape'])test('a pending invitation survives '+dismissal+' until its one-time receipt is shown',async t=>{
 const f=await browser(t,'/');[...f.byId('space-list').querySelectorAll('button')].find(button=>button.textContent.includes('Team')).click();await f.settle();
 let release,reached,token;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});
 f.intercept(async(path,init,response)=>{if(path==='/v1/organizations/org/invites'&&init.method==='POST'){assert.equal(response.status,201);token=(await response.clone().json()).token;reached();await held;}return response;});
 f.byId('invite-members').click();f.byId('field-email').value='invitee@example.test';f.submit('dialog-form');await waiting;
 try{if(dismissal==='escape'){const event=new f.w.Event('cancel',{cancelable:true});assert.equal(f.byId('memory-dialog').dispatchEvent(event),false);}else{assert.equal(f.byId(dismissal).disabled,true);f.byId(dismissal).click();}assert.equal(f.byId('memory-dialog').open,true);}finally{release();await f.settle();}
 assert.equal(f.byId('issued-secret')?.value,token);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM workspace_invitations').get().n,1);
 assert.equal(f.byId('dialog-close').disabled,false);assert.equal(f.byId('dialog-cancel').disabled,false);f.byId('dialog-close').click();assert.equal(f.byId('memory-dialog').open,false);
});

for(const [address,expected]of [['support@allenlabs.org','mailto:support@allenlabs.org'],['Support?Desk@example.org','mailto:Support%3FDesk@example.org'],['Support#Desk@example.org','mailto:Support%23Desk@example.org'],['Support%2FDesk@example.org','mailto:Support%252FDesk@example.org'],['Support&Desk=Team@example.org','mailto:Support%26Desk%3DTeam@example.org']])for(const surface of ['root','management'])test(surface+' mailto preserves the separator and exact configured mailbox '+address,async()=>{
 const brand={name:'Memory',shortName:'Memory',description:'Memory',supportEmail:address,accentColor:'#276747'},html=surface==='management'?managementUi.renderManagement(brand):(await import('../../src/ui.ts')).renderPage(brand),dom=new JSDOM(html);try{const link=dom.window.document.querySelector('a[href^="mailto:"]'),url=new URL(link.href);assert.equal(link.getAttribute('href'),expected);assert.equal(url.search,'');assert.equal(url.hash,'');assert.equal(decodeURIComponent(url.pathname),address);}finally{dom.window.close();}
});

test('management retains the original outbound share receipt after an unrelated usage request',async t=>{
 let memory;const f=await browser(t,'/manage',async f=>{memory=await new MemoryStore(f.db,()=>at).create(f.token,'s1',{body:'Shared memory'},'share-receipt-seed');return f.token;});
 let release,reached,shareId;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});
 f.intercept(async(path,init,response)=>{if(path==='/v1/spaces/s1/shares'&&init.method==='POST'){shareId=(await response.clone().json()).id;reached();await held;}return response;});
 f.byId('share-form').elements.email.value='bob@example.com';f.submit('share-form');await waiting;
 try{f.byId('usage').click();for(let i=0;i<100&&!f.byId('result').textContent.includes('usedUnits');i++)await new Promise(resolve=>setTimeout(resolve,5));}finally{release();}await f.settle();
 assert.ok(f.byId('mutation-receipts').textContent.includes(shareId));assert.match(f.byId('result').textContent,/usedUnits/);assert.equal(f.db.raw.prepare('SELECT count(*) AS n FROM release_shares').get().n,1);
 const transfers=new Transfers(f.db,()=>at);await transfers.accept(f.other,shareId);assert.equal((await new MemoryStore(f.db,()=>at).get(f.other,'s1',memory.id)).body,'Shared memory');
 f.byId('share-revoke').elements.shareId.value=shareId;f.submit('share-revoke');await f.settle();await assert.rejects(()=>new MemoryStore(f.db,()=>at).get(f.other,'s1',memory.id),error=>error.status===403);
});

test('management retains a consumed domain verification receipt needed for delegation',async t=>{
 let db;const f=await browser(t,'/manage',f=>{db=f.db;return f.token;},{fetch:async()=>{const row=db.raw.prepare('SELECT domain,proof FROM release_domain_challenges WHERE used_at IS NULL').get();return new Response(JSON.stringify({Status:0,Answer:[{name:'_memory-verification.'+row.domain,type:16,data:JSON.stringify(row.proof)}]}),{headers:{'content-type':'application/dns-json'}});}});
 f.byId('organization').value='org';f.byId('organization').dispatchEvent(new f.w.Event('change'));f.byId('domain-start').elements.domain.value='example.test';f.submit('domain-start');await f.settle();
 const challenge=JSON.parse(f.byId('result').textContent);f.byId('domain-verify').elements.challengeId.value=challenge.id;
 let release,reached,domainId;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});
 f.intercept(async(path,init,response)=>{if(path==='/v1/domains/verify'){domainId=(await response.clone().json()).id;reached();await held;}return response;});f.submit('domain-verify');await waiting;
 try{f.byId('usage').click();for(let i=0;i<100&&!f.byId('result').textContent.includes('usedUnits');i++)await new Promise(resolve=>setTimeout(resolve,5));}finally{release();}await f.settle();
 assert.ok(domainId,JSON.stringify(f.calls));assert.ok(f.byId('mutation-receipts').textContent.includes(domainId),f.byId('mutation-receipts').textContent);assert.match(f.byId('result').textContent,/usedUnits/);
 f.byId('domain-delegate').elements.domainId.value=domainId;f.byId('domain-delegate').elements.membershipId.value='m2';f.submit('domain-delegate');await f.settle();assert.ok(f.db.raw.prepare("SELECT 1 FROM domain_managers WHERE domain_id=? AND membership_id='m2'").get(domainId));
});

for(const method of ['GET','PATCH','DELETE'])test('root a stale '+method+' authentication error cannot clear a newly issued invitation',async t=>{
 const f=await browser(t,'/',async f=>{await new MemoryStore(f.db,()=>at).create(f.token,'so',{body:'Team memory'},'old-auth-seed');return f.token;});[...f.byId('space-list').querySelectorAll('button')].find(button=>button.textContent.includes('Team')).click();await f.settle();
 if(method==='PATCH'){f.byId('memory-body').value='Existing changed draft';f.byId('memory-body').dispatchEvent(new f.w.Event('input'));}
 let release,reached;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});f.intercept(async(path,init,response)=>{if(path.includes('/memories')&&init.method===method&&response.status===401){reached();await held;}return response;});
 f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);if(method==='GET'){f.byId('search-query').value='probe';f.submit('search-form');}else if(method==='PATCH')f.submit('editor-form');else f.byId('delete-memory').click();await waiting;
 let secret;
 try{f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+900000);f.byId('invite-members').click();f.byId('field-email').value='invitee@example.test';f.submit('dialog-form');for(let i=0;i<100&&!f.byId('issued-secret');i++)await new Promise(resolve=>setTimeout(resolve,5));secret=f.byId('issued-secret')?.value;assert.ok(secret);}finally{release();}
 await f.settle();assert.equal(f.byId('workspace').hidden,false);assert.equal(f.byId('issued-secret')?.value,secret);assert.equal(f.byId('reauth-actions').hidden,true);
});

for(const outcome of ['500','network','pending'])test('root a newer '+outcome+' request does not suppress a genuine session expiry',async t=>{
 const f=await browser(t,'/');f.byId('new-memory').click();f.byId('memory-body').value='Draft needing reconnection';f.byId('memory-body').dispatchEvent(new f.w.Event('input'));
 let releaseOld,oldReached,releaseNew,newReached;const heldOld=new Promise(resolve=>{releaseOld=resolve;}),waitingOld=new Promise(resolve=>{oldReached=resolve;}),heldNew=new Promise(resolve=>{releaseNew=resolve;}),waitingNew=new Promise(resolve=>{newReached=resolve;});
 f.intercept(async(path,init,response)=>{if(path.includes('/memories?query=')){oldReached();await heldOld;}if(path.endsWith('/members')){newReached();if(outcome==='pending')await heldNew;if(outcome==='500')return new Response('{}',{status:500});if(outcome==='network')throw Error('Connection lost');}return response;});
 f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);f.byId('search-query').value='expired';f.submit('search-form');await waitingOld;f.byId('manage-members').click();await waitingNew;
 try{releaseOld();for(let i=0;i<100&&f.byId('reauth-actions').hidden;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.byId('reauth-actions').hidden,false);assert.equal(f.byId('memory-body').value,'Draft needing reconnection');assert.equal(f.byId('save-memory').disabled,true);}finally{releaseOld();releaseNew();}await f.settle();
});

for(const outcome of ['500','network','pending'])test('management a newer '+outcome+' request does not suppress a genuine session expiry',async t=>{
 const f=await browser(t,'/manage');f.byId('add-form').elements.body.value='Draft needing reconnection';
 let releaseOld,oldReached,releaseNew,newReached;const heldOld=new Promise(resolve=>{releaseOld=resolve;}),waitingOld=new Promise(resolve=>{oldReached=resolve;}),heldNew=new Promise(resolve=>{releaseNew=resolve;}),waitingNew=new Promise(resolve=>{newReached=resolve;});
 f.intercept(async(path,init,response)=>{if(path.endsWith('/usage')){oldReached();await heldOld;}if(path.includes('/memories?query=')){newReached();if(outcome==='pending')await heldNew;if(outcome==='500')return new Response('{}',{status:500});if(outcome==='network')throw Error('Connection lost');}return response;});
 f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);f.byId('usage').click();await waitingOld;f.byId('search-form').elements.query.value='new';f.submit('search-form');await waitingNew;
 try{releaseOld();for(let i=0;i<100&&f.byId('reauth-actions').hidden;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.byId('reauth-actions').hidden,false);assert.equal(f.byId('add-form').elements.body.value,'Draft needing reconnection');assert.equal(f.byId('add-form').querySelector('button').disabled,true);}finally{releaseOld();releaseNew();}await f.settle();
});

for(const succeeds of [true,false])test('root pauses edits during logout and '+(succeeds?'clears only after success':'retains its existing draft after failure'),async t=>{
  const f=await browser(t,'/');f.byId('new-memory').click();f.byId('memory-body').value='Existing unsaved draft';f.byId('memory-body').dispatchEvent(new f.w.Event('input'));
  let release,reached;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});
  f.intercept(async(path,init,response)=>{if(path==='/auth/logout'){reached();await held;if(!succeeds)return new Response('{}',{status:500});assert.ok(response.status>=300&&response.status<400);return f.app(new Request(new URL(response.headers.get('location'),f.settings.origin)));}return response;});
  f.byId('logout').click();await waiting;
  try{assert.equal(f.byId('memory-body').readOnly,true);assert.equal(f.byId('memory-source').readOnly,true);assert.equal(f.byId('new-memory').disabled,true);assert.equal(f.byId('save-memory').disabled,true);assert.equal(f.byId('manage-keys').disabled,true);}finally{release();}
  await f.settle();assert.equal(f.byId('memory-body').value,succeeds?'':'Existing unsaved draft');
  if(!succeeds){assert.equal(f.byId('memory-body').readOnly,false);assert.equal(f.byId('save-memory').disabled,false);assert.equal(f.byId('workspace').hidden,false);}
});

test('root ignores an older selection while logout is pending and preserves its draft if logout fails',async t=>{
 let b;const f=await browser(t,'/',async f=>{const store=new MemoryStore(f.db,()=>at);await store.create(f.token,'s1',{body:'Memory A'},'logout-a');b=await store.create(f.token,'s1',{body:'Memory B'},'logout-b');return f.token;});
 [...f.byId('memory-list').querySelectorAll('button')].find(button=>button.textContent.includes('Memory A')).click();await f.settle();f.byId('memory-body').value='Original unsaved draft';f.byId('memory-body').dispatchEvent(new f.w.Event('input'));
 let releaseRead,readReached,releaseLogout,logoutReached;const heldRead=new Promise(resolve=>{releaseRead=resolve;}),waitingRead=new Promise(resolve=>{readReached=resolve;}),heldLogout=new Promise(resolve=>{releaseLogout=resolve;}),waitingLogout=new Promise(resolve=>{logoutReached=resolve;});
 f.intercept(async(path,init,response)=>{if(path.endsWith('/'+b.id)){readReached();await heldRead;}if(path==='/auth/logout'){logoutReached();await heldLogout;return new Response('{}',{status:500});}return response;});
 [...f.byId('memory-list').querySelectorAll('button')].find(button=>button.textContent.includes('Memory B')).click();await waitingRead;f.byId('logout').click();await waitingLogout;
 try{releaseRead();for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(f.byId('memory-body').value,'Original unsaved draft');}finally{releaseRead();releaseLogout();}
 await f.settle();assert.equal(f.byId('memory-body').value,'Original unsaved draft');assert.equal(f.byId('memory-body').readOnly,false);
});

for(const spaceId of ['s1','so'])test('root recomputes organization controls when reconnecting a draft in '+spaceId,async t=>{
  const f=await browser(t,'/');if(spaceId==='so'){[...f.byId('space-list').querySelectorAll('button')].find(button=>button.textContent.includes('Team')).click();await f.settle();}
  assert.equal(f.byId('manage-members').hidden,false);f.byId('new-memory').click();f.byId('memory-body').value='Draft retained through role change';f.byId('memory-body').dispatchEvent(new f.w.Event('input'));
  f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);f.submit('editor-form');await f.settle();
  f.db.raw.exec("UPDATE memberships SET role='member' WHERE id='m1'");f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+900000);
  f.byId('resume-session').click();await f.settle();assert.equal(f.calls.findLast(call=>call.path==='/v1/workspace').status,200);
  assert.equal(f.byId('manage-members').hidden,true);assert.equal(f.byId('invite-members').hidden,true);assert.equal(f.byId('memory-body').value,'Draft retained through role change');assert.equal(f.byId('save-memory').disabled,spaceId==='so');
});

test('root reveals newly granted organization controls after reconnecting a personal draft',async t=>{
 const f=await browser(t,'/',f=>{f.db.raw.exec("UPDATE memberships SET role='member' WHERE id='m1'");return f.token;});assert.equal(f.byId('manage-members').hidden,true);
 f.byId('new-memory').click();f.byId('memory-body').value='Personal draft';f.byId('memory-body').dispatchEvent(new f.w.Event('input'));f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);f.submit('editor-form');await f.settle();
 f.db.raw.exec("UPDATE memberships SET role='admin' WHERE id='m1'");f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at+900000);f.byId('resume-session').click();await f.settle();
 assert.equal(f.byId('manage-members').hidden,false);assert.equal(f.byId('manage-members').disabled,false);assert.equal(f.byId('memory-body').value,'Personal draft');f.byId('manage-members').click();await f.settle();assert.match(f.byId('dialog-title').textContent,/조직 멤버 관리/);
});

for(const path of ['/','/manage'])test(path+' advertises its configured staging MCP endpoint',async t=>{
  const f=await browser(t,path,null,{PUBLIC_ORIGIN:'https://memory-staging.example.test'});
  if(path==='/'){f.w.document.body.dataset.management='false';f.byId('manage-keys').click();assert.match(f.byId('dialog-form').textContent,/https:\/\/memory-staging\.example\.test\/mcp/);}
  else assert.match(f.byId('mcp-connection').textContent,/https:\/\/memory-staging\.example\.test\/mcp/);
});

for(const [startId,completeId,path,idField]of [['reauth-start','reauth-complete','/v1/account/reauth','id'],['email-start','email-complete','/v1/account/emails','challengeId']])test(startId+' preserves a valid challenge pair edited during a later issuance',async t=>{
  const mail=[];const f=await browser(t,'/manage',null,{EMAIL:{send:async message=>{mail.push(message);return{messageId:'test-mail-'+mail.length};}},MAIL_FROM:'memory@example.test'});
  if(startId==='email-start')f.byId(startId).elements.email.value='new@example.test';
  f.submit(startId);await f.settle();const form=f.byId(completeId),original=form.elements.challengeId.value,proof=mail[0]?.text.match(/Proof: ([^\n]+)/)?.[1];assert.ok(original);assert.ok(proof);
  let release,reached,secondId;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});
  f.intercept(async(url,init,response)=>{if(url===path&&init.method==='POST'){secondId=(await response.clone().json())[idField];reached();await held;}return response;});
  f.submit(startId);await waiting;
  try{for(const [name,value]of [['challengeId',original],['proof',proof]]){form.elements[name].value=value;form.elements[name].dispatchEvent(new f.w.Event('input',{bubbles:true}));}}finally{release();}
  await f.settle();assert.equal(form.elements.challengeId.value,original);assert.equal(form.elements.proof.value,proof);assert.ok(f.byId('mutation-receipts').textContent.includes(secondId));
  f.submit(completeId);await f.settle();assert.equal(f.calls.findLast(call=>call.path===path+(startId==='reauth-start'?'/complete':'/verify')).status,200);
});

for (const mutation of ['create','edit','delete','restore','erase']) test('management reconciles '+mutation+' after a refresh of the same memory view', async t => {
  let memory;
  const trash = ['restore','erase'].includes(mutation);
  const f = await browser(t, '/manage', async f => { if (mutation !== 'create') { const store = new MemoryStore(f.db, () => at); memory = await store.create(f.token, 's1', {body:'Original memory'}, 'same-view-seed'); if(trash) await store.remove(f.token, 's1', memory.id, 1, 'same-view-trash'); } return f.token; });
  if(trash) { f.byId('trash').click(); await f.settle(); }
  let release, reached; const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.beforeRequest(async (path, init) => { if(path.includes('/memories') && init.method !== 'GET') { reached(); await held; } });
  f.w.prompt = () => mutation === 'erase' ? memory.id : 'Changed memory';
  if(mutation === 'create') { f.byId('add-form').elements.body.value = 'Committed new memory'; f.submit('add-form'); }
  else [...f.byId('memories').querySelectorAll('button')].find(button => button.textContent === ({edit:'수정',delete:'휴지통',restore:'복원',erase:'영구 제거'})[mutation]).click();
  await waiting;
  try { const before = f.calls.length; f.byId(trash ? 'trash' : 'refresh-memories').click(); for(let i=0;i<100&&f.calls.length===before;i++)await new Promise(resolve=>setTimeout(resolve,5)); assert.ok(f.calls.length>before); for(let i=0;i<100&&f.byId('status').textContent==='처리 중';i++)await new Promise(resolve=>setTimeout(resolve,5)); }
  finally { release(); }
  await f.settle();
  if(['create','edit'].includes(mutation)) assert.match(f.byId('memories').textContent, mutation==='create'?/Committed new memory/:/Changed memory/);
  else assert.equal(f.byId('memories').children.length, 0);
  assert.doesNotMatch(f.byId('status').textContent, /처리 중/);
});

test('management clearing results preserves invitation pagination', async t => {
  const f = await browser(t, '/manage', async f => { const transfer=new Transfers(f.db,()=>at); for(let i=0;i<26;i++){f.db.raw.prepare('INSERT INTO spaces VALUES(?,?,?,?,?,?,?)').run('clear-share-'+i,'Incoming '+i,'bob',null,'managed',at,'session:bob');await transfer.share(f.other,'clear-share-'+i,'alice@example.com');} return f.token; });
  f.byId('invitations').click(); await f.settle(); assert.equal(f.byId('shares').children.length,25);
  f.byId('clear-result').click(); await f.settle(); assert.equal(f.byId('shares-more').hidden,false);
  f.byId('shares-more').click(); await f.settle(); assert.equal(f.byId('shares').children.length,26); assert.equal(f.byId('shares-more').hidden,true);
});

test('management a committed create supersedes an older same-view refresh still in flight', async t => {
  const f = await browser(t, '/manage'); let releaseWrite, writeReached, releaseRead, readReached, holdFirstRead=true;
  const heldWrite=new Promise(resolve=>{releaseWrite=resolve;}), waitingWrite=new Promise(resolve=>{writeReached=resolve;}), heldRead=new Promise(resolve=>{releaseRead=resolve;}), waitingRead=new Promise(resolve=>{readReached=resolve;});
  f.beforeRequest(async(path,init)=>{if(path.endsWith('/memories')&&init.method==='POST'){writeReached();await heldWrite;}});
  f.intercept(async(path,init,response)=>{if(path.includes('/memories?')&&init.method==='GET'&&holdFirstRead){holdFirstRead=false;readReached();await heldRead;}return response;});
  f.byId('add-form').elements.body.value='Created after the earlier snapshot';f.submit('add-form');await waitingWrite;f.byId('refresh-memories').click();await waitingRead;
  try { releaseWrite();for(let i=0;i<100&&f.byId('add-form').elements.body.value;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.byId('add-form').elements.body.value,''); }
  finally {releaseWrite();releaseRead();}
  await f.settle();assert.match(f.byId('memories').textContent,/Created after the earlier snapshot/);assert.doesNotMatch(f.byId('status').textContent,/처리 중/);
});

test('management clearing results leaves a pending save and its list reconciliation active', async t => {
  const f=await browser(t,'/manage');let release,reached;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});
  f.beforeRequest(async(path,init)=>{if(path.endsWith('/memories')&&init.method==='POST'){reached();await held;}});
  f.byId('add-form').elements.body.value='Save across result clearing';f.submit('add-form');await waiting;
  try{f.byId('clear-result').click();}finally{release();}await f.settle();
  assert.equal(f.byId('result').textContent,'');assert.equal(f.byId('add-form').elements.body.value,'');assert.match(f.byId('memories').textContent,/Save across result clearing/);assert.match(f.byId('status').textContent,/지웠/);
});

test('management a repeated search still reconciles a pending edit in that view', async t => {
  const f=await browser(t,'/manage',async f=>{await new MemoryStore(f.db,()=>at).create(f.token,'s1',{body:'needle original'},'same-search-seed');return f.token;});
  f.byId('search-form').elements.query.value='needle';f.submit('search-form');await f.settle();
  let release,reached;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});
  f.beforeRequest(async(path,init)=>{if(init.method==='PATCH'){reached();await held;}});f.w.prompt=()=>'needle changed';
  [...f.byId('memories').querySelectorAll('button')].find(button=>button.textContent==='수정').click();await waiting;
  try{const count=f.calls.length;f.submit('search-form');for(let i=0;i<100&&f.calls.length===count;i++)await new Promise(resolve=>setTimeout(resolve,5));for(let i=0;i<100&&f.byId('status').textContent==='처리 중';i++)await new Promise(resolve=>setTimeout(resolve,5));}finally{release();}
  await f.settle();assert.match(f.byId('memories').textContent,/needle changed/);assert.doesNotMatch(f.byId('memories').textContent,/needle original/);assert.equal(f.byId('search-form').elements.query.value,'needle');
});

test('management a pending create preserves a newly selected trash view', async t => {
  const f=await browser(t,'/manage');let release,reached;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});
  f.beforeRequest(async(path,init)=>{if(path.endsWith('/memories')&&init.method==='POST'){reached();await held;}});
  f.byId('add-form').elements.body.value='Active memory';f.submit('add-form');await waiting;
  let before;
  try{const count=f.calls.length;f.byId('trash').click();for(let i=0;i<100&&f.calls.length===count;i++)await new Promise(resolve=>setTimeout(resolve,5));for(let i=0;i<100&&f.byId('status').textContent==='처리 중';i++)await new Promise(resolve=>setTimeout(resolve,5));before=f.calls.filter(call=>call.path.includes('/memories?')).length;}finally{release();}
  await f.settle();assert.equal(f.byId('memories').children.length,0);assert.equal(f.calls.filter(call=>call.path.includes('/memories?')).length,before);assert.equal(f.db.raw.prepare("SELECT count(*) AS n FROM memories WHERE body='Active memory'").get().n,1);
});

test('management clearing results preserves an invitation page already in flight', async t => {
  const f=await browser(t,'/manage',async f=>{const transfer=new Transfers(f.db,()=>at);for(let i=0;i<26;i++){f.db.raw.prepare('INSERT INTO spaces VALUES(?,?,?,?,?,?,?)').run('pending-share-'+i,'Incoming '+i,'bob',null,'managed',at,'session:bob');await transfer.share(f.other,'pending-share-'+i,'alice@example.com');}return f.token;});
  let release,reached;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{reached=resolve;});
  f.intercept(async(path,init,response)=>{if(path.startsWith('/v1/shares?')){reached();await held;}return response;});
  f.byId('invitations').click();await waiting;try{f.byId('clear-result').click();}finally{release();}await f.settle();
  assert.equal(f.byId('shares').children.length,25);assert.equal(f.byId('shares-more').hidden,false);assert.equal(f.byId('result').textContent,'');assert.match(f.byId('status').textContent,/지웠/);
});

test('root overlong search terms explain the actual 31-character limit', async t => {
  const f = await browser(t, '/'); f.byId('search-query').value='a'.repeat(32); f.submit('search-form'); await f.settle();
  assert.equal(f.calls.findLast(call=>call.path.includes('?query=')).status,400);
  assert.match(f.byId('app-error').textContent,/31자/); assert.doesNotMatch(f.byId('app-error').textContent,/본문|출처|이름/);
});

test('root binds search reads to the displayed account after another tab switches cookies', async t => {
  const f = await browser(t, '/'); [...f.byId('space-list').querySelectorAll('button')].find(button => button.textContent.includes('Team')).click(); await f.settle();
  f.switchAccount(); f.byId('search-query').value = 'query'; f.submit('search-form'); await f.settle();
  assert.equal(f.calls.findLast(call => call.path.includes('?query=')).status, 409);
  assert.equal(f.byId('workspace').hidden, true); assert.match(f.byId('welcome-error').textContent, /다른 계정/);
});

test('root a bound recovery read clears the previous account draft on mismatch', async t => {
  const f = await browser(t, '/'); f.byId('new-memory').click();
  f.byId('memory-body').value = 'EXPIRED ALICE DRAFT'; f.byId('memory-body').dispatchEvent(new f.w.Event('input'));
  f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);
  f.submit('editor-form'); await f.settle(); assert.equal(f.byId('reauth-actions').hidden, false);
  f.switchAccount(); f.byId('resume-session').click(); await f.settle();
  assert.equal(f.calls.findLast(call => call.path === '/v1/workspace').status, 409);
  assert.equal(f.byId('memory-body').value, ''); assert.equal(f.byId('workspace').hidden, true); assert.match(f.byId('welcome-error').textContent, /다른 계정/);
});

for (const method of ['PATCH','DELETE']) test('root '+method+' completion cannot replace a memory selected while its response was pending', async t => {
  let a, b;
  const f = await browser(t, '/', async f => { const store = new MemoryStore(f.db, () => at); a = await store.create(f.token, 's1', { body:'Memory A' }, 'selection-a'); b = await store.create(f.token, 's1', { body:'Memory B' }, 'selection-b'); return f.token; });
  [...f.byId('memory-list').querySelectorAll('button')].find(button => button.textContent.includes('Memory A')).click(); await f.settle();
  f.byId('memory-body').value = 'Edited A'; f.byId('memory-body').dispatchEvent(new f.w.Event('input'));
  let releaseB, releaseWrite, reachedB, reachedWrite;
  const holdB = new Promise(resolve => { releaseB = resolve; }), holdWrite = new Promise(resolve => { releaseWrite = resolve; }), waitingB = new Promise(resolve => { reachedB = resolve; }), waitingWrite = new Promise(resolve => { reachedWrite = resolve; });
  f.intercept(async (path, init, response) => { if (init.method === 'GET' && path.endsWith('/'+b.id)) { reachedB(); await holdB; } if (init.method === method && path.endsWith('/'+a.id)) { reachedWrite(); await holdWrite; } return response; });
  [...f.byId('memory-list').querySelectorAll('button')].find(button => button.textContent.includes('Memory B')).click(); await waitingB;
  if (method === 'PATCH') f.submit('editor-form'); else f.byId('delete-memory').click(); await waitingWrite;
  let before;
  try { releaseB(); for (let i = 0; i < 100 && f.byId('memory-body').value !== 'Memory B'; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(f.byId('memory-body').value, 'Memory B'); before = f.calls.length; }
  finally { releaseB(); releaseWrite(); }
  await f.settle(); assert.equal(f.byId('memory-body').value, 'Memory B'); assert.equal(f.calls.length, before, 'An old completion must not refresh the newly selected editor');
});

test('root late key revocation errors cannot appear in a replacement dialog', async t => {
  const f = await browser(t, '/'); let release, reached;
  const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => { if (path.startsWith('/v1/keys/') && init.method === 'DELETE') { reached(); await held; return new Response('{"error":"temporary_failure"}', { status:500 }); } return response; });
  f.byId('manage-keys').click(); f.byId('dialog-form').querySelector('.key-list button').click(); await waiting;
  try { f.byId('dialog-close').click(); f.byId('accept-invite').click(); assert.equal(f.byId('dialog-error').hidden, true); } finally { release(); }
  await f.settle(); assert.equal(f.byId('dialog-error').hidden, true); assert.match(f.byId('dialog-title').textContent, /초대 코드로 참여/);
});

for (const failed of [false, true]) test('root an older memory selection '+(failed ? 'failure' : 'success')+' cannot replace a completed save', async t => {
  let b;
  const f = await browser(t, '/', async f => { const store = new MemoryStore(f.db, () => at); await store.create(f.token, 's1', { body:'Memory A' }, 'saved-selection-a'); b = await store.create(f.token, 's1', { body:'Memory B' }, 'saved-selection-b'); return f.token; });
  [...f.byId('memory-list').querySelectorAll('button')].find(button => button.textContent.includes('Memory A')).click(); await f.settle();
  f.byId('memory-body').value = 'Successfully saved A'; f.byId('memory-body').dispatchEvent(new f.w.Event('input'));
  let release, reached; const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => { if (init.method === 'GET' && path.endsWith('/'+b.id)) { reached(); await held; if (failed) return new Response('{"error":"temporary_failure"}', { status:500 }); } return response; });
  [...f.byId('memory-list').querySelectorAll('button')].find(button => button.textContent.includes('Memory B')).click(); await waiting;
  let savedStatus;
  try { f.submit('editor-form'); for (let i = 0; i < 100 && !f.byId('app-status').textContent.includes('저장했어요'); i++) await new Promise(resolve => setTimeout(resolve, 5)); savedStatus = f.byId('app-status').textContent; assert.match(savedStatus, /저장했어요/); }
  finally { release(); }
  await f.settle(); assert.equal(f.byId('memory-body').value, 'Successfully saved A'); assert.equal(f.byId('app-error').hidden, true); assert.equal(f.byId('app-status').textContent, savedStatus);
});

test('root a successful late key revocation updates a reopened key dialog', async t => {
  const f = await browser(t, '/'); let release, reached, keyId;
  const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => { if (path.startsWith('/v1/keys/') && init.method === 'DELETE') { keyId = path.split('/').at(-1); reached(); await held; } return response; });
  f.byId('manage-keys').click(); f.byId('dialog-form').querySelector('.key-list button').click(); await waiting;
  try { f.byId('dialog-close').click(); f.byId('manage-keys').click(); } finally { release(); }
  await f.settle(); assert.equal(f.byId('dialog-form').querySelector('[data-key-id="'+keyId+'"]'), null); assert.equal(f.byId('dialog-error').hidden, true);
  f.byId('dialog-close').click(); f.byId('manage-keys').click(); assert.equal(f.byId('dialog-form').querySelector('[data-key-id="'+keyId+'"]'), null);
});

test('management clearing results leaves a terminal status', async t => {
  const f = await browser(t, '/manage'); f.byId('usage').click(); await f.settle(); assert.equal(f.byId('status').textContent, '완료');
  f.byId('clear-result').click(); await f.settle(); assert.equal(f.byId('result').textContent, ''); assert.doesNotMatch(f.byId('status').textContent, /처리 중/); assert.match(f.byId('status').textContent, /지웠/);
});

test('management initial unauthenticated load gives a terminal sign-in message', async t => {
  const f = await browser(t, '/manage', f => { f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at); return f.token; });
  assert.equal(f.calls.find(call => call.path === '/v1/workspace').status, 401); assert.doesNotMatch(f.byId('status').textContent, /처리 중/); assert.match(f.byId('status').textContent, /로그인/); assert.equal(f.byId('add-form').querySelector('button').disabled, true);
});

test('management late team save cannot clear an identical personal draft after email unlink changes the Space', async t => {
  const f = await browser(t, '/manage'); f.byId('space').value = 'so'; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle();
  let release, reached; const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => { if (path === '/v1/spaces/so/memories' && init.method === 'POST') { reached(); await held; } return response; });
  f.byId('add-form').elements.body.value = 'SAME TEXT IN DISTINCT SPACES'; f.submit('add-form'); await waiting;
  try {
    f.byId('email-unlink').elements.emailId.value = 'e1'; f.submit('email-unlink');
    for (let i = 0; i < 100 && (f.byId('space').value !== 's1' || f.byId('space').disabled); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.byId('space').value, 's1'); f.byId('add-form').elements.body.value = 'SAME TEXT IN DISTINCT SPACES';
  } finally { release(); }
  await f.settle(); assert.equal(f.byId('add-form').elements.body.value, 'SAME TEXT IN DISTINCT SPACES');
  assert.equal(f.db.raw.prepare("SELECT count(*) AS n FROM memories WHERE space_id='s1'").get().n, 0);
});

test('management exposes body and conversation drafts when email unlink removes their Space', async t => {
  const f = await browser(t, '/manage'); f.byId('space').value = 'so'; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle();
  f.byId('add-form').elements.body.value = 'REMOVED TEAM DRAFT'; f.byId('ingest-form').elements.messages.value = 'REMOVED TEAM CONVERSATION';
  f.byId('email-unlink').elements.emailId.value = 'e1'; f.submit('email-unlink'); await f.settle();
  assert.equal(f.byId('space').value, 's1'); assert.equal(f.byId('recovery-drafts').hidden, false);
  assert.match(f.byId('recovery-text').textContent, /REMOVED TEAM DRAFT/); assert.match(f.byId('recovery-text').textContent, /REMOVED TEAM CONVERSATION/);
  f.switchAccount(); f.byId('reload').click(); await f.settle(); assert.equal(f.byId('recovery-text').textContent, '');
});

test('management exposes drafts of a removed Space even when another Space was already selected', async t => {
  const f = await browser(t, '/manage');
  const choose = async id => { f.byId('space').value = id; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle(); };
  await choose('so'); f.byId('add-form').elements.body.value = 'NONSELECTED TEAM DRAFT'; f.byId('ingest-form').elements.messages.value = 'NONSELECTED TEAM CONVERSATION';
  await choose('s1'); f.byId('add-form').elements.body.value = 'CURRENT PERSONAL DRAFT';
  f.db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m1'").run(at); f.byId('reload').click(); await f.settle();
  assert.equal(f.byId('space').value, 's1'); assert.equal(f.byId('add-form').elements.body.value, 'CURRENT PERSONAL DRAFT');
  assert.equal(f.byId('recovery-drafts').hidden, false); assert.match(f.byId('recovery-text').textContent, /NONSELECTED TEAM DRAFT/); assert.match(f.byId('recovery-text').textContent, /NONSELECTED TEAM CONVERSATION/);
});

test('management a late ingest receipt cannot replace output after an implicit Space fallback', async t => {
  const f = await browser(t, '/manage', null, { AI: { run: async () => ({}) }, BACKGROUND_JOBS_ENABLED: 'true', PAYLOAD_KEY: Buffer.alloc(32, 3).toString('base64url') });
  f.byId('space').value = 'so'; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle();
  let release, reached, ingestId; const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => { if (path === '/v1/spaces/so/ingests' && init.method === 'POST') { ingestId = (await response.clone().json()).id; reached(); await held; } return response; });
  f.byId('ingest-form').elements.messages.value = JSON.stringify([{ id:'m1', role:'user', content:'PRIVATE TEAM SOURCE' }]); f.submit('ingest-form'); await waiting;
  try {
    f.byId('email-unlink').elements.emailId.value = 'e1'; f.submit('email-unlink');
    for (let i = 0; i < 100 && (f.byId('space').value !== 's1' || f.byId('space').disabled); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.byId('space').value, 's1'); f.byId('ingest-form').elements.messages.value = 'PERSONAL CONVERSATION';
  } finally { release(); }
  await f.settle(); assert.equal(f.byId('ingest-form').elements.messages.value, 'PERSONAL CONVERSATION');
  assert.equal(f.byId('result').textContent.includes(ingestId), false); assert.match(f.byId('recovery-text').textContent, /PRIVATE TEAM SOURCE/);
});

test('root administrators cannot remove owners even when multiple owners remain', async t => {
  const f = await browser(t, '/', f => {
    f.db.raw.exec("UPDATE memberships SET role='admin' WHERE id='m1'; UPDATE memberships SET role='owner' WHERE id='m2'; INSERT INTO accounts(id) VALUES('charlie')");
    f.db.raw.prepare('INSERT INTO account_emails VALUES(?,?,?,?,?,NULL)').run('e3','charlie','charlie@example.com','example.com',at);
    f.db.raw.exec("INSERT INTO memberships VALUES('m3','org','charlie','e3','owner',9007199254740991,NULL)"); return f.token;
  });
  f.byId('manage-members').click(); await f.settle();
  const owners = [...f.byId('members-list').querySelectorAll('[data-role="owner"]')]; assert.equal(owners.length, 2);
  for (const row of owners) { assert.equal(row.querySelector('button').disabled, true); assert.match(row.textContent, /소유자만/); row.querySelector('button').click(); }
  await f.settle(); assert.equal(f.calls.some(call => call.method === 'DELETE'), false);
});

for (const action of ['delete','edit','erase','email-unlink','domain-revoke']) test('management reports a cancelled '+action+' without claiming completion or sending a request', async t => {
  const f = await browser(t, '/manage', async f => { const store = new MemoryStore(f.db, () => at), memory = await store.create(f.token, 's1', { body: 'Preserve on cancel' }, 'cancel-seed'); if (action === 'erase') await store.remove(f.token, 's1', memory.id, 1, 'cancel-trash'); return f.token; });
  if (action === 'erase') { f.byId('trash').click(); await f.settle(); }
  if (action === 'domain-revoke') { f.byId('organization').value = 'org'; f.byId('organization').dispatchEvent(new f.w.Event('change')); }
  f.w.confirm = () => false; f.w.prompt = () => action === 'erase' ? 'incorrect confirmation ID' : null;
  const before = f.calls.length;
  if (['email-unlink','domain-revoke'].includes(action)) f.submit(action);
  else [...f.byId('memories').querySelectorAll('button')].find(b => b.textContent === ({ delete:'휴지통', edit:'수정', erase:'영구 제거' })[action]).click();
  await f.settle(); assert.equal(f.calls.length, before); assert.doesNotMatch(f.byId('status').textContent, /완료/); assert.match(f.byId('status').textContent, /취소|일치|보내지/);
});

test('management retains a late one-time PAT independently of a newer usage result', async t => {
  const f = await browser(t, '/manage'); let release, reached, token;
  const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => { if (path === '/v1/keys') { token = (await response.clone().json()).token; reached(); await held; } return response; });
  f.byId('key-form').elements.label.value = 'Delayed one-time key'; f.submit('key-form'); await waiting;
  try {
    f.byId('usage').click();
    for (let i = 0; i < 100 && !f.byId('result').textContent.includes('usedUnits'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(f.byId('result').textContent, /usedUnits/);
  } finally { release(); }
  await f.settle(); assert.ok(f.w.document.body.textContent.includes(token), 'The committed credential must remain accessible in its own receipt');
  assert.match(f.byId('mutation-receipts').textContent, /s1|Personal/);
});

test('management orphaned failed edits remain copyable after their erased card disappears', async t => {
  let original;
  const f = await browser(t, '/manage', async f => { original = await new MemoryStore(f.db, () => at).create(f.token, 's1', { body: 'Before erase' }, 'orphan-seed'); return f.token; });
  const store = new MemoryStore(f.db, () => at); await store.remove(f.token, 's1', original.id, 1, 'orphan-remove'); await store.erase(f.token, 's1', original.id, 2, original.id, 'orphan-erase');
  f.w.prompt = () => 'ONLY ORPHANED EDIT COPY';
  [...f.byId('memories').querySelectorAll('button')].find(b => b.textContent === '수정').click(); await f.settle();
  f.byId('refresh-memories').click(); await f.settle();
  assert.equal(f.byId('memories').children.length, 0); assert.equal(f.byId('recovery-drafts').hidden, false);
  assert.match(f.byId('recovery-text').textContent, /ONLY ORPHANED EDIT COPY/);
});

test('management broad personal PAT disclosure includes accepted foreign organization shares', async t => {
  const f = await browser(t, '/manage', async f => {
    f.db.raw.exec("INSERT INTO organizations(id) VALUES('foreign'); INSERT INTO memberships VALUES('foreign-owner','foreign','bob','e2','owner',9007199254740991,NULL)");
    f.db.raw.prepare('INSERT INTO spaces VALUES(?,?,?,?,?,?,?)').run('foreign-space','Foreign team',null,'foreign','managed',at,'session:bob');
    const transfer = new Transfers(f.db, () => at), share = await transfer.share(f.other, 'foreign-space', 'alice@example.com'); await transfer.accept(f.token, share.id); return f.token;
  });
  f.byId('space').value = 's1'; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle();
  const form = f.byId('key-form'); form.elements.label.value = 'Broad personal'; form.elements.singleSpace.checked = false; form.elements.singleSpace.dispatchEvent(new f.w.Event('change'));
  assert.match(f.byId('pat-scope').textContent, /수락.*공유|승인.*공유/);
  f.submit('key-form'); await f.settle(); const issued = JSON.parse(f.byId('result').textContent);
  assert.ok((await new MemoryStore(f.db, () => at).spaces(issued.token)).results.some(s => s.id === 'foreign-space'));
});

test('management a late save preserves a newer search view', async t => {
  const f = await browser(t, '/manage', async f => { await new MemoryStore(f.db, () => at).create(f.token, 's1', { body: 'needle match' }, 'view-seed'); return f.token; }); let release, reached;
  const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => { if (path.endsWith('/memories') && init.method === 'POST') { reached(); await held; } return response; });
  f.byId('add-form').elements.body.value = 'Unrelated saved body'; f.submit('add-form'); await waiting;
  try {
    f.byId('search-form').elements.query.value = 'needle'; f.submit('search-form');
    for (let i = 0; i < 100 && !f.byId('memories').textContent.includes('needle'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  } finally { release(); }
  await f.settle(); assert.match(f.byId('memories').textContent, /needle/); assert.doesNotMatch(f.byId('memories').textContent, /Unrelated saved body/);
});

test('management a successful edit refresh preserves its active search filter', async t => {
  const f = await browser(t, '/manage', async f => { await new MemoryStore(f.db, () => at).create(f.token, 's1', { body: 'needle match' }, 'filtered-edit'); await new MemoryStore(f.db, () => at).create(f.token, 's1', { body: 'Unrelated live memory' }, 'filtered-other'); return f.token; });
  f.byId('search-form').elements.query.value = 'needle'; f.submit('search-form'); await f.settle();
  f.w.prompt = () => 'No longer matches'; [...f.byId('memories').querySelectorAll('button')].find(b => b.textContent === '수정').click(); await f.settle();
  assert.equal(f.byId('memories').children.length, 0); assert.equal(f.byId('search-form').elements.query.value, 'needle');
  assert.equal(f.db.raw.prepare("SELECT count(*) AS n FROM memories WHERE body='No longer matches'").get().n, 1);
});

test('root member management disables the remaining owner after another owner is removed', async t => {
  const f = await browser(t, '/', async f => { f.db.raw.exec("UPDATE memberships SET role='owner' WHERE id='m2'"); return f.token; }); f.byId('manage-members').click(); await f.settle();
  const rows = [...f.byId('members-list').querySelectorAll('.key-row')]; assert.equal(rows.filter(row => row.textContent.includes('소유자')).length, 2);
  const bob = rows.find(row => row.textContent.includes('bob@example.com')); bob.querySelector('button').click(); await f.settle();
  const remaining = f.byId('members-list').querySelector('.key-row'); assert.equal(remaining.querySelector('button').disabled, true); assert.match(remaining.textContent, /마지막 소유자/);
});

test('root member management disables removal of its known last owner', async t => {
  const f = await browser(t, '/'); f.byId('manage-members').click(); await f.settle();
  const owner = [...f.byId('members-list').querySelectorAll('.key-row')].find(row => row.textContent.includes('소유자'));
  assert.equal(owner.querySelector('button').disabled, true); assert.match(owner.textContent, /마지막 소유자/);
  assert.doesNotMatch(owner.textContent,/먼저 지정|소유자.*초대|승격/);
  owner.querySelector('button').click(); await f.settle(); assert.equal(f.calls.some(c => c.method === 'DELETE'), false);
});

test('management stale extraction cancellation does not report success after approval', async t => {
  const variables = { BACKGROUND_JOBS_ENABLED: 'true', PAYLOAD_KEY: Buffer.alloc(32, 3).toString('base64url'), AI: { run: async () => ({ response: { memories: [{ body: 'Reviewed fact', kind: 'fact', sourceMessageId: 'm1', quote: 'source fact' }] } }) } };
  const f = await browser(t, '/manage', null, variables), ingest = new Ingest({ DB: f.db, ...variables }, () => at), jobs = new Jobs({ DB: f.db, ...variables }, () => at); jobs.ingest = job => ingest.process(job);
  const started = await ingest.submit(f.token, 's1', { messages: [{ id: 'm1', role: 'user', content: 'A source fact' }] }, 'stale-cancel'); await jobs.drain(1);
  f.byId('ingests').click(); await f.settle(); await ingest.approve(f.token, 's1', started.id, [0], 'other-tab-approve');
  [...f.byId('proposals').querySelectorAll('button')].find(b => b.textContent.includes('취소')).click(); await f.settle();
  assert.equal(f.calls.findLast(c => c.method === 'DELETE').status, 409); assert.doesNotMatch(f.byId('proposals').textContent, /취소 완료/);
  assert.equal(f.db.raw.prepare('SELECT count(*) AS n FROM memories').get().n, 1);
});

for (const method of ['POST', 'PATCH', 'DELETE']) test('root accepts a recovered ' + method + ' response and retains its committed identity', async t => {
  const f = await browser(t, '/', async f => { if (method !== 'POST') await new MemoryStore(f.db, () => at).create(f.token, 's1', { body: 'Stored before expiry' }, 'recovery-seed'); return f.token; });
  if (method === 'POST') f.byId('new-memory').click();
  const change = value => { f.byId('memory-body').value = value; f.byId('memory-body').dispatchEvent(new f.w.Event('input')); };
  change('Draft before expiry');
  f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);
  const send = () => method === 'DELETE' ? f.byId('delete-memory').click() : f.submit('editor-form');
  send(); await f.settle();
  assert.equal(f.byId('reauth-actions').hidden, false);
  f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at + 900000);
  f.byId('resume-session').click(); await f.settle(); send(); await f.settle();
  assert.equal(f.calls.findLast(call => call.method === method).status, method === 'POST' ? 201 : method === 'PATCH' ? 200 : 204);
  assert.match(f.byId('app-status').textContent, method === 'DELETE' ? /삭제했어요/ : /저장했어요/);
  if (method === 'DELETE') { assert.equal(f.byId('editor-form').hidden, true); return; }
  change('Next deliberate edit'); f.submit('editor-form'); await f.settle();
  const records = f.db.raw.prepare('SELECT body,revision FROM memories').all();
  assert.equal(records.length, 1); assert.equal(records[0].body, 'Next deliberate edit');
  assert.equal(records[0].revision, method === 'POST' ? 2 : 3);
});

for (const path of ['/', '/manage']) test(path + ' preserves the original logout account across repeated mismatch responses', async t => {
  const f = await browser(t, path), bindings = [];
  f.intercept((url, init, response) => { if (url === '/auth/logout') bindings.push(new Headers(init.headers).get('x-memory-account-id')); return response; });
  f.switchAccount(); f.byId('logout').click(); await f.settle(); f.byId('logout').click(); await f.settle();
  assert.deepEqual(bindings, ['alice', 'alice']);
  assert.equal(f.db.raw.prepare("SELECT revoked_at FROM credentials WHERE id='session:bob'").get().revoked_at, null);
});

test('management a late usage response cannot replace a newly issued one-time PAT', async t => {
  const f = await browser(t, '/manage'); let release, reached;
  const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => { if (path.endsWith('/usage')) { reached(); await held; } return response; });
  f.byId('usage').click(); await waiting;
  let displayed;
  try {
    f.byId('key-form').elements.label.value = 'One-time PAT'; f.submit('key-form');
    for (let i = 0; i < 100 && !f.byId('result').textContent.includes('"token"'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    displayed = f.byId('result').textContent; assert.ok(JSON.parse(displayed).token);
  } finally { release(); }
  await f.settle(); assert.equal(f.byId('result').textContent, displayed);
});

test('management a delayed expiry response cannot clear a PAT issued after the session was renewed', async t => {
  const f = await browser(t, '/manage'); let release, reached;
  const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => { if (path.endsWith('/usage')) { reached(); await held; } return response; });
  f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);
  f.byId('usage').click(); await waiting;
  let displayed;
  try {
    f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at + 900000);
    f.byId('key-form').elements.label.value = 'Newly verified session'; f.submit('key-form');
    for (let i = 0; i < 100 && !f.byId('result').textContent.includes('"token"'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    displayed = f.byId('result').textContent; assert.ok(JSON.parse(displayed).token);
  } finally { release(); }
  await f.settle(); assert.equal(f.byId('result').textContent, displayed);
  assert.equal(f.byId('reauth-actions').hidden, true);
});

test('management a late committed create preserves a newer PAT and still clears the completed draft', async t => {
  const f = await browser(t, '/manage'); let release, reached;
  const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => { if (path.endsWith('/memories') && init.method === 'POST') { reached(); await held; } return response; });
  f.byId('add-form').elements.body.value = 'Committed while another task starts'; f.submit('add-form'); await waiting;
  let displayed;
  try {
    f.byId('key-form').elements.label.value = 'Newer secret'; f.submit('key-form');
    for (let i = 0; i < 100 && !f.byId('result').textContent.includes('"token"'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    displayed = f.byId('result').textContent; assert.ok(JSON.parse(displayed).token);
  } finally { release(); }
  await f.settle(); assert.equal(f.byId('result').textContent, displayed);
  assert.equal(f.byId('add-form').elements.body.value, '');
  assert.equal(f.db.raw.prepare('SELECT count(*) AS n FROM memories').get().n, 1);
});

test('management preserves oversized edit input before rejecting it and offers the exact text for correction', async t => {
  const f = await browser(t, '/manage', async f => { await new MemoryStore(f.db, () => at).create(f.token, 's1', { body: 'Original body' }, 'validation-seed'); return f.token; });
  const oversized = 'a'.repeat(16385), offered = [];
  f.w.prompt = (label, initial) => { offered.push(initial); return offered.length === 1 ? oversized : null; };
  const edit = () => [...f.byId('memories').querySelectorAll('button')].find(b => b.textContent === '수정').click();
  edit(); await f.settle(); assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
  assert.equal(f.byId('memories').querySelector('.edit-draft textarea')?.value, oversized);
  f.byId('refresh-memories').click(); await f.settle(); edit(); await f.settle();
  assert.equal(offered[1], oversized);
});

test('root receipt retry preserves submitted text when the committed memory has since been deleted', async t => {
  const f = await browser(t, '/', async f => { await new MemoryStore(f.db, () => at).create(f.token, 's1', { body: 'Another live memory' }, 'seed-live'); return f.token; }); let drop = true;
  f.intercept(async (path, init, response) => {
    if (init.method === 'POST' && path.endsWith('/memories') && drop) {
      drop = false; const created = await response.clone().json();
      await new MemoryStore(f.db, () => at).remove(f.token, 's1', created.id, created.revision, 'other-client-delete');
      throw Error('Lost response');
    }
    return response;
  });
  f.byId('new-memory').click(); f.byId('memory-body').value = 'Preserve this submitted text';
  f.byId('memory-body').dispatchEvent(new f.w.Event('input'));
  f.submit('editor-form'); await f.settle(); f.submit('editor-form'); await f.settle();
  assert.equal(f.byId('memory-body').value, 'Preserve this submitted text');
  assert.equal(f.byId('save-memory').disabled, true);
  assert.equal(f.byId('memory-body').readOnly, true);
  assert.match(f.byId('permission-badge').textContent, /복사용/);
  assert.match(f.byId('app-status').textContent, /적용.*현재|현재.*본문/);
  assert.equal(f.db.raw.prepare('SELECT count(*) AS n FROM memories').get().n, 2);
});

test('root late receipt reconciliation cannot replace a newly selected Space editor', async t => {
  const f = await browser(t, '/'); const store = new MemoryStore(f.db, () => at); let attempts = 0, release, reached;
  const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, init, response) => {
    if (init.method === 'POST' && path.endsWith('/memories')) {
      const value = await response.clone().json();
      if (++attempts === 1) { await store.remove(f.token, 's1', value.id, 1, 'delete-reconciliation'); throw Error('Lost response'); }
      await store.restore(f.token, 's1', value.id, 2, 'restore-reconciliation');
    } else if (attempts === 2 && init.method === 'GET' && /\/memories\/[^/]+$/.test(path)) { reached(); await held; }
    return response;
  });
  f.byId('new-memory').click(); f.byId('memory-body').value = 'OLD SPACE BODY'; f.byId('memory-body').dispatchEvent(new f.w.Event('input'));
  f.submit('editor-form'); await f.settle(); f.submit('editor-form'); await waiting;
  try {
    f.byId('new-space').click(); f.byId('field-name').value = 'New destination'; f.submit('dialog-form');
    for (let i = 0; i < 50 && f.byId('space-title').textContent !== 'New destination'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.byId('space-title').textContent, 'New destination');
  } finally { release(); }
  await f.settle();
  assert.equal(f.byId('memory-body').value, ''); assert.equal(f.byId('save-memory').disabled, true);
});

for (const method of ['POST', 'PATCH']) test('management keeps its submitted copy after an erased ' + method + ' receipt retry', async t => {
  const f = await browser(t, '/manage', async f => { if (method === 'PATCH') await new MemoryStore(f.db, () => at).create(f.token, 's1', { body: 'Stored original' }, 'receipt-seed'); return f.token; });
  let drop = true; f.intercept(async (path, init, response) => {
    if (init.method === method && path.includes('/memories') && drop) { drop = false; const m = await response.clone().json(), store = new MemoryStore(f.db, () => at); await store.remove(f.token, 's1', m.id, m.revision, 'receipt-remove'); await store.erase(f.token, 's1', m.id, m.revision + 1, m.id, 'receipt-erase'); throw Error('Lost response'); }
    return response;
  });
  const body = 'LAST REMAINING SUBMITTED COPY';
  f.byId('add-form').elements.body.value = body; f.w.prompt = () => body;
  const send = () => method === 'POST' ? f.submit('add-form') : [...f.byId('memories').querySelectorAll('button')].find(b => b.textContent === '수정').click();
  send(); await f.settle(); send(); await f.settle();
  if (method === 'POST') assert.equal(f.byId('add-form').elements.body.value, body);
  assert.match(f.byId('recovery-text').textContent, /LAST REMAINING SUBMITTED COPY/);
});

test('management pages real incoming shares on demand and clears them if the cookie account changes', async t => {
  const f = await browser(t, '/manage', async f => {
    const transfers = new Transfers(f.db, () => at);
    for (let i = 0; i < 27; i++) {
      const id = 'incoming-space-'+i;
      f.db.raw.prepare('INSERT INTO spaces VALUES(?,?,?,?,?,?,?)').run(id, 'Incoming '+i, 'bob', null, 'managed', at, 'session:bob');
      await transfers.share(f.other, id, 'alice@example.com');
    }
    return f.token;
  });
  f.byId('invitations').click(); await f.settle();
  assert.equal(f.byId('shares').children.length, 25);
  assert.equal(f.calls.filter(c => c.path.startsWith('/v1/shares?')).length, 1);
  assert.equal(f.byId('shares-more').hidden, false);
  f.byId('shares-more').click(); await f.settle();
  assert.equal(f.byId('shares').children.length, 27);
  assert.equal(f.byId('shares-more').hidden, true);
  f.byId('invitations').click(); await f.settle();
  f.switchAccount(); f.byId('shares-more').click(); await f.settle();
  assert.equal(f.byId('shares').children.length, 0);
  assert.equal(f.byId('shares-more').hidden, true);
  assert.equal(f.calls.findLast(c => c.path.startsWith('/v1/shares?')).status, 409);
});

for (const reconnect of ['same', 'different']) test('management expiry retains Space drafts until ' + reconnect + ' account reconnect', async t => {
  const f = await browser(t, '/manage'); const switchTo = async id => { f.byId('space').value = id; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle(); };
  f.byId('add-form').elements.body.value = 'PERSONAL DRAFT';
  f.byId('ingest-form').elements.messages.value = 'PERSONAL CONVERSATION';
  await switchTo('so'); f.byId('add-form').elements.body.value = 'TEAM DRAFT';
  f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);
  f.byId('usage').click(); await f.settle();
  assert.equal(f.byId('add-form').elements.body.value, 'TEAM DRAFT');
  assert.equal(f.byId('add-form').querySelector('button').disabled, true);
  assert.ok(f.byId('resume-session'));
  if (reconnect === 'same') f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at + 900000);
  else f.switchAccount();
  f.byId('resume-session').click(); await f.settle();
  if (reconnect === 'same') { await switchTo('s1'); assert.equal(f.byId('add-form').elements.body.value, 'PERSONAL DRAFT'); assert.equal(f.byId('ingest-form').elements.messages.value, 'PERSONAL CONVERSATION'); }
  else { assert.equal(f.byId('add-form').elements.body.value, ''); assert.doesNotMatch(f.w.document.body.textContent, /PERSONAL DRAFT|TEAM DRAFT/); }
});

test('management failed edit keeps replacement text visible and reopens it for conflict resolution', async t => {
  const f = await browser(t, '/manage', async f => { await new MemoryStore(f.db, () => at).create(f.token, 's1', { body: 'Stored text' }, 'seed-edit'); return f.token; });
  const offered = []; f.w.prompt = (label, initial) => { offered.push(initial); return 'Unsaved replacement'; };
  f.intercept((path, init, response) => init.method === 'PATCH' ? new Response('{"error":"revision_conflict"}', { status: 409 }) : response);
  const edit = () => [...f.byId('memories').querySelectorAll('button')].find(b => b.textContent === '수정').click();
  edit(); await f.settle();
  assert.ok([...f.byId('memories').querySelectorAll('textarea')].some(el => el.value === 'Unsaved replacement'));
  f.byId('refresh-memories').click(); await f.settle(); edit(); await f.settle();
  assert.equal(offered[1], 'Unsaved replacement');
});

test('management starts a new extraction after a confirmed cancellation of identical input', async t => {
  const f = await browser(t, '/manage', null, { AI: { run: async () => ({}) }, BACKGROUND_JOBS_ENABLED: 'true', PAYLOAD_KEY: Buffer.alloc(32, 3).toString('base64url') });
  f.byId('ingest-form').elements.messages.value = JSON.stringify([{ id: 'm1', role: 'user', content: 'Extract again' }]);
  f.submit('ingest-form'); await f.settle();
  f.byId('ingests').click(); await f.settle(); [...f.byId('proposals').querySelectorAll('button')].find(b => b.textContent.includes('취소')).click(); await f.settle();
  f.submit('ingest-form'); await f.settle();
  assert.equal(f.db.raw.prepare('SELECT count(*) AS n FROM release_ingests').get().n, 2);
});

test('management disables memory writes for a known ordinary organization member', async t => {
  const f = await browser(t, '/manage', async f => { await new MemoryStore(f.db, () => at).create(f.token, 'so', { body: 'Read only' }, 'seed-readonly'); f.db.raw.exec("UPDATE memberships SET role='member' WHERE id='m2'"); return f.other; });
  f.byId('space').value = 'so'; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle();
  assert.equal(f.byId('add-form').querySelector('button').disabled, true);
  for (const b of f.byId('memories').querySelectorAll('button')) assert.equal(b.disabled, true);
  assert.match(f.byId('space-permission').textContent, /읽기 전용/);
});

test('management recognizes a personal Space share as read-only for both editing and PAT issuance', async t => {
  const f = await browser(t, '/manage', async f => { const transfers = new Transfers(f.db, () => at); const share = await transfers.share(f.token, 's1', 'bob@example.com'); await transfers.accept(f.other, share.id); return f.other; });
  f.byId('space').value = 's1'; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle();
  assert.equal(f.byId('add-form').querySelector('button').disabled, true);
  assert.equal(f.byId('key-form').elements.singleSpace.disabled, true);
  assert.match(f.byId('pat-scope').textContent, /공유/);
  for (const checkbox of f.byId('key-form').querySelectorAll('input[name="cap"]')) assert.equal(checkbox.checked, checkbox.value === 'read');
});

test('management recovered draft copies are cleared by a subsequent normal account refresh', async t => {
  const f = await browser(t, '/manage'); f.byId('add-form').elements.body.value = 'PRIVATE RECOVERY COPY';
  f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);
  f.byId('usage').click(); await f.settle();
  assert.match(f.byId('recovery-text').textContent, /PRIVATE RECOVERY COPY/);
  f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at + 900000);
  f.byId('resume-session').click(); await f.settle();
  f.switchAccount(); f.byId('reload').click(); await f.settle();
  assert.equal(f.byId('recovery-text').textContent, '');
  assert.equal(f.byId('add-form').elements.body.value, '');
});

test('management keeps an uncertain extraction submission operation for a safe retry', async t => {
  const f = await browser(t, '/manage', null, { AI: { run: async () => ({}) }, BACKGROUND_JOBS_ENABLED: 'true', PAYLOAD_KEY: Buffer.alloc(32, 3).toString('base64url') });
  let drop = true; f.intercept((path, init, response) => { if (path.endsWith('/ingests') && init.method === 'POST' && drop) { drop = false; throw Error('Lost response'); } return response; });
  f.byId('ingest-form').elements.messages.value = JSON.stringify([{ id: 'm1', role: 'user', content: 'Uncertain extraction' }]);
  f.submit('ingest-form'); await f.settle(); f.submit('ingest-form'); await f.settle();
  const writes = f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/ingests'));
  assert.equal(writes[0].data.operationId, writes[1].data.operationId);
  assert.equal(f.db.raw.prepare('SELECT count(*) AS n FROM release_ingests').get().n, 1);
});

test('management CSS applies validated product accent without accepting CSS injection', () => {
  assert.equal(typeof managementUi.renderManagementStyles, 'function');
  assert.match(managementUi.renderManagementStyles({ accentColor: '#a12b34' }), /#a12b34/);
  assert.doesNotMatch(managementUi.renderManagementStyles({ accentColor: 'red;}body{display:none' }), /display:none/);
});

test('root release caption distinguishes creation ordering and relevance search', async t => {
  const f = await browser(t, '/');
  assert.equal(f.byId('list-order')?.textContent, '최근 생성순');
  f.byId('search-query').value = 'find'; f.submit('search-form'); await f.settle();
  assert.equal(f.byId('list-order').textContent, '관련도순');
});

test('management keeps the current Space and locks actions until all refresh pages are ready', async t => {
  const f = await browser(t, '/manage', f => {
    for (let i = 0; i < 100; i++) f.db.raw.prepare('INSERT INTO spaces VALUES(?,?,?,?,?,?,?)')
      .run('extra-'+i, 'Extra '+i, 'alice', null, 'managed', at, 'session:alice');
    return f.token;
  });
  f.byId('space').value = 'so'; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle();
  f.byId('add-form').elements.body.value = 'PRIVATE TEAM DRAFT';
  f.byId('ingest-form').elements.messages.value = 'PRIVATE TEAM CONVERSATION';
  let reached, release;
  const waiting = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
  f.intercept(async (path, init, response) => {
    if (path.startsWith('/v1/spaces?') && path.includes('cursor=')) { reached(); await held; }
    return response;
  });
  f.byId('reload').click(); await waiting;
  try {
    assert.equal(f.byId('space').value, 'so', 'A partial new option list must never become a draft destination');
    assert.equal(f.byId('space').disabled, true);
    assert.equal(f.byId('add-form').querySelector('button').disabled, true);
    f.submit('add-form'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.some(call => call.method === 'POST'), false, 'Programmatic form submission must honor the refresh lock');
    f.byId('add-form').elements.body.value = 'NEW TEXT TYPED DURING REFRESH';
  } finally { release(); }
  await f.settle();
  assert.equal(f.byId('space').value, 'so');
  assert.equal(f.byId('space').disabled, false);
  assert.equal(f.byId('add-form').elements.body.value, 'NEW TEXT TYPED DURING REFRESH');
  assert.equal(f.byId('ingest-form').elements.messages.value, 'PRIVATE TEAM CONVERSATION');
  f.submit('add-form'); await f.settle();
  assert.equal(f.db.raw.prepare("SELECT space_id FROM memories WHERE body='NEW TEXT TYPED DURING REFRESH'").get().space_id, 'so');
});

test('management clears stale account state if cookies change between workspace and Space reads', async t => {
  const f = await browser(t, '/manage');
  f.byId('add-form').elements.body.value = 'PRIVATE ALICE DRAFT';
  f.intercept((path, init, response) => { if (path === '/v1/workspace') f.switchAccount(); return response; });
  f.byId('reload').click(); await f.settle();
  assert.equal(f.calls.findLast(call => call.path.startsWith('/v1/spaces?')).status, 409);
  assert.equal(f.byId('space').options.length, 0);
  assert.equal(f.byId('add-form').elements.body.value, '');
  assert.equal(f.byId('add-form').querySelector('button').disabled, true);
  assert.match(f.byId('status').textContent, /계정/);
});

test('management failed refresh retains the installed Space and draft and unlocks a safe retry', async t => {
  const f = await browser(t, '/manage');
  f.byId('space').value = 'so'; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle();
  f.byId('add-form').elements.body.value = 'PRIVATE TEAM DRAFT';
  f.intercept((path, init, response) => path === '/v1/release/config' ? new Response('{}', { status: 500 }) : response);
  f.byId('reload').click(); await f.settle();
  assert.equal(f.byId('space').value, 'so');
  assert.equal(f.byId('space').disabled, false);
  assert.equal(f.byId('add-form').elements.body.value, 'PRIVATE TEAM DRAFT');
  assert.equal(f.byId('add-form').querySelector('button').disabled, false);
  f.submit('add-form'); await f.settle();
  assert.equal(f.db.raw.prepare("SELECT space_id FROM memories WHERE body='PRIVATE TEAM DRAFT'").get().space_id, 'so');
});

for (const method of ['POST', 'PATCH', 'DELETE']) test('root editor retries a lost ' + method + ' response without another commit', async t => {
  const f = await browser(t, '/');
  f.byId('new-memory').click();
  const change = value => { f.byId('memory-body').value = value; f.byId('memory-body').dispatchEvent(new f.w.Event('input')); };
  change('Initial memory');
  if (method !== 'POST') { f.submit('editor-form'); await f.settle(); change('Updated memory'); }
  let drop = true;
  f.intercept((path, init, response) => {
    if (init.method === method && path.includes('/memories') && response.ok && drop) { drop = false; throw new Error('Lost response after commit'); }
    return response;
  });
  const send = () => method === 'DELETE' ? f.byId('delete-memory').click() : f.submit('editor-form');
  send(); await f.settle(); send(); await f.settle();
  const writes = f.calls.filter(call => call.method === method && call.path.includes('/memories'));
  assert.equal(writes.length, 2);
  assert.ok(writes[0].data.operationId, 'Create the operation ID before sending');
  assert.equal(writes[0].data.operationId, writes[1].data.operationId);
  assert.equal(writes[1].status, method === 'POST' ? 201 : method === 'PATCH' ? 200 : 204);
  const records = f.db.raw.prepare('SELECT revision,deleted_at FROM memories').all();
  assert.equal(records.length, 1);
  assert.equal(records[0].revision, method === 'POST' ? 1 : 2);
  assert.equal(records[0].deleted_at !== null, method === 'DELETE');
  assert.equal(f.byId('app-error').hidden, true);
});

test('root editor uses a new operation for changed content and a deliberately new identical draft', async t => {
  const f = await browser(t, '/');
  f.byId('new-memory').click();
  let drop = true;
  f.intercept((path, init, response) => { if (init.method === 'POST' && path.endsWith('/memories') && drop) { drop = false; throw new Error('Lost response after commit'); } return response; });
  const change = value => { f.byId('memory-body').value = value; f.byId('memory-body').dispatchEvent(new f.w.Event('input')); };
  change('First intended content'); f.submit('editor-form'); await f.settle();
  change('Changed content'); f.submit('editor-form'); await f.settle();
  f.byId('new-memory').click(); change('Changed content'); f.submit('editor-form'); await f.settle();
  const writes = f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/memories'));
  assert.equal(writes.length, 3);
  assert.equal(new Set(writes.map(call => call.data.operationId)).size, 3);
  assert.equal(f.db.raw.prepare('SELECT count(*) AS n FROM memories').get().n, 3);
  assert.equal(f.db.raw.prepare("SELECT count(*) AS n FROM memories WHERE body='Changed content'").get().n, 2);
});

for (const path of ['/', '/manage']) test(`${path} refuses a draft mutation after another tab switches to a shared-Space account`, async t => {
  const f = await browser(t, path);
  if (path === '/') {
    [...f.w.document.querySelectorAll('#space-list button')].find(button => button.textContent.includes('Team')).click();
    await f.settle(); f.byId('new-memory').click();
    f.byId('memory-body').value = 'ALICE PRIVATE UNSAVED DRAFT';
    f.byId('memory-body').dispatchEvent(new f.w.Event('input'));
  } else {
    f.byId('space').value = 'so'; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle();
    f.byId('add-form').elements.body.value = 'ALICE PRIVATE UNSAVED DRAFT';
    f.byId('result').textContent = 'ALICE PRIVATE RESULT';
  }
  f.switchAccount(); f.submit(path === '/' ? 'editor-form' : 'add-form'); await f.settle();
  assert.equal(f.db.raw.prepare("SELECT count(*) AS n FROM memories WHERE space_id='so'").get().n, 0,
    'The new cookie account must never commit a draft composed under the previous account');
  assert.equal(f.calls.findLast(call => call.method === 'POST').status, 409);
  assert.equal(path === '/' ? f.byId('memory-body').value : f.byId('add-form').elements.body.value, '');
  assert.doesNotMatch(f.w.document.body.textContent, /ALICE PRIVATE RESULT/);
  assert.match(path === '/' ? f.byId('welcome-error').textContent : f.byId('status').textContent, /계정/);
  f.submit(path === '/' ? 'editor-form' : 'add-form'); await f.settle();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1, 'The cleared UI cannot retry the old intent');
});

test('release root key dialog links to scoped PAT management and does not issue a broad key', async t => {
  const f = await browser(t, '/');
  f.db.raw.exec("UPDATE credentials SET reauthenticated_at=NULL WHERE id='session:alice'");
  f.byId('manage-keys').click();
  const link = f.byId('dialog-form').querySelector('a[href="/manage"]');
  assert.ok(link, 'An ordinary SSO session needs a path to recent verification and scoped PAT issuance');
  assert.match(f.byId('memory-dialog').textContent, /공간|저장소/);
  assert.equal(f.byId('dialog-form').querySelector('[name="permission"]'), null);
  f.submit('dialog-form'); await f.settle();
  assert.equal(f.calls.some(call => call.path === '/v1/keys' && call.method === 'POST'), false);
});

test('release root key metadata does not mislabel an append-only PAT as readable', async t => {
  const f = await browser(t, '/', async f => {
    await new Admin({ DB: f.db }, () => at).issueKey(f.token, { label: 'Append only', capabilities: ['create'], spaceIds: ['s1'], expiresInDays: 30 });
    return f.token;
  });
  f.byId('manage-keys').click();
  const row = [...f.byId('dialog-form').querySelectorAll('.key-row')].find(row => row.textContent.includes('Append only'));
  assert.ok(row);
  assert.doesNotMatch(row.textContent, /읽기/);
  assert.match(row.textContent, /발급 시 지정한 동작·공간 권한/);
});

test('expected account is checked on the resolved credential while headerless clients remain compatible', async t => {
  const f = await browser(t, '/');
  const request = (expected, bearer = false) => f.app(new Request(f.settings.origin + '/v1/spaces/so/memories', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: f.settings.origin,
      ...(bearer ? { authorization: 'Bearer ' + f.other } : { cookie: '__Host-memory_session=' + f.other }),
      ...(expected === undefined ? {} : { 'x-memory-account-id': expected }) },
    body: JSON.stringify({ body: 'new account intent' }),
  }));
  for (const bearer of [false, true]) {
    const denied = await request('alice', bearer);
    assert.equal(denied.status, 409); assert.deepEqual(await denied.json(), { error: 'account_mismatch' });
  }
  assert.equal((await request('bob')).status, 201);
  assert.equal((await request(undefined, true)).status, 201);
});

test('logout account intent cannot revoke a newly selected account session', async t => {
  const f = await browser(t, '/');
  const response = await f.app(new Request(f.settings.origin + '/auth/logout', {
    method: 'POST', headers: { origin: f.settings.origin, cookie: '__Host-memory_session=' + f.other,
      'x-memory-account-id': 'alice' },
  }));
  assert.equal(response.status, 409);
  assert.equal(f.db.raw.prepare("SELECT revoked_at FROM credentials WHERE id='session:bob'").get().revoked_at, null);
});

for (const path of ['/', '/manage']) test(`${path} attaches displayed-account intent to logout`, async t => {
  const f = await browser(t, path);
  f.switchAccount(); f.byId('logout').click(); await f.settle();
  assert.equal(f.calls.findLast(call => call.path === '/auth/logout').status, 409);
  assert.equal(f.db.raw.prepare("SELECT revoked_at FROM credentials WHERE id='session:bob'").get().revoked_at, null);
  assert.match(path === '/' ? f.byId('welcome-error').textContent : f.byId('status').textContent, /계정/);
});

test('management mints only a personal read PAT for an accepted organization Space share', async t => {
  const f = await browser(t, '/manage', async f => {
    f.db.raw.prepare('UPDATE memberships SET revoked_at=? WHERE id=?').run(at, 'm2');
    const transfers = new Transfers(f.db, () => at);
    const share = await transfers.share(f.token, 'so', 'bob@example.com');
    await transfers.accept(f.other, share.id); return f.other;
  });
  f.byId('space').value = 'so'; f.byId('space').dispatchEvent(new f.w.Event('change')); await f.settle();
  const form = f.byId('key-form'); form.elements.label.value = 'Shared team reader';
  assert.match(f.byId('pat-scope').textContent, /개인.*공유|공유.*개인/);
  assert.equal(form.elements.singleSpace.checked, true);
  assert.equal(form.elements.singleSpace.disabled, true);
  for (const checkbox of form.querySelectorAll('input[name="cap"]')) {
    assert.equal(checkbox.checked, checkbox.value === 'read');
    assert.equal(checkbox.disabled, true);
  }
  f.submit('key-form'); await f.settle();
  assert.equal(f.calls.findLast(call => call.path === '/v1/keys').status, 201);
  const key = f.db.raw.prepare("SELECT c.kind,c.account_id,p.capabilities,p.space_ids FROM credentials c JOIN release_credential_policies p ON p.credential_id=c.id WHERE c.account_id='bob' AND c.kind<>'session'").get();
  assert.deepEqual({ ...key }, { kind: 'personal_key', account_id: 'bob', capabilities: '["read"]', space_ids: '["so"]' });
});
test('a lost share response is recovered after page reload and its original grant is revoked',async t=>{
 let memory;const f=await browser(t,'/manage',async f=>{memory=await new MemoryStore(f.db,()=>at).create(f.token,'s1',{body:'Recover original grant'},'outbound-recovery-seed');return f.token;});
 let lost=false;f.intercept((path,init,response)=>{if(!lost&&path==='/v1/spaces/s1/shares'&&init.method==='POST'){lost=true;assert.equal(response.status,201);throw Error('Failed to fetch');}return response;});
 f.byId('share-form').elements.email.value='bob@example.com';f.submit('share-form');await f.settle();
 const stored=f.db.raw.prepare('SELECT id FROM release_shares').all();assert.equal(stored.length,1);assert.equal(f.calls.filter(c=>c.path==='/v1/spaces/s1/shares'&&c.method==='POST').length,1);
 assert.match(f.byId('status').textContent,/확인|알 수 없/);assert.match(f.byId('status').textContent,/보낸 공유/);
 const html=await(await f.app(new Request(f.settings.origin+'/manage'))).text(),dom=new JSDOM(html,{url:f.settings.origin+'/manage',runScripts:'outside-only'}),w=dom.window;t.after(()=>dom.window.close());
 w.fetch=f.w.fetch;w.TextEncoder=TextEncoder;w.confirm=()=>true;w.eval(managementScript);await f.settle();
 const byId=id=>w.document.getElementById(id);assert.equal(byId('receipt-list').children.length,0);
 byId('outbound-shares-refresh').click();await f.settle();assert.match(byId('outbound-shares').textContent,new RegExp(stored[0].id));
 await new Transfers(f.db,()=>at).accept(f.other,stored[0].id);assert.equal((await new MemoryStore(f.db,()=>at).get(f.other,'s1',memory.id)).body,'Recover original grant');
 const row=[...byId('outbound-shares').children].find(row=>row.dataset.shareId===stored[0].id);row.querySelector('button').click();await f.settle();
 assert.ok(f.db.raw.prepare('SELECT revoked_at FROM release_shares WHERE id=?').get(stored[0].id).revoked_at);await assert.rejects(()=>new MemoryStore(f.db,()=>at).get(f.other,'s1',memory.id),error=>error.status===403);
 assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_shares').get().n,1);
});

test('sent shares page incrementally and result-only clearing preserves the next page',async t=>{
 const f=await browser(t,'/manage',async f=>{const shares=new Transfers(f.db,()=>at);for(let i=0;i<26;i++)await shares.share(f.token,'s1','bob@example.com',7);return f.token;});
 assert.equal(f.calls.some(c=>c.path.startsWith('/v1/spaces/s1/shares?')),false,'Initial workspace does not eagerly download outgoing shares');
 f.byId('outbound-shares-refresh').click();await f.settle();assert.equal(f.byId('outbound-shares').children.length,25);assert.equal(f.byId('outbound-shares-more').hidden,false);
 f.byId('clear-result').click();assert.equal(f.byId('outbound-shares-more').hidden,false);f.byId('outbound-shares-more').click();await f.settle();
 assert.equal(f.byId('outbound-shares').children.length,26);assert.equal(new Set([...f.byId('outbound-shares').children].map(row=>row.dataset.shareId)).size,26);assert.equal(f.byId('outbound-shares-more').hidden,true);
 assert.equal(f.calls.filter(c=>c.path.startsWith('/v1/spaces/s1/shares?')).length,2);
});

test('a lost revoke response remains unknown until a sent-share refresh confirms revocation',async t=>{
 let share;const f=await browser(t,'/manage',async f=>{share=await new Transfers(f.db,()=>at).share(f.token,'s1','bob@example.com',7);return f.token;});
 f.byId('outbound-shares-refresh').click();await f.settle();f.intercept((path,init,response)=>{if(path==='/v1/spaces/s1/shares/'+share.id&&init.method==='DELETE'){assert.equal(response.status,204);throw Error('Failed to fetch');}return response;});
 f.byId('outbound-shares').querySelector('button').click();await f.settle();assert.match(f.byId('status').textContent,/확인|알 수 없/);assert.notEqual(f.byId('status').textContent,'완료');
 f.byId('outbound-shares-refresh').click();await f.settle();assert.match(f.byId('outbound-shares').textContent,/회수/);assert.ok(f.db.raw.prepare('SELECT revoked_at FROM release_shares WHERE id=?').get(share.id).revoked_at);
});

test('sent-share inspection survives stale recent proof while row revocation requires renewed proof',async t=>{
 let share;const f=await browser(t,'/manage',async f=>{share=await new Transfers(f.db,()=>at).share(f.token,'s1','bob@example.com',7);f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-300001);return f.token;});
 f.byId('outbound-shares-refresh').click();await f.settle();assert.match(f.byId('outbound-shares').textContent,new RegExp(share.id));
 f.byId('outbound-shares').querySelector('button').click();await f.settle();assert.match(f.byId('status').textContent,/recent_reauthentication_required/);assert.equal(f.db.raw.prepare('SELECT revoked_at FROM release_shares WHERE id=?').get(share.id).revoked_at,null);assert.ok(f.byId('outbound-shares').querySelector('button'));
 f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at);f.byId('outbound-shares').querySelector('button').click();await f.settle();assert.match(f.byId('outbound-shares').textContent,/회수를 완료/);assert.equal(f.byId('outbound-shares').querySelector('button'),null);
});

test('sent shares show newest-first stored history including expired and revoked grants',async t=>{
 let older,newer;const f=await browser(t,'/manage',async f=>{const earlier=at-86400001;f.db.setClock(()=>earlier);f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(earlier);older=await new Transfers(f.db,()=>earlier).share(f.token,'s1','bob@example.com',1);f.db.setClock(()=>at);f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at);const shares=new Transfers(f.db,()=>at);newer=await shares.share(f.token,'s1','bob@example.com',7);await shares.revoke(f.token,'s1',newer.id);return f.token;});
 f.byId('outbound-shares-refresh').click();await f.settle();const rows=[...f.byId('outbound-shares').children];assert.deepEqual(rows.map(row=>row.dataset.shareId),[newer.id,older.id]);assert.match(rows[0].textContent,/회수된 공유/);assert.match(rows[1].textContent,new RegExp(new Date(at-1).toISOString()));assert.doesNotMatch(f.byId('outbound-shares').textContent,/활성|현재 접근 가능/);
});

for(const [kind,outcome]of [['organization','network'],['organization','invalid-json'],['organization','body-read'],['organization','500'],['space','network']])test('root '+kind+' creation reports an uncertain '+outcome+' outcome before any repeat',async t=>{
 const f=await browser(t,'/'),route=kind==='organization'?'/v1/organizations':'/v1/spaces',name='Response loss '+kind+' '+outcome;
 f.intercept((path,init,response)=>{
  if(path!==route||init.method!=='POST')return response;assert.equal(response.status,201);
  if(outcome==='network')throw Error('Failed to fetch');
  if(outcome==='invalid-json')return new Response('{invalid',{status:201});
  if(outcome==='body-read')return new Response(new ReadableStream({start(controller){controller.error(Error('Response body lost'));}}),{status:201});
  return new Response('{"error":"receipt_read_failed"}',{status:500});
 });
 f.byId(kind==='organization'?'new-organization':'new-space').click();f.byId('field-name').value=name;f.submit('dialog-form');await f.settle();
 const query=kind==='organization'?'SELECT count(*) n FROM workspace_organization_creations c JOIN organizations o ON o.id=c.id WHERE c.name=?':'SELECT count(*) n FROM spaces WHERE name=?';assert.equal(f.db.raw.prepare(query).get(name).n,1);
 assert.equal(f.calls.filter(call=>call.path===route&&call.method==='POST').length,1);assert.equal(f.byId('field-name').value,name);
 const guidance=f.byId('dialog-error').textContent;assert.match(guidance,/결과.*확인|반영.*확인|처리.*확인/);assert.match(guidance,/새로고침/);assert.match(guidance,/다시.*전에|먼저.*확인/);assert.doesNotMatch(guidance,/요청을 완료하지 못했어요/);
 // A successful workspace read exposes the committed resource; repeating POST
 // is unnecessary and would create another organization/Space.
 const headers={cookie:'__Host-memory_session='+f.token,'X-Memory-Account-Id':'alice'},workspace=await(await f.app(new Request(f.settings.origin+'/v1/workspace',{headers}))).json();
 assert.ok((kind==='organization'?workspace.organizations:workspace.spaces).some(item=>item.name===name));
});

test('root confirmed organization validation failure retains its ordinary input guidance',async t=>{
 const f=await browser(t,'/');f.byId('new-organization').click();f.byId('field-name').value='';f.submit('dialog-form');await f.settle();assert.equal(f.calls.findLast(call=>call.method==='POST').status,400);assert.match(f.byId('dialog-error').textContent,/입력 내용/);assert.doesNotMatch(f.byId('dialog-error').textContent,/이미.*생성|중복/);
});

test('root GET transport failure still offers ordinary read retry guidance',async t=>{
 const f=await browser(t,'/');f.intercept((path,init,response)=>{if(path.includes('/memories?query='))throw Error('Read response lost');return response;});f.byId('search-query').value='probe';f.submit('search-form');await f.settle();assert.match(f.byId('app-error').textContent,/다시 시도/);assert.doesNotMatch(f.byId('app-error').textContent,/이미 적용|생성되었을/);
});

test('root a committed memory write followed by500 preserves its operation for retry',async t=>{
 const f=await browser(t,'/');let lost=false;f.intercept((path,init,response)=>{if(!lost&&path==='/v1/spaces/s1/memories'&&init.method==='POST'){lost=true;assert.equal(response.status,201);return new Response('{"error":"receipt_read_failed"}',{status:500});}return response;});
 f.byId('new-memory').click();f.byId('memory-body').value='Committed memory despite500';f.byId('memory-body').dispatchEvent(new f.w.Event('input'));f.submit('editor-form');await f.settle();assert.match(f.byId('app-error').textContent,/작업 결과.*확인/);assert.match(f.byId('app-error').textContent,/현재 작업 ID/);assert.equal(f.byId('memory-body').value,'Committed memory despite500');
 f.submit('editor-form');await f.settle();const writes=f.calls.filter(call=>call.path==='/v1/spaces/s1/memories'&&call.method==='POST');assert.equal(writes.length,2);assert.equal(writes[0].data.operationId,writes[1].data.operationId);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM memories WHERE body=?').get('Committed memory despite500').n,1);
});

for(const days of [30,31])test('management disables restoration after '+days+' days using server retention metadata',async t=>{
 const f=await browser(t,'/manage',async f=>{const earlier=at-days*86400000;f.db.setClock(()=>earlier);const store=new MemoryStore(f.db,()=>earlier),memory=await store.create(f.token,'s1',{body:'Retained expired trash'},'expired-ui-seed');await store.remove(f.token,'s1',memory.id,1,'expired-ui-delete');f.db.setClock(()=>at);return f.token;});
 f.byId('trash').click();await f.settle();const button=[...f.byId('memories').querySelectorAll('button')].find(button=>button.textContent==='복원');assert.ok(button);assert.equal(button.disabled,true);const description=f.byId(button.getAttribute('aria-describedby'));assert.match(description.textContent,/복원 기간.*지나|복원 기한.*지나/);button.click();await f.settle();assert.equal(f.calls.some(call=>call.path.endsWith('/restore')),false);assert.match(f.byId('memories').textContent,/Retained expired trash/);
});

test('management explains a restore deadline shortened after its trash list was loaded',async t=>{
 const f=await browser(t,'/manage',async f=>{const earlier=at-2*86400000;f.db.setClock(()=>earlier);const store=new MemoryStore(f.db,()=>earlier),memory=await store.create(f.token,'s1',{body:'Retention changed'},'changed-retention-seed');await store.remove(f.token,'s1',memory.id,1,'changed-retention-delete');f.db.setClock(()=>at);return f.token;});
 f.byId('trash').click();await f.settle();const button=[...f.byId('memories').querySelectorAll('button')].find(button=>button.textContent==='복원');assert.equal(button.disabled,false);await new MemoryStore(f.db,()=>at).retention(f.token,'s1',1);button.click();await f.settle();
 assert.equal(f.calls.findLast(call=>call.path.endsWith('/restore')).status,409);assert.match(f.byId('status').textContent,/복원 기간.*지나|복원 기한.*지나/);assert.doesNotMatch(f.byId('status').textContent,/revision_conflict/);assert.equal(button.disabled,true);assert.match(f.byId(button.getAttribute('aria-describedby')).textContent,/복원/);
});

for(const mutation of ['approve','cancel'])for(const refreshed of ['displayed','pending-detail'])test('ingest '+mutation+' reconciles the current '+refreshed+' refresh after commit',async t=>{
 const variables={BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,5).toString('base64url'),AI:{run:async()=>({response:{memories:[{body:'Approved fact',kind:'fact',sourceMessageId:'m1',quote:'PRIVATE SOURCE QUOTE'}]}})}};
 const f=await browser(t,'/manage',null,variables),ingest=new Ingest({DB:f.db,...variables},()=>at),jobs=new Jobs({DB:f.db,...variables},()=>at);jobs.ingest=job=>ingest.process(job);const started=await ingest.submit(f.token,'s1',{messages:[{id:'m1',role:'user',content:'PRIVATE SOURCE QUOTE'}]},'refresh-mutation-seed');await jobs.drain(1);
 f.byId('ingests').click();await f.settle();const old=f.byId('proposals').firstElementChild;
 let releaseMutation,reachedMutation,releaseDetail,reachedDetail;const heldMutation=new Promise(r=>releaseMutation=r),waitingMutation=new Promise(r=>reachedMutation=r),heldDetail=new Promise(r=>releaseDetail=r),waitingDetail=new Promise(r=>reachedDetail=r);
 f.beforeRequest(async(path,init)=>{if(path.includes(started.id)&&init.method===(mutation==='approve'?'POST':'DELETE')){reachedMutation();await heldMutation;}});
 if(refreshed==='pending-detail')f.intercept(async(path,init,response)=>{if(path.endsWith('/ingests/'+started.id)&&init.method==='GET'){reachedDetail();await heldDetail;}return response;});
 [...old.querySelectorAll('button')].find(button=>button.textContent.includes(mutation==='approve'?'승인':'취소')).click();await waitingMutation;f.byId('ingests').click();
 try{if(refreshed==='pending-detail')await waitingDetail;else{for(let i=0;i<100&&(!f.byId('proposals').firstElementChild||f.byId('proposals').firstElementChild===old);i++)await new Promise(r=>setTimeout(r,5));assert.notEqual(f.byId('proposals').firstElementChild,old);}releaseMutation();for(let i=0;i<100&&f.db.raw.prepare('SELECT state FROM release_ingests WHERE id=?').get(started.id).state==='review';i++)await new Promise(r=>setTimeout(r,5));}finally{releaseMutation();releaseDetail();}await f.settle();
 assert.equal(f.db.raw.prepare('SELECT state FROM release_ingests WHERE id=?').get(started.id).state,mutation==='approve'?'approved':'cancelled');assert.match(f.byId('proposals').textContent,mutation==='approve'?/approved|승인 완료/:/cancelled|취소 완료/);assert.doesNotMatch(f.byId('proposals').textContent,/PRIVATE SOURCE QUOTE|review/);assert.equal(f.byId('proposals').querySelectorAll('button').length,0);assert.equal(f.byId('proposals').children.length,1);
 if(mutation==='approve'){const memory=f.db.raw.prepare('SELECT id FROM memories').get();assert.ok(f.byId('mutation-receipts').textContent.includes(memory.id));}
});

for(const method of ['POST','DELETE'])for(const failure of ['network','body-read','500','malformed-500'])test('share '+method+' committed with '+failure+' remains recoverable through outgoing inspection',async t=>{
 let grant;const f=await browser(t,'/manage',async f=>{if(method==='DELETE')grant=await new Transfers(f.db,()=>at).share(f.token,'s1','bob@example.com',7);return f.token;});
 let lost=false;f.intercept((path,init,response)=>{if(lost||init.method!==method||!path.startsWith('/v1/spaces/s1/shares'))return response;lost=true;assert.equal(response.status,method==='POST'?201:204);if(failure==='network')throw Error('Response lost');if(failure==='body-read')return new Response(new ReadableStream({start(controller){controller.error(Error('Body lost'));}}),{status:200});return new Response(failure==='500'?'{"error":"internal_error"}':'{invalid',{status:500});});
 if(method==='POST'){f.byId('share-form').elements.email.value='bob@example.com';f.submit('share-form');}else{f.byId('share-revoke').elements.shareId.value=grant.id;f.submit('share-revoke');}await f.settle();const row=f.db.raw.prepare('SELECT id,revoked_at FROM release_shares').get();assert.ok(row);assert.equal(Boolean(row.revoked_at),method==='DELETE');assert.match(f.byId('status').textContent,/결과.*확인/);assert.match(f.byId('status').textContent,/보낸 공유/);assert.notEqual(f.byId('status').textContent,'완료');
 f.byId('outbound-shares-refresh').click();await f.settle();assert.ok(f.byId('outbound-shares').textContent.includes(row.id));if(method==='POST'){f.byId('outbound-shares').querySelector('button').click();await f.settle();assert.ok(f.db.raw.prepare('SELECT revoked_at FROM release_shares').get().revoked_at);}else assert.match(f.byId('outbound-shares').textContent,/회수된 공유/);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_shares').get().n,1);assert.equal(f.calls.filter(call=>call.method==='POST'&&call.path==='/v1/spaces/s1/shares').length,method==='POST'?1:0);
});

test('release root search accepts an API-valid309-character query without a256-character input cap',async t=>{
 const query=Array.from({length:10},(_,i)=>String.fromCharCode(97+i).repeat(30)).join(' '),f=await browser(t,'/',async f=>{await new MemoryStore(f.db,()=>at).create(f.token,'s1',{body:query},'long-search-seed');return f.token;});assert.equal(query.length,309);assert.equal(f.byId('search-query').maxLength,1024);f.byId('search-query').value=query;f.submit('search-form');await f.settle();assert.equal(f.calls.findLast(call=>call.path.includes('/memories?query=')).status,200);assert.equal(new URL(f.calls.findLast(call=>call.path.includes('/memories?query=')).path,f.settings.origin).searchParams.get('query'),query);assert.equal(f.byId('app-error').hidden,true);
});

for(const mutation of ['approve','cancel'])for(const transition of ['space','account'])test('completed ingest '+mutation+' cannot refill a different '+transition+' workspace',async t=>{
 const variables={BACKGROUND_JOBS_ENABLED:'true',PAYLOAD_KEY:Buffer.alloc(32,6).toString('base64url'),AI:{run:async()=>({response:{memories:[{body:'Private extraction',kind:'fact',sourceMessageId:'m1',quote:'PRIVATE EXTRACTED SOURCE'}]}})}},f=await browser(t,'/manage',null,variables),ingest=new Ingest({DB:f.db,...variables},()=>at),jobs=new Jobs({DB:f.db,...variables},()=>at);jobs.ingest=job=>ingest.process(job);const started=await ingest.submit(f.token,'s1',{messages:[{id:'m1',role:'user',content:'PRIVATE EXTRACTED SOURCE'}]},'fenced-ingest');await jobs.drain(1);f.byId('ingests').click();await f.settle();
 let release,reached;const held=new Promise(r=>release=r),waiting=new Promise(r=>reached=r);f.beforeRequest(async(path,init)=>{if(path.includes(started.id)&&init.method===(mutation==='approve'?'POST':'DELETE')){reached();await held;}});[...f.byId('proposals').querySelectorAll('button')].find(button=>button.textContent.includes(mutation==='approve'?'승인':'취소')).click();await waiting;
 try{if(transition==='space'){f.byId('space').value='so';f.byId('space').dispatchEvent(new f.w.Event('change'));}else{f.switchAccount();f.byId('reload').click();}for(let i=0;i<100&&(transition==='space'?f.byId('space').value!=='so':!f.byId('email-select').textContent.includes('bob@example.com'));i++)await new Promise(r=>setTimeout(r,5));}finally{release();}await f.settle();assert.equal(f.byId('proposals').children.length,0);assert.doesNotMatch(f.byId('proposals').textContent,/PRIVATE EXTRACTED SOURCE|Private extraction/);if(transition==='account')assert.equal(f.byId('receipt-list').children.length,0);else if(mutation==='approve')assert.match(f.byId('mutation-receipts').textContent,/s1/);
});

for(const status of [401,403])test('share mutation preserves a definitive'+status+' boundary when its body cannot be read',async t=>{
 const f=await browser(t,'/manage');f.byId('add-form').elements.body.value='Keep draft on expiry';f.db.raw.prepare(status===401?"UPDATE credentials SET expires_at=? WHERE id='session:alice'":"UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(status===401?at:at-300001);
 f.intercept((path,init,response)=>{if(path==='/v1/spaces/s1/shares'&&init.method==='POST'){assert.equal(response.status,status===401?401:403);return new Response(new ReadableStream({start(controller){controller.error(Error('Unreadable error body'));}}),{status});}return response;});f.byId('share-form').elements.email.value='bob@example.com';f.submit('share-form');await f.settle();assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_shares').get().n,0);assert.doesNotMatch(f.byId('status').textContent,/보낸 공유 새로고침/);assert.equal(f.byId('reauth-actions').hidden,status!==401);assert.equal(f.byId('add-form').elements.body.value,'Keep draft on expiry');
});

test('an older outgoing snapshot cannot undo a confirmed revocation and a fresh read supplies its stored timestamp',async t=>{
 let share;const f=await browser(t,'/manage',async f=>{share=await new Transfers(f.db,()=>at).share(f.token,'s1','bob@example.com',7);return f.token;});
 f.byId('outbound-shares-refresh').click();await f.settle();
 let release,reached,hold=true;const held=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>reached=resolve);
 f.intercept(async(path,init,response)=>{if(hold&&path.startsWith('/v1/spaces/s1/shares?')){hold=false;assert.equal(response.status,200);assert.equal((await response.clone().json()).results[0].revokedAt,null);reached();await held;}return response;});
 f.byId('outbound-shares-refresh').click();await waiting;
 try{f.byId('outbound-shares').querySelector('button').click();for(let i=0;i<200&&!f.byId('outbound-shares').querySelector('.revoke-confirmation');i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(f.byId('outbound-shares').querySelector('.revoke-confirmation'));assert.equal(f.db.raw.prepare('SELECT revoked_at FROM release_shares WHERE id=?').get(share.id).revoked_at,at);}finally{release();}await f.settle();
 assert.equal(f.byId('outbound-shares').querySelectorAll('button').length,0);assert.doesNotMatch(f.byId('outbound-shares').textContent,/회수 기록 없음/);assert.match(f.byId('outbound-shares').textContent,/회수/);
 f.byId('outbound-shares-refresh').click();await f.settle();assert.match(f.byId('outbound-shares').textContent,new RegExp('회수 '+new Date(at).toISOString().replaceAll('.','\\.')));assert.equal(f.byId('outbound-shares').querySelectorAll('button').length,0);
});

for(const newerBody of ['Newer unsaved edit','First committed edit'])test('an older edit completion preserves a newer failed edit through retry and session-expiry recovery: '+newerBody,async t=>{
 let memory;const f=await browser(t,'/manage',async f=>{memory=await new MemoryStore(f.db,()=>at).create(f.token,'s1',{body:'Original body'},'edit-ownership-seed');return f.token;});
 let release,reached,hold=true,failNext=false;const held=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>reached=resolve),edit=()=>[...f.byId('memories').querySelectorAll('button')].find(button=>button.textContent==='수정');
 f.intercept(async(path,init,response)=>{if(hold&&init.method==='PATCH'){hold=false;assert.equal(response.status,200);reached();await held;}return response;});
 f.beforeRequest((path,init)=>{if(failNext&&init.method==='PATCH'){failNext=false;throw Error('Newer edit transport failed');}});
 f.w.prompt=()=> 'First committed edit';const originalCard=f.byId('memories').firstElementChild;edit().click();await waiting;
 try{f.byId('refresh-memories').click();for(let i=0;i<200&&(!f.byId('memories').firstElementChild||f.byId('memories').firstElementChild===originalCard);i++)await new Promise(resolve=>setTimeout(resolve,5));assert.notEqual(f.byId('memories').firstElementChild,originalCard);failNext=true;f.w.prompt=()=> newerBody;edit().click();for(let i=0;i<200&&!f.byId('status').textContent.includes('Newer edit transport failed');i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.byId('memories').querySelector('.edit-draft textarea').value,newerBody);assert.match(f.byId('status').textContent,/Newer edit transport failed/);}finally{release();}await f.settle();
 assert.equal(f.db.raw.prepare('SELECT body FROM memories WHERE id=?').get(memory.id).body,'First committed edit');assert.equal(f.byId('memories').querySelector('.edit-draft textarea')?.value,newerBody);
 let retryBody;f.w.prompt=(label,value)=>{retryBody=value;return null;};edit().click();await f.settle();assert.equal(retryBody,newerBody);
 f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);f.byId('usage').click();await f.settle();assert.equal(f.byId('reauth-actions').hidden,false);assert.ok(JSON.parse(f.byId('recovery-text').textContent).edits.some(([,draft])=>draft.body===newerBody&&draft.expectedRevision===2));
});

test('a delayed receipt-only edit preserves its submitted copy separately from a newer failed edit',async t=>{
 let memory;const f=await browser(t,'/manage',async f=>{memory=await new MemoryStore(f.db,()=>at).create(f.token,'s1',{body:'Original erased body'},'overlapping-receipt-seed');return f.token;});
 let release,reached,hold=true,failNext=false;const held=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>reached=resolve),edit=()=>[...f.byId('memories').querySelectorAll('button')].find(button=>button.textContent==='수정');
 f.beforeRequest(async(path,init)=>{if(init.method!=='PATCH')return;if(hold){hold=false;reached();await held;}else if(failNext){failNext=false;throw Error('Newer receipt draft request failed');}});
 f.w.prompt=()=> 'Original submitted copy';const originalCard=f.byId('memories').firstElementChild;edit().click();await waiting;
 try{
  f.byId('refresh-memories').click();for(let i=0;i<200&&(!f.byId('memories').firstElementChild||f.byId('memories').firstElementChild===originalCard);i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(edit());
  failNext=true;f.w.prompt=()=> 'Newer failed receipt draft';edit().click();for(let i=0;i<200&&!f.byId('status').textContent.includes('Newer receipt draft request failed');i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.byId('memories').querySelector('.edit-draft textarea')?.value,'Newer failed receipt draft');
  // Erasure between the real update commit and its follow-up read makes the
  // HTTP handler return its actual body-free receipt, without a mocked body.
  const prepare=f.db.prepare.bind(f.db);let eraseBeforeRead=true;f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('FROM memories r JOIN spaces s')&&sql.includes('AND r.id=?')){const first=statement.first;statement.first=async function(){if(eraseBeforeRead){eraseBeforeRead=false;const stored=f.db.raw.prepare('SELECT revision FROM memories WHERE id=?').get(memory.id);assert.equal(stored.revision,2);const store=new MemoryStore(f.db,()=>at);await store.remove(f.token,'s1',memory.id,2,'overlapping-receipt-remove');await store.erase(f.token,'s1',memory.id,3,memory.id,'overlapping-receipt-erase');}return first.call(this);};}return statement;};
  f.intercept(async(path,init,response)=>{if(init.method==='PATCH'){assert.equal(response.status,200);assert.equal((await response.clone().json()).representation,'receipt');}return response;});
 }finally{release();}await f.settle();
 const copies=JSON.parse(f.byId('recovery-text').textContent.slice(f.byId('recovery-text').textContent.indexOf('{'))).edits;assert.ok(copies.some(([,draft])=>draft.body==='Newer failed receipt draft'&&!draft.receipt));assert.ok(copies.some(([,draft])=>draft.body==='Original submitted copy'&&draft.receipt));
 f.db.raw.prepare("UPDATE credentials SET expires_at=? WHERE id='session:alice'").run(at);f.byId('usage').click();await f.settle();assert.match(f.byId('recovery-text').textContent,/Newer failed receipt draft/);assert.match(f.byId('recovery-text').textContent,/Original submitted copy/);
});

for(const transition of ['space','account'])test('a delayed outgoing snapshot cannot refill a different '+transition+' after revocation',async t=>{
 const f=await browser(t,'/manage',async f=>{await new Transfers(f.db,()=>at).share(f.token,'s1','bob@example.com',7);return f.token;});f.byId('outbound-shares-refresh').click();await f.settle();
 let release,reached,hold=true;const held=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>reached=resolve);f.intercept(async(path,init,response)=>{if(hold&&path.startsWith('/v1/spaces/s1/shares?')){hold=false;reached();await held;}return response;});f.byId('outbound-shares-refresh').click();await waiting;
 try{f.byId('outbound-shares').querySelector('button').click();for(let i=0;i<200&&!f.byId('outbound-shares').querySelector('.revoke-confirmation');i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(f.byId('outbound-shares').querySelector('.revoke-confirmation'));if(transition==='space'){f.byId('space').value='so';f.byId('space').dispatchEvent(new f.w.Event('change'));}else{f.switchAccount();f.byId('reload').click();}for(let i=0;i<200&&(transition==='space'?f.byId('space').value!=='so':!f.byId('email-select').textContent.includes('bob@example.com'));i++)await new Promise(resolve=>setTimeout(resolve,5));}finally{release();}await f.settle();assert.equal(f.byId('outbound-shares').children.length,0);
});

for(const buttonId of ['scim-key','export','portal'])test(buttonId+' allows only one pending issuance despite control updates and unrelated reads',async t=>{
 let providerSessions=0;const variables=buttonId==='portal'?{BACKGROUND_JOBS_ENABLED:'true',STRIPE_SECRET_KEY:'synthetic',STRIPE_WEBHOOK_SECRET:'w'.repeat(64),STRIPE_API_VERSION:'synthetic',BILLING_PRICES_JSON:JSON.stringify({price_test:{plan:'team',monthlyUnits:10000,storageBytes:1048576000}}),fetch:async url=>{assert.ok(String(url).endsWith('/billing_portal/sessions'));return Response.json({url:'https://billing.stripe.com/p/session/'+(++providerSessions)});}}:{};
 const f=await browser(t,'/manage',async f=>{if(buttonId==='portal')f.db.raw.prepare("UPDATE release_pools SET customer_id='cus_test' WHERE id='account:alice'").run();return f.token;},variables),route=buttonId==='scim-key'?'/v1/organizations/org/scim-keys':buttonId==='portal'?'/v1/spaces/s1/billing/portal':'/v1/spaces/s1/exports';
 f.byId('organization').value='org';f.byId('organization').dispatchEvent(new f.w.Event('change'));f.w.URL.createObjectURL=()=> 'blob:synthetic-export';f.w.URL.revokeObjectURL=()=>{};f.w.HTMLAnchorElement.prototype.click=()=>{};
 let release,reached,reachedSecond,attempts=0,responses=0;const held=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>reached=resolve),second=new Promise(resolve=>reachedSecond=resolve);f.beforeRequest((path,init)=>{if(path===route&&init.method==='POST')attempts++;});
 f.intercept(async(path,init,response)=>{if(path===route&&init.method==='POST'){assert.equal(response.status,buttonId==='portal'?200:201);responses++;if(responses===1)reached();else reachedSecond();await held;}return response;});
 const button=f.byId(buttonId);button.click();await waiting;let disabledWhilePending;
 try{f.byId('organization').dispatchEvent(new f.w.Event('change'));f.byId('usage').click();for(let i=0;i<200&&!f.calls.some(call=>call.path.endsWith('/usage'));i++)await new Promise(resolve=>setTimeout(resolve,5));disabledWhilePending=button.disabled;button.click();await new Promise(resolve=>setImmediate(resolve));if(attempts>1)await second;if(buttonId==='portal'){f.byId('space').value='so';f.byId('space').dispatchEvent(new f.w.Event('change'));}}finally{release();}await f.settle();
 const issued=buttonId==='portal'?providerSessions:f.db.raw.prepare('SELECT count(*) n FROM '+(buttonId==='scim-key'?'release_scim_keys':'release_export_sessions')).get().n;t.diagnostic(JSON.stringify({buttonId,attempts,issued,disabledWhilePending,receipts:f.byId('receipt-list').children.length}));assert.equal(attempts,1);assert.equal(issued,1);assert.equal(disabledWhilePending,true);assert.equal(button.disabled,false);assert.ok(f.byId('receipt-list').children.length>=1);
 if(buttonId==='scim-key')assert.match(f.byId('mutation-receipts').textContent,/org.*SCIM/);
});

for(const failure of ['network','403'])test('SCIM issuance unlocks after '+failure+' and permits an explicit successful retry',async t=>{
 const f=await browser(t,'/manage');f.byId('organization').value='org';f.byId('organization').dispatchEvent(new f.w.Event('change'));const button=f.byId('scim-key');let release,reached,hold=true;const held=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>reached=resolve);
 f.beforeRequest(async(path,init)=>{if(hold&&path.endsWith('/scim-keys')&&init.method==='POST'){hold=false;reached();await held;if(failure==='network')throw Error('SCIM connection failed');}});if(failure==='403')f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at-300001);
 button.click();await waiting;try{assert.equal(button.disabled,true);}finally{release();}await f.settle();assert.equal(button.disabled,false);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_scim_keys').get().n,0);f.db.raw.prepare("UPDATE credentials SET reauthenticated_at=? WHERE id='session:alice'").run(at);button.click();await f.settle();assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_scim_keys').get().n,1);assert.equal(button.disabled,false);assert.equal(f.byId('receipt-list').children.length,1);
});

for(const transition of ['organization','account'])test('pending SCIM issuance keeps its original '+transition+' binding and unlocks current controls',async t=>{
 const f=await browser(t,'/manage');f.byId('organization').value='org';f.byId('organization').dispatchEvent(new f.w.Event('change'));const button=f.byId('scim-key');let release,reached,secret,hold=true;const held=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>reached=resolve);f.intercept(async(path,init,response)=>{if(hold&&path.endsWith('/scim-keys')&&init.method==='POST'){hold=false;assert.equal(response.status,201);secret=(await response.clone().json()).token;reached();await held;}return response;});button.click();await waiting;
 try{if(transition==='organization'){f.byId('organization').value='';f.byId('organization').dispatchEvent(new f.w.Event('change'));}else{f.switchAccount();f.byId('reload').click();for(let i=0;i<200&&!f.byId('email-select').textContent.includes('bob@example.com');i++)await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(button.disabled,true);}finally{release();}await f.settle();assert.equal(button.disabled,true);assert.equal(f.w.document.body.textContent.includes(secret),transition==='organization');
 f.byId('organization').value='org';f.byId('organization').dispatchEvent(new f.w.Event('change'));assert.equal(button.disabled,false);if(transition==='organization'){button.click();await f.settle();assert.equal(f.byId('receipt-list').children.length,2);assert.ok(f.w.document.body.textContent.includes(secret));}
});
