import { pollCatalogs } from './catalog-poll.js';
import { externalEndpoint } from './external-mcp.js';
import { readResponseTextLimited } from './http-limits.js';
import { canonicalJson } from './canonical-json.js';
import { configuredCatalogUrls, serviceCatalogSchema, verifyServiceClaim, verifyServiceConflict, type DiscoverySkill, type ServiceChain, type ServiceClaim } from './service-discovery.js';
import { ServiceAnnouncementStore, ServiceEquivocationError } from './service-announcements.js';
export type CatalogSyncReport = { checkedAt: number; catalogs: number; imported: number; unchanged: number; rejected: number; quarantined: number; failures: { catalog: string; reason: string }[] };
/** Only Operator bootstrap URLs are fetched. Provider endpoints are never invoked. */
export class ServiceCatalogSync {
  private readonly lifecycle = new AbortController();
  private running?: Promise<CatalogSyncReport>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private watching = false;
  private report?: CatalogSyncReport;
  constructor(private readonly options: { urls?: string[]; chain: () => ServiceChain; skills: () => Promise<DiscoverySkill[]>; store: () => ServiceAnnouncementStore; transport?: typeof fetch; now?: () => number; intervalMs?: number }) {
    const interval = options.intervalMs ?? 60_000;
    if (!Number.isSafeInteger(interval) || interval < 60_000 || interval > 3_600_000) throw new Error('Catalog synchronization interval must be between one minute and one hour.');
    if (options.urls) configuredCatalogUrls({ AGENTOS_SERVICE_CATALOG_URLS: JSON.stringify(options.urls) });
  }
  status(): CatalogSyncReport | null { return this.report ? structuredClone(this.report) : null; }
  sync(): Promise<CatalogSyncReport> {
    if (this.stopped) return Promise.reject(new Error('Catalog synchronizer is stopped.'));
    if (this.running) return this.running;
    const promise = this.perform().then(report => { this.report = report; return report; }).finally(() => { if (this.running === promise) this.running = undefined; });
    this.running = promise; return promise;
  }
  start() {
    if (this.watching || this.stopped) return;
    this.watching = true;
    const tick = async () => {
      try { await this.sync(); } catch { /* Preserve original data; a later poll may recover. */ }
      if (!this.stopped) { this.timer = setTimeout(() => { this.timer = undefined; void tick(); }, this.options.intervalMs ?? 60_000); this.timer.unref(); }
    };
    void tick();
  }
  async stop() { this.stopped = true; this.lifecycle.abort(); this.watching = false; clearTimeout(this.timer); this.timer = undefined; await this.running?.catch(() => {}); }
  private async perform(): Promise<CatalogSyncReport> {
    const urls = this.options.urls ? configuredCatalogUrls({ AGENTOS_SERVICE_CATALOG_URLS: JSON.stringify(this.options.urls) }) : configuredCatalogUrls();
    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000), report: CatalogSyncReport = { checkedAt: now, catalogs: urls.length, imported: 0, unchanged: 0, rejected: 0, quarantined: 0, failures: [] };
    if (!urls.length) return report;
    let chain: ServiceChain, skills: Map<string, DiscoverySkill>;
    try { chain = this.options.chain(); skills = new Map((await this.options.skills()).map(skill => [skill.address, skill])); }
    catch { report.failures = urls.map(catalog => ({ catalog, reason: 'Canonical chain registry could not be verified; original stored metadata was preserved.' })); return report; }
    const transport = this.options.transport ?? fetch, overall = AbortSignal.timeout(120_000);
    await pollCatalogs(urls, async catalogUrl => {
      const deadline = AbortSignal.any([overall, this.lifecycle.signal, AbortSignal.timeout(30_000)]);
      const root = new URL(catalogUrl), seen = new Set<string>(), candidates: ServiceClaim[] = []; let next: string | undefined = catalogUrl;
      try {
        // Up to the whole 20,000-record registry budget. Nothing is imported from
        // a catalog until its complete confined pagination has been fetched.
        for (let page = 0; next && page < 200; page++) {
          deadline.throwIfAborted();
          const target = new URL(externalEndpoint.parse(next));
          if (target.origin !== root.origin || target.pathname !== root.pathname || seen.has(target.toString())) throw new Error('Catalog pagination leaves or repeats its configured endpoint.');
          seen.add(target.toString());
          const response = await transport(target, { redirect: 'error', cache: 'no-store', signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]) });
          if (!response.ok) throw new Error(`Catalog returned HTTP ${response.status}.`);
          const catalog = serviceCatalogSchema.parse(JSON.parse(await readResponseTextLimited(response, 512000, 'Catalog exceeds 512 KB.')));
          if (catalog.network !== chain.network || catalog.programId !== chain.programId) throw new Error('Catalog belongs to another network or Program.');
          deadline.throwIfAborted();
          for (const claim of catalog.services) {
            deadline.throwIfAborted();
            try {
              if (!skills.get(claim.skill)?.active) throw new Error('Inactive Skill.');
              candidates.push((await verifyServiceClaim(claim, skills.get(claim.skill), chain, now, true)).service);
            } catch { report.rejected++; }
          }
          for (const pair of catalog.conflicts ?? []) {
            deadline.throwIfAborted();
            try { if (!skills.get(pair[0].skill)?.active) throw new Error('Inactive Skill.'); candidates.push(...await verifyServiceConflict(pair, skills.get(pair[0].skill), chain, now)); }
            catch { report.rejected++; }
          }
          if (candidates.length > 40_000 || new Set(candidates.map(claim => claim.skill)).size > 20_000) throw new Error('Catalog exceeds synchronization record budget.');
          next = catalog.next;
        }
        if (next) throw new Error('Catalog exceeds synchronization page budget; partial catalog was not imported.');
        deadline.throwIfAborted();
        // Old valid copies are harmless. Import order cannot clear a same-version
        // quarantine: only a strictly newer Provider-signed claim can do that.
        const current = new Map(this.options.store().loadRecords().map(row => [row.claim.skill, row]));
        const unique = new Map(candidates.map(claim => [canonicalJson(claim), claim]));
        const sorted = [...unique.values()].sort((a,b) => a.attestation!.issuedAt - b.attestation!.issuedAt);
        for (const claim of sorted) {
          deadline.throwIfAborted();
          const old = current.get(claim.skill);
          if (old && old.claim.attestation!.issuedAt > claim.attestation!.issuedAt) { report.unchanged++; continue; }
          try {
            if (this.options.store().saveVerified(claim)) { report.imported++; current.set(claim.skill, { claim, conflict: null }); } else report.unchanged++;
          } catch (cause) { if (cause instanceof ServiceEquivocationError) { report.quarantined++; current.set(claim.skill, { claim, conflict: claim }); } else throw cause; }
        }
      } catch (cause) { report.failures.push({ catalog: catalogUrl, reason: cause instanceof Error ? cause.message.slice(0, 300) : 'Catalog synchronization failed.' }); }
    });
    return report;
  }
}
