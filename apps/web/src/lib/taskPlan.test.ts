import assert from 'node:assert/strict';
import test from 'node:test';
import { PROGRAM_ADDRESS } from './agentOs';
import { assembleTaskResult, bindTaskPlanReceipt, createTaskPlan, matchesPlannedCheckpoint, planCommitment, readTaskPlans, saveTaskPlan, taskDigest, verifyTaskPlan, type TaskPlanTrace, type TaskPlanProgress } from './taskPlan';
import type { ChainTask } from './taskClient';
import type { TaskCheckpoint } from './taskJournal';

const recipient = '11111111111111111111111111111111';
const description = 'Research the supplied local evidence';
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, configurable: true });
async function task(): Promise<ChainTask> {
  return { address: PROGRAM_ADDRESS, agent: PROGRAM_ADDRESS, session: recipient, id: '1', taskHash: await taskDigest(description), status: 'running', resultHash: null, deadline: 5000, actionCount: '0', pendingEscrows: '0', pendingSkillResults: '0', sol: { maximum: '100000000', spent: '0', remaining: '100000000' }, usdc: { maximum: '1000000', spent: '0', remaining: '1000000' } };
}
const proposal = (patch: Partial<TaskPlanTrace> = {}): TaskPlanTrace => ({ id: 'step-1', kind: 'payment', status: 'complete', asset: 'SOL', amount: 0.01, recipient, ...patch });
function checkpoint(): TaskCheckpoint {
  return { version: 1, agent: PROGRAM_ADDRESS, taskId: '1', actionId: '9', execution: PROGRAM_ADDRESS, kind: 'payment', asset: 'SOL', amount: '10000000', inputHash: '01'.repeat(32), state: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), review: { program: PROGRAM_ADDRESS, feePayer: recipient, data: '', accounts: Array.from({ length: 7 }, (_, index) => ({ address: index === 4 ? recipient : index === 6 ? recipient : PROGRAM_ADDRESS, role: 0 })) } };
}

test('fixed plan uses exact amounts, description, target and a deterministic commitment', async () => {
  const plan = await createTaskPlan(await task(), description, [proposal()], 'devnet');
  assert.equal(plan.actions[0].amount, '10000000');
  await verifyTaskPlan(plan);
  assert.equal(plan.planHash, await taskDigest(planCommitment(plan)));
  await assert.rejects(verifyTaskPlan({ ...plan, actions: [{ ...plan.actions[0], target: PROGRAM_ADDRESS }] }));
  await assert.rejects(verifyTaskPlan({ ...plan, description: 'A different task description' }));
});

test('incomplete terms, blocked proposals, duplicate ids and overspending are rejected', async () => {
  const live = await task();
  for (const trace of [[proposal({ recipient: undefined })], [proposal({ status: 'blocked' })], [proposal({ amount: 0 })], [proposal({ amount: 0.0000000001 })], [proposal({ amount: 1 })], [proposal(), proposal()]]) await assert.rejects(createTaskPlan(live, description, trace, 'devnet'));
  await assert.rejects(createTaskPlan(live, description, [], 'devnet'));
  await assert.rejects(createTaskPlan({ ...live, actionCount: '1' }, description, [proposal()], 'devnet'));
});

test('receipt bindings match exact economic terms and cannot be reassigned or shared', async () => {
  storage.clear();
  const plan = await createTaskPlan(await task(), description, [proposal(), proposal({ id: 'step-2', asset: 'USDC', amount: 0.1 })], 'devnet');
  saveTaskPlan(plan);
  const item = checkpoint();
  assert.equal(matchesPlannedCheckpoint(plan, plan.actions[0], item), true);
  assert.equal(matchesPlannedCheckpoint(plan, plan.actions[0], { ...item, amount: '1' }), false);
  const bound = bindTaskPlanReceipt(plan, 'step-1', item);
  assert.equal(bound.planHash, plan.planHash);
  await verifyTaskPlan(bound);
  assert.throws(() => bindTaskPlanReceipt(bound, 'step-1', { ...item, actionId: '10' }));
  assert.throws(() => bindTaskPlanReceipt(bound, 'step-2', { ...item, asset: 'USDC', amount: '100000' }));
  assert.throws(() => saveTaskPlan({ ...bound, bindings: {} }));
  assert.throws(() => saveTaskPlan({ ...bound, actions: [{ ...bound.actions[0], amount: '1' }, bound.actions[1]] }));
});

test('Skill and Worker bindings require the original exact prompt and target', async () => {
  const plan = await createTaskPlan(await task(), description, [proposal({ kind: 'skill', skillId: PROGRAM_ADDRESS })], 'devnet');
  const item = checkpoint(); item.kind = 'skill';
  item.review!.accounts[6].address = PROGRAM_ADDRESS;
  item.skillRequest = { skillId: 'research', skill: PROGRAM_ADDRESS, provider: recipient, endpoint: 'http://127.0.0.1/research', prompt: description };
  assert.equal(matchesPlannedCheckpoint(plan, plan.actions[0], item), true);
  item.skillRequest.prompt = 'Another prompt'; assert.equal(matchesPlannedCheckpoint(plan, plan.actions[0], item), false);
  const workerPlan = await createTaskPlan(await task(), description, [proposal({ kind: 'escrow', workerAgent: recipient, durationHours: 1 })], 'devnet');
  const worker = checkpoint(); worker.kind = 'escrow'; worker.createdAt = '2026-10-09T00:00:00Z';
  worker.escrowTask = { address: PROGRAM_ADDRESS, workerAgent: recipient, id: '2', deadline: Date.parse(worker.createdAt) / 1000 + 3600, task: description };
  assert.equal(matchesPlannedCheckpoint(workerPlan, workerPlan.actions[0], worker), true);
  worker.escrowTask.deadline += 1; assert.equal(matchesPlannedCheckpoint(workerPlan, workerPlan.actions[0], worker), false);
});

test('plan store rejects foreign networks and duplicate Task entries', async () => {
  storage.clear(); const plan = await createTaskPlan(await task(), description, [proposal()], 'devnet'); saveTaskPlan(plan);
  assert.equal(readTaskPlans({ network: 'devnet', agent: PROGRAM_ADDRESS }).length, 1);
  const key = [...storage.keys()][0]; storage.set(key, JSON.stringify([plan, plan]));
  assert.throws(() => readTaskPlans({ network: 'devnet', agent: PROGRAM_ADDRESS }));
  storage.set(key, JSON.stringify([{ ...plan, network: 'mainnet' }]));
  assert.throws(() => readTaskPlans({ network: 'devnet', agent: PROGRAM_ADDRESS }));
});

test('final barrier requires every planned row and exact count and gross spending', async () => {
  const initial = await task(), plan = await createTaskPlan(initial, description, [proposal()], 'devnet');
  const live = { ...initial, actionCount: '1', sol: { maximum: '100000000', spent: '10000000', remaining: '90000000' } };
  const rows: TaskPlanProgress[] = [{ id: 'step-1', kind: 'payment', state: 'complete', detail: 'Verified', execution: PROGRAM_ADDRESS, signature: '2'.repeat(88) }];
  const result = await assembleTaskResult(plan, live, rows, false, 4000);
  assert.equal(result.ready, true);
  if (result.ready) assert.equal(result.resultHash, await taskDigest(result.artifact));
  assert.deepEqual(await assembleTaskResult(plan, live, [{ ...rows[0], roles: [{ role: 'Settlement', state: 'confirmed', detail: 'Display only' }] }], false, 4000), result);
  await assert.rejects(assembleTaskResult(plan, live, [], false, 4000));
  await assert.rejects(assembleTaskResult(plan, live, [{ ...rows[0], id: 'foreign' }], false, 4000));
  assert.equal((await assembleTaskResult(plan, { ...live, actionCount: '2' }, rows, false, 4000)).ready, false);
  assert.equal((await assembleTaskResult(plan, { ...live, sol: { ...live.sol, spent: '10000001' } }, rows, false, 4000)).ready, false);
  assert.equal((await assembleTaskResult(plan, live, rows, true, 4000)).ready, false);
});

test('waiting, failed-review, pause, expiry and pending results cannot produce a final artifact', async () => {
  const initial = await task(), plan = await createTaskPlan(initial, description, [proposal()], 'devnet');
  const live = { ...initial, actionCount: '1', sol: { maximum: '100000000', spent: '10000000', remaining: '90000000' } };
  const row: TaskPlanProgress = { id: 'step-1', kind: 'payment', state: 'complete', detail: '', execution: PROGRAM_ADDRESS, signature: '2'.repeat(88) };
  for (const state of ['planned', 'payment_unknown', 'waiting_skill', 'waiting_worker', 'waiting_judge', 'needs_review'] as const) assert.equal((await assembleTaskResult(plan, live, [{ ...row, state }], false, 4000)).ready, false);
  for (const snapshot of [{ ...live, status: 'paused' as const }, { ...live, status: 'completed' as const }, { ...live, pendingEscrows: '1' }, { ...live, pendingSkillResults: '1' }]) assert.equal((await assembleTaskResult(plan, snapshot, [row], false, 4000)).ready, false);
  assert.equal((await assembleTaskResult(plan, live, [row], false, 5000)).ready, false);
});

test('result assembly preserves exact Skill body and refuses missing or altered commitments', async () => {
  const initial = await task(), plan = await createTaskPlan(initial, description, [proposal({ kind: 'skill', skillId: PROGRAM_ADDRESS })], 'devnet');
  const live = { ...initial, actionCount: '1', sol: { maximum: '100000000', spent: '10000000', remaining: '90000000' } };
  const row: TaskPlanProgress = { id: 'step-1', kind: 'skill', state: 'complete', detail: '', execution: PROGRAM_ADDRESS, signature: '2'.repeat(88), content: 'Exact provider response', outputHash: await taskDigest('Exact provider response') };
  const result = await assembleTaskResult(plan, live, [row], false, 4000);
  assert.equal(result.ready, true);
  if (result.ready) assert.equal(JSON.parse(result.artifact).actions[0].content, row.content);
  await assert.rejects(assembleTaskResult(plan, live, [{ ...row, content: 'Changed provider response' }], false, 4000));
  await assert.rejects(assembleTaskResult(plan, live, [{ ...row, signature: undefined }], false, 4000));
});
