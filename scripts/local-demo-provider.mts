import { resolve } from 'node:path';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

// Read-only startup: registration and payments remain wallet-reviewed UI actions.
const provider = address(process.argv[2] || '');
const name = 'local-demo-research';
const program = address('HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv');
const rpc = new URL(process.env.AGENTOS_LOCAL_RPC_URL || 'http://127.0.0.1:18899');
if (rpc.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname) || rpc.username || rpc.password || rpc.hash) throw new Error('Use a loopback Localnet RPC.');
const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }), signal: AbortSignal.timeout(10_000) });
const payload = await response.json();
if (!response.ok || payload.error || typeof payload.result !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payload.result) || payload.result === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('Expected an independent Localnet genesis.');
process.env.AGENTOS_CLUSTER = 'localnet';
process.env.AGENTOS_LOCALNET_GENESIS_HASH = payload.result;
process.env.SOLANA_RPC_URL = rpc.href;
process.env.AGENTOS_DATA_DIR = resolve(`apps/runtime/.data/localnet/${payload.result}`);
const skillId = new Uint8Array(32);
skillId.set(new TextEncoder().encode(name));
const [skill] = await getProgramDerivedAddress({ programAddress: program, seeds: [new TextEncoder().encode('skill'), getAddressEncoder().encode(provider), skillId] });
const resourceUrl = 'http://127.0.0.1:18788/fixture';
const { createAgentOsVaultSkillHandler } = await import('../apps/runtime/src/x402-vault.ts');
const { localClaimExecution, serveLocalProvider } = await import('../apps/runtime/src/local-provider.ts');
const { localSkillResultStore } = await import('../apps/runtime/src/skill-result-store.ts');
const handler = createAgentOsVaultSkillHandler({ programId: program, skill, resourceUrl, rpcUrl: rpc.href,
  allowedOrigins: ['http://127.0.0.1:15173', 'http://localhost:15173'],
  claimExecution: localClaimExecution('browser-demo'), resultStore: localSkillResultStore('browser-demo', program),
  execute: async ({ prompt }) => ({ mode: 'local-test-fixture', prompt, summary: 'AgentOS local demonstration: a reviewed Skill payment unlocks this deterministic response. This is test data, not live research.', facts: ['Payment proof is checked against the local chain.', 'Response hashes can be recorded on chain.', 'Saved results can be restored from local Agent Memory.'] }),
});
console.log(JSON.stringify({ name, skill, provider, resourceUrl, genesis: payload.result, suggestedSolPrice: '0.001', suggestedUsdcPrice: '0' }, null, 2));
serveLocalProvider(18788, '/fixture', resourceUrl, handler);
