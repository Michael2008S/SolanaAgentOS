import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner,getBase58Decoder } from '@solana/kit';
import { encodePaymentRequiredHeader,encodePaymentResponseHeader,decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { canonicalJson } from './canonical-json.js';
import { callStandardPaidResource,readStandardChallenge,parseMppAuth,standardCredential,recoverStandardPaidResponse,recoverMppPaidResponse,type StandardPaymentTerms } from './standard-payments.js';

const encode=(value:unknown)=>Buffer.from(canonicalJson(value)).toString('base64url');
// Protocol fixtures only; actual gateway acceptance must use finalized chain verification.
const fixtureVerifier=async()=>{};
async function fixture(){
 const [recipient,genesis,mint,sponsor]=await Promise.all(Array.from({length:4},()=>generateKeyPairSigner()));
 const signature=getBase58Decoder().decode(new Uint8Array(64).fill(8));
 const terms:StandardPaymentTerms={protocol:'mpp',endpoint:'http://127.0.0.1:9999/resource',cluster:'localnet',genesis:genesis.address,amount:'1000',currency:'sol',recipient:recipient.address};
 const request={amount:terms.amount,currency:terms.currency,recipient:terms.recipient,methodDetails:{network:'localnet'}};
 const auth=(value:unknown=request,extra='')=>'Payment id="fixture-challenge", realm="fixture", method="solana", intent="charge", request="'+encode(value)+'"'+extra;
 return {terms,signature,request,auth,mint:mint.address,sponsor:sponsor.address};
}
test('MPP cache retrieval verifies historical payment before exposing the exact original credential',async()=>{
 const f=await fixture(),input={method:'POST' as const,body:'{"question":"original"}'},response=new Response(null,{status:402,headers:{'www-authenticate':f.auth(f.request,', expires="2020-01-01T00:00:00Z", opaque="original"')}});
 assert.throws(()=>readStandardChallenge(response,f.terms),/expired/);
 const challenge=readStandardChallenge(response,f.terms,0),header=standardCredential(challenge,{signature:f.signature}).value;let requests=0,verified=0;
 const transport:typeof fetch=async(url,init)=>{requests++;assert.equal(verified,1);assert.equal(url,f.terms.endpoint);assert.equal(init?.method,input.method);assert.equal(init?.body,input.body);assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('authorization'),header);return new Response('Original cached answer',{headers:{'payment-receipt':encode({method:'solana',challengeId:'fixture-challenge',reference:f.signature,status:'success',timestamp:new Date().toISOString()})}});};
 assert.equal(await recoverMppPaidResponse(f.terms,input,challenge,header,f.signature,transport,async()=>{verified++;}),'Original cached answer');assert.equal(requests,1);
 await assert.rejects(recoverMppPaidResponse(f.terms,input,challenge,header,f.signature,transport,async()=>{throw new Error('Original payment not finalized');}),/not finalized/);assert.equal(requests,1);
 const changed=readStandardChallenge(new Response(null,{status:402,headers:{'www-authenticate':f.auth().replace('fixture-challenge','replacement')}}),f.terms);
 for(const [terms,quote,credential,sig,request] of [[{...f.terms,amount:'1001'},challenge,header,f.signature,input],[f.terms,changed,header,f.signature,input],[f.terms,challenge,header+'x',f.signature,input],[f.terms,challenge,header,getBase58Decoder().decode(new Uint8Array(64).fill(9)),input],[f.terms,challenge,header,f.signature,{...input,method:'GET' as const}]] as const){
  await assert.rejects(recoverMppPaidResponse(terms,request,quote,credential,sig,transport,fixtureVerifier));
 }assert.equal(requests,1);
});
test('MPP cache misses and invalid receipts remain unresolved without another challenge or payment',async()=>{
 const f=await fixture(),challenge=readStandardChallenge(new Response(null,{status:402,headers:{'www-authenticate':f.auth()}}),f.terms),header=standardCredential(challenge,{signature:f.signature}).value;
 const receipt={method:'solana',challengeId:'fixture-challenge',reference:f.signature,status:'success',timestamp:new Date().toISOString()};
 for(const response of [new Response(null,{status:402,headers:{'www-authenticate':f.auth()}}),new Response(null,{status:409}),new Response('wrong',{headers:{'payment-receipt':encode({...receipt,challengeId:'replacement'})}}),new Response('wrong',{headers:{'payment-receipt':encode({...receipt,reference:getBase58Decoder().decode(new Uint8Array(64).fill(9))})}}),new Response('x'.repeat(65537),{headers:{'payment-receipt':encode(receipt)}})]){
  let requests=0;await assert.rejects(recoverMppPaidResponse(f.terms,{method:'GET'},challenge,header,f.signature,async()=>{requests++;return response;},fixtureVerifier));assert.equal(requests,1);
 }
});
test('MPP push client echoes the exact challenge, binds receipt and performs one payment',async()=>{
 const f=await fixture();let payments=0,requests=0;
 const transport:typeof fetch=async(_input,init)=>{
  assert.equal(init?.redirect,'error');requests++;
  if(requests===1)return new Response('',{status:402,headers:{'www-authenticate':f.auth(f.request,', opaque="original\\\"value"')}});
  const header=new Headers(init?.headers).get('authorization')!;assert.ok(header.startsWith('Payment '));
  const encoded=header.slice(8),decoded=JSON.parse(Buffer.from(encoded,'base64url').toString());
  assert.equal(decoded.challenge.opaque,'original"value');assert.deepEqual(decoded.payload,{type:'signature',signature:f.signature});assert.equal(encoded,encode(decoded));
  return new Response('Public answer',{headers:{'payment-receipt':encode({method:'solana',challengeId:'fixture-challenge',reference:f.signature,status:'success',timestamp:new Date().toISOString()})}});
 };
 const result=await callStandardPaidResource(f.terms,{method:'GET'},async challenge=>{payments++;assert.equal(challenge.protocol,'mpp');return {signature:f.signature};},transport,fixtureVerifier);
 assert.equal(result.content,'Public answer');assert.equal(payments,1);assert.equal(requests,2);
});
test('MPP rejects price, identity, network, sponsorship, unsupported charges and ambiguous headers before wallet calls',async()=>{
 const f=await fixture();let payments=0;
 const malformed=[f.auth({...f.request,amount:'1001'}),f.auth({...f.request,currency:'SOL'}),f.auth({...f.request,methodDetails:{}}),
  f.auth({...f.request,methodDetails:{network:'devnet'}}),f.auth({...f.request,methodDetails:{network:'localnet',feePayer:true,feePayerKey:f.sponsor}}),
  f.auth({...f.request,methodDetails:{network:'localnet',splits:[{amount:'1',recipient:f.sponsor}]}}),f.auth({...f.request,amount:'18446744073709551616'}),
  f.auth(f.request,', expires="2020-01-01T00:00:00Z"'),f.auth(f.request,', expires="2030"'),f.auth(f.request,', ID="second"'),f.auth(f.request)+', Basic realm="another"',
  f.auth().replace(encode(f.request),Buffer.from('{"amount":"1000","amount":"1000"}').toString('base64url'))];
 for(const header of malformed)await assert.rejects(callStandardPaidResource(f.terms,{method:'GET'},async()=>{payments++;return {signature:f.signature};},async()=>new Response('',{status:402,headers:{'www-authenticate':header}}),fixtureVerifier));
 assert.equal(payments,0);assert.throws(()=>parseMppAuth(f.auth()+','));
});
test('x402 exact client selects pinned terms, sends standard payload and checks settlement',async()=>{
 const f=await fixture(),terms:StandardPaymentTerms={...f.terms,protocol:'x402',currency:f.mint,decimals:6,tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'};
 const accepted:PaymentRequirements={scheme:'exact',network:`solana:${terms.genesis.slice(0,32)}`,amount:terms.amount,asset:terms.currency,payTo:terms.recipient,maxTimeoutSeconds:60,extra:{feePayer:f.sponsor,memo:'invoice-1'}};
 const required={x402Version:2,resource:{url:terms.endpoint},accepts:[accepted]},transaction=Buffer.from('fixture-partial-wire-not-chain-proof').toString('base64');let payments=0,requests=0;
 let settlements=0;
 const result=await callStandardPaidResource(terms,{method:'POST',body:'{"question":"public"}'},async challenge=>{payments++;assert.equal(challenge.protocol,'x402');return {transaction};},async(_input,init)=>{
  requests++;if(requests===1)return new Response('',{status:402,headers:{'payment-required':encodePaymentRequiredHeader(required)}});
  const payload=decodePaymentSignatureHeader(new Headers(init?.headers).get('payment-signature')!);assert.deepEqual(payload.accepted,accepted);assert.deepEqual(payload.payload,{transaction});
  return new Response('Public result',{headers:{'payment-response':encodePaymentResponseHeader({success:true,transaction:f.signature,network:accepted.network})}});
 },async(_challenge,attempt,settled)=>{settlements++;assert.equal(attempt.signature,undefined);assert.equal(attempt.transaction,transaction);assert.equal(settled,f.signature);});
 assert.equal(result.content,'Public result');assert.equal(result.signature,f.signature);assert.equal(payments,1);assert.equal(requests,2);assert.equal(settlements,1);
 assert.throws(()=>readStandardChallenge(new Response('',{status:402,headers:{'payment-required':encodePaymentRequiredHeader({...required,accepts:[accepted,accepted]})}}),terms),/ambiguous/);
 assert.throws(()=>readStandardChallenge(new Response('',{status:402,headers:{'payment-required':encodePaymentRequiredHeader({...required,resource:{url:terms.endpoint+'/other'}})}}),terms),/resource/);
});
test('a failed delivery never triggers another charge and wrong settlement receipts fail',async()=>{
 const f=await fixture();let payments=0,requests=0;
 await assert.rejects(callStandardPaidResource(f.terms,{method:'GET'},async()=>{payments++;return {signature:f.signature};},async()=>{
  requests++;return requests===1?new Response('',{status:402,headers:{'www-authenticate':f.auth()}}):new Response('',{status:402,headers:{'www-authenticate':f.auth()}});
 },fixtureVerifier),/reconcile/);assert.equal(payments,1);assert.equal(requests,2);
 requests=0;
 await assert.rejects(callStandardPaidResource(f.terms,{method:'GET'},async()=>({signature:f.signature}),async()=>{
  requests++;return requests===1?new Response('',{status:402,headers:{'www-authenticate':f.auth()}}):new Response('ignored',{headers:{'payment-receipt':encode({method:'solana',challengeId:'another',reference:f.signature,status:'success',timestamp:new Date().toISOString()})}});
 },fixtureVerifier),/another challenge/);
});
test('required x402 identifier is preflighted before wallet use and echoed from the durable reservation',async()=>{
 const f=await fixture(),terms:StandardPaymentTerms={...f.terms,protocol:'x402',currency:f.mint,decimals:6,tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'};
 const accepted:PaymentRequirements={scheme:'exact',network:`solana:${terms.genesis.slice(0,32)}`,amount:terms.amount,asset:terms.currency,payTo:terms.recipient,maxTimeoutSeconds:60,extra:{feePayer:f.sponsor}};
 const extension={info:{required:true},schema:{type:'object',properties:{required:{type:'boolean'},id:{type:'string',minLength:16,maxLength:128}},required:['required']}},required={x402Version:2,resource:{url:terms.endpoint},accepts:[accepted],extensions:{'payment-identifier':extension}},transaction=Buffer.from('public-protocol-fixture').toString('base64');
 let payments=0;
 for(const paymentIdentifier of [undefined,'short'])await assert.rejects(callStandardPaidResource(terms,{method:'GET',paymentIdentifier},async()=>{payments++;return {transaction};},async()=>new Response(null,{status:402,headers:{'payment-required':encodePaymentRequiredHeader(required)}}),fixtureVerifier));assert.equal(payments,0);
 const paymentIdentifier='pay_12345678-1234-4234-8234-123456789abc';let requests=0;
 const result=await callStandardPaidResource(terms,{method:'GET',paymentIdentifier},async()=>{payments++;return {transaction};},async(_url,init)=>{
  if(++requests===1)return new Response(null,{status:402,headers:{'payment-required':encodePaymentRequiredHeader(required)}});
  const payload=decodePaymentSignatureHeader(new Headers(init?.headers).get('payment-signature')!);assert.deepEqual(payload.extensions,{'payment-identifier':{schema:extension.schema,info:{required:true,id:paymentIdentifier}}});
  return new Response('Original answer',{headers:{'payment-response':encodePaymentResponseHeader({success:true,transaction:f.signature,network:accepted.network})}});
 },fixtureVerifier);
 assert.equal(result.content,'Original answer');assert.equal(payments,1);assert.equal(requests,2);
});

test('cached x402 recovery reuses the exact original request and proof without a payment port',async()=>{
 const f=await fixture(),terms:StandardPaymentTerms={...f.terms,protocol:'x402',currency:f.mint,decimals:6,tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'};
 const accepted:PaymentRequirements={scheme:'exact',network:`solana:${terms.genesis.slice(0,32)}`,amount:terms.amount,asset:terms.currency,payTo:terms.recipient,maxTimeoutSeconds:60,extra:{feePayer:f.sponsor}};
 const required={x402Version:2,resource:{url:terms.endpoint},accepts:[accepted],extensions:{'payment-identifier':{info:{required:true},schema:{type:'object',properties:{required:{type:'boolean'},id:{type:'string',minLength:16,maxLength:128}},required:['required']}}}};
 const challenge=readStandardChallenge(new Response(null,{status:402,headers:{'payment-required':encodePaymentRequiredHeader(required)}}),terms),transaction=Buffer.from('original-public-partial').toString('base64');
 const input={method:'POST' as const,body:'{"question":"original"}',paymentIdentifier:'pay_12345678-1234-4234-8234-123456789abc',originalTransaction:transaction},header=standardCredential(challenge,{transaction},input.paymentIdentifier).value;
 let requests=0,verified=0;
 const transport:typeof fetch=async(url,init)=>{assert.equal(verified,1);requests++;assert.equal(url,terms.endpoint);assert.equal(init?.body,input.body);assert.equal(init?.redirect,'error');assert.equal(init?.method,'POST');assert.equal(new Headers(init?.headers).get('payment-signature'),header);return new Response('Cached original answer',{headers:{'payment-response':encodePaymentResponseHeader({success:true,transaction:f.signature,network:accepted.network})}});};
 assert.equal(await recoverStandardPaidResponse(terms,input,challenge,header,f.signature,transport,async()=>{verified++;}),'Cached original answer');assert.equal(requests,1);
 for(const changed of [{...input,paymentIdentifier:input.paymentIdentifier+'x'},{...input,originalTransaction:Buffer.from('replacement').toString('base64')},{...input,method:'GET' as const}])await assert.rejects(recoverStandardPaidResponse(terms,changed,challenge,header,f.signature,transport,fixtureVerifier));
 await assert.rejects(recoverStandardPaidResponse(terms,input,{...challenge,required:{...required,extensions:{}}} as typeof challenge,header,f.signature,transport,fixtureVerifier),/extension/);
 await assert.rejects(recoverStandardPaidResponse(terms,input,challenge,header,f.signature,transport,async()=>{throw new Error('Not finalized');}),/Not finalized/);assert.equal(requests,1);
 for(const status of [402,409,500]){let tries=0;await assert.rejects(recoverStandardPaidResponse(terms,input,challenge,header,f.signature,async()=>{tries++;return new Response(null,{status});},fixtureVerifier),/reconcile/);assert.equal(tries,1);}
 await assert.rejects(recoverStandardPaidResponse(terms,input,challenge,header,f.signature,async()=>new Response('wrong',{headers:{'payment-response':encodePaymentResponseHeader({success:true,transaction:getBase58Decoder().decode(new Uint8Array(64).fill(9)),network:accepted.network})}}),fixtureVerifier),/another settlement/);
 await assert.rejects(recoverStandardPaidResponse(terms,input,challenge,header,f.signature,async()=>new Response('x'.repeat(65537),{headers:{'payment-response':encodePaymentResponseHeader({success:true,transaction:f.signature,network:accepted.network})}}),fixtureVerifier),/limit/);
});
