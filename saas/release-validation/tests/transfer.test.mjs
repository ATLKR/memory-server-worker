import test from 'node:test';import assert from 'node:assert/strict';import {fixture,at} from './db.mjs';import {MemoryStore} from '../../src/release/memory.ts';
let Transfers;try{({Transfers}=await import('../../src/release/transfer.ts'));}catch{}
for(const name of ['export-snapshot','export-revocation','export-erasure','share-consent','share-revocation','share-no-write','share-org-disable'])test(name,async t=>{
 if(name.startsWith('share')){t.skip('cross-border share federation is deferred (0011); share INSERTs are denied');return;}
 assert.ok(Transfers,'transfer implementation missing');const {db,token,other}=await fixture();const store=new MemoryStore(db,()=>at),transfers=new Transfers(db,()=>at);
 try{const m=await store.create(token,'s1',{body:'before'},'create');
 if(name.startsWith('export')){const session=await transfers.startExport(token,'s1');
 if(name==='export-snapshot'){await store.update(token,'s1',m.id,{body:'after',expectedRevision:1},'update');assert.equal((await transfers.exportPage(token,'s1',session.id)).results[0].body,'before');}
 if(name==='export-revocation'){(await db.raw.exec("UPDATE credentials SET revoked_at=1 WHERE id='session:alice'"));await assert.rejects(()=>transfers.exportPage(token,'s1',session.id),e=>e.status===403);}
 if(name==='export-erasure'){await store.remove(token,'s1',m.id,1,'delete');await store.erase(token,'s1',m.id,2,m.id,'erase');assert.equal((await transfers.exportPage(token,'s1',session.id)).results.length,0);}
 }else{const sh=await transfers.share(token,'s1','bob@example.com',7);if(name==='share-consent')await assert.rejects(()=>store.get(other,'s1',m.id),e=>e.status===403);await transfers.accept(other,sh.id);assert.equal((await store.get(other,'s1',m.id)).body,'before');
 if(name==='share-revocation'){await transfers.revoke(token,'s1',sh.id);await assert.rejects(()=>store.get(other,'s1',m.id),e=>e.status===403);}
 if(name==='share-no-write')await assert.rejects(()=>store.update(other,'s1',m.id,{body:'attack',expectedRevision:1},'attack'),e=>e.status===403);
 if(name==='share-org-disable'){(await db.raw.exec("UPDATE accounts SET disabled_at=1 WHERE id='alice'"));await assert.rejects(()=>store.get(other,'s1',m.id),e=>e.status===403);}
 }
 }finally{db.close();}
});
