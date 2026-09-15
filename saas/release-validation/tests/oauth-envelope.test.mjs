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
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const token=await new SignJWT({token_use:'access',scope:'memory:read memory:write memory:delete',client_id:'external-agent-client',azp:'external-agent-client',banned:false})
 .setProtectedHeader({alg:'RS256',typ:'at+jwt'}).setIssuer(AUTH_ISSUER).setAudience(PUBLIC_ORIGIN).setSubject('external-review')
 .setJti('external-review-one').setIssuedAt(at/1000).setExpirationTime(at/1000+900).sign(privateKey);
 const workspace=new WorkspaceService(db,()=>at);
 await workspace.signIn({issuer:AUTH_ISSUER,subject:'external-review',permission:'write',expiresAt:at+900000},token);
 db.migrate();
 const hash=await digest(token),credentialId='oauth:'+hash;
 const policy=()=>db.raw.prepare('SELECT capabilities,verified_oauth AS verified FROM release_credential_policies WHERE credential_id=?').get(credentialId);
 assert.ok(JSON.parse(policy().capabilities).includes('export'));
 assert.equal(policy().verified,0);
 const env={DB:db,SSO_CLIENT_ID:'browser-only-client',PUBLIC_ORIGIN,REQUEST_LIMITER:{limit:async()=>({success:true})}};
 const release=createRelease(env,{clock:()=>at});
 const app=createApplication(db,readSettings(env),{clock:()=>at,auth:{jwks:async()=>publicKey},release});
 const request=(path,method='GET',payload)=>app(new Request(PUBLIC_ORIGIN+path,{method,headers:{authorization:'Bearer '+token,...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})}));
 const space=db.raw.prepare('SELECT id FROM spaces WHERE account_id=(SELECT account_id FROM credentials WHERE id=?)').get(credentialId).id;
 assert.equal((await request('/v1/spaces/'+space+'/exports','POST',{})).status,403);
 assert.deepEqual(JSON.parse(policy().capabilities),['read','create','update','delete']);
 assert.equal(policy().verified,1);
 // Simulate a not-yet-verified coarse policy on an existing token; every verified request must refine it.
 db.raw.prepare("UPDATE release_credential_policies SET capabilities='[\"read\",\"create\",\"update\",\"delete\",\"export\"]',verified_oauth=0 WHERE credential_id=?").run(credentialId);
 assert.equal((await request('/v1/spaces/'+space+'/exports','POST',{})).status,403);
 assert.equal(policy().verified,1);
 assert.equal((await request('/v1/account/emails')).status,403);
 assert.equal((await request('/v1/spaces/'+space+'/memories','POST',{body:'authorized agent data',operationId:'jwt-one'})).status,201);
 const revokedAt=at+1;db.raw.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(revokedAt,credentialId);
 assert.equal((await request('/v1/spaces/'+space+'/memories')).status,401);
 }finally{db.close();}
});
