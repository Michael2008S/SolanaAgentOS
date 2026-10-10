import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,readFile,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AutonomousLoop } from './autonomous-loop.js';
import { SQLiteAutonomousStore } from './autonomous-sqlite.js';
import { RemoteAutonomousStore } from './remote-autonomous-store.js';
import { AutonomousCoordinator } from './autonomous-coordination.js';
import { operatorJobReview,operatorScopeHash } from './autonomous-operator.js';
const exec=promisify(execFile),input={tenant:'owner',goal:'Obtain public research',agent:'A'.repeat(32),session:'B'.repeat(32),program:'C'.repeat(32),genesis:'D'.repeat(32),limits:{sol:'2',usdc:'0',maxCycles:3,maxActions:3,maxModelRequests:6,deadline:2000,tools:['research']}},adapter={validate:async()=>{}} as any;
async function fixture(){const root=await mkdtemp(join(tmpdir(),'agentos-operator-')),file=join(root,'jobs.sqlite'),store=new SQLiteAutonomousStore(file),job=await new AutonomousLoop(store,adapter,()=>1000000).create(input);return {root,file,store,job,close:async()=>{store.close();await rm(root,{recursive:true,force:true});}};}
test('reviewed cancellation is atomic, scoped, durable, idempotent and leaves a running lease intact',async()=>{
 const f=await fixture(),reader=new SQLiteAutonomousStore(f.file);let release:(()=>Promise<void>)|undefined;
 try{
  const review=operatorJobReview(f.job);release=await f.store.acquire('owner',f.job.id);const advanced={...f.job,cycle:1,modelRequests:1};await f.store.save(advanced);assert.equal(operatorScopeHash(advanced),review.request.scopeHash);
  const result=await reader.reviewedCancellation(review.request);assert.equal(result.idempotent,false);assert.equal(result.audit.stateBefore,'planning');assert.equal(result.audit.request.operationId,review.request.operationId);assert.equal(result.onChainAuthorityChanged,false);assert.equal(await f.store.cancelled('owner',f.job.id),true);
  await f.store.save({...advanced,state:'cancelled'});assert.equal((await reader.reviewedCancellation(review.request)).idempotent,true);
  const reopen=new SQLiteAutonomousStore(f.file);try{assert.deepEqual(await reopen.cancellationHistory('owner',f.job.id),result.audit);assert.deepEqual((await reopen.reviewedCancellation(review.request)).audit,result.audit);}finally{reopen.close();}
  await assert.rejects(reader.reviewedCancellation({...review.request,reason:'Changed retry'}));await assert.rejects(reader.reviewedCancellation({...review.request,operationId:randomUUID()}));assert.equal((await f.store.load('owner',f.job.id)).modelRequests,1);
 }finally{await release?.();reader.close();await f.close();}
});
test('wrong scope, different tenant/job, unreviewed fields and terminal targets cannot set a cancellation',async()=>{
 const f=await fixture();try{const request=operatorJobReview(f.job).request;
  for(const changed of [{scopeHash:'f'.repeat(64)},{tenant:'other'},{id:randomUUID()},{actor:'Bad\nactor'},{reason:''},{session:'E'.repeat(32)}])await assert.rejects(f.store.reviewedCancellation({...request,...changed}));
  assert.equal(await f.store.cancelled('owner',f.job.id),false);assert.equal(await f.store.cancellationHistory('owner',f.job.id),null);
  const release=await f.store.acquire('owner',f.job.id);await f.store.save({...f.job,state:'completed'});await release();await assert.rejects(f.store.reviewedCancellation(request),/terminal/);assert.equal(await f.store.cancelled('owner',f.job.id),false);
 }finally{await f.close();}
});
test('separate operator CLI reviews, cancels and reads the original job without a tenant credential',async()=>{
 const f=await fixture(),reviewFile=join(f.root,'review.json'),env={...process.env,AGENTOS_TASK_COORDINATOR:'',AGENTOS_AUTONOMOUS_DATABASE_PATH:f.file};
 const run=(...args:string[])=>exec(process.execPath,['--import','tsx','apps/runtime/src/manage-autonomous-jobs.ts',...args],{env});
 try{const reviewed=JSON.parse((await run('review','owner',f.job.id,reviewFile)).stdout);assert.equal(reviewed.scope.agent,f.job.agent);assert.equal((await stat(reviewFile)).mode&0o777,0o600);const request=JSON.parse(await readFile(reviewFile,'utf8'));assert.equal(request.scopeHash,operatorScopeHash(f.job));
  const first=JSON.parse((await run('cancel',reviewFile)).stdout),retry=JSON.parse((await run('cancel',reviewFile)).stdout);assert.equal(first.idempotent,false);assert.equal(retry.idempotent,true);assert.deepEqual(first.audit,retry.audit);const viewed=JSON.parse((await run('view','owner',f.job.id)).stdout);assert.equal(viewed.cancellationRequested,true);assert.deepEqual(viewed.audit,first.audit);
  await writeFile(reviewFile,JSON.stringify({...request,scopeHash:'f'.repeat(64)}));await assert.rejects(run('cancel',reviewFile));await assert.rejects(run('review','owner',f.job.id,reviewFile));
 }finally{await f.close();}
});
test('central coordinator persists reviewed cancellation and rejects mismatched remote identity',async()=>{
 const f=await fixture(),scope={tenant:'owner',tokenSha256:'a'.repeat(64),agent:input.agent,session:input.session,maxDurationSeconds:1000,limits:input.limits},coordinator=new AutonomousCoordinator(f.store,[scope],input,()=>1000000);
 const transport=(async(_url,options)=>{try{return Response.json(await coordinator.dispatch(JSON.parse(String(options?.body))));}catch{return Response.json({},{status:422});}}) as typeof fetch,remote=new RemoteAutonomousStore('http://127.0.0.1:8791','x'.repeat(32),transport);
 try{const request=operatorJobReview(await remote.load('owner',f.job.id)).request;await assert.rejects(coordinator.dispatch({op:'cancel-reviewed',tenant:'owner',id:randomUUID(),cancellation:request}));assert.equal(await remote.cancelled('owner',f.job.id),false);const result=await remote.reviewedCancellation(request);assert.equal(result.cancellationRequested,true);assert.deepEqual(await remote.cancellationHistory('owner',f.job.id),result.audit);assert.equal((await remote.reviewedCancellation(request)).idempotent,true);await assert.rejects(remote.cancellationHistory('other',f.job.id));
 }finally{await coordinator.close();await f.close();}
});
