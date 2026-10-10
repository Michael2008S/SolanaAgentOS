import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {address,generateKeyPairSigner,getAddressEncoder,createTransactionMessage,setTransactionMessageFeePayerSigner,setTransactionMessageLifetimeUsingBlockhash,appendTransactionMessageInstructions,signTransactionMessageWithSigners,getBase64EncodedWireTransaction} from '@solana/kit';
import {workflowFundingPreflight,workflowFundingServer,verifyFundingReview,workflowFundingCliSteps} from '../../scripts/devnet-workflow-funding-rpc.mjs';
import {inspectWorkflowFunding,workflowFundingHandler,workflowTokenAddress,workflowUsdcMint} from '../../scripts/devnet-workflow-funding.mjs';
const system='11111111111111111111111111111111',token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',associated='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
async function fixture(){
 const wallet=await generateKeyPairSigner(),payer=await generateKeyPairSigner(),worker=await generateKeyPairSigner();
 const review={authorized:true,network:'devnet',genesisHash:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',rpc:'https://api.devnet.solana.com',fundingWallet:wallet.address,recipients:{payer:payer.address,workerOwner:worker.address},amounts:{payerSolLamports:'300000000',payerUsdcAtomic:'10000',workerOwnerUsdcAtomic:'200000'},limits:{maximumAtaRentLamports:'2100000',networkFeePerTransactionLamports:'10000',maximumWalletLamports:'305000000'}};
 const wire=async instructions=>getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(appendTransactionMessageInstructions(instructions,setTransactionMessageLifetimeUsingBlockhash({blockhash:system,lastValidBlockHeight:100n},setTransactionMessageFeePayerSigner(wallet,createTransactionMessage({version:0}))))));
 const nativeData=Buffer.alloc(12);nativeData.writeUInt32LE(2);nativeData.writeBigUInt64LE(300000000n,4);const native={programAddress:address(system),accounts:[{address:wallet.address,role:3,signer:wallet},{address:payer.address,role:1}],data:nativeData};
 const source=await workflowTokenAddress(wallet.address),destination=await workflowTokenAddress(payer.address),tokenData=Buffer.alloc(10);tokenData[0]=12;tokenData.writeBigUInt64LE(10000n,1);tokenData[9]=6;
 const transfer={programAddress:address(token),accounts:[{address:address(source),role:1},{address:address(workflowUsdcMint),role:0},{address:address(destination),role:1},{address:wallet.address,role:2,signer:wallet}],data:tokenData};
 const ata={programAddress:address(associated),accounts:[{address:wallet.address,role:3,signer:wallet},{address:address(destination),role:1},{address:payer.address,role:0},{address:address(workflowUsdcMint),role:0},{address:address(system),role:0},{address:address(token),role:0}],data:Uint8Array.of(1)};
 const mintBytes=Buffer.alloc(82);mintBytes[44]=6;mintBytes[45]=1;const sourceBytes=Buffer.alloc(165),encoder=getAddressEncoder();Buffer.from(encoder.encode(address(workflowUsdcMint))).copy(sourceBytes);Buffer.from(encoder.encode(wallet.address)).copy(sourceBytes,32);sourceBytes.writeBigUInt64LE(210000n,64);sourceBytes[108]=1;
 const account=data=>({owner:token,executable:false,data:[data.toString('base64'),'base64']}),mint=account(mintBytes),sourceAccount=account(sourceBytes);
 const upstream=async(method)=>{if(method==='getGenesisHash')return {result:review.genesisHash};if(method==='getMultipleAccounts')return {result:{context:{slot:200},value:[mint,sourceAccount]}};if(method==='getBalance')return {result:{value:1_000_000_000}};throw Error('No mutation expected');};
 return {review,wallet,payer,worker,wire,native,transfer,ata,upstream,mint,sourceAccount,sourceBytes};
}
test('canonical Devnet assets must be funded before serving; absent or forged token accounts never become substitutes',async()=>{
 const f=await fixture();assert.equal((await workflowFundingPreflight(f)).ready,true);
 const absent=await workflowFundingPreflight({...f,upstream:async(method,params)=>method==='getMultipleAccounts'?{result:{context:{slot:201},value:[f.mint,null]}}:f.upstream(method,params)});assert.equal(absent.ready,false);assert.equal(absent.availableUsdcAtomic,'0');assert.equal(absent.transactionsSent,0);
 for(const change of ['mint','authority','state']){const bytes=Buffer.from(f.sourceBytes);if(change==='mint')bytes[0]^=1;if(change==='authority')bytes[32]^=1;if(change==='state')bytes[108]=2;await assert.rejects(workflowFundingPreflight({...f,upstream:async(method,params)=>method==='getMultipleAccounts'?{result:{context:{slot:201},value:[f.mint,{...f.sourceAccount,data:[bytes.toString('base64'),'base64']}]}}:f.upstream(method,params)}),/mint, authority or state/);}
 assert.throws(()=>verifyFundingReview({...f.review,amounts:{...f.review.amounts,payerSolLamports:'301000000'}}),/amounts/);
 const unapproved=await workflowFundingPreflight({...f,review:{...f.review,authorized:false}});assert.equal(unapproved.fundsAvailable,true);assert.equal(unapproved.ready,false);assert.equal(unapproved.authorized,false);assert.throws(()=>workflowFundingServer({...f,review:{...f.review,authorized:false},journal:{}}),/authorized/);
});
test('restart preflight accounts for accepted original funding and rejects unknown or forged acknowledgments',async()=>{
 const f=await fixture(),wire=await f.wire([f.transfer]),checked=await inspectWorkflowFunding(wire,f.review),record={...checked,feeLamports:5000},ack={signature:checked.signature,response:{result:checked.signature}};
 const ready=await workflowFundingPreflight({...f,records:[record,ack]});assert.equal(ready.requiredUsdcAtomic,'200000');assert.equal(ready.originalEffectUnknown,false);
 const unknown=await workflowFundingPreflight({...f,records:[record]});assert.equal(unknown.ready,false);assert.equal(unknown.originalEffectUnknown,true);
 await assert.rejects(workflowFundingPreflight({...f,records:[record,{...ack,response:{result:'forged'}}]}),/acknowledgment/);
});
test('installed CLI funding plans retain exact scope and keep token arguments compatible with the classic token CLI',async()=>{
 const f=await fixture(),steps=workflowFundingCliSteps(f.review);assert.deepEqual(steps.map(step=>step.phase),['payer-SOL','payer-USDC','workerOwner-USDC']);assert.equal(steps[0].args[1],f.payer.address);assert.equal(steps[0].args[2],'0.3');
 for(const step of steps.slice(1)){assert.equal(step.command,'spl-token');assert.equal(step.args[1],workflowUsdcMint);assert.equal(step.args[step.args.indexOf('--program-id')+1],token);assert.equal(step.args.includes('--commitment'),false);assert.equal(step.args[step.args.indexOf('--url')+1],'http://127.0.0.1:18894');assert.equal(step.args[step.args.indexOf('--with-compute-unit-price')+1],'0');}
 assert.throws(()=>workflowFundingCliSteps({...f.review,authorized:false}),/authorized/);
});
test('fund-recipient ATA creation is bound to the same transfer destination and reserves rent',async()=>{
 const f=await fixture(),valid=await f.wire([f.ata,f.transfer]),checked=await inspectWorkflowFunding(valid,f.review);assert.equal(checked.phase,'payer-USDC');assert.equal(checked.reservedWalletLamports,'2100000');
 const changed={...f.ata,accounts:f.ata.accounts.map((a,i)=>i===2?{...a,address:f.worker.address}:a)};await assert.rejects(inspectWorkflowFunding(await f.wire([changed,f.transfer]),f.review),/token-account/);
 await assert.rejects(inspectWorkflowFunding(await f.wire([f.ata,f.native]),f.review),/mismatched/);
});
test('an unknown original transfer blocks every other phase, including after journal reopen',async()=>{
 const f=await fixture(),rows=[];let sends=0;const upstream=async method=>{if(method==='getGenesisHash')return {result:f.review.genesisHash};if(method==='simulateTransaction')return {result:{value:{err:null}}};if(method==='getFeeForMessage')return {result:{value:5000}};sends++;throw Error('Unknown send');},journal={writeFile:async s=>rows.push(JSON.parse(s)),sync:async()=>{}};
 const handler=workflowFundingHandler({...f,upstream,journal});await assert.rejects(handler([await f.wire([f.native]),{encoding:'base64'}]),/Unknown send/);await assert.rejects(handler([await f.wire([f.transfer]),{encoding:'base64'}]),/earlier funding effect/);
 const reopened=workflowFundingHandler({...f,upstream,journal,records:rows});await assert.rejects(reopened([await f.wire([f.transfer]),{encoding:'base64'}]),/earlier funding effect/);assert.equal(sends,1);
});
test('actual loopback RPC preserves u64, forces preflight and rejects browser origins, extra writes and altered funding',async()=>{
 const f=await fixture(),rows=[];let sends=0;const encoded=await f.wire([f.native]),checked=await inspectWorkflowFunding(encoded,f.review);
 const upstream=async(method,params)=>{if(method==='getGenesisHash')return {result:f.review.genesisHash};if(method==='getAccountInfo')return {result:{value:{rentEpoch:18446744073709551615n}}};if(method==='simulateTransaction')return {result:{value:{err:null}}};if(method==='getFeeForMessage')return {result:{value:5000}};assert.equal(method,'sendTransaction');assert.equal(params[1].skipPreflight,false);assert.equal(params[1].maxRetries,0);assert.equal(rows.length,1);sends++;return {result:checked.signature};};
 const server=workflowFundingServer({review:f.review,upstream,journal:{writeFile:async s=>rows.push(JSON.parse(s)),sync:async()=>{}},port:0});server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;
 const call=async(method,params=[],headers={})=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:7,method,params})});return r.text();};
 try{
  assert.ok((await call('getAccountInfo',['public'])).includes('18446744073709551615'));
  for(const method of ['requestAirdrop','sendBundle','setAccount'])assert.ok(JSON.parse(await call(method)).error);
  assert.ok(JSON.parse(await call('sendTransaction',[encoded,{encoding:'base64'}],{origin:'https://example.com'})).error);assert.equal(sends,0);
  const changed={...f.native,accounts:f.native.accounts.map((a,i)=>i===1?{...a,address:f.worker.address}:a)};assert.ok(JSON.parse(await call('sendTransaction',[await f.wire([changed]),{encoding:'base64'}])).error);assert.equal(sends,0);
  const result=JSON.parse(await call('sendTransaction',[encoded,{encoding:'base64',skipPreflight:true,maxRetries:100}]));assert.equal(result.result,checked.signature);assert.equal(result.id,7);assert.equal(sends,1);
  assert.equal(JSON.parse(await call('sendTransaction',[encoded,{encoding:'base64'}])).result,checked.signature);assert.equal(sends,1);assert.equal(rows.length,2);
 }finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
});
test('SOL-only review performs no token read, issues one CLI transfer and rejects token or ATA wires',async()=>{
 const f=await fixture(),review={...f.review,assetMode:'SOL',amounts:{payerSolLamports:'300000000',payerUsdcAtomic:'0',workerOwnerUsdcAtomic:'0'},limits:{maximumAtaRentLamports:'0',networkFeePerTransactionLamports:'10000',maximumWalletLamports:'300010000'}},calls=[];
 const upstream=async method=>{calls.push(method);if(method==='getGenesisHash')return {result:review.genesisHash};assert.equal(method,'getBalance');return {result:{context:{slot:200},value:1_000_000_000}};};
 const preflight=await workflowFundingPreflight({review,upstream});assert.equal(preflight.ready,true);assert.equal(preflight.assetMode,'SOL');assert.deepEqual(calls,['getGenesisHash','getBalance']);assert.equal(preflight.requiredSolLamports,'300010000');assert.equal('usdcMint' in preflight,false);assert.equal(workflowFundingCliSteps(review).length,1);
 assert.equal((await inspectWorkflowFunding(await f.wire([f.native]),review)).phase,'payer-SOL');await assert.rejects(inspectWorkflowFunding(await f.wire([f.transfer]),review),/USDC funding scope/);await assert.rejects(inspectWorkflowFunding(await f.wire([f.ata,f.transfer]),review),/token-account funding/);assert.throws(()=>verifyFundingReview({...review,amounts:{...review.amounts,payerUsdcAtomic:'1'}}),/amounts/);
});
