import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,at} from './db.mjs';
import {WorkspaceService} from '../../src/workspace.ts';
import {Transfers} from '../../src/release/transfer.ts';
import {MemoryStore} from '../../src/release/memory.ts';
import {digest} from '../../src/release/util.ts';

const denied=fn=>assert.rejects(fn,error=>[401,403].includes(error.status));
async function setup(t){
  const f=await fixture();t.after(()=>f.db.close());
  const workspace=new WorkspaceService(f.db,()=>at);
  const recipient=await workspace.signIn({issuer:'https://auth-api.allen.company',subject:'recipient',email:'recipient@corp.example',emailVerified:true,permission:'write',expiresAt:at+900000});
  const transfer=new Transfers(f.db,()=>at),memory=new MemoryStore(f.db,()=>at);
  return {...f,workspace,recipient,transfer,memory};
}

for(const change of ['membership','email','account','organization','role','expiry'])test('organization share denies read, invitation, and acceptance after grantor '+change+' loses authority',async t=>{
  const f=await setup(t),record=await f.memory.create(f.token,'so',{body:'Organization private data'},'record');
  const accepted=await f.transfer.share(f.token,'so','recipient@corp.example');
  const pending=await f.transfer.share(f.token,'so','recipient@corp.example');
  await f.transfer.accept(f.recipient.token,accepted.id);
  assert.equal((await f.memory.get(f.recipient.token,'so',record.id)).body,'Organization private data');
  const mutations={
    membership:"UPDATE memberships SET revoked_at=? WHERE id='m1'",
    email:"UPDATE account_emails SET revoked_at=? WHERE id='e1'",
    account:"UPDATE accounts SET disabled_at=? WHERE id='alice'",
    organization:"UPDATE organizations SET disabled_at=? WHERE id='org'",
    role:"UPDATE memberships SET role='member' WHERE id='m1' AND expires_at>?",
    expiry:"UPDATE memberships SET expires_at=? WHERE id='m1'",
  };
  f.db.raw.prepare(mutations[change]).run(at);
  await denied(()=>f.memory.get(f.recipient.token,'so',record.id));
  assert.deepEqual(await f.transfer.invitations(f.recipient.token),[]);
  await denied(()=>f.transfer.accept(f.recipient.token,pending.id));
});

test('a new grantor membership cannot restore or rebind an old organization share',async t=>{
  const f=await setup(t),record=await f.memory.create(f.token,'so',{body:'Private'},'record');
  const share=await f.transfer.share(f.token,'so','recipient@corp.example');await f.transfer.accept(f.recipient.token,share.id);
  f.db.raw.prepare("UPDATE memberships SET revoked_at=? WHERE id='m1'").run(at);
  f.db.raw.prepare('INSERT INTO memberships(id,organization_id,account_id,email_id,role) VALUES(?,?,?,?,?)').run('replacement','org','alice','e1','owner');
  await denied(()=>f.memory.get(f.recipient.token,'so',record.id));
  for(const mode of ['ON','OFF']){
    f.db.raw.exec('PRAGMA recursive_triggers='+mode);
    assert.throws(()=>f.db.raw.prepare('UPDATE release_shares SET creator_membership_id=? WHERE id=?').run('replacement',share.id));
    assert.throws(()=>f.db.raw.prepare('UPDATE release_shares SET revoked_at=NULL WHERE id=?').run(share.id));
    assert.throws(()=>f.db.raw.exec('INSERT OR REPLACE INTO release_shares SELECT * FROM release_shares'));
  }
});

for(const space of ['s1','so'])test('grantor session expiry and logout preserve intended days-long share: '+space,async t=>{
  const f=await setup(t),record=await f.memory.create(f.token,space,{body:'Durable grant'},'record');
  const share=await f.transfer.share(f.token,space,'recipient@corp.example');
  f.db.raw.prepare("UPDATE credentials SET expires_at=?,revoked_at=? WHERE id='session:alice'").run(at,at);
  const invitations=await f.transfer.invitations(f.recipient.token);assert.equal(invitations[0].id,share.id);
  await f.transfer.accept(f.recipient.token,share.id);
  assert.equal((await f.memory.get(f.recipient.token,space,record.id)).body,'Durable grant');
});

test('share invitation metadata is denied when recipient credential is revoked before its data query',async t=>{
  const f=await setup(t);await f.transfer.share(f.token,'so','recipient@corp.example');
  const original=f.db.prepare.bind(f.db),hash=await digest(f.recipient.token);
  f.db.prepare=sql=>{
    const statement=original(sql);
    if(sql.includes('SELECT sh.id,sh.space_id AS spaceId')){
      const all=statement.all.bind(statement);
      statement.all=async()=>{f.db.raw.prepare('UPDATE credentials SET revoked_at=? WHERE token_digest=?').run(at,hash);return all();};
    }
    return statement;
  };
  await denied(()=>f.transfer.invitations(f.recipient.token));
});

test('recipient email reverification does not inherit the old share and parent grants do not include child Spaces',async t=>{
  const f=await setup(t),record=await f.memory.create(f.token,'so',{body:'Shared parent only'},'record');
  const child=await f.workspace.createOrganization(f.token,{name:'Child',emailId:'e1',parentOrganizationId:'org'});
  const childRecord=await f.memory.create(f.token,child.spaceId,{body:'Child private'},'child');
  const share=await f.transfer.share(f.token,'so','recipient@corp.example');await f.transfer.accept(f.recipient.token,share.id);
  await denied(()=>f.memory.get(f.recipient.token,child.spaceId,childRecord.id));
  f.db.raw.prepare('UPDATE account_emails SET revoked_at=? WHERE account_id=?').run(at,f.recipient.accountId);
  f.db.raw.prepare('INSERT INTO account_emails(id,account_id,address,domain,verified_at) VALUES(?,?,?,?,?)').run('new-recipient-claim',f.recipient.accountId,'recipient@corp.example','corp.example',at);
  await denied(()=>f.memory.get(f.recipient.token,'so',record.id));
});
