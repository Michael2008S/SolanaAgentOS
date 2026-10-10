import test from 'node:test';
import assert from 'node:assert/strict';
import { address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressEncoder, getProgramDerivedAddress, getTransactionEncoder, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { deploymentSubmissionHandler, inspectDeploymentTransaction } from '../../scripts/devnet-deployment-guard.mjs';
const payer = '88cAm7hLj17dgRsz3pfGiRZ1mjx5frnGUEZj3QZAdPk4', program = 'HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv', buffer = '4ULeLDPtvhV1R2AXZpCDgwGGFKUjvLhjciLzFMsL3hXy';
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111', system = '11111111111111111111111111111111';
const binary = Buffer.from('reviewed executable bytes');
const review = { feePayer: payer, upgradeAuthority: payer, program, rent: { programLamports: '833120', temporaryBufferLamports: '1000000' } };
const account = (key, role = 1) => ({ address: address(key), role });
const variant = n => { const data = Buffer.alloc(4); data.writeUInt32LE(n); return data; };
function encoded(instructions, feePayer = payer, signatureMarker = 1, blockhash = system) {
 let message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: address(blockhash), lastValidBlockHeight: 100n }, setTransactionMessageFeePayer(address(feePayer), createTransactionMessage({ version: 'legacy' })));
 message = appendTransactionMessageInstructions(instructions, message);
 const tx = compileTransaction(message);
 // Offline scope tests only: these dummy signatures are never sent or accepted
 // by real signature verification, and no signer/private key is created.
 return Buffer.from(getTransactionEncoder().encode({ ...tx, signatures: Object.fromEntries(Object.keys(tx.signatures).map(key => [key, new Uint8Array(64).fill(signatureMarker)])) })).toString('base64');
}
const write = (bytes = binary, target = buffer) => { const data = Buffer.alloc(16 + bytes.length); data.writeUInt32LE(1); data.writeBigUInt64LE(BigInt(bytes.length), 8); data.set(bytes, 16); return { programAddress: address(loader), accounts: [account(target), account(payer, 2)], data }; };
test('deployment writes are restricted to reviewed bytes, buffer and payer', async () => {
 assert.equal((await inspectDeploymentTransaction(encoded([write()]), review, binary, buffer)).phase, 'write-buffer');
 for (const tx of [encoded([write(Buffer.from('different bytes'))]), encoded([write(binary, program)]), encoded([write()], buffer), encoded([write(), write()])]) await assert.rejects(inspectDeploymentTransaction(tx, review, binary, buffer));
});
test('only the fixed buffer rent and loader initialization are accepted', async () => {
 const data = Buffer.alloc(52); data.writeBigUInt64LE(1000000n, 4); data.writeBigUInt64LE(BigInt(binary.length + 37), 12); data.set(getAddressEncoder().encode(address(loader)), 20);
 const create = { programAddress: address(system), accounts: [account(payer, 3), account(buffer, 3)], data };
 const init = { programAddress: address(loader), accounts: [account(buffer), account(payer, 0)], data: variant(0) };
 assert.equal((await inspectDeploymentTransaction(encoded([create, init]), review, binary)).buffer, buffer);
 data.writeBigUInt64LE(1000001n, 4);
 await assert.rejects(inspectDeploymentTransaction(encoded([create, init]), review, binary));
});
test('deployment target, capacity, authority and sysvars are fixed', async () => {
 const [programData] = await getProgramDerivedAddress({ programAddress: address(loader), seeds: [getAddressEncoder().encode(address(program))] });
 const data = Buffer.alloc(12); data.writeUInt32LE(2); data.writeBigUInt64LE(BigInt(binary.length), 4);
 const ix = { programAddress: address(loader), accounts: [account(payer, 3), account(programData), account(program), account(buffer), account('SysvarRent111111111111111111111111111111111', 0), account('SysvarC1ock11111111111111111111111111111111', 0), account(system, 0), account(payer, 2)], data };
 assert.equal((await inspectDeploymentTransaction(encoded([ix]), review, binary, buffer)).phase, 'deploy');
 data.writeBigUInt64LE(BigInt(binary.length * 2), 4); await assert.rejects(inspectDeploymentTransaction(encoded([ix]), review, binary, buffer));
 data.writeBigUInt64LE(BigInt(binary.length), 4); ix.accounts[4] = account(program, 0); await assert.rejects(inspectDeploymentTransaction(encoded([ix]), review, binary, buffer));
});
test('recovery may refund only the same buffer to the payer; authority changes are denied', async () => {
 const close = { programAddress: address(loader), accounts: [account(buffer), account(payer), account(payer, 2)], data: variant(5) };
 assert.equal((await inspectDeploymentTransaction(encoded([close]), review, binary, buffer)).phase, 'recover-buffer');
 close.accounts[0] = account(program); await assert.rejects(inspectDeploymentTransaction(encoded([close]), review, binary, buffer));
 close.accounts[0] = account(buffer); close.accounts[1] = account(program); await assert.rejects(inspectDeploymentTransaction(encoded([close]), review, binary, buffer));
 close.accounts[1] = account(payer); close.data = variant(4); await assert.rejects(inspectDeploymentTransaction(encoded([close]), review, binary, buffer));
});

function fakeSubmission(overrides = {}, behavior = {}) {
 const limits = { maximumTransactions: 3, networkFeePerTransactionLamports: '10000', totalNetworkFeeLamports: '30000', totalTemporaryRentAndProgramDepositLamports: '15400000000', ...overrides };
 const events = [], records = []; let synced = false;
 const journal = { async writeFile(text) { records.push(JSON.parse(text)); synced = false; }, async sync() { synced = true; } };
 const upstream = async (method, params) => {
  events.push(method);
  if (method === 'simulateTransaction') {
   assert.equal(params[1].sigVerify, true); assert.equal(params[1].commitment, 'confirmed');
   await new Promise(resolve => setTimeout(resolve, 25));
   return { result: { context: { slot: 42 }, value: { err: behavior.simulationError ?? null } } };
  }
  if (method === 'getFeeForMessage') return { result: { value: behavior.fee ?? 5000 } };
  assert.equal(method, 'sendTransaction'); assert.equal(params[1].skipPreflight, false); assert.equal(params[1].maxRetries, 0); assert.equal(synced, true);
  assert.ok(records.at(-1).transactionSha256, 'Scope, fee and simulation evidence must be durable before sending.');
  const checked = await inspectDeploymentTransaction(params[0], review, binary, buffer);
  return { result: checked.signature };
 };
 return { submit: deploymentSubmissionHandler({ review: { ...review, limits }, binary, upstream, journal, initialBuffer: buffer }), events, records };
}
const params = (marker, blockhash = system) => [encoded([write()], payer, marker, blockhash), { encoding: 'base64', skipPreflight: true }];
test('concurrent writes complete simulation, fee check and send before the next write; retries deduplicate', async () => {
 const fake = fakeSubmission(), first = params(1);
 const results = await Promise.all([fake.submit(first), fake.submit(first), fake.submit(params(2))]);
 assert.deepEqual(results[0], results[1]);
 assert.deepEqual(fake.events, ['simulateTransaction', 'getFeeForMessage', 'sendTransaction', 'simulateTransaction', 'getFeeForMessage', 'sendTransaction']);
 assert.equal(fake.records.filter(row => row.transactionSha256).length, 2);
});
test('expired blockhash batches fail without sends or quota consumption, and preserve the CLI error shape', async () => {
 const fake = fakeSubmission({ maximumTransactions: 1 }, { simulationError: 'BlockhashNotFound' });
 const results = await Promise.allSettled([fake.submit(params(1)), fake.submit(params(2)), fake.submit(params(3))]);
 assert.ok(results.every(result => result.status === 'rejected' && result.reason.rpcError.data.err === 'BlockhashNotFound'));
 assert.deepEqual(fake.events, ['simulateTransaction']); assert.equal(fake.records.length, 0);
 // A fresh blockhash may proceed to simulation even after a whole failed batch.
 await assert.rejects(fake.submit(params(4, program))); assert.equal(fake.events.length, 2);
});
test('queued sends cannot exceed either transaction or cumulative fee caps', async () => {
 for (const limits of [{ maximumTransactions: 1 }, { totalNetworkFeeLamports: '5000' }]) {
  const fake = fakeSubmission(limits);
  const outcomes = await Promise.allSettled([fake.submit(params(1)), fake.submit(params(2))]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(fake.events.filter(method => method === 'sendTransaction').length, 1);
  assert.equal(fake.records.filter(row => row.transactionSha256).length, 1);
 }
});
test('non-expiry simulation failures and excessive individual fees never send', async () => {
 for (const behavior of [{ simulationError: { InstructionError: [0, 'InvalidArgument'] } }, { fee: 10001 }]) {
  const fake = fakeSubmission({}, behavior); await assert.rejects(fake.submit(params(1)));
  assert.ok(!fake.events.includes('sendTransaction')); assert.equal(fake.records.length, 0);
 }
});

 test('RPC proxy preserves exact u64 account fields for the deployment CLI', async () => {
 const {parseDeploymentRpc,serializeDeploymentRpc}=await import('../../scripts/devnet-deployment-guard.mjs');
 const raw='{"jsonrpc":"2.0","id":1,"result":{"value":{"rentEpoch":18446744073709551615,"lamports":60000000000}}}';
 const parsed=parseDeploymentRpc(raw);assert.equal(parsed.result.value.rentEpoch,18446744073709551615n);assert.equal(parsed.result.value.lamports,60000000000);assert.equal(serializeDeploymentRpc(parsed),raw);
 });

test('resume retains fee and transaction reservations and never repeats an unknown original submission', async () => {
 const checked=await inspectDeploymentTransaction(params(1)[0],review,binary,buffer);
 const row={...checked,feeLamports:5000};delete row.messageBase64;
 let calls=0;const submit=deploymentSubmissionHandler({review:{...review,limits:{maximumTransactions:1,networkFeePerTransactionLamports:'10000',totalNetworkFeeLamports:'10000'}},binary,initialBuffer:buffer,initialRecords:[row],upstream:async()=>{calls++;throw new Error('Unexpected RPC');},journal:{}});
 const original=await submit(params(1));assert.match(original.error.message,/reconciliation/);await assert.rejects(submit(params(2)),/transaction cap/);assert.equal(calls,0);
 assert.throws(()=>deploymentSubmissionHandler({review:{...review,limits:{maximumTransactions:3,networkFeePerTransactionLamports:'10000',totalNetworkFeeLamports:'4999'}},binary,initialBuffer:buffer,initialRecords:[row],upstream:async()=>{},journal:{}}),/exceeded review/);
});
