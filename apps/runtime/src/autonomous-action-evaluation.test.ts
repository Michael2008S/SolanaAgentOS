import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutonomousLoop, FileAutonomousStore, type AutonomousAdapter, type AutonomousJob } from './autonomous-loop.js';

const input={tenant:'owner',goal:'Research using the evidence obtained',agent:'A'.repeat(32),session:'B'.repeat(32),program:'C'.repeat(32),genesis:'D'.repeat(32),limits:{sol:'3',usdc:'0',maxCycles:3,maxActions:3,maxModelRequests:6,deadline:2000,tools:['research']}};
const action=(key:string)=>({key,tool:'research',input:key,asset:'SOL' as const,amount:'1'});
const receipt=(output:string)=>({id:output,output,outputHash:createHash('sha256').update(output).digest('hex'),verified:true as const});

test('first result replans before stale later proposals can execute or reserve funds',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-action-evaluation-')),calls:string[]=[];
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[action('first'),action('stale')],execute:async(_job,a)=>{calls.push(a.key);return receipt(a.key);},reconcile:async()=>null,evaluate:async job=>job.intents.length===1?{complete:false,feedback:'The first source requires a different follow-up',nextPlan:[action('fresh')]}:{complete:true,feedback:'Fresh evidence answers the goal'}};
 try{const store=new FileAutonomousStore(root),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create(input),completed=await loop.run(job.tenant,job.id);assert.equal(job.evaluationMode,'after_action');assert.deepEqual(calls,['first','fresh']);assert.equal(completed.state,'completed');assert.equal(completed.spent.sol,'2');assert.equal(completed.modelRequests,3);assert.equal(completed.evaluations.length,2);assert.deepEqual(completed.pending,[]);assert.ok(!completed.intents.some(i=>i.action.key==='stale'));}finally{await rm(root,{recursive:true,force:true});}
});

test('completion after the first verified action discards unexecuted proposals',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-action-complete-'));let calls=0;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[action('first'),action('unnecessary')],execute:async()=>{calls++;return receipt('Enough evidence');},reconcile:async()=>null,evaluate:async()=>({complete:true,feedback:'The first result fulfils the goal'})};
 try{const store=new FileAutonomousStore(root),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create(input),completed=await loop.run(job.tenant,job.id);assert.equal(completed.state,'completed');assert.equal(completed.spent.sol,'1');assert.equal(completed.modelRequests,2);assert.deepEqual(completed.pending,[]);await new AutonomousLoop(store,adapter,()=>1000000).run(job.tenant,job.id);assert.equal(calls,1);}finally{await rm(root,{recursive:true,force:true});}
});

test('unknown original effect is reconciled and evaluated before any remaining proposal after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-action-recovery-'));let executions=0,original=false;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[action('first'),action('stale')],execute:async()=>{executions++;throw new Error('Original response unknown');},reconcile:async()=>original?receipt('Original verified evidence'):null,evaluate:async job=>{assert.equal(job.intents.length,1);assert.equal(job.intents[0].receipt?.output,'Original verified evidence');return {complete:true,feedback:'Original result is sufficient'};}};
 try{const store=new FileAutonomousStore(root),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create(input);assert.equal((await loop.run(job.tenant,job.id)).state,'needs_reconciliation');original=true;const completed=await new AutonomousLoop(store,adapter,()=>1000000).run(job.tenant,job.id);assert.equal(completed.state,'completed');assert.equal(executions,1);assert.equal(completed.spent.sol,'1');assert.deepEqual(completed.pending,[]);}finally{await rm(root,{recursive:true,force:true});}
});

test('a persisted post-action checkpoint restarts at evaluation without running the old tail',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-action-checkpoint-'));let interrupt=true,calls=0;
 class CheckpointStore extends FileAutonomousStore{override async save(job:AutonomousJob){await super.save(job);if(interrupt&&job.state==='evaluating'&&job.intents[0]?.phase==='complete'){interrupt=false;throw new Error('Stopped after action checkpoint');}}}
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[action('first'),action('stale')],execute:async()=>{calls++;return receipt('Original');},reconcile:async()=>null,evaluate:async()=>({complete:true,feedback:'Original evidence answers the goal'})};
 try{const store=new CheckpointStore(root),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create(input);await assert.rejects(loop.run(job.tenant,job.id),/checkpoint/);const saved=await store.load(job.tenant,job.id);assert.equal(saved.state,'evaluating');assert.equal(saved.pending[0].key,'stale');assert.equal(saved.modelRequests,1);const completed=await new AutonomousLoop(store,adapter,()=>1000000).run(job.tenant,job.id);assert.equal(completed.state,'completed');assert.equal(calls,1);assert.equal(completed.modelRequests,2);}finally{await rm(root,{recursive:true,force:true});}
});

test('legacy jobs keep their recorded batch evaluation behavior',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-action-legacy-'));let calls=0;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[action('first'),action('second')],execute:async()=>receipt('result-'+(++calls)),reconcile:async()=>null,evaluate:async job=>{assert.equal(job.intents.length,2);return {complete:true,feedback:'Both original batch actions were evaluated'};}};
 try{const store=new FileAutonomousStore(root),loop=new AutonomousLoop(store,adapter,()=>1000000),created=await loop.create(input),{evaluationMode,...legacy}=created;await store.save(legacy);const completed=await new AutonomousLoop(store,adapter,()=>1000000).run(created.tenant,created.id);assert.equal(completed.state,'completed');assert.equal(calls,2);assert.equal(completed.evaluationMode,undefined);assert.equal(completed.modelRequests,2);}finally{await rm(root,{recursive:true,force:true});}
});

test('exhausted model allowance stops before stale proposals and cannot reset on restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-action-limit-'));let calls=0,evaluations=0;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[action('first'),action('stale')],execute:async()=>{calls++;return receipt('First evidence');},reconcile:async()=>null,evaluate:async()=>{evaluations++;return {complete:true,feedback:'Must not be called'};}};
 try{const store=new FileAutonomousStore(root),loop=new AutonomousLoop(store,adapter,()=>1000000),job=await loop.create({...input,limits:{...input.limits,maxModelRequests:1}}),stopped=await loop.run(job.tenant,job.id);assert.equal(stopped.state,'failed');assert.equal(stopped.failure,'limit');assert.equal(stopped.modelRequests,1);assert.equal(stopped.intents.length,1);assert.equal(stopped.spent.sol,'1');await new AutonomousLoop(store,adapter,()=>1000000).run(job.tenant,job.id);assert.equal(calls,1);assert.equal(evaluations,0);}finally{await rm(root,{recursive:true,force:true});}
});
