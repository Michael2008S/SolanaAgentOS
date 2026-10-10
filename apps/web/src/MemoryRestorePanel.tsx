/** @jsxImportSource ./i18n */
import { NETWORK_IDENTITY, NETWORK_LABEL } from './lib/chainNetwork';
import { useState } from 'react';
import { address, getAddressEncoder } from '@solana/kit';
import { PROGRAM_ADDRESS } from './lib/agentOs';
type Entry = { programId?: string; agent: string; execution: string; title: string; tags: string[]; content: string; contentHash: string; storedAt: string; source?: string };
const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export function MemoryRestorePanel({ agent, onRestored }: { agent: string; onRestored: () => void }) {
  const [entry, setEntry] = useState<Entry | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function load(file: File) {
    setEntry(null); setMessage(''); setBusy(true);
    try {
      if (file.size > 400000) throw new Error('Archive exceeds 400 KB. Select a single-record archive.');
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
      if (!body || body.format !== 'agentos-memory-archive' || body.version !== 1 || body.network !== NETWORK_IDENTITY || body.programId !== PROGRAM_ADDRESS || body.agent !== agent || body.verification !== 'storage-hashes-only' || typeof body.archivedAt !== 'string' || !Number.isFinite(Date.parse(body.archivedAt)) || Object.keys(body).some(key => !['format','version','network','programId','agent','archivedAt','verification','entry'].includes(key))) throw new Error('Choose an archive for this Agent and Program.');
      const item = body.entry as Entry;
      if (!item || Object.keys(item).some(key => !['programId','agent','execution','title','tags','content','contentHash','storedAt','source'].includes(key)) || item.agent !== agent || (item.programId !== undefined && item.programId !== PROGRAM_ADDRESS) || typeof item.execution !== 'string' || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120 || !Array.isArray(item.tags) || item.tags.length > 10 || !item.tags.every(tag => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= 48) || typeof item.content !== 'string' || !item.content || new TextEncoder().encode(item.content).length > 65536 || !/^[a-f0-9]{64}$/.test(item.contentHash) || typeof item.storedAt !== 'string' || !Number.isFinite(Date.parse(item.storedAt)) || (item.source !== undefined && !['skill','escrow'].includes(item.source))) throw new Error('Invalid archived record.');
      getAddressEncoder().encode(address(item.execution));
      if (await hash(item.content) !== item.contentHash) throw new Error('Archive content hash mismatch.');
      setEntry(item);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not read archive.'); }
    finally { setBusy(false); }
  }
  async function restore() {
    if (!entry || busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, execution: entry.execution, title: entry.title, content: entry.content, tags: entry.tags }), signal: AbortSignal.timeout(30000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not restore Memory.');
      if (body.agent !== agent || body.execution !== entry.execution || body.contentHash !== entry.contentHash || body.programId !== PROGRAM_ADDRESS || body.network !== NETWORK_IDENTITY) throw new Error('Restore response mismatch. Refresh before retrying.');
      setMessage('Memory saved after live Execution verification.'); setEntry(null); onRestored();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Outcome unknown. Refresh before retrying.'); }
    finally { setBusy(false); }
  }
  return <details><summary>Restore an archived Memory</summary><p>Select one archive, review its exact text, then recheck the {NETWORK_LABEL} Execution before saving. No transaction or model call is sent. Exported multi-record snapshots are not accepted here.</p><input type="file" accept=".json,application/json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void load(file); }} />{entry && <div><strong>{entry.title}</strong><small>Execution {entry.execution} · SHA-256 {entry.contentHash}</small><pre className="skill-result-content">{entry.content}</pre><button type="button" className="outline-button" disabled={busy} onClick={() => void restore()}>{busy ? 'Verifying…' : 'Verify on chain and restore'}</button><button type="button" disabled={busy} onClick={() => setEntry(null)}>Discard review</button></div>}{message && <p role="status">{message}</p>}</details>;
}
