import { workerToolPaymentInput,workerToolPaymentReceipt,workerToolPaymentBinding,type WorkerToolPaymentInput,type WorkerToolPaymentReceipt } from './worker-tool-payment.js';
import { workerToolRequest } from './worker-tool-request.js';
import { workerDeliveryInput,workerDeliveryReceipt,type WorkerDeliveryInput,type WorkerDeliveryReceipt } from './worker-delivery-protocol.js';
import { runtimeDataPath } from './data-path.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { runtimeDatabase, runtimeStorageBackend } from './runtime-database.js';
import { readFileTextLimited } from './file-limits.js';
import { getVerifiedMemory, isValidSolanaAddress } from './memory.js';
import { generateWorkerDraft, prepareWorkerEvidence } from './worker-draft.js';

const address = z.string().refine(isValidSolanaAddress);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export { workerToolRequest } from './worker-tool-request.js';
const toolPayment=z.object({request:workerToolPaymentInput,attempts:z.number().int().min(1).max(8),nextAttemptAt:z.number().int().nonnegative(),error:z.string().max(300).nullable(),receipt:workerToolPaymentReceipt.nullable()}).strict();
const toolProgress = z.object({ id: hash, dispatchId: z.string().uuid().nullable().default(null), state: z.enum(['pending', 'dispatched', 'complete']), execution: address.nullable(), taskId: z.string().regex(/^(0|[1-9][0-9]{0,19})$/).nullable(), actionId: z.string().regex(/^(0|[1-9][0-9]{0,19})$/).nullable(),payment:toolPayment.nullable().optional() }).strict();
export const workerJobInput = z.object({
  escrow: address, workerAgent: address, task: z.string().trim().min(1).max(400),
  evidence: z.string().trim().max(4_000).default(''), sourceExecutions: z.array(address).max(3).default([]),
  toolRequests: z.array(workerToolRequest).max(3).default([]),
}).strict();
const schema = workerJobInput.extend({
  programId: address, taskHash: hash,
  tools: z.array(toolProgress).max(3).default([]),
  state: z.enum(['waiting_tools', 'accepted', 'running', 'needs_evidence', 'ready', 'interrupted', 'failed', 'delivered', 'closed']),
  result: z.string().min(1).max(400).nullable(), resultHash: hash.nullable(),
  delivery: z.object({request:workerDeliveryInput,receipt:workerDeliveryReceipt.nullable(),attempts:z.number().int().min(0).max(8),nextAttemptAt:z.number().int().nonnegative(),error:z.string().max(500).nullable()}).strict().nullable().default(null),
  model: z.string().max(200).nullable().default(null), generatedAt: z.string().datetime().nullable().default(null),
  evidenceUsed: z.array(z.string().max(400)).max(6).default([]),
  limitations: z.array(z.string().max(500)).max(6), error: z.string().max(500).nullable(),
  attempts: z.number().int().min(0).max(100), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict().refine((job) => job.tools.length === job.toolRequests.length && job.tools.every((tool, index) => tool.id === digest(JSON.stringify(job.toolRequests[index])) && (tool.state !== 'complete' || tool.execution !== null) && (tool.state !== 'pending' || (!tool.execution && !tool.dispatchId && !tool.taskId && !tool.actionId)) && (tool.state === 'pending' || tool.dispatchId !== null) && (!tool.execution || tool.taskId !== null && tool.actionId !== null)) && (!['accepted', 'running', 'ready', 'needs_evidence', 'interrupted', 'failed'].includes(job.state) || job.tools.every((tool) => tool.state === 'complete')) && job.tools.every(t=>!t.payment||t.payment.request.escrow===job.escrow&&t.payment.request.taskHash===job.taskHash&&t.payment.request.toolId===t.id&&t.payment.request.dispatchId===t.dispatchId&&(!t.payment.receipt||t.payment.receipt.tenant===t.payment.request.tenant&&t.payment.receipt.escrow===job.escrow&&t.payment.receipt.dispatchId===t.dispatchId&&t.payment.receipt.execution===t.execution&&t.payment.receipt.taskId===t.taskId&&t.payment.receipt.actionId===t.actionId)) && job.taskHash === digest(job.task)
  && ((job.result === null && job.resultHash === null) || (job.result !== null && digest(job.result) === job.resultHash))
  && (!['ready', 'delivered'].includes(job.state) || job.result !== null) && (!job.delivery || ['ready','delivered','closed'].includes(job.state) && job.delivery.request.escrow===job.escrow && job.delivery.request.taskHash===job.taskHash && job.delivery.request.result===job.result && job.delivery.request.sources.map(source=>source.execution).sort().join(',')===[...job.sourceExecutions,...job.tools.filter(tool=>tool.state==='complete').map(tool=>tool.execution!)].sort().join(',') && (!job.delivery.receipt || job.delivery.receipt.tenant===job.delivery.request.tenant && job.delivery.receipt.escrow===job.escrow && job.delivery.receipt.taskHash===job.taskHash && job.delivery.receipt.resultHash===job.resultHash)), 'Invalid Worker job commitments.');
export type WorkerJob = z.infer<typeof schema>;
type LiveEscrow = { workerAgent: string; taskHash: string; resultHash: string | null; status: number; deadline: number };

export const workerToolRecoveryScopes=z.array(z.object({workerAgent:address,escrow:address,taskHash:hash}).strict()).max(100).refine(scopes=>new Set(scopes.map(s=>s.escrow)).size===scopes.length);
export type WorkerToolExecutionOptions={select:(job:WorkerJob,index:number)=>string|undefined;preflight:(input:WorkerToolPaymentInput)=>Promise<z.infer<typeof workerToolPaymentBinding>>;send:(input:WorkerToolPaymentInput)=>Promise<WorkerToolPaymentReceipt>;verify:(job:WorkerJob,index:number,receipt:WorkerToolPaymentReceipt)=>Promise<void>};
type ToolRecoveryOptions={select:(job:WorkerJob)=>boolean};
type DeliveryOptions={select:(job:WorkerJob)=>string|undefined;send:(input:WorkerDeliveryInput)=>Promise<WorkerDeliveryReceipt>;verify:(job:WorkerJob,receipt:WorkerDeliveryReceipt)=>Promise<void>};
/** The queue owns no signer; optional delivery uses a fixed operator gateway and
 * persists an immutable request before dispatching any original transaction. */
export class WorkerJobQueue {
  private jobs = new Map<string, WorkerJob>();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private pumping = false;
  private stopped=false;
  private deliveryTimer:ReturnType<typeof setTimeout>|undefined;
  private pumpTask:Promise<void>|undefined;
  private readonly file = runtimeDataPath('worker-jobs.json');
  constructor(private readonly lookup: (escrow: string) => Promise<LiveEscrow>, private readonly program: () => string, private readonly verifyTool: (worker: string, execution: string, request: z.infer<typeof workerToolRequest>, binding: z.infer<typeof toolProgress>, context: { taskHash: string; deadline: number }) => Promise<void>,private readonly deliveryOptions?:DeliveryOptions,private readonly toolRecoveryOptions?:ToolRecoveryOptions,private readonly toolExecutionOptions?:WorkerToolExecutionOptions) {}
  private key(escrow: string) { return `${this.program()}:${escrow}`; }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn); this.queue = next.then(() => undefined, () => undefined); return next;
  }
  private async restore() {
    if (this.loaded) return;
    try {
      const legacy = async () => {
        try { return z.array(schema).max(200).parse(JSON.parse(await readFileTextLimited(this.file, 2_000_000, 'Worker job file exceeds 2 MB.'))); }
        catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
      };
      const entries = z.array(schema).max(200).parse(runtimeStorageBackend() === 'sqlite' ? await (await runtimeDatabase()).restore('worker-jobs', legacy) : await legacy());
      const restored = new Map<string, WorkerJob>();
      for (const job of entries) {
        const key = `${job.programId}:${job.escrow}`;
        if (restored.has(key)) throw new Error('Duplicate Worker jobs.');
        restored.set(key, job.state === 'running' ? { ...job, state: 'interrupted', error: 'Runtime restarted during execution. Review before retrying.', updatedAt: new Date().toISOString() } : job);
      }
      this.jobs = restored;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw new Error(`Cannot restore Worker jobs; existing storage preserved: ${error instanceof Error ? error.message : 'invalid storage'}`);
    }
    this.loaded = true;
  }
  private async persist() {
    if (runtimeStorageBackend() === 'sqlite') { (await runtimeDatabase()).replace('worker-jobs', [...this.jobs.values()]); return; }
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const text = JSON.stringify([...this.jobs.values()]);
      if (Buffer.byteLength(text) > 2_000_000) throw new Error('Worker job storage exceeds 2 MB; archive it before continuing.');
      const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
      await rename(temporary, this.file);
      const directory=await open(dirname(this.file),'r');try{await directory.sync();}finally{await directory.close();}
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  private async save(job: WorkerJob) {
    schema.parse(job);
    const key = `${job.programId}:${job.escrow}`; const previous = this.jobs.get(key);
    if(previous?.delivery && (JSON.stringify(previous.delivery.request)!==JSON.stringify(job.delivery?.request)||previous.result!==job.result||!job.delivery||job.delivery.attempts<previous.delivery.attempts||previous.delivery.receipt && JSON.stringify(previous.delivery.receipt)!==JSON.stringify(job.delivery.receipt))) throw new Error('Original Worker delivery cannot be replaced or reset.');
    if(previous)for(const [i,t] of previous.tools.entries())if(t.payment){const next=job.tools[i]?.payment;if(!next||JSON.stringify(next.request)!==JSON.stringify(t.payment.request)||next.attempts<t.payment.attempts||next.attempts>t.payment.attempts+1||t.payment.receipt&&JSON.stringify(next.receipt)!==JSON.stringify(t.payment.receipt))throw new Error('Original Worker tool payment cannot be replaced or reset.');}
    this.jobs.set(key, job);
    try { await this.persist(); } catch (error) { if (previous) this.jobs.set(key, previous); else this.jobs.delete(key); throw error; }
    return structuredClone(job);
  }
  private async check(job: Pick<WorkerJob, 'escrow' | 'workerAgent' | 'taskHash'>) {
    const live = await this.lookup(job.escrow);
    if (live.workerAgent !== job.workerAgent || live.taskHash !== job.taskHash) throw new Error('Escrow Worker or task commitment does not match.');
    return live;
  }
  async start() {
    this.stopped=false;
    await this.serial(async () => { await this.restore(); await this.persist(); });
    this.kick();
  }
  async accept(raw: unknown) {
    const input = workerJobInput.parse(raw);
    if (new Set(input.toolRequests.map((tool) => digest(JSON.stringify(tool)))).size !== input.toolRequests.length || input.sourceExecutions.length + input.toolRequests.length > 3) throw new Error('Choose at most three distinct total Skill requests and existing proofs.');
    const job = await this.serial(async () => {
      await this.restore();
      const programId = address.parse(this.program()); const key = this.key(input.escrow);
      const existing = this.jobs.get(key);
      if (existing) {
        if (existing.workerAgent !== input.workerAgent || existing.task !== input.task || existing.evidence !== input.evidence || JSON.stringify(existing.sourceExecutions) !== JSON.stringify(input.sourceExecutions) || JSON.stringify(existing.toolRequests) !== JSON.stringify(input.toolRequests)) throw new Error('An accepted job cannot be replaced; reuse its original inputs.');
        return structuredClone(existing);
      }
      if (this.jobs.size >= 200) throw new Error('Worker storage is full. Stop Runtime and back up its configured storage before accepting more jobs.');
      const taskHash = digest(input.task); const live = await this.check({ ...input, taskHash });
      if (live.status !== 0 || live.resultHash || live.deadline * 1000 <= Date.now()) throw new Error('Escrow is not awaiting work.');
      // Validate existing evidence while acceptance holds the same lock as Memory archival.
      await prepareWorkerEvidence(input.workerAgent, input.evidence, input.sourceExecutions);
      const now = new Date().toISOString();
      return this.save({ ...input, programId, taskHash, tools: input.toolRequests.map((request) => ({ id: digest(JSON.stringify(request)), state: 'pending', dispatchId: null, execution: null, taskId: null, actionId: null,payment:null })), state: input.toolRequests.length ? 'waiting_tools' : 'accepted', result: null, resultHash: null, delivery:null, model: null, generatedAt: null, evidenceUsed: [], limitations: [], error: null, attempts: 0, createdAt: now, updatedAt: now });
    });
    this.kick(); return job;
  }
  async withMemoryArchiveGuard<T>(workerAgent: string, execution: string, archive: () => Promise<T>): Promise<T> {
    address.parse(workerAgent); address.parse(execution);
    return this.serial(async () => {
      await this.restore();
      for (const job of this.jobs.values()) {
        if (job.programId !== this.program() || job.workerAgent !== workerAgent
          || !(job.sourceExecutions.includes(execution) || job.tools.some(tool => tool.execution === execution))) continue;
        if (job.state === 'running') throw new Error(`Memory is used by running Worker job ${job.escrow}. Wait for execution to finish.`);
        const live = await this.check(job);
        if (live.status === 0 || live.status === 4) throw new Error(`Memory is needed by unsettled Worker job ${job.escrow}. Settle the Escrow before archiving this source.`);
      }
      // Hold the queue lock through archive commit so a new acceptance cannot race the check.
      return archive();
    });
  }
  async archive(escrow: string, workerAgent: string, expectedUpdatedAt: string) {
    address.parse(escrow); address.parse(workerAgent);
    return this.serial(async () => {
      await this.restore();
      const key = this.key(escrow), job = this.jobs.get(key);
      if (!job || job.workerAgent !== workerAgent || job.updatedAt !== expectedUpdatedAt) throw new Error('Worker job changed; refresh before archiving.');
      if (!['closed', 'delivered'].includes(job.state) || job.tools.some(tool => tool.state === 'dispatched')) throw new Error('Only closed or delivered jobs without unresolved tools can be archived.');
      const live = await this.check(job);
      if (live.status === 0 || live.status === 4) throw new Error('Escrow has not reached final settlement. Keep this job active.');
      const directory = runtimeDataPath('worker-archives/');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const archiveFile = join(directory, `${job.programId}-${escrow}-${randomUUID()}.json`);
      const text = JSON.stringify({ format: 'agentos-worker-archive', version: 1, archivedAt: new Date().toISOString(), verification: 'current-escrow-terminal', escrowStatus: live.status, job: schema.parse(job) });
      const file = await open(archiveFile, 'wx', 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      this.jobs.delete(key);
      try { await this.persist(); } catch (error) { this.jobs.set(key, job); throw new Error(`Archive retained at ${archiveFile}; queue update failed. ${error instanceof Error ? error.message : 'Storage failure.'}`); }
      return { archived: true, escrow, workerAgent, archiveFile, archiveSha256: digest(text) };
    });
  }
  async list(workerAgent: string) {
    address.parse(workerAgent);
    const jobs = await this.serial(async () => { await this.restore(); return [...this.jobs.values()].filter((job) => job.programId === this.program() && job.workerAgent === workerAgent).map((job) => structuredClone(job)); });
    this.kick(); return jobs;
  }
  async retry(escrow: string) {
    address.parse(escrow);
    const job = await this.serial(async () => {
      await this.restore(); const current = this.jobs.get(this.key(escrow));
      if (!current || !['failed', 'interrupted'].includes(current.state) || current.attempts >= 100) throw new Error('Only failed or interrupted jobs can be retried.');
      const live = await this.check(current);
      if (live.status !== 0 || live.resultHash || live.deadline * 1000 <= Date.now()) throw new Error('Escrow is no longer awaiting work.');
      return this.save({ ...current, state: 'accepted', error: null, updatedAt: new Date().toISOString() });
    });
    this.kick(); return job;
  }
  async beginTool(escrow: string, toolId: string) {
    return this.serial(async () => {
      await this.restore(); const job = this.jobs.get(this.key(address.parse(escrow)));
      if (!job || job.state !== 'waiting_tools') throw new Error('Worker job is not waiting for tools.');
      const live = await this.check(job);
      if (live.status !== 0 || live.resultHash || live.deadline * 1000 <= Date.now()) throw new Error('Escrow no longer accepts work.');
      const index = job.tools.findIndex((tool) => tool.id === toolId);
      if (index < 0 || job.tools[index].state !== 'pending' || job.tools.some((tool) => tool.state === 'dispatched')) throw new Error('Tool was already dispatched or an earlier tool is unresolved.');
      const tools = job.tools.map((tool, position) => position === index ? { ...tool, state: 'dispatched' as const, dispatchId: randomUUID() } : tool);
      return this.save({ ...job, tools, updatedAt: new Date().toISOString() });
    });
  }
  async bindTool(escrow: string, toolId: string, dispatchId: string, execution: string, taskId: string, actionId: string) {
    address.parse(execution);
    for (const value of [taskId, actionId]) if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) throw new Error('Invalid Task action binding.');
    const bound=await this.serial(async () => {
      await this.restore(); const job = this.jobs.get(this.key(address.parse(escrow)));
      const index = job?.tools.findIndex((tool) => tool.id === toolId) ?? -1;
      if (!job || job.state !== 'waiting_tools' || index < 0 || job.tools[index].state !== 'dispatched') throw new Error('Tool is not dispatched.');
      const live = await this.check(job);
      if (live.status !== 0 || live.resultHash || live.deadline * 1000 <= Date.now()) throw new Error('Escrow no longer accepts tool work.');
      const previous = job.tools[index];
      if (previous.dispatchId !== dispatchId) throw new Error('Worker tool reservation was replaced; this attempt cannot send a payment.');
      if (previous.execution && (previous.execution !== execution || previous.taskId !== taskId || previous.actionId !== actionId)) throw new Error('A dispatched tool cannot change its stable payment action.');
      const tools = job.tools.map((tool, position) => position === index ? { ...tool, execution, taskId, actionId } : tool);
      return this.save({ ...job, tools, updatedAt: new Date().toISOString() });
    });
    this.kick();return bound;
  }
  async releaseUnboundTool(escrow: string, toolId: string) {
    return this.serial(async () => {
      await this.restore(); const job = this.jobs.get(this.key(address.parse(escrow)));
      const index = job?.tools.findIndex((tool) => tool.id === toolId) ?? -1;
      if (!job || job.state !== 'waiting_tools' || index < 0 || job.tools[index].state !== 'dispatched' || job.tools[index].execution || job.tools[index].payment) throw new Error('Only a tool with no saved payment binding can be released. Recover bound transactions first.');
      const tools = job.tools.map((tool, position) => position === index ? { ...tool, state: 'pending' as const, dispatchId: null } : tool);
      return this.save({ ...job, tools, updatedAt: new Date().toISOString() });
    });
  }
  async completeTool(escrow: string, toolId: string) {
    const completed = await this.serial(async () => {
      await this.restore(); const job = this.jobs.get(this.key(address.parse(escrow)));
      const index = job?.tools.findIndex((tool) => tool.id === toolId) ?? -1;
      if (!job || index < 0) throw new Error('Worker tool not found.');
      const tool = job.tools[index];
      if (tool.state === 'complete') return structuredClone(job);
      if (job.state !== 'waiting_tools' || tool.state !== 'dispatched' || !tool.execution) throw new Error('Tool has no saved payment Execution.');
      const live = await this.check(job);
      if (live.status !== 0 || live.resultHash || live.deadline * 1000 <= Date.now()) throw new Error('Escrow no longer accepts work.');
      await this.verifyTool(job.workerAgent, tool.execution, job.toolRequests[index], tool, { taskHash: job.taskHash, deadline: live.deadline });
      const memory = await getVerifiedMemory(job.workerAgent, tool.execution);
      if (memory.source !== 'skill') throw new Error('Worker tool requires a verified completed Skill response.');
      const tools = job.tools.map((item, position) => position === index ? { ...item, state: 'complete' as const } : item);
      if (new Set([...job.sourceExecutions, ...tools.filter((item) => item.state === 'complete').map((item) => item.execution!)]).size !== job.sourceExecutions.length + tools.filter((item) => item.state === 'complete').length) throw new Error('Worker tool proofs must be distinct.');
      return this.save({ ...job, tools, state: tools.every((item) => item.state === 'complete') ? 'accepted' : 'waiting_tools', updatedAt: new Date().toISOString() });
    });
    this.kick(); return completed;
  }
  async reconcile(escrow: string) {
    address.parse(escrow);
    return this.serial(async () => {
      await this.restore(); const job = this.jobs.get(this.key(escrow)); if (!job) throw new Error('Worker job not found.');
      if (job.state === 'running') throw new Error('Execution is still running.');
      const live = await this.check(job);
      const state = job.resultHash && live.resultHash === job.resultHash ? 'delivered'
        : live.resultHash || live.status !== 0 || live.deadline * 1000 <= Date.now() ? 'closed' : job.state;
      return this.save({ ...job, state, updatedAt: new Date().toISOString() });
    });
  }
  async stop(){this.stopped=true;clearTimeout(this.deliveryTimer);await this.pumpTask;}
  private canDeliver(job:WorkerJob){const selected=this.deliveryOptions?.select(job);return Boolean(selected&&job.result&&job.resultHash&&(job.state==='ready'||job.delivery&&!job.delivery.receipt)&&selected===(job.delivery?.request.tenant??selected));}
  private autoToolIndex(job:WorkerJob){return job.tools.findIndex(t=>t.state!=='complete');}
  private canExecuteTool(job:WorkerJob){const index=this.autoToolIndex(job),t=job.tools[index],tenant=index>=0?this.toolExecutionOptions?.select(job,index):undefined;return job.state==='waiting_tools'&&Boolean(tenant&&t&&(!t.payment||t.payment.request.tenant===tenant&&(t.payment.receipt||t.payment.attempts<8)));}
  private canRecoverTools(job:WorkerJob){return job.state==='waiting_tools'&&Boolean(this.toolRecoveryOptions?.select(job))&&job.tools.some(t=>t.state==='dispatched'&&t.execution!==null);}
  private scheduleDelivery(){if(this.stopped)return;const pending=[...this.jobs.values()].filter(job=>job.programId===this.program()),times=pending.filter(job=>this.canDeliver(job)&&(!job.delivery||job.delivery.attempts<8)).map(job=>job.delivery?.nextAttemptAt??Date.now());times.push(...pending.filter(job=>this.canExecuteTool(job)).map(job=>job.tools[this.autoToolIndex(job)].payment?.nextAttemptAt??Date.now()));if(pending.some(job=>job.state==='accepted'||this.canRecoverTools(job)))times.push(Date.now());if(times.length)this.deliveryTimer=setTimeout(()=>this.kick(),Math.max(1000,Math.min(60000,Math.min(...times)-Date.now())));}
  private async deliver(job:WorkerJob){
    const options=this.deliveryOptions!;
    let request=job.delivery?.request;
    if(!request){const evidence=await prepareWorkerEvidence(job.workerAgent,job.evidence,[...job.sourceExecutions,...job.tools.filter(tool=>tool.state==='complete').map(tool=>tool.execution!)]);request=workerDeliveryInput.parse({tenant:options.select(job),escrow:job.escrow,taskHash:job.taskHash,result:job.result,sources:evidence.sources.map(({execution,contentHash})=>({execution,contentHash}))});}
    const reserved=await this.serial(async()=>{const current=this.jobs.get(this.key(job.escrow));if(!current||current.updatedAt!==job.updatedAt||!this.canDeliver(current))return undefined;const before=current.delivery;return this.save({...current,delivery:{request:request!,receipt:null,attempts:(before?.attempts??0)+1,nextAttemptAt:Date.now()+Math.min(60000,1000*2**(before?.attempts??0)),error:null},updatedAt:new Date().toISOString()});});
    if(!reserved)return;
    try{const receipt=workerDeliveryReceipt.parse(await options.send(reserved.delivery!.request));if(receipt.tenant!==reserved.delivery!.request.tenant||receipt.escrow!==reserved.escrow||receipt.taskHash!==reserved.taskHash||receipt.resultHash!==reserved.resultHash)throw new Error('Original delivery receipt differs.');await options.verify(reserved,receipt);await this.serial(async()=>{const current=this.jobs.get(this.key(reserved.escrow))!;await this.save({...current,state:'delivered',delivery:{...current.delivery!,receipt,error:null},updatedAt:new Date().toISOString()});});}
    catch{await this.serial(async()=>{const current=this.jobs.get(this.key(reserved.escrow))!;await this.save({...current,delivery:{...current.delivery!,error:'Original delivery is unresolved; bounded retries use the saved request only.'},updatedAt:new Date().toISOString()});});}
  }
  private async executeTool(snapshot:WorkerJob){
    const options=this.toolExecutionOptions!,index=this.autoToolIndex(snapshot);let job=snapshot;
    try{
      const live=await this.check(job);if(live.status!==0||live.resultHash||live.deadline*1000<=Date.now()){await this.reconcile(job.escrow);return;}
      if(job.tools[index].execution)try{await this.completeTool(job.escrow,job.tools[index].id);return;}catch{/* An original bound payment still needs its response/proof. */}
      if(job.tools[index].state==='pending')job=await this.beginTool(job.escrow,job.tools[index].id);
      const reserved=await this.serial(async()=>{const current=this.jobs.get(this.key(job.escrow));if(!current||current.tools[index].dispatchId!==job.tools[index].dispatchId||!this.canExecuteTool(current))return undefined;const tool=current.tools[index],before=tool.payment,request=before?.request??workerToolPaymentInput.parse({tenant:options.select(current,index),escrow:current.escrow,taskHash:current.taskHash,toolId:tool.id,dispatchId:tool.dispatchId});const tools=current.tools.map((t,i)=>i===index?{...t,payment:{request,attempts:before?.receipt?before.attempts:(before?.attempts??0)+1,nextAttemptAt:Date.now()+Math.min(60000,1000*2**(before?.attempts??0)),error:null,receipt:before?.receipt??null}}:t);return this.save({...current,tools,updatedAt:new Date().toISOString()});});
      if(!reserved)return;job=reserved;const input=job.tools[index].payment!.request;
      if(!job.tools[index].execution){const binding=workerToolPaymentBinding.parse(await options.preflight(input));job=await this.bindTool(job.escrow,job.tools[index].id,input.dispatchId,binding.execution,binding.taskId,binding.actionId);}
      const receipt=job.tools[index].payment!.receipt??workerToolPaymentReceipt.parse(await options.send(input)),bound=job.tools[index];
      if(receipt.tenant!==input.tenant||receipt.escrow!==input.escrow||receipt.dispatchId!==input.dispatchId||receipt.execution!==bound.execution||receipt.taskId!==bound.taskId||receipt.actionId!==bound.actionId)throw new Error('Worker tool response changed its durable payment binding.');
      await options.verify(job,index,receipt);
      await this.serial(async()=>{const current=this.jobs.get(this.key(job.escrow))!;if(current.tools[index].dispatchId!==input.dispatchId)throw new Error('Worker tool reservation changed.');const tools=current.tools.map((t,i)=>i===index?{...t,payment:{...t.payment!,receipt,error:null}}:t);await this.save({...current,tools,updatedAt:new Date().toISOString()});});
      await this.completeTool(job.escrow,job.tools[index].id);
    }catch{
      await this.serial(async()=>{const current=this.jobs.get(this.key(job.escrow));if(!current?.tools[index].payment)return;const tools=current.tools.map((t,i)=>i===index?{...t,payment:{...t.payment!,error:'Original tool payment is unresolved; bounded retries preserve its original request and binding.'}}:t);await this.save({...current,tools,updatedAt:new Date().toISOString()});});
    }
  }
  private kick() {
    if (this.pumping||this.stopped) return;
    clearTimeout(this.deliveryTimer);
    this.pumping = true;
    this.pumpTask=this.pump().catch(() => console.error('Worker queue stopped; original storage and delivery requests preserved.')).finally(() => { this.pumping = false;this.scheduleDelivery(); });
  }
  private async pump() {
    const checkedTools=new Set<string>();
    for (;;) {
      if(this.stopped)return;
      const job = await this.serial(async () => {
        await this.restore();
        const next = [...this.jobs.values()].find((item) => item.programId === this.program() && (item.state === 'accepted'||this.canExecuteTool(item)&&!checkedTools.has(item.escrow)&&(item.tools[this.autoToolIndex(item)].payment?.nextAttemptAt??0)<=Date.now()||this.canRecoverTools(item)&&!checkedTools.has(item.escrow)||this.canDeliver(item)&&(!item.delivery||item.delivery.attempts<8&&item.delivery.nextAttemptAt<=Date.now())));
        if (!next) return undefined;
        if(next.state!=='accepted')return structuredClone(next);
        return this.save({ ...next, state: 'running', attempts: next.attempts + 1, updatedAt: new Date().toISOString() });
      });
      if (!job) return;
      if(job.state==='waiting_tools'){checkedTools.add(job.escrow);if(this.canExecuteTool(job)){await this.executeTool(job);continue;}const tool=job.tools.find(t=>t.state==='dispatched'&&t.execution);if(tool)try{const live=await this.check(job);if(live.status!==0||live.resultHash||live.deadline*1000<=Date.now())await this.reconcile(job.escrow);else await this.completeTool(job.escrow,tool.id);}catch{/* Original binding remains unresolved; poll verified evidence, never pay again. */}continue;}
      if(job.state!=='running'){await this.deliver(job);continue;}
      let completed: WorkerJob;
      try {
        const live = await this.check(job);
        if (live.status !== 0 || live.resultHash || live.deadline * 1000 <= Date.now()) {
          completed = { ...job, state: 'closed', error: 'Escrow is no longer awaiting work.' };
        } else {
          const evidence = await prepareWorkerEvidence(job.workerAgent, job.evidence, [...job.sourceExecutions, ...job.tools.filter((tool) => tool.state === 'complete').map((tool) => tool.execution!)]);
          const draft = await generateWorkerDraft(job.task, evidence.evidence);
          const current = await this.check(job);
          if (current.status !== 0 || current.resultHash || current.deadline * 1000 <= Date.now()) completed = { ...job, state: 'closed', error: 'Escrow changed during execution; result was not submitted.' };
          else completed = { ...job, state: draft.status === 'needs_evidence' ? 'needs_evidence' : 'ready', result: draft.result, resultHash: digest(draft.result), model: draft.model, generatedAt: draft.generatedAt, evidenceUsed: draft.evidenceUsed, limitations: draft.limitations, error: null };
        }
      } catch (error) {
        completed = { ...job, state: 'failed', error: (error instanceof Error ? error.message : 'Worker execution failed.').slice(0, 500) };
      }
      await this.serial(() => this.save({ ...completed, updatedAt: new Date().toISOString() }));
    }
  }
}
