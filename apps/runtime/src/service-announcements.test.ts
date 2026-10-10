import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSigner, getAddressDecoder } from '@solana/kit';
import { canonicalJson } from './canonical-json.js';
import { discoverServices, verifyServiceClaim, type ServiceClaim, type DiscoverySkill } from './service-discovery.js';
import { ServiceAnnouncementStore, serviceAnnouncementHandler, serviceAnnouncementRoute } from './service-announcements.js';
import { createPublicApiServer } from './autonomous-public-server.js';
import type { AutonomousController } from './autonomous-controller.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (value: string) => getAddressDecoder().decode(createHash('sha256').update(value).digest());
async function fixture() {
  const signer = await generateKeyPairSigner(), now = 1791550000;
  const chain = { programId: key('program'), network: 'localnet' as const, genesis: key('genesis') };
  const metadata = { skill: key('skill'), provider: signer.address, endpoint: 'https://research.example/public', name: 'Research', description: 'Public research', tags: ['research'] };
  const skill = { address: metadata.skill, provider: signer.address, id: 'research', active: true, priceLamports: '1000', priceUsdc: '1', endpointHash: digest(metadata.endpoint) };
  const sign = async (service = metadata, issuedAt = now - 10): Promise<ServiceClaim> => ({ ...service, attestation: { issuedAt, expiresAt: now + 100,
    genesis: chain.genesis, signature: Buffer.from(await crypto.subtle.sign('Ed25519', signer.keyPair.privateKey, Buffer.from(canonicalJson({ domain: 'agentos-service-metadata-v1', ...chain, issuedAt, expiresAt: now + 100, service })))).toString('base64') } });
  return { now, chain, metadata, skill, sign };
}
test('signed announcements bind provider, endpoint and full chain; restart preserves monotonic versions', async () => {
  const f = await fixture(), claim = await f.sign();
  await verifyServiceClaim(claim, f.skill, f.chain, f.now, true);
  for (const [value, skill, chain, now] of [
    [{ ...claim, name: 'Forged' }, f.skill, f.chain, f.now], [claim, { ...f.skill, provider: key('other') }, f.chain, f.now],
    [claim, { ...f.skill, endpointHash: digest('different') }, f.chain, f.now], [claim, f.skill, { ...f.chain, genesis: key('other') }, f.now],
    [claim, f.skill, { ...f.chain, programId: key('other') }, f.now], [claim, f.skill, f.chain, f.now + 101], [claim, f.skill, f.chain, f.now - 11],
  ] as const) await assert.rejects(verifyServiceClaim(value, skill, chain, now, true));
  const root = await mkdtemp(join(tmpdir(), 'agentos-announcements-')), file = join(root, 'claims.sqlite'); let store = new ServiceAnnouncementStore(file, f.chain);
  try {
    assert.equal(store.saveVerified(claim), true); assert.equal(store.saveVerified(claim), false);
    const updated = await f.sign({ ...f.metadata, description: 'Updated research' }, f.now - 5);
    store.saveVerified(updated); assert.throws(() => store.saveVerified(claim), /newer/);
    store.close(); store = new ServiceAnnouncementStore(file, f.chain); assert.deepEqual(store.loadAll(), [updated]);
    const other = new ServiceAnnouncementStore(file, { ...f.chain, genesis: key('other') }); assert.deepEqual(other.loadAll(), []); other.close();
    const discovered = await discoverServices(f.chain.programId, [f.skill], { ...f.chain, now: f.now, urls: [], announcements: store.loadAll() });
    assert.equal(discovered.count, 1); assert.equal(discovered.catalogConfigured, true); assert.equal(discovered.catalogCount, 1); assert.equal(discovered.services[0].metadataTrust, 'provider-signed'); assert.equal(discovered.unresolvedSkills, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
test('public admission, durable publication and federated reads work without exposing autonomous routes', async () => {
  const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'agentos-public-catalog-')), file = join(root, 'claims.sqlite');
  let store = new ServiceAnnouncementStore(file, f.chain), rpcReads = 0, currentSkills: DiscoverySkill[] = [f.skill], now = f.now, origin = '';
  const handler = serviceAnnouncementHandler({ chain: () => f.chain, store: () => store, skills: async () => { rpcReads++; return currentSkills; }, origin: () => origin, now: () => now });
  const controller = { authorized: () => false, handle: async () => { throw new Error('Public catalog must not reach the controller'); } } as unknown as AutonomousController;
  const server = await createPublicApiServer(controller, { port: 0, bind: '127.0.0.1', origin: 'http://127.0.0.1', browserOrigins: ['http://localhost'] }, { matches: serviceAnnouncementRoute, handle: handler });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const listener = server.address(); assert.ok(listener && typeof listener !== 'string'); origin = 'http://127.0.0.1:' + listener.port;
  const transport: typeof fetch = (input, init = {}) => new Promise<Response>((resolve, reject) => {
    const target = new URL(String(input));
    const request = httpRequest(target, { method: init.method ?? 'GET', headers: { ...Object.fromEntries(new Headers(init.headers)), host: '127.0.0.1' } }, incoming => {
      const parts: Buffer[] = []; incoming.on('data', bytes => parts.push(Buffer.from(bytes))); incoming.on('end', () => resolve(new Response(Buffer.concat(parts), { status: incoming.statusCode!, headers: { 'content-type': 'application/json' } })));
    }); request.on('error', reject); request.end(init.body);
  });
  const post = (body: unknown, path = '/api/marketplace/services/announce') => transport(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const claim = await f.sign();
    assert.equal((await post({ ...claim, name: 'Forged' })).status, 400); assert.equal(rpcReads, 0);
    assert.equal((await post({ text: 'x'.repeat(9000) })).status, 413); assert.equal(rpcReads, 0);
    assert.equal((await post(claim)).status, 200); assert.equal(rpcReads, 1);
    assert.equal((await (await post(claim)).json() as any).changed, false);
    assert.equal((await transport(origin + '/api/autonomous/scope')).status, 401);
    assert.equal((await transport(origin + '/execute')).status, 404);
    assert.equal((await post(claim, '/api/marketplace/services/announce?token=secret')).status, 404);
    assert.equal((await transport(origin + '/api/marketplace/services/catalog', { headers: { origin: 'https://evil.example' } })).status, 403);
    const update = await f.sign({ ...f.metadata, description: 'New version' }, f.now - 5);
    assert.equal((await post(update)).status, 200); assert.equal((await post(claim)).status, 400);
    store.close(); store = new ServiceAnnouncementStore(file, f.chain);
    const result = await discoverServices(f.chain.programId, [f.skill], { ...f.chain, now, urls: [origin + '/api/marketplace/services/catalog'], transport });
    assert.equal(result.count, 1); assert.equal(result.services[0].metadata.description, 'New version'); assert.equal(result.services[0].metadataTrust, 'provider-signed');
    const bulkSkills = [];
    for (let index = 0; index < 200; index++) {
      const claim = await f.sign({ ...f.metadata, skill: key('bulk-' + index), name: 'Service ' + index });
      const skill = { ...f.skill, address: claim.skill }; bulkSkills.push(skill);
      await verifyServiceClaim(claim, skill, f.chain, now, true); store.saveVerified(claim);
    }
    currentSkills = [f.skill, ...bulkSkills];
    const first = await (await transport(origin + '/api/marketplace/services/catalog')).json() as any;
    assert.equal(first.services.length, 200); assert.ok(first.next);
    const second = await (await transport(first.next)).json() as any; assert.equal(second.services.length, 1);
    assert.equal(new Set([...first.services, ...second.services].map((claim: any) => claim.skill)).size, 201);
    const federated = await discoverServices(f.chain.programId, currentSkills, { ...f.chain, now, urls: [origin + '/api/marketplace/services/catalog'], transport });
    assert.equal(federated.totalVerified, 201); assert.equal(federated.truncated, false); assert.ok(federated.nextCursor);
    store.saveVerified(await f.sign({ ...f.metadata, description: 'Newest version' }, f.now));
    assert.equal((await transport(first.next)).status, 502);
    currentSkills = [{ ...f.skill, active: false }]; assert.equal((await (await transport(origin + '/api/marketplace/services/catalog')).json() as any).services.length, 0);
    currentSkills = [f.skill]; now += 101; assert.equal((await (await transport(origin + '/api/marketplace/services/catalog')).json() as any).services.length, 0);
    assert.equal(store.loadAll().length, 201); // Expired versions retain their rollback watermark.
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); }
});
