import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { address,getAddressEncoder,getProgramDerivedAddress } from '@solana/kit';
import { workerToolRequest } from './worker-tool-request.js';
import { isValidSolanaAddress } from './memory.js';
const key=z.string().refine(isValidSolanaAddress),atomic=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>BigInt(v)<=18446744073709551615n),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const workerToolPaymentInput=z.object({tenant:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),escrow:key,taskHash:hash,toolId:hash,dispatchId:z.string().uuid()}).strict();
export type WorkerToolPaymentInput=z.infer<typeof workerToolPaymentInput>;
export const workerToolPaymentProfiles=z.array(z.object({tenant:workerToolPaymentInput.shape.tenant,escrow:key,taskHash:hash,taskId:atomic,tools:z.array(z.object({request:workerToolRequest,executionId:atomic,actionId:atomic}).strict()).min(1).max(3)}).strict()).max(100).refine(v=>new Set(v.map(p=>p.tenant+':'+p.escrow)).size===v.length,'Duplicate Worker payment scopes');
export const workerToolId=(request:z.infer<typeof workerToolRequest>)=>createHash('sha256').update(JSON.stringify(workerToolRequest.parse(request))).digest('hex');
const digest=(text:string)=>createHash('sha256').update(text).digest(),bytes=(key:string)=>Buffer.from(getAddressEncoder().encode(address(key))),u64=(id:string)=>{const value=Buffer.alloc(8);value.writeBigUInt64LE(BigInt(id));return value;};
export async function workerTaskSkillScope(input:{program:string;agent:string;session:string;sessionKey:string;feePayer:string;provider:string;taskId:string;actionId:string;executionId:string;request:z.infer<typeof workerToolRequest>;amount:string}){
 const {program,agent,session,sessionKey,feePayer,provider,request}=input;
 const pda=async(program:string,seeds:Uint8Array[])=>String((await getProgramDerivedAddress({programAddress:address(program),seeds}))[0]);
 const execution=await pda(program,[Buffer.from('execution'),bytes(agent),u64(input.executionId)]),policy=await pda(program,[Buffer.from('policy'),bytes(agent)]),task=await pda(program,[Buffer.from('task'),bytes(agent),u64(input.taskId)]),taskAction=await pda(program,[Buffer.from('task_action'),bytes(task),u64(input.actionId)]);
 const inputHash=digest(JSON.stringify({skill:request.skill,prompt:request.prompt})),system='11111111111111111111111111111111',token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',ata='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',mint='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
 const tokenAddress=(owner:string)=>pda(ata,[bytes(owner),bytes(token),bytes(mint)]);
 const accounts=request.asset==='SOL'?[sessionKey,feePayer,agent,policy,session,await pda(program,[Buffer.from('vault'),bytes(agent)]),request.skill,provider,execution,system,task,taskAction]:[sessionKey,feePayer,agent,policy,session,mint,await tokenAddress(agent),request.skill,provider,await tokenAddress(provider),execution,token,ata,system,task,taskAction];
 return {execution,policy,task,taskAction,inputHash,accounts,roles:request.asset==='SOL'?[2,3,1,1,1,1,0,1,1,0,1,1]:[2,3,1,1,1,0,1,0,1,1,1,0,0,0,1,1],paymentData:Buffer.concat([digest('global:'+(request.asset==='SOL'?'pay_task_skill':'pay_task_usdc_skill')).subarray(0,8),u64(input.amount),inputHash,u64(input.executionId),u64(input.actionId)]),resultAccounts:[sessionKey,feePayer,agent,session,execution,task,taskAction],resultRoles:[2,3,0,0,1,1,0],resultData:(content:string)=>Buffer.concat([digest('global:record_task_skill_result').subarray(0,8),digest(content)])};
}

export const workerToolPaymentBinding=z.object({execution:key,taskId:atomic,actionId:atomic}).strict();
export const workerToolPaymentReceipt=workerToolPaymentBinding.extend({tenant:workerToolPaymentInput.shape.tenant,escrow:key,dispatchId:z.string().uuid(),paymentSignature:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),resultSignature:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),content:z.string().refine(v=>Buffer.byteLength(v)<=65536)}).strict();
export type WorkerToolPaymentReceipt=z.infer<typeof workerToolPaymentReceipt>;
