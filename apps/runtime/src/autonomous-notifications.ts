import { createHash,createHmac } from 'node:crypto';
import * as z from 'zod/v4';
import type { SQLiteAutonomousStore } from './autonomous-sqlite.js';
import type { NotificationClaim } from './autonomous-notification-types.js';
const schema=z.object({tenant:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),endpoint:z.string().url().max(2000),secretEnv:z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)}).strict();
export type NotificationDestination=z.infer<typeof schema>&{hash:string};
export function parseNotificationDestinations(raw:string,tenants:readonly string[],env:NodeJS.ProcessEnv=process.env):NotificationDestination[]{
 if(Buffer.byteLength(raw)>200_000)throw new Error('Notification configuration exceeds its limit.');
 const values=z.array(schema).max(100).parse(JSON.parse(raw));
 if(new Set(values.map(value=>value.tenant)).size!==values.length)throw new Error('Notification tenants must be unique.');
 return values.map(value=>{
  const url=new URL(value.endpoint);if(!tenants.includes(value.tenant)||url.username||url.password||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Notification destination requires its configured tenant and a fixed HTTPS or loopback URL.');
  notificationSecret(value.secretEnv,env);const endpoint=url.href;
  return {...value,endpoint,hash:createHash('sha256').update(JSON.stringify({endpoint,secretEnv:value.secretEnv})).digest('hex')};
 });
}
function notificationSecret(name:string,env:NodeJS.ProcessEnv){const secret=env[name];if(typeof secret!=='string'||secret.length<32||secret.length>512||/[\r\n\0]/.test(secret))throw new Error('Notification signing credential is unavailable.');return secret;}
/** Stable event body/id, at-least-once delivery. Receivers must deduplicate id.
 * This worker never plans, invokes tools, signs transactions or changes job state. */
export class AutonomousNotifier {
 private timer?:NodeJS.Timeout;private watching=false;private active?:Promise<number>;
 private pendingSettlement?:{claim:NotificationClaim;outcome:'sent'|'retry'|'failed';at:number};
 constructor(private readonly store:SQLiteAutonomousStore,private readonly destinations:readonly NotificationDestination[],private readonly transport:typeof fetch=fetch,private readonly now=()=>Date.now(),private readonly env:NodeJS.ProcessEnv=process.env){}
 start(){if(this.watching)return;this.watching=true;this.schedule(0);}
 private schedule(delay:number){if(!this.watching||this.timer)return;this.timer=setTimeout(()=>{this.timer=undefined;void this.runOnce().catch(()=>console.error('Autonomous notifications could not be delivered; original queue preserved.')).finally(()=>this.schedule(5000));},delay);this.timer.unref();}
 async stop(){this.watching=false;clearTimeout(this.timer);this.timer=undefined;try{await this.active;}catch{/* Durable original lease remains for proven-dead-process recovery. */}}
 runOnce():Promise<number>{if(this.active)return this.active;const task=this.deliverBatch().finally(()=>{if(this.active===task)this.active=undefined;});this.active=task;return task;}
 private async deliverBatch(){
  if(this.pendingSettlement)await this.persistSettlement();
  let count=0;
  for(;count<10;count++){
   const claim=await this.store.claimNotification(this.now());if(!claim)break;
   let outcome:'sent'|'retry'|'failed'='retry';
   try{
    const destination=this.destinations.find(value=>value.tenant===claim.tenant&&value.hash===claim.destinationHash);if(!destination)throw new Error('Notification destination differs.');
    const timestamp=String(Math.floor(this.now()/1000)),signature=createHmac('sha256',notificationSecret(destination.secretEnv,this.env)).update(timestamp+'.'+claim.id+'.'+claim.body).digest('hex');
    const response=await this.transport(destination.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{'content-type':'application/json','idempotency-key':claim.id,'x-agentos-event':claim.id,'x-agentos-timestamp':timestamp,'x-agentos-signature':'v1='+signature},body:claim.body});
    outcome=response.status>=200&&response.status<300?'sent':response.status===429||response.status>=500?'retry':'failed';await response.body?.cancel().catch(()=>{});
   }catch{/* No remote response, credentials, job output or exception body is logged. */}
   this.pendingSettlement={claim,outcome,at:this.now()};await this.persistSettlement();
  }return count;
 }
 private async persistSettlement(){
  const pending=this.pendingSettlement;if(!pending)return;
  // A transient checkpoint failure must not strand a live-PID lease or resend
  // an acknowledged HTTP effect. Retry only its original outcome persistence.
  await this.store.settleNotification(pending.claim,pending.outcome,pending.at);if(this.pendingSettlement===pending)this.pendingSettlement=undefined;
 }
}
