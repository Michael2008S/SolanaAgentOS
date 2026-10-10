/** @jsxImportSource ./i18n */
import { displayLocale } from './i18n/locale';
import { EXPLORER_QUERY, NETWORK_LABEL } from './lib/chainNetwork';
import { TaskSkillResults } from './TaskSkillResults';
import { TaskPlanProgress } from './TaskPlanProgress';
import type { TaskPlan } from './lib/taskPlan';
import React, { useEffect, useRef, useState } from 'react';
import { address, type Instruction } from '@solana/kit';
import type { AppClient } from './providers';
import { buildCreateTask, buildReplaceTaskSession, buildSetTaskStatus, formatUsdcBaseUnits, PROGRAM_ADDRESS, type TaskStatus } from './lib/agentOs';
import { reconcileCheckpointedTransaction } from './lib/taskTransaction';
import { decodeChainTask, type ChainTask } from './lib/taskClient';
import { discardTaskLifecycle, exportTaskLifecycle, importTaskLifecycle, prepareTaskLifecycle, readTaskLifecycle, reconcileTaskLifecycle, type TaskLifecycleAttempt, type TaskLifecycleCheckpoint } from './lib/taskLifecycle';
import { discardSkillResult, reconcileSkillResult } from './lib/skillResultTransaction';
import { exportTaskJournal, importTaskJournal, readTaskJournal, updateTaskCheckpoint, type TaskCheckpoint } from './lib/taskJournal';

type Review = { taskLifecycleCheckpoint?: TaskLifecycleCheckpoint; title: string; subtitle: string; details: string[]; instruction: Instruction; onSuccess: (signature: string) => void };
type Props = {
  authorizePlan: (plan: TaskPlan, mode: 'grant' | 'revoke' | 'resume' | 'pause') => Promise<void>; orchestrationStatus: string;
  client: AppClient; agent: string; owner: string | null; session: { address: string; expiresAt: number; signer?: unknown } | null;
  revision: number; transactionBusy: boolean; readAccount: (key: string, label: string, type: 'Task') => Promise<Uint8Array>;
  review: (transaction: Review) => void; changed: () => void;
  onCreated: (description: string) => void; resumeSkill: (checkpoint: TaskCheckpoint) => Promise<void>; resumeEscrow: (checkpoint: TaskCheckpoint) => Promise<void>; recoverProvider: (checkpoint: TaskCheckpoint) => Promise<void>;
};
function atomic(text: string, decimals: number): bigint {
  if (!new RegExp(`^(0|[1-9][0-9]{0,10})(\\.[0-9]{1,${decimals}})?$`).test(text)) throw new Error('Enter an exact positive decimal budget.');
  const [whole, fraction = ''] = text.split('.');
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
  if (value > 18_446_744_073_709_551_615n) throw new Error('Budget exceeds the supported amount.');
  return value;
}
const solText = (value: string) => { const amount = BigInt(value); return `${amount / 1_000_000_000n}.${(amount % 1_000_000_000n).toString().padStart(9, '0')}`; };

export function TasksPanel({ client, agent, owner, session, revision, transactionBusy, readAccount, review, changed, onCreated, resumeSkill, resumeEscrow, recoverProvider, authorizePlan, orchestrationStatus }: Props) {
  const [tasks, setTasks] = useState<ChainTask[]>([]);
  const [records, setRecords] = useState<TaskCheckpoint[]>([]);
  const [lifecycle, setLifecycle] = useState<TaskLifecycleAttempt[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [description, setDescription] = useState('');
  const [solBudget, setSolBudget] = useState('0.1');
  const [usdcBudget, setUsdcBudget] = useState('0');
  const [hours, setHours] = useState('6');
  const [taskResults, setTaskResults] = useState<Record<string, string>>({});
  const context = useRef({ agent, owner, session: session?.address, transactionBusy });
  context.current = { agent, owner, session: session?.address, transactionBusy };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function assertReviewContext() {
    const current = context.current;
    if (!mounted.current || current.agent !== agent || current.owner !== owner || current.session !== session?.address || current.transactionBusy) throw new Error('Wallet, Agent, Session or transaction activity changed. The saved review remains available for recovery.');
  }
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setTasks([]); setRecords([]); setLifecycle([]);
    (async () => {
      setLifecycle(readTaskLifecycle(agent)); setRecords(readTaskJournal(agent));
      const response = await fetch(`/api/on-chain/tasks?agent=${encodeURIComponent(agent)}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
      const payload = await response.json();
      if (!response.ok || payload.programId !== PROGRAM_ADDRESS || !Array.isArray(payload.tasks) || payload.tasks.length > 1_000) throw new Error(payload.error ?? 'Could not read Tasks.');
      const values = await Promise.all(payload.tasks.map(async (item: { address: string }) => decodeChainTask(item.address, await readAccount(item.address, 'Task', 'Task'), agent)));
      if (active) { setTasks(values); setRecords(readTaskJournal(agent)); }
    })().catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load Tasks.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [agent, revision, refresh]);

  async function createTask() {
    if (working || transactionBusy) return;
    setError(''); setWorking(true);
    try {
      if (!owner || !session) throw new Error('Connect the Owner wallet and create a Session first.');
      if (description.trim().length < 4 || description.trim().length > 800) throw new Error('Describe the task in 4–800 characters.');
      if (!/^[1-9][0-9]{0,2}$/.test(hours) || Number(hours) > 720) throw new Error('Choose a deadline between 1 and 720 hours.');
      const deadline = Math.floor(Date.now() / 1000) + Number(hours) * 3_600;
      if (deadline > session.expiresAt) throw new Error('The task must end before its Session expires.');
      const maxSol = atomic(solBudget, 9), maxUsdc = atomic(usdcBudget, 6);
      if (maxSol === 0n && maxUsdc === 0n) throw new Error('Set at least one positive budget.');
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(description.trim())));
      const taskId = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0, true);
      const built = await buildCreateTask(address(owner), address(agent), address(session.address), taskId, hash, maxSol, maxUsdc, BigInt(deadline));
      const taskLifecycleCheckpoint = await prepareTaskLifecycle(client, { action: 'create', agent, owner, taskId: taskId.toString(), instruction: built.instruction, description: description.trim(), session: session.address, maxSol: maxSol.toString(), maxUsdc: maxUsdc.toString(), deadline });
      setLifecycle(readTaskLifecycle(agent));
      assertReviewContext();
      const savedDescription = description.trim();
      review({ taskLifecycleCheckpoint, title: 'Create task budget', subtitle: 'Bind this Session to one Task. Task payments retain the Agent and Session spending limits.', details: [`Network: Solana ${NETWORK_LABEL}`, `Task: ${built.task}`, `Task description: ${description.trim()}`, `Session: ${session.address}`, `Total budget: ${solBudget} SOL and ${usdcBudget} USDC`, `Deadline: ${new Date(deadline * 1_000).toLocaleString(displayLocale())}`, `Fee payer: ${owner} · account rent and network fees are outside the Task budget.`, 'The task starts Ready. Start it before making payments.'], instruction: built.instruction, onSuccess: () => { onCreated(savedDescription); changed(); setRefresh((value) => value + 1); } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create Task.'); } finally { setWorking(false); }
  }

  async function restoreTaskPlan(task: ChainTask) {
    if (working || transactionBusy) return;
    setWorking(true); setError('');
    try {
      const saved = readTaskLifecycle(agent).find((item) => item.task === task.address && item.action === 'create' && item.state === 'confirmed' && item.description);
      if (!saved?.description) throw new Error('Import the saved task lifecycle journal to restore its exact description.');
      const live = await decodeChainTask(task.address, await readAccount(task.address, 'Task', 'Task'), agent);
      if (!session?.signer || session.address !== live.session) throw new Error('Restore this Task’s bound Session before restoring its description to the planner. To use another Session, review its replacement first.');
      if (live.status !== 'running' || live.deadline <= Math.floor(Date.now() / 1000)) throw new Error('Start or resume this Task and verify its deadline before planning. Terminal or expired Tasks cannot run.');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saved.description)));
      const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== live.taskHash) throw new Error('Saved task description does not match its on-chain commitment.');
      assertReviewContext();
      onCreated(saved.description);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore task description.'); }
    finally { setWorking(false); }
  }

  async function changeTask(task: ChainTask, next: TaskStatus | 'replace') {
    if (working || transactionBusy) return;
    setError(''); setWorking(true);
    try {
      if (!owner) throw new Error('Connect the Owner wallet.');
      const fresh = await decodeChainTask(task.address, await readAccount(task.address, 'Task', 'Task'), agent);
      const resultText = taskResults[fresh.address] ?? '';
      let resultHash: Uint8Array | undefined;
      if (next === 'completed') {
        if (fresh.status !== 'running' || fresh.pendingEscrows !== '0' || fresh.pendingSkillResults !== '0') throw new Error('This task cannot complete until it is running and every funded Escrow and paid Skill result is resolved. Refresh its chain state.');
        if (!resultText.trim() || resultText.trim().length > 4_000) throw new Error('Enter the exact result text before declaring completion.');
        resultHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(resultText.trim())));
      }
      if (next === 'replace' && !session) throw new Error('Create a replacement Session first.');
      const built = next === 'replace' ? await buildReplaceTaskSession(address(owner), address(agent), BigInt(fresh.id), address(session!.address)) : await buildSetTaskStatus(address(owner), address(agent), BigInt(fresh.id), next, resultHash);
      const taskLifecycleCheckpoint = await prepareTaskLifecycle(client, { action: next === 'replace' ? 'session' : 'status', agent, owner, taskId: fresh.id, instruction: built.instruction, previous: fresh, ...(next === 'replace' ? { session: session!.address } : { next }), ...(next === 'completed' ? { resultText: resultText.trim() } : {}) });
      setLifecycle(readTaskLifecycle(agent));
      assertReviewContext();
      review({ taskLifecycleCheckpoint, title: next === 'replace' ? 'Replace task Session' : `Set task ${next}`, subtitle: next === 'completed' ? 'The Owner declares completion and commits the result text. This is not a Judge verdict.' : 'The Owner updates this task. Its cumulative spending remains unchanged.', details: [`Network: Solana ${NETWORK_LABEL}`, `Task: ${fresh.address}`, `Current status: ${fresh.status}`, `Fee payer: ${owner}`, ...(next === 'replace' ? [`New Session: ${session!.address}`, 'The previous Session remains task-bound. Revoke it separately to remove non-spending permissions.'] : []), ...(resultHash ? [`Result text: ${resultText.trim()}`] : [])], instruction: built.instruction, onSuccess: () => { changed(); setRefresh((value) => value + 1); } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update Task.'); } finally { setWorking(false); }
  }

  async function reconcile(record: TaskCheckpoint) {
    setError('');
    try {
      await reconcileCheckpointedTransaction(client, record);
      setRecords(readTaskJournal(agent)); changed();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not recover action.'); }
  }

  async function discard(record: TaskCheckpoint) {
    try {
      if (!navigator.locks) throw new Error('This browser does not support transaction coordination locks.');
      await navigator.locks.request(`agentos:task-send:${record.agent}:${record.taskId}`, () => {
        const latest = readTaskJournal(agent).find((item) => item.taskId === record.taskId && item.actionId === record.actionId);
        if (!latest || latest.signature || latest.state !== 'prepared') throw new Error('A signed action must be checked on-chain.');
        updateTaskCheckpoint(latest, { state: 'cancelled' }); setRecords(readTaskJournal(agent));
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not discard review.'); }
  }
  async function recoverResult(record: TaskCheckpoint, attemptId: string, discard = false) {
    setError('');
    try {
      const checkpoint = { agent, execution: record.execution, attemptId };
      if (discard) await discardSkillResult(checkpoint);
      else await reconcileSkillResult(client, checkpoint);
      setRecords(readTaskJournal(agent)); changed();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check result registration.'); }
  }
  function exportJournal() {
    try {
      const url = URL.createObjectURL(new Blob([exportTaskJournal(agent)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `agentos-task-journal-${agent.slice(0, 8)}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not export journal.'); }
  }
  async function importJournal(file: File) {
    try {
      if (file.size > 500_000) throw new Error('Journal backup exceeds 500 KB.');
      importTaskJournal(agent, await file.text()); setRecords(readTaskJournal(agent));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore journal.'); }
  }
  async function recoverLifecycle(item: TaskLifecycleAttempt, discard = false) {
    if (working || transactionBusy) return;
    setWorking(true); setError('');
    try {
      const checkpoint = { agent, id: item.id };
      if (discard) await discardTaskLifecycle(checkpoint);
      else await reconcileTaskLifecycle(client, checkpoint);
      setLifecycle(readTaskLifecycle(agent)); changed(); setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not recover Task lifecycle.'); }
    finally { setWorking(false); }
  }
  function downloadLifecycle() {
    try {
      const url = URL.createObjectURL(new Blob([exportTaskLifecycle(agent)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `agentos-task-lifecycle-${agent.slice(0, 8)}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not export lifecycle.'); }
  }
  async function restoreLifecycle(file: File) {
    if (working || transactionBusy) return;
    setWorking(true); setError('');
    try {
      if (file.size > 500000) throw new Error('Lifecycle backup exceeds 500 KB.');
      await importTaskLifecycle(client, agent, await file.text()); setLifecycle(readTaskLifecycle(agent));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not import lifecycle.'); }
    finally { setWorking(false); }
  }
  return <section className="panel task-panel">
    <div className="panel-title-row"><h3>Tasks and recovery</h3><button className="outline-button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? 'Loading…' : 'Refresh'}</button></div>
    <p>Each task has its own total budget and dedicated Session. Payments and Skill calls from that Session use this budget. Worker Escrow funding also consumes this gross budget; refunds do not reset it.</p>
    {error && <p role="alert" className="denied-text">{error}</p>}
    <div className="task-form"><label>Task description<textarea value={description} maxLength={800} onChange={(event) => setDescription(event.target.value)} /></label><label>Total SOL<input value={solBudget} inputMode="decimal" onChange={(event) => setSolBudget(event.target.value)} /></label><label>Total USDC<input value={usdcBudget} inputMode="decimal" onChange={(event) => setUsdcBudget(event.target.value)} /></label><label>Deadline in hours<input value={hours} inputMode="numeric" onChange={(event) => setHours(event.target.value)} /></label><button className="primary-button" disabled={!owner || !session || working || transactionBusy} onClick={() => void createTask()}>Review new task</button></div>
    {tasks.map((task) => <article className="task-card" key={task.address}><strong>Task #{task.id} · {task.status}</strong><p>Gross spent: {solText(task.sol.spent)} SOL · {formatUsdcBaseUnits(BigInt(task.usdc.spent))} USDC. Account rent and network fees are separate.</p>{lifecycle.some((item) => item.task === task.address && item.action === 'create' && item.state === 'confirmed' && item.description) && <button className="outline-button" disabled={working || transactionBusy} onClick={() => void restoreTaskPlan(task)}>Restore verified task description to planner</button>}{!['completed', 'failed', 'cancelled'].includes(task.status) && <label className="task-result">Final result for Task #{task.id}<textarea value={taskResults[task.address] ?? ''} maxLength={4_000} onChange={(event) => setTaskResults((values) => ({ ...values, [task.address]: event.target.value }))} /></label>}{task.resultHash && <small>Final result SHA-256: {task.resultHash}</small>}{(task.pendingEscrows !== '0' || task.pendingSkillResults !== '0') && <p>Completion is waiting for {task.pendingEscrows} Escrow settlement(s) and {task.pendingSkillResults} Skill result commitment(s).</p>}<TaskPlanProgress authorize={authorizePlan} orchestrationStatus={orchestrationStatus} transactionBusy={transactionBusy} client={client} task={task} revision={revision} readTask={() => readAccount(task.address, 'Task', 'Task')} /><TaskSkillResults key={task.address} agent={agent} task={task.address} /><a href={`https://explorer.solana.com/address/${task.address}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">View task</a><p>SOL remaining {solText(task.sol.remaining)} / {solText(task.sol.maximum)} · USDC remaining {formatUsdcBaseUnits(BigInt(task.usdc.remaining))} / {formatUsdcBaseUnits(BigInt(task.usdc.maximum))}</p><small>Confirmed task actions {task.actionCount} · Pending Escrows {task.pendingEscrows} · Pending Skill results {task.pendingSkillResults} · Deadline {new Date(task.deadline * 1_000).toLocaleString(displayLocale())} · {task.session === session?.address ? 'Current Session' : 'Different Session'}</small><div className="task-buttons">{['ready', 'paused'].includes(task.status) && <button className="outline-button" disabled={working || transactionBusy} onClick={() => void changeTask(task, 'running')}>Start / resume</button>}{['running', 'waiting'].includes(task.status) && <button className="outline-button" disabled={working || transactionBusy} onClick={() => void changeTask(task, 'paused')}>Pause</button>}{task.status === 'running' && <button className="outline-button" disabled={working || transactionBusy || task.pendingEscrows !== '0' || task.pendingSkillResults !== '0'} onClick={() => void changeTask(task, 'completed')}>Review completion</button>}{!['completed', 'failed', 'cancelled'].includes(task.status) && <><button className="outline-button" disabled={working || transactionBusy} onClick={() => void changeTask(task, 'cancelled')}>Cancel task</button><button className="outline-button" disabled={working || transactionBusy || !session || task.session === session.address} onClick={() => void changeTask(task, 'replace')}>Use current Session</button></>}</div></article>)}
    {!loading && !tasks.length && <p>No on-chain Tasks found for this Agent.</p>}
    <h4>Saved task creation and state changes</h4>
    <p>Owner reviews are saved before signing, including task descriptions and completion text. Signed attempts are checked using the original transaction; recovery does not send again. Backups contain this text, but no Session keys.</p>
    <div className="task-buttons"><button className="outline-button" onClick={downloadLifecycle}>Download lifecycle backup</button><label>Restore lifecycle backup<input type="file" disabled={working || transactionBusy} accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void restoreLifecycle(file); event.target.value = ''; }} /></label></div>
    {lifecycle.map(item => <div className="task-card" key={item.id}><strong>Task #{item.taskId} · {item.action === 'status' ? `Set ${item.next}` : item.action === 'session' ? 'Replace Session' : 'Create'} · {item.state}</strong><small>{item.task}</small>{item.signature && <a href={`https://explorer.solana.com/tx/${item.signature}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">Original transaction</a>}{['signed', 'unknown'].includes(item.state) && <button className="outline-button" disabled={working || transactionBusy} onClick={() => void recoverLifecycle(item)}>Check original transaction · no replay</button>}{item.state === 'prepared' && <button className="outline-button" disabled={working || transactionBusy} onClick={() => void recoverLifecycle(item, true)}>Discard unsent lifecycle review</button>}{(item.description || item.resultText) && <button className="outline-button" onClick={() => { if (item.description) { setDescription(item.description); onCreated(item.description); } if (item.resultText) setTaskResults((values) => ({ ...values, [item.task]: item.resultText! })); }}>Restore saved text</button>}</div>)}
    <h4>Saved payment checkpoints</h4><p>Saved in this browser: transaction data, Escrow task descriptions and received Skill response text. The downloaded journal also contains this text. It does not contain Session keys or replay Provider requests.</p>
    <div className="task-buttons"><button className="outline-button" onClick={exportJournal}>Download journal</button><label>Restore journal<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importJournal(file); event.target.value = ''; }} /></label></div>
    {records.map((record) => <div className="task-card" key={`${record.taskId}:${record.actionId}`}><strong>{record.kind} · Task #{record.taskId} · {record.state}</strong>{!record.review && <small>Legacy checkpoint · complete reviewed instruction unavailable; manual verification required.</small>}<small>Action {record.actionId} · {record.amount} atomic {record.asset}</small>{record.signature && <a href={`https://explorer.solana.com/tx/${record.signature}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">Transaction</a>}{['signed', 'unknown'].includes(record.state) && <button className="outline-button" onClick={() => void reconcile(record)}>Check saved transaction</button>}{record.state === 'prepared' && !record.signature && <button className="outline-button" onClick={() => void discard(record)}>Discard unsent review</button>}{record.kind === 'skill' && record.skillRequest && record.state === 'confirmed' && !record.skillResult && <button className="outline-button" onClick={() => void recoverProvider(record).then(() => setRefresh((value) => value + 1)).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not recover Provider response.'))}>Retrieve saved Provider response · no payment</button>}{record.skillResult && record.state === 'confirmed' && <button className="outline-button" onClick={() => void resumeSkill(record).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not restore result.'))}>Open saved Skill result</button>}{record.skillResult?.attempts?.map((attempt) => <div key={attempt.id}><small>Result registration · {attempt.state}</small>{attempt.signature && <a href={`https://explorer.solana.com/tx/${attempt.signature}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">Result transaction</a>}{['signed', 'unknown'].includes(attempt.state) && <button className="outline-button" onClick={() => void recoverResult(record, attempt.id)}>Check result transaction</button>}{attempt.state === 'prepared' && !attempt.signature && <button className="outline-button" onClick={() => void recoverResult(record, attempt.id, true)}>Discard unsent result review</button>}</div>)}{record.escrowTask && record.state === 'confirmed' && <button className="outline-button" onClick={() => void resumeEscrow(record).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not restore Escrow.'))}>Restore Escrow task</button>}</div>)}
  </section>;
}
