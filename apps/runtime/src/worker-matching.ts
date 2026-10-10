import * as z from 'zod/v4';
import { isValidSolanaAddress } from './memory.js';
import type { WorkerProfile } from './worker-profiles.js';

const atomic = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= 18446744073709551615n);
export const workerSearchSchema = z.object({
  query: z.string().max(120).optional(), tag: z.string().max(60).optional(),
  language: z.string().trim().min(1).max(60).optional(), model: z.string().trim().min(1).max(60).optional(),
  available: z.boolean().optional(), asset: z.enum(['SOL', 'USDC']).optional(), maxAmount: atomic.optional(),
  minimumQuality: z.number().finite().min(0).max(100).optional(),
  minimumConfidence: z.number().finite().min(0).max(1).optional(),
  employerOwner: z.string().refine(isValidSolanaAddress).optional(), cursor: z.string().max(100).optional(),
}).strict().refine(value => (value.asset === undefined) === (value.maxAmount === undefined), { message: 'Asset and maximum atomic amount must be supplied together.' });
export type WorkerSearch = z.infer<typeof workerSearchSchema>;
type MatchWorker = { address: string; owner: string; name: string; active: boolean; profile: WorkerProfile | null;
  recentReputation: { quality: number | null; confidence: number } };
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().trim();
/** Profiles must already be verified against the current canonical Owner and chain.
 * Starting prices are public claims, not an Escrow quote or spending authority. */
export function matchesWorker(worker: MatchWorker, filters: WorkerSearch): boolean {
  const p = worker.profile?.payload.profile;
  const query = normalized(filters.query ?? '');
  if (query && !normalized([worker.name, worker.address, worker.owner, p?.description ?? '', ...p?.tags ?? [], ...p?.languages ?? [], ...p?.models ?? []].join(' ')).includes(query)) return false;
  if (filters.employerOwner === worker.owner) return false;
  if (filters.tag && !p?.tags.some(value => normalized(value) === normalized(filters.tag!))) return false;
  if (filters.language && !p?.languages.some(value => normalized(value) === normalized(filters.language!))) return false;
  if (filters.model && !p?.models.some(value => normalized(value) === normalized(filters.model!))) return false;
  if (filters.available && (!worker.active || p?.availability !== 'available')) return false;
  if (filters.asset && (!p || BigInt(filters.asset === 'SOL' ? p.minimumSol : p.minimumUsdc) > BigInt(filters.maxAmount!))) return false;
  if (filters.minimumQuality !== undefined && (worker.recentReputation.quality === null || worker.recentReputation.quality < filters.minimumQuality)) return false;
  if (filters.minimumConfidence !== undefined && worker.recentReputation.confidence < filters.minimumConfidence) return false;
  return true;
}
/** Reject duplicate or unknown parameters rather than silently weakening a filter. */
export function parseWorkerSearch(params: URLSearchParams): WorkerSearch {
  const values: Record<string, unknown> = {};
  const names = new Set(['q','tag','language','model','available','asset','maxAmount','minimumQuality','minimumConfidence','employerOwner','cursor']);
  for (const [name, value] of params) {
    if (!names.has(name) || params.getAll(name).length !== 1) throw new Error('Unknown or duplicate Worker search parameter.');
    if (name === 'available') { if (!['true','false'].includes(value)) throw new Error('Invalid availability filter.'); values.available = value === 'true'; }
    else if (name === 'minimumQuality' || name === 'minimumConfidence') {
      if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new Error('Invalid reputation threshold.');
      values[name] = Number(value);
    } else values[name === 'q' ? 'query' : name] = value;
  }
  return workerSearchSchema.parse(values);
}
