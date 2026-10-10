import assert from 'node:assert/strict';
import test from 'node:test';
import { address, getAddressEncoder } from '@solana/kit';
import { encodeEscrowSettlementTerms, settlementAmountToBaseUnits } from './escrowSettlement.js';

test('settlement amounts allow zero, one atomic unit and exact u64 values for both assets', () => {
  for (const asset of ['SOL', 'USDC'] as const) assert.equal(settlementAmountToBaseUnits('0', asset), 0n);
  assert.equal(settlementAmountToBaseUnits('0.000000001', 'SOL'), 1n);
  assert.equal(settlementAmountToBaseUnits('0.000001', 'USDC'), 1n);
  assert.equal(settlementAmountToBaseUnits('18446744073.709551615', 'SOL'), 0xffffffffffffffffn);
  assert.equal(settlementAmountToBaseUnits('18446744073709.551615', 'USDC'), 0xffffffffffffffffn);
});

test('settlement amount parsing rejects rounding, scientific notation, negative and excess amounts', () => {
  for (const amount of ['', '-1', 'NaN', '1e-6', '0.0000001', '18446744073709.551616']) assert.throws(() => settlementAmountToBaseUnits(amount, 'USDC'));
  assert.throws(() => settlementAmountToBaseUnits('0.0000000001', 'SOL'));
});

test('review terms use Anchor Pubkey/u64/i64 wire order without integer truncation', () => {
  const proposer = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const workerAmount = 0xffffffffffffffffn;
  const deadline = 1_000n;
  const bytes = encodeEscrowSettlementTerms({ proposer, workerAmount, deadline });
  assert.equal(bytes.length, 48);
  assert.deepEqual(Array.from(bytes.subarray(0, 32)), Array.from(getAddressEncoder().encode(proposer)));
  const view = new DataView(bytes.buffer);
  assert.equal(view.getBigUint64(32, true), workerAmount);
  assert.equal(view.getBigInt64(40, true), deadline);
  for (const invalid of [{ workerAmount: -1n }, { workerAmount: workerAmount + 1n }, { deadline: 0n }, { deadline: 0x8000000000000000n }]) assert.throws(() => encodeEscrowSettlementTerms({ proposer, workerAmount, deadline, ...invalid }));
});
