import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {address,generateKeyPairSigner,createTransactionMessage,setTransactionMessageFeePayerSigner,setTransactionMessageLifetimeUsingBlockhash,appendTransactionMessageInstructions,signTransactionMessageWithSigners,getBase64EncodedWireTransaction} from '@solana/kit';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
import {inspectWorkflowTransaction,workflowSubmissionHandler,workflowRpcServer} from '../../scripts/devnet-workflow-rpc.mjs';
const system='11111111111111111111111111111111';
async function fixture(){
 const payer=await generateKeyPairSigner(),funding=await generateKeyPairSigner(),worker=await generateKeyPairSigner(),judge=await generateKeyPairSigner(),provider=await generateKeyPairSigner();
 const review={authorized:true,network:'devnet',genesisHash:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',program:String(sdk.PROGRAM_ADDRESS),rpc:'https://api.devnet.solana.com',feePayer:payer.address,fundingWallet:funding.address,recipients:{workerOwner:worker.address,judgeOwner:judge.address,provider:provider.address},maximumTransactions:50,maximumNetworkFeeLamports:10000};
 const ix=sdk.buildFundSessionFeeReserve(payer.address,worker.address,0.05),wire=async(instructions=[ix],blockhash=system,signer=payer)=>getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(appendTransactionMessageInstructions(instructions,setTransactionMessageLifetimeUsingBlockhash({blockhash,lastValidBlockHeight:100n},setTransactionMessageFeePayerSigner(signer,createTransactionMessage({version:0}))))));
 const init=(await sdk.buildInitializeAgent(payer.address,'Devnet ephemeral test',1,0.01,1,1,['escrow'])).instruction;return {payer,funding,worker,judge,provider,review,ix,wire,init};
}
test('business inspector admits exact role funding and SDK setup while rejecting original-wallet, extra instructions and forbidden operations',async()=>{
 const f=await fixture();assert.equal((await inspectWorkflowTransaction(await f.wire(),f.review)).action,'fund-workerOwner');assert.equal((await inspectWorkflowTransaction(await f.wire([f.init]),f.review)).action,'initialize_agent');
 await assert.rejects(inspectWorkflowTransaction(await f.wire([f.ix,f.ix]),f.review),/format or instructions/);
 await assert.rejects(inspectWorkflowTransaction(await f.wire([sdk.buildFundSessionFeeReserve(f.payer.address,f.worker.address,0.051)]),f.review),/native role funding/);
 await assert.rejects(inspectWorkflowTransaction(await f.wire([sdk.buildFundSessionFeeReserve(f.funding.address,f.worker.address,0.05)],system,f.funding),f.review),/payer/);
 const illegal={...f.init,data:Buffer.from('ffffffffffffffff','hex')};await assert.rejects(inspectWorkflowTransaction(await f.wire([illegal]),f.review),/AgentOS operation/);
 const raw=Buffer.from(await f.wire(),'base64');raw[2]^=1;await assert.rejects(inspectWorkflowTransaction(raw.toString('base64'),f.review),/signature/);
});
test('original business wire is fsynced before one forced-preflight send and known acknowledgments never resend or refund a role twice',async()=>{
 const f=await fixture(),rows:any[]=[];let synced=0,sends=0;const wire=await f.wire(),checked=await inspectWorkflowTransaction(wire,f.review);
 const upstream=async(method:string,params:any[])=>{if(method==='getGenesisHash')return {result:f.review.genesisHash};if(method==='simulateTransaction')return {result:{value:{err:null}}};if(method==='getFeeForMessage')return {result:{value:5000}};assert.equal(method,'sendTransaction');assert.equal(rows.length,1);assert.ok(synced);assert.equal(params[1].skipPreflight,false);assert.equal(params[1].maxRetries,0);sends++;return {result:checked.signature};};
 const journal={writeFile:async text=>rows.push(JSON.parse(text)),sync:async()=>{synced++;}},send=workflowSubmissionHandler({review:f.review,upstream,journal});
 assert.equal((await send([wire,{encoding:'base64',skipPreflight:true,maxRetries:30}])).result,checked.signature);assert.equal((await send([wire,{encoding:'base64'}])).result,checked.signature);assert.equal(sends,1);
 const reopened=workflowSubmissionHandler({review:f.review,upstream,journal,records:rows});assert.equal((await reopened([wire,{encoding:'base64'}])).result,checked.signature);assert.equal(sends,1);await assert.rejects(reopened([await f.wire([f.ix],f.judge.address),{encoding:'base64'}]),/replaced or repeated/);
});
test('unknown original send blocks all later business effects before and after journal reopen',async()=>{
 const f=await fixture(),rows:any[]=[];let sends=0;const upstream=async(method:string)=>{if(method==='getGenesisHash')return {result:f.review.genesisHash};if(method==='simulateTransaction')return {result:{value:{err:null}}};if(method==='getFeeForMessage')return {result:{value:5000}};sends++;throw Error('Unknown transport');};const journal={writeFile:async text=>rows.push(JSON.parse(text)),sync:async()=>{}},send=workflowSubmissionHandler({review:f.review,upstream,journal}),wire=await f.wire();
 await assert.rejects(send([wire,{encoding:'base64'}]),/Unknown transport/);await assert.rejects(send([wire,{encoding:'base64'}]),/reconciliation/);await assert.rejects(send([await f.wire([f.init]),{encoding:'base64'}]),/earlier business send/);
 const reopened=workflowSubmissionHandler({review:f.review,upstream,journal,records:rows});await assert.rejects(reopened([await f.wire([f.init]),{encoding:'base64'}]),/earlier business send/);assert.equal(sends,1);
});
test('wrong chain, signed simulation errors and excessive fees prevent every journal reservation and broadcast',async()=>{
 const f=await fixture(),wire=await f.wire();for(const fault of ['genesis','simulation','fee']){let writes=0,sends=0;const upstream=async(method:string)=>{if(method==='getGenesisHash')return {result:fault==='genesis'?'foreign':f.review.genesisHash};if(method==='simulateTransaction')return {result:{value:{err:fault==='simulation'?'rejected':null}}};if(method==='getFeeForMessage')return {result:{value:fault==='fee'?10001:5000}};sends++;return {result:''};};const send=workflowSubmissionHandler({review:f.review,upstream,journal:{writeFile:async()=>{writes++;},sync:async()=>{}}});await assert.rejects(send([wire,{encoding:'base64'}]));assert.equal(writes,0);assert.equal(sends,0);}
});
test('a full original 50-transaction history prevents transaction 51 without contacting RPC',async()=>{
 const f=await fixture(),records:any[]=[];for(let i=0;i<50;i++){const wire=await f.wire([f.init],(await generateKeyPairSigner()).address),checked=await inspectWorkflowTransaction(wire,f.review);records.push({...checked,feeLamports:5000},{signature:checked.signature,response:{result:checked.signature}});}
 let calls=0;const send=workflowSubmissionHandler({review:f.review,records,upstream:async()=>{calls++;throw Error('No upstream');},journal:{writeFile:async()=>{},sync:async()=>{}}});await assert.rejects(send([await f.wire([f.init]),{encoding:'base64'}]),/cap reached/);assert.equal(calls,0);
});
test('actual loopback role RPC preserves integer precision and rejects browser, airdrop and unknown writes',async()=>{
 const f=await fixture();let calls=0;const server=workflowRpcServer({review:f.review,upstream:async()=>{calls++;return {result:{value:{rentEpoch:18446744073709551615n}}};},journal:{writeFile:async()=>{},sync:async()=>{}},port:0});server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as any).port,call=async(method:string,headers={})=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]})});return r.text();};
 try{assert.ok((await call('getAccountInfo')).includes('18446744073709551615'));for(const method of ['requestAirdrop','sendBundle','setAccount'])assert.ok(JSON.parse(await call(method)).error);assert.ok(JSON.parse(await call('getAccountInfo',{origin:'https://example.com'})).error);assert.equal(calls,1);}finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
test('SOL-only business review rejects every USDC payment, deposit, Escrow and settlement operation',async()=>{
 const f=await fixture(),review={...f.review,assetMode:'SOL'};assert.equal((await inspectWorkflowTransaction(await f.wire([f.init]),review)).action,'initialize_agent');
 const {createHash}=await import('node:crypto');for(const name of ['deposit_usdc','create_task_usdc_escrow','pay_task_usdc_skill','settle_judged_usdc_escrow']){const forbidden={...f.init,data:createHash('sha256').update('global:'+name).digest().subarray(0,8)};await assert.rejects(inspectWorkflowTransaction(await f.wire([forbidden]),review),/Unreviewed AgentOS operation/);}
});
