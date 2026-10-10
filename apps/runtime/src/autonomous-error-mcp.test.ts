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
import { AutonomousLoop,FileAutonomousStore,type AutonomousJob } from './autonomous-loop.js';
import { autonomousReceiptOutcome } from './autonomous-receipt.js';
for(const scenario of ['tool-error','invalid-schema','invalid-json'] as const)test('official HTTP MCP '+scenario+' survives both journals and replans to a successful input without repeating or executing stale calls',async()=>{
 const calls:string[]=[];
 const handler=createMcpHandler(()=>{const server=new McpServer({name:'error-recovery',version:'1.0.0'});server.registerTool('lookup',{inputSchema:z.object({query:z.string()})},async({query})=>{calls.push(query);return query==='bad'?{isError:true,content:[{type:'text',text:'Query is unsupported; try corrected public input'}]}:{content:[{type:'text',text:'Verified public account fields'}]};});return server;},{responseMode:'json'});
 const http=createServer(toNodeHandler(handler));http.listen(0,'127.0.0.1');await once(http,'listening');const addr=http.address();assert.ok(addr&&typeof addr!=='string');
 const root=await mkdtemp(join(tmpdir(),'agentos-live-mcp-error-')),config=parseExternalMcpServers(JSON.stringify([{id:'public',endpoint:`http://127.0.0.1:${addr.port}/mcp`,tools:['lookup']}]));let journal=new HeadlessJournal(join(root,'calls.sqlite')),client=new ExternalMcp(config,journal),interrupted=false;
 class InterruptStore extends FileAutonomousStore {override async save(job:AutonomousJob){await super.save(job);if(!interrupted&&job.state==='evaluating'&&job.intents[0]?.receipt?.outcome==='error'){interrupted=true;throw new Error('checkpoint interrupt');}}}
 const action=(query:string)=>({key:query,tool:'mcp:public:lookup',input:query==='bad'&&scenario==='invalid-schema'?'{}':query==='bad'&&scenario==='invalid-json'?'not JSON':JSON.stringify({query}),asset:'SOL' as const,amount:'0'});
 const adapter={validate:async()=>{},plan:async(job:AutonomousJob)=>job.cycle===1?[action('bad'),action('stale')]:[action('corrected')],execute:(job:AutonomousJob,selected:ReturnType<typeof action>,intent:string)=>client.execute(job,selected,intent),reconcile:(job:AutonomousJob,intent:string)=>client.reconcile(job,intent),evaluate:async(job:AutonomousJob)=>({complete:job.cycle===2,feedback:job.cycle===1?'Confirmed source error; use corrected input':'Supported answer'})};
 try{
  const store=new InterruptStore(join(root,'jobs')),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create({tenant:'owner',goal:'Find public account fields',agent:'A'.repeat(32),session:'B'.repeat(32),program:'C'.repeat(32),genesis:'D'.repeat(32),limits:{sol:'0',usdc:'0',maxCycles:2,maxActions:3,maxModelRequests:4,deadline:2000,tools:['mcp:public:lookup']},acceptance:{answerIncludes:[],evidence:[{tool:'mcp:public:lookup',contains:['Verified public account fields']}]}});
  await assert.rejects(loop.run(job.tenant,job.id),/checkpoint interrupt/);const saved=await store.load(job.tenant,job.id);assert.equal(saved.intents[0].receipt?.outcome,'error');assert.deepEqual(saved.pending,[]);assert.deepEqual(calls,scenario==='tool-error'?['bad']:[]);if(scenario!=='tool-error'){assert.equal(JSON.parse(saved.intents[0].receipt!.output).assurance,'local-mcp-preflight');assert.equal(JSON.parse(saved.intents[0].receipt!.output).dispatched,false);}
  journal.close();journal=new HeadlessJournal(join(root,'calls.sqlite'));client=new ExternalMcp(config,journal);const recovered=await client.reconcile(saved,saved.intents[0].id);assert.deepEqual(recovered,saved.intents[0].receipt);
  const completed=await new AutonomousLoop(store,adapter,()=>1000000).run(job.tenant,job.id);assert.equal(completed.state,'completed');assert.deepEqual(calls,scenario==='tool-error'?['bad','corrected']:['corrected']);assert.equal(completed.modelRequests,4);assert.equal(completed.spent.sol,'0');assert.equal(completed.intents.length,2);assert.equal(autonomousReceiptOutcome(completed.intents[1].receipt!),'success');
 }finally{journal.close();await handler.close();await new Promise<void>(resolve=>http.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
