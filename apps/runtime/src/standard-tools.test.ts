import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateKeyPairSigner } from '@solana/kit';
import { parseStandardTools } from './standard-tools.js';
import { HeadlessJournal } from './headless-journal.js';
import { HeadlessSkillExecutor } from './headless-executor.js';
import type { AutonomousJob } from './autonomous-loop.js';
test('ordinary x402 custody is explicit and limited to USDC x402 tools',()=>{
 const tool={id:'http:public',protocol:'x402',endpoint:'https://example.com/data',recipient:'A'.repeat(32),asset:'USDC',amount:'1000'};
 assert.equal(parseStandardTools(JSON.stringify([tool]))[0].x402Mode,undefined);
 assert.equal(parseStandardTools(JSON.stringify([{...tool,x402Mode:'prefunded'}]))[0].x402Mode,'prefunded');
 for(const changed of [{asset:'SOL'},{protocol:'mpp'},{x402Mode:'unknown'}])assert.throws(()=>parseStandardTools(JSON.stringify([{...tool,x402Mode:'prefunded',...changed}])));
});
test('tenant custody opt-in is checked before network or signing and original results expose both proofs',async()=>{
 const signer=await generateKeyPairSigner(),payer=await generateKeyPairSigner(),root=await mkdtemp(join(tmpdir(),'agentos-custody-scope-')),journal=new HeadlessJournal(join(root,'journal.sqlite'));
 const tool=parseStandardTools(JSON.stringify([{id:'http:public',protocol:'x402',x402Mode:'prefunded',endpoint:'https://example.com/data',recipient:payer.address,asset:'USDC',amount:'1000'}]))[0];
 const limits={sol:'0',usdc:'1000',maxCycles:2,maxActions:2,maxModelRequests:4,tools:[tool.id]},action={key:'payment',tool:tool.id,input:'{}',asset:'USDC' as const,amount:'1000'},intentId=randomUUID();
 const job:AutonomousJob={version:1,id:randomUUID(),tenant:'owner',goal:'Read public source',agent:payer.address,session:signer.address,program:payer.address,genesis:payer.address,state:'executing',limits:{...limits,deadline:Math.floor(Date.now()/1000)+600},spent:{sol:'0',usdc:'1000'},cycle:1,modelRequests:1,intents:[{id:intentId,action,phase:'reserved',executionId:'0',cycle:1}],pending:[],evaluations:[]};
 let calls=0;const options={program:job.program,genesis:job.genesis,rpc:async()=>{calls++;throw new Error('No network permitted before custody approval.');},feePayer:payer,signers:new Map([['owner',signer]]),tenants:[{tenant:'owner',tokenSha256:'a'.repeat(64),agent:job.agent,session:job.session,maxDurationSeconds:600,limits}],tools:new Map<string,string>(),standardTools:new Map([[tool.id,tool]]),journal};
 const executor=new HeadlessSkillExecutor(options);
 try{
  await assert.rejects(executor.execute(job,action,intentId),/has not enabled/);assert.equal(calls,0);assert.equal(journal.load(job.tenant,job.id,intentId),null);
  journal.save({tenant:job.tenant,jobId:job.id,intentId,scopeHash:'a'.repeat(64),execution:payer.address,complete:true,funding:{wire:'funding',signature:'b'.repeat(64)},payment:{wire:'settlement',signature:'c'.repeat(64)},content:'public answer',result:{wire:'result',signature:'d'.repeat(64)}});
  const result=executor.result(job.tenant,job.id,intentId);assert.equal(result?.fundingSignature,'b'.repeat(64));assert.equal(result?.paymentSignature,'c'.repeat(64));assert.equal(calls,0);
 }finally{journal.close();await rm(root,{recursive:true,force:true});}
});

test('cached response recovery requires explicit operator configuration for either protocol',()=>{
 const tool={id:'http:cache',protocol:'x402',endpoint:'https://example.com/data',recipient:'A'.repeat(32),asset:'USDC',amount:'1000'};
 assert.equal(parseStandardTools(JSON.stringify([tool]))[0].recoverResponse,undefined);
 assert.equal(parseStandardTools(JSON.stringify([{...tool,recoverResponse:true}]))[0].recoverResponse,true);
 assert.equal(parseStandardTools(JSON.stringify([{...tool,protocol:'mpp',recoverResponse:true}]))[0].recoverResponse,true);
 assert.throws(()=>parseStandardTools(JSON.stringify([{...tool,recoverResponse:'yes'}])));
});
