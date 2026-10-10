import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AutonomousLoop,FileAutonomousStore,type AutonomousAdapter,type AutonomousReceipt } from './autonomous-loop.js';
const receipt=(output:string):AutonomousReceipt=>({id:output,output,outputHash:createHash('sha256').update(output).digest('hex'),verified:true});
const input={tenant:'owner',goal:'Complete two research passes',agent:'A'.repeat(32),session:'B'.repeat(32),program:'C'.repeat(32),genesis:'D'.repeat(32),limits:{sol:'2',usdc:'0',maxCycles:3,maxActions:3,maxModelRequests:6,deadline:2000,tools:['research']}};
test('evaluates real outputs, replans with history and completes within the gross budget',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-loop-'));let executions=0,validations=0;
 const adapter:AutonomousAdapter={validate:async()=>{validations++;},plan:async job=>[{key:'pass-'+job.cycle,tool:'research',input:job.goal,asset:'SOL',amount:'1'}],execute:async()=>receipt('output-'+(++executions)),reconcile:async()=>null,evaluate:async job=>({complete:job.intents.length===2,feedback:job.intents.length===2?'Complete answer':'Need a second source'})};
 try{const loop=new AutonomousLoop(new FileAutonomousStore(root),adapter,()=>1000000);const job=await loop.create(input);const [a,b]=await Promise.all([loop.run(job.tenant,job.id),loop.run(job.tenant,job.id)]);assert.equal(a.state,'completed');assert.equal(b.state,'completed');assert.equal(a.cycle,2);assert.equal(a.spent.sol,'2');assert.equal(executions,2);assert.ok(validations>=5);assert.equal((await loop.run(job.tenant,job.id)).answer,'Complete answer');assert.equal(executions,2);}finally{await rm(root,{recursive:true,force:true});}
});
test('failed model requests retain their quota and stop after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-loop-'));let calls=0;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>{calls++;throw new Error('Model timed out');},execute:async()=>receipt('unused'),reconcile:async()=>null,evaluate:async()=>({complete:true,feedback:'unused'})};
 try{const store=new FileAutonomousStore(root),job=await new AutonomousLoop(store,adapter,()=>1000000).create({...input,limits:{...input.limits,maxModelRequests:1}});await assert.rejects(()=>new AutonomousLoop(store,adapter,()=>1000000).run(job.tenant,job.id),/timed out/);assert.equal((await store.load(job.tenant,job.id)).modelRequests,1);const stopped=await new AutonomousLoop(store,adapter,()=>1000000).run(job.tenant,job.id);assert.equal(stopped.state,'failed');assert.equal(stopped.failure,'limit');assert.equal(calls,1);}finally{await rm(root,{recursive:true,force:true});}
});
test('ambiguous paid effects survive restart and cannot execute twice',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-loop-'));let executions=0,allocations=0,recovered:AutonomousReceipt|null=null;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[{key:'source',tool:'research',input:'Public query',asset:'SOL',amount:'1'}],prepare:async()=>{allocations++;return {executionId:'41'};},execute:async job=>{assert.equal(job.intents[0].executionId,'41');executions++;throw new Error('Response lost after payment');},reconcile:async job=>{assert.equal(job.intents[0].executionId,'41');assert.equal(allocations,1);return recovered;},evaluate:async()=>({complete:true,feedback:'Recovered answer'})};
 try{const store=new FileAutonomousStore(root),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create(input);assert.equal((await loop.run(job.tenant,job.id)).state,'needs_reconciliation');const restarted=new AutonomousLoop(store,adapter,()=>1000000);assert.equal((await restarted.run(job.tenant,job.id)).state,'needs_reconciliation');assert.equal(executions,1);recovered=receipt('Original response');assert.equal((await restarted.run(job.tenant,job.id)).state,'completed');assert.equal(executions,1);}finally{await rm(root,{recursive:true,force:true});}
});
test('replanning cannot repeat a paid action or exceed the authorized budget',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-loop-'));let executions=0;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[{key:'same-action',tool:'research',input:'query',asset:'SOL',amount:'1'}],execute:async()=>{executions++;return receipt('Original');},reconcile:async()=>null,evaluate:async()=>({complete:false,feedback:'Need more evidence'})};
 try{const loop=new AutonomousLoop(new FileAutonomousStore(root),adapter,()=>1000000),job=await loop.create(input);await assert.rejects(()=>loop.run(job.tenant,job.id),/duplicates/);assert.equal(executions,1);adapter.plan=async()=>[{key:'different',tool:'research',input:'query',asset:'SOL',amount:'2'}];await assert.rejects(()=>loop.run(job.tenant,job.id),/remaining authorization/);assert.equal(executions,1);}finally{await rm(root,{recursive:true,force:true});}
});
test('expired authorization still reconciles the original effect without planning or executing again',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-loop-expired-'));let now=1000000,executions=0,recovered:AutonomousReceipt|null=null;
 const adapter:AutonomousAdapter={validate:async()=>{assert.ok(now<2000000,'Expired execution must not be authorized');},plan:async()=>[{key:'source',tool:'research',input:'query',asset:'SOL',amount:'1'}],execute:async()=>{executions++;throw new Error('Lost paid response');},reconcile:async()=>recovered,evaluate:async()=>{throw new Error('Expired work cannot spend another model request');}};
 try{const store=new FileAutonomousStore(root),loop=new AutonomousLoop(store,adapter,()=>now),job=await loop.create(input);assert.equal((await loop.run(job.tenant,job.id)).state,'needs_reconciliation');now=2001000;
 assert.equal((await loop.run(job.tenant,job.id)).state,'needs_reconciliation');recovered=receipt('Original paid output');const stopped=await loop.run(job.tenant,job.id);assert.equal(stopped.state,'failed');assert.equal(stopped.failure,'limit');assert.equal(stopped.intents[0].phase,'complete');assert.equal(stopped.modelRequests,1);assert.equal(executions,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('combined evaluation persists its next plan across restart and counts three model calls for two cycles',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-combined-loop-'));let plans=0,evaluations=0,executions=0,interrupt=true;
 class CheckpointStore extends FileAutonomousStore { override async save(job:Parameters<FileAutonomousStore['save']>[0]){await super.save(job);if(interrupt&&job.state==='planning'&&job.nextPlan?.length){interrupt=false;throw new Error('Interrupted after next-plan checkpoint');}} }
 const first={key:'first',tool:'research',input:'accounts',asset:'SOL' as const,amount:'1'},second={...first,key:'second',input:'fees'};
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>{plans++;return [first];},execute:async()=>receipt('result-'+(++executions)),reconcile:async()=>null,evaluate:async job=>{evaluations++;return job.intents.length===1?{complete:false,feedback:'Need fee source',nextPlan:[second]}:{complete:true,feedback:'Both sources verified'};}};
 try{const store=new CheckpointStore(root),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create({...input,limits:{...input.limits,maxCycles:2,maxModelRequests:3}});
 await assert.rejects(loop.run(job.tenant,job.id),/checkpoint/);const saved=await store.load(job.tenant,job.id);assert.equal(saved.modelRequests,2);assert.deepEqual(saved.nextPlan,[second]);
 const completed=await new AutonomousLoop(store,adapter,()=>1000000).run(job.tenant,job.id);assert.equal(completed.state,'completed');assert.equal(completed.cycle,2);assert.equal(completed.modelRequests,3);assert.equal(plans,1);assert.equal(evaluations,2);assert.equal(executions,2);assert.equal(completed.spent.sol,'2');assert.equal(completed.nextPlan,undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('combined plans retain duplicate, budget and fresh execution-permission checks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-combined-guards-'));let executions=0;
 const first={key:'first',tool:'research',input:'accounts',asset:'SOL' as const,amount:'1'};
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[first],execute:async()=>receipt('result-'+(++executions)),reconcile:async()=>null,evaluate:async()=>({complete:false,feedback:'Another source',nextPlan:[first]})};
 try{const store=new FileAutonomousStore(root),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create(input);await assert.rejects(loop.run(job.tenant,job.id),/duplicates/);assert.equal(executions,1);
 const other=await loop.create(input);adapter.evaluate=async()=>({complete:false,feedback:'Too expensive',nextPlan:[{...first,key:'other',amount:'2'}]});await assert.rejects(loop.run(other.tenant,other.id),/remaining authorization/);assert.equal(executions,2);
 const revoked=await loop.create(input);adapter.evaluate=async()=>({complete:false,feedback:'New source',nextPlan:[{...first,key:'other',input:'fees'}]});adapter.validate=async(_job,action)=>{if(action?.input==='fees')throw new Error('Fresh permission revoked');};await assert.rejects(loop.run(revoked.tenant,revoked.id),/revoked/);assert.equal(executions,3);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a tool finishing after the deadline retains its receipt without dispatching evaluation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-late-tool-'));let now=1000000,evaluations=0;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[{key:'source',tool:'research',input:'query',asset:'SOL',amount:'1'}],execute:async()=>{now=2001000;return receipt('Original late output');},reconcile:async()=>null,evaluate:async()=>{evaluations++;return {complete:true,feedback:'Forbidden late request'};}};
 try{const store=new FileAutonomousStore(root),loop=new AutonomousLoop(store,adapter,()=>now),job=await loop.create(input),stopped=await loop.run(job.tenant,job.id);assert.equal(stopped.state,'failed');assert.equal(stopped.failure,'limit');assert.equal(stopped.intents[0].phase,'complete');assert.equal(stopped.modelRequests,1);assert.equal(evaluations,0);}finally{await rm(root,{recursive:true,force:true});}
});
