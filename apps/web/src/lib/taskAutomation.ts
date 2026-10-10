import { NETWORK_STORAGE } from './chainNetwork';
import { PROGRAM_ADDRESS } from './agentOs';
import { address } from '@solana/kit';
import type { TaskPlan } from './taskPlan';

export type TaskAutomationSetting = { task: string; session: string; planHash: string; expiresAt: number; enabled: boolean; dispatch?: { step: string; knownActionIds: string[] } };
const key = (agent: string) => `agentos:task-automation:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${agent}`;
export function readTaskAutomations(agent: string): TaskAutomationSetting[] {
  address(agent); const text = localStorage.getItem(key(agent));
  if (!text) return [];
  if (text.length > 50000) throw new Error('Task automation settings exceed their storage limit.');
  const values: unknown = JSON.parse(text);
  if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid Task automation settings.');
  const ids = new Set<string>();
  return values.map((item: TaskAutomationSetting) => {
    if (!item || !/^[a-f0-9]{64}$/.test(item.planHash) || !Number.isSafeInteger(item.expiresAt) || item.expiresAt <= 0 || typeof item.enabled !== 'boolean' || ids.has(item.task)) throw new Error('Invalid or duplicate Task automation setting.');
    address(item.task); address(item.session); ids.add(item.task);
    if (item.dispatch && (typeof item.dispatch.step !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.dispatch.step) || !Array.isArray(item.dispatch.knownActionIds) || item.dispatch.knownActionIds.length > 500 || new Set(item.dispatch.knownActionIds).size !== item.dispatch.knownActionIds.length || item.dispatch.knownActionIds.some(id => !/^(0|[1-9][0-9]{0,19})$/.test(id) || BigInt(id) > 18446744073709551615n))) throw new Error('Invalid pending Task dispatch.');
    return { task: item.task, session: item.session, planHash: item.planHash, expiresAt: item.expiresAt, enabled: item.enabled, ...(item.dispatch ? { dispatch: { step: item.dispatch.step, knownActionIds: [...item.dispatch.knownActionIds] } } : {}) };
  });
}
function save(agent: string, values: TaskAutomationSetting[]) {
  const text = JSON.stringify(values);
  if (values.length > 100 || text.length > 50000) throw new Error('Task automation settings are full.');
  localStorage.setItem(key(agent), text);
  if (localStorage.getItem(key(agent)) !== text) throw new Error('Could not persist the explicit Task automation choice.');
}
/** Call only after explicit review; importing evidence never calls this function. */
export function setTaskAutomation(plan: TaskPlan, expiresAt: number, enabled: boolean) {
  const values = readTaskAutomations(plan.agent), previous = values.find(item => item.task === plan.task);
  if (previous && (previous.session !== plan.session || previous.planHash !== plan.planHash)) throw new Error('Task automation cannot change its fixed plan or Session.');
  save(plan.agent, [...values.filter(item => item.task !== plan.task), { ...previous, task: plan.task, session: plan.session, planHash: plan.planHash, expiresAt, enabled }]);
}
export function assertTaskAutomation(plan: TaskPlan, now = Math.floor(Date.now() / 1000)) {
  const setting = readTaskAutomations(plan.agent).find(item => item.task === plan.task);
  if (!setting?.enabled || setting.session !== plan.session || setting.planHash !== plan.planHash || setting.expiresAt <= now) throw new Error('The fixed Task plan is paused, expired or has not been explicitly enabled.');
  return setting;
}
export function beginTaskDispatch(plan: TaskPlan, step: string, knownActionIds: string[]) {
  const setting = assertTaskAutomation(plan);
  if (setting.dispatch || !plan.actions.some(action => action.id === step)) throw new Error('A Task step is already dispatching or is outside the fixed plan.');
  save(plan.agent, readTaskAutomations(plan.agent).map(item => item.task === plan.task ? { ...item, dispatch: { step, knownActionIds } } : item));
  readTaskAutomations(plan.agent); // Validate and read back before any payment.
}
export function finishTaskDispatch(plan: TaskPlan, step: string) {
  const values = readTaskAutomations(plan.agent), setting = values.find(item => item.task === plan.task);
  if (setting?.dispatch?.step !== step || !plan.bindings[step]) throw new Error('The pending Task step has no durably bound payment checkpoint.');
  save(plan.agent, values.map(item => {
    if (item.task !== plan.task) return item;
    const { dispatch: _dispatch, ...rest } = item; return rest;
  }));
}
