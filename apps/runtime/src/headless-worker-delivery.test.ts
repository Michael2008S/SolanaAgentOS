import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { address,generateKeyPairSigner,getAddressEncoder,getProgramDerivedAddress,type TransactionPartialSigner } from '@solana/kit';
import { HeadlessJournal } from './headless-journal.js';
import { HeadlessWorkerDelivery,workerDeliveryInput,workerDeliveryProfiles } from './headless-worker-delivery.js';
const sha=(text:string)=>createHash('sha256').update(text).digest(),bytes=(key:string)=>Buffer.from(getAddressEncoder().encode(address(key)));
test('Worker delivery validates current chain, canonical accounts, revocation, expiry and original Escrow before signing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-delivery-unit-')),journal=new HeadlessJournal(join(root,'journal.sqlite'));
 try{
 const [program,owner,sessionKey,fee]=await Promise.all(Array.from({length:4},()=>generateKeyPairSigner()));let signs=0;
 const signer:TransactionPartialSigner={address:sessionKey.address,signTransactions:async()=>{signs++;throw new Error('Must not sign rejected delivery');}},feePayer:TransactionPartialSigner={address:fee.address,signTransactions:signer.signTransactions};
 const derive=(seeds:Uint8Array[])=>getProgramDerivedAddress({programAddress:program.address,seeds}),id=Buffer.alloc(32),eid=Buffer.alloc(8),[agent,ab]=await derive([Buffer.from('agent'),bytes(owner.address),id]),[policy,pb]=await derive([Buffer.from('policy'),bytes(agent)]),[session,sb]=await derive([Buffer.from('session'),bytes(agent),bytes(sessionKey.address)]),[escrow,eb]=await derive([Buffer.from('escrow'),bytes(owner.address),eid]),[permit,wb]=await derive([Buffer.from('worker_delivery'),bytes(escrow)]);
 const data=(kind:string,n:number)=>{const d=Buffer.alloc(n);sha('account:'+kind).subarray(0,8).copy(d);return d;},a=data('Agent',138),p=data('Policy',123),s=data('Session',147),e=data('Escrow',180),w=data('WorkerDeliveryPermit',115),deadline=BigInt(Math.floor(Date.now()/1000)+600);
 bytes(owner.address).copy(a,8);a[121]=ab;bytes(agent).copy(p,8);p[72]=2;p[74]=pb;bytes(agent).copy(s,8);bytes(sessionKey.address).copy(s,40);s.writeBigInt64LE(deadline,72);s[104]=2;s[106]=sb;bytes(owner.address).copy(e,8);bytes(agent).copy(e,40);e.writeBigInt64LE(deadline,88);sha('task').copy(e,96);e[130]=eb;bytes(escrow).copy(w,8);bytes(agent).copy(w,40);bytes(session).copy(w,72);w.writeBigInt64LE(deadline,104);w[114]=wb;
 const accounts=new Map([[agent,a],[policy,p],[session,s],[escrow,e],[permit,w]]);let genesis=owner.address,foreign=false,simulations=0;
 const rpc=async(method:string,params:unknown[])=>{if(method==='getGenesisHash')return genesis;if(method==='getAccountInfo'){const d=accounts.get(params[0] as any);return {value:d?{owner:foreign?owner.address:program.address,executable:false,data:[d.toString('base64'),'base64']}:null};}if(method==='getLatestBlockhash')return {value:{blockhash:owner.address,lastValidBlockHeight:100}};if(method==='simulateTransaction'){simulations++;return {value:{err:'fixture-preflight-stop'}};}throw new Error('Rejected delivery cannot broadcast');};
 const input={tenant:'worker',escrow,taskHash:sha('task').toString('hex'),result:'public result',sources:[]},profiles=[{tenant:'worker',escrows:[{escrow,taskHash:input.taskHash}]}],executor=new HeadlessWorkerDelivery({program:program.address,genesis:owner.address,rpc,feePayer,signers:new Map([['worker',signer]]),identities:[{tenant:'worker',agent,session}],profiles,journal});
 profiles[0].escrows[0].taskHash='0'.repeat(64);
 await assert.rejects(executor.execute(input),/simulation failed before signing/);assert.equal(simulations,1);
 for(const [d,i,v] of [[a,104,1],[a,121,ab^1],[p,73,1],[p,72,0],[s,105,1],[s,104,0],[s,106,sb^1],[w,112,1],[w,113,1],[w,114,wb^1],[e,128,1],[e,129,2],[e,130,eb^1]] as const){const old=d[i];d[i]=v;await assert.rejects(executor.execute(input));d[i]=old;}
 Buffer.from('AGTASK01').copy(s,115);await assert.rejects(executor.execute(input),/task-bound/);s.fill(0,115,123);
 w.writeBigInt64LE(1n,104);await assert.rejects(executor.execute(input),/permit/);w.writeBigInt64LE(deadline,104);
 genesis=program.address;await assert.rejects(executor.execute(input),/chain changed/);genesis=owner.address;foreign=true;await assert.rejects(executor.execute(input),/owned program/);
 await assert.rejects(executor.execute({...input,tenant:'other'}),/configured/);assert.equal(signs,0);assert.equal(simulations,1);
 }finally{journal.close();await rm(root,{recursive:true,force:true});}
});
test('Worker scope is bounded and rejects ambiguous identities and evidence',()=>{
 const key='11111111111111111111111111111111',row={tenant:'worker',escrows:[{escrow:key,taskHash:'a'.repeat(64)}]};assert.equal(workerDeliveryProfiles.safeParse([row,row]).success,false);assert.equal(workerDeliveryProfiles.safeParse([{...row,escrows:[...row.escrows,...row.escrows]}]).success,false);assert.equal(workerDeliveryInput.safeParse({tenant:'worker',escrow:key,taskHash:'a'.repeat(64),result:'ok',sources:[{execution:key,contentHash:'b'.repeat(64)},{execution:key,contentHash:'b'.repeat(64)}]}).success,false);
});
test('saved delivery verifies original wire signatures even if RPC reports finalized',async()=>{
 const {readFile}=await import('node:fs/promises'),{getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase64EncodedWireTransaction}=await import('@solana/kit'),{canonicalJson}=await import('./canonical-json.js');
 const base='docs/evidence/headless-worker-delivery-2026-10-09T22-44-13-665Z',report=JSON.parse(await readFile(join(base,'report.json'),'utf8')),chainTx=JSON.parse(await readFile(join(base,'delivery-transaction.json'),'utf8')),tx=getTransactionDecoder().decode(Buffer.from(chainTx.transaction[0],'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 if(message.version!==0)throw new Error('Fixture must use v0');const sessionKey=message.staticAccounts[message.instructions[0].accountIndices![0]],fee=message.staticAccounts[0],identity={tenant:'worker',agent:report.worker,session:report.session},input={tenant:'worker',escrow:report.escrow,taskHash:report.taskHash,result:report.result,sources:[]};
 const key=(value:string)=>({address:address(value),signTransactions:async()=>{throw new Error('Original recovery cannot sign');}}),scopeHash=sha(canonicalJson({kind:'worker-delivery-v1',program:report.program,genesis:report.genesis,identity,signer:sessionKey,feePayer:fee,input})).toString('hex');
 let wire=chainTx.transaction[0],saves=0;const journal={load:()=>({tenant:'worker',jobId:'00000000-0000-4000-a000-000000000000',intentId:'00000000-0000-4000-a000-000000000000',scopeHash,execution:report.escrow,content:report.result,result:{wire,signature:report.delivery.signature},complete:false}),save:()=>{saves++;}} as unknown as HeadlessJournal;
 const account=Buffer.alloc(180);sha('account:Escrow').subarray(0,8).copy(account);account[128]=1;sha(report.result).copy(account,129);
 const executor=new HeadlessWorkerDelivery({program:report.program,genesis:report.genesis,feePayer:key(fee),signers:new Map([['worker',key(sessionKey)]]),identities:[identity],profiles:[{tenant:'worker',escrows:[{escrow:report.escrow,taskHash:report.taskHash}]}],journal,rpc:async(method:string)=>{if(method==='getGenesisHash')return report.genesis;if(method==='getSignatureStatuses')return {value:[{err:null,confirmationStatus:'finalized'}]};if(method==='getAccountInfo')return {value:{owner:report.program,data:[account.toString('base64'),'base64']}};throw new Error('Original recovery cannot broadcast');}});
 assert.equal((await executor.execute(input)).signature,report.delivery.signature);assert.equal(saves,1);
 const signature=tx.signatures[sessionKey]!,corrupt=Uint8Array.from(signature);corrupt[0]^=1;wire=getBase64EncodedWireTransaction({...tx,signatures:{...tx.signatures,[sessionKey]:corrupt as typeof signature}});await assert.rejects(executor.execute(input),/signature is invalid/);assert.equal(saves,1);
});
