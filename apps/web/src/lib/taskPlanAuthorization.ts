import type { AppClient } from '../providers';
import type { TaskCheckpoint } from './taskJournal';
import { NETWORK_STORAGE } from './chainNetwork';
import { matchesPlannedCheckpoint, readTaskPlans, verifyTaskPlan } from './taskPlan';
import { assertTaskAutomation } from './taskAutomation';
import { assertCompletionPermit, loadTaskCompletionState } from './taskCompletionJournal';

/** Legacy manual Tasks remain supported; fixed plans require their exact capability. */
export async function assertPlannedTaskAction(client: AppClient, item: TaskCheckpoint, resultOnly = false) {
  const plan = readTaskPlans({ network: NETWORK_STORAGE, agent: item.agent }).find(plan => plan.taskId === item.taskId);
  if (!plan) return;
  await verifyTaskPlan(plan);
  const setting = assertTaskAutomation(plan);
  const action = resultOnly
    ? plan.actions.find(action => plan.bindings[action.id] === item.actionId || setting.dispatch?.step === action.id && !setting.dispatch.knownActionIds.includes(item.actionId))
    : plan.actions.find(action => setting.dispatch?.step === action.id && !setting.dispatch.knownActionIds.includes(item.actionId));
  if (!action || resultOnly && action.kind !== 'skill' || !matchesPlannedCheckpoint(plan, action, item)) throw new Error('Task action differs from its fixed plan or pending dispatch; it was not authorized.');
  const live = await loadTaskCompletionState(client, plan);
  assertCompletionPermit(plan, live.task, live.permit);
}
