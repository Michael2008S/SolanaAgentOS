/** @jsxImportSource ./i18n */
import { useState } from 'react';
import { PROGRAM_ADDRESS } from './lib/agentOs';
import { WEB_NETWORK } from './lib/chainNetwork';
import { backgroundApiUrl } from './lib/backgroundApi';
import { readResponseTextLimited } from '../../runtime/src/http-limits';
import { canonicalJson } from '../../runtime/src/canonical-json';
type Skill = { address: string; provider: string; id: string; active: boolean; endpointHash: string };
export function ServicePublicationPanel({ skills, owner, blocked, sign }: { skills: Skill[]; owner?: string; blocked: boolean; sign?: (message: Uint8Array) => Promise<Uint8Array> }) {
  const owned = skills.filter(skill => skill.provider === owner && skill.active);
  const [selected, setSelected] = useState(''), [endpoint, setEndpoint] = useState(''), [name, setName] = useState(''), [description, setDescription] = useState(''), [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  if (!owner || !sign || !owned.length) return null;
  async function publish() {
    if (busy || blocked || !owner || !sign) return; setBusy(true); setError(''); setStatus('');
    try {
      const skill = owned.find(skill => skill.address === selected); if (!skill) throw new Error('Select an active Skill owned by your wallet.');
      const url = new URL(endpoint.trim());
      if (url.username || url.password || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use an HTTPS service address, or a local test address, without credentials.');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.toString())))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== skill.endpointHash) throw new Error('This service address does not match the registered Skill.');
      const labels = tags.split(',').map(value => value.trim()).filter(Boolean);
      if (labels.length > 8 || labels.some(value => value.length > 40)) throw new Error('Use at most eight tags of up to 40 characters.');
      const service = { skill: skill.address, provider: owner, endpoint: url.toString(), name: name.trim() || skill.id, description: description.trim(), tags: labels };
      const issuedAt = Math.floor(Date.now() / 1000), expiresAt = issuedAt + 7 * 86400;
      const signature = await sign(new TextEncoder().encode(canonicalJson({ domain: 'agentos-service-metadata-v1', programId: PROGRAM_ADDRESS, network: WEB_NETWORK.cluster, genesis: WEB_NETWORK.genesisHash, issuedAt, expiresAt, service })));
      const target = backgroundApiUrl('scope', import.meta.env.VITE_AUTONOMOUS_API_ORIGIN?.trim() || '').replace(/\/api\/autonomous\/scope$/, '/api/marketplace/services/announce');
      const response = await fetch(target, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...service, attestation: { issuedAt, expiresAt, genesis: WEB_NETWORK.genesisHash, signature: btoa(String.fromCharCode(...signature)) } }), signal: AbortSignal.timeout(30000) });
      const text = await readResponseTextLimited(response, 8000, 'Publication response exceeds its limit.'); const result = JSON.parse(text);
      if (!response.ok || result.saved !== true || result.skill !== skill.address || result.issuedAt !== issuedAt) throw new Error(result.error ?? 'Service publication was not confirmed.');
      setStatus('Service published for seven days. Refresh discovery to find it.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Service publication failed.'); } finally { setBusy(false); }
  }
  return <section className="panel registry-panel"><details className="worker-profile-form"><summary>Publish my service</summary><p>Your wallet signs the public service address and description below. The directory checks them against your registered Skill. Publication lasts seven days and has no transaction fee.</p>
    <label>Registered Skill<select value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}><option value="">Select a Skill</option>{owned.map(skill => <option key={skill.address} value={skill.address}>{skill.id}</option>)}</select></label>
    <label>Service address<input type="url" value={endpoint} maxLength={2000} disabled={busy} onChange={event => setEndpoint(event.target.value)} /></label>
    <label>Service name<input value={name} maxLength={120} disabled={busy} onChange={event => setName(event.target.value)} /></label>
    <label>Description<textarea value={description} maxLength={500} disabled={busy} onChange={event => setDescription(event.target.value)} /></label>
    <label>Tags (comma separated)<input value={tags} maxLength={328} disabled={busy} onChange={event => setTags(event.target.value)} /></label>
    <button className="outline-button" disabled={busy || blocked || !selected || !endpoint} onClick={() => void publish()}>Sign and publish service</button>{error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
  </details></section>;
}
