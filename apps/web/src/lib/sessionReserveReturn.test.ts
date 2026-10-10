import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionReserveReturn } from './sessionReserveReturn';

test('return all leaves zero after the quoted fee', () => {
  assert.deepEqual(sessionReserveReturn(20_000_000n, 5_000n, 890_880n), { amount: 19_995_000n, remaining: 0n });
});
test('reject the former dust-producing default', () => {
  assert.throws(() => sessionReserveReturn(20_000_000n, 5_000n, 890_880n, 19_990_000n), /rent minimum/);
});
test('partial returns must retain rent-exempt balance', () => {
  assert.deepEqual(sessionReserveReturn(20_000_000n, 5_000n, 890_880n, 19_104_120n), { amount: 19_104_120n, remaining: 890_880n });
});
test('reject insufficient balance, excessive fee and invalid values', () => {
  assert.throws(() => sessionReserveReturn(5_000n, 5_000n, 890_880n));
  assert.throws(() => sessionReserveReturn(20_000_000n, 10_001n, 890_880n));
  assert.throws(() => sessionReserveReturn(-1n, 5_000n, 890_880n));
  assert.throws(() => sessionReserveReturn(20_000_000n, 5_000n, 890_880n, 20_000_000n));
});
