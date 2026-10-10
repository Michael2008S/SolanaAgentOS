import type * as z from 'zod/v4';
import type { runtimeWorkerToolProfiles } from './remote-worker-tool.js';
/** Inbox task text cannot add tools. Only the operator's exact Worker/Escrow/hash scope supplies requests. */
export function workerInboxToolRequests(profiles:z.infer<typeof runtimeWorkerToolProfiles>,workerAgent:string,escrow:string,taskHash:string){const matches=profiles.filter(p=>p.workerAgent===workerAgent&&p.escrow===escrow&&p.taskHash===taskHash);if(matches.length>1)throw new Error('Worker Inbox tool scope is ambiguous.');return structuredClone(matches[0]?.tools.map(t=>t.request)??[]);}
