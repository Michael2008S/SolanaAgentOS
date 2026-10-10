import * as z from 'zod/v4';
import {createHash} from 'node:crypto';
import {address,getAddressEncoder,getAddressDecoder,getProgramDerivedAddress,type ReadonlyUint8Array} from '@solana/kit';
import {isValidSolanaAddress} from './memory.js';
export const handoffSources=z.array(z.object({execution:z.string().refine(isValidSolanaAddress),contentHash:z.string().regex(/^[a-f0-9]{64}$/),content:z.string().min(1).max(65536)}).strict()).min(1).max(3).refine(rows=>new Set(rows.map(row=>row.execution)).size===rows.length&&rows.every(row=>Buffer.byteLength(row.content,'utf8')<=65536&&sha(row.content).toString('hex')===row.contentHash));
export type HandoffSources=z.infer<typeof handoffSources>;
const sha=(text:string)=>createHash('sha256').update(text).digest();
/** Recheck original finalized Escrow/source commitments without trusting the
 * publishing tenant, local disk, URLs, or model-generated source claims. */
export async function verifyHandoffSources(program:string,escrow:string,worker:string,resultHash:string,sources:HandoffSources,rpc:(method:string,params:unknown[])=>Promise<any>){
 const rows=handoffSources.parse(sources),enc=getAddressEncoder(),dec=getAddressDecoder();
 const pda=async(seed:string,bytes:ReadonlyUint8Array[])=>getProgramDerivedAddress({programAddress:address(program),seeds:[Buffer.from(seed),...bytes]});
 const account=async(key:string,name:string,length:number)=>{const a=(await rpc('getAccountInfo',[key,{encoding:'base64',commitment:'finalized'}])).value;if(!a||a.owner!==program||a.executable||a.data?.[1]!=='base64'||typeof a.data[0]!=='string'||a.data[0].length>1024)throw new Error('Shared source account is foreign or missing.');const bytes=Buffer.from(a.data[0],'base64');if(bytes.length!==length||!bytes.subarray(0,8).equals(sha('account:'+name).subarray(0,8)))throw new Error('Shared source account layout differs.');return bytes;};
 const [key,bump]=await pda('escrow_evidence',[enc.encode(address(escrow))]);
 const proof=await account(key,'EscrowEvidence',269),count=proof.readUInt32LE(72);
 if(dec.decode(proof.subarray(8,40))!==escrow||proof.subarray(40,72).toString('hex')!==resultHash||proof[76+count*64]!==bump||count!==rows.length)throw new Error('Shared sources differ from original delivery evidence.');
 for(const [i,row] of rows.entries()){
  const offset=76+i*64;
  if(dec.decode(proof.subarray(offset,offset+32))!==row.execution||proof.subarray(offset+32,offset+64).toString('hex')!==row.contentHash)throw new Error('Shared source order or commitment differs.');
  const execution=await account(row.execution,'Execution',132),[expected]=await pda('execution',[enc.encode(address(worker)),execution.subarray(40,48)]);
  if(expected!==row.execution||execution[131]!==0||dec.decode(execution.subarray(8,40))!==worker||![1,3].includes(execution[49])||execution[98]!==1||execution.subarray(99,131).toString('hex')!==row.contentHash)throw new Error('Shared source is not this Worker’s completed Skill Execution.');
 }
 return rows;
}
