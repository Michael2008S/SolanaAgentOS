/** @jsxImportSource ./i18n */
import { displayLocale } from './i18n/locale';
import { EXPLORER_QUERY, NETWORK_LABEL, NETWORK_STORAGE } from './lib/chainNetwork';
import React, { useEffect, useRef, useState } from 'react';
import { address, type Instruction, type KeyPairSigner } from '@solana/kit';
import type { AppClient } from './providers';
import { PROGRAM_ADDRESS, buildProposeEscrowJudge, buildAcceptEscrowJudge, buildDeclineEscrowJudge, buildRecordEscrowJudgment, buildSettleJudgedEscrow, formatUsdcBaseUnits } from './lib/agentOs';
import { validateProposedJudgeSession, loadJudgeSnapshot, parseJudgeArtifact, judgeHashBytes, judgeDigest, readJudgeDirectory, readSharedJudgeTexts, type JudgeDirectoryEntry, type JudgeSnapshot } from './lib/judgeClient';
import { advanceAutomaticJudge, reconcileAutomaticJudgeOutcome, disableAutomaticJudge, enableAutomaticJudge, previewAutomaticJudge, readAutomaticJudge, type AutomaticJudgePlan, type AutomaticJudgeSession } from './lib/automaticJudge';
import { prepareJudgeTransaction, discardJudgeTransaction, reconcileJudgeTransaction, exportJudgeJournal, importJudgeJournal, readJudgeJournal, type JudgeCheckpoint, type JudgeAttempt } from './lib/judgeJournal';
type Review = { judgeCheckpoint?: JudgeCheckpoint; title: string; subtitle: string; details: string[]; instruction: Instruction; onSuccess: (signature: string) => void };
type Props = { client: AppClient; agent: string; owner: string | null; session: AutomaticJudgeSession | null; blocked?: boolean; review: (value: Review) => void; changed: () => void };
const artifactKey = (escrow: string) => `agentos:judge-body:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${escrow}`;
const selectionKey = (agent: string) => `agentos:judge-selection:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${agent}`;

export function JudgePanel({ client, agent, owner, session, blocked = false, review, changed }: Props) {
  const [escrow, setEscrow] = useState('');
  const [judge, setJudge] = useState('');
  const [judgeSession, setJudgeSession] = useState('');
  const [expires, setExpires] = useState('');
  const [body, setBody] = useState('');
  const [taskText, setTaskText] = useState('');
  const [resultText, setResultText] = useState('');
  const [attempts, setAttempts] = useState<JudgeAttempt[]>([]);
  const [snapshot, setSnapshot] = useState<JudgeSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoPlan, setAutoPlan] = useState<AutomaticJudgePlan | null>(null);
  const [autoPreview, setAutoPreview] = useState<AutomaticJudgePlan | null>(null);
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [autoSettle, setAutoSettle] = useState(false);
  const [autoMessage, setAutoMessage] = useState('');
  const [autoBusy, setAutoBusy] = useState(false);
  const [directory, setDirectory] = useState<JudgeDirectoryEntry[]>([]);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [directoryNotice, setDirectoryNotice] = useState('');
  const automationContext = useRef({ session, agent, blocked, busy });
  automationContext.current = { session, agent, blocked, busy };
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : 'Judge operation failed.');
  useEffect(() => {
    try {
      const selected = localStorage.getItem(selectionKey(agent));
      if (selected) {
        address(selected);
        void load(selected);
      }
    } catch (cause) { fail(cause); }
  }, [agent, client]);
  useEffect(() => {
    if (!snapshot) { setAttempts([]); return; }
    const refresh = () => { try { setAttempts(readJudgeJournal(snapshot.escrow)); setAutoPlan(readAutomaticJudge(snapshot.escrow)); } catch (cause) { fail(cause); } };
    refresh(); const timer = window.setInterval(refresh, 2_000); window.addEventListener('storage', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('storage', refresh); };
  }, [snapshot?.escrow]);
  useEffect(() => {
    setAutoBusy(false);
    if (!snapshot) return;
    const escrowKey = snapshot.escrow;
    let closed = false, running = false;
    const tick = async () => {
      if (closed || running) return;
      const current = automationContext.current;
      const plan = readAutomaticJudge(escrowKey);
      if (!plan?.enabled || plan.judge !== current.agent || current.blocked || current.busy) return;
      if (!current.session?.signer || current.session.address !== plan.session || current.session.automationsPaused) {
        running = true;
        try {
          const terminal = await reconcileAutomaticJudgeOutcome(client, escrowKey);
          if (!closed && terminal) { setSnapshot(terminal); setAutoPlan(readAutomaticJudge(escrowKey)); setAutoMessage('Escrow completed; no signing key or further transaction is required.'); changed(); }
        } finally { running = false; }
        return;
      }
      running = true; setAutoBusy(true);
      try {
        const output = await advanceAutomaticJudge(client, escrowKey, () => automationContext.current.session, () => !closed && !automationContext.current.blocked && !automationContext.current.busy && automationContext.current.agent === plan.judge);
        if (!closed) {
          if (output.snapshot) setSnapshot(output.snapshot);
          if (output.message) { setAutoMessage(output.message); changed(); }
          const saved = readAutomaticJudge(escrowKey); setAutoPlan(saved); if (saved?.artifact) setBody(saved.artifact); setAttempts(readJudgeJournal(escrowKey));
        }
      } catch (cause) { if (!closed) { fail(cause); const saved = readAutomaticJudge(escrowKey); setAutoPlan(saved); if (saved?.artifact) setBody(saved.artifact); } }
      finally { running = false; if (!closed) setAutoBusy(false); }
    };
    const safeTick = () => { void tick().catch((cause) => { if (!closed) fail(cause); }); };
    safeTick(); const timer = window.setInterval(safeTick, 5_000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [snapshot?.escrow, client]);
  async function previewAutomation() {
    if (!snapshot || busy || autoBusy || blocked) return;
    setBusy(true); setError('');
    try { setAutoPreview(await previewAutomaticJudge(client, snapshot.escrow, agent, session, taskText, resultText, autoGenerate, body, autoSettle)); }
    catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  async function enableAutomation() {
    if (!autoPreview || busy || blocked) return;
    setBusy(true); setError('');
    try { setAutoPlan(await enableAutomaticJudge(client, autoPreview, session)); setAutoPreview(null); setAutoMessage('Automatic Judge enabled for this Escrow and Session.'); }
    catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  function disableAutomation() {
    try { if (snapshot) { disableAutomaticJudge(snapshot.escrow); setAutoPlan(readAutomaticJudge(snapshot.escrow)); setAutoPreview(null); setAutoMessage('Automatic Judge disabled. Check any already signed transaction.'); } }
    catch (cause) { fail(cause); }
  }
  async function refreshDirectory() {
    const requestedAgent = agent;
    setDirectoryBusy(true); setError('');
    try {
      const result = await readJudgeDirectory(requestedAgent);
      if (automationContext.current.agent !== requestedAgent) return;
      setDirectory(result.tasks);
      setDirectoryNotice(`${result.tasks.length} tasks · ${result.truncated ? 'Limited view; enter omitted Escrow addresses manually.' : 'Current bounded snapshot.'}${result.failures ? ` ${result.failures} account snapshots could not be verified; refresh before acting.` : ''}`);
    } catch (cause) { if (automationContext.current.agent === requestedAgent) { setDirectory([]); fail(cause); } } finally { setDirectoryBusy(false); }
  }
  useEffect(() => { setDirectory([]); setDirectoryNotice(''); }, [agent]);
  async function readSharedTexts() {
    if (!snapshot || busy || autoBusy || autoPlan?.enabled) return;
    setBusy(true); setError('');
    try {
      const shared = await readSharedJudgeTexts(client, snapshot.escrow);
      setSnapshot(shared.snapshot); setTaskText(shared.task); setResultText(shared.result); setAutoPreview(null);
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  async function load(selectedEscrow = escrow.trim()) {
    setBusy(true); setError(''); setSnapshot(null); setAutoPreview(null); setAutoPlan(null); setAutoMessage('');
    try {
      const live = await loadJudgeSnapshot(client, selectedEscrow); setSnapshot(live); setEscrow(selectedEscrow); setTaskText(''); setResultText('');
      localStorage.setItem(selectionKey(agent), live.escrow);
      const saved = localStorage.getItem(artifactKey(live.escrow));
      const records = readJudgeJournal(live.escrow); setAttempts(records);
      setBody([...records].reverse().find((item) => item.action === 'record' && item.artifact)?.artifact ?? readAutomaticJudge(live.escrow)?.artifact ?? (saved ? JSON.parse(saved).artifact : ''));
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  async function assess() {
    if (autoPlan?.enabled || autoBusy) return;
    if (!snapshot || busy) return;
    setBusy(true); setError('');
    try {
      const live = await loadJudgeSnapshot(client, snapshot.escrow); setSnapshot(live);
      if (await judgeDigest(taskText.trim()) !== live.taskHash || await judgeDigest(resultText.trim()) !== live.resultHash) throw new Error('Exact task and result text must match the chain before assessment.');
      const requestBody = JSON.stringify({ task: taskText.trim(), result: resultText.trim(), taskHash: live.taskHash, resultHash: live.resultHash });
      if (new TextEncoder().encode(requestBody).length > 32_000) throw new Error('Assessment request exceeds 32 KB.');
      const response = await fetch('/api/escrow/judge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody, signal: AbortSignal.timeout(120_000) });
      const text = await response.text();
      if (!response.ok) throw new Error(JSON.parse(text).error ?? 'Could not generate assessment.');
      await parseJudgeArtifact(text, live); setBody(text);
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  async function prepare(action: 'propose' | 'accept' | 'decline' | 'record' | 'settle') {
    if (!snapshot || busy) return;
    setBusy(true); setError('');
    try {
      if (readAutomaticJudge(snapshot.escrow)?.enabled) throw new Error('Disable automatic Judge work before preparing a manual transaction.');
      if (!owner) throw new Error('Connect the wallet that will sign and pay transaction fees.');
      const live = await loadJudgeSnapshot(client, snapshot.escrow); setSnapshot(live);
      const now = Math.floor(Date.now() / 1_000);
      const common = [`Network: Solana ${NETWORK_LABEL}`, `Escrow: ${live.escrow}`, `Employer: ${live.employer}`, `Worker: ${live.worker}`, `Task SHA-256: ${live.taskHash}`, `Fee payer: ${owner}`];
      let instruction: Instruction; let title: string; let details: string[] = []; let subtitle = '';
      let savedArtifact: { content: string; hash: string; artifact: string } | undefined;
      if (action === 'propose') {
        if (live.employer !== agent || live.employerOwner !== owner || live.mandate || !live.funded || live.resultHash) throw new Error('Only the employer Owner can propose once, before result submission.');
        const expiry = Math.floor(Date.parse(expires) / 1_000);
        if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > live.deadline) throw new Error('Choose a Judge deadline before the Escrow deadline. It must also fit the selected Session.');
        await validateProposedJudgeSession(client, judge.trim(), judgeSession.trim(), live, expiry);
        instruction = await buildProposeEscrowJudge(address(owner), address(live.employer), address(live.worker), address(live.escrow), address(judge.trim()), address(judgeSession.trim()), BigInt(expiry));
        title = 'Propose Escrow Judge'; subtitle = 'The Worker must agree before delivering a result. The Judge Agent and its owner must differ from both parties.';
        details = [`Judge Agent: ${judge.trim()}`, `Judge Session: ${judgeSession.trim()}`, `Deadline: ${new Date(expiry * 1_000).toISOString()}`, 'Terms: pass pays the Worker in full; fail refunds the employer in full; needs_review moves no funds.', 'Proposal is immutable. Either party may decline before acceptance; no replacement proposal for this Escrow.', 'Fee payer funds JudgeMandate account rent plus network fees. Existing Owner release and mutual settlement remain available.'];
      } else {
        const mandate = live.mandate;
        if (!mandate) throw new Error('No Judge proposal exists for this Escrow.');
        details = [`Judge Agent: ${mandate.judge}`, `Judge Session: ${mandate.session}`, `Deadline: ${new Date(mandate.expiresAt * 1_000).toISOString()}`];
        if (action === 'accept') {
          if (live.worker !== agent || live.workerOwner !== owner || mandate.accepted || mandate.declined || !live.funded || live.resultHash || now >= mandate.expiresAt) throw new Error('Only the Worker Owner can accept a live proposal before delivering a result.');
          instruction = await buildAcceptEscrowJudge(address(owner), address(live.worker), address(live.escrow), { judgeAgent: address(mandate.judge), session: address(mandate.session), expiresAt: BigInt(mandate.expiresAt), taskHash: judgeHashBytes(mandate.taskHash) });
          title = 'Accept Escrow Judge'; subtitle = 'Authorize this exact Judge Session to sign one decision for this task. Acceptance cannot be withdrawn.';
          details.push('Pass: full Worker payment. Fail: full employer refund. Needs review: retain funds for manual resolution.', 'Network fee only.');
        } else if (action === 'decline') {
          if (mandate.accepted || mandate.declined || mandate.used || ![live.employerOwner, live.workerOwner].includes(owner)) throw new Error('Only an Escrow party can decline an unaccepted proposal.');
          instruction = await buildDeclineEscrowJudge(address(owner), address(live.employer), address(live.worker), address(live.escrow));
          title = 'Decline Escrow Judge'; subtitle = 'Decline this proposal permanently. Use existing Owner or mutual settlement paths for this Escrow.';
          details.push('Network fee only. No funds move.');
        } else if (action === 'record') {
          if (mandate.judge !== agent || mandate.session !== session?.address || !session?.signer || !mandate.accepted || mandate.declined || mandate.used || !live.funded || !live.resultHash || now >= mandate.expiresAt) throw new Error('Use the selected Judge Agent and its authorized Session to sign this live result.');
          const artifact = await parseJudgeArtifact(body, live);
          const saved = localStorage.getItem(artifactKey(live.escrow));
          if (saved && JSON.parse(saved).hash !== artifact.hash && (JSON.parse(saved).signature || readJudgeJournal(live.escrow).some((item) => item.action === 'record' && ['prepared', 'signed', 'unknown', 'confirmed'].includes(item.state)))) throw new Error('A different Judge artifact has an unresolved or confirmed attempt. Check its transaction first.');
          savedArtifact = { content: artifact.content, hash: artifact.hash, artifact: body };
          localStorage.setItem(artifactKey(live.escrow), JSON.stringify(savedArtifact));
          if (localStorage.getItem(artifactKey(live.escrow)) !== JSON.stringify(savedArtifact)) throw new Error('Could not save Judge body before review.');
          instruction = await buildRecordEscrowJudgment({ feePayer: address(owner), judge: address(agent), session: address(session.address), signer: session.signer, escrow: address(live.escrow), verdict: artifact.verdict, taskHash: judgeHashBytes(live.taskHash), resultHash: judgeHashBytes(live.resultHash), judgmentHash: judgeHashBytes(artifact.hash) });
          title = 'Record authorized Judge decision'; subtitle = 'Sign the assessment for this exact task and result. This consumes the one-decision mandate; no funds move yet.';
          details.push(`Verdict: ${artifact.verdict}`, `Summary: ${artifact.summary}`, `Result SHA-256: ${live.resultHash}`, `Judgment SHA-256: ${artifact.hash}`, 'Fee payer funds JudgeDecision account rent plus network fees. The full assessment is saved in this browser and can be downloaded.');
        } else {
          const decision = live.decision;
          if (!decision || decision.settled || !mandate.accepted || mandate.declined || !mandate.used || !live.funded || decision.verdict === 'needs_review' || now >= mandate.expiresAt) throw new Error('No live pass/fail judgment is available to settle.');
          instruction = await buildSettleJudgedEscrow({ caller: address(owner), employer: address(live.employer), worker: address(live.worker), escrow: address(live.escrow), asset: live.asset, execution: live.execution ? address(live.execution) : undefined, task: live.task ? address(live.task) : undefined });
          const amount = live.asset === 'USDC' ? formatUsdcBaseUnits(live.amount) : `${BigInt(live.amount) / 1_000_000_000n}.${(BigInt(live.amount) % 1_000_000_000n).toString().padStart(9, '0')}`;
          title = 'Settle authorized Judge decision'; subtitle = 'Anyone can submit this fixed on-chain decision. The caller cannot change the verdict, amount or recipient.';
          details.push(`Verdict: ${decision.verdict}`, `Judgment SHA-256: ${decision.judgmentHash}`, `Transfer: ${amount} ${live.asset} → ${decision.verdict === 'pass' ? live.worker : live.employer} Agent vault`, 'Updates Execution, Worker reputation and any parent Task atomically. Duplicate settlement is rejected.', live.asset === 'USDC' ? 'Fee payer also funds either Agent USDC token account if absent; account rent is outside the Task budget.' : 'Network fee only; Escrow rent is retained.');
        }
      }
      const reviewedEscrow = live.escrow;
      const judgeCheckpoint = await prepareJudgeTransaction(live, action, owner, instruction, action === 'record' ? body : undefined);
      setAttempts(readJudgeJournal(live.escrow));
      review({ judgeCheckpoint, title, subtitle, details: [...common, ...details], instruction, onSuccess: (signature) => {
        if (savedArtifact) localStorage.setItem(artifactKey(reviewedEscrow), JSON.stringify({ ...savedArtifact, signature }));
        setAttempts(readJudgeJournal(reviewedEscrow)); changed(); void loadJudgeSnapshot(client, reviewedEscrow).then(setSnapshot).catch(fail);
      } });
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  async function recover(id: string, discard = false) {
    if (!snapshot || busy) return;
    setBusy(true); setError('');
    try {
      const checkpoint = { escrow: snapshot.escrow, id };
      if (discard) await discardJudgeTransaction(checkpoint);
      else await reconcileJudgeTransaction(client, checkpoint);
      setAttempts(readJudgeJournal(snapshot.escrow));
      setSnapshot(await loadJudgeSnapshot(client, snapshot.escrow)); changed();
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  async function restore(file: File) {
    if (!snapshot || busy) return;
    setBusy(true); setError('');
    try {
      if (file.size > 1_000_000) throw new Error('Judge backup exceeds 1 MB.');
      const text = await file.text(); const backup = JSON.parse(text);
      const live = await loadJudgeSnapshot(client, snapshot.escrow); setSnapshot(live);
      if (backup.format === 'agentos-judge-journal') {
        await importJudgeJournal(client, live.escrow, text);
        const records = readJudgeJournal(live.escrow); setAttempts(records);
        const record = [...records].reverse().find((item) => item.action === 'record' && item.artifact);
        if (record?.artifact) setBody(record.artifact);
      } else {
        if (typeof backup.artifact !== 'string') throw new Error('Invalid Judge body backup.');
        const artifact = await parseJudgeArtifact(backup.artifact, live);
        if (backup.hash !== artifact.hash || backup.content !== artifact.content) throw new Error('Judge body backup hash is invalid.');
        const saved = localStorage.getItem(artifactKey(live.escrow));
        if (saved && JSON.parse(saved).hash !== artifact.hash) throw new Error('Restored Judge body conflicts with the saved commitment.');
        if (live.decision && live.decision.judgmentHash !== artifact.hash) throw new Error('Restored body differs from the chain decision.');
        localStorage.setItem(artifactKey(live.escrow), JSON.stringify({ content: artifact.content, hash: artifact.hash, artifact: backup.artifact }));
        setBody(backup.artifact); // Imported signature is not confirmation evidence.
      }
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  function downloadJournal() {
    try {
      if (!snapshot) return;
      const url = URL.createObjectURL(new Blob([exportJudgeJournal(snapshot.escrow)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `agentos-judge-journal-${snapshot.escrow}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) { fail(cause); }
  }
  async function download() {
    try {
      if (!snapshot) return;
      const record = [...readJudgeJournal(snapshot.escrow)].reverse().find((item) => item.action === 'record' && item.artifact);
      const artifact = record?.artifact ?? readAutomaticJudge(snapshot.escrow)?.artifact;
      const parsed = artifact ? await parseJudgeArtifact(artifact, snapshot) : undefined;
      const saved = artifact && parsed ? JSON.stringify({ content: parsed.content, hash: parsed.hash, artifact, ...(record?.signature ? { signature: record.signature } : {}) }) : localStorage.getItem(artifactKey(snapshot.escrow));
      if (!saved) throw new Error('Prepare a Judge artifact first.');
      const url = URL.createObjectURL(new Blob([saved], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `agentos-judge-${snapshot.escrow}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) { fail(cause); }
  }
  return <section className="panel task-panel">
    <div className="panel-title-row"><h3>Judge authorization and settlement</h3></div>
    <p>Both Escrow parties agree to an independent Judge Session before result submission. A signed pass/fail decision permits fixed settlement; needs_review keeps funds for manual resolution.</p>
    {error && <p className="denied-text" role="alert">{error}</p>}
    <div className="panel-title-row"><h4>This Agent's Judge tasks</h4><button className="outline-button" disabled={directoryBusy || busy || autoBusy} onClick={() => void refreshDirectory()}>{directoryBusy ? 'Reading directory…' : 'Discover authorized Judge tasks'}</button></div>
    {directoryNotice && <p>{directoryNotice}</p>}
    {directory.map((item) => <article className="task-card" key={item.escrow}><strong>{item.readyForAssessment ? 'Result available for assessment' : item.decision ? `Decision ${item.decision.verdict}` : item.declined ? 'Declined proposal' : item.accepted ? 'Accepted authorization' : 'Awaiting Worker acceptance'}</strong><small>Escrow {item.escrow} · {item.escrowStatus}</small><small>Session {item.session} · deadline {new Date(item.expiresAt * 1_000).toLocaleString(displayLocale())}</small><button className="outline-button" disabled={busy || autoBusy || Boolean(autoPlan?.enabled)} onClick={() => void load(item.escrow)}>Load this Judge task</button></article>)}
    <div className="task-form"><label>Escrow PDA<input value={escrow} disabled={busy || autoBusy || Boolean(autoPlan?.enabled)} onChange={(event) => { setEscrow(event.target.value); setSnapshot(null); }} /></label><button className="outline-button" disabled={busy || autoBusy || Boolean(autoPlan?.enabled) || !escrow.trim()} onClick={() => void load()}>{busy ? 'Reading…' : 'Load Judge state'}</button></div>
    {snapshot && <><article className="task-card"><strong>Escrow {snapshot.escrow}</strong><small>Employer {snapshot.employer} · Worker {snapshot.worker}</small><small>Task SHA-256 {snapshot.taskHash}</small><small>Result SHA-256 {snapshot.resultHash ?? 'Awaiting delivery'}</small><small>Escrow deadline {new Date(snapshot.deadline * 1_000).toLocaleString(displayLocale())}</small>
      {snapshot.mandate ? <><strong>Judge {snapshot.mandate.judge}</strong><small>Session {snapshot.mandate.session}</small><small>{snapshot.mandate.declined ? 'Declined' : snapshot.mandate.used ? 'Decision recorded' : snapshot.mandate.accepted ? 'Both parties accepted' : 'Awaiting Worker acceptance'} · deadline {new Date(snapshot.mandate.expiresAt * 1_000).toLocaleString(displayLocale())}</small></> : <p>No Judge proposal.</p>}
      {snapshot.decision && <><strong>Decision: {snapshot.decision.verdict} · {snapshot.decision.settled ? 'settled' : 'not settled by Judge path'}</strong><a href={`https://explorer.solana.com/address/${snapshot.decision.address}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">Decision account</a><small>Judgment SHA-256 {snapshot.decision.judgmentHash}</small></>}
    </article>
    <button className="outline-button" disabled={busy || autoBusy || Boolean(autoPlan?.enabled) || !snapshot.resultHash} onClick={() => void readSharedTexts()}>Read verified shared task and result · no transaction</button>
    <div className="task-buttons"><button className="outline-button" onClick={() => void download()}>Download saved judgment body</button><button className="outline-button" onClick={downloadJournal}>Download Judge journal</button><label>Restore Judge body / journal<input disabled={busy || autoBusy || Boolean(autoPlan?.enabled)} type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void restore(file); event.target.value = ''; }} /></label></div>
    {attempts.map((item) => <article className="task-card" key={item.id}><strong>{item.action} · {item.state}</strong><small>Fee payer {item.feePayer} · {item.createdAt}</small>{item.signature && <a href={`https://explorer.solana.com/tx/${item.signature}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">Original Judge transaction</a>}{['signed', 'unknown'].includes(item.state) && <button className="outline-button" disabled={busy} onClick={() => void recover(item.id)}>Check Judge transaction</button>}{item.state === 'prepared' && !item.signature && <button className="outline-button" disabled={busy} onClick={() => void recover(item.id, true)}>Discard unsent Judge review</button>}</article>)}
    {!snapshot.mandate && snapshot.employer === agent && <div className="task-form"><label>Independent Judge Agent PDA<input value={judge} onChange={(event) => setJudge(event.target.value)} /></label><label>Judge Session PDA<input value={judgeSession} onChange={(event) => setJudgeSession(event.target.value)} /></label><label>Judge deadline (local time)<input type="datetime-local" value={expires} onChange={(event) => setExpires(event.target.value)} /></label><button className="primary-button" disabled={busy || !owner} onClick={() => void prepare('propose')}>Review Judge proposal</button></div>}
    {snapshot.mandate && !snapshot.mandate.accepted && !snapshot.mandate.declined && <div className="task-buttons">{snapshot.worker === agent && <button className="primary-button" disabled={busy || !owner} onClick={() => void prepare('accept')}>Review Worker acceptance</button>}<button className="outline-button" disabled={busy || !owner} onClick={() => void prepare('decline')}>Review decline</button></div>}
    {snapshot.mandate?.judge === agent && snapshot.mandate.accepted && !snapshot.mandate.used && <><p>Generate an assessment with the configured Runtime model, or paste its original response. Generation sends the task and result to the model and does not sign or settle.</p><label className="task-result">Exact task text<textarea maxLength={400} value={taskText} onChange={(event) => { setTaskText(event.target.value); setAutoPreview(null); }} /></label><label className="task-result">Exact submitted result text<textarea maxLength={6000} value={resultText} onChange={(event) => { setResultText(event.target.value); setAutoPreview(null); }} /></label><button className="outline-button" disabled={busy || autoBusy || Boolean(autoPlan?.enabled) || !snapshot.resultHash} onClick={() => void assess()}>Generate assessment · no transaction</button><label className="task-result">Exact Runtime Judge response JSON<textarea value={body} onChange={(event) => { setBody(event.target.value); setAutoPreview(null); }} /></label><div className="task-buttons"><button className="primary-button" disabled={busy || autoBusy || Boolean(autoPlan?.enabled) || !owner || !session?.signer} onClick={() => void prepare('record')}>Review signed Judge decision</button></div></>}
    {snapshot.decision && !snapshot.decision.settled && snapshot.decision.verdict !== 'needs_review' && <button className="primary-button" disabled={busy || autoBusy || Boolean(autoPlan?.enabled) || !owner || !snapshot.funded} onClick={() => void prepare('settle')}>Review Judge settlement</button>}
    {snapshot.mandate?.judge === agent && snapshot.mandate.accepted && <article className="task-card"><strong>Automatic Judge for this Escrow</strong><p>Enable before delivery to wait for this Worker’s committed result and verified shared texts, or assess an existing result. The selected Session signs one assessment. Optional settlement pays the Worker in full on pass or refunds the employer in full on fail; needs_review keeps funds. Session reserve pays rent and network fees. Runtime assessment sends the exact texts to its configured model.</p>
      {autoPlan && <><small>{!autoPlan.enabled ? 'Stopped' : session?.automationsPaused ? 'Paused by Session' : !session?.signer ? 'Waiting for Session restore' : session.address !== autoPlan.session ? 'Waiting for the authorized Session' : blocked || busy ? 'Waiting for another operation' : autoBusy ? 'Running automatic Judge step' : autoPlan.resultHash === null ? 'Waiting for verified Worker delivery' : 'Enabled'} · {autoPlan.phase} · {autoPlan.error ?? autoMessage}</small>{autoPlan.enabled && <small>Keep this browser tab open with the authorized Judge Agent and restored Session selected. You can switch workspace pages while this loop continues. Switching Agent or closing the tab stops the loop; an already sent transaction may still confirm.</small>}</>}
      {autoBusy && <small>Automatic Judge is checking this Escrow…</small>}
      <label><input type="checkbox" checked={autoGenerate} disabled={Boolean(autoPlan?.enabled) || busy || autoBusy} onChange={(event) => { setAutoGenerate(event.target.checked); setAutoPreview(null); }} /> Let Runtime generate the assessment from the exact texts above</label>
      <label><input type="checkbox" checked={autoSettle} disabled={Boolean(autoPlan?.enabled) || busy || autoBusy} onChange={(event) => { setAutoSettle(event.target.checked); setAutoPreview(null); }} /> Also submit fixed pass/fail settlement automatically</label>
      {!autoPlan?.enabled && <button className="outline-button" disabled={busy || autoBusy || blocked || !session?.signer || !snapshot.funded} onClick={() => void previewAutomation()}>Prepare automatic Judge authorization</button>}
      {autoPlan?.enabled && <button className="outline-button" onClick={disableAutomation}>Disable automatic Judge</button>}
      {autoPreview && <><strong>Review automatic authorization</strong><small>{NETWORK_LABEL} · Escrow {autoPreview.escrow} · Judge {autoPreview.judge}</small><small>Session {autoPreview.session} · Fee payer {autoPreview.feePayer}</small><small>Escrow amount {autoPreview.amount} atomic {autoPreview.asset} · pass recipient {autoPreview.worker} · fail refund recipient {autoPreview.employer}</small>{autoPreview.artifact && <small>Assessment verdict {JSON.parse(autoPreview.artifact).verdict} · SHA-256 {JSON.parse(autoPreview.artifact).judgmentHash} · {JSON.parse(autoPreview.artifact).summary}</small>}<small>Task SHA-256 {autoPreview.taskHash} · Result SHA-256 {autoPreview.resultHash}</small><small>{autoPreview.generate ? 'Runtime will generate the assessment and the Session will sign its verified verdict.' : 'Only the provided exact assessment will be signed.'} · {autoPreview.settle ? 'Pass pays Worker; fail refunds employer; needs_review moves no funds.' : 'Settlement requires a separate review.'}</small><small>Decision rent ceiling {autoPreview.recordRentLimit} lamports · settlement account rent ceiling {autoPreview.settleRentLimit} lamports · each network fee ≤ {autoPreview.maxFeeLamports} lamports, at most two transactions.</small><small>Deadline {new Date(autoPreview.expiresAt * 1_000).toLocaleString(displayLocale())}. Keep this page open with the authorized Session restored. Unknown attempts stop automation.</small><button className="primary-button" disabled={busy || blocked} onClick={() => void enableAutomation()}>Enable exactly this automatic Judge authorization</button><button className="outline-button" onClick={() => setAutoPreview(null)}>Cancel automatic authorization</button></>}
    </article>}
    </>}
    <p>Manual actions require separate transaction review. Signed Judge actions must be checked using their saved original transaction before another attempt. Automatic work runs only after explicit authorization, with this page open and its selected Session available. Existing Owner release, refund and mutual settlement paths remain available.</p>
  </section>;
}
