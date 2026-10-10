import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer,createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { ExternalMcp,parseExternalMcpServers } from './external-mcp.js';
import { HeadlessJournal } from './headless-journal.js';
import { mcpDiscoverySnapshotSchema } from './mcp-discovery.js';
import { RemoteMcp } from './remote-mcp.js';
test('a stalled provider is bounded; healthy discovery survives with coalesced isolated results and current status',async()=>{
 let listings=0,deadRequests=0,hang=true,healthyDown=false;const secret='private-discovery-fixture-credential';process.env.DISCOVERY_FIXTURE_TOKEN=secret;
 const handler=createMcpHandler(()=>{const mcp=new McpServer({name:'healthy-discovery',version:'1.0.0'});mcp.registerTool('lookup',{description:'Public fact '+secret,inputSchema:z.object({query:z.string()})},async()=>({content:[]}));mcp.registerTool('unapproved',{inputSchema:z.object({})},async()=>({content:[]}));return mcp;},{responseMode:'json'}),nodeHandler=toNodeHandler(handler);
 const healthy=createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer '+secret);if(healthyDown){res.writeHead(503).end('Private upstream '+secret);return;}void nodeHandler(req,res);});
 const dead=createServer((_req,res)=>{deadRequests++;if(!hang)res.writeHead(503).end('Private upstream '+secret);});healthy.listen(0,'127.0.0.1');dead.listen(0,'127.0.0.1');await Promise.all([once(healthy,'listening'),once(dead,'listening')]);
 const root=await mkdtemp(join(tmpdir(),'agentos-discovery-')),journal=new HeadlessJournal(join(root,'journal.sqlite')),config=parseExternalMcpServers(JSON.stringify([{id:'healthy',endpoint:`http://127.0.0.1:${(healthy.address() as any).port}/mcp`,tools:['lookup','missing'],tokenEnv:'DISCOVERY_FIXTURE_TOKEN'},{id:'offline',endpoint:`http://127.0.0.1:${(dead.address() as any).port}/mcp`,tools:['lookup']}])) ,transport=(async(url,options)=>{const input=typeof options?.body==='string'?JSON.parse(options.body):{};if(input.method==='tools/list')listings++;return fetch(url,options);}) as typeof fetch,client=new ExternalMcp(config,journal,transport,false,undefined,500);
 try{
  assert.ok(client.discoveryStatus().every(status=>status.state==='not-checked'&&status.checkedAt===null));const start=Date.now(),[one,two]=await Promise.all([client.catalog(),client.catalog()]);assert.ok(Date.now()-start<2000,'Discovery must stop its stalled provider');assert.equal(deadRequests,1);assert.equal(listings,1);assert.deepEqual(one.map(tool=>tool.id),['mcp:healthy:lookup']);assert.ok(!JSON.stringify(one).includes(secret));one[0].description='Mutated';assert.notEqual(two[0].description,'Mutated');
  const status=client.discoveryStatus();assert.deepEqual(status.map(value=>value.state),['partial','unavailable']);assert.deepEqual(status[0].missingTools,['mcp:healthy:missing']);assert.deepEqual(status[1].availableTools,[]);assert.ok(status.every(value=>value.checkedAt));assert.ok(!JSON.stringify(status).includes(secret));status[0].missingTools=[];assert.deepEqual(client.discoveryStatus()[0].missingTools,['mcp:healthy:missing']);
  hang=false;await client.catalog();assert.equal(listings,2);assert.equal(deadRequests,2);
  healthyDown=true;await assert.rejects(client.catalog(),/No configured external MCP/);assert.ok(client.discoveryStatus().every(status=>status.state==='unavailable'&&status.availableTools.length===0));healthyDown=false;config[0].tools.push('injected');assert.deepEqual((await client.catalog()).map(tool=>tool.id),['mcp:healthy:lookup']);assert.deepEqual(client.discoveryStatus()[0].missingTools,['mcp:healthy:missing']);
  const onlyDead=new ExternalMcp([config[1]],journal,fetch,false,undefined,500);await assert.rejects(onlyDead.catalog(),/No configured external MCP/);assert.equal(onlyDead.discoveryStatus()[0].state,'unavailable');assert.ok(!JSON.stringify(onlyDead.discoveryStatus()).includes(secret));
 }finally{delete process.env.DISCOVERY_FIXTURE_TOKEN;journal.close();await handler.close();healthy.closeAllConnections();dead.closeAllConnections();await Promise.all([new Promise<void>(resolve=>healthy.close(()=>resolve())),new Promise<void>(resolve=>dead.close(()=>resolve()))]);await rm(root,{recursive:true,force:true});}
});
test('remote discovery is read-only and rejects inconsistent server scopes, raw diagnostics and credentials',async()=>{
 const status={server:'public',state:'available',availableTools:['mcp:public:lookup'],missingTools:[],checkedAt:new Date().toISOString()},token='discovery-operator-fixture-credential';
 const client=new RemoteMcp('https://gateway.example.com',token,async(url,options)=>{assert.equal(String(url),'https://gateway.example.com/mcp/discovery');assert.equal(options?.method,'GET');assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+token);return Response.json([status]);});assert.deepEqual(await client.discoveryStatus(),[status]);
 for(const changed of [{availableTools:['mcp:other:lookup']},{state:'unavailable'},{checkedAt:null},{availableTools:['mcp:public:lookup','mcp:public:lookup']},{endpoint:'https://private.example.com'},{error:'Private upstream'}])assert.equal(mcpDiscoverySnapshotSchema.safeParse([{...status,...changed}]).success,false);
 await assert.rejects(new RemoteMcp('https://gateway.example.com',token,async()=>Response.json([{...status,server:token}])).discoveryStatus(),/credential/);
});
