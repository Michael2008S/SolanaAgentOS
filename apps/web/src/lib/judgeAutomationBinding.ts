/** Public commitments fixed by an explicit per-Escrow authorization. */
export type JudgeAutomationBinding = {
  judge: string; session: string; expiresAt: number; employer: string; worker: string;
  amount: string; asset: 'SOL' | 'USDC'; taskHash: string; resultHash: string | null;
};
export type JudgeAutomationSnapshot = {
  employer: string; worker: string; amount: string; asset: 'SOL' | 'USDC'; taskHash: string;
  resultHash: string | null; deadline: number;
  mandate: { accepted: boolean; declined: boolean; judge: string; session: string; expiresAt: number } | null;
};
export function assertJudgeAutomationBinding(plan: JudgeAutomationBinding, live: JudgeAutomationSnapshot, now = Math.floor(Date.now() / 1_000)) {
  const mandate = live.mandate;
  if (!mandate?.accepted || mandate.declined || mandate.judge !== plan.judge || mandate.session !== plan.session || mandate.expiresAt !== plan.expiresAt || live.employer !== plan.employer || live.worker !== plan.worker || live.amount !== plan.amount || live.asset !== plan.asset || live.taskHash !== plan.taskHash || (plan.resultHash !== null && live.resultHash !== plan.resultHash) || now >= Math.min(live.deadline, plan.expiresAt)) throw new Error('Automatic Judge authorization or task/result commitments changed or expired.');
}

/** Terminal observation grants no permission to assess, sign or settle. */
export function assertJudgeTerminalOutcome(plan: JudgeAutomationBinding, live: JudgeAutomationSnapshot & { funded: boolean; decision?: { settled: boolean } | null }) {
  if (live.funded && !live.decision?.settled) throw new Error('Escrow is still open; normal authorization remains required.');
  assertJudgeAutomationBinding(plan, live, 0);
}
