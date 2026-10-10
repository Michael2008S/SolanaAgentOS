/** @jsxImportSource ./i18n */
import { EXPLORER_QUERY, NETWORK_STORAGE } from './lib/chainNetwork';
import { useEffect, useState } from 'react';
import { useClient } from '@solana/react';
import type { AppClient } from './providers';
import { PROGRAM_ADDRESS } from './lib/agentOs';
import { readSharedJudgeTexts } from './lib/judgeClient';
import { ensureConfiguredNetwork } from './lib/chainNetwork';
import { readDeliveryJournal, verifyDeliveryTexts, importDeliveryJournal, updateDelivery, reconcileDelivery, automaticDeliveries, enableAutomaticDelivery, automaticWorkerTools, enableAutomaticWorkerTools, type DeliveryCheckpoint } from './lib/workerDeliveryJournal';

export function WorkerDeliveryRecovery({ worker, onRestore }: { worker: string; onRestore: (item: DeliveryCheckpoint) => void }) {
  const client = useClient<AppClient>();
  const [records, setRecords] = useState<DeliveryCheckpoint[]>([]);
  const [settings, setSettings] = useState<{ escrow: string; session: string }[]>([]);
  const [toolSettings, setToolSettings] = useState<{ escrow: string; session: string }[]>([]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [journalError, setJournalError] = useState('');
  const [message, setMessage] = useState('');
  const refresh = () => { try { setRecords(readDeliveryJournal(worker)); setSettings(automaticDeliveries(worker)); setToolSettings(automaticWorkerTools(worker)); setJournalError(''); } catch (cause) { setJournalError(cause instanceof Error ? cause.message : 'Delivery journal unavailable.'); } };
  useEffect(() => { setError(''); setMessage(''); refresh(); const timer = setInterval(refresh, 3000); return () => clearInterval(timer); }, [worker]);
  async function check(item: DeliveryCheckpoint) {
    setBusy(true); setError('');
    try {
      if (!navigator.locks) throw new Error('Recovery requires browser coordination locks.');
      await navigator.locks.request(`agentos:delivery:${PROGRAM_ADDRESS}:${item.escrow}`, async () => {
        const current = readDeliveryJournal(worker).find((record) => record.id === item.id);
        if (current) await reconcileDelivery(client, current);
      });
      refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reconcile the saved delivery.'); }
    finally { setBusy(false); }
  }
  async function discard(item: DeliveryCheckpoint) {
    setError(''); setMessage('');
    try {
      if (!navigator.locks) throw new Error('Recovery requires browser coordination locks.');
      await navigator.locks.request(`agentos:delivery:${PROGRAM_ADDRESS}:${item.escrow}`, async () => {
        const current = readDeliveryJournal(worker).find((record) => record.id === item.id);
        if (current?.state === 'prepared' && !current.signature) updateDelivery(current, { state: 'cancelled' });
      }); refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not discard the unsent review.'); }
  }
  async function share(item: DeliveryCheckpoint) {
    setBusy(true); setError(''); setMessage('');
    try {
      await ensureConfiguredNetwork(client);
      await verifyDeliveryTexts(item);
      const response = await fetch('/api/escrow/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ escrow: item.escrow, task: item.task, result: item.result }), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not share the saved Worker result.');
      const shared = await readSharedJudgeTexts(client, item.escrow);
      if (shared.task !== item.task || shared.result !== item.result) throw new Error('Shared texts differ from this saved delivery.');
      setMessage('Saved result shared and verified against the current chain commitments. A waiting automatic Judge can continue. No transaction was signed or sent.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not share the saved Worker result.'); }
    finally { setBusy(false); }
  }
  function download() {
    const data = JSON.stringify({ format: 'agentos-worker-delivery-journal', version: 1, programId: PROGRAM_ADDRESS, network: NETWORK_STORAGE, worker, records: readDeliveryJournal(worker) }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `worker-delivery-${worker}.json`; link.click(); URL.revokeObjectURL(url);
  }

  return <section className="review-details"><strong>Saved Worker delivery checkpoints</strong><small>Signature and exact texts are saved before broadcast. Recovery checks the original transaction; it never resends it.</small>
    <button className="outline-button" disabled={busy} onClick={() => { try { download(); } catch (cause) { setError(String(cause)); } }}>Download delivery journal</button>
    <label>Restore delivery journal<input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void (async () => { try { if (file.size > 520_000) throw new Error('Delivery backup is too large.'); importDeliveryJournal(worker, await file.text()); refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not import delivery journal.'); } })(); }} /></label>
    {settings.map((item) => <div key={item.escrow}><small>Automatic delivery enabled: {item.escrow} · Session {item.session}</small><button className="outline-button" onClick={() => { enableAutomaticDelivery(worker, item.escrow, item.session, false); refresh(); }}>Disable automatic delivery</button></div>)}
    {toolSettings.map((item) => <div key={item.escrow}><small>Paid Worker tools enabled: {item.escrow} · Session {item.session}</small><button className="outline-button" onClick={() => { enableAutomaticWorkerTools(worker, item.escrow, item.session, false); refresh(); }}>Disable paid tools</button></div>)}
    {records.slice().reverse().map((item) => <div key={item.id}><strong>{item.state} · {item.escrow}</strong><p>{item.result}</p><small>Fee payer: {item.feePayer}</small>
      {item.signature && <a href={`https://explorer.solana.com/tx/${item.signature}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">Saved transaction</a>}
      {['signed', 'unknown'].includes(item.state) && <button className="outline-button" disabled={busy} onClick={() => void check(item)}>Check saved delivery</button>}
      {item.state === 'prepared' && <button className="outline-button" disabled={busy} onClick={() => void discard(item)}>Discard unsent review</button>}
      {item.state === 'confirmed' && <button className="outline-button" disabled={busy} onClick={() => void verifyDeliveryTexts(item).then(() => onRestore(item)).catch((cause) => setError(cause instanceof Error ? cause.message : 'Saved result text is invalid.'))}>Restore confirmed result receipt</button>}
      {item.state === 'confirmed' && <><button className="outline-button" disabled={busy} onClick={() => void share(item)}>Share saved result with local Runtime</button><small>Shares the exact task and result text with local Runtime users after hash checks. Use this if automatic delivery succeeded but its text handoff failed. It does not repeat delivery or settle funds.</small></>}
    </div>)}
    {error && <div className="inline-error">{error}</div>}
    {journalError && <div className="inline-error">{journalError}</div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
