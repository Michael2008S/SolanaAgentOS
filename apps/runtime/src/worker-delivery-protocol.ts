import * as z from 'zod/v4';
import { isValidSolanaAddress } from './memory.js';
const key=z.string().refine(isValidSolanaAddress),hash=z.string().regex(/^[a-f0-9]{64}$/);
const tenant=z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const workerDeliveryInput=z.object({tenant,escrow:key,taskHash:hash,result:z.string().min(1).max(400),sources:z.array(z.object({execution:key,contentHash:hash}).strict()).max(3).default([])}).strict().refine(input=>new Set(input.sources.map(source=>source.execution)).size===input.sources.length);
export type WorkerDeliveryInput=z.infer<typeof workerDeliveryInput>;
export const workerDeliveryProfiles=z.array(z.object({tenant,escrows:z.array(z.object({escrow:key,taskHash:hash}).strict()).min(1).max(100)}).strict()).max(100).refine(profiles=>new Set(profiles.map(profile=>profile.tenant)).size===profiles.length&&profiles.every(profile=>new Set(profile.escrows.map(item=>item.escrow)).size===profile.escrows.length));

export const workerDeliveryReceipt=z.object({tenant,escrow:key,taskHash:hash,resultHash:hash,signature:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),commitment:z.literal('finalized')}).strict();
export type WorkerDeliveryReceipt=z.infer<typeof workerDeliveryReceipt>;
