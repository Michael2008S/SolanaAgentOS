import { createHash } from 'node:crypto';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

export type TaskSnapshot = {
  address: string; agent: string; session: string; id: string; taskHash: string;
  status: 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'waiting';
  resultHash: string | null; createdAt: number; updatedAt: number; deadline: number;
  actionCount: string; pendingEscrows: string; pendingSkillResults: string;
  sol: { maximum: string; spent: string; remaining: string };
  usdc: { maximum: string; spent: string; remaining: string };
};

// Program ownership is checked by the caller before decoding these account bytes.
export async function decodeTaskSnapshot(key: string, bytes: Buffer, programId: string): Promise<TaskSnapshot> {
  const discriminator = createHash('sha256').update('account:Task').digest().subarray(0, 8);
  if (bytes.length !== 227 || !bytes.subarray(0, 8).equals(discriminator) || bytes[144] > 6 || bytes[145] > 1) throw new Error('Task account layout is invalid.');
  const decoder = getAddressDecoder();
  const encoder = getAddressEncoder();
  const agent = decoder.decode(bytes.subarray(8, 40));
  const session = decoder.decode(bytes.subarray(40, 72));
  const id = bytes.readBigUInt64LE(72);
  const offset = bytes[145] ? 178 : 146;
  const [expected, bump] = await getProgramDerivedAddress({ programAddress: address(programId), seeds: [Buffer.from('task'), encoder.encode(address(agent)), bytes.subarray(72, 80)] });
  if (expected !== key || bytes[offset + 40] !== bump) throw new Error('Task account is not its canonical PDA.');
  if (bytes.readBigUInt64LE(offset + 41) > bytes.readBigUInt64LE(offset + 24) || bytes[144] === 3 && (bytes.readBigUInt64LE(offset + 32) !== 0n || bytes.readBigUInt64LE(offset + 41) !== 0n)) throw new Error('Task pending counters or completion state are invalid.');
  const budget = (start: number, spentOffset: number) => {
    const maximum = bytes.readBigUInt64LE(start); const spent = bytes.readBigUInt64LE(spentOffset);
    if (spent > maximum) throw new Error('Task spending exceeds its limit.');
    return { maximum: maximum.toString(), spent: spent.toString(), remaining: (maximum - spent).toString() };
  };
  const time = (at: number) => {
    const value = Number(bytes.readBigInt64LE(at));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Task timestamp is invalid.');
    return value;
  };
  return { address: key, agent, session, id: id.toString(), taskHash: bytes.subarray(80, 112).toString('hex'), status: (['ready', 'running', 'paused', 'completed', 'failed', 'cancelled', 'waiting'] as const)[bytes[144]], resultHash: bytes[145] ? bytes.subarray(146, 178).toString('hex') : null, createdAt: time(offset), updatedAt: time(offset + 8), deadline: time(offset + 16), actionCount: bytes.readBigUInt64LE(offset + 24).toString(), pendingEscrows: bytes.readBigUInt64LE(offset + 32).toString(), pendingSkillResults: bytes.readBigUInt64LE(offset + 41).toString(), sol: budget(112, 128), usdc: budget(120, 136) };
}


export type TaskActionSnapshot = { address: string; task: string; execution: string; amount: string; asset: 'SOL' | 'USDC'; actionId: string };

// The caller checks Program ownership before passing the raw account data.
export async function decodeTaskActionSnapshot(key: string, bytes: Buffer, programId: string): Promise<TaskActionSnapshot> {
  const discriminator = createHash('sha256').update('account:TaskAction').digest().subarray(0, 8);
  if (bytes.length !== 90 || !bytes.subarray(0, 8).equals(discriminator) || bytes[80] > 1 || bytes.readBigUInt64LE(72) === 0n) throw new Error('TaskAction account layout is invalid.');
  const decoder = getAddressDecoder();
  const task = decoder.decode(bytes.subarray(8, 40));
  const [expected, bump] = await getProgramDerivedAddress({ programAddress: address(programId), seeds: [Buffer.from('task_action'), getAddressEncoder().encode(address(task)), bytes.subarray(81, 89)] });
  if (expected !== key || bump !== bytes[89]) throw new Error('TaskAction account is not its canonical PDA.');
  return { address: key, task, execution: decoder.decode(bytes.subarray(40, 72)), amount: bytes.readBigUInt64LE(72).toString(), asset: bytes[80] === 0 ? 'SOL' : 'USDC', actionId: bytes.readBigUInt64LE(81).toString() };
}
