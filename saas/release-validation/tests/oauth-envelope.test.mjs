import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { DB, at } from './db.mjs';
import { WorkspaceService } from '../../src/workspace.ts';
import { createApplication } from '../../src/app.ts';
import { createRelease } from '../../src/release/extension.ts';
import { readSettings, AUTH_ISSUER, PUBLIC_ORIGIN } from '../../src/config.ts';
import { digest } from '../../src/release/util.ts';
test('real OAuth verification narrows migration policies before routing and again on credential reuse',async()=>{
 const db=new DB();
 try {
 // credential_policy_upgrade admits exactly the verified-OAuth narrowing
 // (unverified → verified) the signedIn upsert performs; no fixture patch is
 // needed for the service path. The lifecycle-journal staleness gate denies
 // provider-bound accounts whose issuer has no fresh apply-head; this test
 // does not exercise staleness.
 (await db.raw.prepare('INSERT INTO memory_ops.lifecycle_apply_head(issuer,applied_sequence,applied_at_ms) VALUES(?,?,?)')
  .run(AUTH_ISSUER,0,9007199254740991));
 (await db.raw.prepare("INSERT INTO memory_ops.lifecycle_apply_head(issuer,applied_sequence,applied_at_ms) VALUES('memory:control',0,?)")
  .run(9007199254740991));
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const token=await new SignJWT({token_use:'access',scope:'memory:read memory:write memory:delete',client_id:'external-agent-client',azp:'external-agent-client',banned:false})
 .setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(AUTH_ISSUER).setAudience(PUBLIC_ORIGIN).setSubject('external-review')
 .setJti('external-review-one').setIssuedAt(at/1000).setExpirationTime(at/1000+900).sign(privateKey);
 const workspace=new WorkspaceService(db,()=>at);
 await workspace.signIn({issuer:AUTH_ISSUER,subject:'external-review',permission:'write',expiresAt:at+900000},token);
 (await db.migrate());
 const hash=await digest(token),credentialId='oauth:'+hash;
 // The retired D1 lineage backfilled a coarse migration policy for every
 // non-session credential; seed the same unverified row the port expects.
 (await db.raw.prepare(`INSERT INTO release_credential_policies(credential_id,capabilities) VALUES(?,'["read","create","update","delete","export"]')`).run(credentialId));
 const policy=async ()=>(await db.raw.prepare('SELECT capabilities,verified_oauth::int AS verified FROM release_credential_policies WHERE credential_id=?').get(credentialId));
 // jsonb columns arrive already decoded; accept either representation.
 const caps=async()=>{const v=(await policy()).capabilities;return Array.isArray(v)?v:JSON.parse(v);};
 assert.ok((await caps()).includes('export'));
 assert.equal((await policy()).verified,0);
 const env={DB:db,SSO_CLIENT_ID:'browser-only-client',PUBLIC_ORIGIN,REQUEST_LIMITER:{limit:async()=>({success:true})}};
 const release=createRelease(env,{clock:()=>at});
 const app=createApplication(db,readSettings(env),{clock:()=>at,auth:{jwks:async()=>publicKey},release});
 const request=(path,method='GET',payload)=>app(new Request(PUBLIC_ORIGIN+path,{method,headers:{authorization:'Bearer '+token,...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})}));
 const space=(await db.raw.prepare('SELECT id FROM memory_control.spaces WHERE owner_account_id=(SELECT account_id FROM memory_identity.credentials WHERE id=?)').get(credentialId)).id;
 assert.equal((await request('/v1/spaces/'+space+'/exports','POST',{})).status,403);
 assert.deepEqual(await caps(),['read','create','update','delete']);
 assert.equal((await policy()).verified,1);
 // Simulate a not-yet-verified coarse policy on an existing token; every verified request must refine it.
 // The unverified→verified transition is one-way, so the fixture reset runs
 // with row triggers bypassed rather than emulating a service write.
 (await db.raw.exec(`SET session_replication_role='replica'`));
 (await db.raw.prepare("UPDATE release_credential_policies SET capabilities='[\"read\",\"create\",\"update\",\"delete\",\"export\"]',verified_oauth=false WHERE credential_id=?").run(credentialId));
 (await db.raw.exec(`SET session_replication_role='origin'`));
 assert.equal((await request('/v1/spaces/'+space+'/exports','POST',{})).status,403);
 assert.equal((await policy()).verified,1);
 assert.equal((await request('/v1/account/emails')).status,403);
 assert.equal((await request('/v1/spaces/'+space+'/memories','POST',{body:'authorized agent data',operationId:'jwt-one'})).status,201);
 const revokedAt=at+1;(await db.raw.prepare('UPDATE memory_identity.credentials SET revoked_at=? WHERE id=?').run(revokedAt,credentialId));
 assert.equal((await request('/v1/spaces/'+space+'/memories')).status,401);
 }finally{db.close();}
});
