import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { address, getAddressEncoder, getAddressDecoder, getBase58Encoder, getProgramDerivedAddress } from '@solana/kit';
import { decodeTaskSnapshot, decodeTaskActionSnapshot } from '../apps/runtime/src/task-state.js';
import { readResponseTextLimited } from '../apps/runtime/src/http-limits.js';
// A read-only audit of this authorized browser demonstration. No wallet access.
const prefix = 'docs/evidence/local-goal-20261009';
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const review = await json(`${prefix}-review.json`), report = await json(`${prefix}-receipts/report.json`);
const plan = await json(`${prefix}-task-plan.json`), resultText = await readFile(`${prefix}-task-result.json`, 'utf8'), result = JSON.parse(resultText);
const delivery = (await json(`${prefix}-worker-delivery.json`)).records[0], judgment = await json(`${prefix}-judge-body.json`);
const completion = await json(`${prefix}-task-completion.json`);
const enc = getAddressEncoder(), dec = getAddressDecoder(), base58 = getBase58Encoder();
const program = address(review.program);
const pub = (value: string) => enc.encode(address(value));
const id = (value: string) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const pda = async (seed: string, ...seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program, seeds: [Buffer.from(seed), ...seeds] }))[0];
async function rpc(method: string, params: unknown[] = []) {
 const response = await fetch(report.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
 assert(response.ok); const payload = JSON.parse(await readResponseTextLimited(response, 2_000_000, 'Audit RPC response exceeds 2 MB.')); assert(!payload.error); return payload.result;
}
assert.equal(await rpc('getGenesisHash'), review.genesis);
assert.equal(report.receipts.length, 12); assert.deepEqual(report.missing, []);
const operations = ['create_session', 'system_transfer', 'create_task', 'grant_task_completion', 'create_task_escrow', 'grant_worker_delivery', 'propose_escrow_judge', 'accept_escrow_judge', 'submit_session_escrow_result', 'record_escrow_judgment', 'settle_judged_escrow', 'complete_session_task'];
const payers = [review.worker.owner, review.worker.owner, review.employer.owner, review.employer.owner, review.employer.sessionKey, review.worker.owner, review.employer.owner, review.worker.owner, review.worker.sessionKey, review.judge.sessionKey, review.judge.sessionKey, review.employer.sessionKey];
const receipts: any[] = [], created = new Map<string, number>();
for (const [i, row] of report.receipts.entries()) {
 const raw = await readFile(`${prefix}-receipts/${row.filename}`); assert.equal(sha(raw), row.sha256); assert.equal(raw.length, row.bytes);
 const tx = JSON.parse(raw.toString()).result; assert.equal(tx.slot, row.slot); assert.equal(tx.transaction.signatures[0], row.signature); assert.equal(tx.meta.err, null);
 assert(tx.meta.fee <= Number(review.limits.networkFeePerTransactionLamports)); assert.equal(tx.transaction.message.accountKeys[0], payers[i]);
 const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
 const instruction = tx.transaction.message.instructions.filter((ix: any) => keys[ix.programIdIndex] !== 'ComputeBudget111111111111111111111111111111'); assert.equal(instruction.length, 1);
 const ix = instruction[0], bytes = Buffer.from(base58.encode(ix.data));
 if (operations[i] === 'system_transfer') {
  assert.equal(keys[ix.programIdIndex], '11111111111111111111111111111111'); assert.equal(bytes.readUInt32LE(), 2); assert.equal(bytes.readBigUInt64LE(4).toString(), review.limits.workerFeeReserveFundingLamports);
  assert.deepEqual(ix.accounts.map((n: number) => keys[n]), [review.worker.owner, review.worker.sessionKey]);
 } else { assert.equal(keys[ix.programIdIndex], review.program); assert(bytes.subarray(0, 8).equals(createHash('sha256').update(`global:${operations[i]}`).digest().subarray(0, 8))); }
 keys.forEach((key: string, n: number) => { if (tx.meta.preBalances[n] === 0 && tx.meta.postBalances[n] > 0 && key !== review.worker.sessionKey) created.set(key, tx.meta.postBalances[n]); });
 receipts.push({ operation: operations[i], signature: row.signature, slot: row.slot, feeLamports: tx.meta.fee, feePayer: payers[i], rawSha256: row.sha256 });
}
const workerSession = await pda('session', pub(review.worker.agent), pub(review.worker.sessionKey));
const escrow = result.actions[0].escrow, execution = result.actions[0].execution;
const completionPermit = await pda('task_completion', pub(review.task.address));
const workerPermit = await pda('worker_delivery', pub(escrow));
const mandate = await pda('escrow_judge', pub(escrow)), decision = await pda('escrow_decision', pub(escrow));
const taskAction = await pda('task_action', pub(review.task.address), id(plan.bindings[plan.actions[0].id]));
const taskLink = await pda('task_escrow', pub(escrow));
const names = [review.task.address, review.employer.agent, review.worker.agent, review.judge.agent, review.employer.session, workerSession, review.judge.session, escrow, execution, completionPermit, workerPermit, mandate, decision, taskAction, taskLink, ...created.keys()];
const unique = [...new Set(names)], snapshot = await rpc('getMultipleAccounts', [unique, { encoding: 'base64', commitment: 'finalized' }]);
const accounts = new Map(unique.map((key, i) => [key, snapshot.value[i]]));
function data(key: string, type: string, length: number) { const account: any = accounts.get(key); assert(account && account.owner === program && !account.executable); const bytes = Buffer.from(account.data[0], 'base64'); assert.equal(bytes.length, length); assert(bytes.subarray(0, 8).equals(createHash('sha256').update(`account:${type}`).digest().subarray(0, 8))); return bytes; }
const addr = (bytes: Buffer, at: number) => dec.decode(bytes.subarray(at, at + 32));
const task = await decodeTaskSnapshot(review.task.address, data(review.task.address, 'Task', 227), program);
assert.equal(task.status, 'completed'); assert.equal(task.agent, review.employer.agent); assert.equal(task.session, review.employer.session); assert.equal(task.id, review.task.id); assert.equal(task.taskHash, sha(review.task.description)); assert.equal(task.sol.spent, '10000000'); assert.equal(task.usdc.spent, '0'); assert.equal(task.actionCount, '1'); assert.equal(task.pendingEscrows, '0'); assert.equal(task.pendingSkillResults, '0'); assert.equal(task.resultHash, sha(resultText));
const { planHash, bindings, ...commitment } = plan; assert.equal(sha(JSON.stringify(commitment)), planHash); assert.equal(result.planHash, planHash);
assert.equal(sha(delivery.result), delivery.resultHash); assert.equal(sha(judgment.content), judgment.hash); assert.equal(result.actions[0].outputHash, delivery.resultHash); assert.equal(result.actions[0].judgmentHash, judgment.hash);
assert(completion.records.some((row: any) => row.artifact === resultText && row.resultHash === task.resultHash && row.state === 'confirmed'));
for (const role of [review.employer, review.worker, review.judge]) { const b = data(role.agent, 'Agent', 138); assert.equal(addr(b, 8), role.owner); assert.equal(await pda('agent', pub(role.owner), b.subarray(40, 72)), role.agent); assert.equal(b[104], 0); }
for (const [key, role] of [[review.employer.session, review.employer], [workerSession, review.worker], [review.judge.session, review.judge]] as const) { const b = data(key, 'Session', 147); assert.equal(addr(b, 8), role.agent); assert.equal(addr(b, 40), role.sessionKey); assert.equal(await pda('session', pub(role.agent), pub(role.sessionKey)), key); assert.equal(b[105], 0); }
const e = data(escrow, 'Escrow', 180); assert.equal(addr(e, 8), review.employer.agent); assert.equal(addr(e, 40), review.worker.agent); assert.equal(await pda('escrow', pub(review.employer.agent), e.subarray(72, 80)), escrow); assert.equal(e.readBigUInt64LE(80), 10000000n); assert.equal(e[128], 1); assert.equal(e.subarray(129, 161).toString('hex'), delivery.resultHash); assert.equal(e[161], 1); assert.equal(e.subarray(171, 179).toString(), 'AGTSK001');
const cp = data(completionPermit, 'TaskCompletionPermit', 155); assert.equal(addr(cp, 8), task.address); assert.equal(addr(cp, 40), task.agent); assert.equal(addr(cp, 72), task.session); assert.equal(cp.subarray(104, 136).toString('hex'), planHash); assert.equal(cp.readBigUInt64LE(136), 1n); assert.equal(cp[152], 0); assert.equal(cp[153], 1);
const wp = data(workerPermit, 'WorkerDeliveryPermit', 115); assert.equal(addr(wp, 8), escrow); assert.equal(addr(wp, 40), review.worker.agent); assert.equal(addr(wp, 72), workerSession); assert.equal(wp[112], 0); assert.equal(wp[113], 1);
const m = data(mandate, 'JudgeMandate', 220); assert.equal(addr(m, 8), escrow); assert.equal(addr(m, 40), task.agent); assert.equal(addr(m, 72), review.worker.agent); assert.equal(addr(m, 104), review.judge.agent); assert.equal(addr(m, 136), review.judge.session); assert.equal(m[216], 1); assert.equal(m[217], 0); assert.equal(m[218], 1);
const d = data(decision, 'JudgeDecision', 243); assert.equal(addr(d, 8), escrow); assert.equal(addr(d, 40), mandate); assert.equal(addr(d, 72), review.judge.agent); assert.equal(addr(d, 104), review.judge.session); assert.equal(d.subarray(136, 168).toString('hex'), task.taskHash); assert.equal(d.subarray(168, 200).toString('hex'), delivery.resultHash); assert.equal(d.subarray(200, 232).toString('hex'), judgment.hash); assert.equal(d[232], 0); assert.equal(d[241], 1);
const action = await decodeTaskActionSnapshot(taskAction, data(taskAction, 'TaskAction', 90), program); assert.equal(action.task, task.address); assert.equal(action.execution, execution); assert.equal(action.amount, '10000000'); assert.equal(action.asset, 'SOL');
const link = data(taskLink, 'TaskEscrow', 106); assert.equal(addr(link, 8), task.address); assert.equal(addr(link, 40), escrow); assert.equal(addr(link, 72), execution); assert.equal(link[104], 1);
const ex = data(execution, 'Execution', 132); assert.equal(addr(ex, 8), task.agent); assert.equal(await pda('execution', pub(task.agent), ex.subarray(40, 48)), execution); assert.equal(ex[48], 0); assert.equal(ex[49], 2); assert.equal(ex.readBigUInt64LE(50), 10000000n); assert.equal(ex.subarray(66, 98).toString('hex'), task.taskHash); assert.equal(ex[98], 1); assert.equal(ex.subarray(99, 131).toString('hex'), delivery.resultHash);
let rent = 0; const rentAccounts = [];
for (const [key, firstBalance] of created) { const a: any = accounts.get(key); if (a?.owner !== program) continue; const length = Buffer.from(a.data[0], 'base64').length; const minimum = await rpc('getMinimumBalanceForRentExemption', [length]); assert.equal(firstBalance, minimum + (key === escrow ? 10000000 : 0)); rent += minimum; rentAccounts.push({ address: key, bytes: length, rentLamports: minimum }); }
assert(rent <= Number(review.limits.totalNewAccountRentLamports));
const outcome = { format: 'agentos-browser-loop-audit', version: 1, auditedAt: new Date().toISOString(), status: 'passed', genesis: review.genesis, program, task, escrow: { address: escrow, status: 'released', worker: review.worker.agent, amountLamports: '10000000' }, finalResultSha256: sha(resultText), workerResultSha256: delivery.resultHash, judgmentSha256: judgment.hash, receipts, totalFeeLamports: receipts.reduce((sum, row) => sum + row.feeLamports, 0), newAccountRentLamports: rent, rentAccounts, accountSnapshotSlot: snapshot.context.slot, limitations: ['Deterministic local model fixture: this verifies browser automation, commitments and settlement, not factual/model quality.', 'Original receipts were captured before validator pruning. The fresh account snapshot verifies final state; no transactions were replayed.', 'Simulation success was observed in the browser before signing; finalized receipts do not independently preserve preflight responses.'] };
await writeFile(`${prefix}-accounts.json`, JSON.stringify({ genesis: review.genesis, addresses: unique, ...snapshot }, null, 2) + '\n');
await writeFile(`${prefix}-verification.json`, JSON.stringify(outcome, null, 2) + '\n');
console.log(JSON.stringify({ status: outcome.status, task: task.status, transactions: receipts.length, feeLamports: outcome.totalFeeLamports, rentLamports: rent }));
