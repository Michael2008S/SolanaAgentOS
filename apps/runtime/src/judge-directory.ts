import { createHash } from 'node:crypto';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
type OwnedAccount = { address: string; data: Uint8Array };
export type JudgeDirectoryTask = {
  escrow: string; mandate: string; employer: string; worker: string; judge: string; session: string;
  taskHash: string; resultHash: string | null; amount: string; asset: 'SOL' | 'USDC'; deadline: number; expiresAt: number;
  accepted: boolean; declined: boolean; used: boolean; escrowStatus: string; readyForAssessment: boolean;
  decision: { address: string; verdict: 'pass' | 'fail' | 'needs_review'; judgmentHash: string; recordedAt: number; settled: boolean } | null;
};
const encoder = getAddressEncoder(), decoder = getAddressDecoder();
const publicKey = (data: Uint8Array, offset: number) => decoder.decode(data.subarray(offset, offset + 32));
const hex = (data: Uint8Array) => Buffer.from(data).toString('hex');
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const time = (data: Uint8Array, offset: number) => { const value = Number(view(data).getBigInt64(offset, true)); if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Judge directory timestamp.'); return value; };
function layout(data: Uint8Array, name: string, length: number) {
  const discriminator = createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
  if (data.length !== length || !discriminator.every((byte, at) => data[at] === byte)) throw new Error(`Invalid ${name} account layout.`);
}
async function pda(programId: string, seed: string, escrow: string) { return getProgramDerivedAddress({ programAddress: address(programId), seeds: [new TextEncoder().encode(seed), encoder.encode(address(escrow))] }); }

// Ownership and Devnet are checked by the loaders. Decode every link again here.
export async function buildJudgeDirectory(programId: string, judge: string, mandates: OwnedAccount[], decisions: OwnedAccount[], loadEscrows: (keys: string[]) => Promise<OwnedAccount[]>, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Judge directory limit must be 1–100.');
  const failures: { address: string; error: string }[] = [];
  const candidates: OwnedAccount[] = [];
  for (const account of mandates) {
    try {
      const data = account.data; layout(data, 'JudgeMandate', 220);
      const escrow = publicKey(data, 8), [expected, bump] = await pda(programId, 'escrow_judge', escrow);
      if (account.address !== expected || data[219] !== bump || publicKey(data, 104) !== judge || [216, 217, 218].some((at) => data[at] > 1) || data[216] && data[217] || data[218] && !data[216]) throw new Error('Judge mandate PDA, Agent or state is invalid.');
      time(data, 200); time(data, 208); candidates.push(account);
    } catch (cause) { failures.push({ address: account.address, error: cause instanceof Error ? cause.message : 'Invalid Judge mandate.' }); }
  }
  const now = Math.floor(Date.now() / 1_000);
  const priority = (data: Uint8Array) => time(data, 200) <= now || data[217] ? 0 : data[216] && !data[218] ? 3 : !data[216] ? 2 : 1;
  candidates.sort((a, b) => priority(b.data) - priority(a.data) || time(a.data, 200) - time(b.data, 200) || a.address.localeCompare(b.address));
  const selected = candidates.slice(0, limit);
  const escrowKeys = selected.map((account) => publicKey(account.data, 8));
  if (new Set(escrowKeys).size !== escrowKeys.length) throw new Error('Judge directory contains duplicate Escrow mandates.');
  const escrows = new Map((await loadEscrows(escrowKeys)).map((account) => [account.address, account]));
  const decisionByEscrow = new Map<string, OwnedAccount>();
  for (const account of decisions) {
    if (account.data.length !== 243) { failures.push({ address: account.address, error: 'Invalid JudgeDecision account length.' }); continue; }
    const escrow = publicKey(account.data, 8);
    if (decisionByEscrow.has(escrow)) throw new Error('Duplicate Judge decisions for one Escrow.');
    decisionByEscrow.set(escrow, account);
  }
  const tasks: JudgeDirectoryTask[] = [];
  for (const mandate of selected) {
    try {
      const data = mandate.data, escrow = publicKey(data, 8);
      const escrowData = escrows.get(escrow)?.data;
      if (!escrowData) throw new Error('Escrow snapshot is unavailable.');
      layout(escrowData, 'Escrow', 180);
      if (escrowData[128] > 1) throw new Error('Invalid Escrow result tag.');
      const offset = escrowData[128] ? 161 : 129;
      const [canonical, bump] = await getProgramDerivedAddress({ programAddress: address(programId), seeds: [new TextEncoder().encode('escrow'), escrowData.subarray(8, 40), escrowData.subarray(72, 80)] });
      const employer = publicKey(data, 40), worker = publicKey(data, 72), taskHash = hex(data.subarray(168, 200));
      if (canonical !== escrow || escrowData[offset + 1] !== bump || escrowData[offset] > 5 || escrowData[offset + 18] > 1 || publicKey(escrowData, 8) !== employer || publicKey(escrowData, 40) !== worker || hex(escrowData.subarray(96, 128)) !== taskHash) throw new Error('Judge mandate does not match its canonical Escrow.');
      const deadline = time(escrowData, 88), expiresAt = time(data, 200), acceptedAt = time(data, 208);
      if (expiresAt > deadline || data[216] && (acceptedAt <= 0 || acceptedAt >= expiresAt)) throw new Error('Invalid Judge acceptance or expiry.');
      const resultHash = escrowData[128] ? hex(escrowData.subarray(129, 161)) : null;
      let decision: JudgeDirectoryTask['decision'] = null;
      const decisionAccount = decisionByEscrow.get(escrow);
      if (decisionAccount) {
        const value = decisionAccount.data; layout(value, 'JudgeDecision', 243);
        const [expected, decisionBump] = await pda(programId, 'escrow_decision', escrow);
        const recordedAt = time(value, 233);
        if (!data[218] || hex(value.subarray(200, 232)) === '0'.repeat(64) || value[241] && (value[232] === 2 || escrowData[offset] !== (value[232] === 0 ? 1 : 2)) || value[232] > 2 || value[241] > 1 || expected !== decisionAccount.address || value[242] !== decisionBump || publicKey(value, 40) !== mandate.address || publicKey(value, 72) !== judge || publicKey(value, 104) !== publicKey(data, 136) || hex(value.subarray(136, 168)) !== taskHash || hex(value.subarray(168, 200)) !== resultHash || recordedAt < acceptedAt || recordedAt >= expiresAt) throw new Error('Judge decision commitments or authorization are invalid.');
        decision = { address: expected, verdict: (['pass', 'fail', 'needs_review'] as const)[value[232]], judgmentHash: hex(value.subarray(200, 232)), recordedAt, settled: Boolean(value[241]) };
      } else if (data[218]) throw new Error('Consumed Judge mandate has no readable decision. Refresh before acting.');
      const now = Math.floor(Date.now() / 1_000);
      tasks.push({ escrow, mandate: mandate.address, employer, worker, judge, session: publicKey(data, 136), taskHash, resultHash, amount: view(escrowData).getBigUint64(80, true).toString(), asset: escrowData[offset + 18] ? 'USDC' : 'SOL', deadline, expiresAt, accepted: Boolean(data[216]), declined: Boolean(data[217]), used: Boolean(data[218]), escrowStatus: ['funded', 'released', 'refunded', 'cancelled', 'settlement_proposed', 'settled'][escrowData[offset]], readyForAssessment: Boolean(data[216] && !data[217] && !data[218] && resultHash && escrowData[offset] === 0 && now < Math.min(expiresAt, deadline)), decision });
    } catch (cause) { failures.push({ address: mandate.address, error: cause instanceof Error ? cause.message : 'Could not verify Judge task.' }); }
  }
  tasks.sort((a, b) => Number(b.readyForAssessment) - Number(a.readyForAssessment) || a.expiresAt - b.expiresAt || a.escrow.localeCompare(b.escrow));
  return { tasks, count: tasks.length, limit, truncated: candidates.length > limit || mandates.length >= 1_000 || decisions.length >= 1_000, failures: failures.slice(0, 100) };
}
