import assert from 'node:assert/strict';
import test from 'node:test';
import { historyOptions, inspectReceipt } from '../../scripts/check-local-history.mjs';

const genesis = 'EhmZWnZngz2DsXT4d8ykg9sf1L5byYj7HfVnbPwrbK4v';
const signature = '4AgpDdJ4aDiNNoF8JkwLzjsZ12FapGxgdThQFRGQ4Wsf6322e7LpiF3RcpkeZfSZfPs5y9ukTwLFxKLGpfjfMriQ';
const args = [`--genesis=${genesis}`, `--receipt=${signature}:62554`];
test('history checker accepts only explicit local receipts and expected genesis', () => {
  assert.equal(historyOptions(args).receipts[0].slot, 62554);
  for (const endpoint of ['https://api.devnet.solana.com', 'http://user:pass@localhost', 'file:///tmp/ledger']) assert.throws(() => historyOptions(args, endpoint));
  for (const flags of [[], args.slice(1), [...args, args[1]], [...args, '--unknown'], [`--genesis=${genesis}`, '--receipt=x:1']]) assert.throws(() => historyOptions(flags));
});
test('missing receipts distinguish pruned history from unknown availability', () => {
  const receipt = { signature, slot: 62554 };
  assert.equal(inspectReceipt(receipt, null, 69650).status, 'pruned');
  assert.equal(inspectReceipt(receipt, null, 62554).status, 'unavailable');
});
test('availability requires the exact successful transaction and slot', () => {
  const receipt = { signature, slot: 62554 };
  const transaction = { slot: 62554, transaction: { signatures: [signature] }, meta: { err: null } };
  assert.equal(inspectReceipt(receipt, transaction, 60000).status, 'available');
  for (const invalid of [{ ...transaction, slot: 62555 }, { ...transaction, transaction: { signatures: ['wrong'] } }, { ...transaction, meta: null }, { ...transaction, meta: { err: 'failed' } }]) {
    assert.equal(inspectReceipt(receipt, invalid, 60000).status, 'mismatch-or-failed');
  }
});
