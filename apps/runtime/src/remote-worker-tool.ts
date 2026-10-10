import * as z from 'zod/v4';
import { isValidSolanaAddress } from './memory.js';
import { readResponseTextLimited } from './http-limits.js';
import { workerToolPaymentInput,workerToolPaymentBinding,workerToolPaymentReceipt,workerToolPaymentProfiles,type WorkerToolPaymentInput } from './worker-tool-payment.js';
const key=z.string().refine(isValidSolanaAddress);
export const runtimeWorkerToolProfiles=z.array(workerToolPaymentProfiles.element.extend({workerAgent:key,session:key,feePayer:key}).strict()).max(100).refine(profiles=>new Set(profiles.map(p=>p.workerAgent+':'+p.escrow)).size===profiles.length,'Ambiguous Worker tool scopes');
export class RemoteWorkerTool {
 private readonly origin:URL;
 constructor(endpoint:string,private readonly token:string,private readonly transport:typeof fetch=fetch){this.origin=new URL(endpoint);if(this.origin.pathname!=='/'||this.origin.username||this.origin.password||this.origin.search||this.origin.hash||!(this.origin.protocol==='https:'||this.origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(this.origin.hostname))||!/^[A-Za-z0-9_-]{24,256}$/.test(token))throw new Error('Worker tools require a fixed HTTPS origin or loopback and an operator credential.');}
 private async call(path:string,raw:WorkerToolPaymentInput){const input=workerToolPaymentInput.parse(raw),response=await this.transport(new URL(path,this.origin),{method:'POST',redirect:'error',cache:'no-store',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(55000)});if(!response.ok){await response.body?.cancel();throw new Error('Worker tool gateway returned HTTP '+response.status);}const text=await readResponseTextLimited(response,450000,'Worker tool gateway response exceeds its limit.');if(text.includes(this.token))throw new Error('Worker tool gateway echoed a protected credential.');const parsed=JSON.parse(text);if(JSON.stringify(parsed).includes(this.token))throw new Error('Worker tool gateway echoed a protected credential.');return {input,parsed};}
 async preflight(input:WorkerToolPaymentInput){return workerToolPaymentBinding.parse((await this.call('/worker/tool/preflight',input)).parsed);}
 async send(input:WorkerToolPaymentInput){const {parsed}=await this.call('/worker/tool/execute',input),receipt=workerToolPaymentReceipt.parse(parsed);if(receipt.tenant!==input.tenant||receipt.escrow!==input.escrow||receipt.dispatchId!==input.dispatchId)throw new Error('Worker tool receipt changed its original request.');return receipt;}
}
