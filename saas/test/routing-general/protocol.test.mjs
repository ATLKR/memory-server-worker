import test from 'node:test';
import assert from 'node:assert/strict';
import { generalMcpControl } from '../../src/routing/general-protocol.ts';
const request=()=>new Request('https://memory.test/mcp',{method:'POST',headers:{accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2025-11-25'}});
async function parsed(response){const text=await response.text();return JSON.parse(text.startsWith('event:')?text.split('\n').find(line=>line.startsWith('data:')).slice(5):text);}
test('routed remote MCP negotiates standard initialization and preserves configurable product title',async()=>{
  const r=await generalMcpControl(request(),{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{title:'Rebranded Memory'});
  assert.equal(r.status,200);const value=await parsed(r);assert.equal(value.result.protocolVersion,'2025-11-25');
  assert.equal(value.result.serverInfo.title,'Rebranded Memory');assert.ok(value.result.capabilities.tools);
});
test('tools list describes routed schemas and destructive scope, with metadata preflight tool',async()=>{
  const value=await parsed(await generalMcpControl(request(),{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}));
  const tools=value.result.tools;assert.deepEqual(tools.map(t=>t.name),['memory_route_check','memory_ingest','memory_search','memory_clear_space','memory_usage']);
  const clear=tools.find(t=>t.name==='memory_clear_space');assert.equal(clear.annotations.destructiveHint,true);
  assert.equal(clear.inputSchema.properties.scope.const,'all-general-memory-in-space');
  assert.ok(tools.find(t=>t.name==='memory_ingest').inputSchema.required.includes('spaceId'));
});
test('initialized and ping work without a provider session, unsupported methods are protocol errors',async()=>{
  const initialized=await generalMcpControl(request(),{jsonrpc:'2.0',method:'notifications/initialized'});
  assert.equal(initialized.status,202);assert.equal(await initialized.text(),'');
  assert.deepEqual((await parsed(await generalMcpControl(request(),{jsonrpc:'2.0',id:3,method:'ping'}))).result,{});
  assert.ok((await parsed(await generalMcpControl(request(),{jsonrpc:'2.0',id:4,method:'not/a/method'}))).error);
});
test('ordinary tool calls remain exclusively owned by guarded executor',async()=>{
  assert.equal(await generalMcpControl(request(),{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'memory_ingest',arguments:{}}}),null);
});
test('unsupported MCP version is rejected before any tool dispatch',async()=>{
  const request=new Request('https://memory.test/mcp',{method:'POST',headers:{'mcp-protocol-version':'unknown'}});
  const response=await generalMcpControl(request,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'memory_ingest',arguments:{}}});
  assert.equal(response.status,400);
});
test('route-check tool sends only validated references to current server authority',async()=>{
  const seen=[];const options={async check(spaceId,operation,requestId){seen.push({spaceId,operation,requestId});return {allowed:true};}};
  const call=args=>generalMcpControl(request(),{jsonrpc:'2.0',id:'rpc-check',method:'tools/call',params:{name:'memory_route_check',arguments:args}},options);
  const r=await parsed(await call({spaceId:'space',operation:'memory_ingest'}));assert.equal(r.result.isError,undefined);
  assert.deepEqual(seen,[{spaceId:'space',operation:'memory_ingest',requestId:'rpc-check'}]);
  const bad=await parsed(await call({spaceId:'space',operation:'memory_ingest',messages:['raw']}));assert.equal(bad.result.isError,true);assert.equal(seen.length,1);
});
