/** @jsxImportSource ./i18n */
import { NETWORK_IDENTITY, NETWORK_LABEL } from './lib/chainNetwork';
import React, { useState } from 'react';
import { address, getAddressEncoder } from '@solana/kit';
import { PROGRAM_ADDRESS, formatUsdcBaseUnits } from './lib/agentOs';
import { WEB_NETWORK } from './lib/chainNetwork';
import { canonicalJson } from '../../runtime/src/canonical-json';
export type DiscoveredService = { address: string; provider: string; id: string; active: boolean; priceLamports: string; priceUsdc: string; endpointHash: string; endpoint: string; metadata: { name: string; description: string; tags: string[] }; endpointVerified: true; metadataTrust: 'catalog-claims' | 'provider-signed'; attestation?: {issuedAt:number;expiresAt:number;genesis:string;signature:string}|null };
const isKey = (key: unknown) => { try { if (typeof key !== 'string') return false; getAddressEncoder().encode(address(key)); return true; } catch { return false; } };
const atomic = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
export function ServiceDiscoveryPanel({ canPay, blocked, onChoose, selectionMode = 'call' }: { selectionMode?: 'call' | 'worker-tool'; canPay: boolean; blocked: boolean; onChoose: (service: DiscoveredService, asset: 'SOL' | 'USDC') => void }) {
  const [services, setServices] = useState<DiscoveredService[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [query,setQuery]=useState(''),[tag,setTag]=useState(''),[asset,setAsset]=useState(''),[sort,setSort]=useState('name'),[onlyActive,setOnlyActive]=useState(true),[cursor,setCursor]=useState<string|null>(null);
  async function discover(next?:string) {
    if (loading) return;
    setLoading(true); setError(''); setServices([]); setStatus('');
    try {
      const params=new URLSearchParams({q:query,tag,sort,...(asset?{asset}:{}),...(onlyActive?{active:'true'}:{}),...(next?{cursor:next}:{})});
      const response = await fetch('/api/on-chain/services?'+params, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const reader = response.body?.getReader(); if (!reader) throw new Error('Discovery returned no body.');
      const chunks: Uint8Array[] = []; let total = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > 1000000) { await reader.cancel(); throw new Error('Discovery exceeds 1 MB.'); } chunks.push(next.value); } } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!response.ok) throw new Error(payload.error ?? 'Could not discover services.');
      if (payload.programId !== PROGRAM_ADDRESS || payload.network !== NETWORK_IDENTITY || typeof payload.catalogConfigured !== 'boolean' || typeof payload.truncated !== 'boolean' || !Number.isInteger(payload.unresolvedSkills) || payload.unresolvedSkills < 0 || !Array.isArray(payload.services) || payload.services.length > 200 || payload.count !== payload.services.length || !Array.isArray(payload.failures) || payload.failures.length > 200) throw new Error('Discovery response is invalid.');
      const ids = new Set<string>();
      for (const item of payload.services as DiscoveredService[]) {
        if (!item || !isKey(item.address) || !isKey(item.provider) || ids.has(item.address) || typeof item.id !== 'string' || item.id.length > 100 || typeof item.active !== 'boolean' || !atomic(item.priceLamports) || !atomic(item.priceUsdc) || item.endpointVerified !== true || !['catalog-claims','provider-signed'].includes(item.metadataTrust) || !/^[a-f0-9]{64}$/.test(item.endpointHash) || typeof item.endpoint !== 'string' || item.endpoint.length > 2000 || !item.metadata || typeof item.metadata.name !== 'string' || !item.metadata.name.trim() || item.metadata.name.length > 120 || typeof item.metadata.description !== 'string' || item.metadata.description.length > 500 || !Array.isArray(item.metadata.tags) || item.metadata.tags.length > 8 || !item.metadata.tags.every(tag => typeof tag === 'string' && tag.length <= 40)) throw new Error('Invalid service metadata.');
        ids.add(item.address);
        const url = new URL(item.endpoint), local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password || url.hash || url.href !== item.endpoint) throw new Error('Service URL is not canonical HTTPS or loopback HTTP.');
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.endpoint)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== item.endpointHash) throw new Error('Service URL differs from its registered hash.');
        if(item.metadataTrust==='provider-signed'){
          const att=item.attestation,now=Math.floor(Date.now()/1000);
          if(!att||att.genesis!==WEB_NETWORK.genesisHash||!Number.isSafeInteger(att.issuedAt)||att.issuedAt>now||!Number.isSafeInteger(att.expiresAt)||att.expiresAt<=now||att.expiresAt-att.issuedAt>30*86400||typeof att.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(att.signature))throw new Error('Invalid Provider metadata validity or chain binding.');
          const signed=canonicalJson({domain:'agentos-service-metadata-v1',programId:PROGRAM_ADDRESS,network:WEB_NETWORK.cluster,genesis:att.genesis,issuedAt:att.issuedAt,expiresAt:att.expiresAt,
            service:{skill:item.address,provider:item.provider,endpoint:item.endpoint,...item.metadata}});
          const publicKey=await crypto.subtle.importKey('raw',new Uint8Array(getAddressEncoder().encode(address(item.provider))),'Ed25519',false,['verify']);
          if(!await crypto.subtle.verify('Ed25519',publicKey,Uint8Array.from(atob(att.signature),c=>c.charCodeAt(0)),new TextEncoder().encode(signed)))throw new Error('Provider metadata signature is invalid.');
        }
      }
      setServices(payload.services);
      if(!(payload.nextCursor===null||typeof payload.nextCursor==='string'&&/^[a-f0-9]{64}:[0-9]{1,5}$/.test(payload.nextCursor)))throw new Error('Invalid service pagination cursor.');
      setCursor(payload.nextCursor);
      setStatus(payload.catalogConfigured ? `${payload.count} services on this page · ${payload.totalMatched} matched across ${payload.catalogCount} catalogs · ${payload.failures.length} rejected entries · ${payload.catalogFailures?.length??0} unavailable catalogs · ${payload.unresolvedSkills} Skills without a catalog match${payload.truncated ? ' · catalog or registry may be truncated' : ''}` : 'No public catalog configured. Set AGENTOS_SERVICE_CATALOG_URL in Runtime.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not discover services.'); }
    finally { setLoading(false); }
  }
  return <section className="panel registry-panel">
    <div className="panel-title-row"><h3>Discover service URLs</h3><button type="button" className="outline-button" disabled={loading || blocked} onClick={() => void discover()}>{loading ? 'Discovering…' : 'Read public catalog'}</button></div>
    <p>URLs match the registered Skill commitment. Signed metadata identifies its Provider; other descriptions are catalog claims. Payment prices come from {NETWORK_LABEL}. Discovery does not call a Skill or enable automation.</p>
    <div className="marketplace-filter-row"><input aria-label="Search services" placeholder="Search services" maxLength={120} disabled={loading} value={query} onChange={event=>{setQuery(event.target.value);setCursor(null);}}/><input aria-label="Service tag" placeholder="Service tag" maxLength={40} disabled={loading} value={tag} onChange={event=>{setTag(event.target.value);setCursor(null);}}/><select aria-label="Payment currency" disabled={loading} value={asset} onChange={event=>{setAsset(event.target.value);setCursor(null);}}><option value="">All currencies</option><option value="SOL">SOL</option><option value="USDC">USDC</option></select><select aria-label="Sort services" disabled={loading} value={sort} onChange={event=>{setSort(event.target.value);setCursor(null);}}><option value="name">Name</option><option value="price">Price</option></select><label><input type="checkbox" disabled={loading} checked={onlyActive} onChange={event=>{setOnlyActive(event.target.checked);setCursor(null);}}/>Active only</label>{cursor&&<button type="button" className="outline-button" disabled={loading||blocked} onClick={()=>void discover(cursor)}>Next page</button>}</div>
    {error && <p role="alert" className="denied-text">{error}</p>}{status && <p>{status}</p>}
    <div className="registry-list">{services.map(service => <article className="registry-row" key={service.address}><div className="registry-copy"><strong>{service.metadata.name} · {service.active ? 'Active' : 'Inactive'}</strong><p>{service.metadata.description}</p><small>{service.metadataTrust==='provider-signed'?'Provider-signed metadata':'Catalog claims'}</small><small>{service.endpoint}</small><small>Provider {service.provider} · {service.metadata.tags.join(' · ')}</small><small>{service.priceLamports} lamports / {formatUsdcBaseUnits(service.priceUsdc)} USDC per call</small></div><div className="registry-actions">{(['SOL', 'USDC'] as const).map(asset => <button type="button" className="outline-button" key={asset} disabled={!canPay || blocked || !service.active || BigInt(asset === 'SOL' ? service.priceLamports : service.priceUsdc) === 0n} onClick={() => onChoose(service, asset)}>{selectionMode === 'worker-tool' ? `Select ${asset} tool` : `Review ${asset} call`}</button>)}</div></article>)}</div>
  </section>;
}
