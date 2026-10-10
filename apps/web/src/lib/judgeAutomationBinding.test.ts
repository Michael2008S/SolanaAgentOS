import test from 'node:test';
import assert from 'node:assert/strict';
import { assertJudgeAutomationBinding, assertJudgeTerminalOutcome, type JudgeAutomationBinding, type JudgeAutomationSnapshot } from './judgeAutomationBinding';
const plan: JudgeAutomationBinding = { judge: 'judge', session: 'session', expiresAt: 200, employer: 'employer', worker: 'worker', amount: '10000000', asset: 'SOL', taskHash: 'task', resultHash: null };
const live: JudgeAutomationSnapshot = { ...plan, deadline: 250, mandate: { accepted: true, declined: false, judge: plan.judge, session: plan.session, expiresAt: plan.expiresAt } };
test('preauthorized Judge can wait and observe the first committed result', () => {
  assert.doesNotThrow(() => assertJudgeAutomationBinding(plan, live, 100));
  assert.doesNotThrow(() => assertJudgeAutomationBinding(plan, { ...live, resultHash: 'first' }, 100));
});
test('bound result cannot be replaced or removed', () => {
  const bound = { ...plan, resultHash: 'first' };
  assert.doesNotThrow(() => assertJudgeAutomationBinding(bound, { ...live, resultHash: 'first' }, 100));
  for (const resultHash of [null, 'second']) assert.throws(() => assertJudgeAutomationBinding(bound, { ...live, resultHash }, 100));
});
test('waiting never permits changed economics or participants', () => {
  for (const patch of [{ amount: '1' }, { asset: 'USDC' as const }, { employer: 'other' }, { worker: 'other' }, { taskHash: 'other' }]) assert.throws(() => assertJudgeAutomationBinding(plan, { ...live, ...patch }, 100));
});
test('mandate and deadlines remain enforced while waiting', () => {
  for (const patch of [{ accepted: false }, { declined: true }, { judge: 'other' }, { session: 'other' }, { expiresAt: 201 }]) assert.throws(() => assertJudgeAutomationBinding(plan, { ...live, mandate: { ...live.mandate!, ...patch } }, 100));
  assert.throws(() => assertJudgeAutomationBinding(plan, { ...live, mandate: null }, 100));
  assert.throws(() => assertJudgeAutomationBinding(plan, live, 200));
  assert.throws(() => assertJudgeAutomationBinding(plan, { ...live, deadline: 100 }, 100));
});
test('terminal observation can finish after expiry but never authorizes open work', () => {
  assert.doesNotThrow(() => assertJudgeTerminalOutcome(plan, { ...live, funded: false }));
  assert.doesNotThrow(() => assertJudgeTerminalOutcome(plan, { ...live, funded: false, decision: { settled: true } }));
  assert.throws(() => assertJudgeTerminalOutcome(plan, { ...live, funded: true, decision: { settled: false } }));
  assert.throws(() => assertJudgeTerminalOutcome(plan, { ...live, funded: false, amount: '1' }));
  assert.throws(() => assertJudgeTerminalOutcome({ ...plan, resultHash: 'first' }, { ...live, funded: false, resultHash: 'second' }));
  assert.throws(() => assertJudgeAutomationBinding(plan, live, 201));
});
