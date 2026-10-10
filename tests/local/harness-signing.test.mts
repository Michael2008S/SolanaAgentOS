import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner,address,blockhash,createTransactionMessage,setTransactionMessageLifetimeUsingBlockhash,setTransactionMessageFeePayerSigner,appendTransactionMessageInstruction,getTransactionDecoder,getSignatureFromTransaction } from '@solana/kit';
import { LocalHarness } from './harness.mts';
async function fixture(){
 const h=new LocalHarness(),wallet=await generateKeyPairSigner(),recipient=await generateKeyPairSigner();let signs=0;const calls:string[]=[],state={error:null as unknown,fee:5000};
 const payer={...wallet,signTransactions:async(...args:Parameters<typeof wallet.signTransactions>)=>{signs++;calls.push('sign');return wallet.signTransactions(...args);}};
 const data=Buffer.alloc(12);data.writeUInt32LE(2);data.writeBigUInt64LE(1n,4);const instruction={programAddress:address('11111111111111111111111111111111'),accounts:[{address:payer.address,role:3},{address:recipient.address,role:1}],data};
 const message=appendTransactionMessageInstruction(instruction,setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(payer.address),lastValidBlockHeight:100n},setTransactionMessageFeePayerSigner(payer,createTransactionMessage({version:0}))));
 h.approved=true;h.initialSol=10_000_000_000n;h.signers={payer} as any;h.message=async()=>message;
 h.rpc=async(method,params=[])=>{if(method==='getBalance')return {value:10_000_000_000};if(method==='simulateTransaction'){const signed=(params[1] as any).sigVerify;calls.push(signed?'signed-simulation':'unsigned-simulation');const transaction=getTransactionDecoder().decode(Buffer.from(String(params[0]),'base64'));assert.equal(Object.values(transaction.signatures).some(Boolean),signed);return {value:{err:state.error,logs:['expected_rejection'],unitsConsumed:1}};}if(method==='getFeeForMessage'){calls.push('fee');return {value:state.fee};}if(method==='sendTransaction'){calls.push('send');return getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(String(params[0]),'base64')));}if(method==='getSignatureStatuses')return {value:[{err:null,confirmationStatus:'confirmed'}]};throw new Error('Unexpected RPC '+method);};
 return {h,state,calls,get signs(){return signs;}};
}
test('invalid preparation and excessive fees never reach a test wallet signer',async()=>{
 for(const mode of ['simulation','fee','expected']){const f=await fixture();if(mode==='fee')f.state.fee=10001;else f.state.error='rejected';if(mode==='expected')assert.equal(await f.h.tx('expected rejection',[],[],'expected_rejection'),'');else await assert.rejects(f.h.tx('invalid preparation',[]));assert.equal(f.signs,0);assert.equal(f.h.sent,0);assert.equal(f.calls.includes('send'),false);}
});
test('a valid preparation is simulated and fee-capped before signing, then signed-simulated before send',async()=>{
 const f=await fixture();assert.ok(await f.h.tx('bounded preparation',[]));assert.equal(f.signs,1);assert.equal(f.h.sent,1);assert.deepEqual(f.calls,['unsigned-simulation','fee','sign','signed-simulation','send']);
});
