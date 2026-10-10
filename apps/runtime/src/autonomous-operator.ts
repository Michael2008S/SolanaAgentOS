import { createHash,randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { canonicalJson } from './canonical-json.js';
import { parseAutonomousJob,type AutonomousJob } from './autonomous-loop.js';
const label=(max:number)=>z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const cancellationRequest=z.object({version:z.literal(1),operationId:z.string().uuid(),tenant:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),id:z.string().uuid(),scopeHash:hash,actor:label(80),reason:label(240)}).strict();
export type CancellationRequest=z.infer<typeof cancellationRequest>;
export const cancellationAudit=z.object({request:cancellationRequest,checkpointHash:hash,stateBefore:z.enum(['planning','executing','evaluating','needs_reconciliation','cancelled','completed','failed']),requestedAt:z.number().int().positive(),originalReservedEffects:z.number().int().nonnegative().max(200),alreadyRequested:z.boolean()}).strict();
export const cancellationResult=z.object({audit:cancellationAudit,idempotent:z.boolean(),cancellationRequested:z.literal(true),onChainAuthorityChanged:z.literal(false)}).strict();
export function operatorJobScope(value:AutonomousJob){
 const job=parseAutonomousJob(value);
 return {domain:'agentos-operator-job-scope-v1',tenant:job.tenant,id:job.id,goal:job.goal,agent:job.agent,session:job.session,program:job.program,genesis:job.genesis,limits:job.limits,...(job.acceptance?{acceptance:job.acceptance}:{}),...(job.evaluationMode?{evaluationMode:job.evaluationMode}:{})};
}
export const operatorScopeHash=(job:AutonomousJob)=>createHash('sha256').update(canonicalJson(operatorJobScope(job))).digest('hex');
export function operatorJobReview(job:AutonomousJob){return {request:cancellationRequest.parse({version:1,operationId:randomUUID(),tenant:job.tenant,id:job.id,scopeHash:operatorScopeHash(job),actor:'Local operator',reason:'Cancel this reviewed autonomous job'}),scope:operatorJobScope(job),state:job.state,spent:job.spent,modelRequests:job.modelRequests,reservedEffects:job.intents.filter(item=>item.phase==='reserved').length,semantics:'Stop subsequent work at the next loop boundary. Original dispatched effects still require reconciliation. Existing Session authority is unchanged.'};}
