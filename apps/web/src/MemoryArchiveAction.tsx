/** @jsxImportSource ./i18n */
import { useState } from 'react';
export function MemoryArchiveAction({ agent, execution, contentHash, onArchived }: { agent: string; execution: string; contentHash: string; onArchived: () => void }) {
  const [review, setReview] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function archive() {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/memory/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, execution, contentHash }), signal: AbortSignal.timeout(30000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Archive failed. Refresh before retrying.');
      if (body.archived !== true || body.execution !== execution || body.contentHash !== contentHash || typeof body.archiveFile !== 'string' || !/^[a-f0-9]{64}$/.test(body.archiveSha256)) throw new Error('Archive response invalid. Refresh before retrying.');
      setMessage(`Archived locally: ${body.archiveFile}`); setReview(false); onArchived();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Outcome unknown. Refresh before retrying.'); }
    finally { setBusy(false); }
  }
  return <div><button type="button" className="outline-button" disabled={busy} onClick={() => setReview(true)}>Review archive</button>{review && <div><p>Save an exact local archive file, then remove this record from active Memory. It will stop appearing in search and Worker evidence lookup. Runtime rejects sources used by running or unsettled Worker jobs. Chain accounts remain unchanged. Preserve the archive directory separately from database backups.</p><small>Execution {execution} · SHA-256 {contentHash}</small><button type="button" className="outline-button" disabled={busy} onClick={() => void archive()}>{busy ? 'Archiving…' : 'Archive and remove from active Memory'}</button><button type="button" disabled={busy} onClick={() => setReview(false)}>Cancel</button></div>}{message && <p role="status">{message}</p>}</div>;
}
