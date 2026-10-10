import { runtimeNetwork } from './chain-network.js';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { getPublicKeyFromAddress, address, verifySignature } from '@solana/kit';
import { isValidSolanaAddress } from './memory.js';
import { readResponseTextLimited } from './http-limits.js';
import { externalEndpoint } from './external-mcp.js';
import { canonicalJson } from './canonical-json.js';
const key = z.string().refine(isValidSolanaAddress);
export const serviceClaimSchema = z.object({ skill: key, provider: key, endpoint: externalEndpoint, name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500), tags: z.array(z.string().trim().min(1).max(40)).max(8),
  attestation: z.object({ issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
    genesis: key, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict().optional() }).strict();
export const serviceCatalogSchema = z.object({ format: z.literal('agentos-service-catalog'), version: z.union([z.literal(1), z.literal(2)]),
  network: z.enum(['devnet', 'localnet']), programId: key, services: z.array(serviceClaimSchema).max(200),
  conflicts: z.array(z.tuple([serviceClaimSchema, serviceClaimSchema])).max(200).optional(), next: externalEndpoint.optional() }).strict().refine(value => value.version === 2 || !value.conflicts?.length);
export type ServiceClaim = z.infer<typeof serviceClaimSchema>;
export type ServiceChain = { programId: string; network: 'devnet' | 'localnet'; genesis: string };
export async function verifyServiceClaim(input: unknown, skill: DiscoverySkill | undefined, chain: ServiceChain, now = Math.floor(Date.now() / 1000), requireSignature = false) {
  const service = serviceClaimSchema.parse(input);
  if (!skill || skill.address !== service.skill || skill.provider !== service.provider || digest(service.endpoint) !== skill.endpointHash)
    throw new Error('No matching on-chain Skill, provider or endpoint commitment.');
  if (!service.attestation) { if (requireSignature) throw new Error('Provider metadata signature is required.'); return { service, trusted: false }; }
  const { attestation, ...metadata } = service;
  const signed = canonicalJson({ domain: 'agentos-service-metadata-v1', ...chain, genesis: attestation.genesis,
    issuedAt: attestation.issuedAt, expiresAt: attestation.expiresAt, service: metadata });
  if (Buffer.from(attestation.signature, 'base64').toString('base64') !== attestation.signature || chain.genesis !== attestation.genesis || attestation.issuedAt > now || attestation.expiresAt <= now ||
      attestation.expiresAt <= attestation.issuedAt || attestation.expiresAt - attestation.issuedAt > 30 * 86400 ||
      !await verifySignature(await getPublicKeyFromAddress(address(service.provider)), Buffer.from(attestation.signature, 'base64') as any, Buffer.from(signed)))
    throw new Error('Provider metadata signature, network binding or validity period is invalid.');
  return { service, trusted: true };
}
export async function verifyServiceConflict(pair: [ServiceClaim, ServiceClaim], skill: DiscoverySkill | undefined, chain: ServiceChain, now = Math.floor(Date.now() / 1000)) {
  const [first, second] = pair.map(value => serviceClaimSchema.parse(value));
  if (!first.attestation || !second.attestation || first.skill !== second.skill || first.provider !== second.provider ||
      first.attestation.issuedAt !== second.attestation.issuedAt || canonicalJson(first) === canonicalJson(second)) throw new Error('Invalid service equivocation proof.');
  for (const claim of [first, second]) await verifyServiceClaim(claim, skill, chain, Math.min(now, claim.attestation!.expiresAt - 1), true);
  return [first, second] as [ServiceClaim, ServiceClaim];
}
export function configuredCatalogUrls(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.AGENTOS_SERVICE_CATALOG_URLS?.trim() ? JSON.parse(env.AGENTOS_SERVICE_CATALOG_URLS) : env.AGENTOS_SERVICE_CATALOG_URL?.trim() ? [env.AGENTOS_SERVICE_CATALOG_URL.trim()] : [];
  const urls = z.array(externalEndpoint).max(20).parse(configured);
  if (new Set(urls).size !== urls.length) throw new Error('Catalog URLs must be unique.'); return urls;
}
export type DiscoverySkill = { address: string; provider: string; id: string; active: boolean; priceLamports: string; priceUsdc: string; endpointHash: string };
type Options = { query?: string; tag?: string; active?: boolean; asset?: 'SOL' | 'USDC'; sort?: 'name' | 'price'; cursor?: string;
  versions?: Record<string, number>; conflicts?: [ServiceClaim, ServiceClaim][]; announcements?: ServiceClaim[]; announcementCatalog?: string; urls?: string[]; transport?: typeof fetch; network?: 'devnet' | 'localnet'; genesis?: string; now?: number };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function discoverServices(programId: string, skills: DiscoverySkill[], options: Options = {}) {
  const urls = options.urls ? configuredCatalogUrls({ AGENTOS_SERVICE_CATALOG_URLS: JSON.stringify(options.urls) }) : configuredCatalogUrls();
  const network = options.network ?? runtimeNetwork().cluster;
  const genesis = options.genesis ?? (options.network ? undefined : runtimeNetwork().genesisHash);
  const now = options.now ?? Math.floor(Date.now() / 1000), transport = options.transport ?? fetch;
  const deadline = AbortSignal.timeout(20000);
  const byKey = new Map(skills.map(skill => [skill.address, skill]));
  const failures: { skill: string; reason: string }[] = [];
  const catalogFailures: { catalog: string; reason: string }[] = [];
  const rows: { claim: ServiceClaim; catalog: string; trusted: boolean }[] = [];
  let catalogTruncated = false;
  // Pagination may only change the query of the configured origin/path.
  // Discovered service URLs are never fetched during discovery.
  await Promise.all(urls.map(async catalogUrl => {
    const root = new URL(catalogUrl), seen = new Set<string>(); let next: string | undefined = catalogUrl;
    try {
      for (let page = 0; next && page < 5; page++) {
        if (seen.has(next)) throw new Error('Catalog pagination repeats a URL.'); seen.add(next);
        const target = new URL(next);
        if (target.origin !== root.origin || target.pathname !== root.pathname) throw new Error('Catalog pagination leaves its configured endpoint.');
        const response = await transport(next, { redirect: 'error', cache: 'no-store', signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw new Error(`Catalog returned HTTP ${response.status}.`);
        const catalog = serviceCatalogSchema.parse(JSON.parse(await readResponseTextLimited(response, 512000, 'Catalog exceeds 512 KB.')));
        if (catalog.network !== network || catalog.programId !== programId || new Set(catalog.services.map(service => service.skill)).size !== catalog.services.length)
          throw new Error('Catalog belongs to another network/Program or duplicates a Skill.');
        for (const service of catalog.services) {
          try {
            const verified = await verifyServiceClaim(service, byKey.get(service.skill), { programId, network, genesis: genesis ?? '' }, now);
            rows.push({ claim: verified.service, catalog: catalogUrl, trusted: verified.trusted });
          } catch (cause) { failures.push({ skill: service.skill, reason: cause instanceof Error ? cause.message : 'Invalid service claim.' }); }
        }
        for (const pair of catalog.conflicts ?? []) {
          try { for (const service of await verifyServiceConflict(pair, byKey.get(pair[0].skill), { programId, network, genesis: genesis ?? '' }, now)) rows.push({ claim: service, catalog: catalogUrl, trusted: true }); }
          catch (cause) { failures.push({ skill: pair[0].skill, reason: cause instanceof Error ? cause.message : 'Invalid service equivocation proof.' }); }
        }
        next = catalog.next;
      }
      if (next) catalogTruncated = true;
    } catch (cause) { catalogFailures.push({ catalog: catalogUrl, reason: cause instanceof Error ? cause.message.slice(0, 300) : 'Catalog unavailable.' }); }
  }));
  for (const service of options.announcements ?? []) {
    try {
      const verified = await verifyServiceClaim(service, byKey.get(service.skill), { programId, network, genesis: genesis ?? '' }, now, true);
      rows.push({ claim: verified.service, catalog: options.announcementCatalog ?? 'runtime-announcements', trusted: true });
    } catch (cause) { failures.push({ skill: service.skill, reason: cause instanceof Error ? cause.message : 'Invalid service announcement.' }); }
  }
  for (const pair of options.conflicts ?? []) {
    try { for (const service of await verifyServiceConflict(pair, byKey.get(pair[0].skill), { programId, network, genesis: genesis ?? '' }, now)) rows.push({ claim: service, catalog: options.announcementCatalog ?? 'runtime-announcements', trusted: true }); }
    catch (cause) { failures.push({ skill: pair[0].skill, reason: cause instanceof Error ? cause.message : 'Invalid stored service conflict.' }); }
  }
  const groups = new Map<string, typeof rows>(); for (const row of rows) groups.set(row.claim.skill, [...groups.get(row.claim.skill) ?? [], row]);
  const services = [...groups].flatMap(([skillId, candidates]) => {
    const current = candidates.filter(row => options.versions?.[skillId] === undefined || row.trusted && row.claim.attestation!.issuedAt >= options.versions[skillId]);
    if (!current.length) { failures.push({ skill: skillId, reason: 'Provider metadata has a newer retained version; older listing omitted.' }); return []; }
    const signed = current.filter(row => row.trusted); const choices = signed.length ? signed : current;
    const latest = Math.max(...choices.map(row => row.claim.attestation?.issuedAt ?? 0));
    const selected = choices.filter(row => (row.claim.attestation?.issuedAt ?? 0) === latest);
    const metadata = (row: typeof rows[number]) => ({ name: row.claim.name, description: row.claim.description, tags: row.claim.tags });
    if (new Set(selected.map(row => canonicalJson(row.trusted ? row.claim : metadata(row)))).size !== 1) {
      failures.push({ skill: skillId, reason: 'Catalogs disagree on current metadata; ambiguous listing omitted.' }); return [];
    }
    const row = selected[0]; return [{ ...byKey.get(skillId)!, endpoint: row.claim.endpoint, metadata: metadata(row),
      endpointVerified: true as const, metadataTrust: row.trusted ? 'provider-signed' as const : 'catalog-claims' as const,
      attestation: row.trusted ? row.claim.attestation! : null,
      catalogs: [...new Set(candidates.map(row => row.catalog))], metadataExpiresAt: row.claim.attestation?.expiresAt ?? null }];
  });
  const query = (options.query ?? '').trim().toLocaleLowerCase();
  if (query.length > 120 || (options.tag?.length ?? 0) > 40) throw new Error('Discovery filter exceeds its limit.');
  const filtered = services.filter(service => (!query || [service.metadata.name, service.metadata.description, ...service.metadata.tags].join(' ').toLocaleLowerCase().includes(query)) &&
    (!options.tag || service.metadata.tags.includes(options.tag)) && (options.active === undefined || service.active === options.active) &&
    (!options.asset || BigInt(options.asset === 'SOL' ? service.priceLamports : service.priceUsdc) > 0n));
  filtered.sort((a, b) => {
    if (options.sort === 'price') { const price = (row: typeof a) => BigInt(options.asset === 'USDC' ? row.priceUsdc : row.priceLamports); if (price(a) !== price(b)) return price(a) < price(b) ? -1 : 1; }
    return a.metadata.name.localeCompare(b.metadata.name) || a.address.localeCompare(b.address);
  });
  const snapshot = digest(canonicalJson(filtered)); let offset = 0;
  if (options.cursor) {
    const parsed = /^([a-f0-9]{64}):([0-9]{1,5})$/.exec(options.cursor);
    if (!parsed || parsed[1] !== snapshot || Number(parsed[2]) % 200 || Number(parsed[2]) >= filtered.length) throw new Error('Catalog changed or cursor is invalid; restart discovery.');
    offset = Number(parsed[2]);
  }
  const page = filtered.slice(offset, offset + 200);
  return { catalogConfigured: urls.length > 0 || Boolean(options.announcements?.length), catalogCount: urls.length + (options.announcements?.length ? 1 : 0), services: page, failures: failures.slice(0, 200),
    catalogFailures, count: page.length, totalMatched: filtered.length, totalVerified: services.length,
    unresolvedSkills: Math.max(0, skills.length - services.length), truncated: catalogTruncated,
    nextCursor: offset + 200 < filtered.length ? `${snapshot}:${offset + 200}` : null };
}
