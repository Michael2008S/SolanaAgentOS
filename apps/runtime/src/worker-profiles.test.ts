import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSigner } from '@solana/kit';
import { canonicalJson } from './canonical-json.js';
import { verifyWorkerProfile, WorkerProfileStore, type WorkerProfile } from './worker-profiles.js';
test('owner-signed profiles reject tampering, chain replay, expiry and rollback; reopen retains original claims', async () => {
  const owner = await generateKeyPairSigner(), agent = { address: owner.address, owner: owner.address }, now = 1791550000;
  const chain = { network: 'localnet', programId: owner.address, genesis: owner.address };
  const payload: WorkerProfile['payload'] = { domain: 'agentos-worker-profile-v1', ...chain, network: 'localnet', agent: agent.address, owner: owner.address,
    issuedAt: now - 10, expiresAt: now + 100, profile: { description: 'Public research', tags: ['research'], languages: ['中文'], models: ['DeepSeek'], availability: 'available', minimumSol: '1000000', minimumUsdc: '0' } };
  const sign = async (p: typeof payload): Promise<WorkerProfile> => ({ payload: p, signature: Buffer.from(await crypto.subtle.sign('Ed25519', owner.keyPair.privateKey, Buffer.from(canonicalJson(p)))).toString('base64') });
  const original = await sign(payload); assert.deepEqual(await verifyWorkerProfile(original, agent, chain, now), original);
  await assert.rejects(verifyWorkerProfile({ ...original, payload: { ...payload, profile: { ...payload.profile, description: 'Forged claim' } } }, agent, chain, now));
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',last=original.signature[85],alias=original.signature.slice(0,85)+alphabet[alphabet.indexOf(last)+1]+'==';
  assert.deepEqual(Buffer.from(alias,'base64'),Buffer.from(original.signature,'base64'));await assert.rejects(verifyWorkerProfile({...original,signature:alias},agent,chain,now));
  await assert.rejects(verifyWorkerProfile(original, agent, { ...chain, network: 'devnet' }, now));
  await assert.rejects(verifyWorkerProfile(original, agent, chain, now + 101));
  const root = await mkdtemp(join(tmpdir(), 'agentos-profiles-')), file = join(root, 'profiles.sqlite'); let store = new WorkerProfileStore(file,chain);
  try {
    store.saveVerified(original); store.saveVerified(original);
    const updated = await sign({ ...payload, issuedAt: now - 5, profile: { ...payload.profile, availability: 'busy' } });
    await verifyWorkerProfile(updated, agent, chain, now); store.saveVerified(updated);
    assert.throws(() => store.saveVerified(original), /newer/); store.close(); const legacy=new DatabaseSync(file);legacy.exec('DROP TABLE profile_conflicts;PRAGMA user_version=2;');legacy.close();store = new WorkerProfileStore(file,chain); assert.deepEqual(store.load(agent.address), updated);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
