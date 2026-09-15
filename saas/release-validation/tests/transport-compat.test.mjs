import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at } from './db.mjs';
import { createRelease } from '../../src/release/extension.ts';
async function rpc(response) {
  const text = await response.text();
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6))
    : JSON.parse(text);
}
test('release MCP keeps legacy protocol clients, canonical server identity, and memoryId inputs', async () => {
  const {db,token} = await fixture();
  try {
    const ext = createRelease({DB:db,PUBLIC_ORIGIN:'https://memory.example.com',PRODUCT_NAME:'Future Brand',REQUEST_LIMITER:{limit:async()=>({success:true})}},{clock:()=>at});
    const request = (data,version='2025-03-26') => new Request('https://memory.example.com/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':version},body:JSON.stringify(data)});
    const init = await ext.route(request({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'regression',version:'1'}}}),token);
    assert.equal(init.status,200);
    const value = await rpc(init);
    assert.equal(value.result.protocolVersion,'2025-03-26');
    assert.equal(value.result.serverInfo.name,'allenlabs-memory');
    assert.equal(value.result.serverInfo.title,'Future Brand');
    const call = async(name,args) => rpc(await ext.route(request({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}}),token));
    const created = await call('memory_add',{spaceId:'s1',body:'canonical id works',operationId:'compat-one'});
    assert.notEqual(created.result.isError,true);
    const id = JSON.parse(created.result.content[0].text).id;
    const read = await call('memory_get',{spaceId:'s1',memoryId:id});
    assert.notEqual(read.result.isError,true);
    assert.equal(JSON.parse(read.result.content[0].text).body,'canonical id works');
    const mismatch = await call('memory_get',{spaceId:'s1',memoryId:id,id:'different'});
    assert.equal(mismatch.result.isError,true);
  } finally {db.close();}
});
test('release management page uses configured display brand safely',async()=>{
 const {db}=await fixture();
 try {
 const ext=createRelease({DB:db,PUBLIC_ORIGIN:'https://memory.example.com',PRODUCT_NAME:'Future <Brand>',REQUEST_LIMITER:{limit:async()=>({success:true})}},{clock:()=>at});
 const response=await ext.publicRoute(new Request('https://memory.example.com/manage'));
 const html=await response.text();
 assert.match(html,/<title>Future &lt;Brand&gt;/);
 assert.doesNotMatch(html,/<title>Memory/);
 }finally{db.close();}
});
test('release handles modern SDK per-request protocol without a legacy handshake',async()=>{
 const {db,token}=await fixture();
 try {
 const ext=createRelease({DB:db,PUBLIC_ORIGIN:'https://memory.example.com',REQUEST_LIMITER:{limit:async()=>({success:true})}},{clock:()=>at});
 const response=await ext.route(new Request('https://memory.example.com/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','Mcp-Method':'tools/list'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'modern-review',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})}),token);
 assert.equal(response.status,200);
 const value=await rpc(response);
 assert.equal(value.error,undefined);
 assert.ok(value.result.tools.some(tool=>tool.name==='memory_add'));
 }finally{db.close();}
});
