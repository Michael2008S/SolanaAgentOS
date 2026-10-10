import assert from 'node:assert/strict';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { LocalHarness, digest, hex } from '../tests/local/harness.mts';
import * as sdk from '../apps/web/src/lib/agentOs.ts';
import { localModelEnvironment } from './local-launch-options.mjs';
import { readResponseTextLimited } from '../apps/runtime/src/http-limits.js';
import { redactModelError } from '../apps/runtime/src/model-diagnostics.js';

// Explicit acceptance command: isolated Localnet, ephemeral in-memory signers,
// real provider HTTP requests, shared existing model quota, no browser keys.
if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Use --run to execute isolated real-model acceptance.');
const quota = resolve('docs/evidence/deepseek-goal-20261009-quota.json');
const used = async () => JSON.parse(await readFile(quota, 'utf8')).requests.length as number;
const limit=JSON.parse(await readFile(quota,'utf8')).limit as number;
assert.ok([5,10,100].includes(limit),'Unexpected model authorization limit.');
const before = await used();
assert.ok(before <= limit-3, 'At least three authorized model requests are needed. No request sent.');
const modelEnv = localModelEnvironment({ realModel: true, fixtureMode: false }, process.env, parseEnv(await readFile('apps/runtime/.env', 'utf8')));
assert.equal(modelEnv.AGENTOS_MODEL_PROVIDER, 'deepseek');
const directory = resolve('docs/evidence/real-model-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: false });
const h = new LocalHarness();
const evidence: any = { format: 'agentos-real-model-acceptance', version: 1, status: 'running', model: modelEnv.OPENAI_MODEL, startedAt: new Date().toISOString(), stage: 'startup', modelRequestsBefore: before, steps: [], transactions: [], limitations: ['Isolated Localnet with temporary in-memory identities; no user wallet or Devnet.', 'Research retrieves official Solana documents; Weather reads live NWS data.', 'Hash commitments prove exact output integrity, not factual correctness.'] };
async function save(name: string, value: unknown) { await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
async function stage(name: string) { evidence.stage = name; await save('report', evidence); console.log('Acceptance stage: ' + name); }
async function tx(name: string, instructions: Parameters<LocalHarness['tx']>[1], signers: Parameters<LocalHarness['tx']>[2] = []) {
 assert.ok(h.sent < 12, 'Acceptance transaction limit exceeded.');
 const signature = await h.tx(name, instructions, signers);
 for (let n = 0; n < 100; n++) {
  const result = await h.rpc('getTransaction', [signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  if (result) {
   assert.equal(result.meta.err, null); assert.ok(result.meta.fee <= 10000);
   const raw = JSON.stringify({ jsonrpc: '2.0', result }, (_key, value) => typeof value === 'bigint' ? (JSON as any).rawJSON(value.toString()) : value);
   const file = await open(join(directory, signature + '.json'), 'wx', 0o600);
   try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
   evidence.transactions.push({ name, signature, slot: result.slot, fee: result.meta.fee, rawSha256: hex(digest(raw)) });
   await save('report', evidence); return signature;
  }
  await new Promise(resolve => setTimeout(resolve, 100));
 }
 throw new Error('Original finalized transaction unavailable; acceptance stopped.');
}
async function api(path: string, value: unknown) {
 const response = await fetch(h.runtimeUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(55000) });
 const body = await readResponseTextLimited(response, 1_000_000, 'Runtime response exceeded 1 MB.');
 if (!response.ok) {
  // Errors from transport, JSON decoding and validation share redaction so
  // malformed successful responses do not collapse to an unhelpful HTTP 502.
  const error = JSON.parse(body).error;
  evidence.diagnostics = redactModelError(error);
  throw new Error('Runtime stage failed; see safe diagnostics.');
 }
 return JSON.parse(body);
}
try {
 await h.start(); h.approved = true;
 // A fresh validator's RPC can accept transactions before its local TPU has
 // stabilized. Wait for confirmed slots and retain the same signed transaction
 // during RPC forwarding retries; never create another payment attempt.
 const originalRpc = h.rpc.bind(h);
 h.rpc = (method, params = []) => originalRpc(method, method === 'sendTransaction' ? [params[0], { ...(params[1] as object), maxRetries: 30 }] : params);
 for (let n=0;n<150;n++) { if(await h.rpc('getSlot',[{commitment:'confirmed'}])>=32)break;await new Promise(resolve=>setTimeout(resolve,200)); }
 assert.ok(await h.rpc('getSlot',[{commitment:'confirmed'}])>=32,'Local validator did not stabilize.');
 Object.assign(process.env, modelEnv, { AGENTOS_MODEL_REQUEST_LIMIT: String(limit), AGENTOS_MODEL_BUDGET_PATH: quota, AGENTOS_MODEL_DIAGNOSTICS_PATH:join(directory,'model-diagnostics.jsonl'), AGENTOS_WEB_ORIGINS: 'http://127.0.0.1:15173', AGENTOS_WORKER_AUTORUN: '' });
 evidence.genesis = h.genesis; evidence.program = sdk.PROGRAM_ADDRESS;
 const { payer, session, provider } = h.signers;
 // The current Program requires positive limits for both assets. USDC remains
 // unfunded and neither registered Skill offers a USDC payment option.
 const init = await sdk.buildInitializeAgent(payer.address, 'Real model acceptance', 0.01, 0.001, 0.001, 0.001, ['api']); const agent = init.accounts;
 const permit = await sdk.buildCreateSession(payer.address, agent.agent, agent.policy, session.address, BigInt(Math.floor(Date.now()/1000)+1800), 0.001, 0.002, 0.001, 0.001, ['api']);
 const skills = await Promise.all(['research','weather'].map(async (kind, index) => {
  const port = 19791 + index, endpoint = `http://127.0.0.1:${port}/${kind}`, id = Buffer.alloc(32); id.write('live-' + kind);
  const registered = await sdk.buildRegisterSkill(provider.address, id, digest(endpoint), 0.001, '0');
  return { kind, port, endpoint, ...registered };
 }));
 await save('review', { cluster: 'localnet', genesis: h.genesis, program: sdk.PROGRAM_ADDRESS, payer: payer.address, provider: provider.address, agent: agent.agent, session: permit.session, maximumTransactions: 12, perTransactionFeeLamports: 10000, totalSkillPaymentsLamports: 2000000, modelRequests: 3, maxOutputTokens: 2500, credentials: 'Never saved; temporary chain signers only in memory.' });
 await stage('chain-setup');
 await tx('initialize API Agent', [init.instruction]);
 await tx('fund API Vault', [await sdk.buildDeposit(payer.address, agent.agent, agent.vault, 0.002)]);
 await tx('create bounded API Session', [permit.instruction]);
 await tx('fund temporary Provider rent', [sdk.buildFundSessionFeeReserve(payer.address, provider.address, 0.02)]);
 for (const skill of skills) {
  await tx('register live ' + skill.kind, [skill.instruction], [provider]);
  await h.launch(skill.kind + '-provider', process.execPath, ['--import','tsx',`apps/runtime/src/${skill.kind}-provider.ts`], { [`AGENTOS_${skill.kind.toUpperCase()}_SKILL`]: skill.skill, [`AGENTOS_${skill.kind.toUpperCase()}_PORT`]: String(skill.port) });
 }
 await h.runtime();
 const health = await h.api('/api/health'); assert.equal(health.modelBackend, 'deepseek'); await save('health', health);
 const researchTask = 'Research Solana transactions and processed, confirmed, finalized commitment levels using live-research.';
 const weatherTask = 'weather 39.7456,-97.0892';
 const task = `${researchTask} Also obtain the forecast for 39.7456,-97.0892 using live-weather. Select exactly these two SOL API actions, once each. No hiring, direct payment or extra research actions.`;
 // Both real providers must be reachable before reserving a model request.
 for (const skill of skills) {
  let ready = false;
  for (let n=0;n<80;n++) { try { const response=await fetch(skill.endpoint,{method:'OPTIONS',signal:AbortSignal.timeout(1000)}); await response.body?.cancel(); if(response.status<500){ready=true;break;} } catch {} await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.ok(ready, 'Provider startup failed.');
 }
 await stage('real-planning');
 const plan = await api('/api/run', { task, agent: agent.agent, session: permit.session, skills: skills.map(skill => ({ address: skill.skill, id: 'live-'+skill.kind, active:true, priceLamports:'1000000', priceUsdc:'0' })) });
 await save('plan', plan); assert.equal(plan.planner.model, modelEnv.OPENAI_MODEL); assert.equal(plan.status, 'complete');
 const actions = plan.trace.filter((row:any) => row.skillId && row.kind==='skill');
 assert.equal(actions.length, 2); assert.deepEqual(actions.map((row:any)=>row.skillId).sort(), skills.map(skill=>skill.skill).sort());
 const outputs: { skillId: string; content: string; truncated: boolean }[] = [];
 const { hashAgentOsSkillRequest } = await import('../apps/runtime/src/x402-vault.ts');
 for (const [index, skill] of skills.entries()) {
  await stage('paid-' + skill.kind);
  const prompt = skill.kind === 'research' ? researchTask : weatherTask;
  const inputHash = await hashAgentOsSkillRequest(skill.skill, prompt);
  const body = { protocol:'agentos-skill-v2',agent:agent.agent,paymentPreference:'SOL',skill:{address:skill.skill},request:{skill:skill.skill,prompt,sha256:inputHash} };
  const call = (headers:Record<string,string>={}) => fetch(skill.endpoint, {method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:15173',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(55000)});
  const challenge = await call(); assert.equal(challenge.status,402);
  const required = decodePaymentRequiredHeader(challenge.headers.get('PAYMENT-REQUIRED')!); await challenge.body?.cancel();
  assert.equal(required.accepts.length,1); const accepted=required.accepts[0];
  assert.equal(accepted.scheme,'agentos-vault');assert.equal(accepted.network,`solana:${h.genesis.slice(0,32)}`);assert.equal(accepted.amount,'1000000');assert.equal(accepted.asset,'SOL');assert.equal(accepted.payTo,provider.address);assert.equal(required.resource.url,skill.endpoint);
  assert.equal(accepted.extra.programId,sdk.PROGRAM_ADDRESS);assert.equal(accepted.extra.skill,skill.skill);assert.equal(accepted.extra.inputHash,inputHash);
  const paid = await sdk.buildPaySkill(payer.address,agent.agent,agent.policy,agent.vault,permit.session,session,skill.skill,provider.address,1000000n,Buffer.from(inputHash,'hex'),BigInt(index));
  const providerBefore=await h.sol(provider.address);
  const signature=await tx('pay '+skill.kind,[paid.instruction]);assert.equal(await h.sol(provider.address)-providerBefore,1000000n);
  const paymentHeader=encodePaymentSignatureHeader({x402Version:2,resource:required.resource,accepted,payload:{agent:agent.agent,skill:skill.skill,inputHash,execution:paid.execution,signature}});
  const response=await call({'PAYMENT-SIGNATURE':paymentHeader});const content=await readResponseTextLimited(response,65536,'Provider output too large.');
  await save(skill.kind+'-response',{status:response.status,content});
  assert.equal(response.status,200,'Paid provider failed; preserved response evidence.');
  const settlement=decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE')!);assert.equal(settlement.success,true);assert.equal(settlement.transaction,signature);
  const data=JSON.parse(content);
  if(skill.kind==='research'){assert.equal(data.retrieval,'official-solana-documents-via-github-api');assert.ok(data.sources.length>0);assert.ok(data.report.length>0);}else{assert.equal(data.source,'US National Weather Service');assert.equal(data.periods.length,3);assert.equal(data.coordinates.latitude,39.7456);}
  const resultSignature=await tx('record '+skill.kind+' result',[await sdk.buildRecordSkillResult(payer.address,agent.agent,permit.session,session,paid.execution,digest(content))]);
  const memory=await api('/api/memory',{agent:agent.agent,execution:paid.execution,title:'Live '+skill.kind,content,tags:['real-model',skill.kind]});assert.equal(memory.contentHash,hex(digest(content)));
  const requestsBeforeRecovery=await used();const recovered=await call({'PAYMENT-SIGNATURE':paymentHeader,'AGENTOS-RESULT-ONLY':'true'});assert.equal(recovered.status,200);assert.equal(await recovered.text(),content);assert.equal(await used(),requestsBeforeRecovery);
  // The original response remains in Memory and its evidence file. Summaries
  // receive a bounded excerpt with an explicit truncation flag.
  outputs.push({skillId:skill.skill,content:content.slice(0,12000),truncated:content.length>12000});evidence.steps.push({kind:skill.kind,skill:skill.skill,prompt,paymentSignature:signature,execution:paid.execution,resultSignature,outputHash:hex(digest(content)),memoryVerified:true,resultRecoveryVerified:true});await save('report',evidence);
 }
 await stage('real-final-answer');
 const final = await api('/api/finalize',{task,responses:outputs}); assert.ok(final.answer.trim()); await save('final-answer',final);
 evidence.finalAnswer=final.answer;evidence.status='passed';evidence.stage='completed';assert.equal(await used()-before,3);assert.equal(h.sent,10);assert.equal(await h.sol(agent.vault),0n);
} catch(error) {
 evidence.status='failed';evidence.error=error instanceof assert.AssertionError ? {kind:'assertion',code:error.code,operator:error.operator} : {kind:'stage-error',detailsOmitted:true};
 // Local assertions and submitted public transaction IDs are diagnostic facts,
 // not arbitrary remote error bodies or private signing material.
 evidence.submittedTransactions=h.transactions;
 if(error instanceof assert.AssertionError && ['Transaction status missing','Transaction cap exceeded','Explicit local test approval required'].includes(error.message))evidence.diagnostics=error.message;
 process.exitCode=1;
} finally {
 evidence.authorizedRequestLimit=limit;evidence.modelRequestsAfter=await used();evidence.remainingModelRequests=limit-evidence.modelRequestsAfter;evidence.endedAt=new Date().toISOString();await save('report',evidence);
 if(h.root)await h.finish(evidence.status==='passed'?undefined:'Real acceptance failed at '+evidence.stage);
 console.log(JSON.stringify({status:evidence.status,stage:evidence.stage,evidence:directory,modelRequestsUsed:evidence.modelRequestsAfter-before,remainingModelRequests:evidence.remainingModelRequests}));
}
