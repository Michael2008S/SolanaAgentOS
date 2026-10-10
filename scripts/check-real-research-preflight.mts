import { access, open, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { localModelEnvironment } from './local-launch-options.mjs';
import { researchSolana } from '../apps/runtime/src/solana-research.js';
import { DeepseekResponseError } from '../apps/runtime/src/deepseek-transport.js';

// One previously authorized public research model call; no RPC, registration,
// payment, wallet, Session signing or paid Skill invocation occurs here.
const output = 'docs/evidence/deepseek-goal-20261009-preflight.json';
const quotaPath = 'docs/evidence/deepseek-goal-20261009-quota.json';
if (process.argv.length !== 2) throw new Error('This bounded preflight takes no overrides.');
try { await access(output); throw new Error('Preflight evidence already exists; do not repeat the model request.'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const fileValues = parseEnv(await readFile('apps/runtime/.env', 'utf8'));
const modelEnvironment = localModelEnvironment({ realModel: true, fixtureMode: false }, process.env, fileValues);
if (modelEnvironment.AGENTOS_MODEL_PROVIDER !== 'deepseek') throw new Error('Only the explicitly authorized DeepSeek provider is allowed.');
Object.assign(process.env, modelEnvironment, { AGENTOS_MODEL_REQUEST_LIMIT: '5', AGENTOS_MODEL_BUDGET_PATH: quotaPath });
async function usedRequests() {
 try { return JSON.parse(await readFile(quotaPath, 'utf8')).requests.length as number; }
 catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot verify the shared model quota.'); return 0; }
}
const before = await usedRequests();
if (before > 0) throw new Error('Preflight is only allowed before the paid workflows; preserve remaining quota.');
const review = JSON.parse(await readFile('docs/evidence/real-api-goal-20261009-review.json', 'utf8'));
const file = await open(output, 'wx', 0o600);
const evidence: Record<string, unknown> = { format: 'agentos-real-model-preflight', version: 1, startedAt: new Date().toISOString(), provider: 'deepseek', model: modelEnvironment.OPENAI_MODEL, status: 'incomplete', task: review.researchTask, authorizedRequestLimit: 5, maxOutputTokens: 2500, paidWorkflowCompleted: false, limitations: ['One live model and public document retrieval check before payment.', 'No Skill registration, payment, result commitment, final-answer workflow or Devnet verification occurred.'] };
try {
 const result = await researchSolana(review.researchTask);
 evidence.status = 'passed'; evidence.result = result;
} catch (error) {
 evidence.status = 'failed';
 // Remote errors can contain echoed inputs. Never persist raw errors or keys.
 evidence.error = 'Live model or official-source validation failed. Raw error omitted.';
 if (error instanceof DeepseekResponseError) evidence.safeDiagnostics = error.diagnostics;
 else if (error instanceof Error && /^(Research model|Official Solana source) returned HTTP [1-5][0-9]{2}\.$/.test(error.message)) evidence.safeDiagnostics = { kind: 'http-status', status: Number(error.message.match(/[0-9]{3}/)![0]) };
 else if (error instanceof Error && error.message === 'Research output lacks valid citations to retrieved sources.') evidence.safeDiagnostics = { kind: 'source-citation-validation' };
 else evidence.safeDiagnostics = { kind: 'transport-or-response-validation', detailsOmitted: true };
 process.exitCode = 1;
} finally {
 evidence.usedModelRequests = await usedRequests(); evidence.requestsUsedByPreflight = Number(evidence.usedModelRequests) - before;
 evidence.remainingModelRequests = 5 - Number(evidence.usedModelRequests); evidence.endedAt = new Date().toISOString();
 try { await file.writeFile(JSON.stringify(evidence, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
}
console.log(JSON.stringify({ status: evidence.status, model: evidence.model, requestsUsedByPreflight: evidence.requestsUsedByPreflight, remainingModelRequests: evidence.remainingModelRequests, evidence: output, paidWorkflowCompleted: false }));
