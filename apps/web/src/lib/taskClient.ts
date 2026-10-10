import { address, getAddressEncoder, getBase58Decoder, getProgramDerivedAddress } from '@solana/kit';
import { PROGRAM_ADDRESS } from './agentOs';

export type TaskCompletionAuthorization = {
  address: string; task: string; agent: string; session: string; planHash: string;
  expectedActions: string; expiresAt: number; revoked: boolean; used: boolean;
};

// Callers must check RPC account ownership before passing the bytes here.
export async function decodeTaskCompletion(key: string, bytes: Uint8Array, task: ChainTask): Promise<TaskCompletionAuthorization> {
  const discriminator = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account:TaskCompletionPermit'))).slice(0, 8);
  if (bytes.length !== 155 || discriminator.some((byte, index) => bytes[index] !== byte) || bytes[152] > 1 || bytes[153] > 1) throw new Error('Task completion authorization layout is invalid.');
  const decoder = getBase58Decoder(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [expected, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('task_completion'), getAddressEncoder().encode(address(task.address))] });
  if (key !== expected || bytes[154] !== bump) throw new Error('Task completion authorization PDA is not canonical.');
  const boundTask = decoder.decode(bytes.slice(8, 40)), agent = decoder.decode(bytes.slice(40, 72)), session = decoder.decode(bytes.slice(72, 104));
  if (boundTask !== task.address || agent !== task.agent) throw new Error('Task completion authorization belongs to another task.');
  const expectedActions = view.getBigUint64(136, true), expiresAt = Number(view.getBigInt64(144, true));
  if (!expectedActions || !bytes.slice(104, 136).some(byte => byte !== 0) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > task.deadline) throw new Error('Task completion authorization terms are invalid.');
  return { address: key, task: boundTask, agent, session, planHash: Array.from(bytes.slice(104, 136), byte => byte.toString(16).padStart(2, '0')).join(''), expectedActions: expectedActions.toString(), expiresAt, revoked: bytes[152] === 1, used: bytes[153] === 1 };
}

export type ChainTask = {
  address: string; agent: string; session: string; id: string; taskHash: string;
  status: 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'waiting';
  resultHash: string | null; deadline: number; actionCount: string; pendingEscrows: string; pendingSkillResults: string;
  sol: { maximum: string; spent: string; remaining: string }; usdc: { maximum: string; spent: string; remaining: string };
};

export async function decodeChainTask(key: string, bytes: Uint8Array, agent: string): Promise<ChainTask> {
  const discriminator = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account:Task'))).slice(0, 8);
  if (bytes.length !== 227 || discriminator.some((byte, index) => bytes[index] !== byte) || bytes[144] > 6 || bytes[145] > 1) throw new Error('Task account layout is invalid.');
  const decoder = getBase58Decoder();
  if (decoder.decode(bytes.slice(8, 40)) !== agent) throw new Error('Task belongs to another Agent.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [expected, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('task'), getAddressEncoder().encode(address(agent)), bytes.slice(72, 80)] });
  const offset = bytes[145] === 1 ? 178 : 146;
  if (expected !== key || bytes[offset + 40] !== bump) throw new Error('Task PDA is not canonical.');
  if (view.getBigUint64(offset + 41, true) > view.getBigUint64(offset + 24, true) || bytes[144] === 3 && (view.getBigUint64(offset + 32, true) !== 0n || view.getBigUint64(offset + 41, true) !== 0n)) throw new Error('Task pending counters or completion state are invalid.');
  const budget = (maxAt: number, spentAt: number) => {
    const maximum = view.getBigUint64(maxAt, true), spent = view.getBigUint64(spentAt, true);
    if (spent > maximum) throw new Error('Task spending exceeds its budget.');
    return { maximum: maximum.toString(), spent: spent.toString(), remaining: (maximum - spent).toString() };
  };
  const deadline = Number(view.getBigInt64(offset + 16, true));
  if (!Number.isSafeInteger(deadline) || deadline < 0) throw new Error('Task deadline is invalid.');
  return { address: key, agent, session: decoder.decode(bytes.slice(40, 72)), id: view.getBigUint64(72, true).toString(), taskHash: Array.from(bytes.slice(80, 112), (byte) => byte.toString(16).padStart(2, '0')).join(''), status: (['ready', 'running', 'paused', 'completed', 'failed', 'cancelled', 'waiting'] as const)[bytes[144]], resultHash: bytes[145] ? Array.from(bytes.slice(146, 178), (byte) => byte.toString(16).padStart(2, '0')).join('') : null, deadline, actionCount: view.getBigUint64(offset + 24, true).toString(), pendingEscrows: view.getBigUint64(offset + 32, true).toString(), pendingSkillResults: view.getBigUint64(offset + 41, true).toString(), sol: budget(112, 128), usdc: budget(120, 136) };
}

export function sessionTaskId(bytes: Uint8Array): bigint | null {
  if (bytes.length < 147) throw new Error('Session account is truncated.');
  return new TextDecoder().decode(bytes.slice(115, 123)) === 'AGTASK01' ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(107, true) : null;
}
