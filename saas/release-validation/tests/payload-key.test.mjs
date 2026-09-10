import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, payloadKeyId } from '../../src/release/util.ts';
const secret=Buffer.alloc(32,17).toString('base64url'), replacement=Buffer.alloc(32,18).toString('base64url');
test('new encrypted ingestion carries an authenticated stable key identity',async()=>{
  const value={body:'김민수 👩🏽‍💻'},one=await encrypt(secret,value,'job-one'),two=await encrypt(secret,value,'job-one');
  assert.match(await payloadKeyId(secret),/^[a-f0-9]{64}$/);
  assert.ok(one.startsWith('v2.'+await payloadKeyId(secret)+'.'));assert.notEqual(one,two);
  assert.deepEqual(await decrypt(secret,one,'job-one'),value);
  await assert.rejects(decrypt(secret,one,'another-job'));
  await assert.rejects(decrypt(replacement,one,'job-one'));
});
test('retagging an old key envelope cannot make it readable using the replacement key',async()=>{
  const value=await encrypt(secret,{private:'content'},'job');
  const retagged=value.replace(await payloadKeyId(secret),await payloadKeyId(replacement));
  await assert.rejects(decrypt(replacement,retagged,'job'));
  await assert.rejects(decrypt(secret,retagged,'job'));
});
test('existing two-part AES-GCM envelopes remain readable with their original key',async()=>{
  const iv=crypto.getRandomValues(new Uint8Array(12)),key=await crypto.subtle.importKey('raw',Buffer.from(secret,'base64url'),'AES-GCM',false,['encrypt']);
  const body=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('legacy-job')},key,new TextEncoder().encode('{"body":"retained"}'));
  const envelope=Buffer.from(iv).toString('base64url')+'.'+Buffer.from(body).toString('base64url');
  assert.deepEqual(await decrypt(secret,envelope,'legacy-job'),{body:'retained'});
});
test('malformed v2 envelopes and invalid runtime keys cannot enter processing',async()=>{
  for(const envelope of ['v2.bad.a.b','v2.'+'a'.repeat(64)+'.iv.data.extra','v3.'+'a'.repeat(64)+'.iv.data'])await assert.rejects(decrypt(secret,envelope,'job'));
  await assert.rejects(payloadKeyId(Buffer.alloc(31).toString('base64url')));
});
