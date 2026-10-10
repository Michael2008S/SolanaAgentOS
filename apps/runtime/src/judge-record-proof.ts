import { createHash } from 'node:crypto';
import { address,getAddressEncoder,getProgramDerivedAddress,getTransactionDecoder,getCompiledTransactionMessageDecoder,getSignatureFromTransaction,getPublicKeyFromAddress,verifySignature } from '@solana/kit';
import { canonicalJson } from './canonical-json.js';
import { judgeRecordInput,judgeRecordReceipt,type JudgeRecordInput } from './judge-record-protocol.js';
import * as z from 'zod/v4';
const sha=(s:string)=>createHash('sha256').update(s).digest(),bytes=(s:string)=>getAddressEncoder().encode(address(s));
/** Caller checks fresh RPC genesis, finalization, fee and canonical decision. */
export async function verifyJudgeRecordWire(program:string,judge:string,input:JudgeRecordInput,raw:z.infer<typeof judgeRecordReceipt>,wire:string){
 input=judgeRecordInput.parse(input);const receipt=judgeRecordReceipt.parse(raw);
 if(wire.length>2000||receipt.tenant!==input.tenant||receipt.escrow!==input.escrow||receipt.taskHash!==input.taskHash||receipt.resultHash!==input.resultHash||receipt.verdict!==input.judgment.verdict||receipt.judgmentHash!==sha(canonicalJson(input.judgment)).toString('hex'))throw new Error('Judge proof commitments differ.');
 const tx=getTransactionDecoder().decode(Buffer.from(wire,'base64')),m=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 if(m.version!==0||m.instructions.length!==1||m.header.numSignerAccounts!==2||String(getSignatureFromTransaction(tx))!==receipt.signature)throw new Error('Judge proof transaction differs.');
 const ix=m.instructions[0],keys=(ix.accountIndices??[]).map(i=>m.staticAccounts[i]),authority=keys[0],payer=m.staticAccounts[0];
 if(!authority||m.staticAccounts[ix.programAddressIndex]!==program||new Set([authority,payer]).size!==2||![authority,payer].every(key=>m.staticAccounts.slice(0,2).includes(key)))throw new Error('Judge proof signers differ.');
 const derive=async(prefix:string,key:string)=>String((await getProgramDerivedAddress({programAddress:address(program),seeds:[Buffer.from(prefix),bytes(key)]}))[0]),session=String((await getProgramDerivedAddress({programAddress:address(program),seeds:[Buffer.from('session'),bytes(judge),bytes(authority)]}))[0]),decision=await derive('escrow_decision',input.escrow);
 const expectedKeys=[authority,payer,judge,await derive('policy',judge),session,input.escrow,await derive('escrow_judge',input.escrow),decision,'11111111111111111111111111111111'];
 if(receipt.decision!==decision||keys.length!==9||keys.some((key,i)=>key!==expectedKeys[i])||!Buffer.from(ix.data??[]).equals(Buffer.concat([sha('global:record_escrow_judgment').subarray(0,8),Buffer.from([['pass','fail','needs_review'].indexOf(input.judgment.verdict)]),Buffer.from(input.taskHash,'hex'),Buffer.from(input.resultHash,'hex'),sha(canonicalJson(input.judgment))])))throw new Error('Judge proof instruction differs.');
 for(const key of m.staticAccounts.slice(0,2))if(!tx.signatures[key]||!await verifySignature(await getPublicKeyFromAddress(key),tx.signatures[key]!,tx.messageBytes))throw new Error('Judge proof signature is invalid.');
 return {session};
}
