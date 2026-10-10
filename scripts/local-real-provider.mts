import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { localModelEnvironment } from './local-launch-options.mjs';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { loadRuntimeEnv } from '../apps/runtime/src/local-provider.js';
import { readResponseTextLimited } from '../apps/runtime/src/http-limits.js';

// This process serves real APIs on loopback. It never registers a Skill,
// signs a transaction, pays a provider, or owns an Agent Session key.
const [kind, providerText, ...flags] = process.argv.slice(2);
if (!['research', 'weather'].includes(kind) || flags.length > 1 || flags.some(flag => flag !== '--describe')) throw new Error('Use research|weather PROVIDER_PUBLIC_ADDRESS [--describe].');
const provider = address(providerText);
const program = address('HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv');
const rpc = new URL(process.env.AGENTOS_LOCAL_RPC_URL || 'http://127.0.0.1:18899');
if (!['http:', 'https:'].includes(rpc.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname) || rpc.username || rpc.password || rpc.hash) throw new Error('Use a loopback Localnet RPC.');
async function request(method: string, params: unknown[] = []) {
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Local RPC request failed.');
  const text = await readResponseTextLimited(response, 2_000_000, 'Local RPC response exceeds 2 MB.');
  const payload = JSON.parse(text);
  if (payload.error || !Object.hasOwn(payload, 'result')) throw new Error(`Local RPC ${method} failed.`);
  return payload.result;
}
const genesis = await request('getGenesisHash');
if (typeof genesis !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis) || genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('Expected an independent Localnet genesis.');
getAddressEncoder().encode(address(genesis));
const account = (await request('getAccountInfo', [program, { encoding: 'base64', commitment: 'finalized' }]))?.value;
if (!account?.executable || account.owner !== 'BPFLoaderUpgradeab1e11111111111111111111111') throw new Error('Local AgentOS Program is not executable under the expected loader.');
if (kind === 'research') {
 const values = parseEnv(await readFile(new URL('../apps/runtime/.env', import.meta.url), 'utf8'));
 Object.assign(process.env, localModelEnvironment({ realModel: true, fixtureMode: false }, process.env, values));
}
loadRuntimeEnv();
process.env.AGENTOS_CLUSTER = 'localnet';
process.env.AGENTOS_LOCALNET_GENESIS_HASH = genesis;
process.env.SOLANA_RPC_URL = rpc.href;
process.env.AGENTOS_PROGRAM_ID = program;
process.env.AGENTOS_DATA_DIR = resolve(`apps/runtime/.data/localnet/${genesis}/real-model`);
process.env.AGENTOS_WEB_ORIGINS = 'http://127.0.0.1:15173,http://localhost:15173';
process.env.AGENTOS_LOCAL_MODEL_URL = '';
const name = `live-${kind}`, port = kind === 'research' ? 18791 : 18792;
const id = new Uint8Array(32); id.set(new TextEncoder().encode(name));
const [skill] = await getProgramDerivedAddress({ programAddress: program, seeds: [new TextEncoder().encode('skill'), getAddressEncoder().encode(provider), id] });
process.env[`AGENTOS_${kind.toUpperCase()}_SKILL`] = skill;
process.env[`AGENTOS_${kind.toUpperCase()}_PORT`] = String(port);
console.log(JSON.stringify({ kind, name, provider, skill, program, genesis, endpoint: `http://127.0.0.1:${port}/${kind}`,
  suggestedSolPrice: '0.001', suggestedUsdcPrice: '0', mode: 'real-service',
  scope: `Read-only startup; registration and payment require separate wallet review. Research uses ${process.env.AGENTOS_MODEL_PROVIDER === 'deepseek' ? 'DeepSeek with official Solana documents from the GitHub API' : 'OpenAI web search'} and incurs API charges; Weather reads US National Weather Service.` }, null, 2));
if (!flags.includes('--describe')) {
  if (kind === 'research') {
    if (!process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY.trim() === 'local-test-fixture') throw new Error('Research requires a real API credential. No model request has been sent.');
    await import('../apps/runtime/src/research-provider.js');
  } else await import('../apps/runtime/src/weather-provider.js');
}
