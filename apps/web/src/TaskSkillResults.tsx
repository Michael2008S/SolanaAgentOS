/** @jsxImportSource ./i18n */
import { EXPLORER_QUERY, NETWORK_IDENTITY } from './lib/chainNetwork';
import { useState } from 'react';
import { PROGRAM_ADDRESS } from './lib/agentOs';
const atomic = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
type Result = { taskAction: string; actionId: string; execution: string; executionId: string; asset: string; amount: string; inputHash: string; outputHash: string | null; resultRecorded: boolean };
export function TaskSkillResults({ agent, task }: { agent: string; task: string }) {
  const [items, setItems] = useState<Result[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  async function read(after?: string) {
    if (busy) return; setBusy(true); setMessage(''); if (after === undefined) { setItems([]); setCursor(null); }
    try {
      const response = await fetch(`/api/on-chain/task-skill-results?agent=${encodeURIComponent(agent)}&task=${encodeURIComponent(task)}${after === undefined ? '' : `&afterActionId=${after}`}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not read results.');
      if (body.programId !== PROGRAM_ADDRESS || body.network !== NETWORK_IDENTITY || body.agent !== agent || body.task !== task || !Array.isArray(body.results) || body.results.length > 100 || body.count !== body.results.length || typeof body.truncated !== 'boolean' || typeof body.registryTruncated !== 'boolean' || !Number.isInteger(body.inspectedActions) || body.inspectedActions < body.count || body.inspectedActions > 100 || body.afterActionId !== (after ?? null) || !atomic(body.pendingSkillResults) || !(body.nextCursor === null || atomic(body.nextCursor) && (after === undefined || BigInt(body.nextCursor) > BigInt(after)))) throw new Error('Invalid result response.');
      for (const item of body.results as Result[]) if (!item || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(item.execution) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(item.taskAction) || !atomic(item.actionId) || !atomic(item.executionId) || (after !== undefined && BigInt(item.actionId) <= BigInt(after)) || !['SOL','USDC'].includes(item.asset) || !atomic(item.amount) || item.amount === '0' || !/^[a-f0-9]{64}$/.test(item.inputHash) || typeof item.resultRecorded !== 'boolean' || !(item.outputHash === null || /^[a-f0-9]{64}$/.test(item.outputHash)) || item.resultRecorded !== (item.outputHash !== null)) throw new Error('Invalid result row.');
      if (new Set(body.results.map((item: Result) => item.taskAction)).size !== body.results.length || after !== undefined && body.results.some((item: Result) => items.some(previous => previous.taskAction === item.taskAction))) throw new Error('Duplicate page entries. Restart the read.');
      const combined = after === undefined ? body.results : [...items, ...body.results];
      if (combined.length > 1000) throw new Error('Result view exceeds 1,000 rows.');
      setItems(combined); setCursor(body.nextCursor); setMessage(`${combined.length} Skill receipts loaded${body.nextCursor ? ' · more action pages available' : ''}${body.registryTruncated ? ' · registry limited to 1,000 actions; not a complete list' : ''}. Task pending counter: ${body.pendingSkillResults}`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not read results.'); }
    finally { setBusy(false); }
  }
  return <details><summary>Inspect paid Skill result commitments</summary><p>Read-only discovery. Original prompt, Skill address, endpoint and payment signature are still needed for saved Provider result recovery; do not repeat payment.</p><button type="button" className="outline-button" disabled={busy} onClick={() => void read()}>{busy ? 'Reading…' : 'Read Task Skill receipts'}</button>{cursor && <button type="button" className="outline-button" disabled={busy} onClick={() => void read(cursor)}>Read next action page</button>}{message && <p role="status">{message}</p>}{items.map(item => <div key={item.taskAction}><strong>Action #{item.actionId} · {item.resultRecorded ? 'Result recorded' : 'Result not recorded'}</strong><small>{item.amount} {item.asset === 'SOL' ? 'lamports' : 'USDC base units'} · Input SHA-256 {item.inputHash}</small><small>Output {item.outputHash ?? 'missing'}</small><a href={`https://explorer.solana.com/address/${item.execution}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">Execution and original transactions</a></div>)}</details>;
}
