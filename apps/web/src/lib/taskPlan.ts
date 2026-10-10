import { address } from '@solana/kit';
import { PROGRAM_ADDRESS } from './agentOs';
import type { ChainTask } from './taskClient';
import type { TaskCheckpoint } from './taskJournal';

export type TaskPlanAction = { id: string; kind: 'payment' | 'skill' | 'escrow'; asset: 'SOL' | 'USDC'; amount: string; target: string; durationHours?: number };
export type TaskPlan = {
  version: 1; network: string; programId: string; agent: string; task: string; taskId: string;
  session: string; taskHash: string; description: string; actions: TaskPlanAction[];
  planHash: string; bindings: Record<string, string>;
};
export type TaskPlanTrace = { id: string; kind: string; status: string; asset?: 'SOL' | 'USDC'; amount?: number; recipient?: string; skillId?: string; workerAgent?: string; durationHours?: number };
export type TaskPlanProgress = { id: string; kind: string; state: 'planned' | 'payment_unknown' | 'waiting_skill' | 'waiting_worker' | 'waiting_judge' | 'needs_review' | 'complete'; detail: string; execution?: string; signature?: string; content?: string; outputHash?: string; escrow?: string; judgmentHash?: string; roles?: import('./taskRoleProgress').TaskRoleProgress[] };
export const taskDigest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const u64 = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value !== '0'.repeat(64);
const network = (value: string) => /^(devnet|localnet:[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(value);

export function planCommitment(plan: TaskPlan): string {
  return JSON.stringify({ version: 1, network: plan.network, programId: plan.programId, agent: plan.agent, task: plan.task, taskId: plan.taskId, session: plan.session, taskHash: plan.taskHash, description: plan.description, actions: plan.actions.map(action => ({ id: action.id, kind: action.kind, asset: action.asset, amount: action.amount, target: action.target, ...(action.kind === 'escrow' ? { durationHours: action.durationHours } : {}) })) });
}

export function validateTaskPlan(value: unknown): TaskPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid task plan.');
  const plan = value as TaskPlan;
  if (plan.version !== 1 || !network(plan.network) || plan.programId !== PROGRAM_ADDRESS || !u64(plan.taskId) || !hash(plan.taskHash) || !hash(plan.planHash) || typeof plan.description !== 'string' || plan.description !== plan.description.trim() || plan.description.length < 4 || plan.description.length > 800 || !Array.isArray(plan.actions) || !plan.actions.length || plan.actions.length > 6 || !plan.bindings || typeof plan.bindings !== 'object' || Array.isArray(plan.bindings)) throw new Error('Invalid task plan terms.');
  for (const key of [plan.agent, plan.task, plan.session]) address(key);
  const ids = new Set<string>();
  for (const action of plan.actions) {
    if (!action || typeof action.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(action.id) || ids.has(action.id) || ['__proto__', 'constructor', 'prototype'].includes(action.id) || !['payment', 'skill', 'escrow'].includes(action.kind) || !['SOL', 'USDC'].includes(action.asset) || !u64(action.amount) || action.amount === '0' || action.kind === 'escrow' && (!Number.isInteger(action.durationHours) || action.durationHours! < 1 || action.durationHours! > 720 || plan.description.length > 400) || action.kind !== 'escrow' && action.durationHours !== undefined) throw new Error('Invalid or duplicate planned action.');
    address(action.target); ids.add(action.id);
  }
  const bindings = Object.entries(plan.bindings);
  if (bindings.some(([id, actionId]) => !ids.has(id) || !u64(actionId)) || new Set(bindings.map(([, actionId]) => actionId)).size !== bindings.length) throw new Error('Invalid task plan receipt bindings.');
  return { version: 1, network: plan.network, programId: plan.programId, agent: plan.agent, task: plan.task, taskId: plan.taskId, session: plan.session, taskHash: plan.taskHash, description: plan.description, actions: plan.actions.map(action => ({ id: action.id, kind: action.kind, asset: action.asset, amount: action.amount, target: action.target, ...(action.kind === 'escrow' ? { durationHours: action.durationHours } : {}) })), planHash: plan.planHash, bindings: Object.fromEntries(bindings) };
}

export async function verifyTaskPlan(plan: TaskPlan) {
  validateTaskPlan(plan);
  if (await taskDigest(planCommitment(plan)) !== plan.planHash || await taskDigest(plan.description) !== plan.taskHash) throw new Error('Saved task plan differs from its commitments.');
}

/** Assemble only rows already verified by the chain evidence reader. */
export async function assembleTaskResult(plan: TaskPlan, task: ChainTask, rows: TaskPlanProgress[], unresolved: boolean, now = Math.floor(Date.now() / 1000)) {
  await verifyTaskPlan(plan);
  if (task.address !== plan.task || task.agent !== plan.agent || task.id !== plan.taskId || task.session !== plan.session || task.taskHash !== plan.taskHash || rows.length !== plan.actions.length || rows.some((row, index) => row.id !== plan.actions[index].id || row.kind !== plan.actions[index].kind)) throw new Error('Result rows or Task identity differ from the fixed plan.');
  const total = (asset: string) => plan.actions.filter(action => action.asset === asset).reduce((sum, action) => sum + BigInt(action.amount), 0n).toString();
  let reason = rows.find(row => row.state !== 'complete')?.detail ?? '';
  if (rows.some(row => row.state !== 'complete') && !reason) reason = 'A planned action has not completed.';
  if (unresolved) reason = 'An unresolved Task payment must be checked before completion.';
  else if (task.actionCount !== String(plan.actions.length) || task.sol.spent !== total('SOL') || task.usdc.spent !== total('USDC')) reason = 'Task action count or gross spending differs from the complete committed plan.';
  else if (task.pendingEscrows !== '0' || task.pendingSkillResults !== '0') reason = 'Task still has pending Escrows or Skill results.';
  else if (task.status !== 'running' || task.deadline <= now) reason = 'Task must be running and unexpired to finish automatically.';
  if (reason) return { ready: false as const, reason };
  for (const row of rows) {
    if (!row.execution || !row.signature || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(row.signature)) throw new Error('Completed action lacks its original payment evidence.');
    address(row.execution);
    if (row.kind !== 'payment' && (typeof row.content !== 'string' || !row.content.length || !hash(row.outputHash) || await taskDigest(row.content) !== row.outputHash)) throw new Error('Completed action lacks its exact result body and output commitment.');
    if (row.kind === 'escrow') { if (!row.escrow || !hash(row.judgmentHash)) throw new Error('Completed Worker action lacks its Judge evidence.'); address(row.escrow); }
  }
  const artifact = JSON.stringify({ format: 'agentos-task-result', version: 1, network: plan.network, programId: PROGRAM_ADDRESS, task: plan.task, agent: plan.agent, session: plan.session, taskHash: plan.taskHash, planHash: plan.planHash, description: plan.description, spentSol: task.sol.spent, spentUsdc: task.usdc.spent, actions: rows.map(row => ({ id: row.id, kind: row.kind, execution: row.execution, paymentSignature: row.signature, ...(row.content === undefined ? {} : { content: row.content, outputHash: row.outputHash }), ...(row.escrow ? { escrow: row.escrow, judgmentHash: row.judgmentHash } : {}) })) });
  if (new TextEncoder().encode(artifact).length > 450_000) throw new Error('Final Task artifact exceeds the recoverable storage limit.');
  return { ready: true as const, reason: 'All planned actions and committed results verified.', artifact, resultHash: await taskDigest(artifact) };
}

/** Match economic terms before attaching a real journal action to a plan step. */
export function matchesPlannedCheckpoint(plan: TaskPlan, action: TaskPlanAction, item: TaskCheckpoint): boolean {
  if (item.agent !== plan.agent || item.taskId !== plan.taskId || item.kind !== action.kind || item.asset !== action.asset || item.amount !== action.amount || !item.review || item.review.accounts[4]?.address !== plan.session) return false;
  const usdc = action.asset === 'USDC';
  if (action.kind === 'payment') return item.review.accounts[usdc ? 7 : 6]?.address === action.target;
  if (action.kind === 'skill') return item.skillRequest?.skill === action.target && item.skillRequest.prompt === plan.description && item.review.accounts[usdc ? 7 : 6]?.address === action.target;
  const escrow = item.escrowTask;
  return Boolean(escrow && escrow.workerAgent === action.target && escrow.task === plan.description && item.review.accounts[usdc ? 7 : 6]?.address === action.target && escrow.deadline <= Math.floor(Date.parse(item.createdAt) / 1000) + action.durationHours! * 3600);
}

export function bindTaskPlanReceipt(plan: TaskPlan, id: string, item: TaskCheckpoint): TaskPlan {
  const action = plan.actions.find(action => action.id === id);
  if (!action || !matchesPlannedCheckpoint(plan, action, item) || Object.entries(plan.bindings).some(([other, receipt]) => other !== id && receipt === item.actionId) || plan.bindings[id] && plan.bindings[id] !== item.actionId) throw new Error('The payment receipt differs from its planned action or is already bound.');
  const next = { ...plan, bindings: { ...plan.bindings, [id]: item.actionId } };
  saveTaskPlan(next);
  return next;
}

export async function createTaskPlan(task: ChainTask, description: string, trace: TaskPlanTrace[], networkIdentity: string): Promise<TaskPlan> {
  if (task.actionCount !== '0' || task.sol.spent !== '0' || task.usdc.spent !== '0' || task.pendingEscrows !== '0' || task.pendingSkillResults !== '0' || !['ready', 'running'].includes(task.status)) throw new Error('Prepare an automatic plan before the first Task payment. Existing unplanned actions require manual completion.');
  const actions: TaskPlanAction[] = trace.filter(item => ['payment', 'skill', 'escrow'].includes(item.kind)).map(item => {
    if (item.status !== 'complete' || !item.asset || item.amount === undefined || !Number.isFinite(item.amount) || item.amount <= 0) throw new Error('A blocked or incomplete proposal cannot enter an automatic plan.');
    const amount = String(item.amount), decimals = item.asset === 'SOL' ? 9 : 6;
    if (!new RegExp(`^[0-9]+(?:\\.[0-9]{1,${decimals}})?$`).test(amount)) throw new Error('Plan amounts must use exact supported decimal precision.');
    const [whole, fraction = ''] = amount.split('.');
    const target = item.kind === 'payment' ? item.recipient : item.kind === 'skill' ? item.skillId : item.workerAgent;
    if (!target) throw new Error('A planned action lacks its exact recipient, Skill or Worker.');
    return { id: item.id, kind: item.kind as TaskPlanAction['kind'], asset: item.asset, amount: (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'))).toString(), target, ...(item.kind === 'escrow' ? { durationHours: item.durationHours } : {}) };
  });
  const plan: TaskPlan = { version: 1, network: networkIdentity, programId: PROGRAM_ADDRESS, agent: task.agent, task: task.address, taskId: task.id, session: task.session, taskHash: task.taskHash, description: description.trim(), actions, planHash: '1'.repeat(64), bindings: {} };
  validateTaskPlan(plan);
  const total = (asset: string) => actions.filter(action => action.asset === asset).reduce((sum, action) => sum + BigInt(action.amount), 0n);
  if (total('SOL') > BigInt(task.sol.remaining) || total('USDC') > BigInt(task.usdc.remaining)) throw new Error('The entire plan exceeds its Task budget.');
  plan.planHash = await taskDigest(planCommitment(plan));
  await verifyTaskPlan(plan);
  return plan;
}

const storageKey = (scope: { network: string; agent: string }) => `agentos:task-plans:${scope.network}:${PROGRAM_ADDRESS}:${scope.agent}`;
export function readTaskPlans(scope: { network: string; agent: string }): TaskPlan[] {
  if (!network(scope.network)) throw new Error('Invalid task plan network.'); address(scope.agent);
  const text = localStorage.getItem(storageKey(scope)); if (!text) return [];
  if (text.length > 500_000) throw new Error('Task plans exceed their storage limit.');
  const values = JSON.parse(text);
  if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid task plan store.');
  const plans = values.map(validateTaskPlan);
  if (plans.some(plan => plan.agent !== scope.agent || plan.network !== scope.network) || new Set(plans.map(plan => plan.task)).size !== plans.length) throw new Error('Foreign or duplicate task plan.');
  return plans;
}
export function saveTaskPlan(plan: TaskPlan) {
  const saved = validateTaskPlan(plan), values = readTaskPlans(saved), index = values.findIndex(item => item.task === saved.task);
  if (index >= 0) {
    const previous = values[index];
    if (previous.planHash !== saved.planHash || planCommitment(previous) !== planCommitment(saved) || Object.entries(previous.bindings).some(([id, actionId]) => saved.bindings[id] !== actionId)) throw new Error('A saved plan or its existing receipt bindings cannot change.');
    values[index] = saved;
  } else values.push(saved);
  const text = JSON.stringify(values);
  if (values.length > 100 || text.length > 500_000) throw new Error('Task plan store is full; retain evidence before continuing.');
  localStorage.setItem(storageKey(saved), text);
  if (localStorage.getItem(storageKey(saved)) !== text) throw new Error('Task plan persistence failed.');
}
