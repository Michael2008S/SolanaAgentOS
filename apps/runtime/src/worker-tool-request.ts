import * as z from 'zod/v4';
import { isValidSolanaAddress } from './memory.js';
const address=z.string().refine(isValidSolanaAddress);
export const workerToolRequest = z.object({
  skill: address, asset: z.enum(['SOL', 'USDC']), prompt: z.string().trim().min(1).max(1000),
  endpoint: z.string().max(2_000).refine((value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash; } catch { return false; } }),
  maxAmount: z.string().regex(/^[1-9][0-9]{0,19}$/).refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n),
}).strict();
