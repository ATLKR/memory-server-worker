import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DB, at } from './db.mjs';
import { WorkspaceService } from '../../src/workspace.ts';
import { createRelease } from '../../src/release/extension.ts';
import { Admin } from '../../src/release/admin.ts';
import { Transfers } from '../../src/release/transfer.ts';
import { requireSpace } from '../../src/release/authority.ts';
import { hmac } from '../../src/release/util.ts';

const issuer='https://auth-api.allen.company', secret='synthetic-lifecycle-heads-'.repeat(2);
async function fixture(t) {
    let now=at; const db=new DB(()=>now); t.after(()=>db.close()); db.migrate(23);
    db.raw.exec(readFileSync(new URL('../../lifecycle-schema.sql',import.meta.url),'utf8'));
    const clock=()=>now, workspace=new WorkspaceService(db,clock,{identityLifecycle:true});
    const principal=(subject='alice',extra={})=>({issuer,subject,email:subject+'@example.com',emailVerified:true,issuedAt:now,expiresAt:now+900000,permission:'write',...extra});
    const old=await workspace.signIn(principal()), bob=await workspace.signIn(principal('bob'));
    db.raw.prepare('UPDATE credentials SET reauthenticated_at=?').run(now);
    const oldEmail=db.raw.prepare('SELECT id FROM account_emails WHERE account_id=?').get(old.accountId).id;
    const bobSpace=db.raw.prepare('SELECT id FROM spaces WHERE account_id=?').get(bob.accountId).id;
    const transfer=new Transfers(db,clock), share=await transfer.share(bob.token,bobSpace,'alice@example.com'); await transfer.accept(old.token,share.id);
    const admin=new Admin({DB:db,IDENTITY_WEBHOOK_SECRET:secret},clock);
    const oldOrg=await workspace.createOrganization(old.token,{name:'Old grant',emailId:oldEmail});
    const oldKey=await admin.issueKey(old.token,{label:'Old org key',capabilities:['read'],organizationId:oldOrg.id,spaceIds:[oldOrg.spaceId],expiresInDays:1});
    const release=createRelease({DB:db,ENROLLMENT_MODE:'invite',IDENTITY_WEBHOOK_SECRET:secret},{clock});
    const event=(sequence,type,email=null)=>JSON.stringify({version:2,id:'head-'+sequence,sequence,issuer,subject:'alice',type,occurredAt:now,email});
    const deliver=async raw=>{const timestamp=String(Math.floor(now/1000));return admin.identityWebhook(new Request('https://memory.allenlabs.org/webhooks/identity',{method:'POST',headers:{'x-memory-timestamp':timestamp,'x-memory-signature':await hmac(secret,timestamp+'.'+raw)},body:raw}));};
    return {db,clock,workspace,old,oldEmail,oldOrg,oldKey,bobSpace,principal,event,deliver,advance(ms){now+=ms;},
        async signIn(heads,extra={}){const proof=principal('alice',{identityLifecycle:heads,...extra});await release.beforeSignIn(proof);return workspace.signIn(proof);},
        apply:proof=>release.beforeSignIn(proof)};
}

for(const type of ['email.verified','account.resumed']) test('signed '+type+' precedes fresh owner creation and delayed HMAC is exact replay',async t=>{
    const f=await fixture(t); f.advance(1000);const raw=f.event(2,type,type==='email.verified'?'alice@example.com':null);
    f.advance(1000);const fresh=await f.signIn([raw]);
    const email=f.db.raw.prepare('SELECT id FROM account_emails WHERE account_id=? AND revoked_at IS NULL').get(fresh.accountId).id;
    assert.notEqual(email,f.oldEmail);
    const org=await f.workspace.createOrganization(fresh.token,{name:'Fresh owner',emailId:email});
    f.advance(1000);assert.equal((await(await f.deliver(raw)).json()).replayed,true);
    await requireSpace(f.db,fresh.token,org.spaceId,'update',f.clock);
    assert.equal(f.db.raw.prepare("SELECT count(*) n FROM active_memberships WHERE organization_id=? AND role='owner'").get(org.id).n,1);
    await assert.rejects(()=>requireSpace(f.db,fresh.token,f.bobSpace,'read',f.clock),e=>e.status===403);
    await assert.rejects(()=>requireSpace(f.db,f.oldKey.token,f.oldOrg.spaceId,'read',f.clock),e=>e.status===403);
    if(type==='account.resumed')await assert.rejects(()=>requireSpace(f.db,f.old.token,org.spaceId,'read',f.clock),e=>e.status===403);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_identity_lifecycle_events').get().n,1);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_identity_lifecycle_jwt_proofs').get().n,1);
});

test('both signed heads commit before claims; a late older negative cannot revoke the new owner',async t=>{
    const f=await fixture(t), old=f.event(1,'account.suspended'); f.advance(1000);
    const heads=[f.event(2,'account.resumed'),f.event(3,'email.verified','alice@example.com')];f.advance(1000);
    const fresh=await f.signIn(heads), email=f.db.raw.prepare('SELECT id FROM account_emails WHERE account_id=? AND revoked_at IS NULL').get(fresh.accountId).id;
    const org=await f.workspace.createOrganization(fresh.token,{name:'Fresh',emailId:email});
    await f.deliver(old);for(const raw of heads)await f.deliver(raw);
    await requireSpace(f.db,fresh.token,org.spaceId,'update',f.clock);
    await assert.rejects(()=>requireSpace(f.db,fresh.token,f.bobSpace,'read',f.clock),e=>e.status===403);
});

test('signed heads cannot target a different subject/address or exceed the two-entity bound',async t=>{
    const f=await fixture(t), raw=f.event(1,'email.verified','alice@example.com'), value=JSON.parse(raw);
    for(const heads of [[JSON.stringify({...value,subject:'bob'})],[JSON.stringify({...value,email:'bob@example.com'})],[raw,raw],[raw,raw,raw]])
        await assert.rejects(()=>f.apply(f.principal('alice',{identityLifecycle:heads})),e=>e.status===401);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_webhook_events').get().n,0);
});

test('JWT proof expiry between batch statements rolls back all lifecycle effects',async t=>{
    const f=await fixture(t), raw=f.event(1,'account.resumed');f.advance(1000);
    const prepare=f.db.prepare.bind(f.db);let injected=false;
    f.db.prepare=sql=>{const s=prepare(sql);if(sql.includes('INSERT INTO release_identity_lifecycle_events')){const all=s.all.bind(s);s.all=async()=>{if(!injected){injected=true;f.advance(1001);}return all();};}return s;};
    await assert.rejects(()=>f.apply(f.principal('alice',{expiresAt:f.clock()+1000,identityLifecycle:[raw]})));
    assert.equal(injected,true);assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_webhook_events').get().n,0);
    assert.equal(f.db.raw.prepare('SELECT count(*) n FROM release_identity_lifecycle_jwt_proofs').get().n,0);
    assert.equal(f.db.raw.prepare('SELECT revoked_at FROM account_emails WHERE id=?').get(f.oldEmail).revoked_at,null);
});
