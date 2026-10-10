import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as z from 'zod/v4';
import { autonomousAcceptanceSchema } from './autonomous-acceptance.js';
import { AutonomousLoop, type AutonomousJob } from './autonomous-loop.js';
import { SQLiteAutonomousStore,AutonomousLeaseBusyError } from './autonomous-sqlite.js';
import { isValidSolanaAddress } from './memory.js';
import { redactModelError, recordModelDiagnostic } from './model-diagnostics.js';

const atomic = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= 18446744073709551615n);
const key = z.string().refine(isValidSolanaAddress);
const limits = z.object({ sol: atomic, usdc: atomic, maxCycles: z.number().int().min(1).max(50),
  maxActions: z.number().int().min(1).max(200), maxModelRequests: z.number().int().min(1).max(100),
  tools: z.array(z.string().min(1).max(120)).min(1).max(100) }).strict();
const profile = z.object({ tenant: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  allowSessionTokenCustody:z.boolean().optional(),agent: key, session: key, maxDurationSeconds: z.number().int().min(60).max(86400), limits,
}).strict();
export type AutonomousTenant = z.infer<typeof profile>;
export function parseHeadlessTenantScopes(raw:string){
  if(Buffer.byteLength(raw)>200_000)throw new Error('Headless scopes exceed their configuration limit.');
  const values=z.array(profile.omit({session:true,tokenSha256:true})).min(1).max(100).parse(JSON.parse(raw));
  if(new Set(values.map(value=>value.tenant)).size!==values.length)throw new Error('Headless tenant scopes must be unique.');return values;
}
export function parseAutonomousTenants(raw: string): AutonomousTenant[] {
  if (Buffer.byteLength(raw) > 200_000) throw new Error('Autonomous tenant configuration exceeds its limit.');
  const values = z.array(profile).min(1).max(100).parse(JSON.parse(raw));
  if (new Set(values.map(value => value.tenant)).size !== values.length || new Set(values.map(value => value.tokenSha256)).size !== values.length)
    throw new Error('Autonomous tenant identities and credentials must be unique.');
  return values;
}
async function body(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';',1)[0].trim().toLowerCase() !== 'application/json') throw new Error('Use application/json.');
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.byteLength;if(size>20_000)throw new Error('Autonomous request exceeds 20 KB.');chunks.push(bytes);}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
const summary=(job:AutonomousJob)=>({id:job.id,goal:job.goal,state:job.state,cycle:job.cycle,spent:job.spent,
  modelRequests:job.modelRequests,actions:job.intents.length,deadline:job.limits.deadline,...(job.failure?{failure:job.failure}:{}),...(job.answer?{answer:job.answer}:{})});

/** Runs inside the server process; browser connections do not own its lifetime.
 * Only these authenticated routes may be exposed by a public reverse proxy.
 * Existing local preview APIs are not a public multi-tenant API. */
export class AutonomousController {
  private readonly active=new Map<string,Promise<void>>();
  private readonly queue:{tenant:string;id:string}[]=[];
  private readonly failures=new Map<string,string>();
  private readonly rate=new Map<string,{window:number;count:number}>();
  private timer?:NodeJS.Timeout;
  private watching=false;
  constructor(private readonly store:Pick<SQLiteAutonomousStore,'load'|'list'|'events'|'notificationStatus'|'cancelled'|'requestCancellation'>,private readonly loop:AutonomousLoop,
    private readonly tenants:AutonomousTenant[],private readonly chain:{program:string;genesis:string},private readonly now=()=>Date.now(),private readonly credentialTenant?:(hash:Buffer)=>string|null){}
  private authenticate(request:IncomingMessage){
    const authorization=request.headers.authorization;
    if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization))return null;
    const hash=createHash('sha256').update(authorization.slice(7)).digest();
    if(this.credentialTenant){try{const name=this.credentialTenant(hash);return this.tenants.find(tenant=>tenant.tenant===name)??null;}catch{return null;}}
    return this.tenants.find(tenant=>timingSafeEqual(Buffer.from(tenant.tokenSha256,'hex'),hash))??null;
  }
  authorized(request:IncomingMessage){return !!this.authenticate(request);}
  private enqueue(tenant:string,id:string){
    const key=tenant+':'+id;
    if(this.active.has(key)||this.queue.some(job=>job.tenant===tenant&&job.id===id))return;
    this.queue.push({tenant,id});this.drain();
  }
  private drain(){
    while(this.active.size<2&&this.queue.length){
      const index=this.queue.findIndex(job=>![...this.active.keys()].some(key=>
        this.tenants.find(scope=>scope.tenant===key.split(':',1)[0])?.agent===this.tenants.find(scope=>scope.tenant===job.tenant)?.agent));
      if(index===-1)return;
      const [{tenant,id}]=this.queue.splice(index,1),key=tenant+':'+id;
      const run=this.loop.run(tenant,id).then(()=>{this.failures.delete(key);},async cause=>{
        if(cause instanceof AutonomousLeaseBusyError){this.failures.delete(key);return;}
        const message=redactModelError(cause instanceof Error?cause.message:'Autonomous execution unavailable.');
        this.failures.set(key,message);try{await recordModelDiagnostic({phase:'validation',message});}catch{console.error('Autonomous diagnostics could not be persisted.');}
      }).finally(()=>{this.active.delete(key);this.drain();});
      this.active.set(key,run);
    }
  }
  async resume(){
    for(const tenant of this.tenants)for(const job of await this.store.list(tenant.tenant))
      if(['planning','executing','evaluating','needs_reconciliation'].includes(job.state)||job.intents.some(intent=>intent.phase==='reserved'))this.enqueue(tenant.tenant,job.id);
  }
  watchReconciliation(){
    this.watching=true;this.scheduleReconciliation();
  }
  private scheduleReconciliation(){
    if(!this.watching||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=undefined;void this.pollReconciliation().finally(()=>this.scheduleReconciliation());},60_000);this.timer.unref();
  }
  stopWatching(){this.watching=false;clearTimeout(this.timer);this.timer=undefined;}
  private async pollReconciliation(){
    try{for(const tenant of this.tenants)for(const job of await this.store.list(tenant.tenant))if(['planning','executing','evaluating','needs_reconciliation'].includes(job.state)||job.intents.some(intent=>intent.phase==='reserved'))this.enqueue(tenant.tenant,job.id);}
    catch{console.error('Original autonomous results could not be checked.');}
  }
  async idle(){while(this.active.size||this.queue.length)await Promise.all([...this.active.values()]);}
  async handle(request:IncomingMessage,response:ServerResponse,url:URL):Promise<boolean>{
    if(!url.pathname.startsWith('/api/autonomous/'))return false;
    response.setHeader('Cache-Control','no-store');
    const tenant=this.authenticate(request);
    if(!tenant){response.writeHead(401).end(JSON.stringify({error:'Autonomous credentials are required.'}));return true;}
    const window=Math.floor(this.now()/60_000),old=this.rate.get(tenant.tenant),count=old?.window===window?old.count+1:1;
    this.rate.set(tenant.tenant,{window,count});
    if(count>120){response.writeHead(429,{'Retry-After':'60'}).end(JSON.stringify({error:'Please wait before retrying.'}));return true;}
    try{
      const path=url.pathname.slice('/api/autonomous/'.length);
      if(path==='scope'&&request.method==='GET'){
        response.end(JSON.stringify({tenant:tenant.tenant,agent:tenant.agent,session:tenant.session,limits:tenant.limits,maxDurationSeconds:tenant.maxDurationSeconds,...this.chain}));return true;
      }
      if(path==='events'&&request.method==='GET'){
        const raw=url.searchParams.get('after')??'0';if(!/^(0|[1-9][0-9]{0,15})$/.test(raw))throw new Error('Invalid notification cursor.');
        response.end(JSON.stringify(await this.store.events(tenant.tenant,Number(raw))));return true;
      }
      if(path==='notifications'&&request.method==='GET'){
        response.end(JSON.stringify(await this.store.notificationStatus(tenant.tenant)));return true;
      }
      if(path==='jobs'&&request.method==='GET'){
        response.end(JSON.stringify({jobs:(await this.store.list(tenant.tenant)).map(summary)}));return true;
      }
      if(path==='jobs'&&request.method==='POST'){
        const input=z.object({goal:z.string().trim().min(4).max(3000),acceptance:autonomousAcceptanceSchema.optional(),limits:limits.partial().optional(),durationSeconds:z.number().int().min(1).optional()}).strict().parse(await body(request));
        const requested={...tenant.limits,...input.limits};
        if(BigInt(requested.sol)>BigInt(tenant.limits.sol)||BigInt(requested.usdc)>BigInt(tenant.limits.usdc)
          ||requested.maxActions>tenant.limits.maxActions||requested.maxCycles>tenant.limits.maxCycles||requested.maxModelRequests>tenant.limits.maxModelRequests
          ||requested.tools.some(tool=>!tenant.limits.tools.includes(tool))||(input.durationSeconds??tenant.maxDurationSeconds)>tenant.maxDurationSeconds)
          throw new Error('Requested job exceeds the configured tenant authorization.');
        const job=await this.loop.create({tenant:tenant.tenant,goal:input.goal,...(input.acceptance?{acceptance:input.acceptance}:{}),agent:tenant.agent,session:tenant.session,
          ...this.chain,limits:{...requested,deadline:Math.floor(this.now()/1000)+(input.durationSeconds??tenant.maxDurationSeconds)}});
        this.enqueue(job.tenant,job.id);response.writeHead(202).end(JSON.stringify({job:summary(job)}));return true;
      }
      const match=/^jobs\/([a-f0-9-]{36})(?:\/(resume|cancel))?$/.exec(path);
      if(match){
        const id=z.string().uuid().parse(match[1]);
        const job=await this.store.load(tenant.tenant,id);
        if(!match[2]&&request.method==='GET'){
          response.end(JSON.stringify({job,cancellationRequested:await this.store.cancelled(tenant.tenant,id),...(this.failures.has(tenant.tenant+':'+id)?{error:this.failures.get(tenant.tenant+':'+id)}:{})}));return true;
        }
        if(request.method==='POST'&&match[2]==='cancel'){
          await this.store.requestCancellation(tenant.tenant,id);this.enqueue(tenant.tenant,id);
          response.writeHead(202).end(JSON.stringify({cancellationRequested:true,originalEffectsRequireReconciliation:true}));return true;
        }
        if(request.method==='POST'&&match[2]==='resume'){
          this.enqueue(tenant.tenant,id);response.writeHead(202).end(JSON.stringify({job:summary(job)}));return true;
        }
      }
      response.writeHead(404).end(JSON.stringify({error:'Autonomous route not found.'}));
    }catch(cause){response.writeHead(422).end(JSON.stringify({error:redactModelError(cause instanceof Error?cause.message:'Autonomous request failed.')}));}
    return true;
  }
}
