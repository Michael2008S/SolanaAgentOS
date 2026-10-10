import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadlessJournal } from './headless-journal.js';
import { JudgeJobQueue, judgeQueueIdentity } from './judge-jobs.js';
import { importJudgeReview } from './judge-review.js';
import { canonicalJson } from './canonical-json.js';
const key='11111111111111111111111111111111',hash=(text:string)=>createHash('sha256').update(text).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'judge-review-')),file=join(root,'jobs.sqlite');let journal=new HeadlessJournal(file),models=0,sends=0,preflights=0;
 const task='Review the supplied quotation.',result='Solana uses accounts.',scope={tenant:'judge',judgeAgent:key,escrow:key,taskHash:hash(task)},profiles=[{tenant:scope.tenant,judgeAgent:key,escrows:[{escrow:key,taskHash:scope.taskHash}]}],judgment={verdict:'pass' as const,confidence:1,summary:'Operator verified the supplied quotation',checks:[{criterion:'Quotation matches',status:'met' as const,evidence:result}],limitations:[]},input={tenant:'judge',escrow:key,taskHash:scope.taskHash,resultHash:hash(result),judgment};
 const review={reviewId:randomUUID(),program:key,genesis:key,judgeAgent:key,reviewer:'Local test operator',reason:'Model output was interrupted',expiresAt:100,input};
 const deps={program:key,genesis:key,profiles,lookup:async()=>({task,result,resultHash:hash(result)}),preflight:async()=>{preflights++;},assess:async()=>{models++;throw new Error('Model output lost');},send:async(raw:any)=>{sends++;const {judgment,...fields}=raw;return {...fields,decision:key,judgmentHash:hash(canonicalJson(judgment)),verdict:judgment.verdict,signature:'1'.repeat(64),commitment:'finalized' as const};},verify:async()=>{},now:()=>1000};
 let queue=new JudgeJobQueue({...deps,journal});
 const options=()=>({...deps,journal});
 const restart=async()=>{await queue.stop();journal.close();journal=new HeadlessJournal(file);queue=new JudgeJobQueue({...deps,journal});};
 const reserve=async()=>{await queue.start();await queue.scan();assert.equal(queue.status()[0].state,'needs_review');await queue.stop();};
 const {jobId,scopeHash,intent}=judgeQueueIdentity(key,key,scope);
 return {review,input,deps,options,reserve,restart,get queue(){return queue;},get journal(){return journal;},row:(stage:string)=>journal.load('judge',jobId,intent(stage)),identity:{jobId,scopeHash,intent},counts:()=>({models,sends,preflights}),close:async()=>{await queue.stop();journal.close();await rm(root,{recursive:true,force:true});}};
}
test('operator review recovers an interrupted model without a second request and survives completed restart',async()=>{
 const f=await fixture();try{await f.reserve();assert.equal((await importJudgeReview(f.options(),f.review)).status,'imported');assert.equal(f.row('manual-review')?.content,canonicalJson(f.review));await f.restart();await f.queue.start();assert.equal(f.queue.status()[0].state,'recorded');assert.equal(f.counts().models,1);assert.equal(f.counts().sends,1);await f.queue.stop();assert.equal((await importJudgeReview({...f.options(),now:()=>200000},f.review)).status,'already_imported');await assert.rejects(importJudgeReview(f.options(),{...f.review,reason:'Replace earlier review'}),/replaced/);await f.restart();await f.queue.start();assert.equal(f.counts().sends,1);assert.equal(f.counts().models,1);}finally{await f.close();}
});
test('review requires the interrupted reservation and exact scope, result, evidence and unexpired authority',async()=>{
 const f=await fixture();try{await assert.rejects(importJudgeReview(f.options(),f.review),/reservation/);await f.reserve();for(const raw of [{...f.review,genesis:'SysvarRent111111111111111111111111111111111'},{...f.review,input:{...f.input,resultHash:'a'.repeat(64)}},{...f.review,expiresAt:1},{...f.review,input:{...f.input,judgment:{...f.input.judgment,checks:[{criterion:'Quote',status:'met',evidence:'Invented quote'}]}}}])await assert.rejects(importJudgeReview(f.options(),raw));assert.equal(f.row('assessment'),null);assert.equal(f.row('manual-review'),null);f.deps.preflight=async()=>{throw new Error('Revoked delegation');};await assert.rejects(importJudgeReview(f.options(),f.review),/Revoked/);assert.equal(f.row('manual-review'),null);assert.equal(f.counts().sends,0);}finally{await f.close();}
});
test('review cannot replace an existing assessment or reset exhausted record attempts',async()=>{
 const f=await fixture();try{await f.reserve();const {jobId,scopeHash,intent}=f.identity;for(const responseRecoveries of [0,1,2,3])f.journal.save({tenant:'judge',jobId,intentId:intent('assessment'),scopeHash,execution:key,content:canonicalJson(f.input),responseRecoveries,complete:false});await assert.rejects(importJudgeReview(f.options(),f.review),/Existing assessment/);await f.restart();await f.queue.start();assert.equal(f.queue.status()[0].state,'needs_review');assert.equal(f.queue.status()[0].attempts,3);assert.equal(f.counts().sends,0);}finally{await f.close();}
});
test('interrupted audit write only accepts the same review after another live preflight',async()=>{
 const f=await fixture();try{await f.reserve();const {jobId,scopeHash,intent}=f.identity;f.journal.save({tenant:'judge',jobId,intentId:intent('manual-review'),scopeHash,execution:key,content:canonicalJson(f.review),complete:true});await assert.rejects(importJudgeReview(f.options(),{...f.review,reviewId:randomUUID()}),/replaced/);assert.equal((await importJudgeReview(f.options(),f.review)).status,'imported');assert.equal(f.row('assessment')?.content,canonicalJson(f.input));assert.equal(f.counts().preflights,2);}finally{await f.close();}
});
