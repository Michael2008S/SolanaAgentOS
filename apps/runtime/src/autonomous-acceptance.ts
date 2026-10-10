import * as z from 'zod/v4';
import { autonomousReceiptOutcome } from './autonomous-receipt.js';
import type { AutonomousJob } from './autonomous-loop.js';

const phrase = z.string().trim().min(1).max(200);
/** Literal coverage checks supplied by the caller, never executable expressions. */
export const autonomousAcceptanceSchema = z.object({
  answerIncludes: z.array(phrase).max(20),
  evidence: z.array(z.object({tool:z.string().min(1).max(120), contains:z.array(phrase).max(20)}).strict()).max(20),
}).strict().refine(value=>value.answerIncludes.length+value.evidence.length>0,'At least one completion check is required.');
const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('en-US');
export function missingAutonomousAcceptance(job:AutonomousJob,answer:string):string[]{
  if(!job.acceptance)return [];
  const missing:string[]=[];
  for(const phrase of job.acceptance.answerIncludes){
    if(!normalize(answer).includes(normalize(phrase)))missing.push('Answer must include: '+phrase);
  }
  for(const requirement of job.acceptance.evidence){
    // Each requirement must be covered by one actual, verified tool receipt.
    const satisfied=job.intents.some(intent=>intent.phase==='complete'&&intent.action.tool===requirement.tool&&intent.receipt?.verified===true&&autonomousReceiptOutcome(intent.receipt)==='success'&&requirement.contains.every(phrase=>normalize(intent.receipt!.output).includes(normalize(phrase))));
    if(!satisfied)missing.push('Verified evidence required from '+requirement.tool+(requirement.contains.length?': '+requirement.contains.join(', '):''));
  }
  return missing;
}
