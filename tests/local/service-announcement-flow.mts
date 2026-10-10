import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { canonicalJson } from '../../apps/runtime/src/canonical-json.ts';
import { discoverServices } from '../../apps/runtime/src/service-discovery.ts';
if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Use --run for isolated Localnet genesis-fixture verification. No transactions or real-model calls.');
const quotaFile = resolve('docs/evidence/deepseek-goal-20261009-quota.json'), quotaBefore = await readFile(quotaFile, 'utf8');
const root = await mkdtemp(join(tmpdir(), 'agentos-service-announcement-')), fixtures = join(root, 'accounts'); await mkdir(fixtures);
const directory = resolve('docs/evidence/service-announcements-' + new Date().toISOString().replace(/[:.]/g, '-')); await mkdir(directory);
const programId = 'HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv', rpc = 'http://127.0.0.1:19899', origin = 'http://127.0.0.1:19787';
const owner = await generateKeyPairSigner(), endpoint = 'https://research.example/public';
const hash = (value: string) => createHash('sha256').update(value).digest();
const accounts: string[] = [];
for (let index = 0; index < 1007; index++) {
  const id = Buffer.alloc(32); id.write('service-' + index);
  const [skill, bump] = await getProgramDerivedAddress({ programAddress: address(programId), seeds: [Buffer.from('skill'), getAddressEncoder().encode(owner.address), id] });
  const data = Buffer.alloc(130); hash('account:Skill').subarray(0, 8).copy(data); Buffer.from(getAddressEncoder().encode(owner.address)).copy(data, 8); id.copy(data, 40); hash(endpoint).copy(data, 72);
  data.writeBigUInt64LE(1000n, 104); data[112] = 1; data[113] = bump; data.writeBigUInt64LE(1n, 114); accounts.push(skill);
  await writeFile(join(fixtures, skill + '.json'), JSON.stringify({ pubkey: skill, account: { lamports: 2_000_000, data: [data.toString('base64'), 'base64'], owner: programId, executable: false, rentEpoch: 0 } }));
}
const children: ChildProcess[] = [], logs: Record<string, string> = {};
function launch(name: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); logs[name] = '';
  child.stdout?.on('data', bytes => { logs[name] += bytes; }); child.stderr?.on('data', bytes => { logs[name] += bytes; }); child.on('error', error => { logs[name] += error.message; }); return child;
}
const rpcCall = async (method: string) => { const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }), signal: AbortSignal.timeout(1000) }); const b = await r.json() as any; if (!r.ok || b.error) throw new Error('RPC unavailable'); return b.result; };
async function wait(test: () => Promise<boolean>, child: ChildProcess) { for (let n = 0; n < 160; n++) { if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture process stopped'); try { if (await test()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 250)); } throw new Error('Fixture readiness timeout'); }
async function stop(child: ChildProcess) { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
const report: any = { status: 'running', transactions: 0, modelRequests: 0, scope: 'Actual isolated Localnet and Runtime with canonical genesis-loaded Skill fixtures; does not test Skill registration transactions or public-domain deployment.' };
try {
  try { await rpcCall('getHealth'); throw new Error('Isolated RPC port is already occupied; existing validator preserved.'); } catch (error) { if ((error as Error).message.includes('occupied')) throw error; }
  try { await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) }); throw new Error('Isolated Runtime port is already occupied; existing service preserved.'); } catch (error) { if ((error as Error).message.includes('occupied')) throw error; }
  const validator = launch('validator', 'solana-test-validator', ['--ledger', join(root, 'ledger'), '--rpc-port', '19899', '--faucet-port', '19901', '--gossip-port', '19902', '--mint', owner.address, '--account-dir', fixtures, '--quiet'], { NO_DNA: '1' });
  await wait(async () => await rpcCall('getHealth') === 'ok', validator); const genesis = await rpcCall('getGenesisHash'); report.genesis = genesis;
  const env = { PORT: '19787', AGENTOS_CLUSTER: 'localnet', AGENTOS_LOCALNET_GENESIS_HASH: genesis, SOLANA_RPC_URL: rpc, AGENTOS_PROGRAM_ID: programId, AGENTOS_DATA_DIR: join(root, 'runtime'),
    AGENTOS_AUTONOMOUS_TENANTS: '', AGENTOS_PUBLIC_PORT: '', AGENTOS_WORKER_AUTORUN: '', AGENTOS_SERVICE_CATALOG_URL: '', AGENTOS_SERVICE_CATALOG_URLS: '[]', OPENAI_API_KEY: 'disabled-local-fixture', AGENTOS_STORAGE_BACKEND: 'json' };
  const startRuntime = async (name: string) => { const child = launch(name, process.execPath, ['--import', 'tsx', 'apps/runtime/src/index.ts'], env); await wait(async () => (await fetch(origin + '/api/health')).ok, child); return child; };
  let runtime = await startRuntime('runtime-before');
  const api = async (path: string, body?: unknown) => { const r = await fetch(origin + path, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) }); return { status: r.status, body: await r.json() as any }; };
  const registry = await api('/api/on-chain/skills'); assert.equal(registry.status, 200); assert.equal(registry.body.count, 1007); assert.deepEqual(registry.body.skills.map((s: any) => s.address).sort(), accounts.sort());
  const service = { skill: accounts.at(-1)!, provider: owner.address, endpoint, name: 'Public research', description: 'Signed genesis-fixture service', tags: ['research'] };
  const issuedAt = Math.floor(Date.now() / 1000), expiresAt = issuedAt + 3600;
  const signature = Buffer.from(await crypto.subtle.sign('Ed25519', owner.keyPair.privateKey, Buffer.from(canonicalJson({ domain: 'agentos-service-metadata-v1', programId, network: 'localnet', genesis, issuedAt, expiresAt, service })))).toString('base64');
  const claim = { ...service, attestation: { issuedAt, expiresAt, genesis, signature } };
  assert.equal((await api('/api/marketplace/services/announce', { ...claim, name: 'Forged' })).status, 400);
  assert.equal((await api('/api/marketplace/services/announce', claim)).status, 200);
  const local = await api('/api/on-chain/services'); assert.equal(local.status, 200); assert.equal(local.body.count, 1); assert.equal(local.body.services[0].metadataTrust, 'provider-signed'); assert.equal(local.body.unresolvedSkills, 1006); assert.equal(local.body.truncated, false);
  await stop(runtime); runtime = await startRuntime('runtime-after');
  const original = await api('/api/marketplace/services/catalog'); assert.equal(original.status, 200); assert.deepEqual(original.body.services, [claim]);
  const independent = await discoverServices(programId, registry.body.skills, { network: 'localnet', genesis, urls: [origin + '/api/marketplace/services/catalog'] });
  assert.equal(independent.count, 1); assert.equal(independent.services[0].address, service.skill); assert.equal(independent.services[0].metadataTrust, 'provider-signed');
  assert.equal((await api('/api/marketplace/services/announce', claim)).body.changed, false);
  const peerOrigin = 'http://127.0.0.1:19788';
  const startPeer = async (name: string) => {
    const child = launch(name, process.execPath, ['--import', 'tsx', 'apps/runtime/src/index.ts'], { ...env, PORT: '19788', AGENTOS_DATA_DIR: join(root, 'peer'), AGENTOS_SERVICE_CATALOG_URLS: JSON.stringify([origin + '/api/marketplace/services/catalog']) });
    await wait(async () => { const response = await fetch(peerOrigin + '/api/health'); const health = await response.json() as any; return response.ok && health.serviceCatalogSync?.checkedAt > 0; }, child); return child;
  };
  try { await fetch(peerOrigin + '/api/health', { signal: AbortSignal.timeout(1000) }); throw new Error('Isolated peer Runtime port is already occupied; existing service preserved.'); } catch (error) { if ((error as Error).message.includes('occupied')) throw error; }
  let peer = await startPeer('peer-online');
  const synced = await (await fetch(peerOrigin + '/api/health')).json() as any; assert.equal(synced.serviceCatalogSync.imported, 1); assert.deepEqual(synced.serviceCatalogSync.failures, []);
  const competingService = { ...service, description: 'Conflicting Provider description' };
  const competingSignature = Buffer.from(await crypto.subtle.sign('Ed25519', owner.keyPair.privateKey, Buffer.from(canonicalJson({ domain: 'agentos-service-metadata-v1', programId, network: 'localnet', genesis, issuedAt, expiresAt, service: competingService })))).toString('base64');
  const competing = { ...competingService, attestation: { issuedAt, expiresAt, genesis, signature: competingSignature } };
  assert.equal((await api('/api/marketplace/services/announce', competing)).status, 409);
  const conflictCatalog = await api('/api/marketplace/services/catalog'); assert.equal(conflictCatalog.body.version, 2); assert.equal(conflictCatalog.body.conflicts.length, 1);
  await writeFile(join(directory, 'conflict-catalog.json'), JSON.stringify(conflictCatalog.body, null, 2) + '\n');
  await stop(peer); peer = await startPeer('peer-conflict');
  const conflicted = await (await fetch(peerOrigin + '/api/on-chain/services')).json() as any; assert.equal(conflicted.count, 0);
  const proofAtPeer = await (await fetch(peerOrigin + '/api/marketplace/services/catalog')).json() as any; assert.equal(proofAtPeer.version, 2); assert.equal(proofAtPeer.conflicts.length, 1);
  const newerIssue = Math.floor(Date.now() / 1000); assert.ok(newerIssue > issuedAt);
  const resolvedService = { ...service, description: 'Resolved by a newer Provider version' }, newerExpiry = newerIssue + 3600;
  const resolvedSignature = Buffer.from(await crypto.subtle.sign('Ed25519', owner.keyPair.privateKey, Buffer.from(canonicalJson({ domain: 'agentos-service-metadata-v1', programId, network: 'localnet', genesis, issuedAt: newerIssue, expiresAt: newerExpiry, service: resolvedService })))).toString('base64');
  assert.equal((await api('/api/marketplace/services/announce', { ...resolvedService, attestation: { issuedAt: newerIssue, expiresAt: newerExpiry, genesis, signature: resolvedSignature } })).status, 200);
  await stop(peer); peer = await startPeer('peer-resolved');
  const resolved = await (await fetch(peerOrigin + '/api/on-chain/services')).json() as any; assert.equal(resolved.count, 1); assert.equal(resolved.services[0].metadata.description, resolvedService.description);
  report.providerEquivocation = { publicationRejected409: true, proofReplicated: true, peerQuarantinePersists: true, newerProviderVersionResolves: true };
  await stop(runtime); await stop(peer); peer = await startPeer('peer-source-offline');
  const peerHealth = await (await fetch(peerOrigin + '/api/health')).json() as any; assert.equal(peerHealth.serviceCatalogSync.failures.length, 1);
  const offline = await (await fetch(peerOrigin + '/api/on-chain/services')).json() as any; assert.equal(offline.count, 1); assert.equal(offline.services[0].address, service.skill); assert.equal(offline.services[0].metadataTrust, 'provider-signed');
  report.peerReplication = { imported: synced.serviceCatalogSync.imported, offlineRestartRetainsVerifiedService: true, sourceFailureReported: true };
  assert.equal(await readFile(quotaFile, 'utf8'), quotaBefore);
  await writeFile(join(directory, 'catalog.json'), JSON.stringify(original.body, null, 2) + '\n');
  Object.assign(report, { status: 'passed', programId, completeRegistryAccounts: registry.body.count, signedService: service.skill, restartRetainsPublication: true, independentFederationVerified: true, unsignedTamperingRejected: true, exactRetryIdempotent: true, realModelQuotaUnchanged: true });
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : 'Failed'; process.exitCode = 1; }
finally { for (const child of children.reverse()) await stop(child); for (const [name, log] of Object.entries(logs)) await writeFile(join(directory, name + '.log'), log); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await rm(root, { recursive: true, force: true }); console.log(JSON.stringify({ status: report.status, evidence: directory })); }
