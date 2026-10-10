import assert from 'node:assert/strict';
import test from 'node:test';
import { address, getBase58Decoder } from '@solana/kit';
import { DEVNET_GENESIS } from '../../../../shared/chain-network';
import { buildGrantTaskCompletion, deriveTaskAddress, PROGRAM_ADDRESS } from './agentOs';
import { createTaskPlan, saveTaskPlan, taskDigest } from './taskPlan';
import { readTaskAutomations, setTaskAutomation, beginTaskDispatch, finishTaskDispatch } from './taskAutomation';
import { assertCompletionPermit, discardTaskCompletion, exportTaskCompletionJournal, importTaskCompletionJournal, readTaskCompletionJournal, reconcileTaskCompletion, sendTaskCompletion, validateTaskCompletionJournal, type TaskCompletionAttempt } from './taskCompletionJournal';
import type { ChainTask, TaskCompletionAuthorization } from './taskClient';
import type { AppClient } from '../providers';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { locks: { request: async (_key: string, run: () => unknown) => run() } }, configurable: true });
const owner = address('11111111111111111111111111111111');
const description = 'Execute the supplied fixed local test';
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(7));
async function fixture() {
  const task: ChainTask = { address: await deriveTaskAddress(PROGRAM_ADDRESS, 1n), agent: PROGRAM_ADDRESS, session: owner, id: '1', taskHash: await taskDigest(description), status: 'running', resultHash: null, deadline: Math.floor(Date.now() / 1000) + 1000, actionCount: '0', pendingEscrows: '0', pendingSkillResults: '0', sol: { maximum: '100000000', spent: '0', remaining: '100000000' }, usdc: { maximum: '1000000', spent: '0', remaining: '1000000' } };
  const plan = await createTaskPlan(task, description, [{ id: 'step-1', kind: 'payment', status: 'complete', asset: 'SOL', amount: 0.01, recipient: owner }], 'devnet');
  const instruction = (await buildGrantTaskCompletion(owner, PROGRAM_ADDRESS, owner, 1n, Uint8Array.from(plan.planHash.match(/../g)!, byte => parseInt(byte, 16)), 1n, BigInt(task.deadline), false)).instruction;
  const item: TaskCompletionAttempt = { version: 1, id: crypto.randomUUID(), action: 'grant', plan, owner, signer: owner, feePayer: owner, expiresAt: task.deadline, startTask: false, spentSol: '0', spentUsdc: '0', instruction: { program: PROGRAM_ADDRESS, data: [...instruction.data].map(byte => byte.toString(16).padStart(2, '0')).join(''), accounts: instruction.accounts.map(account => ({ address: account.address, role: account.role })) }, state: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  return { task, plan, instruction, item };
}
const backup = (records: TaskCompletionAttempt[]) => JSON.stringify({ format: 'agentos-task-completion', version: 1, network: 'devnet', programId: PROGRAM_ADDRESS, agent: PROGRAM_ADDRESS, records });

test('imported signed confirmation becomes unknown and never enables automation', async () => {
  storage.clear(); const { item } = await fixture();
  await importTaskCompletionJournal(PROGRAM_ADDRESS, backup([{ ...item, state: 'confirmed', signature, lastValidBlockHeight: '100' }]));
  assert.equal(readTaskCompletionJournal(PROGRAM_ADDRESS)[0].state, 'unknown');
  assert.deepEqual(readTaskAutomations(PROGRAM_ADDRESS), []);
  assert.equal(JSON.parse(exportTaskCompletionJournal(PROGRAM_ADDRESS)).records[0].signature, signature);
});

test('signed attempts cannot be discarded, resent or assigned another signature', async () => {
  storage.clear(); const { item, instruction } = await fixture();
  await importTaskCompletionJournal(PROGRAM_ADDRESS, backup([{ ...item, state: 'signed', signature, lastValidBlockHeight: '100' }]));
  const checkpoint = { agent: PROGRAM_ADDRESS, id: item.id };
  await assert.rejects(discardTaskCompletion(checkpoint));
  await assert.rejects(sendTaskCompletion({} as AppClient, instruction, checkpoint));
  await assert.rejects(importTaskCompletionJournal(PROGRAM_ADDRESS, backup([{ ...item, state: 'signed', signature: getBase58Decoder().decode(new Uint8Array(64).fill(8)), lastValidBlockHeight: '100' }])));
});

test('unsigned discard is final and cannot absorb a later imported signature', async () => {
  storage.clear(); const { item } = await fixture(); await importTaskCompletionJournal(PROGRAM_ADDRESS, backup([item]));
  await discardTaskCompletion({ agent: PROGRAM_ADDRESS, id: item.id });
  assert.equal(readTaskCompletionJournal(PROGRAM_ADDRESS)[0].state, 'cancelled');
  await assert.rejects(importTaskCompletionJournal(PROGRAM_ADDRESS, backup([{ ...item, state: 'signed', signature, lastValidBlockHeight: '100' }])));
});

test('altered exact instruction, plan and foreign network backups are rejected', async () => {
  storage.clear(); const { item } = await fixture();
  await assert.rejects(importTaskCompletionJournal(PROGRAM_ADDRESS, backup([{ ...item, instruction: { ...item.instruction, data: '00'.repeat(item.instruction.data.length / 2) } }])));
  await assert.rejects(importTaskCompletionJournal(PROGRAM_ADDRESS, backup([{ ...item, plan: { ...item.plan, description: 'Altered description' } }])));
  await assert.rejects(importTaskCompletionJournal(PROGRAM_ADDRESS, backup([item]).replace('"network":"devnet"', '"network":"mainnet"')));
  assert.throws(() => validateTaskCompletionJournal([{ ...item, state: 'signed' }], PROGRAM_ADDRESS));
});

test('missing original signature remains unknown without any signing or sending', async () => {
  storage.clear(); const { item } = await fixture();
  await importTaskCompletionJournal(PROGRAM_ADDRESS, backup([{ ...item, state: 'signed', signature, lastValidBlockHeight: '100' }]));
  let queries = 0;
  const client = { rpc: { getGenesisHash: () => ({ send: async () => DEVNET_GENESIS }), getSignatureStatuses: () => ({ send: async () => { queries++; return { value: [null] }; } }) } } as unknown as AppClient;
  await assert.rejects(reconcileTaskCompletion(client, { agent: PROGRAM_ADDRESS, id: item.id }));
  assert.equal(queries, 1); assert.equal(readTaskCompletionJournal(PROGRAM_ADDRESS)[0].state, 'unknown');
});

test('historical grant confirms from its exact original transaction without requiring current Task Session', async () => {
  storage.clear(); const { item, instruction } = await fixture();
  await importTaskCompletionJournal(PROGRAM_ADDRESS, backup([{ ...item, state: 'signed', signature, lastValidBlockHeight: '100' }]));
  const keys = [owner, ...item.instruction.accounts.map(account => account.address).filter(key => key !== owner), PROGRAM_ADDRESS];
  const client = { rpc: {
    getGenesisHash: () => ({ send: async () => DEVNET_GENESIS }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'finalized', err: null }] }) }),
    getTransaction: () => ({ send: async () => ({ meta: { err: null }, transaction: { signatures: [signature], message: { accountKeys: keys, header: { numRequiredSignatures: 1 }, instructions: [{ programIdIndex: keys.indexOf(PROGRAM_ADDRESS), data: getBase58Decoder().decode(new Uint8Array(instruction.data)), accounts: item.instruction.accounts.map(account => keys.indexOf(account.address)) }] } } }) }),
    getAccountInfo: () => { throw new Error('Mutable Task state cannot be used to reject a historical grant.'); },
  } } as unknown as AppClient;
  await reconcileTaskCompletion(client, { agent: PROGRAM_ADDRESS, id: item.id });
  assert.equal(readTaskCompletionJournal(PROGRAM_ADDRESS)[0].state, 'confirmed');
  assert.deepEqual(readTaskAutomations(PROGRAM_ADDRESS), []);
});

test('foreign genesis cannot confirm an imported original signature', async () => {
  storage.clear(); const { item } = await fixture();
  await importTaskCompletionJournal(PROGRAM_ADDRESS, backup([{ ...item, state: 'signed', signature, lastValidBlockHeight: '100' }]));
  const client = { rpc: { getGenesisHash: () => ({ send: async () => owner }), getSignatureStatuses: () => { throw new Error('Wrong network must stop before transaction lookup.'); } } } as unknown as AppClient;
  await assert.rejects(reconcileTaskCompletion(client, { agent: PROGRAM_ADDRESS, id: item.id }), /genesis/);
  assert.equal(readTaskCompletionJournal(PROGRAM_ADDRESS)[0].state, 'unknown');
});

test('permit checks enforce scope, revocation, usage, action count, pause and expiry', async () => {
  const { task, plan } = await fixture();
  const permit: TaskCompletionAuthorization = { address: PROGRAM_ADDRESS, task: task.address, agent: plan.agent, session: plan.session, planHash: plan.planHash, expectedActions: '1', expiresAt: task.deadline, revoked: false, used: false };
  assertCompletionPermit(plan, task, permit);
  for (const patch of [{ session: PROGRAM_ADDRESS }, { planHash: '01'.repeat(32) }, { expectedActions: '2' }, { revoked: true }, { used: true }, { expiresAt: 1 }, { task: PROGRAM_ADDRESS }]) assert.throws(() => assertCompletionPermit(plan, task, { ...permit, ...patch }));
  assert.throws(() => assertCompletionPermit(plan, { ...task, status: 'paused' }, permit));
});

test('dispatch is durably stored before payment and requires a bound receipt to end', async () => {
  storage.clear(); const { plan, task } = await fixture(); saveTaskPlan(plan); setTaskAutomation(plan, task.deadline, true);
  beginTaskDispatch(plan, 'step-1', ['3']);
  assert.equal(readTaskAutomations(PROGRAM_ADDRESS)[0].dispatch?.step, 'step-1');
  assert.throws(() => beginTaskDispatch(plan, 'step-1', []));
  assert.throws(() => finishTaskDispatch(plan, 'step-1'));
  finishTaskDispatch({ ...plan, bindings: { 'step-1': '9' } }, 'step-1');
  assert.equal(readTaskAutomations(PROGRAM_ADDRESS)[0].dispatch, undefined);
  setTaskAutomation(plan, task.deadline, false);
  assert.throws(() => beginTaskDispatch(plan, 'step-1', []));
});
