/** @jsxImportSource ./i18n */
import { EXPLORER_QUERY, NETWORK_IDENTITY } from './lib/chainNetwork';
import { useState } from 'react';
import { address, getAddressEncoder } from '@solana/kit';
import { PROGRAM_ADDRESS, formatUsdcBaseUnits } from './lib/agentOs';
type Outcome = { address: string; workerAgent: string; agent: string; id: string; status: string; amount: string; asset: 'SOL' | 'USDC'; taskHash: string; resultHash: string | null };
const key = (value: unknown) => { try { if (typeof value !== 'string') return false; getAddressEncoder().encode(address(value)); return true; } catch { return false; } };
const atomic = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
export function ReputationOutcomes({ worker }: { worker: string }) {
  const [records, setRecords] = useState<Outcome[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  async function read() {
    if (busy) return;
    setBusy(true); setError(''); setLoaded(false); setRecords([]);
    try {
      const response = await fetch(`/api/on-chain/escrows?worker=${encodeURIComponent(worker)}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const reader = response.body?.getReader(); if (!reader) throw new Error('No outcome response.');
      const parts: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2000000) { await reader.cancel(); throw new Error('Outcome response exceeds 2 MB.'); } parts.push(part.value); } } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!response.ok) throw new Error(body.error || 'Could not read outcomes.');
      if (body.programId !== PROGRAM_ADDRESS || body.network !== NETWORK_IDENTITY || !Array.isArray(body.escrows) || body.escrows.length > 1000 || body.count !== body.escrows.length) throw new Error('Invalid outcome envelope.');
      const seen = new Set<string>();
      for (const item of body.escrows as Outcome[]) {
        if (!item || !key(item.address) || !key(item.agent) || item.workerAgent !== worker || seen.has(item.address) || !atomic(item.id) || !atomic(item.amount) || !['SOL', 'USDC'].includes(item.asset) || !['funded', 'released', 'refunded', 'cancelled', 'settlement_proposed', 'settled'].includes(item.status) || !/^[a-f0-9]{64}$/.test(item.taskHash) || !(item.resultHash === null || /^[a-f0-9]{64}$/.test(item.resultHash))) throw new Error('Invalid outcome record.');
        seen.add(item.address);
      }
      setRecords(body.escrows); setLoaded(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read outcomes.'); }
    finally { setBusy(false); }
  }
  return <details><summary>Inspect Worker Escrow outcomes</summary><p>Current account snapshots read through Runtime. Refunded does not distinguish Judge failure from expiry; released does not distinguish Owner release from Judge pass. These rows alone do not prove score changes.</p><button type="button" className="outline-button" disabled={busy} onClick={() => void read()}>{busy ? 'Reading…' : 'Read outcome accounts'}</button>{error && <p role="alert">{error}</p>}{loaded && <p>{records.length} records{records.length >= 1000 ? ' · registry may be truncated' : ''}. Verify original transactions for reputation attribution.</p>}{records.map(item => <div key={item.address}><strong>#{item.id} · {item.status}</strong><small>{item.asset === 'USDC' ? formatUsdcBaseUnits(item.amount) + ' USDC' : item.amount + ' lamports'} · Employer {item.agent}</small><small>Task SHA-256 {item.taskHash} · Result {item.resultHash ?? 'not submitted'}</small><a href={`https://explorer.solana.com/address/${item.address}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">Inspect Escrow and transactions</a></div>)}</details>;
}
