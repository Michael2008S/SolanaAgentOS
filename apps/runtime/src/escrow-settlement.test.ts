import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { attachEscrowSettlements, decodeEscrowSettlement } from './escrow-settlement.js';

const program = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const escrow = { address: '11111111111111111111111111111111', amount: '18446744073709551615', status: 'settlement_proposed' };
const proposer = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

async function fixture(workerAmount = 40n, deadline = 1_000n) {
  const encoder = getAddressEncoder();
  const [pda, bump] = await getProgramDerivedAddress({ programAddress: address(program), seeds: [new TextEncoder().encode('escrow_settlement'), encoder.encode(address(escrow.address))] });
  const data = Buffer.alloc(89);
  createHash('sha256').update('account:EscrowSettlement').digest().copy(data, 0, 0, 8);
  Buffer.from(encoder.encode(address(escrow.address))).copy(data, 8);
  Buffer.from(encoder.encode(address(proposer))).copy(data, 40);
  data.writeBigUInt64LE(workerAmount, 72);
  data.writeBigInt64LE(deadline, 80);
  data[88] = bump;
  return { address: pda as string, data };
}

test('snapshot preserves exact atomic shares beyond Number precision and shows expired proposals', async () => {
  for (const workerAmount of [0n, 9_007_199_254_740_993n, 18_446_744_073_709_551_615n]) {
    const account = await fixture(workerAmount);
    const value = await decodeEscrowSettlement(account, program, escrow);
    assert.equal(value.workerAmount, workerAmount.toString());
    assert.equal(BigInt(value.workerAmount) + BigInt(value.employerAmount), BigInt(escrow.amount));
    assert.equal(value.proposer, proposer);
    assert.equal(value.deadline, 1_000);
  }
});

test('snapshot rejects wrong PDA, bump, Escrow link, discriminator, and truncated bytes', async () => {
  const original = await fixture();
  await assert.rejects(decodeEscrowSettlement({ ...original, address: proposer }, program, escrow));
  for (const offset of [0, 8, 88]) {
    const data = Buffer.from(original.data);
    data[offset] ^= 1;
    await assert.rejects(decodeEscrowSettlement({ ...original, data }, program, escrow));
  }
  await assert.rejects(decodeEscrowSettlement({ ...original, data: original.data.subarray(0, 88) }, program, escrow));
});

test('snapshot rejects excess payouts and unsupported deadlines', async () => {
  await assert.rejects(decodeEscrowSettlement(await fixture(101n), program, { ...escrow, amount: '100' }));
  for (const deadline of [-1n, 0n, 9_007_199_254_740_992n]) {
    await assert.rejects(decodeEscrowSettlement(await fixture(1n, deadline), program, escrow));
  }
});

test('missing proposals report an error without losing the Escrow record', async () => {
  const [pending, completed] = await attachEscrowSettlements([escrow, { ...escrow, address: proposer, status: 'settled' }], [], program);
  assert.equal(pending.address, escrow.address);
  assert.equal(pending.settlement, null);
  assert.ok(pending.settlementReadError);
  assert.equal(completed.settlement, null);
  assert.equal(completed.settlementReadError, null);
});

test('invalid duplicate cannot overwrite a verified proposal, and closed proposals are ignored', async () => {
  const account = await fixture();
  const [pending] = await attachEscrowSettlements([escrow], [account, { ...account, address: proposer }], program);
  assert.equal(pending.settlement?.address, account.address);
  assert.equal(pending.settlementReadError, null);
  const [closed] = await attachEscrowSettlements([{ ...escrow, status: 'settled' }], [account], program);
  assert.equal(closed.settlement, null);
});
