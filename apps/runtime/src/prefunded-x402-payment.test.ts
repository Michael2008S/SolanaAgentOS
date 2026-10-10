import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { address,blockhash,generateKeyPairSigner,getAddressDecoder,getAddressEncoder,getBase58Decoder,addSignersToInstruction,appendTransactionMessageInstructions,createTransactionMessage,getBase64EncodedWireTransaction,setTransactionMessageFeePayerSigner,setTransactionMessageLifetimeUsingBlockhash,signTransactionMessageWithSigners,getTransactionDecoder,getCompiledTransactionMessageDecoder,type SignatureBytes } from '@solana/kit';
import { ExactSvmScheme } from '@x402/svm/exact/facilitator';
import type { FacilitatorSvmSigner } from '@x402/svm';
import type { AutonomousJob } from './autonomous-loop.js';
import { prefundedX402Scope,preparePrefundedX402Payment,verifyPrefundedX402Settlement } from './prefunded-x402-payment.js';
import type { StandardPaymentChallenge } from './standard-payments.js';
const key=(text:string)=>getAddressDecoder().decode(createHash('sha256').update(text).digest()),encode=getAddressEncoder();
async function fixture(){
 const signer=await generateKeyPairSigner(),payer=await generateKeyPairSigner(),sponsor=await generateKeyPairSigner(),recipient=key('recipient'),genesis=key('genesis'),intentId=randomUUID();
 const action={key:'payment',tool:'http:ordinary',input:'{}',asset:'USDC' as const,amount:'1000'},job:AutonomousJob={version:1,id:randomUUID(),tenant:'owner',goal:'Obtain public data',agent:key('agent'),session:key('session'),program:key('program'),genesis,state:'executing',limits:{sol:'0',usdc:'1000',maxCycles:2,maxActions:2,maxModelRequests:4,deadline:Math.floor(Date.now()/1000)+600,tools:[action.tool]},spent:{sol:'0',usdc:'1000'},cycle:1,modelRequests:1,intents:[{id:intentId,action,phase:'reserved',executionId:'0',cycle:1}],pending:[],evaluations:[]};
 const endpoint='https://ordinary.example/data',accepted={scheme:'exact',network:`solana:${genesis.slice(0,32)}` as const,asset:'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',amount:'1000',payTo:recipient,maxTimeoutSeconds:60,extra:{feePayer:sponsor.address}},challenge:Extract<StandardPaymentChallenge,{protocol:'x402'}>={protocol:'x402',accepted,required:{x402Version:2,resource:{url:endpoint},accepts:[accepted]}};
 const base={job,action,intentId,sessionKey:signer.address,fundingFeePayer:payer.address,recipient,endpoint,challenge},scope=await prefundedX402Scope(base),roles=[2,3,1,1,1,0,1,0,1,1,0,0,0] as const;
 const instruction=addSignersToInstruction([signer,payer],{programAddress:address(job.program),accounts:scope.accounts.map((value,n)=>({address:address(value),role:roles[n]})),data:scope.paymentData});
 const lifetime={blockhash:blockhash(key('blockhash')),lastValidBlockHeight:1000n},message=appendTransactionMessageInstructions([instruction],setTransactionMessageLifetimeUsingBlockhash(lifetime,setTransactionMessageFeePayerSigner(payer,createTransactionMessage({version:0})))),funding=await signTransactionMessageWithSigners(message),fundingSignature=getBase58Decoder().decode(funding.signatures[payer.address]!);
 const state={badToken:false,badFunding:false,badFee:false,badSimulation:false};let signatures=0;
 const protectedSigner={address:signer.address,signTransactions:async(...args:Parameters<typeof signer.signTransactions>)=>{signatures++;return signer.signTransactions(...args);}};
 const rpc=async(method:string,params:unknown[])=>{
  if(method==='getGenesisHash')return genesis;
  if(method==='getTransaction')return {slot:42,meta:{err:state.badFunding?{InstructionError:[0,'bad']}:null,fee:10000},transaction:[getBase64EncodedWireTransaction(funding),'base64']};
  if(method==='getAccountInfo'){const source=params[0]===scope.accounts[8],data=Buffer.alloc(165);Buffer.from(encode.encode(address(accepted.asset))).copy(data);Buffer.from(encode.encode(source?signer.address:recipient)).copy(data,32);data.writeBigUInt64LE(source?1000n:0n,64);data[108]=1;if(state.badToken&&source)data.writeUInt32LE(1,72);return {context:{slot:42},value:{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',executable:false,data:[data.toString('base64'),'base64']}};}
  if(method==='getLatestBlockhash')return {value:lifetime};if(method==='simulateTransaction')return {value:{err:state.badSimulation?'failure':null}};if(method==='getFeeForMessage')return {value:state.badFee?10001:10000};throw new Error('Unexpected RPC '+method);
 };
 return {...base,signer:protectedSigner,rpc,fundingSignature,scope,sponsor,state,get signatures(){return signatures;}};
}
test('budget-funded standard transfer passes official default x402 verifier with no smart-wallet configuration',async()=>{
 const f=await fixture(),prepared=await preparePrefundedX402Payment(f),tx=getTransactionDecoder().decode(Buffer.from(prepared.wire,'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);assert.equal(tx.signatures[f.sponsor.address],null);assert.equal(f.signatures,1);assert.notEqual(message.version,1);if(message.version===1)throw new Error('Unexpected v1 message');assert.equal(message.instructions.length,4);assert.ok(!message.staticAccounts.includes(address(f.job.program)));assert.equal(prepared.scope.accounts[7],f.signer.address);
 const facilitatorSigner:FacilitatorSvmSigner={getAddresses:()=>[f.sponsor.address],signTransaction:async()=>{throw new Error('Verification must not sign.');},sendTransaction:async()=>{throw new Error('Verification must not broadcast.');},confirmTransaction:async()=>{throw new Error('Verification must not settle.');},simulateTransaction:async()=>{},fetchAddressLookupTables:async()=>({})};
 const facilitator=new ExactSvmScheme(facilitatorSigner),response=await facilitator.verify({x402Version:2,resource:f.challenge.required.resource,accepted:f.challenge.accepted,payload:{transaction:prepared.wire}},f.challenge.accepted);assert.equal(response.isValid,true,JSON.stringify(response));assert.equal(response.payer,f.signer.address);
});
test('rejects missing funding, unsafe token authority, simulation failure and excess fees before client signing',async()=>{
 for(const field of ['badFunding','badToken','badSimulation','badFee'] as const){const f=await fixture();f.state[field]=true;await assert.rejects(preparePrefundedX402Payment(f));assert.equal(f.signatures,0);}
});
test('quote recipient, endpoint, amount, signer and durable funding commitment cannot change',async()=>{
 const f=await fixture();for(const input of [{...f,recipient:key('changed')},{...f,endpoint:'https://changed.example/data'},{...f,action:{...f.action,amount:'999'}},{...f,job:{...f.job,spent:{sol:'0',usdc:'0'}}}])await assert.rejects(preparePrefundedX402Payment(input));assert.equal(f.signatures,0);
 const newAccepted={...f.challenge.accepted,maxTimeoutSeconds:61},changed={...f,challenge:{...f.challenge,accepted:newAccepted,required:{...f.challenge.required,accepts:[newAccepted]}}};assert.notDeepEqual((await prefundedX402Scope(changed)).inputHash,f.scope.inputHash);await assert.rejects(preparePrefundedX402Payment(changed),/instruction differs/);assert.equal(f.signatures,0);
});

test('expired or stopped jobs cannot sign an ordinary transfer',async()=>{
 const f=await fixture();await assert.rejects(preparePrefundedX402Payment({...f,job:{...f.job,limits:{...f.job.limits,deadline:Math.floor(Date.now()/1000)-1}}}),/deadline/);await assert.rejects(preparePrefundedX402Payment({...f,job:{...f.job,state:'needs_reconciliation'}}),/deadline/);assert.equal(f.signatures,0);
});

test('settlement verifies both original funding and exact ordinary transfer without signing again',async()=>{
 const f=await fixture(),prepared=await preparePrefundedX402Payment(f),partial=getTransactionDecoder().decode(Buffer.from(prepared.wire,'base64'));
 const sponsorSignature=new Uint8Array(await crypto.subtle.sign('Ed25519',f.sponsor.keyPair.privateKey,new Uint8Array(partial.messageBytes))) as SignatureBytes,complete={...partial,signatures:{...partial.signatures,[f.sponsor.address]:sponsorSignature}},settlementSignature=getBase58Decoder().decode(sponsorSignature);
 const state={slot:43,fee:10000,err:null as unknown};
 const rpc=async(method:string,params:unknown[])=>method==='getTransaction'&&params[0]===settlementSignature?{slot:state.slot,meta:{err:state.err,fee:state.fee},transaction:[getBase64EncodedWireTransaction(complete),'base64']}:f.rpc(method,params);
 const input={...f,sessionKey:f.signer.address,rpc,partialWire:prepared.wire,memo:prepared.memo,settlementSignature};
 const verified=await verifyPrefundedX402Settlement(input);assert.equal(verified.scope.execution,f.scope.execution);assert.equal(verified.settlement.slot,43);assert.equal(f.signatures,1);
 state.slot=41;await assert.rejects(verifyPrefundedX402Settlement(input),/precedes/);state.slot=43;
 state.err={InstructionError:[2,'Custom']};await assert.rejects(verifyPrefundedX402Settlement(input),/successful finalized/);state.err=null;
 state.fee=10001;await assert.rejects(verifyPrefundedX402Settlement(input),/fee cap/);state.fee=10000;
 f.state.badFunding=true;await assert.rejects(verifyPrefundedX402Settlement(input),/Original finalized/);f.state.badFunding=false;
 await assert.rejects(verifyPrefundedX402Settlement({...input,memo:'replacement'}),/authorized quote/);
 const action={...f.action,amount:'999'},accepted={...f.challenge.accepted,amount:'999'},challenge={...f.challenge,accepted,required:{...f.challenge.required,accepts:[accepted]}},job={...f.job,intents:f.job.intents.map(intent=>({...intent,action}))};
 await assert.rejects(verifyPrefundedX402Settlement({...input,action,challenge,job}),/authorized quote/);
 await assert.rejects(verifyPrefundedX402Settlement({...input,partialWire:prepared.wire+'\n'}),/encoding/);assert.equal(f.signatures,1);
});
