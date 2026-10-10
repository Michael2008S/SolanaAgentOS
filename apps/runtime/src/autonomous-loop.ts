import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { autonomousReceiptOutcome } from './autonomous-receipt.js';
import { autonomousAcceptanceSchema,missingAutonomousAcceptance } from './autonomous-acceptance.js';

const atomic = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value=>BigInt(value)<=18446744073709551615n);
const actionSchema = z.object({ key:z.string().min(1).max(120), tool:z.string().min(1).max(120), input:z.string().max(12000), asset:z.enum(['SOL','USDC']), amount:atomic }).strict();
export type AutonomousAction = z.infer<typeof actionSchema>;
const receiptSchema = z.object({ id:z.string().min(1).max(160), output:z.string().max(65536), outputHash:z.string().regex(/^[a-f0-9]{64}$/), verified:z.literal(true),outcome:z.enum(['success','error']).optional() }).strict();
export type AutonomousReceipt = z.infer<typeof receiptSchema>;
const intentSchema = z.object({ id:z.string().uuid(), action:actionSchema, phase:z.enum(['reserved','complete']), cycle:z.number().int().min(1).max(50).optional(), executionId:atomic.optional(), receipt:receiptSchema.optional() }).strict();
// Missing evaluationMode denotes a legacy batch job; restore never upgrades it.
const jobSchema = z.object({ version:z.literal(1), id:z.string().uuid(), tenant:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), goal:z.string().min(4).max(3000), acceptance:autonomousAcceptanceSchema.optional(), evaluationMode:z.literal('after_action').optional(), agent:z.string().min(32).max(44), session:z.string().min(32).max(44), program:z.string().min(32).max(44), genesis:z.string().min(32).max(44), state:z.enum(['planning','executing','evaluating','completed','needs_reconciliation','failed','cancelled']), limits:z.object({ sol:atomic,usdc:atomic,maxCycles:z.number().int().min(1).max(50),maxActions:z.number().int().min(1).max(200),maxModelRequests:z.number().int().min(1).max(100),deadline:z.number().int().positive(),tools:z.array(z.string().min(1).max(120)).min(1).max(100) }).strict(), spent:z.object({ sol:atomic,usdc:atomic }).strict(), cycle:z.number().int().min(0).max(50), modelRequests:z.number().int().min(0).max(100), intents:z.array(intentSchema).max(200), pending:z.array(actionSchema).max(20), nextPlan:z.array(actionSchema).max(20).optional(), evaluations:z.array(z.object({ complete:z.boolean(), feedback:z.string().max(6000) }).strict()).max(50), answer:z.string().max(12000).optional(), failure:z.enum(['limit','adapter','verification']).optional() }).strict();
export type AutonomousJob = z.infer<typeof jobSchema>;
export const parseAutonomousJob = (value: unknown): AutonomousJob => jobSchema.parse(value);
export interface AutonomousStore { load(tenant:string,id:string):Promise<AutonomousJob>; save(job:AutonomousJob):Promise<void>; acquire?(tenant:string,id:string):Promise<()=>Promise<void>>; cancelled?(tenant:string,id:string):Promise<boolean>; }
export interface AutonomousAdapter {
 /** Always use fresh chain permissions, budgets, prices and tool capabilities. */
 validate(job:AutonomousJob,action?:AutonomousAction):Promise<void>;
 plan(job:AutonomousJob):Promise<AutonomousAction[]>;
 /** Read-only allocation from the live chain counter. The binding is persisted
  * with the reservation before any signer or provider receives the intent. */
 prepare?(job:AutonomousJob,action:AutonomousAction,intentId:string):Promise<{executionId:string}>;
 /** A stable intent ID is the execution idempotency key, including after restart. */
 execute(job:AutonomousJob,action:AutonomousAction,intentId:string):Promise<AutonomousReceipt>;
 /** Reconcile original effects; returning null must never authorize re-execution. */
 reconcile(job:AutonomousJob,intentId:string):Promise<AutonomousReceipt|null>;
 evaluate(job:AutonomousJob):Promise<{complete:boolean;feedback:string;nextPlan?:AutonomousAction[]}>;
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const copy=<T>(value:T):T=>structuredClone(value);

/** Planning -> execution -> verified evaluation -> re-planning. Unknown effects
 * halt on their original intent, rather than buying or executing the tool twice. */
export class AutonomousLoop {
 private running=new Map<string,Promise<AutonomousJob>>();
 constructor(private readonly store:AutonomousStore,private readonly adapter:AutonomousAdapter,private readonly now=()=>Date.now()){}
 async create(input:Pick<AutonomousJob,'tenant'|'goal'|'agent'|'session'|'program'|'genesis'|'limits'> & Pick<Partial<AutonomousJob>,'acceptance'>):Promise<AutonomousJob>{
  const job=jobSchema.parse({...input,version:1,evaluationMode:'after_action',id:randomUUID(),state:'planning',spent:{sol:'0',usdc:'0'},cycle:0,modelRequests:0,intents:[],pending:[],evaluations:[]});
  if(job.acceptance?.evidence.some(item=>!job.limits.tools.includes(item.tool)))throw new Error('Completion checks require an unauthorized tool.');
  await this.adapter.validate(copy(job));await this.store.save(job);return copy(job);
 }
 run(tenant:string,id:string):Promise<AutonomousJob>{
  const key=tenant+':'+id,existing=this.running.get(key);if(existing)return existing;
  const running=this.withLease(tenant,id).finally(()=>this.running.delete(key));this.running.set(key,running);return running;
 }
 private async withLease(tenant:string,id:string){
  const release=await this.store.acquire?.(tenant,id);
  try{return await this.advance(tenant,id);}finally{await release?.();}
 }
 private async advance(tenant:string,id:string):Promise<AutonomousJob>{
  const job=jobSchema.parse(await this.store.load(tenant,id));
  if(job.tenant!==tenant||job.id!==id)throw new Error('Autonomous job identity mismatch.');
  const terminal=['completed','cancelled','failed'].includes(job.state);
  if(terminal&&!job.intents.some(intent=>intent.phase==='reserved'))return copy(job);
  while(true){
   const unresolved=job.intents.find(intent=>intent.phase==='reserved');
   if(unresolved){
    // A saved reservation could have reached the provider before interruption.
    const receipt=await this.adapter.reconcile(copy(job),unresolved.id);
    if(!receipt){if(!terminal)job.state='needs_reconciliation';await this.store.save(job);return copy(job);}
    this.commitReceipt(unresolved,receipt);if(terminal){await this.store.save(job);return copy(job);}job.state=autonomousReceiptOutcome(receipt)==='error'||job.evaluationMode==='after_action'?'evaluating':'executing';if(autonomousReceiptOutcome(receipt)==='error')job.pending=[];await this.store.save(job);
   }
   const previousIntent=job.intents.at(-1),previous=previousIntent?.receipt;
   if(job.state==='executing'&&previousIntent?.cycle===job.cycle&&previous&&(autonomousReceiptOutcome(previous)==='error'||job.evaluationMode==='after_action')){if(autonomousReceiptOutcome(previous)==='error')job.pending=[];job.state='evaluating';await this.store.save(job);}
   if(await this.stopRequested(job))return copy(job);
   if(this.now()/1000>=job.limits.deadline){job.state='failed';job.failure='limit';await this.store.save(job);return copy(job);}
   await this.adapter.validate(copy(job));
   if(job.state==='planning'){
    if(job.cycle>=job.limits.maxCycles||(!job.nextPlan&&job.modelRequests>=job.limits.maxModelRequests)){job.state='failed';job.failure='limit';await this.store.save(job);return copy(job);}
    // Persist model-call reservations before dispatch; failed requests still
    // count and restarts cannot reset either the cycle or API billing cap.
    const cachedPlan=job.nextPlan;
    job.cycle++;if(!cachedPlan){job.modelRequests++;await this.store.save(job);}
    const actions=z.array(actionSchema).max(20).parse(cachedPlan??await this.adapter.plan(copy(job)));
    const keys=new Set(job.intents.map(intent=>intent.action.key));let sol=BigInt(job.spent.sol),usdc=BigInt(job.spent.usdc);
    for(const action of actions){
     if(keys.has(action.key)||!job.limits.tools.includes(action.tool))throw new Error('Plan duplicates a prior action or selects an unauthorized tool.');
     keys.add(action.key);if(action.asset==='SOL')sol+=BigInt(action.amount);else usdc+=BigInt(action.amount);
    }
    if(sol>BigInt(job.limits.sol)||usdc>BigInt(job.limits.usdc)||job.intents.length+actions.length>job.limits.maxActions)throw new Error('Replanned actions exceed the remaining authorization.');
    delete job.nextPlan;job.pending=actions;job.state=actions.length?'executing':'evaluating';await this.store.save(job);
   }
   if(job.state==='executing'){
    while(job.pending.length){
     const action=job.pending[0];await this.adapter.validate(copy(job),copy(action));
     if(await this.stopRequested(job))return copy(job);
     if(this.now()/1000>=job.limits.deadline){job.state='failed';job.failure='limit';await this.store.save(job);return copy(job);}
     const intentId=randomUUID();
     const binding=this.adapter.prepare?z.object({executionId:atomic}).strict().parse(await this.adapter.prepare(copy(job),copy(action),intentId)):{};
     if(await this.stopRequested(job))return copy(job);
     if(this.now()/1000>=job.limits.deadline){job.state='failed';job.failure='limit';await this.store.save(job);return copy(job);}
     const intent:z.infer<typeof intentSchema>={id:intentId,action:copy(action),phase:'reserved',cycle:job.cycle,...binding};job.intents.push(intent);job.pending.shift();
     // Reservations count against the gross budget even if a paid tool fails.
     if(action.asset==='SOL')job.spent.sol=(BigInt(job.spent.sol)+BigInt(action.amount)).toString();else job.spent.usdc=(BigInt(job.spent.usdc)+BigInt(action.amount)).toString();
     await this.store.save(job);
     try {this.commitReceipt(intent,await this.adapter.execute(copy(job),copy(action),intent.id));}
     catch {job.state='needs_reconciliation';await this.store.save(job);return copy(job);}
     if(autonomousReceiptOutcome(intent.receipt!)==='error'){job.pending=[];job.state='evaluating';}
     else if(job.evaluationMode==='after_action')job.state='evaluating';
     await this.store.save(job);if(job.state==='evaluating')break;
    }
    job.state='evaluating';await this.store.save(job);
   }
   if(job.state==='evaluating'){
    if(await this.stopRequested(job))return copy(job);
    if(this.now()/1000>=job.limits.deadline){job.state='failed';job.failure='limit';await this.store.save(job);return copy(job);}
    await this.adapter.validate(copy(job));
    if(this.now()/1000>=job.limits.deadline){job.state='failed';job.failure='limit';await this.store.save(job);return copy(job);}
    if(job.modelRequests>=job.limits.maxModelRequests){job.state='failed';job.failure='limit';await this.store.save(job);return copy(job);}
    job.modelRequests++;await this.store.save(job);
    const result=z.object({complete:z.boolean(),feedback:z.string().min(1).max(6000),nextPlan:z.array(actionSchema).max(20).optional()}).strict().parse(await this.adapter.evaluate(copy(job)));
    if(result.complete&&result.nextPlan?.length)throw new Error('Completed evaluation cannot schedule more actions.');
    if(result.complete){
     const missing=missingAutonomousAcceptance(job,result.feedback);
     if(missing.length){result.complete=false;result.feedback=('Completion checks failed. '+missing.join('\n')).slice(0,6000);}
    }
    // Unexecuted proposals are not effects. Fresh evaluation replaces the rest
    // of an action-mode plan; only persisted intents consume the gross budget.
    if(job.evaluationMode==='after_action')job.pending=[];
    if(!result.complete&&result.nextPlan)job.nextPlan=result.nextPlan;
    job.evaluations.push({complete:result.complete,feedback:result.feedback});job.state=result.complete?'completed':'planning';if(result.complete)job.answer=result.feedback;
    await this.store.save(job);if(result.complete)return copy(job);
   }
  }
 }
 private async stopRequested(job:AutonomousJob){
  if(!await this.store.cancelled?.(job.tenant,job.id))return false;
  job.state='cancelled';await this.store.save(job);return true;
 }
 private commitReceipt(intent:z.infer<typeof intentSchema>,value:AutonomousReceipt){
  const receipt=receiptSchema.parse(value);if(hash(receipt.output)!==receipt.outputHash)throw new Error('Execution output does not match its verified hash.');
  intent.receipt=receipt;intent.phase='complete';
 }
}

/** Durable local store. Multi-host leases and authenticated tenants are handled
 * by the deployment layer; hashes detect accidental corruption, not forgery. */
export class FileAutonomousStore implements AutonomousStore {
 constructor(private readonly directory:string){}
 private path(tenant:string,id:string){if(!/^[A-Za-z0-9_-]{1,80}$/.test(tenant)||!z.string().uuid().safeParse(id).success)throw new Error('Invalid job identity.');return join(this.directory,tenant,id+'.json');}
 async load(tenant:string,id:string){const path=this.path(tenant,id);const raw=await readFile(path,'utf8');if(Buffer.byteLength(raw)>16000000)throw new Error('Job exceeds storage limit.');const value=JSON.parse(raw);if(typeof value.body!=='string'||hash(value.body)!==value.sha256)throw new Error('Autonomous job snapshot is corrupt.');return jobSchema.parse(JSON.parse(value.body));}
 async save(value:AutonomousJob){const job=jobSchema.parse(value),path=this.path(job.tenant,job.id),directory=join(this.directory,job.tenant);
  try{const previous=await this.load(job.tenant,job.id);if(JSON.stringify(previous.acceptance)!==JSON.stringify(job.acceptance))throw new Error('Completion checks cannot change after job creation.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await mkdir(directory,{recursive:true,mode:0o700});const body=JSON.stringify(job);if(Buffer.byteLength(body)>8000000)throw new Error('Job exceeds storage limit.');const temporary=path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify({body,sha256:hash(body)}));await file.sync();}finally{await file.close();}await rename(temporary,path);const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}}
 async list(tenant:string):Promise<AutonomousJob[]>{
  this.path(tenant,randomUUID());
  let names:string[];try{names=await readdir(join(this.directory,tenant));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const ids=names.filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5));
  if(ids.length>200)throw new Error('Autonomous tenant exceeds 200 jobs. Archive completed jobs before creating more.');
  return Promise.all(ids.map(id=>this.load(tenant,id)));
 }
 /** File locks never expire or get stolen. A crash requires explicit local
  * recovery. Use SQLiteAutonomousStore for atomic dead-process recovery. */
 async acquire(tenant:string,id:string):Promise<()=>Promise<void>>{
  const path=this.path(tenant,id)+'.lock',token=randomUUID();
  await mkdir(join(this.directory,tenant),{recursive:true,mode:0o700});
   try{const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify({token,pid:process.pid,host:hostname()}));await file.sync();}finally{await file.close();}
    return async()=>{const owner=JSON.parse(await readFile(path,'utf8'));if(owner.token!==token)throw new Error('Autonomous lease ownership changed.');await unlink(path);};
   }catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    throw new Error('Autonomous job is already leased.');
   }
 }
}
