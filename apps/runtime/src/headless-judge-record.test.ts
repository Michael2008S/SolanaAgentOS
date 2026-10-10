import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { address,generateKeyPairSigner,getAddressEncoder,getProgramDerivedAddress,type TransactionPartialSigner } from '@solana/kit';
import { HeadlessJournal } from './headless-journal.js';
import { HeadlessJudgeRecord } from './headless-judge-record.js';
import { judgeRecordInput,judgeRecordProfiles } from './judge-record-protocol.js';
const sha=(text:string)=>createHash('sha256').update(text).digest(),bytes=(key:string)=>Buffer.from(getAddressEncoder().encode(address(key)));
test('Judge signing requires live independent canonical parties, API delegation, accepted mandate and exact result',async()=>{
 const root=await mkdtemp(join(tmpdir(),'judge-record-unit-')),journal=new HeadlessJournal(join(root,'journal.sqlite'));
 try{
  const [program,employerOwner,workerOwner,judgeOwner,sessionKey,fee]=await Promise.all(Array.from({length:6},()=>generateKeyPairSigner()));const pda=(seeds:Uint8Array[])=>getProgramDerivedAddress({programAddress:program.address,seeds}),data=(name:string,n:number)=>{const d=Buffer.alloc(n);sha('account:'+name).subarray(0,8).copy(d);return d;};
  const parties=await Promise.all([employerOwner,workerOwner,judgeOwner].map(async(owner,index)=>{const id=Buffer.alloc(32);id[0]=index;const [key,bump]=await pda([Buffer.from('agent'),bytes(owner.address),id]),d=data('Agent',138);bytes(owner.address).copy(d,8);id.copy(d,40);d[121]=bump;return {key,d};}));const [employer,worker,judge]=parties;
  const [policy,pb]=await pda([Buffer.from('policy'),bytes(judge.key)]),[session,sb]=await pda([Buffer.from('session'),bytes(judge.key),bytes(sessionKey.address)]),[escrow,eb]=await pda([Buffer.from('escrow'),bytes(employer.key),Buffer.alloc(8)]),[mandate,mb]=await pda([Buffer.from('escrow_judge'),bytes(escrow)]),p=data('Policy',123),s=data('Session',147),e=data('Escrow',180),m=data('JudgeMandate',220),expiry=BigInt(Math.floor(Date.now()/1000)+600);
  bytes(judge.key).copy(p,8);p[72]=4;p[74]=pb;bytes(judge.key).copy(s,8);bytes(sessionKey.address).copy(s,40);s.writeBigInt64LE(expiry,72);s[104]=4;s[106]=sb;bytes(employer.key).copy(e,8);bytes(worker.key).copy(e,40);e.writeBigInt64LE(expiry,88);sha('task').copy(e,96);e[128]=1;sha('result').copy(e,129);e[162]=eb;bytes(escrow).copy(m,8);bytes(employer.key).copy(m,40);bytes(worker.key).copy(m,72);bytes(judge.key).copy(m,104);bytes(session).copy(m,136);sha('task').copy(m,168);m.writeBigInt64LE(expiry,200);m.writeBigInt64LE(expiry-600n,208);m[216]=1;m[219]=mb;
  const accounts=new Map([...parties.map(item=>[item.key,item.d] as const),[policy,p],[session,s],[escrow,e],[mandate,m]]);let signs=0,simulations=0,genesis=employerOwner.address;
  const signer:TransactionPartialSigner={address:sessionKey.address,signTransactions:async()=>{signs++;throw new Error('Rejected Judge cannot sign');}},feePayer:TransactionPartialSigner={address:fee.address,signTransactions:signer.signTransactions};
  const executor=new HeadlessJudgeRecord({program:program.address,genesis:employerOwner.address,feePayer,signers:new Map([['judge',signer]]),identities:[{tenant:'judge',agent:judge.key,session}],profiles:[{tenant:'judge',minimumConfidence:0.9,escrows:[{escrow,taskHash:sha('task').toString('hex')}]}],journal,rpc:async(method:string,params:unknown[])=>{if(method==='getGenesisHash')return genesis;if(method==='getAccountInfo'){const d=accounts.get(params[0] as any);return {value:d?{owner:program.address,data:[d.toString('base64'),'base64']}:null};}if(method==='getLatestBlockhash')return {value:{blockhash:employerOwner.address,lastValidBlockHeight:100}};if(method==='simulateTransaction'){simulations++;return {value:{err:'preflight-stop'}};}throw new Error('Rejected Judge cannot send');}});
  const input={tenant:'judge',escrow,taskHash:sha('task').toString('hex'),resultHash:sha('result').toString('hex'),judgment:{verdict:'pass' as const,confidence:0.95,summary:'Public fixture',checks:[{criterion:'Public task',status:'met' as const,evidence:'Public result'}],limitations:[]}};
  await assert.rejects(executor.execute(input),/simulation failed before signing/);assert.equal(simulations,1);
  for(const [d,i,v] of [[judge.d,104,1],[p,73,1],[p,72,0],[s,105,1],[s,104,0],[m,216,0],[m,217,1],[m,218,1],[m,219,mb^1],[e,128,0],[e,161,1],[e,162,eb^1]] as const){const old=d[i];d[i]=v;await assert.rejects(executor.execute(input));d[i]=old;}
  Buffer.from('AGTASK01').copy(s,115);await assert.rejects(executor.execute(input),/task-bound/);s.fill(0,115,123);
  m.writeBigInt64LE(1n,200);await assert.rejects(executor.execute(input),/mandate/);m.writeBigInt64LE(expiry,200);
  await assert.rejects(executor.execute({...input,resultHash:'a'.repeat(64)}),/result/);await assert.rejects(executor.execute({...input,judgment:{...input.judgment,confidence:0.5}}),/confidence/);
  const shared=Buffer.from(worker.d);bytes(employerOwner.address).copy(shared,8);const [sharedWorker,sharedBump]=await pda([Buffer.from('agent'),shared.subarray(8,40),shared.subarray(40,72)]);shared[121]=sharedBump;accounts.set(sharedWorker,shared);bytes(sharedWorker).copy(e,40);bytes(sharedWorker).copy(m,72);await assert.rejects(executor.execute(input),/independent/);bytes(worker.key).copy(e,40);bytes(worker.key).copy(m,72);
  genesis=program.address;await assert.rejects(executor.execute(input),/chain changed/);assert.equal(signs,0);assert.equal(simulations,1);
 }finally{journal.close();await rm(root,{recursive:true,force:true});}
});
test('Judge protocol bounds assessments and rejects ambiguous fixed scopes',()=>{
 const assessment={confidence:0.95,summary:'Public fixture',checks:[{criterion:'Public criterion',status:'unclear',evidence:'Insufficient evidence'}],limitations:[]};
 for(const verdict of ['pass','fail'])assert.equal(judgeRecordInput.safeParse({tenant:'judge',escrow:'11111111111111111111111111111111',taskHash:'a'.repeat(64),resultHash:'b'.repeat(64),judgment:{...assessment,verdict}}).success,false);
 assert.equal(judgeRecordInput.safeParse({tenant:'judge',escrow:'11111111111111111111111111111111',taskHash:'a'.repeat(64),resultHash:'b'.repeat(64),judgment:{...assessment,confidence:0.4,verdict:'needs_review'}}).success,true);
 const key='11111111111111111111111111111111',profile={tenant:'judge',escrows:[{escrow:key,taskHash:'a'.repeat(64)}]};assert.equal(judgeRecordProfiles.parse([profile])[0].minimumConfidence,0.9);assert.equal(judgeRecordProfiles.safeParse([profile,profile]).success,false);assert.equal(judgeRecordProfiles.safeParse([{...profile,escrows:[...profile.escrows,...profile.escrows]}]).success,false);assert.equal(judgeRecordInput.safeParse({tenant:'judge',escrow:key,taskHash:'a'.repeat(64),resultHash:'b'.repeat(64),judgment:{verdict:'pass',confidence:NaN,summary:'fake',checks:[],limitations:[]}}).success,false);
});
