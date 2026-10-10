/** @jsxImportSource ./i18n */
import { useState } from 'react';
import { address, getAddressEncoder } from '@solana/kit';
import { PROGRAM_ADDRESS, formatUsdcBaseUnits, solToLamports, usdcToBaseUnits } from './lib/agentOs';
import { EXPLORER_QUERY, NETWORK_IDENTITY, WEB_NETWORK } from './lib/chainNetwork';
import { ReputationOutcomes } from './ReputationOutcomes';
import { backgroundApiUrl } from './lib/backgroundApi';
import { canonicalJson } from '../../runtime/src/canonical-json';
import type { WorkerProfile } from '../../runtime/src/worker-profiles';
import type { RecentReputation } from '../../runtime/src/worker-reputation';
type Worker = { address: string; owner: string; name: string; active: boolean; profile: WorkerProfile | null; profileError: string | null; recentReputation: RecentReputation };
const key = (value: unknown) => { try { if (typeof value !== 'string') return false; getAddressEncoder().encode(address(value)); return true; } catch { return false; } };
async function json(response: Response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Response has no body.');
  const parts: Uint8Array[] = []; let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 1000000) { await reader.cancel(); throw new Error('Marketplace response exceeds 1 MB.'); } parts.push(chunk.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!response.ok) throw new Error(result.error ?? 'Marketplace request failed.'); return result;
}
export function WorkerMarketplacePanel({ ownAgent, owner, blocked, onHire, sign }: { ownAgent?: string; owner?: string; blocked: boolean; onHire: (worker: string) => void; sign?: (message: Uint8Array) => Promise<Uint8Array> }) {
  const [workers, setWorkers] = useState<Worker[]>([]), [query, setQuery] = useState(''), [tag, setTag] = useState(''), [available, setAvailable] = useState(false);
  const [searchLanguage, setSearchLanguage] = useState(''), [searchModel, setSearchModel] = useState(''), [searchAsset, setSearchAsset] = useState<'SOL' | 'USDC'>('SOL'), [searchBudget, setSearchBudget] = useState(''), [searchConfidence, setSearchConfidence] = useState('');
  const [cursor, setCursor] = useState<string | null>(null), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [description, setDescription] = useState(''), [tags, setTags] = useState(''), [languages, setLanguages] = useState(''), [models, setModels] = useState('');
  const [availability, setAvailability] = useState<'available' | 'busy' | 'offline'>('available'), [sol, setSol] = useState('0.001'), [usdc, setUsdc] = useState('0');
  async function read(next?: string) {
    if (busy) return; setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ q: query, tag, available: String(available), ...(next ? { cursor: next } : {}) });
      if (searchLanguage.trim()) params.set('language', searchLanguage.trim());
      if (searchModel.trim()) params.set('model', searchModel.trim());
      if (owner) params.set('employerOwner', owner);
      if (searchBudget.trim()) {
        const decimals = searchAsset === 'SOL' ? 9 : 6, match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(searchBudget.trim());
        if (!match || (match[2]?.length ?? 0) > decimals) throw new Error('Enter a valid maximum starting price.');
        const amount = BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] ?? '').padEnd(decimals, '0'));
        if (amount > 18446744073709551615n) throw new Error('Maximum starting price exceeds the supported amount.');
        params.set('asset', searchAsset); params.set('maxAmount', amount.toString());
      }
      if (searchConfidence.trim()) {
        if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(searchConfidence.trim()) || Number(searchConfidence) > 100) throw new Error('Confidence must be between 0 and 100 percent.');
        params.set('minimumConfidence', String(Number(searchConfidence) / 100));
      }
      const data = await json(await fetch('/api/marketplace/workers?' + params, { cache: 'no-store', signal: AbortSignal.timeout(30000) }));
      if (data.programId !== PROGRAM_ADDRESS || data.network !== NETWORK_IDENTITY || data.genesis !== WEB_NETWORK.genesisHash || data.commitment !== 'finalized' || !Array.isArray(data.workers) || data.workers.length > 50 || data.count !== data.workers.length || !Number.isInteger(data.totalMatched) || typeof data.truncated !== 'boolean' || !(data.nextCursor === null || typeof data.nextCursor === 'string' && /^wr2:[a-f0-9]{64}:[1-9][0-9]{0,11}:[1-9][0-9]{0,4}$/.test(data.nextCursor))) throw new Error('Worker directory belongs to another chain or is invalid.');
      const seen = new Set<string>();
      for (const worker of data.workers as Worker[]) {
        const rep = worker.recentReputation;
        if (!worker || !key(worker.address) || !key(worker.owner) || seen.has(worker.address) || typeof worker.name !== 'string' || worker.name.length > 120 || typeof worker.active !== 'boolean' || !rep || !(rep.quality === null || Number.isFinite(rep.quality) && rep.quality >= 0 && rep.quality <= 100) || !Number.isFinite(rep.confidence) || rep.confidence < 0 || rep.confidence > 1 || !Number.isFinite(rep.effectiveSamples) || !Number.isInteger(rep.independentEmployers) || !Number.isInteger(rep.independentJudges) || !Array.isArray(rep.evidence) || rep.evidence.length > 50 || !rep.evidence.every(item => key(item.escrow) && key(item.decision) && ['pass','fail'].includes(item.verdict) && Number.isSafeInteger(item.recordedAt) && Number.isFinite(item.weight) && item.weight >= 0 && item.weight <= 1) || typeof rep.evidenceTruncated !== 'boolean' || !Array.isArray(rep.risks) || !rep.risks.every(risk => typeof risk === 'string' && risk.length < 80)) throw new Error('Invalid Worker or reputation record.');
        seen.add(worker.address);
        if (worker.profile) {
          const { payload, signature } = worker.profile;
          if (payload?.domain !== 'agentos-worker-profile-v1' || payload.agent !== worker.address || payload.owner !== worker.owner || payload.programId !== PROGRAM_ADDRESS || payload.genesis !== WEB_NETWORK.genesisHash || payload.network !== WEB_NETWORK.cluster || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now() / 1000 || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid signed Worker profile.');
          const publicKey = await crypto.subtle.importKey('raw', new Uint8Array(getAddressEncoder().encode(address(worker.owner))), 'Ed25519', false, ['verify']);
          if (!await crypto.subtle.verify('Ed25519', publicKey, Uint8Array.from(atob(signature), c => c.charCodeAt(0)), new TextEncoder().encode(canonicalJson(payload)))) throw new Error('Worker profile signature is invalid.');
          const p = payload.profile;
          if (!p || typeof p.description !== 'string' || p.description.length > 2000 || !['available','busy','offline'].includes(p.availability) || ![p.tags, p.models, p.languages].every(labels => Array.isArray(labels) && labels.length <= 12 && labels.every(label => typeof label === 'string' && label.length <= 60)) || ![p.minimumSol, p.minimumUsdc].every(value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n)) throw new Error('Invalid Worker claims.');
        }
      }
      setWorkers(data.workers); setCursor(data.nextCursor); setStatus(`${data.totalMatched} Workers${data.truncated ? ' · directory may be truncated' : ''}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Worker search failed.'); } finally { setBusy(false); }
  }
  async function publish() {
    if (busy || blocked || !ownAgent || !owner || !sign) return; setBusy(true); setError('');
    try {
      const groups = [tags, languages, models].map(text => text.split(',').map(item => item.trim()).filter(Boolean));
      if (groups.some(group => group.length > 12 || group.some(item => item.length > 60))) throw new Error('Use at most 12 labels per field, each at most 60 characters.');
      const issuedAt = Math.floor(Date.now() / 1000);
      const payload: WorkerProfile['payload'] = { domain: 'agentos-worker-profile-v1', network: WEB_NETWORK.cluster, programId: PROGRAM_ADDRESS, genesis: WEB_NETWORK.genesisHash, agent: ownAgent, owner, issuedAt, expiresAt: issuedAt + 7 * 86400,
        profile: { description, tags: groups[0], languages: groups[1], models: groups[2], availability, minimumSol: solToLamports(Number(sol)).toString(), minimumUsdc: usdcToBaseUnits(usdc).toString() } };
      const signature = await sign(new TextEncoder().encode(canonicalJson(payload)));
      const result = await json(await fetch(backgroundApiUrl('scope',import.meta.env.VITE_AUTONOMOUS_API_ORIGIN?.trim()||'').replace(/\/api\/autonomous\/scope$/,'/api/marketplace/profile'), { method: 'POST', redirect:'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload, signature: btoa(String.fromCharCode(...signature)) }), signal: AbortSignal.timeout(30000) }));
      if (result.saved !== true || result.agent !== ownAgent) throw new Error('Profile publication was not confirmed.');
      setStatus('Public profile published. It expires in seven days. Refresh the search to read it.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Profile publication failed.'); } finally { setBusy(false); }
  }
  return <section className="panel registry-panel worker-marketplace">
    <h3>Worker Marketplace</h3><p>Recent quality uses independent settled Judge decisions. Old results lose weight over 90 days; repeated and related trades are limited. Positive evidence from one Judge is capped. Confidence reflects evidence diversity. Separate-wallet collusion can still occur.</p>
    <div className="marketplace-filter-row"><input aria-label="Search Workers" placeholder="Search Workers" maxLength={120} value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setCursor(null); }} /><input aria-label="Worker skill tag" placeholder="Skill tag" maxLength={60} value={tag} disabled={busy} onChange={event => { setTag(event.target.value); setCursor(null); }} /><label><input type="checkbox" checked={available} disabled={busy} onChange={event => { setAvailable(event.target.checked); setCursor(null); }} />Available only</label><button className="outline-button" disabled={busy || blocked} onClick={() => void read()}>Search Workers</button>{cursor && <button className="outline-button" disabled={busy || blocked} onClick={() => void read(cursor)}>Next page</button>}</div>
    <div className="marketplace-filter-row"><input aria-label="Required Worker language" placeholder="Required language" maxLength={60} value={searchLanguage} disabled={busy} onChange={event => { setSearchLanguage(event.target.value); setCursor(null); }} /><input aria-label="Required Worker model" placeholder="Required model" maxLength={60} value={searchModel} disabled={busy} onChange={event => { setSearchModel(event.target.value); setCursor(null); }} /><label>Maximum starting price<input inputMode="decimal" maxLength={30} value={searchBudget} disabled={busy} onChange={event => { setSearchBudget(event.target.value); setCursor(null); }} /></label><select aria-label="Starting price asset" value={searchAsset} disabled={busy} onChange={event => { setSearchAsset(event.target.value as 'SOL' | 'USDC'); setCursor(null); }}><option value="SOL">SOL</option><option value="USDC">USDC</option></select><label>Minimum confidence (%)<input inputMode="decimal" maxLength={6} value={searchConfidence} disabled={busy} onChange={event => { setSearchConfidence(event.target.value); setCursor(null); }} /></label></div>
    <p>Capabilities and starting prices are Owner-signed claims. Confirm the final price and delivery terms when reviewing hiring.</p>
    {error && <p role="alert">{error}</p>}{status && <p>{status}</p>}
    <div className="registry-list">{workers.map(worker => { const p = worker.profile?.payload.profile, rep = worker.recentReputation; return <article className="registry-row" key={worker.address}><div className="registry-copy"><strong>{worker.name} · {worker.active ? 'Active' : 'Inactive'}</strong><p>{p?.description ?? 'No current Owner-signed profile.'}</p>{p && <><small>Owner-signed claims · {p.availability} · {p.tags.join(' · ')}</small><small>Languages: {p.languages.join(', ')} · Models: {p.models.join(', ')}</small><small>Starting at {Number(BigInt(p.minimumSol)) / 1e9} SOL / {formatUsdcBaseUnits(p.minimumUsdc)} USDC</small></>}<small>Recent quality: {rep.quality === null ? 'Insufficient evidence' : `${rep.quality.toFixed(1)} / 100`} · Confidence: {(rep.confidence * 100).toFixed(1)}%</small><small>{rep.independentEmployers} independent employers · {rep.independentJudges} independent Judges · {rep.effectiveSamples} weighted outcomes</small>{rep.risks.length > 0 && <small>Evidence risks: {rep.risks.map(risk => <span key={risk} className="reputation-risk">{{'concentrated-employers':'Most evidence comes from one employer','concentrated-judges':'Most evidence comes from one Judge','concentrated-positive-judgments':'Repeated passes from one Judge were excluded','reciprocal-trading':'Reciprocal trading detected','circular-trading':'Circular trading detected'}[risk] ?? 'Evidence requires review'}</span>)}</small>}{worker.profileError && <small>{worker.profileError}</small>}<details><summary>Score evidence</summary>{rep.evidence.map(item => <p key={item.escrow}><a href={`https://explorer.solana.com/address/${item.decision}?${EXPLORER_QUERY}`} target="_blank" rel="noreferrer">{item.verdict} · {new Date(item.recordedAt * 1000).toLocaleString()} · {item.weight} weight</a></p>)}{rep.evidenceTruncated && <small>Evidence list truncated to 50 decisions; all eligible results contribute to the score.</small>}</details><ReputationOutcomes worker={worker.address} /><small>Worker {worker.address} · Owner {worker.owner}</small></div><button className="outline-button" disabled={busy || blocked || !owner || !worker.active || worker.address === ownAgent || worker.owner === owner} onClick={() => onHire(worker.address)}>Review hiring</button></article>; })}</div>
    {ownAgent && owner && sign && <details className="worker-profile-form"><summary>Publish my Worker profile</summary><p>This profile is public and valid for seven days. Your wallet signs the description, capabilities, availability and starting prices shown below. Publishing the profile has no network transaction fee.</p><label>Description<textarea maxLength={2000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} /></label><label>Skills (comma separated)<input value={tags} disabled={busy} onChange={event => setTags(event.target.value)} /></label><label>Languages (comma separated)<input value={languages} disabled={busy} onChange={event => setLanguages(event.target.value)} /></label><label>Models (comma separated)<input value={models} disabled={busy} onChange={event => setModels(event.target.value)} /></label><label>Availability<select value={availability} disabled={busy} onChange={event => setAvailability(event.target.value as typeof availability)}><option value="available">Available</option><option value="busy">Busy</option><option value="offline">Offline</option></select></label><label>Starting price in SOL<input value={sol} disabled={busy} onChange={event => setSol(event.target.value)} /></label><label>Starting price in USDC<input value={usdc} disabled={busy} onChange={event => setUsdc(event.target.value)} /></label><button className="outline-button" disabled={busy || blocked} onClick={() => void publish()}>Sign and publish public profile</button></details>}
  </section>;
}
