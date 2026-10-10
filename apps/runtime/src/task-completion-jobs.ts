import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { HeadlessJournal } from './headless-journal.js';
import { canonicalJson } from './canonical-json.js';
import { taskCompletionInput,taskCompletionReceipt,type TaskCompletionInput } from './task-completion-protocol.js';
const jobInput=z.object({tenant:taskCompletionInput.shape.tenant,plan:taskCompletionInput.shape.plan,evidence:taskCompletionInput.shape.evidence}).strict().refine(j=>j.evidence.length===j.plan.actions.length&&new Set(j.evidence.map(e=>e.id)).size===j.evidence.length&&j.evidence.every(e=>j.plan.actions.some(a=>a.id===e.id&&(a.kind!=='payment'||e.content===undefined))));
export const completionJobs=z.array(jobInput).max(100).refine(jobs=>new Set(jobs.map(j=>j.plan.task)).size===jobs.length);
type Receipt=z.infer<typeof taskCompletionReceipt>;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),uuid=(s:string)=>{const h=sha(s);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
type Options={journal:HeadlessJournal;program:string;genesis:string;jobs:z.infer<typeof completionJobs>;ready:(input:TaskCompletionInput)=>Promise<'ready'|'waiting'|'review'>;materialize?:(input:TaskCompletionInput)=>Promise<TaskCompletionInput|null>;send:(input:TaskCompletionInput)=>Promise<Receipt>;verify:(input:TaskCompletionInput,receipt:Receipt)=>Promise<void>;now?:()=>number};
/** Fixed operator jobs, no wallet or model. Unknown completion retries only its
 * immutable request and the gateway's original signed effect. */
export class TaskCompletionJobQueue {
 private readonly jobs:TaskCompletionInput[];
 private stopped=true;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private active:Promise<void>|undefined;
 private states=new Map<string,{state:string;attempts:number}>();
 constructor(private readonly options:Options){this.jobs=completionJobs.parse(structuredClone(options.jobs));}
 status(){return this.jobs.map(j=>({tenant:j.tenant,agent:j.plan.agent,task:j.plan.task,...this.states.get(j.plan.task)??{state:'waiting',attempts:0}}));}
 start(){this.stopped=false;return this.scan();}
 async stop(){this.stopped=true;clearTimeout(this.timer);await this.active;}
 scan(){if(this.active)return this.active;if(this.stopped)return Promise.resolve();clearTimeout(this.timer);this.active=this.pump().finally(()=>{this.active=undefined;if(!this.stopped)this.timer=setTimeout(()=>void this.scan(),1000);});return this.active;}
 private async pump(){for(const input of this.jobs){if(this.stopped)break;try{await this.process(input);}catch{this.states.set(input.plan.task,{state:'blocked',attempts:this.states.get(input.plan.task)?.attempts??0});}}}
 private async process(input:TaskCompletionInput){const {journal,program,genesis}=this.options,task=input.plan.task,jobId=uuid('task-completion-job:'+task),scopeHash=sha(canonicalJson({program,genesis,input})),intent=(stage:string)=>uuid('task-completion-job:'+task+':'+stage),load=(stage:string)=>{const r=journal.load(input.tenant,jobId,intent(stage));if(r&&(r.scopeHash!==scopeHash||r.execution!==task))throw new Error('Original completion job authority changed.');return r;};
  const done=load('receipt');if(done){const receipt=taskCompletionReceipt.parse({...JSON.parse(done.content!),artifact:done.resultArtifact});if(receipt.task!==task||receipt.planHash!==input.plan.planHash||receipt.taskHash!==input.plan.taskHash||receipt.tenant!==input.tenant||sha(receipt.artifact)!==receipt.resultHash)throw new Error('Saved completion receipt differs.');this.states.set(task,{state:'completed',attempts:load('progress')?.responseRecoveries??0});return;}
  let progress=load('progress');if(!progress){const ready=await this.options.ready(input);if(ready!=='ready'){this.states.set(task,{state:ready==='review'?'needs_review':'waiting',attempts:0});return;}const materialized=this.options.materialize?await this.options.materialize(structuredClone(input)):input;if(!materialized){this.states.set(task,{state:'waiting',attempts:0});return;}progress={tenant:input.tenant,jobId,intentId:intent('progress'),scopeHash,execution:task,resultArtifact:canonicalJson(taskCompletionInput.parse(materialized)),complete:false};journal.save(progress);}const request=taskCompletionInput.parse(JSON.parse(progress.resultArtifact!));if(request.tenant!==input.tenant||canonicalJson(request.plan)!==canonicalJson(input.plan)||input.evidence.some(e=>!request.evidence.some(r=>r.id===e.id&&r.signature===e.signature&&(e.content===undefined||r.content===e.content))))throw new Error('Original completion request cannot change.');
  const attempts=progress.responseRecoveries??0;if(attempts>=3){this.states.set(task,{state:'needs_review',attempts});return;}const now=z.number().int().nonnegative().parse((this.options.now??Date.now)());if(attempts){const prior=load('attempt-'+attempts);if(!prior){this.states.set(task,{state:'needs_review',attempts});return;}const last=z.number().int().nonnegative().parse(Number(prior.content));if(now<last+1000*2**(attempts-1)){this.states.set(task,{state:'completing',attempts});return;}}
  progress.responseRecoveries=attempts+1;journal.save(progress);journal.save({tenant:input.tenant,jobId,intentId:intent('attempt-'+(attempts+1)),scopeHash,execution:task,content:String(now),complete:true});this.states.set(task,{state:'completing',attempts:attempts+1});
  const receipt=taskCompletionReceipt.parse(await this.options.send(request));if(receipt.tenant!==input.tenant||receipt.task!==task||receipt.taskHash!==input.plan.taskHash||receipt.planHash!==input.plan.planHash||sha(receipt.artifact)!==receipt.resultHash)throw new Error('Completion response differs from the original request.');await this.options.verify(request,receipt);const {artifact,...metadata}=receipt;journal.save({tenant:input.tenant,jobId,intentId:intent('receipt'),scopeHash,execution:task,content:JSON.stringify(metadata),resultArtifact:artifact,complete:true});this.states.set(task,{state:'completed',attempts:attempts+1});
 }
}
