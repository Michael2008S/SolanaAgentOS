import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputFiles } from './build-inputs.mjs';
import { verifyJudgeEvidence } from './judge-evidence.mjs';
import { address, getAddressEncoder, getAddressDecoder, getBase58Encoder, getProgramDerivedAddress } from '@solana/kit';

// This collector never signs or sends a transaction. A successful report requires
// finalized chain records, not browser receipts or planner status alone.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} requires a value.`);
  return argv[index + 1];
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const discriminator = (kind, name) => Buffer.from(digest(`${kind}:${name}`), 'hex').subarray(0, 8);
const addressBytes = getAddressEncoder();
const addressText = getAddressDecoder();
const instructionBytes = getBase58Encoder();
const pubkey = (value) => { addressBytes.encode(address(value)); return value; };
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const explorer = (kind, value) => `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
const timestamp = new Date().toISOString();
const outputDir = path.resolve(root, option('--output') ?? `docs/evidence/${timestamp.replace(/[:.]/g, '-')}`);
const report = { format: 'agentos-devnet-evidence', version: 1, checkedAt: timestamp, commitment: 'finalized', status: 'incomplete', deployment: null, workflows: {}, errors: [] };
const collected = { network: null, transactions: {}, accounts: {} };
let rpcId = 0;

function requireThat(condition, message) { if (!condition) throw new Error(message); }
async function textFile(filename, cap) {
  const handle = await open(filename, 'r');
  try {
    const bytes = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    requireThat(length <= cap, 'Evidence input exceeds its byte limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}
async function rpc(endpoint, method, params = []) {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  requireThat(response.ok, `Devnet RPC ${method} returned HTTP ${response.status}.`);
  const reader = response.body?.getReader();
  requireThat(reader, 'Devnet RPC returned no response body.');
  const parts = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 5_000_000) { await reader.cancel(); throw new Error('Devnet RPC response exceeds 5 MB.'); }
      parts.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  requireThat(!payload.error && Object.hasOwn(payload, 'result'), `Devnet RPC ${method} failed.`);
  return payload.result;
}
async function account(endpoint, key, owner, kind) {
  pubkey(key);
  const result = await rpc(endpoint, 'getAccountInfo', [key, { encoding: 'base64', commitment: 'finalized' }]);
  collected.accounts[key] = result;
  const value = result?.value;
  requireThat(value && value.owner === owner && Array.isArray(value.data) && value.data[1] === 'base64', `${kind ?? 'Program'} account is absent or has the wrong owner.`);
  const bytes = Buffer.from(value.data[0], 'base64');
  if (kind) requireThat(bytes.length >= 8 && bytes.subarray(0, 8).equals(discriminator('account', kind)), `${kind} discriminator is invalid.`);
  return { bytes, value, slot: result.context.slot };
}
async function pda(programId, seeds) {
  return (await getProgramDerivedAddress({ programAddress: address(programId), seeds }))[0];
}
function u64(value) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; }
async function execution(endpoint, programId, key, expectedAction) {
  const { bytes } = await account(endpoint, key, programId, 'Execution');
  requireThat(bytes.length >= 100 && bytes[48] <= 1 && (Array.isArray(expectedAction) ? expectedAction.includes(bytes[49]) : bytes[49] === expectedAction) && bytes[98] === 1, 'Execution action, asset or output commitment is invalid.');
  requireThat(bytes.length >= 132 && bytes[131] === 0, 'Execution is not completed with a committed result.');
  const agent = addressText.decode(bytes.subarray(8, 40));
  const id = bytes.readBigUInt64LE(40);
  requireThat(await pda(programId, [Buffer.from('execution'), addressBytes.encode(address(agent)), u64(id)]) === key, 'Execution PDA is not canonical.');
  return { address: key, agent, id: id.toString(), asset: bytes[48] === 1 ? 'USDC' : 'SOL', amount: bytes.readBigUInt64LE(50).toString(), inputHash: bytes.subarray(66, 98).toString('hex'), outputHash: bytes.subarray(99, 131).toString('hex'), taskScoped: bytes[49] === 3 };
}
async function transaction(endpoint, signature, programId, methods, accountPositions, expectedData, signerPositions = []) {
  requireThat(typeof signature === 'string' && instructionBytes.encode(signature).length === 64, 'Transaction signature is invalid.');
  const tx = await rpc(endpoint, 'getTransaction', [signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
  requireThat(tx && tx.meta?.err === null && tx.transaction?.signatures?.[0] === signature, 'Transaction is missing, unsuccessful, or not finalized.');
  const message = tx.transaction.message;
  const keys = [...message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const matched = message.instructions.some((ix) => {
    if (keys[ix.programIdIndex] !== programId || typeof ix.data !== 'string' || !Array.isArray(ix.accounts)) return false;
    const bytes = Buffer.from(instructionBytes.encode(ix.data));
    if (!methods.some((method) => bytes.subarray(0, 8).equals(discriminator('global', method)))) return false;
    if (!Object.entries(accountPositions).every(([index, key]) => keys[ix.accounts[Number(index)]] === key)) return false;
    if (!signerPositions.every(index => Number.isInteger(ix.accounts[index]) && ix.accounts[index] >= 0 && ix.accounts[index] < message.header.numRequiredSignatures)) return false;
    return expectedData(bytes);
  });
  requireThat(matched, `Transaction does not contain the expected ${methods.join('/')} instruction, accounts and arguments.`);
  collected.transactions[signature] = tx;
  return { signature, slot: tx.slot, blockTime: tx.blockTime, feePayer: keys[0], feeLamports: String(tx.meta.fee), explorer: explorer('tx', signature) };
}
async function verifySkill(endpoint, programId, input) {
  requireThat(input && typeof input.prompt === 'string' && input.prompt.trim() && input.prompt.length <= 1000 && typeof input.response === 'string', 'Skill evidence needs the exact prompt and response text.');
  requireThat(Buffer.byteLength(input.response) <= 65_536, 'Skill response exceeds 64 KiB.');
  const result = await execution(endpoint, programId, pubkey(input.execution), [1, 3]);
  requireThat(result.inputHash === digest(JSON.stringify({ skill: pubkey(input.skill), prompt: input.prompt.trim() })), 'Skill request text does not match the Execution input hash.');
  requireThat(result.outputHash === digest(input.response), 'Exact Skill response bytes do not match the Execution output hash.');
  const registry = (await account(endpoint, input.skill, programId, 'Skill')).bytes;
  requireThat(registry.length >= 104, 'Skill registry record is truncated.');
  const provider = addressText.decode(registry.subarray(8, 40));
  requireThat(await pda(programId, [Buffer.from('skill'), addressBytes.encode(address(provider)), registry.subarray(40, 72)]) === input.skill, 'Skill PDA is not canonical.');
  const positions = { 2: result.agent, [result.asset === 'SOL' ? 6 : 7]: input.skill, [result.asset === 'SOL' ? 7 : 8]: provider, [result.asset === 'SOL' ? 8 : 10]: input.execution };
  const resultPositions = { 2: result.agent, 4: input.execution };
  let taskProof;
  if (result.taskScoped) {
    const taskKey = pubkey(input.task);
    requireThat(typeof input.actionId === 'string' && /^(0|[1-9][0-9]*)$/.test(input.actionId) && BigInt(input.actionId) <= 18446744073709551615n, 'Task Skill evidence needs the stable u64 actionId.');
    const actionId = BigInt(input.actionId);
    const taskBytes = (await account(endpoint, taskKey, programId, 'Task')).bytes;
    requireThat(taskBytes.length === 227 && addressText.decode(taskBytes.subarray(8, 40)) === result.agent, 'Task belongs to another Agent or has an invalid layout.');
    requireThat(await pda(programId, [Buffer.from('task'), addressBytes.encode(address(result.agent)), taskBytes.subarray(72, 80)]) === taskKey, 'Task PDA is not canonical.');
    const receiptKey = await pda(programId, [Buffer.from('task_action'), addressBytes.encode(address(taskKey)), u64(actionId)]);
    const receipt = (await account(endpoint, receiptKey, programId, 'TaskAction')).bytes;
    requireThat(receipt.length === 90 && addressText.decode(receipt.subarray(8, 40)) === taskKey && addressText.decode(receipt.subarray(40, 72)) === input.execution && receipt.readBigUInt64LE(72).toString() === result.amount && receipt[80] === (result.asset === 'SOL' ? 0 : 1) && receipt.readBigUInt64LE(81) === actionId, 'TaskAction does not bind this exact payment.');
    positions[result.asset === 'SOL' ? 10 : 14] = taskKey;
    positions[result.asset === 'SOL' ? 11 : 15] = receiptKey;
    resultPositions[5] = taskKey; resultPositions[6] = receiptKey;
    taskProof = { task: taskKey, taskAction: receiptKey, actionId: input.actionId };
  }
  const paid = await transaction(endpoint, input.paymentSignature, programId, [result.taskScoped ? result.asset === 'SOL' ? 'pay_task_skill' : 'pay_task_usdc_skill' : result.asset === 'SOL' ? 'pay_skill' : 'pay_usdc_skill'], positions, (bytes) => bytes.length === (result.taskScoped ? 64 : 56) && bytes.readBigUInt64LE(8).toString() === result.amount && bytes.subarray(16, 48).toString('hex') === result.inputHash && bytes.readBigUInt64LE(48).toString() === result.id && (!result.taskScoped || bytes.readBigUInt64LE(56).toString() === input.actionId));
  const recorded = await transaction(endpoint, input.resultSignature, programId, [result.taskScoped ? 'record_task_skill_result' : 'record_skill_result'], resultPositions, (bytes) => bytes.length === 40 && bytes.subarray(8).toString('hex') === result.outputHash);
  requireThat(paid.slot <= recorded.slot, 'Result recording precedes payment.');
  return { status: 'verified-chain-commitments', execution: result, payment: paid, resultRecording: recorded, ...(taskProof ? { taskProof } : {}), responseBytes: Buffer.byteLength(input.response), limitations: ['Caller supplied response text matches the signed commitment. This alone does not prove an HTTP request was made, factual correctness, Memory saving, or final answer generation.'] };
}
async function verifyEscrow(endpoint, programId, input) {
  requireThat(input && typeof input.task === 'string' && input.task.trim() && input.task.length <= 400 && typeof input.result === 'string' && input.result.trim() && input.result.length <= 400, 'Escrow evidence needs exact task and result text (1–400 characters each).');
  const key = pubkey(input.escrow);
  const { bytes } = await account(endpoint, key, programId, 'Escrow');
  requireThat(bytes.length >= 180 && bytes[128] === 1 && bytes[161] === 1 && bytes[179] <= 1, 'Escrow is not released with a result commitment.');
  const employer = addressText.decode(bytes.subarray(8, 40));
  const worker = addressText.decode(bytes.subarray(40, 72));
  const taskId = bytes.readBigUInt64LE(72);
  requireThat(await pda(programId, [Buffer.from('escrow'), addressBytes.encode(address(employer)), u64(taskId)]) === key, 'Escrow PDA is not canonical.');
  const taskHash = bytes.subarray(96, 128).toString('hex');
  const resultHash = bytes.subarray(129, 161).toString('hex');
  requireThat(taskHash === digest(input.task.trim()) && resultHash === digest(input.result.trim()), 'Task or result text differs from the released Escrow commitment.');
  const taskScoped = bytes.subarray(171, 179).equals(Buffer.from('AGTSK001'));
  requireThat(taskScoped || bytes.subarray(171, 179).equals(Buffer.from('AGEXE001')), 'Escrow lacks the linked funding Execution.');
  const executionId = bytes.readBigUInt64LE(163);
  const executionKey = await pda(programId, [Buffer.from('execution'), addressBytes.encode(address(employer)), u64(executionId)]);
  const record = await execution(endpoint, programId, executionKey, 2);
  const amount = bytes.readBigUInt64LE(80).toString();
  const asset = bytes[179] === 1 ? 'USDC' : 'SOL';
  requireThat(record.inputHash === taskHash && record.outputHash === resultHash && record.amount === amount && record.asset === asset, 'Linked Execution does not match the released Escrow.');
  const fundingPositions = { 2: employer, [asset === 'SOL' ? 6 : 7]: worker, [asset === 'SOL' ? 7 : 8]: key, [asset === 'SOL' ? 8 : 10]: executionKey };
  const releasePositions = { 2: employer, 4: key, 5: worker };
  let parentTaskProof;
  if (taskScoped) {
    const parentTask = pubkey(input.parentTask);
    requireThat(typeof input.actionId === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(input.actionId) && BigInt(input.actionId) <= 18446744073709551615n, 'Task Escrow evidence needs the stable u64 actionId.');
    const task = (await account(endpoint, parentTask, programId, 'Task')).bytes;
    requireThat(task.length === 227 && addressText.decode(task.subarray(8, 40)) === employer && await pda(programId, [Buffer.from('task'), addressBytes.encode(address(employer)), task.subarray(72, 80)]) === parentTask, 'Parent Task does not belong to this employer.');
    const taskLink = await pda(programId, [Buffer.from('task_escrow'), addressBytes.encode(address(key))]);
    const link = (await account(endpoint, taskLink, programId, 'TaskEscrow')).bytes;
    requireThat(link.length === 106 && addressText.decode(link.subarray(8, 40)) === parentTask && addressText.decode(link.subarray(40, 72)) === key && addressText.decode(link.subarray(72, 104)) === executionKey && link[104] === 1, 'Task Escrow link is not closed and bound to this funding.');
    const taskAction = await pda(programId, [Buffer.from('task_action'), addressBytes.encode(address(parentTask)), u64(BigInt(input.actionId))]);
    const receipt = (await account(endpoint, taskAction, programId, 'TaskAction')).bytes;
    requireThat(receipt.length === 90 && addressText.decode(receipt.subarray(8, 40)) === parentTask && addressText.decode(receipt.subarray(40, 72)) === executionKey && receipt.readBigUInt64LE(72).toString() === amount && receipt[80] === (asset === 'SOL' ? 0 : 1) && receipt.readBigUInt64LE(81).toString() === input.actionId, 'TaskAction does not match the Escrow funding.');
    const base = asset === 'SOL' ? 10 : 14;
    fundingPositions[base] = parentTask; fundingPositions[base + 1] = taskAction; fundingPositions[base + 2] = taskLink;
    const releaseBase = asset === 'SOL' ? 9 : 14;
    releasePositions[releaseBase] = taskLink; releasePositions[releaseBase + 1] = parentTask;
    parentTaskProof = { parentTask, taskAction, taskLink, actionId: input.actionId, closed: true };
  }
  const funding = await transaction(endpoint, input.fundingSignature, programId, [taskScoped ? asset === 'SOL' ? 'create_task_escrow' : 'create_task_usdc_escrow' : asset === 'SOL' ? 'create_escrow' : 'create_usdc_escrow'], fundingPositions, (data) => data.length === (taskScoped ? 80 : 72) && data.readBigUInt64LE(8).toString() === amount && data.readBigUInt64LE(16) === taskId && data.readBigInt64LE(24) === bytes.readBigInt64LE(88) && data.subarray(32, 64).toString('hex') === taskHash && data.readBigUInt64LE(64) === executionId && (!taskScoped || data.readBigUInt64LE(72).toString() === input.actionId));
  let submission; let deliveryProof;
  if (input.deliverySession) {
    const sessionKey = pubkey(input.deliverySession);
    const permitKey = await pda(programId, [Buffer.from('worker_delivery'), addressBytes.encode(address(key))]);
    const permit = (await account(endpoint, permitKey, programId, 'WorkerDeliveryPermit')).bytes;
    const session = (await account(endpoint, sessionKey, programId, 'Session')).bytes;
    requireThat(permit.length === 115 && addressText.decode(permit.subarray(8, 40)) === key && addressText.decode(permit.subarray(40, 72)) === worker && addressText.decode(permit.subarray(72, 104)) === sessionKey && permit[113] === 1, 'Delivery Permit is not used and bound to this Worker, Escrow and Session.');
    requireThat(session.length === 147 && addressText.decode(session.subarray(8, 40)) === worker, 'Delivery Session belongs to another Worker.');
    const signer = addressText.decode(session.subarray(40, 72));
    requireThat(await pda(programId, [Buffer.from('session'), addressBytes.encode(address(worker)), addressBytes.encode(address(signer))]) === sessionKey, 'Delivery Session PDA is not canonical.');
    const workerAccount = (await account(endpoint, worker, programId, 'Agent')).bytes;
    requireThat(workerAccount.length >= 40, 'Worker Agent is truncated.');
    const owner = addressText.decode(workerAccount.subarray(8, 40));
    const granted = await transaction(endpoint, input.deliveryGrantSignature, programId, ['grant_worker_delivery'], { 0: owner, 1: worker, 3: sessionKey, 4: key, 5: permitKey }, (data) => data.length === 16 && data.readBigInt64LE(8) === permit.readBigInt64LE(104));
    submission = await transaction(endpoint, input.submissionSignature, programId, ['submit_session_escrow_result'], { 0: signer, 2: worker, 4: sessionKey, 5: key, 6: permitKey }, (data) => data.length >= 44 && data.readUInt32LE(40) <= 3 && data.length === 44 + data.readUInt32LE(40) * 64 && data.subarray(8, 40).toString('hex') === resultHash);
    requireThat(granted.slot <= submission.slot && Number.isSafeInteger(submission.blockTime) && BigInt(submission.blockTime) < permit.readBigInt64LE(104) && BigInt(submission.blockTime) < session.readBigInt64LE(72), 'Delivery grant or Session expired before submission.');
    deliveryProof = { permit: permitKey, session: sessionKey, signer, grant: granted, used: true, limitation: 'Current Session or Permit revocation after delivery does not undo the historical successful submission.' };
  } else {
    submission = await transaction(endpoint, input.submissionSignature, programId, ['submit_escrow_result', 'submit_escrow_result_with_sources'], { 1: worker, 2: key }, (data) => data.length >= 40 && data.subarray(8, 40).toString('hex') === resultHash);
  }
  const release = await transaction(endpoint, input.releaseSignature, programId, [asset === 'SOL' ? 'release_escrow' : 'release_usdc_escrow'], releasePositions, (data) => data.length === 8);
  requireThat(funding.slot <= submission.slot && submission.slot <= release.slot, 'Escrow transactions are out of order.');
  const reputationKey = await pda(programId, [Buffer.from('reputation'), addressBytes.encode(address(worker))]);
  const reputation = (await account(endpoint, reputationKey, programId, 'Reputation')).bytes;
  requireThat(reputation.length === 113 && addressText.decode(reputation.subarray(8, 40)) === worker && reputation.readBigUInt64LE(72) <= 10000n, 'Worker Reputation snapshot layout, binding or score is invalid.');
  const partyOwners = {};
  for (const party of [employer, worker]) {
    const agent = (await account(endpoint, party, programId, 'Agent')).bytes;
    requireThat(agent.length === 138 && await pda(programId, [Buffer.from('agent'), agent.subarray(8, 40), agent.subarray(40, 72)]) === party, 'Escrow party Agent layout or PDA is invalid.');
    partyOwners[party] = addressText.decode(agent.subarray(8, 40));
  }
  const reputationAttribution = { employerOwner: partyOwners[employer], workerOwner: partyOwners[worker], sameOwner: partyOwners[employer] === partyOwners[worker], latestSourceRule: 'same-owner-settlements-excluded', historicalIncrementVerified: false, limitation: 'Owner relationship is current account data. This report does not prove which historical binary executed settlement or measure a reputation delta.' };
  return { status: 'verified-chain-settlement', escrow: key, employer, worker, amount, asset, taskHash, resultHash, execution: record, funding, submission, release, ...(deliveryProof ? { deliveryProof } : {}), ...(parentTaskProof ? { parentTaskProof } : {}), reputationAttribution, workerReputation: { address: reputationKey, completedTasks: reputation.readBigUInt64LE(40).toString(), successfulTasks: reputation.readBigUInt64LE(48).toString(), score: reputation.readBigUInt64LE(72).toString() }, limitations: ['Reputation is the current snapshot, not a before/after delta. Human review, AI Judge output, and off-chain task transport are not proved by these transactions.'] };
}

try {
  const source = await readFile(path.join(root, 'programs/agent_os/src/lib.rs'), 'utf8');
  const programId = pubkey(source.match(/declare_id!\("([^"]+)"\)/)?.[1]);
  report.programId = programId;
  report.sourceSha256 = digest(source);
  report.gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  report.workingTreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
  const endpoint = new URL(process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com');
  requireThat(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.hash, 'Use an HTTPS Devnet RPC URL without embedded credentials or fragments.');
  const actualGenesis = await rpc(endpoint, 'getGenesisHash');
  collected.network = { expectedGenesisHash: genesis, actualGenesisHash: actualGenesis };
  requireThat(actualGenesis === genesis, 'RPC is not Solana Devnet.');
  report.network = 'devnet';
  const binary = await readFile(path.resolve(root, option('--binary') ?? 'target/sbf-safe/agent_os.so'));
  const provenance = JSON.parse(await textFile(path.resolve(root, option('--build-manifest') ?? 'target/sbf-safe/build-manifest.json'), 64_000));
  requireThat(provenance.format === 'agentos-sbf-build' && provenance.version === 1 && provenance.status === 'built' && provenance.programId === programId && provenance.binarySha256 === digest(binary), 'Build provenance is missing or does not match this binary and Program. Run npm run build:devnet.');
  const expectedFiles = await buildInputFiles(root);
  requireThat(JSON.stringify(Object.keys(provenance.inputHashes ?? {}).sort()) === JSON.stringify(expectedFiles), 'Build provenance does not cover the current complete source tree.');
  for (const filename of expectedFiles) requireThat(provenance.inputHashes?.[filename] === digest(await readFile(path.join(root, filename))), 'Build provenance is stale; on-chain bytes cannot be attributed to the current sources.');
  report.localBuild = provenance;
  const payer = option('--payer');
  if (payer) {
    const [balance, programRent, programDataRent, bufferRent] = await Promise.all([
      rpc(endpoint, 'getBalance', [pubkey(payer), { commitment: 'finalized' }]),
      rpc(endpoint, 'getMinimumBalanceForRentExemption', [36, { commitment: 'finalized' }]),
      rpc(endpoint, 'getMinimumBalanceForRentExemption', [binary.length + 45, { commitment: 'finalized' }]),
      rpc(endpoint, 'getMinimumBalanceForRentExemption', [binary.length + 37, { commitment: 'finalized' }]),
    ]);
    report.preparation = { payer, balanceLamports: String(balance.value), balanceReadSlot: balance.context.slot, programRentLamports: String(programRent), programDataRentLamports: String(programDataRent), bufferRentLamports: String(bufferRent), accountRentSumLamports: (BigInt(programRent) + BigInt(programDataRent) + BigInt(bufferRent)).toString(), limitation: 'Conservative rent sum for a same-size deployment buffer and ProgramData; transaction fees, optional larger capacity and buffer recovery are excluded. This is not a deployment quote.' };
  }
  const program = await account(endpoint, programId, loader);
  requireThat(program.value.executable && program.bytes.length === 36 && program.bytes.readUInt32LE(0) === 2, 'Program is not an executable upgradeable deployment.');
  const dataKey = addressText.decode(program.bytes.subarray(4, 36));
  const deployed = await account(endpoint, dataKey, loader);
  requireThat(deployed.bytes.length > 45 && deployed.bytes.readUInt32LE(0) === 3 && deployed.bytes[12] <= 1, 'ProgramData metadata is invalid.');
  requireThat(deployed.bytes.length >= binary.length + 45 && deployed.bytes.subarray(45, 45 + binary.length).equals(binary) && deployed.bytes.subarray(45 + binary.length).every((byte) => byte === 0), 'Deployed program bytes differ from the selected local build.');
  report.deployment = { status: 'binary-match', programId, programData: dataKey, deploymentSlot: deployed.bytes.readBigUInt64LE(4).toString(), readSlot: deployed.slot, upgradeAuthority: deployed.bytes[12] ? addressText.decode(deployed.bytes.subarray(13, 45)) : null, binaryBytes: binary.length, binarySha256: digest(binary), build: provenance, explorer: explorer('address', programId) };
  if (argv.includes('--deployment-only')) report.status = 'deployment-verified-workflows-pending';
  else {
    const inputPath = option('--input');
    requireThat(inputPath, 'Provide --input with workflow receipts, or use --deployment-only.');
    const input = JSON.parse(await textFile(path.resolve(root, inputPath), 200_000));
    requireThat(input.format === 'agentos-demo-input' && input.version === 1 && input.programId === programId, 'Input format or Program ID does not match.');
    const selected = (option('--workflows') ?? 'skill,escrow').split(',');
    requireThat(selected.length > 0 && new Set(selected).size === selected.length && selected.every(name => ['skill', 'escrow', 'judge'].includes(name)), '--workflows must list unique skill, escrow or judge names.');
    report.requestedWorkflows = selected;
    const verifiers = { skill: verifySkill, escrow: verifyEscrow, judge: (url, program, value) => verifyJudgeEvidence(url, program, value, { requireThat, account, pda, pubkey, addressBytes, addressText, digest, transaction }) };
    for (const name of selected) {
      const verify = verifiers[name];
      try { report.workflows[name] = await verify(endpoint, programId, input[name]); }
      catch (error) { report.errors.push(`${name}: ${error.message}`); report.workflows[name] = { status: 'unverified' }; }
    }
    if (!report.errors.length) report.status = report.workflows.judge?.status === 'verified-judge-decision-unsettled' ? 'chain-evidence-verified-judge-unsettled-offchain-review-required' : 'chain-evidence-verified-offchain-review-required';
  }
} catch (error) { report.errors.push(error.message); }
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
await writeFile(path.join(outputDir, 'rpc-evidence.json'), JSON.stringify(collected, null, 2) + '\n', { mode: 0o600 });
console.log(`Evidence status: ${report.status}\nReport: ${path.join(outputDir, 'report.json')}`);
for (const error of report.errors) console.error(error);
if (report.errors.length) process.exitCode = 1;
