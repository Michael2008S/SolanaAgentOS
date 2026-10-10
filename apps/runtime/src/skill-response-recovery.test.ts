import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePaymentSignatureHeader,encodePaymentResponseHeader } from '@x402/core/http';
import { recoverSavedSkillResponse,type SavedSkillResponseScope } from './skill-response-recovery.js';
const scope:SavedSkillResponseScope={endpoint:'http://127.0.0.1:19791/fixture',program:'program',genesis:'a'.repeat(44),agent:'agent',skill:'skill',provider:'provider',asset:'USDC',amount:'1000',input:'public research',inputHash:'b'.repeat(64),execution:'execution',signature:'original-signature'};
const header=(change:(value:any)=>void=()=>{})=>{const value:any={x402Version:2,resource:{url:scope.endpoint},accepted:{scheme:'agentos-vault',network:'solana:'+scope.genesis.slice(0,32),asset:'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',amount:scope.amount,payTo:scope.provider,maxTimeoutSeconds:60,extra:{programId:scope.program,skill:scope.skill,inputHash:scope.inputHash}},payload:{agent:scope.agent,skill:scope.skill,inputHash:scope.inputHash,execution:scope.execution,signature:scope.signature}};change(value);return encodePaymentSignatureHeader(value);};
const response=(change:(value:any)=>void=()=>{},body='stored original body')=>{const settlement:any={success:true,transaction:scope.signature,network:'solana:'+scope.genesis.slice(0,32)};change(settlement);return new Response(body,{headers:{'PAYMENT-RESPONSE':encodePaymentResponseHeader(settlement)}});};
test('cached legacy response uses original proof and only the result-only route, reserving before dispatch',async()=>{
 let attempts=0,calls=0;const payment=header();
 const transport:typeof fetch=async(url,init)=>{calls++;assert.equal(attempts,1);assert.equal(url,scope.endpoint);assert.equal(init?.redirect,'error');const headers=new Headers(init?.headers);assert.equal(headers.get('AGENTOS-RESULT-ONLY'),'true');assert.equal(headers.get('PAYMENT-SIGNATURE'),payment);assert.deepEqual(JSON.parse(String(init?.body)),{protocol:'agentos-skill-v2',agent:scope.agent,paymentPreference:'USDC',skill:{address:scope.skill},request:{skill:scope.skill,prompt:scope.input,sha256:scope.inputHash}});return response();};
 assert.equal(await recoverSavedSkillResponse(scope,payment,()=>attempts++,transport),'stored original body');assert.equal(calls,1);
});
test('changed immutable quote or payment proof cannot contact the Provider or consume an attempt',async()=>{
 let attempts=0,calls=0;const transport:typeof fetch=async()=>{calls++;return response();};
 for(const [field,value] of [['scheme','exact'],['network','solana:other'],['asset','USDC'],['amount','999'],['payTo','other']])await assert.rejects(recoverSavedSkillResponse(scope,header(v=>v.accepted[field]=value),()=>attempts++,transport),/verified scope/);
 for(const field of ['agent','skill','inputHash','execution','signature'])await assert.rejects(recoverSavedSkillResponse(scope,header(v=>v.payload[field]='other'),()=>attempts++,transport),/verified scope/);
 await assert.rejects(recoverSavedSkillResponse(scope,header(v=>v.resource.url='http://other'),()=>attempts++,transport),/verified scope/);
 await assert.rejects(recoverSavedSkillResponse(scope,header(v=>v.accepted.extra.programId='other'),()=>attempts++,transport),/verified scope/);
 assert.equal(calls,0);assert.equal(attempts,0);
});
test('missing cache, changed settlement and oversized response fail without falling back to execution',async()=>{
 for(const result of [new Response(null,{status:404}),new Response(null,{status:501}),response(v=>v.transaction='other'),response(v=>v.network='other'),response(v=>v.success=false),response(()=>{},'x'.repeat(65537))]){let calls=0,attempts=0;await assert.rejects(recoverSavedSkillResponse(scope,header(),()=>attempts++,async()=>{calls++;return result;}));assert.equal(calls,1);assert.equal(attempts,1);}
 let attempts=0;await assert.rejects(recoverSavedSkillResponse(scope,header(),()=>attempts++,async()=>{throw new Error('disconnected');}),/disconnected/);assert.equal(attempts,1);
});
test('SOL cache recovery accepts the SOL quote and rejects the USDC Mint for the same scope',async()=>{
 const sol={...scope,asset:'SOL' as const};let calls=0;
 const transport:typeof fetch=async()=>{calls++;return response();};
 assert.equal(await recoverSavedSkillResponse(sol,header(v=>v.accepted.asset='SOL'),()=>{},transport),'stored original body');
 await assert.rejects(recoverSavedSkillResponse(sol,header(),()=>{},transport),/verified scope/);assert.equal(calls,1);
});
