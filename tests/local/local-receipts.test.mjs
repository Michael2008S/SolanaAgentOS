import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptWatchOptions, inspectLocalReceipt } from '../../scripts/watch-local-receipts.mjs';
const address = '11111111111111111111111111111111', genesis = 'EhmZWnZngz2DsXT4d8ykg9sf1L5byYj7HfVnbPwrbK4v';
const signature = '1'.repeat(64), row = { signature, slot: 42 };
const args = [`--genesis=${genesis}`, `--address=${address}`, '--output=docs/evidence/test-receipts'];
const transaction = () => ({ slot: 42, transaction: { signatures: [signature], message: { accountKeys: [address] } }, meta: { err: null } });
test('capture requires explicit local identities and a new bounded evidence path', () => {
  assert.equal(receiptWatchOptions(args).seconds, 60);
  for (const more of [['--seconds=0'], ['--seconds=7201'], ['--from-slot=-1'], [`--address=${address}`], ['--output=/tmp/other'], ['--output=docs/evidence/../other']]) assert.throws(() => receiptWatchOptions([...args, ...more]));
  assert.throws(() => receiptWatchOptions(args, 'https://api.devnet.solana.com'));
  assert.throws(() => receiptWatchOptions(args.slice(1)));
});
test('receipt validation rejects changed signatures, slots and unrelated accounts', () => {
  const wrongSignature = transaction(); wrongSignature.transaction.signatures = ['2'.repeat(64)];
  assert.throws(() => inspectLocalReceipt(row, wrongSignature, [address]));
  assert.throws(() => inspectLocalReceipt(row, { ...transaction(), slot: 43 }, [address]));
  assert.throws(() => inspectLocalReceipt(row, transaction(), [genesis]));
  assert.throws(() => inspectLocalReceipt(row, null, [address]));
});
test('failed transactions are retained as failed evidence, never reported successful', () => {
  const failed = transaction(); failed.meta.err = { InstructionError: [0, 'InvalidArgument'] };
  assert.equal(inspectLocalReceipt(row, failed, [address]).successful, false);
  assert.equal(inspectLocalReceipt(row, transaction(), [address]).successful, true);
});
test('watched addresses may be resolved through an original loaded address table', () => {
  const loaded = transaction(); loaded.transaction.message.accountKeys = [genesis]; loaded.meta.loadedAddresses = { writable: [address], readonly: [] };
  assert.deepEqual(inspectLocalReceipt(row, loaded, [address]).matchedAddresses, [address]);
  loaded.meta.loadedAddresses.readonly = null;
  assert.throws(() => inspectLocalReceipt(row, loaded, [address]));
});
