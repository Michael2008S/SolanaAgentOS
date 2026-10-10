import { createHash,randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { parseAutonomousJob,type AutonomousJob } from './autonomous-loop.js';
import { AutonomousLeaseBusyError,SQLiteAutonomousStore } from './autonomous-sqlite.js';
import type { AutonomousTenant } from './autonomous-controller.js';
import { cancellationRequest } from './autonomous-operator.js';
export const checkpointHash=(job:AutonomousJob)=>createHash('sha256').update(JSON.stringify(job)).digest('hex');
const command=z.object({op:z.enum(['load','list','events','notifications','cancelled','cancel','cancel-reviewed','cancellation-history','create','acquire','renew','release','save']),tenant:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),id:z.string().uuid().optional(),token:z.string().uuid().optional(),hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),after:z.number().int().nonnegative().optional(),job:z.unknown().optional(),cancellation:cancellationRequest.optional()}).strict();
/** One central database owner. Remote TTLs fence checkpoints, never erase an
 * original reserved effect. All commands serialize, including expiry/release. */
export class AutonomousCoordinator {
 private tail:Promise<unknown>=Promise.resolve();
 private closing=false;
 private leases=new Map<string,{token:string;expires:number;release:()=>Promise<void>}>();
 constructor(private readonly store:SQLiteAutonomousStore,private readonly tenants:readonly AutonomousTenant[],private readonly chain:{program:string;genesis:string},private readonly now=()=>Date.now(),private readonly ttl=60000){}
 dispatch(input:unknown):Promise<unknown>{if(this.closing)return Promise.reject(new Error('Coordinator is closing.'));input=structuredClone(input);const task=this.tail.then(()=>this.command(input));this.tail=task.catch(()=>{});return task;}
 async close(){this.closing=true;await this.tail;for(const lease of this.leases.values())await lease.release();this.leases.clear();}
 private async command(input:unknown){
  const c=command.parse(input),scope=this.tenants.find(t=>t.tenant===c.tenant);if(!scope)throw new Error('Unknown configured tenant.');
  for(const [key,lease] of this.leases)if(lease.expires<=this.now()){await lease.release();this.leases.delete(key);}
  if(c.op==='list')return this.store.list(c.tenant);
  if(c.op==='events')return this.store.events(c.tenant,c.after??0);
  if(c.op==='notifications')return this.store.notificationStatus(c.tenant);
  const job=c.job===undefined?undefined:parseAutonomousJob(c.job),id=c.id??job?.id;if(!id)throw new Error('Job identity required.');
  if(job&&(job.id!==id||job.tenant!==c.tenant))throw new Error('Checkpoint identity differs.');
  const key=c.tenant+':'+id;
  if(c.op==='create'){
   if(!job||job.agent!==scope.agent||job.session!==scope.session||job.program!==this.chain.program||job.genesis!==this.chain.genesis||job.state!=='planning'||job.cycle!==0||job.modelRequests!==0||job.intents.length||job.spent.sol!=='0'||job.spent.usdc!=='0'||job.answer!==undefined||job.failure!==undefined||job.nextPlan!==undefined||job.pending.length||job.evaluations.length||job.acceptance?.evidence.some(item=>!job.limits.tools.includes(item.tool))||job.limits.deadline<=Math.floor(this.now()/1000)||job.limits.deadline-Math.floor(this.now()/1000)>scope.maxDurationSeconds||BigInt(job.limits.sol)>BigInt(scope.limits.sol)||BigInt(job.limits.usdc)>BigInt(scope.limits.usdc)||job.limits.maxCycles>scope.limits.maxCycles||job.limits.maxActions>scope.limits.maxActions||job.limits.maxModelRequests>scope.limits.maxModelRequests||job.limits.tools.some(tool=>!scope.limits.tools.includes(tool)))throw new Error('Initial job exceeds configured authorization.');
   if((await this.store.list(c.tenant)).some(old=>old.id===id))throw new Error('Original job already exists.');await this.store.save(job);return {hash:checkpointHash(job)};
  }
  if(c.op==='load')return this.store.load(c.tenant,id);
  if(c.op==='cancel') {await this.store.requestCancellation(c.tenant,id);return {};}
  if(c.op==='cancel-reviewed'){if(!c.cancellation||c.cancellation.tenant!==c.tenant||c.cancellation.id!==id)throw new Error('Operator cancellation identity differs.');return this.store.reviewedCancellation(c.cancellation);}
  if(c.op==='cancellation-history')return this.store.cancellationHistory(c.tenant,id);
  if(c.op==='cancelled')return this.store.cancelled(c.tenant,id);
  if(c.op==='acquire'){
   if(this.leases.has(key))throw new AutonomousLeaseBusyError();const release=await this.store.acquire(c.tenant,id),token=randomUUID();this.leases.set(key,{token,release,expires:this.now()+this.ttl});return {token,ttl:this.ttl};
  }
  const lease=this.leases.get(key);if(!lease||lease.token!==c.token)throw new Error('Remote checkpoint lease is lost.');
  if(c.op==='renew'){lease.expires=this.now()+this.ttl;return {ttl:this.ttl};}
  if(c.op==='release'){await lease.release();this.leases.delete(key);return {};}
  const previous=await this.store.load(c.tenant,id);
  if(!job||c.hash!==checkpointHash(previous))throw new Error('Original checkpoint changed.');
  if(job.goal!==previous.goal||job.cycle<previous.cycle||job.modelRequests<previous.modelRequests||job.cycle>job.limits.maxCycles||job.modelRequests>job.limits.maxModelRequests||job.intents.length>job.limits.maxActions||job.intents.length<previous.intents.length||job.evaluations.length<previous.evaluations.length)throw new Error('Original counters or history cannot be reset.');
  for(let i=0;i<previous.evaluations.length;i++)if(JSON.stringify(job.evaluations[i])!==JSON.stringify(previous.evaluations[i]))throw new Error('Original evaluation cannot change.');
  if(['completed','failed','cancelled'].includes(previous.state)&&job.state!==previous.state)throw new Error('Terminal job cannot restart.');
  for(let i=0;i<previous.intents.length;i++){
   const old=previous.intents[i],next=job.intents[i];
   if(next.id!==old.id||JSON.stringify(next.action)!==JSON.stringify(old.action)||next.executionId!==old.executionId||next.cycle!==old.cycle||old.phase==='complete'&&JSON.stringify(next)!==JSON.stringify(old))throw new Error('Original execution intent cannot change.');
  }
  if(new Set(job.intents.map(intent=>intent.id)).size!==job.intents.length||new Set(job.intents.map(intent=>intent.action.key)).size!==job.intents.length)throw new Error('Duplicate execution intents.');
  for(const asset of ['sol','usdc'] as const){
   const total=job.intents.filter(intent=>intent.action.asset===(asset==='sol'?'SOL':'USDC')).reduce((sum,intent)=>sum+BigInt(intent.action.amount),0n);
   if(BigInt(job.spent[asset])!==total||total<BigInt(previous.spent[asset])||total>BigInt(job.limits[asset]))throw new Error('Gross reserved spending differs.');
  }
  if(job.intents.some(intent=>!job.limits.tools.includes(intent.action.tool)||intent.phase==='complete'&&!intent.receipt||intent.phase==='reserved'&&intent.receipt||intent.receipt&&createHash('sha256').update(intent.receipt.output).digest('hex')!==intent.receipt.outputHash))throw new Error('Intent authority or receipt phase differs.');
  await this.store.save(job);return {hash:checkpointHash(job)};
 }
}
