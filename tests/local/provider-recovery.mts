import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodePaymentSignatureHeader } from '@x402/core/http';

// Read-only regression against the existing browser demo; every request is result-only.
const rpcUrl = 'http://127.0.0.1:18899';
const endpoint = 'http://127.0.0.1:18788/fixture';
const agent = 'Gd4a8KNBnaxM4kcpuH9cPZEat2gW2ooHXrsor3GqFhgK';
const provider = '7tX58PLDej8ggt7eRz99QBnAQPFu4rhcicGMMUs3koCi';
const execution = '13THVxBBXjX5LUbMzPrctDJgfMXEFa1g2RMpJmXVSqM4';
const skill = 'E3ayCekozqb6xf3kCjmJE8kvoHKFtEWbMHw9Y9MjNuzu';
const signature = '3Xv697rMceynbXYEbU9sgXEd4QRozsuuEV82i3e4bdLK9YMgDDDrL8wfSbhDqqgH5Mxp8aCA7eMWFp3Y8v8VCWe1';
const prompt = 'Summarize the AgentOS local payment, result verification, and Memory recovery demo.';
const inputHash = createHash('sha256').update(JSON.stringify({ skill, prompt })).digest('hex');
async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const result = await response.json(); assert.ok(response.ok && !result.error); return result.result;
}
const genesis = await rpc('getGenesisHash');
assert.equal(genesis, 'tKbuTej3RaSxUuAhSARJA1xkDQqD2LagczdqbHqLewC', 'Run only against the original browser demo ledger.');
const accepted = { scheme: 'agentos-vault', network: `solana:${genesis.slice(0, 32)}` as `solana:${string}`, asset: 'SOL', amount: '1000000', payTo: provider, maxTimeoutSeconds: 120, extra: { agentosProtocol: 'agentos-vault-v1', programId: 'HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv', skill, inputHash } };
const payload = { x402Version: 2, resource: { url: endpoint }, accepted, payload: { signature, execution, agent, skill, inputHash } };
const body = { protocol: 'agentos-skill-v2', agent, paymentPreference: 'SOL', skill: { address: skill }, request: { skill, prompt, sha256: inputHash } };
async function retrieve(proof = payload, requestBody = body) {
  return fetch(endpoint, { method: 'POST', headers: { origin: 'http://127.0.0.1:15173', 'content-type': 'application/json', 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(proof), 'AGENTOS-RESULT-ONLY': 'true' }, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(15_000) });
}
const before = await rpc('getBalance', [provider]);
const response = await retrieve(); assert.equal(response.status, 200); assert.ok(response.headers.get('PAYMENT-RESPONSE'));
const content = await response.text(); assert.equal(createHash('sha256').update(content).digest('hex'), '9907cc6b946460da015ac0c074b83d6ee2f72ec0468b1f02e74721f64e07fe0a');
const repeat = await retrieve(); assert.equal(repeat.status, 200); assert.equal(await repeat.text(), content);
const cases = [
  { ...payload, payload: { ...payload.payload, signature: '1'.repeat(88) } },
  { ...payload, accepted: { ...accepted, amount: '1000001' } },
  { ...payload, accepted: { ...accepted, payTo: agent } },
  { ...payload, payload: { ...payload.payload, execution: agent } },
];
for (const changed of cases) { const rejected = await retrieve(changed); assert.notEqual(rejected.status, 200); await rejected.body?.cancel(); }
const wrongPrompt = await retrieve(payload, { ...body, request: { ...body.request, prompt: 'Changed request' } }); assert.notEqual(wrongPrompt.status, 200); await wrongPrompt.body?.cancel();
assert.equal((await rpc('getBalance', [provider])).value, before.value);
console.log('Passed: original response/hash, repeat retrieval, five tampered requests rejected, unchanged payer balance. No transactions submitted.');
