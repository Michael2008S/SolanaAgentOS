import { getBase58Encoder, signature, type Base58EncodedBytes } from '@solana/kit';
import type { AppClient } from '../providers';
import { PROGRAM_ADDRESS } from './agentOs';
import type { ChainTask } from './taskClient';
import { readTaskJournal } from './taskJournal';
import { loadTaskPaymentProof } from './taskPaymentProof';
import { loadJudgeSnapshot, readSharedJudgeTexts } from './judgeClient';
import { loadTaskRoleProgress } from './taskRoleProgress';
import { assertTaskEvidenceSnapshot } from './taskEvidenceSnapshot';
import { assembleTaskResult, matchesPlannedCheckpoint, taskDigest, verifyTaskPlan, type TaskPlan, type TaskPlanProgress } from './taskPlan';
export type { TaskPlanProgress } from './taskPlan';

export type TaskPlanEvidence = { task: ChainTask; rows: TaskPlanProgress[]; ready: boolean; reason: string; artifact?: string; resultHash?: string };

/** Read-only barrier. Never pays, evaluates, signs, retries or trusts imported states. */
export async function inspectTaskPlan(client: AppClient, plan: TaskPlan, liveTask: ChainTask): Promise<TaskPlanEvidence> {
  await verifyTaskPlan(plan);
  if (liveTask.address !== plan.task || liveTask.agent !== plan.agent || liveTask.id !== plan.taskId || liveTask.session !== plan.session || liveTask.taskHash !== plan.taskHash) throw new Error('Task identity or Session changed since the plan was committed.');
  const records = readTaskJournal(plan.agent).filter(item => item.taskId === plan.taskId);
  const rows: TaskPlanProgress[] = [];
  for (const action of plan.actions) {
    const id = plan.bindings[action.id], item = records.find(item => item.actionId === id);
    if (!id) { rows.push({ id: action.id, kind: action.kind, state: 'planned', detail: 'The planned action has no bound payment receipt.' }); continue; }
    if (!item || !matchesPlannedCheckpoint(plan, action, item)) throw new Error('Restore the original journal: a planned action lacks its exact payment checkpoint.');
    const base = { id: action.id, kind: action.kind, execution: item.execution, signature: item.signature };
    if (item.state !== 'confirmed' || !item.signature) { rows.push({ ...base, state: 'payment_unknown', detail: 'The original payment needs confirmation or review; it will not be repeated.' }); continue; }
    const proof = await loadTaskPaymentProof(client, item);
    if (!proof.receipt || !proof.execution) throw new Error('Confirmed action lacks its matching chain receipt and Execution.');
    const tx = await client.rpc.getTransaction(signature(item.signature), { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 }).send();
    if (!tx?.meta || tx.meta.err !== null || tx.transaction.signatures[0] !== item.signature) throw new Error('Original successful payment transaction cannot be verified.');
    const message = tx.transaction.message, keys = [...message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    if (keys[0] !== item.review!.feePayer || !message.instructions.some((ix: { programIdIndex: number; data: Base58EncodedBytes; accounts: readonly number[] }) => keys[ix.programIdIndex] === PROGRAM_ADDRESS && [...getBase58Encoder().encode(ix.data)].map(byte => byte.toString(16).padStart(2, '0')).join('') === item.review!.data && ix.accounts.length === item.review!.accounts.length && ix.accounts.every((index, at) => keys[index] === item.review!.accounts[at].address) && [0, 1].every(at => ix.accounts[at] >= 0 && ix.accounts[at] < message.header.numRequiredSignatures))) throw new Error('Original transaction differs from the planned recipient or payment instruction.');
    assertTaskEvidenceSnapshot(liveTask, proof.task);
    if (action.kind === 'skill') {
      const result = item.skillResult;
      if (!result || proof.execution[98] !== 1) { rows.push({ ...base, state: 'waiting_skill', detail: 'Waiting for the saved response and its on-chain result commitment.' }); continue; }
      const output = [...proof.execution.slice(99, 131)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (await taskDigest(result.content) !== result.outputHash || output !== result.outputHash) throw new Error('Skill response differs from its on-chain output commitment.');
      if (result.attempts?.some(attempt => ['prepared', 'signed', 'unknown'].includes(attempt.state))) { rows.push({ ...base, state: 'waiting_skill', detail: 'Check the unresolved result-recording attempt before completion.' }); continue; }
      rows.push({ ...base, state: 'complete', detail: 'Skill response and output commitment verified.', content: result.content, outputHash: output });
    } else if (action.kind === 'escrow') {
      const snapshot = await loadJudgeSnapshot(client, item.escrowTask!.address);
      if (snapshot.task !== plan.task || snapshot.execution !== item.execution || snapshot.taskHash !== item.inputHash || snapshot.worker !== action.target || snapshot.amount !== action.amount || snapshot.asset !== action.asset) throw new Error('Worker Escrow differs from the planned task funding.');
      const roles = await loadTaskRoleProgress(client, snapshot);
      if (!snapshot.resultHash && snapshot.status === 'funded') { rows.push({ ...base, roles, state: 'waiting_worker', detail: 'Waiting for Worker delivery. Check the role preparation below.', escrow: snapshot.escrow }); continue; }
      if (snapshot.decision?.verdict === 'fail' || snapshot.decision?.verdict === 'needs_review' || ['refunded', 'cancelled', 'settlement_proposed'].includes(snapshot.status)) { rows.push({ ...base, roles, state: 'needs_review', detail: 'The Worker outcome is failed, refunded, cancelled or requires review; successful Task completion is blocked.', escrow: snapshot.escrow }); continue; }
      if (!snapshot.decision?.settled || snapshot.decision.verdict !== 'pass') { rows.push({ ...base, roles, state: 'waiting_judge', detail: 'Waiting for a pass judgment and its confirmed settlement.', escrow: snapshot.escrow }); continue; }
      if (snapshot.status !== 'released' || proof.link?.[104] !== 1 || proof.execution[proof.execution[98] ? 131 : 99] !== 0 || !snapshot.mandate?.accepted || !snapshot.mandate.used) throw new Error('Successful judgment lacks matching release, closed TaskEscrow or completed Execution.');
      const shared = await readSharedJudgeTexts(client, snapshot.escrow);
      if (shared.snapshot.resultHash !== snapshot.resultHash || shared.snapshot.decision?.judgmentHash !== snapshot.decision.judgmentHash || !shared.snapshot.decision.settled) throw new Error('Worker result or judgment changed during evidence collection.');
      rows.push({ ...base, roles, state: 'complete', detail: 'Worker result, pass judgment and settlement verified.', content: shared.result, outputHash: snapshot.resultHash!, escrow: snapshot.escrow, judgmentHash: snapshot.decision.judgmentHash });
    } else rows.push({ ...base, state: 'complete', detail: 'Exact recipient, amount and successful payment verified.' });
  }
  const unresolved = records.some(item => ['prepared', 'signed', 'unknown'].includes(item.state));
  return { task: liveTask, rows, ...await assembleTaskResult(plan, liveTask, rows, unresolved) };
}
