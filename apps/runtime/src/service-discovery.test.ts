import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { generateKeyPairSigner, getAddressDecoder } from '@solana/kit';
import { canonicalJson } from './canonical-json.js';
import { discoverServices } from './service-discovery.js';
const hash = (value: string) => createHash('sha256').update(value).digest();
const key = (value: string) => getAddressDecoder().decode(hash(value));
const program = key('program'), provider = key('provider'), genesis = key('genesis');
const service = (n: number) => ({ skill: key('skill' + n), provider, endpoint: `https://service.example/${n}`, name: `Service ${n}`, description: 'Public research', tags: ['research'] });
const skill = (row: ReturnType<typeof service>) => ({ address: row.skill, provider: row.provider, id: row.name, active: true,
  priceLamports: '10', priceUsdc: '1', endpointHash: hash(row.endpoint).toString('hex') });
const envelope = (services: unknown[], next?: string) => ({ format: 'agentos-service-catalog', version: 1, network: 'localnet', programId: program, services, ...(next ? { next } : {}) });
test('federated discovery paginates, filters and refuses stale cursors and cross-endpoint pagination', async () => {
  const rows = Array.from({ length: 201 }, (_, n) => service(n)); const calls: string[] = [];
  const transport: typeof fetch = async input => { calls.push(String(input)); return Response.json(String(input).includes('?page=2') ? envelope(rows.slice(200)) : envelope(rows.slice(0, 200), 'https://catalog.example/list?page=2')); };
  const options = { urls: ['https://catalog.example/list'], transport, network: 'localnet' as const, genesis };
  const first = await discoverServices(program, rows.map(skill), options); assert.equal(first.count, 200); assert.equal(first.totalMatched, 201); assert.ok(first.nextCursor);
  const second = await discoverServices(program, rows.map(skill), { ...options, cursor: first.nextCursor! }); assert.equal(second.count, 1);
  assert.equal(new Set([...first.services, ...second.services].map(item => item.address)).size, 201);
  assert.equal((await discoverServices(program, rows.map(skill), { ...options, query: 'Service 200', asset: 'USDC' })).count, 1);
  await assert.rejects(discoverServices(program, rows.map(skill).slice(1), { ...options, cursor: first.nextCursor! }), /changed/);
  const denied: string[] = [];
  const limited = await discoverServices(program, rows.map(skill), { ...options, transport: async input => { denied.push(String(input)); return Response.json(envelope([rows[0]], 'https://other.example/private')); } });
  assert.equal(denied.length, 1); assert.match(limited.catalogFailures[0].reason, /leaves/);
});
test('conflicting catalog claims are omitted, and provider signatures bind metadata and network', async () => {
  const wallet = await generateKeyPairSigner(), row = { ...service(1), provider: wallet.address };
  const now = 1791550000;
  const metadata = { domain: 'agentos-service-metadata-v1', programId: program, network: 'localnet', genesis, issuedAt: now - 10, expiresAt: now + 100, service: row };
  const signature = Buffer.from(await crypto.subtle.sign('Ed25519', wallet.keyPair.privateKey, Buffer.from(canonicalJson(metadata)))).toString('base64');
  const signed = { ...row, attestation: { issuedAt: metadata.issuedAt, expiresAt: metadata.expiresAt, genesis, signature } };
  const urls = ['https://catalog.example/list', 'https://catalog2.example/list'];
  const options = { urls, network: 'localnet' as const, genesis, now };
  const conflict = await discoverServices(program, [skill(row)], { ...options, transport: async input => Response.json(envelope([{ ...row, name: String(input).includes('catalog2') ? 'Other claim' : row.name }])) });
  assert.equal(conflict.count, 0); assert.match(conflict.failures[0].reason, /disagree/);
  const accepted = await discoverServices(program, [skill(row)], { ...options, transport: async input => Response.json(envelope([String(input).includes('catalog2') ? { ...row, name: 'Unsigned wrong claim' } : signed])) });
  assert.equal(accepted.services[0].metadataTrust, 'provider-signed'); assert.equal(accepted.services[0].metadata.name, row.name);
  for (const changed of [{ ...signed, description: 'Tampered' }, { ...signed, attestation: { ...signed.attestation, genesis: key('other chain') } }]) {
    const result = await discoverServices(program, [skill(row)], { ...options, urls: urls.slice(0, 1), transport: async () => Response.json(envelope([changed])) });
    assert.equal(result.count, 0); assert.equal(result.failures.length, 1);
  }
});
test('canonical signed JSON sorts code units and rejects non-JSON/invalid Unicode', () => {
  assert.equal(canonicalJson({ z: 1e-27, b: [true, null], a: -0 }), '{"a":0,"b":[true,null],"z":1e-27}');
  assert.throws(() => canonicalJson({ x: '\ud800' }), /Unicode/); assert.throws(() => canonicalJson([, 1]));
  assert.throws(() => canonicalJson({ x: Infinity }));
});
