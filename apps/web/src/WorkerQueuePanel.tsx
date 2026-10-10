/** @jsxImportSource ./i18n */
import { displayLocale } from './i18n/locale';
import { EXPLORER_QUERY } from './lib/chainNetwork';
import { useEffect, useState } from 'react';
import { ServiceDiscoveryPanel, type DiscoveredService } from './ServiceDiscoveryPanel';
import { PROGRAM_ADDRESS } from './lib/agentOs';

type ToolRequest = { skill: string; asset: 'SOL' | 'USDC'; prompt: string; endpoint: string; maxAmount: string };
type Skill = { address: string; id: string; active: boolean; priceLamports: string; priceUsdc: string };
type Job = {
  escrow: string; workerAgent: string; programId: string; taskHash: string; task: string;
  state: string; result: string | null; resultHash: string | null; limitations: string[];
  toolRequests: ToolRequest[]; tools: { id: string; state: 'pending' | 'dispatched' | 'complete'; execution: string | null; taskId: string | null; actionId: string | null }[];
  error: string | null; attempts: number; updatedAt: string;
};
const states = new Set(['waiting_tools', 'accepted', 'running', 'needs_evidence', 'ready', 'interrupted', 'failed', 'delivered', 'closed']);
const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

function formatToolPrice(value: string, asset: 'SOL' | 'USDC') {
  const decimals = asset === 'SOL' ? 9 : 6; const scale = 10n ** BigInt(decimals); const amount = BigInt(value);
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${amount / scale}${fraction ? `.${fraction}` : ''}`;
}

export function WorkerQueuePanel({ skills, onTools, escrow, workerAgent, taskHash, task, evidence, sourceExecutions, onUse }: {
  skills: Skill[]; onTools: (enabled: boolean) => void; escrow: string; workerAgent: string; taskHash: string; task: string; evidence: string; sourceExecutions: string[];
  onUse: (task: string, result: string) => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [archiveReview, setArchiveReview] = useState(false), [archived, setArchived] = useState(false), [archiveMessage, setArchiveMessage] = useState('');
  const [toolRequests, setToolRequests] = useState<ToolRequest[]>([]);
  const [toolSkill, setToolSkill] = useState(''); const [toolAsset, setToolAsset] = useState<'SOL' | 'USDC'>('SOL');
  const [toolEndpoint, setToolEndpoint] = useState(''); const [toolPrompt, setToolPrompt] = useState('');
  function chooseDiscoveredTool(service: DiscoveredService, asset: 'SOL' | 'USDC') {
    if (busy || job) return;
    const registered = skills.find(item => item.address === service.address && item.active);
    if (!registered || registered.priceLamports !== service.priceLamports || registered.priceUsdc !== service.priceUsdc) {
      setError('The discovered Skill differs from this editor’s registry snapshot. Refresh the Agent page before selecting it.'); return;
    }
    setToolSkill(service.address); setToolAsset(asset); setToolEndpoint(service.endpoint); setError('');
  }
  async function archiveJob() {
    if (!job || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/worker/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ escrow, workerAgent, updatedAt: job.updatedAt }), signal: AbortSignal.timeout(30000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Archive failed.');
      if (body.archived !== true || body.escrow !== escrow || body.workerAgent !== workerAgent || typeof body.archiveFile !== 'string' || !/^[a-f0-9]{64}$/.test(body.archiveSha256)) throw new Error('Archive response mismatch; refresh before retrying.');
      setArchived(true); setJob(null); setArchiveReview(false); setArchiveMessage(`Archived: ${body.archiveFile}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Outcome unknown; refresh before retrying.'); }
    finally { setBusy(false); }
  }
  function addTool() {
    const selected = skills.find((item) => item.address === toolSkill && item.active);
    const maxAmount = selected ? toolAsset === 'SOL' ? selected.priceLamports : selected.priceUsdc : '0';
    if (!selected || BigInt(maxAmount) <= 0n || !toolEndpoint.trim() || !(toolPrompt || task).trim()) { setError('Select a paid registered Skill, its endpoint, and a request.'); return; }
    if (toolRequests.length + sourceExecutions.length >= 3) { setError('At most three tool requests and existing proofs are supported.'); return; }
    setToolRequests((items) => [...items, { skill: selected.address, asset: toolAsset, prompt: (toolPrompt || task).trim(), endpoint: toolEndpoint.trim(), maxAmount }]); setError('');
  }
  async function validate(value: unknown): Promise<Job> {
    if (!value || typeof value !== 'object') throw new Error('Invalid Worker job response.');
    const item = value as Job;
    if (item.escrow !== escrow || item.workerAgent !== workerAgent || item.programId !== PROGRAM_ADDRESS || item.taskHash !== taskHash
      || typeof item.task !== 'string' || !item.task || item.task.length > 400 || await hash(item.task) !== taskHash
      || !Array.isArray(item.toolRequests) || !Array.isArray(item.tools) || item.toolRequests.length > 3 || item.tools.length !== item.toolRequests.length || item.tools.some((tool) => !tool || !['pending', 'dispatched', 'complete'].includes(tool.state))
      || !states.has(item.state) || !Array.isArray(item.limitations) || item.limitations.length > 6 || !item.limitations.every((text) => typeof text === 'string' && text.length <= 500)
      || !Number.isInteger(item.attempts) || item.attempts < 0 || item.attempts > 100 || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))
      || !(item.error === null || typeof item.error === 'string' && item.error.length <= 500)
      || !((item.result === null && item.resultHash === null) || typeof item.result === 'string' && item.result.length > 0 && item.result.length <= 400 && await hash(item.result) === item.resultHash)) throw new Error('Worker job does not match this Escrow or its saved commitments.');
    return item;
  }
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(`/api/worker/jobs?worker=${encodeURIComponent(workerAgent)}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not restore Worker queue.');
        if (body.programId !== PROGRAM_ADDRESS || !Array.isArray(body.jobs)) throw new Error('Worker queue Program mismatch.');
        const found = body.jobs.find((item: { escrow?: string }) => item?.escrow === escrow);
        const restored = found ? await validate(found) : null;
        if (active) { setJob(restored); setError(''); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Worker queue unavailable.'); }
      finally { if (active) timer = setTimeout(() => void poll(), 3000); }
    }
    void poll(); return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [escrow, workerAgent, taskHash]);
  async function update(operation: 'jobs' | 'retry' | 'reconcile' | 'tool-complete' | 'tool-release', toolId?: string) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/worker/${operation}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operation === 'jobs' ? { escrow, workerAgent, task, evidence, sourceExecutions, toolRequests } : operation === 'tool-complete' || operation === 'tool-release' ? { escrow, toolId } : { escrow }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not update Worker job.');
      setJob(await validate(body.job));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Worker queue unavailable.'); }
    finally { setBusy(false); }
  }
  return <section className="review-details" aria-live="polite">
    <strong>Persistent Worker execution</strong>
    <small>Accept locally to run the configured text executor in the background. Inputs and results stay in this Runtime’s queue across refreshes. It sends the task, notes and selected Skill excerpts to OpenAI. Acceptance grants no chain authority; delivery still requires wallet review.</small>
    {!job && !archived && <ServiceDiscoveryPanel selectionMode="worker-tool" canPay={toolRequests.length + sourceExecutions.length < 3} blocked={busy} onChoose={chooseDiscoveredTool} />}
    {!job && !archived && <small>Catalog selection fills the tool editor only. Review the request and add it explicitly; acceptance and paid-tool authorization remain separate steps.</small>}
    {!job && !archived && <fieldset disabled={busy}><legend>Optional paid Skill requests</legend><small>Choose up to three tools and existing proofs in total. The quoted price is each request’s ceiling. Automatic execution requires separate opt-in and a Worker Task budget tied to this Escrow’s exact task text.</small><select value={toolSkill} onChange={(event) => setToolSkill(event.target.value)}><option value="">Choose registered Skill</option>{skills.filter((skill) => skill.active).map((skill) => <option value={skill.address} key={skill.address}>{skill.id}</option>)}</select><select value={toolAsset} onChange={(event) => setToolAsset(event.target.value as 'SOL' | 'USDC')}><option>SOL</option><option>USDC</option></select><label>Registered endpoint<input value={toolEndpoint} onChange={(event) => setToolEndpoint(event.target.value)} maxLength={2000} /></label><label>Tool request<textarea value={toolPrompt} onChange={(event) => setToolPrompt(event.target.value)} maxLength={1000} placeholder="Defaults to the exact Worker task" /></label><button type="button" className="outline-button" onClick={addTool}>Add tool at quoted price ceiling</button>{toolRequests.map((request, index) => <div key={index}>{skills.find((skill) => skill.address === request.skill)?.id} · {request.asset} · cap {formatToolPrice(request.maxAmount, request.asset)} · {request.prompt}<button type="button" className="outline-button" onClick={() => setToolRequests((items) => items.filter((_, position) => position !== index))}>Remove</button></div>)}</fieldset>}
    {!job && !archived && <button type="button" className="outline-button" disabled={busy || !task.trim()} onClick={() => void update('jobs')}>{busy ? 'Accepting…' : 'Accept and execute in background'}</button>}
    {job && <>
      <div>Status: {job.state} · attempts {job.attempts}</div>
      {['closed', 'delivered'].includes(job.state) && !job.tools.some(tool => tool.state === 'dispatched') && <div><button type="button" className="outline-button" disabled={busy} onClick={() => setArchiveReview(true)}>Review archive</button>{archiveReview && <><p>Save the full job to a local archive, then remove it from the active queue. Runtime will verify final Escrow settlement. Preserve worker-archives separately; this action cannot replay tools or delivery.</p><small>Escrow {escrow} · reviewed update {job.updatedAt}</small><button type="button" disabled={busy} onClick={() => void archiveJob()}>Archive terminal Worker job</button><button type="button" disabled={busy} onClick={() => setArchiveReview(false)}>Cancel</button></>}</div>}

      {job.toolRequests.length > 0 && <section><small>Paid tools are immutable after acceptance. dispatched means an attempt is reserved; it must be reconciled before any retry.</small><button type="button" className="outline-button" onClick={() => onTools(true)}>Enable paid tools for this Escrow</button><button type="button" className="outline-button" onClick={() => onTools(false)}>Disable paid tools</button>{job.tools.map((tool, index) => <div key={tool.id}><strong>{job.toolRequests[index].skill} · {tool.state}</strong><small>{job.toolRequests[index].prompt}</small>{tool.execution && <a href={`https://explorer.solana.com/address/${tool.execution}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">Saved payment Execution</a>}{!tool.execution && tool.state === 'dispatched' && <button type="button" className="outline-button" disabled={busy} onClick={() => void update('tool-release', tool.id)}>Release reservation with no payment binding</button>}{tool.execution && tool.state === 'dispatched' && <button type="button" className="outline-button" disabled={busy} onClick={() => void update('tool-complete', tool.id)}>Verify recovered tool proof and continue</button>}</div>)}</section>}

      <small>Updated {new Date(job.updatedAt).toLocaleString(displayLocale())}</small>
      {job.error && <p>{job.error}</p>}
      {job.result && <p>{job.result}</p>}
      {job.limitations.length > 0 && <ul>{job.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>}
      {job.state === 'ready' && job.result && <button type="button" className="outline-button" onClick={() => onUse(job.task, job.result!)}>Use saved result for review</button>}
      {['interrupted', 'failed'].includes(job.state) && <><small>Retry makes another model request and may incur API charges. Review the original task and error first.</small><button type="button" className="outline-button" disabled={busy} onClick={() => void update('retry')}>Retry original execution</button></>}
      {!['running', 'accepted'].includes(job.state) && <button type="button" className="outline-button" disabled={busy} onClick={() => void update('reconcile')}>Check on-chain delivery status</button>}
    </>}
    {archiveMessage && <p role="status">{archiveMessage}</p>}
    {error && <div className="inline-error">{error}</div>}
  </section>;
}
