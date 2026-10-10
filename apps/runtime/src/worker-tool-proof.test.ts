import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { address,getAddressEncoder } from '@solana/kit';
import { verifyWorkerToolReceipt,workerToolConfiguredBinding } from './worker-tool-proof.js';
import { workerToolId } from './worker-tool-payment.js';
test('Worker receipt requires original native Task payment/result wires and rejects mismatched body, allocation, network or signatures',async()=>{
 const root='docs/evidence/worker-tool-gateway-usdc-2026-10-10T01-52-08-727Z',read=async(file:string)=>JSON.parse(await readFile(join(root,file),'utf8')),r=await read('report.json'),snapshots=await read('account-snapshots.json'),payment=await read('payment-transaction.json'),result=await read('result-transaction.json'),digest=(s:string)=>createHash('sha256').update(s).digest(),encode=(key:string)=>Buffer.from(getAddressEncoder().encode(address(key)));
 const paymentSignature=r.transactions.find((t:any)=>t.name==='pay bound Worker Task Skill').signature,resultSignature=r.transactions.find((t:any)=>t.name==='commit Worker tool response').signature,profile={tenant:'worker',workerAgent:r.worker,session:r.workerSession,feePayer:r.feePayer,escrow:r.escrow,taskHash:r.ready.taskHash,taskId:'0',tools:[{request:r.request,executionId:'0',actionId:'0'}]},input={tenant:'worker',escrow:r.escrow,taskHash:profile.taskHash,toolId:workerToolId(r.request),dispatchId:r.ready.tools[0].dispatchId},receipt={tenant:'worker',escrow:r.escrow,dispatchId:input.dispatchId,execution:r.toolExecution,taskId:'0',actionId:'0',paymentSignature,resultSignature,content:r.content};
 // Older evidence omitted the Skill snapshot; reconstruct only its publicly known registry fields.
 const skill=Buffer.alloc(130);digest('account:Skill').subarray(0,8).copy(skill);encode(r.provider).copy(skill,8);digest('worker-tool').copy(skill,40);digest(r.request.endpoint).copy(skill,72);snapshots[r.request.skill]={value:{owner:r.program,executable:false,data:[skill.toString('base64'),'base64']}};
 let network=r.genesis;const rpc=async(method:string,params:unknown[])=>method==='getGenesisHash'?network:method==='getAccountInfo'?snapshots[String(params[0])]:method==='getTransaction'?params[0]===paymentSignature?payment:params[0]===resultSignature?result:null:assert.fail('Unexpected RPC');const chain={program:r.program,genesis:r.genesis,rpc};
 assert.equal((await verifyWorkerToolReceipt(chain,profile,input,receipt)).execution,r.toolExecution);assert.deepEqual(await workerToolConfiguredBinding(r.program,profile,input),{execution:r.toolExecution,taskId:'0',actionId:'0'});
 for(const changed of [{...receipt,content:'forged body'},{...receipt,execution:r.worker},{...receipt,taskId:'1'},{...receipt,actionId:'1'},{...receipt,paymentSignature:resultSignature},{...receipt,resultSignature:paymentSignature},{...receipt,dispatchId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'}])await assert.rejects(verifyWorkerToolReceipt(chain,profile,input,changed));
 network='other';await assert.rejects(verifyWorkerToolReceipt(chain,profile,input,receipt));network=r.genesis;
 const key=r.taskAction,old=snapshots[key];snapshots[key]={value:{...old.value,owner:r.worker}};await assert.rejects(verifyWorkerToolReceipt(chain,profile,input,receipt));snapshots[key]=old;
 const offset=result.slot;result.slot=payment.slot-1;await assert.rejects(verifyWorkerToolReceipt(chain,profile,input,receipt),/before its original payment/);result.slot=offset;
 const fee=payment.meta.fee;payment.meta.fee=10001;await assert.rejects(verifyWorkerToolReceipt(chain,profile,input,receipt));payment.meta.fee=fee;
 const wire=payment.transaction;payment.transaction=['altered','base64'];await assert.rejects(verifyWorkerToolReceipt(chain,profile,input,receipt));payment.transaction=wire;
});
