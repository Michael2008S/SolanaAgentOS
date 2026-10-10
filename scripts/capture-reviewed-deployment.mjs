import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, rename } from 'node:fs/promises';
import { inspectDeploymentTransaction } from './devnet-deployment-guard.mjs';
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
requireThat(process.argv.length === 2, 'This read-only collector takes no overrides.');
const review = JSON.parse(await readFile(process.env.AGENTOS_DEPLOYMENT_REVIEW || 'docs/evidence/devnet-goal-20261009-deployment-review.json', 'utf8'));
requireThat(review.network === 'devnet' && review.rpc === 'https://api.devnet.solana.com', 'Expected the saved official Devnet review.');
const directory = review.evidenceDirectory || 'docs/evidence/devnet-goal-20261009-deployment-transactions', journalPath = `${directory}/submissions.jsonl`;
requireThat((await stat(journalPath)).size <= 8000000, 'Deployment journal exceeds 8 MB.');
const journal = (await readFile(journalPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const attempts = journal.filter(row => row.transactionSha256), responses = new Map(journal.filter(row => row.submissionResponse).map(row => [row.signature, row.submissionResponse]));
requireThat(attempts.length > 0 && attempts.length <= review.limits.maximumTransactions && new Set(attempts.map(row => row.signature)).size === attempts.length, 'Invalid deployment transaction count.');
const binary = await readFile(review.binary); requireThat(digest(binary) === review.binarySha256, 'Reviewed executable changed.');
let nextAt = 0, rpcId = 0;
async function rpcOnce(method, params = []) {
 const delay = Math.max(0, nextAt - Date.now()); if (delay) await new Promise(resolve => setTimeout(resolve, delay)); nextAt = Date.now() + 310;
 const response = await fetch(review.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20000), body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
 requireThat(response.ok && response.body, `Devnet receipt RPC returned HTTP ${response.status}.`);
 const reader = response.body.getReader(), parts = []; let length = 0;
 try { while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 2000000) { await reader.cancel(); throw new Error('Devnet receipt exceeds 2 MB.'); } parts.push(chunk.value); } }
 finally { reader.releaseLock(); }
 const bytes = Buffer.concat(parts), payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
 requireThat(!payload.error && Object.hasOwn(payload, 'result'), 'Devnet receipt RPC returned an error.'); return { bytes, value: payload.result };
}
// Read-only retries never submit, re-sign or classify a missing receipt as success.
async function rpc(method, params = []) {
 let lastError;
 for (let attempt = 0; attempt < 4; attempt++) {
  try { return await rpcOnce(method, params); } catch (error) { lastError = error; }
  if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
 }
 throw lastError;
}
async function savedReceipt(signature) {
 const path = `${directory}/receipts/${signature}.json`;
 try {
  requireThat((await stat(path)).size <= 2000000, 'Saved receipt exceeds 2 MB.');
  const bytes = await readFile(path), payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  requireThat(!payload.error && payload.result, 'Saved finalized receipt is invalid.');
  return { bytes, value: payload.result, saved: true };
 } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
requireThat((await rpc('getGenesisHash')).value === review.genesisHash, 'Devnet genesis mismatch.');
await mkdir(`${directory}/receipts`, { mode: 0o700, recursive: true });
const report = { format: 'agentos-reviewed-deployment-receipts', version: 1, network: 'devnet', genesisHash: review.genesisHash, checkedAt: new Date().toISOString(), status: 'incomplete', submittedAttempts: attempts.length, finalized: [], notAccepted: [], unknown: [], successfulFeeLamports: '0', failedFeeLamports: '0', limitations: ['Original finalized RPC responses and transaction-byte scope verification. Binary equivalence requires the separate ProgramData verification report.'] };
let successfulFees = 0n, failedFees = 0n;
try {
 for (const attempt of attempts) {
  let receipt = await savedReceipt(attempt.signature);
  for (let tries = 0; !receipt?.value && tries < 4; tries++) { receipt = await rpc('getTransaction', [attempt.signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]); if (receipt.value || responses.get(attempt.signature)?.error) break; if (tries < 3) await new Promise(resolve => setTimeout(resolve, 10000)); }
  if (!receipt.value) { (responses.get(attempt.signature)?.error ? report.notAccepted : report.unknown).push({ signature: attempt.signature, phase: attempt.phase }); continue; }
  const tx = receipt.value; requireThat(Number.isSafeInteger(tx.slot) && tx.slot >= 0 && Array.isArray(tx.transaction) && tx.transaction[1] === 'base64' && tx.meta && Object.hasOwn(tx.meta, 'err'), 'Invalid original finalized transaction.');
  const checked = await inspectDeploymentTransaction(tx.transaction[0], review, binary, attempt.buffer);
  requireThat(checked.signature === attempt.signature && checked.transactionSha256 === attempt.transactionSha256 && tx.meta.fee === attempt.feeLamports && tx.meta.fee <= Number(review.limits.networkFeePerTransactionLamports), 'Finalized transaction differs from inspected submission or fee.');
  if (!receipt.saved) { const file = await open(`${directory}/receipts/${attempt.signature}.json`, 'wx', 0o600); try { await file.writeFile(receipt.bytes); await file.sync(); } finally { await file.close(); } }
  if (tx.meta.err === null) successfulFees += BigInt(tx.meta.fee); else failedFees += BigInt(tx.meta.fee);
  report.finalized.push({ signature: attempt.signature, slot: tx.slot, phase: attempt.phase, successful: tx.meta.err === null, feeLamports: tx.meta.fee, rawSha256: digest(receipt.bytes), transactionSha256: checked.transactionSha256 });
  if (report.finalized.length % 100 === 0 || attempt.phase !== 'write-buffer') console.log(JSON.stringify({ collected: report.finalized.length, attempted: attempts.length, phase: attempt.phase }));
 }
 requireThat(successfulFees + failedFees <= BigInt(review.limits.totalNetworkFeeLamports), 'Finalized deployment fees exceed review.');
 report.status = report.unknown.length ? 'incomplete' : report.finalized.some(row => !row.successful) ? 'finalized-with-failures' : 'complete';
} catch { report.error = 'Collection or finalized transaction verification failed; preserve captured receipts and inspect the public journal.'; process.exitCode = 1; }
finally { report.successfulFeeLamports = successfulFees.toString(); report.failedFeeLamports = failedFees.toString(); report.endedAt = new Date().toISOString(); await mkdir(`${directory}/receipt-reports`, { mode: 0o700, recursive: true }); const body = JSON.stringify(report, null, 2) + '\n';
 // Preserve each prior report before atomically replacing the latest view.
 try { const prior = await readFile(`${directory}/receipts-report.json`); const archive = await open(`${directory}/receipt-reports/prior-${digest(prior)}.json`, 'wx', 0o600); try { await archive.writeFile(prior); await archive.sync(); } finally { await archive.close(); } } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
 const name = report.checkedAt.replace(/[:.]/g, '-'), history = await open(`${directory}/receipt-reports/${name}.json`, 'wx', 0o600); try { await history.writeFile(body); await history.sync(); } finally { await history.close(); }
 const temporary = `${directory}/receipt-reports/latest-${name}.tmp`, latest = await open(temporary, 'wx', 0o600); try { await latest.writeFile(body); await latest.sync(); } finally { await latest.close(); } await rename(temporary, `${directory}/receipts-report.json`); }
console.log(JSON.stringify({ status: report.status, finalized: report.finalized.length, unknown: report.unknown.length, successfulFeeLamports: report.successfulFeeLamports, failedFeeLamports: report.failedFeeLamports }));
if (report.status !== 'complete') process.exitCode = 1;
