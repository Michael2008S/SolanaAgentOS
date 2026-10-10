import { createHash } from 'node:crypto';
import type { AutonomousJob,AutonomousAction } from './autonomous-loop.js';
export const mcpExecutionScope=(job:AutonomousJob,action:AutonomousAction)=>createHash('sha256').update(JSON.stringify({tenant:job.tenant,id:job.id,agent:job.agent,session:job.session,program:job.program,genesis:job.genesis,limits:job.limits,action})).digest('hex');
