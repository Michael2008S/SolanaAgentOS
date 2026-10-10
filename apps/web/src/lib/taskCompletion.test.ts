import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRole, address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { PROGRAM_ADDRESS, buildGrantTaskCompletion, buildRevokeTaskCompletion, deriveTaskAddress, deriveTaskCompletionAddress } from './agentOs';
import { decodeTaskCompletion, type ChainTask } from './taskClient';

const owner = address('11111111111111111111111111111111');
const agent = PROGRAM_ADDRESS;
const session = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

test('completion grant commits exact plan, count and deadline and revoke has Owner signer', async () => {
  const grant = await buildGrantTaskCompletion(owner, agent, session, 7n, new Uint8Array(32).fill(9), 3n, 1000n);
  assert.equal(grant.task, await deriveTaskAddress(agent, 7n));
  assert.equal(grant.permit, await deriveTaskCompletionAddress(grant.task));
  assert.equal(grant.instruction.accounts[0].role, AccountRole.WRITABLE_SIGNER);
  assert.equal(grant.instruction.data.length, 57);
  const data = new DataView(grant.instruction.data.buffer, grant.instruction.data.byteOffset);
  assert.equal(data.getBigUint64(40, true), 3n);
  assert.equal(data.getBigInt64(48, true), 1000n);
  const revoke = await buildRevokeTaskCompletion(owner, agent, 7n);
  assert.equal(revoke.permit, grant.permit);
  assert.equal(revoke.instruction.accounts[0].role, AccountRole.READONLY_SIGNER);
  await assert.rejects(buildGrantTaskCompletion(owner, agent, session, 7n, new Uint8Array(32), 3n, 1000n));
  await assert.rejects(buildGrantTaskCompletion(owner, agent, session, 7n, new Uint8Array(32).fill(9), 0n, 1000n));
});

test('permit decoder rejects noncanonical, malformed and foreign task accounts', async () => {
  const taskAddress = await deriveTaskAddress(agent, 7n);
  const [permit, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('task_completion'), getAddressEncoder().encode(taskAddress)] });
  const task: ChainTask = { address: taskAddress, agent, session, id: '7', taskHash: '01'.repeat(32), status: 'running', resultHash: null, deadline: 1100, actionCount: '3', pendingEscrows: '0', pendingSkillResults: '0', sol: { maximum: '10', spent: '1', remaining: '9' }, usdc: { maximum: '10', spent: '1', remaining: '9' } };
  const bytes = new Uint8Array(155), view = new DataView(bytes.buffer), encoder = getAddressEncoder();
  bytes.set(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account:TaskCompletionPermit'))).slice(0, 8));
  bytes.set(encoder.encode(taskAddress), 8); bytes.set(encoder.encode(agent), 40); bytes.set(encoder.encode(session), 72);
  bytes.fill(9, 104, 136); view.setBigUint64(136, 3n, true); view.setBigInt64(144, 1000n, true); bytes[154] = bump;
  assert.equal((await decodeTaskCompletion(permit, bytes, task)).expectedActions, '3');
  await assert.rejects(decodeTaskCompletion(owner, bytes, task));
  await assert.rejects(decodeTaskCompletion(permit, bytes.slice(0, 154), task));
  await assert.rejects(decodeTaskCompletion(permit, bytes, { ...task, agent: owner }));
  bytes[152] = 2; await assert.rejects(decodeTaskCompletion(permit, bytes, task)); bytes[152] = 0;
  view.setBigUint64(136, 0n, true); await assert.rejects(decodeTaskCompletion(permit, bytes, task));
});
