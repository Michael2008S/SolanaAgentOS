import type { WorkerProfile } from './worker-profiles.js';
import type { RecentReputation } from './worker-reputation.js';
export type HiringWorker = { address: string; owner: string; name: string; active: boolean;
  profile: WorkerProfile | null; profileError: string | null; recentReputation: RecentReputation };
export type HiringBudget = { asset: 'SOL' | 'USDC'; amount: string };
/** Inputs are finalized directory records and current verified profiles. This is
 * candidate selection only, never a quote, permission or execution proof. */
export function hiringCandidates<T extends HiringWorker>(workers: T[], employer: { address: string; owner: string }, budget?: HiringBudget): T[] {
  return workers.filter(worker => worker.active && worker.address !== employer.address && worker.owner !== employer.owner &&
    !worker.profileError && (!worker.profile || worker.profile.payload.profile.availability === 'available') && meetsStartingPrice(worker,budget))
    .sort((a,b) => b.recentReputation.rankScore - a.recentReputation.rankScore || a.address.localeCompare(b.address));
}
export function meetsStartingPrice(worker: HiringWorker, budget?: HiringBudget): boolean {
  if (!budget || !worker.profile) return true;
  const price = budget.asset === 'SOL' ? worker.profile.payload.profile.minimumSol : worker.profile.payload.profile.minimumUsdc;
  return BigInt(price) <= BigInt(budget.amount);
}
export function hiringEvidence(worker: HiringWorker): string {
  const rep=worker.recentReputation;
  return `Worker Agent ${worker.address} · independent Judge quality ${rep.quality === null ? 'unknown' : rep.quality.toFixed(1)+'/100'} · confidence ${(rep.confidence*100).toFixed(1)}% · ${rep.independentEmployers} independent employers · ${rep.independentJudges} independent Judges · risks: ${rep.risks.join(', ') || 'none detected'} · ${worker.profile ? 'Owner-signed capability and price claims' : 'no current signed capability or price claims'}`;
}
export function hiringModelContext(worker: HiringWorker) {
  const {quality,confidence,rankScore,effectiveSamples,independentEmployers,independentJudges,risks}=worker.recentReputation;
  return {address:worker.address,name:worker.name,owner:worker.owner,
    recentReputation:{quality,confidence,rankScore,effectiveSamples,independentEmployers,independentJudges,risks},
    profileClaims:worker.profile?.payload.profile ?? null};
}
