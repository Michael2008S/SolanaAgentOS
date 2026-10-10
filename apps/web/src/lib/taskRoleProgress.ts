import { address, getAddressDecoder, getProgramDerivedAddress } from '@solana/kit';
import type { AppClient } from '../providers';
import { deriveWorkerDeliveryAddress, PROGRAM_ADDRESS } from './agentOs';
import type { JudgeSnapshot } from './judgeClient';
import { readTaskProofAccount } from './taskPaymentProof';

export type TaskRoleProgress = { role: 'Worker delivery' | 'Judge appointment' | 'Judge decision' | 'Settlement'; state: string; detail: string };
export type WorkerPermitProgress = { session: string; expiresAt: number; revoked: boolean; used: boolean };

/** A recorded permit is not proof that another browser has its key or auto opt-in. */
export async function decodeWorkerPermitProgress(key: string, data: Uint8Array, snapshot: JudgeSnapshot): Promise<WorkerPermitProgress> {
  const discriminator = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account:WorkerDeliveryPermit'))).slice(0, 8);
  if (data.length !== 115 || discriminator.some((byte, index) => byte !== data[index]) || data[112] > 1 || data[113] > 1) throw new Error('Invalid Worker delivery permit layout.');
  const decoder = getAddressDecoder();
  const [expected, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('worker_delivery'), new Uint8Array(data.slice(8, 40))] });
  if (key !== expected || data[114] !== bump || decoder.decode(data.slice(8, 40)) !== snapshot.escrow || decoder.decode(data.slice(40, 72)) !== snapshot.worker) throw new Error('Worker delivery permit belongs to another Escrow or Worker.');
  const expiresAt = Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(104, true));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > snapshot.deadline) throw new Error('Invalid Worker permit deadline.');
  return { session: decoder.decode(data.slice(72, 104)), expiresAt, revoked: data[112] === 1, used: data[113] === 1 };
}

export function describeTaskRoles(snapshot: JudgeSnapshot, permit: WorkerPermitProgress | null, now = Math.floor(Date.now() / 1000)): TaskRoleProgress[] {
  const terminal = ['released', 'refunded', 'cancelled', 'settled'].includes(snapshot.status);
  const worker: TaskRoleProgress = snapshot.resultHash
    ? { role: 'Worker delivery', state: 'delivered', detail: `Result committed: ${snapshot.resultHash}. This does not establish whether delivery was automatic.` }
    : terminal ? { role: 'Worker delivery', state: 'closed', detail: 'Escrow ended without a committed Worker result.' }
    : !permit ? { role: 'Worker delivery', state: 'needs authorization', detail: `Worker ${snapshot.worker}: create a Session delivery grant, then enable automatic delivery in the Worker page.` }
    : permit.revoked || permit.used || permit.expiresAt <= now || snapshot.deadline <= now
      ? { role: 'Worker delivery', state: 'permit unavailable', detail: 'The permit is revoked, used or expired. Review the Worker role; delivery cannot rely on this permit.' }
      : { role: 'Worker delivery', state: 'permit recorded', detail: `Session ${permit.session}; expires ${new Date(permit.expiresAt * 1000).toISOString()}. Its live permissions, restored key, fee reserve and browser auto opt-in are checked at delivery.` };
  const mandate = snapshot.mandate;
  const appointment: TaskRoleProgress = !mandate
    ? { role: 'Judge appointment', state: 'needs proposal', detail: 'Employer proposes an independent Judge and Session; Worker must accept the exact terms.' }
    : mandate.declined ? { role: 'Judge appointment', state: 'declined', detail: 'Worker declined these Judge terms; successful automatic completion is blocked.' }
    : !mandate.accepted ? { role: 'Judge appointment', state: 'awaiting Worker acceptance', detail: `Worker must accept Judge ${mandate.judge} and Session ${mandate.session}.` }
    : !snapshot.decision && (mandate.expiresAt <= now || snapshot.deadline <= now)
      ? { role: 'Judge appointment', state: 'expired', detail: 'The accepted Judge terms or Escrow deadline expired before a decision.' }
      : { role: 'Judge appointment', state: 'accepted', detail: `Judge ${mandate.judge}; Session ${mandate.session}. Browser automatic assessment and settlement require that role’s explicit opt-in.` };
  const decision: TaskRoleProgress = snapshot.decision
    ? { role: 'Judge decision', state: snapshot.decision.verdict, detail: `Judgment commitment: ${snapshot.decision.judgmentHash}.` }
    : { role: 'Judge decision', state: snapshot.resultHash ? 'awaiting assessment' : 'waiting for delivery', detail: 'The Judge needs the exact task and result texts verified against their chain commitments.' };
  const settlement: TaskRoleProgress = { role: 'Settlement', state: snapshot.decision?.settled ? 'confirmed' : terminal ? snapshot.status : 'pending', detail: snapshot.decision?.settled ? 'Judge settlement recorded. Only pass plus verified release can count as a successful Task action.' : 'Task finalization waits for a confirmed pass settlement; fail, needs_review and refunds require review.' };
  return [worker, appointment, decision, settlement];
}

export async function loadTaskRoleProgress(client: AppClient, snapshot: JudgeSnapshot) {
  const key = await deriveWorkerDeliveryAddress(address(snapshot.escrow));
  const data = await readTaskProofAccount(client, key, 'WorkerDeliveryPermit', 115, true);
  return describeTaskRoles(snapshot, data ? await decodeWorkerPermitProgress(key, data, snapshot) : null);
}
