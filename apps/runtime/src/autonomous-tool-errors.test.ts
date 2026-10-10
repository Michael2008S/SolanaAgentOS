import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutonomousLoop,FileAutonomousStore,type AutonomousAdapter,type AutonomousReceipt } from './autonomous-loop.js';
import { autonomousReceiptOutcome } from './autonomous-receipt.js';
import { missingAutonomousAcceptance } from './autonomous-acceptance.js';
const input={tenant:'owner',goal:'Complete research after a source error',agent:'A'.repeat(32),session:'B'.repeat(32),program:'C'.repeat(32),genesis:'D'.repeat(32),limits:{sol:'2',usdc:'0',maxCycles:2,maxActions:3,maxModelRequests:4,deadline:2000,tools:['research']}};
const action=(key:string)=>({key,tool:'research',input:key,asset:'SOL' as const,amount:'1'});
const receipt=(text:string,error=false):AutonomousReceipt=>({id:'receipt',output:text,outputHash:createHash('sha256').update(text).digest('hex'),verified:true,...(error?{outcome:'error' as const}:{})});
test('confirmed tool error discards stale pending calls and replans within original gross limits',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agentos-tool-errors-'));const calls:string[]=[];
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async job=>job.cycle===1?[action('bad'),action('stale')]:[action('corrected')],execute:async(_job,action)=>{calls.push(action.key);return receipt(action.key,action.key==='bad');},reconcile:async()=>null,evaluate:async job=>{assert.deepEqual(job.pending,[]);return {complete:job.cycle===2,feedback:job.cycle===1?'Source rejected the request; need corrected input':'Supported answer'};}};
 try{const loop=new AutonomousLoop(new FileAutonomousStore(directory),adapter,()=>1000000),job=await loop.create(input),done=await loop.run(job.tenant,job.id);assert.equal(done.state,'completed');assert.deepEqual(calls,['bad','corrected']);assert.equal(done.spent.sol,'2');assert.equal(done.modelRequests,4);assert.equal(done.intents[0].receipt?.outcome,'error');assert.equal(done.intents[0].phase,'complete');assert.deepEqual(done.intents.map(intent=>intent.cycle),[1,2]);}
 finally{await rm(directory,{recursive:true,force:true});}
});
test('restart at either error checkpoint or corrected-plan checkpoint never replays the failed call or drops the new plan',async()=>{
 for(const interruptAt of ['error','plan']){
  const directory=await mkdtemp(join(tmpdir(),'agentos-error-restart-'));let interrupted=false;const calls:string[]=[];
  class InterruptStore extends FileAutonomousStore {override async save(job:Parameters<FileAutonomousStore['save']>[0]){await super.save(job);if(!interrupted&&(interruptAt==='error'?job.state==='evaluating'&&job.intents[0]?.receipt?.outcome==='error':job.state==='executing'&&job.cycle===2)){interrupted=true;throw new Error('checkpoint interrupt');}}}
  const adapter:AutonomousAdapter={validate:async()=>{},plan:async job=>[action(job.cycle===1?'bad':'corrected')],execute:async(_job,action)=>{calls.push(action.key);return receipt(action.key,action.key==='bad');},reconcile:async()=>null,evaluate:async job=>({complete:job.cycle===2,feedback:job.cycle===1?'Need corrected input':'Supported answer'})};
  try{const store=new InterruptStore(directory),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create(input);await assert.rejects(loop.run(job.tenant,job.id),/checkpoint interrupt/);const done=await new AutonomousLoop(store,adapter,()=>1000000).run(job.tenant,job.id);assert.equal(done.state,'completed');assert.deepEqual(calls,['bad','corrected']);assert.equal(done.modelRequests,4);assert.equal(done.spent.sol,'2');}
  finally{await rm(directory,{recursive:true,force:true});}
 }
});
test('ambiguous effect pauses, then original error response resumes evaluation without executing stale calls',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agentos-error-reconcile-'));let original:AutonomousReceipt|null=null,calls=0;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[action('bad'),action('stale')],execute:async()=>{calls++;throw new Error('Response lost');},reconcile:async()=>original,evaluate:async()=>({complete:true,feedback:'Source returned a confirmed error; diagnostic goal answered'})};
 try{const store=new FileAutonomousStore(directory),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create(input);assert.equal((await loop.run(job.tenant,job.id)).state,'needs_reconciliation');assert.equal((await loop.run(job.tenant,job.id)).state,'needs_reconciliation');assert.equal(calls,1);original=receipt('Confirmed error',true);const done=await new AutonomousLoop(store,adapter,()=>1000000).run(job.tenant,job.id);assert.equal(done.state,'completed');assert.equal(calls,1);assert.deepEqual(done.pending,[]);assert.equal(done.intents.length,1);}
 finally{await rm(directory,{recursive:true,force:true});}
});
test('error receipts and legacy MCP error envelopes cannot satisfy required successful tool evidence',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agentos-error-evidence-'));
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[],execute:async()=>receipt('unused'),reconcile:async()=>null,evaluate:async()=>({complete:true,feedback:'unused'})};
 try{const job=await new AutonomousLoop(new FileAutonomousStore(directory),adapter,()=>1000000).create({...input,acceptance:{answerIncludes:[],evidence:[{tool:'research',contains:['account fields']}]}});
 for(const result of [receipt('account fields',true),{...receipt(JSON.stringify({source:'mcp:public:research',assurance:'authenticated-mcp-response',result:{isError:true,content:[{type:'text',text:'account fields unavailable'}]}})),id:'mcp:legacy'}]){job.intents=[{id:job.id,phase:'complete',action:action('bad'),receipt:result}];assert.equal(autonomousReceiptOutcome(result),'error');assert.match(missingAutonomousAcceptance(job,'account fields').join(' '),/Verified evidence required/);}
 }finally{await rm(directory,{recursive:true,force:true});}
});
