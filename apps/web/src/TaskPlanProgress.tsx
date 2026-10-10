/** @jsxImportSource ./i18n */
import { displayLocale } from './i18n/locale';
import { useEffect, useState } from 'react';
import type { AppClient } from './providers';
import { NETWORK_STORAGE } from './lib/chainNetwork';
import { decodeChainTask, type ChainTask } from './lib/taskClient';
import { bindTaskPlanReceipt, matchesPlannedCheckpoint, readTaskPlans, saveTaskPlan, validateTaskPlan, verifyTaskPlan, type TaskPlan } from './lib/taskPlan';
import { inspectTaskPlan, type TaskPlanEvidence } from './lib/taskPlanEvidence';
import { readTaskJournal } from './lib/taskJournal';
import { readTaskAutomations, type TaskAutomationSetting } from './lib/taskAutomation';
import { discardTaskCompletion, exportTaskCompletionJournal, importTaskCompletionJournal, loadTaskCompletionState, readTaskCompletionJournal, reconcileTaskCompletion, type TaskCompletionAttempt } from './lib/taskCompletionJournal';
import { taskDigest } from './lib/taskPlan';

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TaskPlanProgress({ client, task, revision, readTask, authorize, transactionBusy, orchestrationStatus }: { client: AppClient; task: ChainTask; revision: number; readTask: () => Promise<Uint8Array>; authorize: (plan: TaskPlan, mode: 'grant' | 'revoke' | 'resume' | 'pause') => Promise<void>; transactionBusy: boolean; orchestrationStatus: string }) {
  const [plan, setPlan] = useState<TaskPlan | null>(null), [evidence, setEvidence] = useState<TaskPlanEvidence | null>(null);
  const [message, setMessage] = useState(''), [working, setWorking] = useState(false), [refresh, setRefresh] = useState(0);
  const [setting, setSetting] = useState<TaskAutomationSetting | null>(null), [attempts, setAttempts] = useState<TaskCompletionAttempt[]>([]);
  const [permit, setPermit] = useState<Awaited<ReturnType<typeof loadTaskCompletionState>>['permit']>(null);
  const [completedArtifact, setCompletedArtifact] = useState<string | null>(null);
  useEffect(() => {
    let active = true, running = false;
    async function tick() {
      if (running) return; running = true;
      try {
        const saved = readTaskPlans({ network: NETWORK_STORAGE, agent: task.agent }).find(plan => plan.task === task.address) ?? null;
        if (active) setPlan(saved);
        if (!saved) return;
        const journal = readTaskCompletionJournal(task.agent).filter(item => item.plan.task === task.address);
        // Keep historical attempts recoverable even after a Task changes Session.
        if (active) setAttempts(journal);
        const state = await loadTaskCompletionState(client, saved);
        if (active) { setAttempts(journal); setPermit(state.permit); setSetting(readTaskAutomations(task.agent).find(item => item.task === task.address) ?? null); }
        const live = await decodeChainTask(task.address, await readTask(), task.agent);
        const completed = journal.find(item => item.action === 'complete' && item.state === 'confirmed' && item.resultHash === live.resultHash && item.plan.planHash === saved.planHash);
        if (live.status === 'completed' && completed?.artifact && await taskDigest(completed.artifact) === live.resultHash) {
          if (active) { setCompletedArtifact(completed.artifact); setEvidence(null); setMessage('Automatic Task completion confirmed. The original final artifact matches its chain commitment.'); }
          return;
        }
        if (active) setCompletedArtifact(null);
        const result = await inspectTaskPlan(client, saved, live);
        if (active) { setEvidence(result); setMessage(''); }
      } catch (cause) { if (active) { setEvidence(null); setMessage(cause instanceof Error ? cause.message : 'Could not verify task progress.'); } }
      finally { running = false; }
    }
    void tick(); const timer = setInterval(() => void tick(), 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [task.address, task.agent, revision, refresh]);

  async function restoreBindings() {
    if (!plan || working) return; setWorking(true); setMessage('');
    try {
      let next = plan;
      const records = readTaskJournal(plan.agent).filter(item => item.taskId === plan.taskId);
      const unbound = plan.actions.filter(action => !plan.bindings[action.id]);
      for (const action of unbound) {
        const candidates = records.filter(item => !Object.values(next.bindings).includes(item.actionId) && item.signature && matchesPlannedCheckpoint(next, action, item));
        if (!candidates.length) continue;
        if (candidates.length !== 1 || unbound.filter(other => matchesPlannedCheckpoint(next, other, candidates[0])).length !== 1) throw new Error('Several identical proposals or receipts match. Keep their original journals for explicit review; no ambiguous receipt was attached.');
        next = bindTaskPlanReceipt(next, action.id, candidates[0]);
      }
      setPlan(next); setRefresh(value => value + 1);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not restore receipt bindings.'); }
    finally { setWorking(false); }
  }

  async function control(mode: 'grant' | 'revoke' | 'resume' | 'pause') {
    if (!plan || working || transactionBusy) return; setWorking(true); setMessage('');
    try { await authorize(plan, mode); setRefresh(value => value + 1); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not prepare plan authorization.'); }
    finally { setWorking(false); }
  }
  async function recover(attempt: TaskCompletionAttempt) {
    if (working || transactionBusy) return; setWorking(true); setMessage('');
    const checkpoint = { agent: task.agent, id: attempt.id };
    try { if (attempt.signature) await reconcileTaskCompletion(client, checkpoint); else await discardTaskCompletion(checkpoint); setRefresh(value => value + 1); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not check the original completion transaction.'); }
    finally { setWorking(false); }
  }
  async function importCompletion(file?: File) {
    if (!file || working || transactionBusy) return; setWorking(true); setMessage('');
    try { if (file.size > 2000000) throw new Error('Completion backup exceeds 2 MB.'); await importTaskCompletionJournal(task.agent, await file.text()); setRefresh(value => value + 1); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not restore completion evidence.'); }
    finally { setWorking(false); }
  }

  async function importPlan(file?: File) {
    if (!file || working) return; setWorking(true); setMessage('');
    try {
      if (file.size > 500_000) throw new Error('Task plan backup exceeds 500 KB.');
      const restored = validateTaskPlan(JSON.parse(await file.text())); await verifyTaskPlan(restored);
      const live = await decodeChainTask(task.address, await readTask(), task.agent);
      if (restored.network !== NETWORK_STORAGE || restored.agent !== live.agent || restored.task !== live.address || restored.taskId !== live.id || restored.session !== live.session || restored.taskHash !== live.taskHash) throw new Error('Plan backup belongs to another network, Task or Session.');
      saveTaskPlan(restored); setRefresh(value => value + 1);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not restore plan.'); }
    finally { setWorking(false); }
  }

  return <details className="task-plan-progress"><summary>Automatic task plan and verified progress</summary>
    {!plan ? <p>No fixed automatic plan is saved for this Task. Run its exact description before the first payment, or restore its plan backup.</p> : <>
      <p>{evidence?.reason ?? 'Verifying original transactions and chain results…'}</p>
      <small>Fixed plan SHA-256: {plan.planHash} · {plan.actions.length} planned actions</small>
      <p role="status">{completedArtifact ? 'Completed' : setting?.enabled ? 'Automatic plan enabled' : 'Automatic plan paused or awaiting authorization'}{orchestrationStatus ? ` · ${orchestrationStatus}` : ''}</p>
      {permit && <small>Completion permit: {permit.revoked ? 'revoked' : permit.used ? 'used' : permit.planHash === plan.planHash && permit.session === plan.session ? 'matches fixed plan' : 'different plan or Session'} · expires {new Date(permit.expiresAt * 1000).toLocaleString(displayLocale())}</small>}
      {!completedArtifact && <div className="task-buttons"><button type="button" className="outline-button" disabled={working || transactionBusy || Boolean(permit?.used)} onClick={() => void control('grant')}>Review plan and authorize automatic finish</button>{permit && !permit.used && !permit.revoked && <><button type="button" className="outline-button" disabled={working || transactionBusy} onClick={() => void control(setting?.enabled ? 'pause' : 'resume')}>{setting?.enabled ? 'Pause fixed plan' : 'Resume original fixed plan'}</button><button type="button" className="outline-button" disabled={working || transactionBusy} onClick={() => void control('revoke')}>Review completion revocation</button></>}</div>}
      <ol>{plan.actions.map(action => {
        const row = evidence?.rows.find(row => row.id === action.id);
        return <li key={action.id}><strong>{action.kind} · {row?.state.replaceAll('_', ' ') ?? 'awaiting verification'}</strong><p>{row?.detail ?? `${action.amount} ${action.asset === 'SOL' ? 'lamports' : 'USDC base units'} · ${action.target}`}</p>{row?.escrow && <small>Escrow: {row.escrow}</small>}{row?.roles && <table><caption>Role preparation and execution</caption><thead><tr><th>Role</th><th>Current state</th><th>Next step or evidence</th></tr></thead><tbody>{row.roles.map(role => <tr key={role.role}><th scope="row">{role.role}</th><td>{role.state}</td><td>{role.detail}</td></tr>)}</tbody></table>}{row?.outputHash && <small>Result SHA-256: {row.outputHash}</small>}</li>;
      })}</ol>
      <button type="button" className="outline-button" disabled={working} onClick={() => download(`agentos-task-plan-${task.id}.json`, JSON.stringify(plan))}>Download fixed plan backup</button>
      <button type="button" className="outline-button" disabled={working} onClick={() => void restoreBindings()}>Recover unique saved receipt bindings</button>
      {evidence?.ready && evidence.artifact && <><p>All planned actions passed verification. The enabled plan can commit this result using its authorized Session.</p><button type="button" className="outline-button" onClick={() => download(`agentos-task-result-${task.id}.json`, evidence.artifact!)}>Download verified final result</button><small>Final result SHA-256: {evidence.resultHash}</small></>}
      {completedArtifact && <button type="button" className="outline-button" onClick={() => download(`agentos-task-result-${task.id}.json`, completedArtifact)}>Download completed Task result</button>}
      <button type="button" className="outline-button" disabled={working || transactionBusy} onClick={() => download(`agentos-task-completion-${task.agent.slice(0, 8)}.json`, exportTaskCompletionJournal(task.agent))}>Download authorization and completion checkpoints</button>
      {attempts.map(attempt => <p key={attempt.id}><strong>{attempt.action} · {attempt.state}</strong>{attempt.signature && <small>Original signature: {attempt.signature}</small>}{['prepared', 'signed', 'unknown'].includes(attempt.state) && <button type="button" className="outline-button" disabled={working || transactionBusy} onClick={() => void recover(attempt)}>{attempt.signature ? 'Check original signature' : 'Discard unsigned review'}</button>}</p>)}
    </>}
    <label>Restore fixed plan backup<input type="file" accept="application/json,.json" disabled={working} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void importPlan(file); }} /></label>
    <label>Restore authorization and completion checkpoints<input type="file" accept="application/json,.json" disabled={working || transactionBusy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void importCompletion(file); }} /></label>
    {message && <p role="status">{message}</p>}
  </details>;
}
