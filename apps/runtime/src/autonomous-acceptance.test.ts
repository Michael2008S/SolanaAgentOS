import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutonomousLoop,FileAutonomousStore,type AutonomousAdapter } from './autonomous-loop.js';
import { SQLiteAutonomousStore } from './autonomous-sqlite.js';
import { autonomousAcceptanceSchema } from './autonomous-acceptance.js';
const input={tenant:'owner',goal:'Explain account fields',agent:'A'.repeat(32),session:'B'.repeat(32),program:'C'.repeat(32),genesis:'D'.repeat(32),limits:{sol:'0',usdc:'0',maxCycles:2,maxActions:2,maxModelRequests:4,deadline:2000,tools:['research']},acceptance:{answerIncludes:['lamports: balance'],evidence:[{tool:'research',contains:['lamports','balance']}]}};
const receipt=(output:string)=>({id:'source',output,outputHash:createHash('sha256').update(output).digest('hex'),verified:true as const});
function adapter():AutonomousAdapter{return {validate:async()=>{},plan:async job=>job.intents.length?[]:[{key:'first',tool:'research',input:'account fields',asset:'SOL',amount:'0'}],execute:async()=>receipt('lamports: balance'),reconcile:async()=>null,evaluate:async job=>({complete:true,feedback:job.cycle===1?'Only field names: lamports':'LAMPORTS: BALANCE'})};}
test('rejects premature completion, passes missing checks to replanning, and retains checks after restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agentos-checks-'));let stopped=false;
 class InterruptStore extends FileAutonomousStore {override async save(job:Parameters<FileAutonomousStore['save']>[0]){await super.save(job);if(!stopped&&job.state==='planning'&&job.evaluations.length){stopped=true;throw new Error('checkpoint interrupt');}}}
 try{const store=new InterruptStore(directory),a=adapter(),loop=new AutonomousLoop(store,a,()=>1000000),job=await loop.create(input);await assert.rejects(loop.run(job.tenant,job.id),/checkpoint interrupt/);const saved=await store.load(job.tenant,job.id);assert.equal(saved.answer,undefined);assert.equal(saved.evaluations[0].complete,false);assert.match(saved.evaluations[0].feedback,/Answer must include/);assert.deepEqual(saved.acceptance,input.acceptance);
 const plan=a.plan;a.plan=async job=>{assert.match(job.evaluations[0].feedback,/lamports: balance/);return plan(job);};const done=await new AutonomousLoop(store,a,()=>1000000).run(job.tenant,job.id);assert.equal(done.state,'completed');assert.equal(done.modelRequests,4);assert.equal(done.intents.length,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('missing actual tool evidence cannot be supplied by an answer and stops at the original quota',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agentos-evidence-checks-'));
 try{const a=adapter();a.execute=async()=>receipt('field names only');a.evaluate=async()=>({complete:true,feedback:'lamports: balance'});const store=new FileAutonomousStore(directory),loop=new AutonomousLoop(store,a,()=>1000000),job=await loop.create({...input,limits:{...input.limits,maxModelRequests:2}}),done=await loop.run(job.tenant,job.id);assert.equal(done.state,'failed');assert.equal(done.failure,'limit');assert.equal(done.answer,undefined);assert.equal(done.modelRequests,2);assert.match(done.evaluations[0].feedback,/Verified evidence required/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('rejects unauthorized evidence tools and empty or unbounded checks',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agentos-check-validation-'));
 try{const loop=new AutonomousLoop(new FileAutonomousStore(directory),adapter(),()=>1000000);await assert.rejects(loop.create({...input,acceptance:{answerIncludes:[],evidence:[{tool:'other',contains:[]}]}}),/unauthorized tool/);assert.equal(autonomousAcceptanceSchema.safeParse({answerIncludes:[' '],evidence:[]}).success,false);assert.equal(autonomousAcceptanceSchema.safeParse({answerIncludes:[],evidence:[]}).success,false);assert.equal(autonomousAcceptanceSchema.safeParse({answerIncludes:Array(21).fill('phrase'),evidence:[]}).success,false);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('durable stores refuse weakening completion checks after creation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agentos-check-immutable-')),store=new SQLiteAutonomousStore(join(directory,'jobs.sqlite'));
 try{const fileStore=new FileAutonomousStore(join(directory,'files')),fileJob=await new AutonomousLoop(fileStore,adapter(),()=>1000000).create(input);await assert.rejects(fileStore.save({...fileJob,acceptance:undefined}),/cannot change/);
 const loop=new AutonomousLoop(store,adapter(),()=>1000000),job=await loop.create(input),release=await store.acquire(job.tenant,job.id);try{await assert.rejects(store.save({...job,acceptance:{answerIncludes:['lamports'],evidence:[]}}),/cannot change/);assert.deepEqual((await store.load(job.tenant,job.id)).acceptance,input.acceptance);}finally{await release();}}
 finally{store.close();await rm(directory,{recursive:true,force:true});}
});
