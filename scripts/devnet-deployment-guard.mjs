import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { address, getAddressDecoder, getAddressEncoder, getBase58Decoder, getCompiledTransactionMessageDecoder, getProgramDerivedAddress, getTransactionDecoder } from '@solana/kit';
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111', system = '11111111111111111111111111111111', compute = 'ComputeBudget111111111111111111111111111111';
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

/** Inspection never signs. Each write must contain the exact reviewed binary
 * bytes; only the one temporary buffer may be closed back to the payer. */
export async function inspectDeploymentTransaction(encoded, review, binary, previousBuffer = null) {
 requireThat(typeof encoded === 'string' && encoded.length <= 6000 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'Expected a bounded base64 transaction.');
 const raw = Buffer.from(encoded, 'base64'); requireThat(raw.length <= 1232 && raw.toString('base64') === encoded, 'Invalid deployment transaction encoding.');
 const tx = getTransactionDecoder().decode(raw), message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 requireThat(message.version === 'legacy' && message.staticAccounts[0] === review.feePayer && message.header.numSignerAccounts >= 1 && message.header.numSignerAccounts <= 2, 'Deployment payer, version or signer count changed.');
 requireThat(Object.values(tx.signatures).every(signature => signature && signature.some(byte => byte !== 0)), 'Deployment transaction must be signed.');
 const [programData] = await getProgramDerivedAddress({ programAddress: address(loader), seeds: [getAddressEncoder().encode(address(review.program))] });
 let buffer = previousBuffer, phase = '', systemDeposit = 0n, loaderOperations = 0;
 for (const ix of message.instructions) {
  const program = message.staticAccounts[ix.programAddressIndex], accounts = (ix.accountIndices ?? []).map(index => message.staticAccounts[index]), data = Buffer.from(ix.data ?? []);
  if (program === compute) {
   requireThat(data.length >= 1, 'Invalid compute instruction.');
   requireThat(data[0] === 2 && data.length === 5 && data.readUInt32LE(1) <= 1400000 || data[0] === 3 && data.length === 9 && data.readBigUInt64LE(1) === 0n || data[0] === 1 && data.length === 5 || data[0] === 4 && data.length === 5, 'Unreviewed priority fee or compute operation.'); continue;
  }
  requireThat(data.length >= 4, 'Invalid deployment instruction.'); const kind = data.readUInt32LE();
  if (program === system) {
   requireThat(kind === 0 && data.length === 52 && accounts.length === 2 && accounts[0] === review.feePayer && getAddressDecoder().decode(data.subarray(20, 52)) === loader, 'Only reviewed loader account creation is allowed.');
   const bytes = data.readBigUInt64LE(12), amount = data.readBigUInt64LE(4);
   if (accounts[1] === review.program) requireThat(bytes === 36n && amount === BigInt(review.rent.programLamports), 'Program account rent or size changed.');
   else { requireThat(bytes === BigInt(binary.length + 37) && amount === BigInt(review.rent.temporaryBufferLamports), `Temporary buffer rent or size changed (bytes=${bytes}, lamports=${amount}; reviewed bytes=${binary.length + 37}, lamports=${review.rent.temporaryBufferLamports}).`); requireThat(!buffer || buffer === accounts[1], 'Only one temporary buffer is authorized.'); buffer = accounts[1]; }
   systemDeposit += amount; continue;
  }
  requireThat(program === loader && ++loaderOperations === 1, 'Unexpected deployment program or multiple loader operations.');
  if (kind === 0) { requireThat(data.length === 4 && accounts.length === 2 && accounts[0] === buffer && accounts[1] === review.upgradeAuthority, 'Buffer initialization authority changed.'); phase = 'initialize-buffer'; }
  else if (kind === 1) {
   requireThat(accounts.length === 2 && accounts[0] === buffer && accounts[1] === review.upgradeAuthority && data.length >= 16, 'Buffer write authority changed.');
   const offset = data.readUInt32LE(4), count = Number(data.readBigUInt64LE(8)); requireThat(count === data.length - 16 && count > 0 && offset + count <= binary.length && data.subarray(16).equals(binary.subarray(offset, offset + count)), 'Buffer write differs from reviewed binary.'); phase = 'write-buffer';
  } else if (kind === 2) { requireThat(data.length === 12 && data.readBigUInt64LE(4) === BigInt(binary.length) && accounts.length === 8 && accounts[0] === review.feePayer && accounts[1] === programData && accounts[2] === review.program && accounts[3] === buffer && accounts[4] === 'SysvarRent111111111111111111111111111111111' && accounts[5] === 'SysvarC1ock11111111111111111111111111111111' && accounts[6] === system && accounts[7] === review.upgradeAuthority, 'Deployment target, capacity or authority changed.'); phase = 'deploy'; }
  else if (kind === 5) { requireThat(data.length === 4 && accounts.length === 3 && accounts[0] === buffer && accounts[1] === review.feePayer && accounts[2] === review.upgradeAuthority, 'Only temporary buffer recovery to the payer is authorized.'); phase = 'recover-buffer'; }
  else throw new Error('Unreviewed loader operation.');
 }
 requireThat(phase && Object.keys(tx.signatures).every(key => [review.feePayer, review.program, buffer].includes(key)), 'Unreviewed signer or missing deployment operation.');
 return { signature: getBase58Decoder().decode(tx.signatures[address(review.feePayer)]), messageBase64: Buffer.from(tx.messageBytes).toString('base64'), blockhash: message.lifetimeToken, buffer, phase, systemDeposit: systemDeposit.toString(), transactionSha256: createHash('sha256').update(raw).digest('hex') };
}

// Preserve RPC u64 fields such as rentEpoch; Number rounds UINT64_MAX.
export const parseDeploymentRpc = text => JSON.parse(text, (_key, value, context) => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source ? BigInt(context.source) : value);
export const serializeDeploymentRpc = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? JSON.rawJSON(item.toString()) : item);

class DeploymentSimulationError extends Error {
 constructor(value) {
  super('Deployment simulation failed; transaction was not sent.');
  this.rpcError = { code: -32002, message: this.message, data: value };
 }
}

// Queue the complete simulate/quote/send sequence, rather than thousands of
// individual simulations ahead of their fee checks. Dependencies are injected
// only for offline tests; the CLI server below pins the authorized official RPC.
export function deploymentSubmissionHandler({ review, binary, upstream, journal, initialBuffer = null, initialRecords = [], onProgress = () => {} }) {
 let buffer = initialBuffer, count = 0, fees = 0, submissionQueue = Promise.resolve();
 const seen = new Map(), unavailableBlockhashes = new Set();
 for (const row of initialRecords.filter(row => row.transactionSha256)) {
  requireThat(row.buffer === buffer && Number.isSafeInteger(row.feeLamports) && row.feeLamports > 0 && row.feeLamports <= Number(review.limits.networkFeePerTransactionLamports), 'Invalid previous deployment scope or fee.');
  count++; fees += row.feeLamports;
  const response = initialRecords.find(item => item.signature === row.signature && item.submissionResponse)?.submissionResponse;
  seen.set(row.signature, Promise.resolve(response ?? { jsonrpc: '2.0', error: {code:-32002,message:'Previous original submission requires reconciliation; no replay.'} }));
 }
 requireThat(count <= review.limits.maximumTransactions && fees <= Number(review.limits.totalNetworkFeeLamports), 'Previous deployment exceeded review.');
 return async function submission(params) {
  requireThat(Array.isArray(params) && params[1]?.encoding === 'base64', 'Use base64 deployment transactions.');
  const checked = await inspectDeploymentTransaction(params[0], review, binary, buffer);
  if (seen.has(checked.signature)) return await seen.get(checked.signature);
  // Inspection awaits PDA derivation. Recheck the buffer after that await so
  // concurrent account creations cannot select two distinct temporary buffers.
  requireThat(!buffer || buffer === checked.buffer, 'Only one temporary buffer is authorized.'); buffer = checked.buffer;
  const attempt = submissionQueue.then(async () => {
   requireThat(count < review.limits.maximumTransactions, 'Deployment transaction cap reached.');
   if (unavailableBlockhashes.has(checked.blockhash)) throw new DeploymentSimulationError({ err: 'BlockhashNotFound', logs: null, accounts: null, unitsConsumed: 0, returnData: null });
   const simulation = await upstream('simulateTransaction', [params[0], { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
   requireThat(!simulation.error && simulation.result?.value && Object.hasOwn(simulation.result.value, 'err'), 'Deployment simulation RPC failed; transaction was not sent.');
   if (simulation.result.value.err !== null) {
    if (simulation.result.value.err === 'BlockhashNotFound') unavailableBlockhashes.add(checked.blockhash);
    throw new DeploymentSimulationError(simulation.result.value);
   }
   const quote = await upstream('getFeeForMessage', [checked.messageBase64, { commitment: 'confirmed' }]); const fee = quote.result?.value;
   requireThat(!quote.error && Number.isSafeInteger(fee) && fee > 0 && fee <= Number(review.limits.networkFeePerTransactionLamports) && fees + fee <= Number(review.limits.totalNetworkFeeLamports), 'Deployment fee exceeds review.');
   requireThat(BigInt(checked.systemDeposit) <= BigInt(review.limits.totalTemporaryRentAndProgramDepositLamports), 'Account deposit exceeds review.');
   count++; fees += fee;
   const record = { ...checked, feeLamports: fee, reservedAt: new Date().toISOString(), simulationSlot: simulation.result.context.slot }; delete record.messageBase64;
   await journal.writeFile(JSON.stringify(record) + '\n'); await journal.sync();
   const sent = await upstream('sendTransaction', [params[0], { ...params[1], skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }]);
   if (!sent.error) requireThat(sent.result === checked.signature, 'RPC returned a different submission signature.');
   await journal.writeFile(JSON.stringify({ signature: checked.signature, submissionResponse: sent, checkedAt: new Date().toISOString() }) + '\n'); await journal.sync();
   onProgress({ phase: checked.phase, submitted: count, reservedFeesLamports: fees, buffer });
   return sent;
  });
  // A rejected simulation must not poison the following independent submission.
  submissionQueue = attempt.then(() => undefined, () => undefined);
  seen.set(checked.signature, attempt); return await attempt;
 };
}

async function serve() {
 const review = JSON.parse(await readFile(process.env.AGENTOS_DEPLOYMENT_REVIEW || 'docs/evidence/devnet-goal-20261009-deployment-review.json', 'utf8'));
 requireThat(review.authorized === true && review.network === 'devnet' && review.rpc === 'https://api.devnet.solana.com', 'An authorized exact Devnet deployment review is required.');
 const binary = await readFile(review.binary); requireThat(createHash('sha256').update(binary).digest('hex') === review.binarySha256 && binary.length === review.binaryBytes, 'Reviewed build changed.');
 const directory = review.evidenceDirectory || 'docs/evidence/devnet-goal-20261009-deployment-transactions'; await mkdir(directory, { mode: 0o700, recursive: true });
 const resume=process.argv.includes('--resume');
 const initialRecords=resume?(await readFile(`${directory}/submissions.jsonl`,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
 const priorBuffers=[...new Set(initialRecords.filter(row=>row.transactionSha256).map(row=>row.buffer))];
 requireThat(!resume || priorBuffers.length===1,'Resume requires exactly one existing reviewed Buffer.');
 const journal = await open(`${directory}/submissions.jsonl`, resume?'a':'wx', 0o600);
 const methods = new Set(['getAccountInfo', 'getBalance', 'getBlockHeight', 'getClusterNodes', 'getEpochInfo', 'getEpochSchedule', 'getFeeForMessage', 'getGenesisHash', 'getHealth', 'getLatestBlockhash', 'getMinimumBalanceForRentExemption', 'getMultipleAccounts', 'getSignatureStatuses', 'getSlot', 'getVersion', 'isBlockhashValid', 'simulateTransaction', 'sendTransaction']);
 let nextRequestAt = 0, queue = Promise.resolve();
 async function upstream(method, params = []) {
  const attempt=queue.then(async()=>{
   for(let retry=0;retry<4;retry++){
    const delay=Math.max(0,nextRequestAt-Date.now());if(delay)await new Promise(done=>setTimeout(done,delay));nextRequestAt=Date.now()+350;
    let response;try{response=await fetch(review.rpc,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}catch(cause){if(retry===3)throw new Error('Devnet RPC transport unavailable after bounded retries.');nextRequestAt=Date.now()+2000*(retry+1);continue;}
    if(response.status===429 && retry<3){await response.body?.cancel();nextRequestAt=Date.now()+10000*(retry+1);continue;}
    requireThat(response.ok&&response.body,`Devnet RPC returned HTTP ${response.status}.`);
    const reader=response.body.getReader(),parts=[];let size=0;
    try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>5000000){await reader.cancel();throw new Error('Devnet RPC response exceeds 5 MB.');}parts.push(next.value);}}finally{reader.releaseLock();}
    return parseDeploymentRpc(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
   }
  });queue=attempt.then(()=>undefined,()=>undefined);return attempt;
 }
 requireThat((await upstream('getGenesisHash')).result === review.genesisHash, 'Devnet genesis mismatch.');
 const submission = deploymentSubmissionHandler({ review, binary, upstream, journal, initialBuffer:priorBuffers[0]??null, initialRecords, onProgress: progress => { if (progress.phase !== 'write-buffer' || progress.submitted % 100 === 0) console.log(JSON.stringify(progress)); } });
 let lastRejectionAt=0; const server = createServer(async (incoming, outgoing) => {
  let request;
  try {
   requireThat(incoming.method === 'POST' && incoming.url === '/', 'Expected RPC POST.'); const chunks = []; let length = 0;
   for await (const part of incoming) { length += part.length; requireThat(length <= 65536, 'RPC request exceeds 64 KiB.'); chunks.push(part); }
   request = JSON.parse(Buffer.concat(chunks).toString()); requireThat(request && !Array.isArray(request) && request.jsonrpc === '2.0' && methods.has(request.method), 'Unreviewed RPC method.');
   const payload = request.method === 'sendTransaction' ? await submission(request.params) : await upstream(request.method, request.params);
   outgoing.writeHead(200, { 'content-type': 'application/json' }).end(serializeDeploymentRpc({ ...payload, id: request.id }));
  } catch (error) { if(Date.now()-lastRejectionAt>5000){lastRejectionAt=Date.now();console.log(JSON.stringify({phase:'guard-rejected',method:/^[A-Za-z]{1,80}$/.test(request?.method||'')?request.method:'invalid',message:error instanceof Error?error.message:'Rejected'}));} outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: error instanceof DeploymentSimulationError ? error.rpcError : { code: -32002, message: error instanceof Error ? error.message : 'Deployment guard rejected request.' } })); }
 });
 server.listen(18893, '127.0.0.1', () => console.log('Authorized Devnet deployment guard listening on http://127.0.0.1:18893. Every send is inspected and simulated.'));
 for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(async () => { await journal.close(); process.exit(); }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { requireThat((process.argv.length === 3 || process.argv.length === 4 && process.argv[3] === '--resume') && process.argv[2] === '--serve', 'Use --serve after authorizing the saved deployment review.'); await serve(); }
