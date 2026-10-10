import { createHash } from 'node:crypto';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

export type EscrowSettlementSnapshot = {
  address: string;
  proposer: string;
  workerAmount: string;
  employerAmount: string;
  deadline: number;
};
export type EscrowSettlementView = { settlement: EscrowSettlementSnapshot | null; settlementReadError: string | null };
type EscrowRecord = { address: string; amount: string; status: string };
type OwnedProgramAccount = { address: string; data: Uint8Array };

// The directory loader checks program ownership before passing account bytes here.
export async function decodeEscrowSettlement(
  account: OwnedProgramAccount, programId: string, escrow: EscrowRecord,
): Promise<EscrowSettlementSnapshot> {
  const discriminator = createHash('sha256').update('account:EscrowSettlement').digest().subarray(0, 8);
  const data = account.data;
  if (data.length !== 89 || !discriminator.every((byte, i) => data[i] === byte)) throw new Error('Settlement account data is invalid.');
  const encoder = getAddressEncoder();
  const decoder = getAddressDecoder();
  const [expectedAddress, bump] = await getProgramDerivedAddress({
    programAddress: address(programId), seeds: [new TextEncoder().encode('escrow_settlement'), encoder.encode(address(escrow.address))],
  });
  if (account.address !== expectedAddress || data[88] !== bump || decoder.decode(data.subarray(8, 40)) !== escrow.address) throw new Error('Settlement account does not match its Escrow PDA.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const workerAmount = view.getBigUint64(72, true);
  const employerAmount = BigInt(escrow.amount) - workerAmount;
  const deadline = Number(view.getBigInt64(80, true));
  if (employerAmount < 0n || !Number.isSafeInteger(deadline) || deadline <= 0) throw new Error('Settlement amount or deadline is invalid.');
  return { address: expectedAddress, proposer: decoder.decode(data.subarray(40, 72)), workerAmount: workerAmount.toString(), employerAmount: employerAmount.toString(), deadline };
}

export async function attachEscrowSettlements<T extends EscrowRecord>(
  escrows: T[], accounts: OwnedProgramAccount[], programId: string,
): Promise<(T & EscrowSettlementView)[]> {
  const pending = new Map(escrows.filter((escrow) => escrow.status === 'settlement_proposed').map((escrow) => [escrow.address, escrow]));
  const snapshots = new Map<string, EscrowSettlementSnapshot>();
  const failures = new Map<string, string>();
  const decoder = getAddressDecoder();
  await Promise.all(accounts.map(async (account) => {
    if (account.data.length < 40) return;
    const escrowAddress = decoder.decode(account.data.subarray(8, 40));
    const escrow = pending.get(escrowAddress);
    if (!escrow) return;
    try { snapshots.set(escrowAddress, await decodeEscrowSettlement(account, programId, escrow)); }
    catch (cause) { failures.set(escrowAddress, cause instanceof Error ? cause.message : 'Could not verify Settlement account.'); }
  }));
  return escrows.map((escrow) => ({
    ...escrow,
    settlement: escrow.status === 'settlement_proposed' ? snapshots.get(escrow.address) ?? null : null,
    settlementReadError: escrow.status === 'settlement_proposed' && !snapshots.has(escrow.address)
      ? failures.get(escrow.address) ?? 'Settlement proposal is unavailable. It may have been settled since this read; refresh to check the current state.' : null,
  }));
}
