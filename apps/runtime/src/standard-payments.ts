import { address } from '@solana/kit';
import { decodePaymentRequiredHeader,decodePaymentResponseHeader,decodePaymentSignatureHeader,encodePaymentRequiredHeader,encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements,PaymentRequired } from '@x402/core/types';
import * as z from 'zod/v4';
import { x402IdentifierExtensions } from './x402-payment-identifier.js';
import { canonicalJson } from './canonical-json.js';
import { readResponseTextLimited } from './http-limits.js';
import { chainNetwork } from '../../../shared/chain-network.js';

const atomic=z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value=>BigInt(value)<=18446744073709551615n);
const publicAddress=z.string().refine(value=>{try{address(value);return true;}catch{return false;}});
const signature=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
export type StandardPaymentTerms={protocol:'mpp'|'x402';endpoint:string;cluster:'devnet'|'localnet';genesis:string;
 amount:string;currency:string;recipient:string;decimals?:number;tokenProgram?:string};
export type StandardPaymentChallenge={protocol:'mpp';auth:Record<string,string>;request:Record<string,unknown>;memo?:string}|
 {protocol:'x402';required:PaymentRequired;accepted:PaymentRequirements;memo?:string};

function decodeUrlJson(value:string){
 if(value.length>16384||!/^[A-Za-z0-9_-]+={0,2}$/.test(value))throw new Error('Invalid payment JSON encoding.');
 const bytes=Buffer.from(value,'base64url');
 if(bytes.toString('base64url')!==value.replace(/=+$/,''))throw new Error('Invalid payment JSON encoding.');
 const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes),decoded=JSON.parse(raw);
 // JCS is mandatory for MPP header JSON; this also rejects duplicate keys.
 if(canonicalJson(decoded)!==raw)throw new Error('Payment header JSON must use canonical encoding.');
 return decoded;
}
const encodeUrlJson=(value:unknown)=>Buffer.from(canonicalJson(value)).toString('base64url');
/** One Payment challenge only; mixed/multiple authentication challenges are unsupported. */
export function parseMppAuth(header:string):Record<string,string>{
 if(header.length>20000||!/^[\x20-\x7e]*$/.test(header)||!/^Payment\s+/i.test(header))throw new Error('Expected one MPP Payment challenge.');
 const result:Record<string,string>={},rest=header.replace(/^Payment\s+/i,'');let offset=0;
 while(offset<rest.length){
  const match=/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\[\x20-\x7e])*"|[A-Za-z0-9._~+\/-]+=*)\s*(,|$)/.exec(rest.slice(offset));
  if(!match)throw new Error('Malformed MPP auth parameters.');
  const key=match[1].toLowerCase();if(Object.hasOwn(result,key))throw new Error('Duplicate MPP auth parameter.');
  if(!['id','realm','method','intent','request','expires','digest','opaque'].includes(key))throw new Error('Unsupported MPP auth parameter.');
  result[key]=match[2].startsWith('"')?match[2].slice(1,-1).replace(/\\([\x20-\x7e])/g,'$1'):match[2];
  offset+=match[0].length;if(match[3]===','&&offset===rest.length)throw new Error('Trailing MPP auth separator.');
 }
 for(const key of ['id','realm','method','intent','request'])if(!result[key])throw new Error('Missing MPP auth parameter.');
 return result;
}
const detailsSchema=z.object({network:z.enum(['mainnet','devnet','localnet']).optional(),decimals:z.number().int().min(0).max(9).optional(),
 tokenProgram:publicAddress.optional(),feePayer:z.boolean().optional(),feePayerKey:publicAddress.optional(),recentBlockhash:publicAddress.optional()}).strict();
const requestSchema=z.object({amount:atomic,currency:z.string().max(128),recipient:publicAddress,
 description:z.string().max(256).optional(),externalId:z.string().refine(value=>Buffer.byteLength(value)<=566).optional(),methodDetails:detailsSchema.optional()}).strict();

export function validateStandardTerms(terms:StandardPaymentTerms){
 const url=new URL(terms.endpoint);
 if(url.username||url.password||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error('Paid resource requires a fixed HTTPS or loopback endpoint.');
 atomic.parse(terms.amount);publicAddress.parse(terms.recipient);publicAddress.parse(terms.genesis);
 if(!['mpp','x402'].includes(terms.protocol)||!['devnet','localnet'].includes(terms.cluster))throw new Error('Unsupported payment protocol or cluster.');
 if(chainNetwork(terms.cluster,terms.genesis).genesisHash!==terms.genesis)throw new Error('Payment genesis does not match its configured cluster.');
 if(terms.currency==='sol'){
  if(terms.protocol==='x402'||terms.decimals!==undefined||terms.tokenProgram!==undefined)throw new Error('Native SOL is supported only by the MPP charge profile.');
 }else{
  publicAddress.parse(terms.currency);z.number().int().min(0).max(9).parse(terms.decimals);
  if(!['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(terms.tokenProgram??''))throw new Error('Pin the verified token program for SPL payments.');
 }
}

/** No remote amount, recipient, cluster or currency can widen operator terms. */
export function readStandardChallenge(response:Response,terms:StandardPaymentTerms,now=Date.now()):StandardPaymentChallenge{
 validateStandardTerms(terms);if(response.status!==402)throw new Error('Expected Payment Required before signing.');
 if(terms.protocol==='mpp'){
  const auth=parseMppAuth(response.headers.get('www-authenticate')??'');
  if(auth.method!=='solana'||auth.intent!=='charge')throw new Error('Unsupported MPP payment method or intent.');
  if(auth.expires){z.iso.datetime({offset:true}).parse(auth.expires);if(Date.parse(auth.expires)<=now)throw new Error('MPP challenge is expired.');}
  const request=requestSchema.parse(decodeUrlJson(auth.request)),details=request.methodDetails;
  if((details?.network??'mainnet')!==terms.cluster||request.amount!==terms.amount||request.currency!==terms.currency||request.recipient!==terms.recipient)throw new Error('MPP challenge differs from fixed payment terms.');
  // Push mode cannot use server sponsorship. Splits/confidential fields are rejected by the strict schema.
  if(details?.feePayer||details?.feePayerKey)throw new Error('MPP push payments cannot use server fee sponsorship.');
  if(terms.currency==='sol'?(details?.decimals!==undefined||details?.tokenProgram!==undefined):(details?.decimals!==terms.decimals||details?.tokenProgram!==undefined&&details.tokenProgram!==terms.tokenProgram))throw new Error('MPP token details differ from the verified asset.');
  return {protocol:'mpp',auth,request,memo:request.externalId};
 }
 const header=response.headers.get('payment-required')??'';if(!header||header.length>20000)throw new Error('Missing or oversized x402 challenge.');
 const required=decodePaymentRequiredHeader(header);
 if(required.x402Version!==2||required.resource?.url!==new URL(terms.endpoint).href||!Array.isArray(required.accepts)||required.accepts.length>20)throw new Error('x402 resource or version differs from the configured endpoint.');
 const matches=required.accepts.filter(option=>option.scheme==='exact'&&option.network==='solana:'+terms.genesis.slice(0,32)&&
  option.amount===terms.amount&&option.asset===terms.currency&&option.payTo===terms.recipient);
 if(matches.length!==1)throw new Error('x402 exact quote is missing or ambiguous.');
 const accepted=matches[0];
 z.number().int().min(1).max(300).parse(accepted.maxTimeoutSeconds);publicAddress.parse(accepted.extra?.feePayer);
 const memo=accepted.extra?.memo;
 if(memo!==undefined&&(typeof memo!=='string'||Buffer.byteLength(memo)>256))throw new Error('Invalid x402 payment memo.');
 return {protocol:'x402',required,accepted,memo:typeof memo==='string'?memo:undefined};
}

export type StandardPaymentAttempt={signature?:string;transaction?:string};
export function standardCredential(challenge:StandardPaymentChallenge,payment:StandardPaymentAttempt,paymentIdentifier?:string){
 if(challenge.protocol==='mpp')return {name:'Authorization',value:'Payment '+encodeUrlJson({challenge:challenge.auth,payload:{type:'signature',signature:signature.parse(payment.signature)}})};
 if(!payment.transaction||payment.transaction.length>12000||!/^[-A-Za-z0-9+/]+=*$/.test(payment.transaction)||Buffer.from(payment.transaction,'base64').toString('base64')!==payment.transaction)throw new Error('x402 requires the original partially signed transaction.');
 const extensions=x402IdentifierExtensions(challenge.required,paymentIdentifier);
 return {name:'PAYMENT-SIGNATURE',value:encodePaymentSignatureHeader({x402Version:2,resource:challenge.required.resource,accepted:challenge.accepted,payload:{transaction:payment.transaction},...(extensions?{extensions}:{})})};
}

export function verifyStandardReceipt(response:Response,challenge:StandardPaymentChallenge,paymentSignature:string|undefined,terms:StandardPaymentTerms):string{
 if(response.status!==200)throw new Error('Paid resource did not complete; reconcile the original payment, do not pay again.');
 if(challenge.protocol==='mpp'){
  const receipt=z.object({method:z.literal('solana'),challengeId:z.string(),reference:signature,status:z.literal('success'),timestamp:z.iso.datetime({offset:true})}).strict().parse(decodeUrlJson(response.headers.get('payment-receipt')??''));
  if(receipt.challengeId!==challenge.auth.id||receipt.reference!==paymentSignature)throw new Error('MPP receipt refers to another challenge or payment.');
  return receipt.reference;
 }else{
  const header=response.headers.get('payment-response')??'';if(!header||header.length>20000)throw new Error('Missing x402 settlement receipt.');
  const receipt=decodePaymentResponseHeader(header);
  if(receipt.success!==true||paymentSignature!==undefined&&receipt.transaction!==paymentSignature||receipt.network!=='solana:'+terms.genesis.slice(0,32))throw new Error('x402 receipt refers to another settlement or network.');
  return signature.parse(receipt.transaction);
 }
}

/** The wallet port must persist the original signed attempt before exposing it.
 * This transport performs no payment retries. Chain verification is separately required. */
export async function callStandardPaidResource(terms:StandardPaymentTerms,input:{method:'GET'|'POST';body?:string;paymentIdentifier?:string},
 pay:(challenge:StandardPaymentChallenge)=>Promise<StandardPaymentAttempt>,transport:typeof fetch=fetch,
 verifySettlement:(challenge:StandardPaymentChallenge,payment:StandardPaymentAttempt,settledSignature:string)=>Promise<void>){
 if(typeof verifySettlement!=='function')throw new Error('Standard paid resources require an independent settlement verifier.');
 validateStandardTerms(terms);if(input.body!==undefined&&Buffer.byteLength(input.body)>16384)throw new Error('Paid request exceeds its limit.');
 if(input.method==='GET'&&input.body!==undefined)throw new Error('GET paid requests cannot contain a body.');
 const request={method:input.method,redirect:'error' as const,headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:input.body})};
 const response=await transport(terms.endpoint,{...request,signal:AbortSignal.timeout(20000)});
 try{
  const challenge=readStandardChallenge(response,terms);await response.body?.cancel();
  if(challenge.protocol==='x402')x402IdentifierExtensions(challenge.required,input.paymentIdentifier);
  // The caller owns the durable reservation and all Session/chain checks.
  const payment=await pay(structuredClone(challenge)),credential=standardCredential(challenge,payment,input.paymentIdentifier);
  const delivered=await transport(terms.endpoint,{...request,headers:{...request.headers,[credential.name]:credential.value},signal:AbortSignal.timeout(30000)});
  try{const settledSignature=verifyStandardReceipt(delivered,challenge,payment.signature,terms);
   await verifySettlement(structuredClone(challenge),structuredClone(payment),settledSignature);
   return {content:await readResponseTextLimited(delivered,65536,'Paid response exceeds its limit.'),signature:settledSignature,challenge};
  }finally{await delivered.body?.cancel().catch(()=>{});}
 }finally{await response.body?.cancel().catch(()=>{});}
}

/** Retrieve an operator-approved idempotent cache entry using the original credential.
 * There is intentionally no wallet/payment port and no new challenge negotiation. */
export async function recoverStandardPaidResponse(terms:StandardPaymentTerms,input:{method:'GET'|'POST';body?:string;paymentIdentifier:string;originalTransaction:string},
 challenge:StandardPaymentChallenge,originalHeader:string,settledSignature:string,transport:typeof fetch,
 verifySettlement:()=>Promise<void>){
 validateStandardTerms(terms);
 if(terms.protocol!=='x402'||challenge.protocol!=='x402'||!challenge.required.extensions?.['payment-identifier'])throw new Error('Response recovery requires the original x402 payment identifier extension.');
 if(typeof verifySettlement!=='function')throw new Error('Response recovery requires independent settlement verification.');
 if(!['GET','POST'].includes(input.method)||input.body!==undefined&&Buffer.byteLength(input.body)>16384||input.method==='GET'&&input.body!==undefined)throw new Error('Invalid original paid request.');
 if(originalHeader.length>20000)throw new Error('Original payment credential exceeds its limit.');
 // Revalidate historical terms; expiry must not turn retrieval into another payment.
 const checked=readStandardChallenge(new Response(null,{status:402,headers:{'payment-required':encodePaymentRequiredHeader(challenge.required)}}),terms,0);
 const decoded=decodePaymentSignatureHeader(originalHeader),transaction=decoded.payload.transaction;
 if(typeof transaction!=='string'||transaction!==input.originalTransaction||standardCredential(checked,{transaction},input.paymentIdentifier).value!==originalHeader)throw new Error('Response recovery cannot replace its original payment credential or identifier.');
 signature.parse(settledSignature);
 // Do not expose a credential to the provider unless the original payment is finalized.
 await verifySettlement();
 const delivered=await transport(terms.endpoint,{method:input.method,redirect:'error',headers:{'content-type':'application/json','PAYMENT-SIGNATURE':originalHeader},...(input.body===undefined?{}:{body:input.body}),signal:AbortSignal.timeout(30000)});
 try{verifyStandardReceipt(delivered,checked,settledSignature,terms);
  return await readResponseTextLimited(delivered,65536,'Paid response exceeds its limit.');
 }finally{await delivered.body?.cancel().catch(()=>{});}
}

/** MPP does not promise a response cache. Only an operator-approved service may
 * receive this original credential again, and must return its saved operation.
 * Historical expiry is ignored for retrieval, never for a fresh payment. */
export async function recoverMppPaidResponse(terms:StandardPaymentTerms,input:{method:'GET'|'POST';body?:string},
 challenge:StandardPaymentChallenge,originalHeader:string,settledSignature:string,transport:typeof fetch,
 verifySettlement:()=>Promise<void>){
 validateStandardTerms(terms);
 if(terms.protocol!=='mpp'||challenge.protocol!=='mpp')throw new Error('Response recovery requires the original MPP challenge.');
 if(typeof verifySettlement!=='function')throw new Error('Response recovery requires independent settlement verification.');
 if(!['GET','POST'].includes(input.method)||input.body!==undefined&&Buffer.byteLength(input.body)>16384||input.method==='GET'&&input.body!==undefined)throw new Error('Invalid original paid request.');
 if(originalHeader.length>20000)throw new Error('Original payment credential exceeds its limit.');
 const checked=readStandardChallenge(new Response(null,{status:402,headers:{'www-authenticate':'Payment '+Object.entries(challenge.auth).map(([key,value])=>key+'='+JSON.stringify(value)).join(', ')}}),terms,0);
 if(standardCredential(checked,{signature:settledSignature}).value!==originalHeader)throw new Error('Response recovery cannot replace its original MPP credential or signature.');
 await verifySettlement();
 const delivered=await transport(terms.endpoint,{method:input.method,redirect:'error',headers:{'content-type':'application/json',Authorization:originalHeader},...(input.body===undefined?{}:{body:input.body}),signal:AbortSignal.timeout(30000)});
 try{verifyStandardReceipt(delivered,checked,settledSignature,terms);
  return await readResponseTextLimited(delivered,65536,'Paid response exceeds its limit.');
 }finally{await delivered.body?.cancel().catch(()=>{});}
}
