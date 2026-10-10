import type { ChainTask } from './taskClient';

/** Only a verified Task observation changed; the next tick may read again.
 * Never use this error to retry a payment, signature or broadcast. */
export class TaskEvidenceChanged extends Error {
  constructor() {
    super('Task state changed while checking results. Reading fresh evidence on the next cycle; no transaction is repeated.');
    this.name = 'TaskEvidenceChanged';
  }
}

export function assertTaskEvidenceSnapshot(expected: ChainTask, observed: ChainTask): void {
  if (observed.address !== expected.address || observed.agent !== expected.agent || observed.id !== expected.id || observed.session !== expected.session || observed.taskHash !== expected.taskHash || observed.deadline !== expected.deadline || observed.sol.maximum !== expected.sol.maximum || observed.usdc.maximum !== expected.usdc.maximum) throw new Error('Task identity, authorization or budget differs during the evidence read. Review the original fixed plan.');
  if (observed.actionCount !== expected.actionCount || observed.sol.spent !== expected.sol.spent || observed.usdc.spent !== expected.usdc.spent || observed.pendingEscrows !== expected.pendingEscrows || observed.pendingSkillResults !== expected.pendingSkillResults || observed.status !== expected.status || observed.resultHash !== expected.resultHash) throw new TaskEvidenceChanged();
}
