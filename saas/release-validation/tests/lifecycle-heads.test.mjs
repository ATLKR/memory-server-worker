import test from 'node:test';
import assert from 'node:assert/strict';
import { DB, at } from './db.mjs';
import { WorkspaceService } from '../../src/workspace.ts';
import { createRelease } from '../../src/release/extension.ts';
import { Admin } from '../../src/release/admin.ts';
import { Transfers } from '../../src/release/transfer.ts';
import { requireSpace } from '../../src/release/authority.ts';
import { hmac } from '../../src/release/util.ts';

const issuer='https://auth-api.allen.company', secret='synthetic-lifecycle-heads-'.repeat(2);
async function fixture(t,options={}) {
    let now=at; const db=new DB(()=>now); t.after(()=>db.close()); (await db.migrate(23));
    // The regional apply unit is external to the intake path: lifecycle_events
    // are journaled, then folded into lifecycle_applied_state with the exact D1
    // revocation cascade. The tests replay that unit as triggers so intake and
    // apply stay atomic. The event guards replay the retired D1 predicates the
    // regional intake does not carry (sequence conflict, signature expiry).
    (await db.raw.exec(`CREATE FUNCTION lifecycle_test_apply() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $apply$
  BEGIN
    UPDATE memory_ops.lifecycle_applied_state s
      SET sequence=NEW.sequence,kind=NEW.kind,occurred_at_ms=NEW.occurred_at,event_id=NEW.id
      WHERE s.issuer=NEW.issuer AND s.subject=NEW.subject AND s.address=NEW.address
        AND s.sequence<NEW.sequence AND s.kind<>'account.deleted';
    INSERT INTO memory_ops.lifecycle_applied_state(issuer,subject,address,sequence,kind,occurred_at_ms,event_id)
      SELECT NEW.issuer,NEW.subject,NEW.address,NEW.sequence,NEW.kind,NEW.occurred_at,NEW.id
      WHERE NOT EXISTS(SELECT 1 FROM memory_ops.lifecycle_applied_state s
        WHERE s.issuer=NEW.issuer AND s.subject=NEW.subject AND s.address=NEW.address);
    -- The apply unit's freshness watermark; authority() denies provider-bound
    -- accounts while the head is missing or stale (lifecycleFreshnessSql).
    INSERT INTO memory_ops.lifecycle_apply_head(issuer,applied_sequence,applied_at_ms)
      VALUES(NEW.issuer,NEW.sequence,memory_control.now_ms())
      ON CONFLICT(issuer) DO UPDATE SET applied_sequence=GREATEST(EXCLUDED.applied_sequence,lifecycle_apply_head.applied_sequence),
        applied_at_ms=EXCLUDED.applied_at_ms;
    RETURN NULL;
  END $apply$;
  CREATE TRIGGER lifecycle_test_apply AFTER INSERT ON memory_ops.lifecycle_events
    FOR EACH ROW EXECUTE FUNCTION lifecycle_test_apply();
  CREATE FUNCTION lifecycle_test_revoke() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $revoke$
  BEGIN
    UPDATE memory_identity.credentials SET revoked_at=memory_control.now_ms() WHERE revoked_at IS NULL AND NEW.address=''
      AND account_id IN (SELECT account_id FROM memory_identity.provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
    UPDATE memory_identity.memberships SET revoked_at=memory_control.now_ms() WHERE revoked_at IS NULL AND NEW.address=''
      AND account_id IN (SELECT account_id FROM memory_identity.provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
    UPDATE memory_identity.account_emails SET revoked_at=memory_control.now_ms() WHERE revoked_at IS NULL AND (NEW.address='' OR address=NEW.address)
      AND account_id IN (SELECT account_id FROM memory_identity.provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
    UPDATE memory_identity.email_challenges SET invalidated_at=memory_control.now_ms() WHERE used_at IS NULL AND invalidated_at IS NULL AND (NEW.address='' OR address=NEW.address)
      AND account_id IN (SELECT account_id FROM memory_identity.provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
    UPDATE memory_identity.accounts SET disabled_at=memory_control.now_ms() WHERE disabled_at IS NULL AND NEW.kind='account.deleted'
      AND id IN (SELECT account_id FROM memory_identity.provider_identities WHERE issuer=NEW.issuer AND subject=NEW.subject);
    RETURN NULL;
  END $revoke$;
  CREATE TRIGGER lifecycle_test_revoke AFTER INSERT OR UPDATE ON memory_ops.lifecycle_applied_state
    FOR EACH ROW EXECUTE FUNCTION lifecycle_test_revoke();
  CREATE FUNCTION lifecycle_test_event_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
  BEGIN
    IF EXISTS(SELECT 1 FROM memory_ops.lifecycle_events WHERE id=NEW.id OR (issuer=NEW.issuer AND sequence=NEW.sequence))
    THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='identity_lifecycle_event_conflict'; END IF;
    IF (EXISTS(SELECT 1 FROM memory_ops.lifecycle_jwt_proofs WHERE event_id=NEW.id)
      AND NOT EXISTS(SELECT 1 FROM memory_ops.lifecycle_jwt_proofs p WHERE p.event_id=NEW.id AND p.body_hash=NEW.body_hash
        AND p.issued_at<=memory_control.now_ms() AND p.expires_at>memory_control.now_ms()))
      OR (NOT EXISTS(SELECT 1 FROM memory_ops.lifecycle_jwt_proofs WHERE event_id=NEW.id)
        AND memory_control.now_ms() NOT BETWEEN NEW.signed_at-300000 AND NEW.signed_at+300000)
    THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='identity_lifecycle_signature_expired'; END IF;
    RETURN NEW;
  END $guard$;
  CREATE TRIGGER lifecycle_test_event_guard BEFORE INSERT ON memory_ops.lifecycle_events
    FOR EACH ROW EXECUTE FUNCTION lifecycle_test_event_guard();`));
    // Issuer watermark before the first event: provider-bound accounts fail
    // closed while lifecycle_apply_head is missing or stale.
    (await db.raw.prepare('INSERT INTO memory_ops.lifecycle_apply_head(issuer,applied_sequence,applied_at_ms) VALUES(?,?,?)').run(issuer,0,9007199254740991));
    (await db.raw.prepare("INSERT INTO memory_ops.lifecycle_apply_head(issuer,applied_sequence,applied_at_ms) VALUES('memory:control',0,?)").run(9007199254740991));
    const clock=()=>now, workspace=new WorkspaceService(db,clock,{identityLifecycle:true});
    const principal=(subject='alice',extra={})=>({issuer,subject,email:subject+'@example.com',emailVerified:true,issuedAt:now,expiresAt:now+900000,permission:'write',...extra});
    const old=await workspace.signIn(principal()), bob=await workspace.signIn(principal('bob'));
    (await db.raw.prepare('UPDATE credentials SET reauthenticated_at=?').run(now));
    const oldEmail=(await db.raw.prepare('SELECT id FROM account_emails WHERE account_id=?').get(old.accountId)).id;
    const bobSpace=(await db.raw.prepare('SELECT id FROM spaces WHERE account_id=?').get(bob.accountId)).id;
    // Cross-border share federation is deferred (0011); share INSERTs are denied.
    // Callers pass {shares:false} so lifecycle-head assertions still run.
    const transfer=new Transfers(db,clock);
    if(options.shares!==false){const share=await transfer.share(bob.token,bobSpace,'alice@example.com'); await transfer.accept(old.token,share.id);}
    const admin=new Admin({DB:db,IDENTITY_WEBHOOK_SECRET:secret},clock);
    const oldOrg=await workspace.createOrganization(old.token,{name:'Old grant',emailId:oldEmail});
    const oldKey=await admin.issueKey(old.token,{label:'Old org key',capabilities:['read'],organizationId:oldOrg.id,spaceIds:[oldOrg.spaceId],expiresInDays:1});
    // 'open' enrollment: invite mode would demand a roster for these tests'
    // synthetic principals (src/release/enrollment.ts now quotes the alias).
    const release=createRelease({DB:db,ENROLLMENT_MODE:'open',IDENTITY_WEBHOOK_SECRET:secret},{clock});
    const event=(sequence,type,email=null)=>JSON.stringify({version:2,id:'head-'+sequence,sequence,issuer,subject:'alice',type,occurredAt:now,email});
    const deliver=async raw=>{const timestamp=String(Math.floor(now/1000));return admin.identityWebhook(new Request('https://memory.allenlabs.org/webhooks/identity',{method:'POST',headers:{'x-memory-timestamp':timestamp,'x-memory-signature':await hmac(secret,timestamp+'.'+raw)},body:raw}));};
    return {db,clock,workspace,old,oldEmail,oldOrg,oldKey,bobSpace,principal,event,deliver,advance(ms){now+=ms;},
        async signIn(heads,extra={}){const proof=principal('alice',{identityLifecycle:heads,...extra});await release.beforeSignIn(proof);return workspace.signIn(proof);},
        apply:proof=>release.beforeSignIn(proof)};
}

for(const type of ['email.verified','account.resumed']) test('signed '+type+' precedes fresh owner creation and delayed HMAC is exact replay',async t=>{
    const f=await fixture(t,{shares:false}); f.advance(1000);const raw=f.event(2,type,type==='email.verified'?'alice@example.com':null);
    f.advance(1000);const fresh=await f.signIn([raw]);
    const email=(await f.db.raw.prepare('SELECT id FROM account_emails WHERE account_id=? AND revoked_at IS NULL').get(fresh.accountId)).id;
    assert.notEqual(email,f.oldEmail);
    const org=await f.workspace.createOrganization(fresh.token,{name:'Fresh owner',emailId:email});
    f.advance(1000);assert.equal((await(await f.deliver(raw)).json()).replayed,true);
    await requireSpace(f.db,fresh.token,org.spaceId,'update',f.clock);
    assert.equal((await f.db.raw.prepare("SELECT count(*) n FROM active_memberships WHERE organization_id=? AND role='owner'").get(org.id)).n,1);
    await assert.rejects(()=>requireSpace(f.db,fresh.token,f.bobSpace,'read',f.clock),e=>e.status===403);
    await assert.rejects(()=>requireSpace(f.db,f.oldKey.token,f.oldOrg.spaceId,'read',f.clock),e=>e.status===403);
    if(type==='account.resumed')await assert.rejects(()=>requireSpace(f.db,f.old.token,org.spaceId,'read',f.clock),e=>e.status===403);
    assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_identity_lifecycle_events').get()).n,1);
    assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_identity_lifecycle_jwt_proofs').get()).n,1);
});

test('both signed heads commit before claims; a late older negative cannot revoke the new owner',async t=>{
    const f=await fixture(t,{shares:false}), old=f.event(1,'account.suspended'); f.advance(1000);
    const heads=[f.event(2,'account.resumed'),f.event(3,'email.verified','alice@example.com')];f.advance(1000);
    const fresh=await f.signIn(heads), email=(await f.db.raw.prepare('SELECT id FROM account_emails WHERE account_id=? AND revoked_at IS NULL').get(fresh.accountId)).id;
    const org=await f.workspace.createOrganization(fresh.token,{name:'Fresh',emailId:email});
    await f.deliver(old);for(const raw of heads)await f.deliver(raw);
    await requireSpace(f.db,fresh.token,org.spaceId,'update',f.clock);
    await assert.rejects(()=>requireSpace(f.db,fresh.token,f.bobSpace,'read',f.clock),e=>e.status===403);
});

test('signed heads cannot target a different subject/address or exceed the two-entity bound',async t=>{
    const f=await fixture(t,{shares:false}), raw=f.event(1,'email.verified','alice@example.com'), value=JSON.parse(raw);
    for(const heads of [[JSON.stringify({...value,subject:'bob'})],[JSON.stringify({...value,email:'bob@example.com'})],[raw,raw],[raw,raw,raw]])
        await assert.rejects(()=>f.apply(f.principal('alice',{identityLifecycle:heads})),e=>e.status===401);
    assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_webhook_events').get()).n,0);
});

test('JWT proof expiry between batch statements rolls back all lifecycle effects',async t=>{
    const f=await fixture(t,{shares:false}), raw=f.event(1,'account.resumed');f.advance(1000);
    const prepare=f.db.prepare.bind(f.db);let injected=false;
    f.db.prepare=sql=>{const s=prepare(sql);if(sql.includes('INSERT INTO memory_ops.lifecycle_events')){const all=s.all.bind(s);s.all=async()=>{if(!injected){injected=true;f.advance(1001);}return all();};}return s;};
    await assert.rejects(()=>f.apply(f.principal('alice',{expiresAt:f.clock()+1000,identityLifecycle:[raw]})));
    assert.equal(injected,true);assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_webhook_events').get()).n,0);
    assert.equal((await f.db.raw.prepare('SELECT count(*) n FROM release_identity_lifecycle_jwt_proofs').get()).n,0);
    assert.equal((await f.db.raw.prepare('SELECT revoked_at FROM account_emails WHERE id=?').get(f.oldEmail)).revoked_at,null);
});
