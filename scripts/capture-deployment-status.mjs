import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputFiles } from './build-inputs.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (![2, 4].includes(args.length) || args[0] !== '--output' || args.length === 4 && args[2] !== '--rpc') throw new Error('Use --output /new/status.json [--rpc HTTPS_URL].');
const endpoint = new URL(args[3] || 'https://api.devnet.solana.com');
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Use a secure Devnet RPC without embedded login credentials.');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(resolve(root, 'target/sbf-safe/build-manifest.json'), 'utf8'));
if (manifest.format !== 'agentos-sbf-build' || manifest.version !== 1 || manifest.status !== 'built' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(manifest.programId) || !manifest.inputHashes) throw new Error('Valid completed build manifest required.');
if (JSON.stringify((await buildInputFiles(root)).sort()) !== JSON.stringify(Object.keys(manifest.inputHashes).sort())) throw new Error('Build manifest does not cover all current inputs.');
for (const [path, expected] of Object.entries(manifest.inputHashes)) {
 if (!(path === 'Cargo.lock' || path === 'Cargo.toml' || /^programs\/agent_os\/(Cargo.toml|src\/[a-zA-Z0-9_/-]+\.rs)$/.test(path)) || path.includes('..')) throw new Error('Invalid build manifest path.');
 if (digest(await readFile(resolve(root, path))) !== expected) throw new Error('Build input changed: '+path);
}
const binary = await readFile(resolve(root, 'target/sbf-safe/agent_os.so'));
if (digest(binary) !== manifest.binarySha256 || binary.length !== manifest.binaryBytes) throw new Error('Binary changed since build.');
const rpc = async (method, params = []) => {
 const response = await fetch(endpoint, {method:'POST', redirect:'error', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}), signal:AbortSignal.timeout(15000)});
 if (!response.ok) throw new Error('RPC HTTP '+response.status);
 const text = await response.text(); if (Buffer.byteLength(text)>5000000) throw new Error('RPC response too large.');
 const payload = JSON.parse(text); if (payload.error || !('result' in payload)) throw new Error('RPC error or missing result.'); return payload.result;
};
const genesis = await rpc('getGenesisHash');
if (genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('Not Devnet.');
const program = await rpc('getAccountInfo', [manifest.programId, {encoding:'base64',commitment:'finalized'}]);
if (!program?.context || !Number.isSafeInteger(program.context.slot) || !('value' in program) || (program.value !== null && (typeof program.value.executable !== 'boolean' || typeof program.value.owner !== 'string'))) throw new Error('Invalid Program RPC response.');
const snapshot = {format:'agentos-deployment-status',version:1,checkedAt:new Date().toISOString(),network:'devnet',rpcOrigin:endpoint.origin,genesisHash:genesis,programId:manifest.programId,slot:program.context.slot,programPresent:program.value!==null,programExecutable:program.value?.executable??false,programOwner:program.value?.owner??null,sourceBuildMatches:true,binarySha256:manifest.binarySha256,binaryBytes:manifest.binaryBytes,status:program.value===null?'not-deployed':'present-unverified-binary',limitations:['Read-only status; no deployment or transaction performed.','Present Program binary equivalence requires separate ProgramData verification.','No paid Skill, Escrow or Judge run evidence collected.','RPC path and query are omitted to avoid recording provider credentials.']};
const file = await open(resolve(args[1]), 'wx', 0o600);
try { await file.writeFile(JSON.stringify(snapshot,null,2)+'\n'); await file.sync(); } finally { await file.close(); }
console.log(JSON.stringify(snapshot,null,2));
