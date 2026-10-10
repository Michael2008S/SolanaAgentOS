import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChainTask } from './taskClient';
import { assertTaskEvidenceSnapshot, TaskEvidenceChanged } from './taskEvidenceSnapshot';
const initial = (): ChainTask => ({ address: 'task', agent: 'agent', id: '1', session: 'session', taskHash: 'hash', deadline: 5000, status: 'running', resultHash: null, actionCount: '1', pendingEscrows: '1', pendingSkillResults: '0', sol: { maximum: '100', spent: '10', remaining: '90' }, usdc: { maximum: '100', spent: '0', remaining: '100' } });
test('Judge settlement during evidence reads requests a fresh snapshot, then accepts consistent observation', () => {
  const before = initial(), after = { ...before, pendingEscrows: '0' };
  assert.throws(() => assertTaskEvidenceSnapshot(before, after), TaskEvidenceChanged);
  assert.doesNotThrow(() => assertTaskEvidenceSnapshot(after, after));
});
test('Skill registration, spending and completion changes cannot use a stale final snapshot', () => {
  const before = initial();
  const changed: ChainTask[] = [
    { ...before, pendingSkillResults: '1' }, { ...before, actionCount: '2' },
    { ...before, sol: { ...before.sol, spent: '20', remaining: '80' } },
    { ...before, usdc: { ...before.usdc, spent: '10', remaining: '90' } },
    { ...before, status: 'paused' }, { ...before, status: 'completed', resultHash: 'result', pendingEscrows: '0' },
  ];
  for (const observation of changed) assert.throws(() => assertTaskEvidenceSnapshot(before, observation), TaskEvidenceChanged);
});
test('foreign identity, replaced Session and changed fixed terms require review rather than a soft retry', () => {
  const before = initial();
  const changed: ChainTask[] = ['address', 'agent', 'id', 'session', 'taskHash'].map(key => ({ ...before, [key]: 'different' }));
  changed.push({ ...before, deadline: 6000 }, { ...before, sol: { ...before.sol, maximum: '200' } }, { ...before, usdc: { ...before.usdc, maximum: '200' } });
  for (const observation of changed) assert.throws(() => assertTaskEvidenceSnapshot(before, observation), error => error instanceof Error && !(error instanceof TaskEvidenceChanged));
});
