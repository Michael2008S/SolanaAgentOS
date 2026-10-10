import * as z from 'zod/v4';
import { parseAutonomousJob,type AutonomousJob } from './autonomous-loop.js';
import { checkpointHash } from './autonomous-coordination.js';
import { AutonomousLeaseBusyError } from './autonomous-sqlite.js';
import { readResponseTextLimited } from './http-limits.js';
import { cancellationRequest,cancellationResult,cancellationAudit } from './autonomous-operator.js';
import { canonicalJson } from './canonical-json.js';
/** Trusted internal coordinator credential, separate from browser credentials.
 * A failed heartbeat loses this lease; it never silently acquires a fresh one. */
export class RemoteAutonomousStore {
 private readonly origin:URL;
 private hashes=new Map<string,string>();
 private leases=new Map<string,{token:string;lost:boolean;timer?:NodeJS.Timeout}>();
 constructor(endpoint:string,private readonly credential:string,private readonly transport:typeof fetch=fetch){
  this.origin=new URL(endpoint);if(this.origin.pathname!=='/'||this.origin.username||this.origin.password||this.origin.search||this.origin.hash||!(this.origin.protocol==='https:'||this.origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(this.origin.hostname))||!/^[A-Za-z0-9_-]{24,256}$/.test(credential))throw new Error('Task coordinator requires fixed HTTPS or loopback and an operator credential.');
 }
 private async request(value:unknown){
  const response=await this.transport(new URL('/coordination',this.origin),{method:'POST',redirect:'error',cache:'no-store',headers:{authorization:'Bearer '+this.credential,'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(15000)});
  if(!response.ok){await response.body?.cancel();if(response.status===409)throw new AutonomousLeaseBusyError();throw new Error('Task coordinator returned HTTP '+response.status);}
  const raw=await readResponseTextLimited(response,8_000_000,'Task coordinator response exceeds its limit.');if(raw.includes(this.credential))throw new Error('Coordinator echoed its credential.');const result=JSON.parse(raw);if(JSON.stringify(result).includes(this.credential))throw new Error('Coordinator echoed its credential.');return result;
 }
 async load(tenant:string,id:string){const job=parseAutonomousJob(await this.request({op:'load',tenant,id}));if(job.tenant!==tenant||job.id!==id)throw new Error('Coordinator returned another job.');this.hashes.set(tenant+':'+id,checkpointHash(job));return job;}
 async list(tenant:string){const raw=z.array(z.unknown()).max(200).parse(await this.request({op:'list',tenant}));return raw.map(value=>{const job=parseAutonomousJob(value);if(job.tenant!==tenant)throw new Error('Coordinator returned another tenant.');return job;});}
 async save(job:AutonomousJob){job=parseAutonomousJob(job);const key=job.tenant+':'+job.id,lease=this.leases.get(key);if(lease?.lost)throw new Error('Remote checkpoint lease is lost.');const result=await this.request({op:lease?'save':'create',tenant:job.tenant,id:job.id,job,...(lease?{token:lease.token,hash:this.hashes.get(key)}:{})});if(result.hash!==checkpointHash(job))throw new Error('Coordinator checkpoint differs.');this.hashes.set(key,result.hash);}
 async acquire(tenant:string,id:string){const key=tenant+':'+id;if(this.leases.has(key))throw new AutonomousLeaseBusyError();const result=z.object({token:z.string().uuid(),ttl:z.number().int().min(30000).max(120000)}).strict().parse(await this.request({op:'acquire',tenant,id})),lease={token:result.token,lost:false,timer:undefined as NodeJS.Timeout|undefined};this.leases.set(key,lease);
  const renew=()=>{lease.timer=setTimeout(()=>{void this.request({op:'renew',tenant,id,token:lease.token}).then(()=>{if(this.leases.get(key)===lease&&!lease.lost)renew();},()=>{lease.lost=true;});},Math.floor(result.ttl/4));lease.timer.unref();};renew();
  return async()=>{clearTimeout(lease.timer);this.leases.delete(key);if(!lease.lost)await this.request({op:'release',tenant,id,token:lease.token});};
 }
 events(tenant:string,after=0){return this.request({op:'events',tenant,after});}
 notificationStatus(tenant:string){return this.request({op:'notifications',tenant});}
 async requestCancellation(tenant:string,id:string){await this.request({op:'cancel',tenant,id});}
 async reviewedCancellation(value:unknown){const input=cancellationRequest.parse(value),result=cancellationResult.parse(await this.request({op:'cancel-reviewed',tenant:input.tenant,id:input.id,cancellation:input}));if(canonicalJson(result.audit.request)!==canonicalJson(input))throw new Error('Coordinator returned another operator cancellation.');return result;}
 async cancellationHistory(tenant:string,id:string){const value=await this.request({op:'cancellation-history',tenant,id});if(value===null)return null;const audit=cancellationAudit.parse(value);if(audit.request.tenant!==tenant||audit.request.id!==id)throw new Error('Coordinator returned another cancellation audit.');return audit;}
 async cancelled(tenant:string,id:string){return z.boolean().parse(await this.request({op:'cancelled',tenant,id}));}
}
