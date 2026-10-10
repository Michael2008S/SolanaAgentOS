import {handoffSources,type HandoffSources} from './handoff-sources.js';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { HeadlessJournal,type HeadlessRecord } from './headless-journal.js';
import { judgeSettlementReceipt,type JudgeSettlementReceipt } from './judge-settlement-protocol.js';
import { canonicalJson } from './canonical-json.js';
import { judgeAssessment,judgeRecordInput,judgeRecordReceipt,type JudgeRecordInput } from './judge-record-protocol.js';
import { isValidSolanaAddress } from './memory.js';

export const judgeQueueProfiles=z.array(z.object({tenant:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),judgeAgent:z.string().refine(isValidSolanaAddress),escrows:z.array(z.object({escrow:z.string().refine(isValidSolanaAddress),taskHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(100)}).strict()).max(100).refine(profiles=>profiles.reduce((n,p)=>n+p.escrows.length,0)<=100&&new Set(profiles.map(p=>p.tenant)).size===profiles.length&&new Set(profiles.flatMap(p=>p.escrows.map(s=>s.escrow))).size===profiles.reduce((n,p)=>n+p.escrows.length,0));
export type JudgeQueueScope={tenant:string;judgeAgent:string;escrow:string;taskHash:string};
type Material={task:string;result:string;resultHash:string;sources?:HandoffSources};
type Receipt=z.infer<typeof judgeRecordReceipt>;
type Dependencies={journal:HeadlessJournal;program:string;genesis:string;profiles:z.infer<typeof judgeQueueProfiles>;lookup:(scope:JudgeQueueScope)=>Promise<Material|null>;preflight:(input:JudgeRecordInput)=>Promise<void>;assess:(task:string,result:string,taskHash:string,resultHash:string,sources?:HandoffSources)=>Promise<z.infer<typeof judgeAssessment>>;send:(input:JudgeRecordInput)=>Promise<Receipt>;verify:(scope:JudgeQueueScope,input:JudgeRecordInput,receipt:Receipt)=>Promise<void>;settlement?:{select:(scope:JudgeQueueScope)=>boolean;send:(input:JudgeRecordInput)=>Promise<JudgeSettlementReceipt>;verify:(scope:JudgeQueueScope,input:JudgeRecordInput,receipt:JudgeSettlementReceipt)=>Promise<void>};now?:()=>number};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const uuid=(text:string)=>{const h=sha(text);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export function judgeQueueIdentity(program:string,genesis:string,scope:JudgeQueueScope){return {jobId:uuid('judge-queue:'+scope.escrow),scopeHash:sha(canonicalJson({program,genesis,scope})),intent:(stage:string)=>uuid('judge-queue:'+scope.escrow+':'+stage)};}
const materialSchema=z.object({task:z.string().trim().min(1).max(400),result:z.string().trim().min(1).max(6000),resultHash:z.string().regex(/^[a-f0-9]{64}$/),sources:handoffSources.optional()}).strict();
/** No signer. One model reservation per fixed Escrow; interrupted model output
 * requires review. Three durable record attempts recover the same assessment. */
export class JudgeJobQueue {
 private readonly scopes:JudgeQueueScope[];
 private readonly states=new Map<string,{state:string;attempts:number}>();
 private timer:ReturnType<typeof setTimeout>|undefined;
 private active:Promise<void>|undefined;
 private stopped=true;
 constructor(private readonly d:Dependencies){if(!isValidSolanaAddress(d.program)||!isValidSolanaAddress(d.genesis))throw new Error('Judge queue requires a pinned Program and genesis.');this.scopes=judgeQueueProfiles.parse(structuredClone(d.profiles)).flatMap(p=>p.escrows.map(s=>({tenant:p.tenant,judgeAgent:p.judgeAgent,...s})));}
 status(){return this.scopes.map(scope=>({...scope,...this.states.get(scope.escrow)??{state:'waiting',attempts:0}}));}
 start(){this.stopped=false;return this.scan();}
 async stop(){this.stopped=true;clearTimeout(this.timer);await this.active;}
 scan(){if(this.active)return this.active;if(this.stopped)return Promise.resolve();clearTimeout(this.timer);this.active=this.pump().finally(()=>{this.active=undefined;if(!this.stopped)this.timer=setTimeout(()=>void this.scan(),1000);});return this.active;}
 private async pump(){for(const scope of this.scopes){if(this.stopped)break;try{await this.process(scope);}catch{this.states.set(scope.escrow,{state:'blocked',attempts:this.states.get(scope.escrow)?.attempts??0});}}}
 private async process(scope:JudgeQueueScope){
  const {journal,program,genesis}=this.d,{jobId,scopeHash,intent}=judgeQueueIdentity(program,genesis,scope);
  const load=(stage:string)=>{const record=journal.load(scope.tenant,jobId,intent(stage));if(record&&(record.scopeHash!==scopeHash||record.execution!==scope.escrow))throw new Error('Judge queue authority changed.');return record;};
  const save=(stage:string,content:string,complete=false)=>journal.save({tenant:scope.tenant,jobId,intentId:intent(stage),scopeHash,execution:scope.escrow,content,complete});
  const done=load('receipt');if(done){judgeRecordReceipt.parse(JSON.parse(done.content!));this.states.set(scope.escrow,{state:'recorded',attempts:load('assessment')?.responseRecoveries??0});await this.settle(scope,judgeRecordInput.parse(JSON.parse(load('assessment')!.content!)),load,save);return;}
  let assessment=load('assessment');
  if(!assessment){
   if(load('model-reservation')){this.states.set(scope.escrow,{state:'needs_review',attempts:0});return;}
   const raw=await this.d.lookup(scope);if(!raw){this.states.set(scope.escrow,{state:'waiting',attempts:0});return;}
   const material=materialSchema.parse(raw);if(sha(material.task)!==scope.taskHash||sha(material.result)!==material.resultHash)throw new Error('Judge input does not match exact chain text commitments.');
   await this.d.preflight({tenant:scope.tenant,escrow:scope.escrow,taskHash:scope.taskHash,resultHash:material.resultHash,judgment:{verdict:'needs_review',confidence:0,summary:'Background authority preflight',checks:[{criterion:'Authority preflight',status:'unclear',evidence:''}],limitations:[]}});
   // Durable reservation precedes the request, including network failures.
   save('model-reservation',canonicalJson(material));
   const judgment=judgeAssessment.parse(await this.d.assess(material.task,material.result,scope.taskHash,material.resultHash,material.sources));
   if(judgment.checks.some(check=>check.evidence&&!material.result.includes(check.evidence)))throw new Error('Judge evidence is not a result quotation.');
   const input=judgeRecordInput.parse({tenant:scope.tenant,escrow:scope.escrow,taskHash:scope.taskHash,resultHash:material.resultHash,judgment});
   save('assessment',canonicalJson(input));assessment=load('assessment')!;
  }
  const input=judgeRecordInput.parse(JSON.parse(assessment.content!)),reserved=materialSchema.parse(JSON.parse(load('model-reservation')!.content!));
  if(input.tenant!==scope.tenant||input.escrow!==scope.escrow||input.taskHash!==scope.taskHash||input.resultHash!==reserved.resultHash||sha(reserved.task)!==scope.taskHash||sha(reserved.result)!==input.resultHash)throw new Error('Saved Judge assessment commitments changed.');
  const attempts=assessment.responseRecoveries??0;
  if(attempts>=3){this.states.set(scope.escrow,{state:'needs_review',attempts});return;}
  const now=z.number().int().nonnegative().parse((this.d.now??Date.now)());if(attempts){const prior=load('attempt-'+attempts);if(!prior){this.states.set(scope.escrow,{state:'needs_review',attempts});return;}const last=z.number().int().nonnegative().parse(Number(prior.content));if(now<last+Math.min(60000,1000*2**(attempts-1))){this.states.set(scope.escrow,{state:'recording',attempts});return;}}
  assessment.responseRecoveries=attempts+1;journal.save(assessment);save('attempt-'+(attempts+1),String(now));this.states.set(scope.escrow,{state:'recording',attempts:attempts+1});
  const receipt=judgeRecordReceipt.parse(await this.d.send(input));
  if(receipt.tenant!==input.tenant||receipt.escrow!==input.escrow||receipt.taskHash!==input.taskHash||receipt.resultHash!==input.resultHash||receipt.verdict!==input.judgment.verdict||receipt.judgmentHash!==sha(canonicalJson(input.judgment)))throw new Error('Judge receipt changed the assessment.');
  await this.d.verify(scope,input,receipt);save('receipt',canonicalJson(receipt),true);this.states.set(scope.escrow,{state:'recorded',attempts:attempts+1});await this.settle(scope,input,load,save);
 }
 private async settle(scope:JudgeQueueScope,input:JudgeRecordInput,load:(stage:string)=>HeadlessRecord|null,save:(stage:string,content:string,complete?:boolean)=>void){
  const adapter=this.d.settlement;if(!adapter?.select(scope)||input.judgment.verdict==='needs_review')return;
  const done=load('settlement-receipt');if(done){judgeSettlementReceipt.parse(JSON.parse(done.content!));this.states.set(scope.escrow,{state:'settled',attempts:load('settlement-progress')?.responseRecoveries??0});return;}
  let progress=load('settlement-progress');if(!progress){save('settlement-progress',canonicalJson(input));progress=load('settlement-progress')!;}if(progress.content!==canonicalJson(input))throw new Error('Original settlement assessment cannot change.');
  const attempts=progress.responseRecoveries??0;if(attempts>=3){this.states.set(scope.escrow,{state:'needs_review',attempts});return;}
  const now=z.number().int().nonnegative().parse((this.d.now??Date.now)());if(attempts){const prior=load('settlement-attempt-'+attempts);if(!prior){this.states.set(scope.escrow,{state:'needs_review',attempts});return;}const last=z.number().int().nonnegative().parse(Number(prior.content));if(now<last+1000*2**(attempts-1)){this.states.set(scope.escrow,{state:'settling',attempts});return;}}
  progress.responseRecoveries=attempts+1;this.d.journal.save(progress);save('settlement-attempt-'+(attempts+1),String(now));this.states.set(scope.escrow,{state:'settling',attempts:attempts+1});
  const receipt=judgeSettlementReceipt.parse(await adapter.send(input));if(receipt.tenant!==input.tenant||receipt.escrow!==input.escrow||receipt.taskHash!==input.taskHash||receipt.resultHash!==input.resultHash||receipt.verdict!==input.judgment.verdict||receipt.judgmentHash!==sha(canonicalJson(input.judgment)))throw new Error('Settlement receipt changed the original assessment.');await adapter.verify(scope,input,receipt);save('settlement-receipt',canonicalJson(receipt),true);this.states.set(scope.escrow,{state:'settled',attempts:attempts+1});
 }
}
