import { getAddressEncoder, type Address } from '@solana/kit';

export type EscrowSettlementTerms = { proposer: Address; workerAmount: bigint; deadline: bigint };

export function settlementAmountToBaseUnits(value: string, asset: 'SOL' | 'USDC'): bigint {
  const decimals = asset === 'USDC' ? 6 : 9;
  const normalized = value.trim();
  if (!new RegExp(`^\\d+(?:\\.\\d{0,${decimals}})?$`).test(normalized)) throw new Error(`Enter an amount with up to ${decimals} decimal places.`);
  const [whole, fraction = ''] = normalized.split('.');
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
  if (amount > 0xffffffffffffffffn) throw new Error('The settlement amount is outside the supported range.');
  return amount;
}

export function encodeEscrowSettlementTerms(expected: EscrowSettlementTerms): Uint8Array {
  if (expected.workerAmount < 0n || expected.workerAmount > 0xffffffffffffffffn || expected.deadline <= 0n || expected.deadline > 0x7fffffffffffffffn) throw new Error('Settlement terms are outside the supported range.');
  const data = new Uint8Array(48);
  data.set(getAddressEncoder().encode(expected.proposer));
  const view = new DataView(data.buffer);
  view.setBigUint64(32, expected.workerAmount, true);
  view.setBigInt64(40, expected.deadline, true);
  return data;
}
