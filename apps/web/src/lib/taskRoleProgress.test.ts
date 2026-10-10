import assert from 'node:assert/strict';
import test from 'node:test';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { PROGRAM_ADDRESS } from './agentOs';
import type { JudgeSnapshot } from './judgeClient';
import { decodeWorkerPermitProgress, describeTaskRoles } from './taskRoleProgress';

const owner = '11111111111111111111111111111111';
const snapshot: JudgeSnapshot = { escrow: PROGRAM_ADDRESS, employer: owner, worker: PROGRAM_ADDRESS, employerOwner: owner, workerOwner: owner, amount: '10000000', asset: 'SOL', deadline: 5000, funded: true, status: 'funded', taskHash: '01'.repeat(32), resultHash: null, mandate: null, decision: null };
const permit = { session: owner, expiresAt: 4500, revoked: false, used: false };

test('missing role grants identify exact preparations without claiming browser readiness', () => {
  const rows = describeTaskRoles(snapshot, null, 4000);
  assert.equal(rows[0].state, 'needs authorization');
  assert.equal(rows[1].state, 'needs proposal');
  assert.equal(rows[2].state, 'waiting for delivery');
  assert.equal(rows[3].state, 'pending');
  const granted = describeTaskRoles(snapshot, permit, 4000);
  assert.equal(granted[0].state, 'permit recorded');
  assert.match(granted[0].detail, /browser auto opt-in/);
  for (const patch of [{ revoked: true }, { used: true }, { expiresAt: 4000 }]) assert.equal(describeTaskRoles(snapshot, { ...permit, ...patch }, 4000)[0].state, 'permit unavailable');
});

test('appointment distinguishes Worker acceptance, decline and expiry', () => {
  const mandate = { address: PROGRAM_ADDRESS, employer: owner, worker: PROGRAM_ADDRESS, judge: PROGRAM_ADDRESS, session: owner, taskHash: snapshot.taskHash, expiresAt: 4500, acceptedAt: 0, accepted: false, declined: false, used: false };
  assert.equal(describeTaskRoles({ ...snapshot, mandate }, permit, 4000)[1].state, 'awaiting Worker acceptance');
  assert.equal(describeTaskRoles({ ...snapshot, mandate: { ...mandate, declined: true } }, permit, 4000)[1].state, 'declined');
  assert.equal(describeTaskRoles({ ...snapshot, mandate: { ...mandate, accepted: true } }, permit, 4000)[1].state, 'accepted');
  assert.equal(describeTaskRoles({ ...snapshot, mandate: { ...mandate, accepted: true } }, permit, 4500)[1].state, 'expired');
});

test('delivery and settled outcomes display chain observations rather than automatic execution claims', () => {
  const decision = { address: PROGRAM_ADDRESS, judge: PROGRAM_ADDRESS, session: owner, taskHash: snapshot.taskHash, resultHash: '02'.repeat(32), judgmentHash: '03'.repeat(32), verdict: 'pass' as const, recordedAt: 4000, settled: true };
  const rows = describeTaskRoles({ ...snapshot, status: 'released', funded: false, resultHash: decision.resultHash, decision }, { ...permit, used: true }, 6000);
  assert.equal(rows[0].state, 'delivered');
  assert.match(rows[0].detail, /does not establish/);
  assert.equal(rows[2].state, 'pass');
  assert.equal(rows[3].state, 'confirmed');
  assert.equal(describeTaskRoles({ ...snapshot, status: 'refunded', funded: false }, null, 6000)[0].state, 'closed');
});

test('Worker permit decoder rejects changed bindings, flags, deadlines and canonical PDA', async () => {
  const data = new Uint8Array(115), encoder = getAddressEncoder();
  data.set(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account:WorkerDeliveryPermit'))).slice(0, 8));
  data.set(encoder.encode(address(snapshot.escrow)), 8); data.set(encoder.encode(address(snapshot.worker)), 40); data.set(encoder.encode(address(owner)), 72);
  new DataView(data.buffer).setBigInt64(104, 4500n, true);
  const [key, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('worker_delivery'), data.slice(8, 40)] }); data[114] = bump;
  assert.deepEqual(await decodeWorkerPermitProgress(key, data, snapshot), permit);
  await assert.rejects(decodeWorkerPermitProgress(owner, data, snapshot));
  await assert.rejects(decodeWorkerPermitProgress(key, data, { ...snapshot, worker: owner }));
  await assert.rejects(decodeWorkerPermitProgress(key, data, { ...snapshot, escrow: owner }));
  await assert.rejects(decodeWorkerPermitProgress(key, data.slice(0, 114), snapshot));
  for (const offset of [112, 113, 114]) { const bad = data.slice(); bad[offset] = offset === 114 ? (bump + 1) % 256 : 2; await assert.rejects(decodeWorkerPermitProgress(key, bad, snapshot)); }
  const late = data.slice(); new DataView(late.buffer).setBigInt64(104, 5001n, true); await assert.rejects(decodeWorkerPermitProgress(key, late, snapshot));
});
