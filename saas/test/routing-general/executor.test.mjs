import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createGeneralExecutor, reconcileGeneralRetirements } from '../../src/routing/general-executor.ts';
import { GeneralSpaceLedger } from '../../src/routing/general-ledger.ts';
import { RoutingBudgetLedger } from '../../src/routing/budget-ledger.ts';

const now=Date.now();
export const policy={version:1,revision:'test-v1',validUntilMs:now+86400000,maxMonthlyRequests:100,
  maxMonthlyInputBytes:1000000,maxMonthlyReservedMicroUsd:1000000,ingestBaseMicroUsd:100,
  ingestMicroUsdPerKiB:10,searchBaseMicroUsd:100,searchMicroUsdPerKiB:10,pricingBasis:'operator-upper-bound'};
function fixture(overrides={}) {
  const events=[], calls=[];
  const authority={spaceId:'space-a',owner:{kind:'organization',id:'org-a'},accountId:'account-a',credentialId:'key-a',authorityExpiresAtMs:now+60000};
  const ticket={id:'ticket-a',operationId:'operation-a',operation:'memory_ingest',generation:1,state:'admitted',createdAtMs:now,expiresAtMs:now+60000,dispatch:true};
  const ledger={
    async admit(input){events.push('admit');return {...ticket,operation:input.operation,operationId:input.operationId};},
    async check(input){events.push(input.phase);},
    async finalize(input){events.push('space:'+input.state);},
    async retire(){events.push('retire');return {id:'retire-a',generation:1,nextGeneration:2,createdAtMs:now,state:'pending',dispatch:true,logicallyHidden:true,physicalPurgeVerified:false};},
    async pending(){return [];},
    async finishRetirement(input){events.push('retired:'+input.state);},
    async usage(){events.push('usage');return {generation:1,month:'2026-09'};},...overrides.ledger};
  const budget={async reserve(input){events.push('reserve');calls.push({kind:'budget',input});return {reservationId:input.reservationId,month:'2026-09',reservedMicroUsd:110,expiresAtMs:now+50000,replayed:false};},
    async finalize(input){events.push('budget:'+input.state);},async usage(){return {};},...overrides.budget};
  const provider={async ingest(...args){events.push('ingest');calls.push({kind:'ingest',args});},
    async recall(...args){events.push('recall');calls.push({kind:'recall',args});return {answer:'private-answer',candidates:[],count:0};},
    async deleteProfile(...args){events.push('delete');calls.push({kind:'delete',args});},...overrides.provider};
  const execute=createGeneralExecutor({clock:()=>now,allowedSpaceIds:['space-a'],seoulSpaceIds:[],
    providerIdentity:{accountId:'a'.repeat(32),namespace:'memory-test'},
    async authority(_token,spaceId,operation){events.push('authority');return {...authority,spaceId,operation};},
    ledger:()=>ledger,budgetId:'test-budget',budgetPolicy:policy,budget,provider,...overrides.ports});
  const input={spaceId:'space-a',routing:{version:1,classification:'general'},operationId:'operation-a',messages:[{role:'user',content:'synthetic'}]};
  return {execute,input,events,calls,ticket};
}
function durableLedgers(t) {
  const storage=()=>{
    const db=new DatabaseSync(':memory:');t.after(()=>db.close());
    return {db,sql:{exec(sql,...values){if(!values.length&&sql.includes(';')){db.exec(sql);return {toArray:()=>[]};}
      return {toArray:()=>db.prepare(sql).all(...values)};}},transactionSync(run){db.exec('BEGIN');try{const result=run();db.exec('COMMIT');return result;}
      catch(error){db.exec('ROLLBACK');throw error;}}};
  };
  const spaceStorage=storage(),budgetStorage=storage();
  const space=new GeneralSpaceLedger(spaceStorage,{now:()=>now,objectName:'space:space-a'});space.initialize();
  const budget=new RoutingBudgetLedger(budgetStorage,{now:()=>now,objectName:'budget:test-budget'});budget.initialize();
  return {space,budget,spaceDb:spaceStorage.db,budgetDb:budgetStorage.db};
}

test('general managed recall rejects explicit modes before authority, budget or provider dispatch',async()=>{
  for(const mode of ['keyword','semantic']) {
    const f=fixture();
    const result=await f.execute('memory_search',{spaceId:'space-a',routing:{version:1,classification:'general'},query:'private query',mode},'token');
    assert.equal(result.ok,false);assert.equal(result.body.error,'routing_search_mode_unavailable');
    assert.deepEqual(f.events,[]);assert.deepEqual(f.calls,[]);
  }
});
test('general writes reserve global budget after durable admission and recheck before dispatch/disclosure',async()=>{
  const f=fixture(),r=await f.execute('memory_ingest',f.input,'token');assert.equal(r.ok,true);
  assert.deepEqual(f.events,['authority','admit','reserve','authority','dispatch','ingest','space:accepted','budget:accepted','authority','disclose']);
  const write=f.calls.find(c=>c.kind==='ingest');assert.match(write.args[0],/^general-[a-f0-9]{64}$/);
  assert.equal(write.args[3].deadlineMs,now+15000);assert.equal(f.calls[0].input.usage.inputBytes,9);
});
test('replay returns only operation metadata and never reserves or dispatches again',async()=>{
  const f=fixture({ledger:{async admit(){return {id:'ticket-a',operationId:'operation-a',state:'accepted',dispatch:false};}}});
  const r=await f.execute('memory_ingest',f.input,'token');assert.equal(r.body.replayed,true);assert.equal(f.calls.length,0);
});
test('budget rejection durably closes undispatched admission without raw diagnostic disclosure',async()=>{
  const f=fixture({budget:{async reserve(){throw new Error('secret-token raw input');}}});
  const r=await f.execute('memory_ingest',f.input,'token');assert.equal(r.ok,false);assert.equal(r.body.state,'not_dispatched');
  assert.ok(f.events.includes('space:not_dispatched'));assert.equal(f.calls.length,0);assert.doesNotMatch(JSON.stringify(r),/secret-token/);
});

test('committed budget reservation with lost response records known no-egress once and retains its charge',async t=>{
  const d=durableLedgers(t);let reservations=0,finalizations=0;
  const f=fixture({ports:{ledger:()=>d.space,budget:{async reserve(input){reservations++;await d.budget.reserve(input);throw new Error('private transport failure');},
    async finalize(input){finalizations++;await d.budget.finalize(input);}}}});
  const result=await f.execute('memory_ingest',f.input,'token');
  assert.equal(result.ok,false);assert.equal(result.body.state,'not_dispatched');assert.equal(result.body.providerDispatched,false);
  assert.equal(d.spaceDb.prepare('SELECT state FROM general_operations').get().state,'not_dispatched');
  assert.equal(d.budgetDb.prepare('SELECT state FROM budget_reservations').get().state,'not_dispatched');
  const usage=await d.budget.usage({budgetId:'test-budget'});assert.equal(usage.requests,1);assert.equal(usage.notDispatched,1);assert.equal(usage.reservedMicroUsd,110);
  await f.execute('memory_ingest',f.input,'token');
  assert.equal(reservations,1);assert.equal(finalizations,1);assert.equal(f.calls.length,0);
  assert.doesNotMatch(JSON.stringify(result),/private transport/);
});

test('failed no-egress budget finalization retains the conservative reservation without retry or masking Space outcome',async t=>{
  const d=durableLedgers(t);let reservations=0,finalizations=0;
  const f=fixture({ports:{ledger:()=>d.space,budget:{async reserve(input){reservations++;await d.budget.reserve(input);throw new Error('routing_budget_unavailable');},
    async finalize(){finalizations++;throw new Error('private journal outage');}}}});
  const result=await f.execute('memory_ingest',f.input,'token');
  assert.equal(result.body.error,'routing_budget_unavailable');assert.equal(result.body.state,'not_dispatched');
  assert.equal(d.spaceDb.prepare('SELECT state FROM general_operations').get().state,'not_dispatched');
  assert.equal(d.budgetDb.prepare('SELECT state FROM budget_reservations').get().state,'admitted');
  assert.equal((await d.budget.usage({budgetId:'test-budget'})).reservedMicroUsd,110);
  assert.equal(reservations,1);assert.equal(finalizations,1);assert.equal(f.calls.length,0);
  assert.doesNotMatch(JSON.stringify(result),/private journal/);
});

test('an absent budget reservation cannot prevent the independent Space no-egress outcome',async t=>{
  const d=durableLedgers(t);let finalizations=0;
  const f=fixture({ports:{ledger:()=>d.space,budget:{async reserve(){throw new Error('routing_budget_exhausted');},
    async finalize(input){finalizations++;await d.budget.finalize(input);}}}});
  const result=await f.execute('memory_ingest',f.input,'token');
  assert.equal(result.body.error,'routing_budget_exhausted');assert.equal(result.body.state,'not_dispatched');
  assert.equal(d.spaceDb.prepare('SELECT state FROM general_operations').get().state,'not_dispatched');
  assert.equal((await d.budget.usage({budgetId:'test-budget'})).requests,0);
  assert.equal(finalizations,1);assert.equal(f.calls.length,0);
});
test('provider timeout never refunds admission and records unknown in both ledgers',async()=>{
  const f=fixture({provider:{async ingest(){throw new Error('secret');}}});
  const r=await f.execute('memory_ingest',f.input,'token');assert.equal(r.body.state,'unknown');
  assert.ok(f.events.includes('space:unknown'));assert.ok(f.events.includes('budget:unknown'));
});
test('retirement or revoked authority during search withholds the provider answer',async()=>{
  const f=fixture({ledger:{async check(input){if(input.phase==='disclose')throw new Error('routing_generation_retired');}}});
  const r=await f.execute('memory_search',{spaceId:'space-a',routing:{version:1,classification:'general'},query:'hello'},'token');
  assert.equal(r.ok,false);assert.doesNotMatch(JSON.stringify(r),/private-answer/);assert.equal(r.body.state,'accepted');
});
test('a hard Seoul lock and medical labels never enter general provider storage',async()=>{
  for(const routing of [{version:1,classification:'medical',medicalCloudflareConsent:{mode:'organization'}},{version:1,classification:'general',requiredRegion:'kr-seoul'}]) {
    const f=fixture();const r=await f.execute('memory_ingest',{...f.input,routing},'token');assert.equal(r.ok,false);assert.equal(f.calls.length,0);
  }
  const f=fixture({ports:{seoulSpaceIds:['space-a']}});assert.equal((await f.execute('memory_ingest',f.input,'token')).ok,false);assert.equal(f.calls.length,0);
});
test('clear retires first and bypasses spend admission, requiring explicit destructive scope',async()=>{
  const f=fixture();const input={spaceId:'space-a',routing:{version:1,classification:'general'},operationId:'clear-a',scope:'all-general-memory-in-space'};
  const r=await f.execute('memory_clear_space',input,'token');assert.equal(r.ok,true);assert.equal(r.body.physicalPurgeVerified,false);
  assert.ok(f.events.indexOf('retire')<f.events.indexOf('delete'));assert.ok(!f.events.includes('reserve'));
  assert.equal((await f.execute('memory_clear_space',{...input,scope:'all'},'token')).ok,false);
});
test('clear timeout retains durable cleanup pending and logical hiding, never claims purge',async()=>{
  const f=fixture({provider:{async deleteProfile(){throw new Error('network failed');}}});
  const r=await f.execute('memory_clear_space',{spaceId:'space-a',routing:{version:1,classification:'general'},operationId:'clear-a',scope:'all-general-memory-in-space'},'token');
  assert.equal(r.body.logicallyHidden,true);assert.equal(r.body.physicalPurgeVerified,false);assert.equal(r.body.cleanupPending,true);
  assert.ok(f.events.includes('retired:unknown'));
});

test('revocation after acknowledged deletion reports the completed side effect truthfully without content',async()=>{
  let authorizations=0;
  const f=fixture({ports:{async authority(_token,spaceId,operation){if(++authorizations===3)throw new Error('access_denied');
    return {spaceId,operation,owner:{kind:'organization',id:'org-a'},accountId:'account-a',credentialId:'key-a',authorityExpiresAtMs:now+60000};}}});
  const result=await f.execute('memory_clear_space',{spaceId:'space-a',routing:{version:1,classification:'general'},operationId:'clear-a',scope:'all-general-memory-in-space'},'token');
  assert.equal(result.ok,false);assert.equal(result.body.error,'access_denied');assert.equal(result.body.state,'retired');
  assert.equal(result.body.providerDispatched,true);assert.equal(result.body.providerAcknowledged,true);
  assert.equal(result.body.cleanupPending,false);assert.equal(result.body.logicallyHidden,true);assert.equal(result.body.physicalPurgeVerified,false);
  assert.equal(f.calls.filter(call=>call.kind==='delete').length,1);
});

test('provider delete acknowledgement remains known when its outcome journal fails before or after commit',async t=>{
  for(const committed of [false,true]){
    const d=durableLedgers(t),states=[];
    const ledger={retire:input=>d.space.retire(input),async finishRetirement(input){states.push(input.state);
      if(input.state==='acknowledged'){
        if(committed)await d.space.finishRetirement(input);
        throw new Error('private ACK journal failure');
      }
      await d.space.finishRetirement(input);
    }};
    const f=fixture({ports:{ledger:()=>ledger}});
    const result=await f.execute('memory_clear_space',{spaceId:'space-a',routing:{version:1,classification:'general'},operationId:'clear-a',scope:'all-general-memory-in-space'},'token');
    assert.equal(result.body.state,'retired');assert.equal(result.body.providerDispatched,true);assert.equal(result.body.providerAcknowledged,true);
    assert.equal(result.body.logicallyHidden,true);assert.equal(result.body.cleanupPending,true);assert.equal(result.body.physicalPurgeVerified,false);
    assert.equal(f.calls.filter(call=>call.kind==='delete').length,1);assert.deepEqual(states,['acknowledged','unknown']);
    assert.equal(d.spaceDb.prepare('SELECT state FROM general_retirements').get().state,committed?'acknowledged':'unknown');
    assert.doesNotMatch(JSON.stringify(result),/private ACK/);
  }
});
test('aborted requests and expired/replayed reservations do not contact provider',async()=>{
  const abort=new AbortController();abort.abort();const f=fixture();
  assert.equal((await f.execute('memory_ingest',f.input,'token',{signal:abort.signal})).ok,false);assert.equal(f.events.length,0);
  for(const reservation of [{expiresAtMs:now-1,replayed:false},{expiresAtMs:now+5000,replayed:true}]) {
    const x=fixture({budget:{async reserve(input){return {...reservation,reservationId:input.reservationId,month:'2026-09',reservedMicroUsd:100};}}});
    assert.equal((await x.execute('memory_ingest',x.input,'token')).ok,false);assert.equal(x.calls.length,0);
  }
});

test('final disclosure response latency cannot outlive ticket, fresh authority, budget or policy expiry',async()=>{
  for(const bound of ['ticket','authority','budget','policy']) {
    let clock=now;
    const expiry=now+100;
    const f=fixture({
      ports:{clock:()=>clock,...(bound==='policy'?{budgetPolicy:{...policy,validUntilMs:expiry}}:{}),
        async authority(_token,spaceId,operation){return {spaceId,operation,owner:{kind:'organization',id:'org-a'},accountId:'account-a',credentialId:'key-a',authorityExpiresAtMs:bound==='authority'?expiry:now+60000};}},
      ledger:{async check(input){if(input.phase==='disclose')clock=expiry;}},
      ...(bound==='budget'?{budget:{async reserve(input){return {reservationId:input.reservationId,month:'2026-09',reservedMicroUsd:110,expiresAtMs:expiry,replayed:false};}}}:{}),
    });
    if(bound==='ticket')f.ticket.expiresAtMs=expiry;
    const result=await f.execute('memory_search',{spaceId:'space-a',routing:{version:1,classification:'general'},query:'hello'},'token');
    assert.equal(result.ok,false,bound);assert.equal(result.body.state,'accepted',bound);
    assert.doesNotMatch(JSON.stringify(result),/private-answer/,bound);
    assert.equal(result.body.error,'routing_authority_expired',bound);
  }
});

test('budget expiration during durable outcome writes withholds results before another disclosure authority call',async()=>{
  let clock=now,authorities=0;
  const f=fixture({ports:{clock:()=>clock,async authority(_token,spaceId,operation){authorities++;return {spaceId,operation,
    owner:{kind:'organization',id:'org-a'},accountId:'account-a',credentialId:'key-a',authorityExpiresAtMs:now+60000};}},
    budget:{async reserve(input){return {reservationId:input.reservationId,month:'2026-09',reservedMicroUsd:110,expiresAtMs:now+100,replayed:false};},
      async finalize(){clock=now+100;}}});
  const result=await f.execute('memory_search',{spaceId:'space-a',routing:{version:1,classification:'general'},query:'hello'},'token');
  assert.equal(result.ok,false);assert.equal(result.body.state,'accepted');assert.equal(authorities,2);
  assert.doesNotMatch(JSON.stringify(result),/private-answer/);assert.ok(f.events.includes('space:accepted'));
});

test('expiry or cancellation while dispatch check is in flight never reaches provider',async()=>{
  for(const cause of ['expiry','abort']) {
    let clock=now;const controller=new AbortController();
    const f=fixture({ports:{clock:()=>clock},ledger:{async check(input){if(input.phase==='dispatch') {
      if(cause==='expiry')clock=now+60000;else controller.abort();
    }}}});
    const result=await f.execute('memory_ingest',f.input,'token',{signal:controller.signal});
    assert.equal(result.ok,false);assert.equal(result.body.state,'not_dispatched');
    assert.equal(f.calls.filter(call=>call.kind==='ingest').length,0);
    assert.ok(f.events.includes('space:not_dispatched'));assert.ok(f.events.includes('budget:not_dispatched'));
  }
});

const retirementIdentity={spaceId:'space-a',owner:{kind:'organization',id:'org-a'},provider:{accountId:'a'.repeat(32),namespace:'memory-test'}};
function retirementFixture(overrides={}) {
  const events=[],rows=Array.from({length:3},(_,i)=>({id:'r-'+i,generation:i+1,nextGeneration:i+2,createdAtMs:now,
    state:'pending',dispatch:false,logicallyHidden:true,physicalPurgeVerified:false}));
  const ledger={async pending(){events.push('pending');return rows;},async finishRetirement(input){events.push(input.retirementId+':'+input.state);},...overrides.ledger};
  const provider={async deleteProfile(){events.push('delete');},...overrides.provider};
  return {events,rows,run(options={}){return reconcileGeneralRetirements(retirementIdentity,ledger,provider,{clock:()=>now,...options});}};
}

test('pre-aborted reconciliation does not load or mutate any retirement',async()=>{
  const controller=new AbortController();controller.abort();const f=retirementFixture();
  await assert.rejects(f.run({signal:controller.signal}),/routing_request_aborted/);assert.deepEqual(f.events,[]);
});

test('reconciliation aborted while loading leaves all undispatched rows unchanged',async()=>{
  const controller=new AbortController();
  const f=retirementFixture({ledger:{async pending(){controller.abort();return [{id:'r-0',generation:1},{id:'r-1',generation:2}];}}});
  assert.deepEqual(await f.run({signal:controller.signal}),{acknowledged:0,pending:2,physicalPurgeVerified:false});
  assert.deepEqual(f.events,[]);
});

test('aborting one attempted deletion journals only that row and preserves untouched pending rows',async()=>{
  const controller=new AbortController();let deletions=0;
  const f=retirementFixture({provider:{async deleteProfile(){deletions++;controller.abort();throw new Error('timeout');}}});
  assert.deepEqual(await f.run({signal:controller.signal}),{acknowledged:0,pending:3,physicalPurgeVerified:false});
  assert.equal(deletions,1);assert.deepEqual(f.events,['pending','r-0:unknown']);
});

test('one reconciliation journal conflict cannot starve independent retirement cleanup',async()=>{
  let deletions=0;const journals=[];
  const f=retirementFixture({provider:{async deleteProfile(){if(++deletions===1)throw new Error('provider timeout');}},
    ledger:{async finishRetirement(input){journals.push([input.retirementId,input.state]);if(input.retirementId==='r-0')throw new Error('routing_space_transition_invalid');}}});
  assert.deepEqual(await f.run(),{acknowledged:2,pending:1,physicalPurgeVerified:false});assert.equal(deletions,3);
  assert.deepEqual(journals,[['r-0','unknown'],['r-1','acknowledged'],['r-2','acknowledged']]);
});

test('unknown acknowledgement writes remain conservatively pending while later rows proceed',async()=>{
  let deletions=0;const journals=[];
  const f=retirementFixture({provider:{async deleteProfile(){deletions++;}},ledger:{async finishRetirement(input){
    journals.push([input.retirementId,input.state]);if(input.retirementId==='r-0')throw new Error('unavailable');}}});
  assert.deepEqual(await f.run(),{acknowledged:2,pending:1,physicalPurgeVerified:false});assert.equal(deletions,3);
  assert.deepEqual(journals,[['r-0','acknowledged'],['r-0','unknown'],['r-1','acknowledged'],['r-2','acknowledged']]);
});

test('reconciliation checks the per-delete deadline after preparing its immutable profile',async t=>{
  let clock=now;
  const f=retirementFixture();
  const digest=crypto.subtle.digest;
  // Keep real hashing, but model a delayed completion before any provider I/O.
  t.mock.method(crypto.subtle,'digest',async function(...args){const value=await digest.apply(this,args);clock+=15000;return value;});
  const result=await f.run({clock:()=>clock});
  assert.deepEqual(result,{acknowledged:0,pending:3,physicalPurgeVerified:false});
  assert.deepEqual(f.events,['pending']);
});
