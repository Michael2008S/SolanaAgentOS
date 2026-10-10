import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { generateKeyPairSigner, getAddressDecoder } from '@solana/kit';
import { canonicalJson } from './canonical-json.js';
import { ServiceAnnouncementStore, ServiceEquivocationError } from './service-announcements.js';
import { ServiceCatalogSync } from './service-catalog-sync.js';
import { discoverServices, type ServiceClaim } from './service-discovery.js';
const hash = (value: string) => createHash('sha256').update(value).digest();
const key = (value: string) => getAddressDecoder().decode(hash(value));
test('full signed catalog replication survives source outage and restart, and propagates Provider equivocation', async () => {
  const signer = await generateKeyPairSigner(), now = 1791550000, chain = { programId: key('program'), network: 'localnet' as const, genesis: key('genesis') };
  const sign = async (index: number, description = 'Research', issuedAt = now - 10, expiresAt = now + 100): Promise<ServiceClaim> => {
    const service = { skill: key('skill' + index), provider: signer.address, endpoint: 'https://research.example/' + index, name: 'Research ' + index, description, tags: [] };
    return { ...service, attestation: { issuedAt, expiresAt, genesis: chain.genesis, signature: Buffer.from(await crypto.subtle.sign('Ed25519', signer.keyPair.privateKey, Buffer.from(canonicalJson({ domain: 'agentos-service-metadata-v1', ...chain, issuedAt, expiresAt, service })))).toString('base64') } };
  };
  const claims = await Promise.all(Array.from({ length: 1007 }, (_, index) => sign(index)));
  const skills = claims.map(claim => ({ address: claim.skill, provider: claim.provider, endpointHash: hash(claim.endpoint).toString('hex'), id: claim.name, active: true, priceLamports: '1', priceUsdc: '0' }));
  const root = await mkdtemp(join(tmpdir(), 'agentos-sync-')), file = join(root, 'claims.sqlite'); let store = new ServiceAnnouncementStore(file, chain), offline = false;
  const calls: string[] = [], catalog = (services: ServiceClaim[], next?: string, conflicts?: [ServiceClaim,ServiceClaim][]) => ({ format: 'agentos-service-catalog', version: conflicts ? 2 : 1, ...chain, genesis: undefined, services, ...(next ? { next } : {}), ...(conflicts ? { conflicts } : {}) });
  const transport: typeof fetch = async input => { calls.push(String(input)); if (offline) throw new Error('Source offline'); const page = Number(new URL(String(input)).searchParams.get('page') ?? 0); return Response.json(catalog(claims.slice(page * 200, (page + 1) * 200), page < 5 ? 'https://catalog.example/list?page=' + (page + 1) : undefined)); };
  const options = { urls: ['https://catalog.example/list'], chain: () => chain, skills: async () => skills, store: () => store, now: () => now, transport };
  const sync = new ServiceCatalogSync(options);
  try {
    const report = await sync.sync(); assert.equal(report.imported, 1007); assert.deepEqual(report.failures, []); assert.equal(calls.length, 6); assert.equal(store.loadAll().length, 1007);
    offline = true; assert.equal((await sync.sync()).failures.length, 1); assert.equal(store.loadAll().length, 1007);
    store.close(); const legacy = new DatabaseSync(file); legacy.exec('DROP TABLE conflicts;PRAGMA user_version=1;'); legacy.close();
    store = new ServiceAnnouncementStore(file, chain); assert.equal(store.loadAll().length, 1007);
    const cached = await discoverServices(chain.programId, skills, { ...chain, now, urls: [], announcements: store.loadAll() }); assert.equal(cached.totalVerified, 1007);
    const competing = await sign(0, 'Conflicting signed description');
    assert.throws(() => store.saveVerified(competing), ServiceEquivocationError); assert.equal(store.loadAll().length, 1006);
    const proof = store.loadRecords().find(row => row.claim.skill === competing.skill)!; assert.ok(proof.conflict);
    const peer = new ServiceAnnouncementStore(join(root, 'peer.sqlite'), chain);
    try {
      const proofTransport: typeof fetch = async () => Response.json(catalog([], undefined, [[proof.claim, proof.conflict!]]));
      const replicate = new ServiceCatalogSync({ ...options, store: () => peer, transport: proofTransport }); assert.equal((await replicate.sync()).quarantined, 1); assert.deepEqual(peer.loadAll(), []);
      const discovery = await discoverServices(chain.programId, skills, { ...chain, now, urls: ['https://catalog.example/list'], transport: async () => Response.json(catalog([proof.claim])), conflicts: [[proof.claim, proof.conflict!]] });
      assert.equal(discovery.totalVerified, 0); assert.match(discovery.failures[0].reason, /ambiguous/);
      store.close(); store = new ServiceAnnouncementStore(file, chain); assert.equal(store.loadAll().length, 1006);
      const newer = await sign(0, 'Resolved by Provider', now - 1); store.saveVerified(newer); assert.equal(store.loadAll().length, 1007);
      const resolvePeer = new ServiceCatalogSync({ ...options, store: () => peer, transport: async () => Response.json(catalog([newer])) }); assert.equal((await resolvePeer.sync()).imported, 1); assert.equal(peer.loadAll()[0].description, 'Resolved by Provider');
    } finally { peer.close(); }
    const expiredNewer = await sign(0, 'Short-lived newest version', now, now + 1);
    store.saveVerified(expiredNewer);
    const stale = await discoverServices(chain.programId, skills, { ...chain, now: now + 2, urls: ['https://catalog.example/list'], transport: async () => Response.json(catalog([claims[0]])), announcements: store.loadAll(), versions: { [claims[0].skill]: now } });
    assert.equal(stale.totalVerified, 1006); assert.ok(stale.failures.some(row => /newer retained/.test(row.reason)));
    const incomplete = new ServiceCatalogSync({ ...options, transport: async () => Response.json(catalog([await sign(0, 'Must not import', now)], 'https://other.example/list')) });
    assert.match((await incomplete.sync()).failures[0].reason, /configured endpoint/); assert.equal(store.loadAll().find(claim => claim.skill === competing.skill)!.description, 'Short-lived newest version');
  } finally { await sync.stop(); store.close(); await rm(root, { recursive: true, force: true }); }
});
