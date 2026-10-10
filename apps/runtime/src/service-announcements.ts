import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalJson } from './canonical-json.js';
import { serviceClaimSchema, verifyServiceClaim, verifyServiceConflict, type ServiceClaim, type ServiceChain, type DiscoverySkill } from './service-discovery.js';
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
export class ServiceEquivocationError extends Error { constructor() { super('Provider signed conflicting service claims at the same issue time; listing quarantined until a newer signed version.'); } }
/** Public signed metadata only. Keep the latest version even after expiry to prevent rollback. */
export class ServiceAnnouncementStore {
  private readonly db: DatabaseSync;
  private readonly chainId: string;
  constructor(file: string, chain: ServiceChain) {
    this.chainId = hash(canonicalJson(chain));
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(file, 'wx', 0o600)); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000_000) throw new Error('Invalid service announcement database.');
    chmodSync(file, 0o600); this.db = new DatabaseSync(file, { timeout: 1000 });
    try {
      const app = this.db.prepare('PRAGMA application_id').get()?.application_id, version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (app === 0 && version === 0 && !tables.length) this.db.exec('BEGIN IMMEDIATE;CREATE TABLE announcements(chain TEXT NOT NULL,skill TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(chain,skill)) STRICT;PRAGMA application_id=1095190361;PRAGMA user_version=1;COMMIT;');
      else if (app !== 1095190361 || ![1, 2].includes(Number(version))) throw new Error('Announcement database belongs to another application.');
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) === 1) this.db.exec('BEGIN IMMEDIATE;CREATE TABLE conflicts(chain TEXT NOT NULL,skill TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(chain,skill),FOREIGN KEY(chain,skill) REFERENCES announcements(chain,skill)) STRICT;PRAGMA user_version=2;COMMIT;');
      this.db.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA trusted_schema=OFF;');
    } catch (cause) { this.db.close(); throw cause; }
  }
  private decode(row: Record<string, unknown>): ServiceClaim {
    if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > 8000 || hash(row.body) !== row.hash) throw new Error('Service announcement is corrupt.');
    const value = serviceClaimSchema.parse(JSON.parse(row.body));
    if (value.skill !== row.skill || !value.attestation) throw new Error('Service announcement identity or signature is missing.');
    return value;
  }
  loadRecords(): { claim: ServiceClaim; conflict: ServiceClaim | null }[] {
    return this.db.prepare('SELECT skill,body,hash FROM announcements WHERE chain=? ORDER BY skill').all(this.chainId).map(row => {
      const claim = this.decode(row), conflicting = this.db.prepare('SELECT skill,body,hash FROM conflicts WHERE chain=? AND skill=?').get(this.chainId, claim.skill);
      const conflict = conflicting ? this.decode(conflicting) : null;
      if (conflict && (conflict.attestation!.issuedAt !== claim.attestation!.issuedAt || canonicalJson(conflict) === canonicalJson(claim))) throw new Error('Service conflict proof is corrupt.');
      return { claim, conflict };
    });
  }
  loadAll(): ServiceClaim[] { return this.loadRecords().flatMap(row => row.conflict ? [] : [row.claim]); }
  saveVerified(input: ServiceClaim): boolean {
    const value = serviceClaimSchema.parse(input), body = canonicalJson(value);
    if (!value.attestation || Buffer.byteLength(body) > 8000) throw new Error('Signed service announcement exceeds its limit or has no signature.');
    this.db.exec('BEGIN IMMEDIATE'); let committed = false;
    try {
      const oldRow = this.db.prepare('SELECT skill,body,hash FROM announcements WHERE chain=? AND skill=?').get(this.chainId, value.skill);
      if (oldRow) {
        const old = this.decode(oldRow);
        if (value.attestation.issuedAt === old.attestation!.issuedAt) {
          const conflict = this.db.prepare('SELECT skill FROM conflicts WHERE chain=? AND skill=?').get(this.chainId, value.skill);
          if (!conflict && canonicalJson(old) === body) { this.db.exec('COMMIT'); return false; }
          if (!conflict) this.db.prepare('INSERT INTO conflicts(chain,skill,body,hash) VALUES(?,?,?,?)').run(this.chainId, value.skill, body, hash(body));
          this.db.exec('COMMIT'); committed = true; throw new ServiceEquivocationError();
        }
        if (value.attestation.issuedAt < old.attestation!.issuedAt) throw new Error('A signed service update must be newer than the existing version.');
      } else if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM announcements').get()?.count) >= 20_000) throw new Error('Service announcement store is full.');
      this.db.prepare('DELETE FROM conflicts WHERE chain=? AND skill=?').run(this.chainId, value.skill);
      this.db.prepare('INSERT INTO announcements(chain,skill,body,hash) VALUES(?,?,?,?) ON CONFLICT(chain,skill) DO UPDATE SET body=excluded.body,hash=excluded.hash').run(this.chainId, value.skill, body, hash(body));
      this.db.exec('COMMIT'); return true;
    } catch (cause) { if (!committed) this.db.exec('ROLLBACK'); throw cause; }
  }
  close() { this.db.close(); }
}
export function serviceAnnouncementRoute(target: string, method: string): boolean {
  if (method === 'POST') return target === '/api/marketplace/services/announce';
  if (method === 'OPTIONS') return target === '/api/marketplace/services/announce' || /^\/api\/marketplace\/services\/catalog(?:\?cursor=[a-f0-9]{64}-[0-9]{1,5})?$/.test(target);
  return method === 'GET' && /^\/api\/marketplace\/services\/catalog(?:\?cursor=[a-f0-9]{64}-[0-9]{1,5})?$/.test(target);
}
export function serviceAnnouncementHandler(options: { chain: () => ServiceChain; store: () => ServiceAnnouncementStore; skills: () => Promise<DiscoverySkill[]>; origin: () => string; now?: () => number }) {
  let window = 0, writes = 0, reads = 0;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
    const at = now(); if (Math.floor(at / 60) !== window) { window = Math.floor(at / 60); writes = 0; reads = 0; }
    const writing = request.method === 'POST';
    if (writing ? ++writes > 30 : ++reads > 240) { response.setHeader('Retry-After', '60'); response.writeHead(429).end(JSON.stringify({ error: 'Service announcement rate limit exceeded.' })); return; }
    try {
      const chain = options.chain();
      if (writing) {
        if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' || request.headers['content-encoding']) { response.writeHead(415).end(); return; }
        if (Number(request.headers['content-length'] ?? 0) > 8000) { response.writeHead(413).end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 8000) { response.writeHead(413).end(); return; } chunks.push(bytes); }
        const claim = serviceClaimSchema.parse(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))));
        // Cheap cryptographic admission before any RPC. The independent chain
        // lookup below still checks the actual provider and endpoint commitment.
        await verifyServiceClaim(claim, { address: claim.skill, provider: claim.provider, endpointHash: hash(claim.endpoint), id: '', active: true, priceLamports: '0', priceUsdc: '0' }, chain, at, true);
        const skill = (await options.skills()).find(skill => skill.address === claim.skill);
        const verified = await verifyServiceClaim(claim, skill, chain, at, true);
        if (!skill?.active) throw new Error('Only an active on-chain Skill can be announced.');
        const changed = options.store().saveVerified(verified.service);
        response.end(JSON.stringify({ saved: true, changed, skill: claim.skill, issuedAt: claim.attestation!.issuedAt })); return;
      }
      const skills = new Map((await options.skills()).map(skill => [skill.address, skill]));
      const records: { claim: ServiceClaim; conflict: ServiceClaim | null }[] = [];
      for (const row of options.store().loadRecords()) {
        if (!skills.get(row.claim.skill)?.active || (row.conflict ? row.claim.attestation!.issuedAt + 30 * 86400 <= at : row.claim.attestation!.expiresAt <= at)) continue;
        try {
          if (!row.conflict) await verifyServiceClaim(row.claim, skills.get(row.claim.skill), chain, at, true);
          // A retained signed equivocation remains quarantined until a newer
          // version, even if one of its conflicting claims expires first.
          if (row.conflict) await verifyServiceConflict([row.claim, row.conflict], skills.get(row.claim.skill), chain, at);
          records.push(row);
        } catch { /* Revoked/changed/unverifiable metadata is omitted. */ }
      }
      const snapshot = hash(canonicalJson(records)), cursor = url.searchParams.get('cursor'); let offset = 0;
      if (cursor) { const match = /^([a-f0-9]{64})-([0-9]{1,5})$/.exec(cursor); if (!match || match[1] !== snapshot || Number(match[2]) >= records.length) throw new Error('Service announcements changed or cursor is invalid; restart discovery.'); offset = Number(match[2]); }
      const services: ServiceClaim[] = [], conflicts: [ServiceClaim, ServiceClaim][] = []; let end = offset;
      for (; end < Math.min(records.length, offset + 200); end++) {
        const row = records[end]; if (row.conflict) conflicts.push([row.claim, row.conflict]); else services.push(row.claim);
        if (Buffer.byteLength(JSON.stringify({ services, conflicts })) > 480_000) { if (row.conflict) conflicts.pop(); else services.pop(); break; }
      }
      response.end(JSON.stringify({ format: 'agentos-service-catalog', version: conflicts.length ? 2 : 1, network: chain.network, programId: chain.programId, services,
        ...(conflicts.length ? { conflicts } : {}), ...(end < records.length ? { next: options.origin() + '/api/marketplace/services/catalog?cursor=' + snapshot + '-' + end } : {}) }));
    } catch (cause) { response.writeHead(cause instanceof ServiceEquivocationError ? 409 : writing ? 400 : 502).end(JSON.stringify({ error: cause instanceof Error ? cause.message : 'Service announcement could not be processed.' })); }
  };
}
