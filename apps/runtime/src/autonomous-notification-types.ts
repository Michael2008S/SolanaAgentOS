import * as z from 'zod/v4';
export const notificationState=z.enum(['completed','failed','cancelled','needs_reconciliation']);
export const notificationEvent=z.object({version:z.literal(1),id:z.string().uuid(),tenant:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),jobId:z.string().uuid(),state:notificationState,
 cycle:z.number().int().nonnegative(),actions:z.number().int().nonnegative(),spent:z.object({sol:z.string().regex(/^[0-9]+$/),usdc:z.string().regex(/^[0-9]+$/)}).strict(),createdAt:z.iso.datetime()}).strict();
export type NotificationClaim={id:string;tenant:string;body:string;destinationHash:string;attempts:number;token:string};
