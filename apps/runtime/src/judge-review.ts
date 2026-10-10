import {handoffSources} from './handoff-sources.js';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { HeadlessJournal } from './headless-journal.js';
import { canonicalJson } from './canonical-json.js';
import { judgeRecordInput, type JudgeRecordInput } from './judge-record-protocol.js';
import { judgeQueueIdentity, judgeQueueProfiles } from './judge-jobs.js';
import { isValidSolanaAddress } from './memory.js';

const key = z.string().refine(isValidSolanaAddress);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export const judgeReview = z.object({
  reviewId: z.string().uuid(),
  program: key, genesis: key, judgeAgent: key,
  reviewer: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(600),
  expiresAt: z.number().int().positive().safe(),
  input: judgeRecordInput,
}).strict();
type Options = {
  journal: HeadlessJournal; program: string; genesis: string;
  profiles: z.infer<typeof judgeQueueProfiles>;
  preflight: (input: JudgeRecordInput) => Promise<void>;
  now?: () => number;
};

/** Operator-supplied assessment for an interrupted model request only.
 * The caller owns the stopped Runtime's exclusive journal. This function
 * cannot call a model, sign, broadcast, reset retries or replace output. */
export async function importJudgeReview(options: Options, raw: unknown) {
  const review = judgeReview.parse(raw), { input } = review;
  if (review.program !== options.program || review.genesis !== options.genesis)
    throw new Error('Review network or Program differs.');
  const profile = judgeQueueProfiles.parse(options.profiles).find(p => p.tenant === input.tenant);
  if (!profile || profile.judgeAgent !== review.judgeAgent ||
      !profile.escrows.some(e => e.escrow === input.escrow && e.taskHash === input.taskHash))
    throw new Error('Review is outside the fixed Judge queue scope.');
  const scope = { tenant: input.tenant, judgeAgent: review.judgeAgent, escrow: input.escrow, taskHash: input.taskHash };
  const { jobId, scopeHash, intent } = judgeQueueIdentity(options.program, options.genesis, scope);
  const load = (stage: string) => {
    const row = options.journal.load(input.tenant, jobId, intent(stage));
    if (row && (row.scopeHash !== scopeHash || row.execution !== input.escrow))
      throw new Error('Original Judge queue authority changed.');
    return row;
  };
  const reservation = load('model-reservation');
  if (!reservation?.content) throw new Error('Review requires an existing interrupted model reservation.');
  const material = z.object({ task: z.string().trim().min(1).max(400), result: z.string().trim().min(1).max(6000), resultHash: z.string().regex(/^[a-f0-9]{64}$/), sources: handoffSources.optional() }).strict().parse(JSON.parse(reservation.content));
  if (sha(material.task) !== input.taskHash || sha(material.result) !== input.resultHash || material.resultHash !== input.resultHash ||
      input.judgment.checks.some(check => check.evidence && !material.result.includes(check.evidence)))
    throw new Error('Review must match the original task, result and quoted evidence.');
  const audit = load('manual-review'), assessment = load('assessment');
  const body = canonicalJson(review), output = canonicalJson(input);
  if (audit && audit.content !== body) throw new Error('Accepted review cannot be replaced.');
  if (assessment) {
    if (!audit || assessment.content !== output) throw new Error('Existing assessment cannot be replaced.');
    return { status: 'already_imported' as const, reviewId: review.reviewId, escrow: input.escrow };
  }
  if (load('receipt') || load('settlement-progress') || load('settlement-receipt'))
    throw new Error('Recorded or settling judgments cannot be reviewed again.');
  if (review.expiresAt <= Math.floor((options.now ?? Date.now)() / 1000))
    throw new Error('Review authorization expired.');
  // Fresh authority, exact result, confidence and accepted mandate are still
  // required by the existing read-only gateway barrier before any write.
  await options.preflight(input);
  const save = (stage: string, content: string) => options.journal.save({
    tenant: input.tenant, jobId, intentId: intent(stage), scopeHash,
    execution: input.escrow, content, complete: stage === 'manual-review',
  });
  // Audit first: interruption between writes is recoverable by the same
  // review only, with another live preflight; it never grants a new model.
  save('manual-review', body);
  save('assessment', output);
  return { status: 'imported' as const, reviewId: review.reviewId, escrow: input.escrow };
}
