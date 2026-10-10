import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { localLaunchOptions, localModelEnvironment } from './local-launch-options.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const options = localLaunchOptions(process.argv.slice(2));
const { target, fixtureMode, realModel, workers } = options;
let fileValues = {};
if (realModel) {
 try { fileValues = parseEnv(await readFile(resolve(root, 'apps/runtime/.env'), 'utf8')); }
 catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
const modelEnv = localModelEnvironment(options, process.env, fileValues);
const rpc = new URL(process.env.AGENTOS_LOCAL_RPC_URL || 'http://127.0.0.1:18899');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname) || !['http:', 'https:'].includes(rpc.protocol) || rpc.username || rpc.password || rpc.hash) throw new Error('Local RPC must be a loopback HTTP(S) URL.');
const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }), signal: AbortSignal.timeout(10000) });
const payload = await response.json();
if (!response.ok || payload.error || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payload.result) || payload.result === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('Expected a healthy independent local chain.');
const program = 'HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv';
const programResponse = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getAccountInfo', params: [program, { encoding: 'base64', commitment: 'confirmed' }] }), signal: AbortSignal.timeout(10000) });
const programPayload = await programResponse.json();
if (!programResponse.ok || programPayload.error || !programPayload.result?.value?.executable) throw new Error('Local AgentOS Program is missing or not executable. Start a fresh validator ledger with --bpf-program before launching the Runtime or web app.');
// A real-model launch must not replay restored fixture Worker jobs or expose
// deterministic test results as real-model Memory/history.
const dataDirectory = resolve(root, `apps/runtime/.data/localnet/${payload.result}`, realModel ? 'real-model' : '.');
const env = { ...process.env, AGENTOS_CLUSTER: 'localnet', AGENTOS_LOCALNET_GENESIS_HASH: payload.result,
 SOLANA_RPC_URL: rpc.href, AGENTOS_PROGRAM_ID: program, AGENTOS_DATA_DIR: dataDirectory,
 AGENTOS_DATABASE_PATH: resolve(dataDirectory, 'agentos.sqlite'),
 VITE_AGENTOS_CLUSTER: 'localnet', VITE_AGENTOS_LOCALNET_GENESIS_HASH: payload.result, VITE_SOLANA_RPC_URL: rpc.href, VITE_AGENTOS_PROGRAM_ID: program,
 AGENTOS_RUNTIME_URL: `http://127.0.0.1:${process.env.AGENTOS_LOCAL_RUNTIME_PORT || '18787'}`, AGENTOS_WEB_ORIGINS: 'http://127.0.0.1:15173,http://localhost:15173',
 AGENTOS_PERSIST_MEMORY: 'true', AGENTOS_PERSIST_HISTORY: 'true', AGENTOS_PERSIST_ESCROW_HANDOFFS: 'true',
 PORT: process.env.AGENTOS_LOCAL_RUNTIME_PORT || '18787', ...modelEnv, AGENTOS_WORKER_AUTORUN: workers.join(','),
};
if (fixtureMode) {
 console.log('LOCAL TEST FIXTURE enabled: deterministic responses, no external AI requests.');
}
if (realModel) console.log(`REAL MODEL enabled: ${env.OPENAI_MODEL}; requests go to ${env.AGENTOS_MODEL_PROVIDER} and incur API charges. No chain signing is performed by this launcher.`);
if (workers.length) console.log(`Local ${fixtureMode ? 'fixture' : 'real-model'} Worker discovery enabled for ${workers.join(', ')}. Only verified shared tasks are accepted; delivery still requires the browser Session and Escrow Permit.`);
console.log(`Local ${target}: RPC ${rpc.href}; genesis ${payload.result}; data ${env.AGENTOS_DATA_DIR}`);
const child = spawn(process.execPath, target === 'runtime' ? ['--import', 'tsx', fixtureMode ? 'scripts/local-fixture-runtime.mts' : 'apps/runtime/src/index.ts'] : ['node_modules/vite/bin/vite.js', 'apps/web', '--host', '127.0.0.1', '--port', '15173', '--strictPort'], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
