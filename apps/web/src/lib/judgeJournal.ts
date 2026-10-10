import { NETWORK_STORAGE } from './chainNetwork';
import { AccountRole, address, assertIsFullySignedTransaction, getBase58Decoder, getBase58Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, sendAndConfirmTransactionFactory, signature, type Instruction, type KeyPairSigner } from '@solana/kit';
import type { AppClient } from '../providers';
import { PROGRAM_ADDRESS, deriveJudgeMandateAddress } from './agentOs';
import { judgeDigest, loadJudgeSnapshot, parseJudgeArtifact, type JudgeSnapshot } from './judgeClient';
import { sendSessionSponsoredTransaction } from './sessionSponsoredTransaction';
export type JudgeAction = 'propose' | 'accept' | 'decline' | 'record' | 'settle';
export type JudgeCheckpoint = { escrow: string; id: string };
export type JudgeAttempt = {
  version: 1; id: string; escrow: string; action: JudgeAction; feePayer: string;
  binding: { employer: string; worker: string; amount: string; asset: 'SOL' | 'USDC'; taskHash: string };
  instruction: { program: string; data: string; accounts: { address: string; role: AccountRole }[] };
  artifact?: string;
  state: 'prepared' | 'signed' | 'unknown' | 'confirmed' | 'failed' | 'cancelled';
  signature?: string; lastValidBlockHeight?: string; createdAt: string; updatedAt: string;
};
const key = (escrow: string) => `agentos:judge-journal:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${escrow}`;
const isAddress = (value: unknown) => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const isU64 = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const bytes = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const transitions = { prepared: ['prepared', 'signed', 'cancelled'], signed: ['signed', 'unknown', 'confirmed', 'failed'], unknown: ['unknown', 'confirmed', 'failed'], confirmed: ['confirmed'], failed: ['failed'], cancelled: ['cancelled'] };
function validate(values: unknown, escrow: string): JudgeAttempt[] {
  if (!isAddress(escrow) || !Array.isArray(values) || values.length > 100) throw new Error('Invalid Judge journal or record limit exceeded.');
  const ids = new Set<string>();
  return values.map((item: JudgeAttempt) => {
    if (!item || item.version !== 1 || item.escrow !== escrow || typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || ids.has(item.id) || !['propose', 'accept', 'decline', 'record', 'settle'].includes(item.action) || !isAddress(item.feePayer) || !item.binding || !isAddress(item.binding.employer) || !isAddress(item.binding.worker) || !isU64(item.binding.amount) || BigInt(item.binding.amount) === 0n || !['SOL', 'USDC'].includes(item.binding.asset) || !/^[a-f0-9]{64}$/.test(item.binding.taskHash) || !item.instruction || item.instruction.program !== PROGRAM_ADDRESS || typeof item.instruction.data !== 'string' || !/^[a-f0-9]{16,224}$/.test(item.instruction.data) || item.instruction.data.length % 2 || !Array.isArray(item.instruction.accounts) || item.instruction.accounts.length > 20 || !item.instruction.accounts.every((account) => account && isAddress(account.address) && [0, 1, 2, 3].includes(account.role)) || !Object.hasOwn(transitions, item.state) || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt)) || item.artifact !== undefined && (item.action !== 'record' || typeof item.artifact !== 'string' || new TextEncoder().encode(item.artifact).length > 32_768) || item.action === 'record' && !item.artifact || item.signature !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.signature) || item.lastValidBlockHeight !== undefined && !isU64(item.lastValidBlockHeight) || ['signed', 'unknown', 'confirmed'].includes(item.state) && (!item.signature || !item.lastValidBlockHeight) || ['prepared', 'cancelled'].includes(item.state) && Boolean(item.signature)) throw new Error('Judge journal contains an invalid attempt.');
    ids.add(item.id);
    return { version: 1, id: item.id, escrow, action: item.action, feePayer: item.feePayer, binding: { employer: item.binding.employer, worker: item.binding.worker, amount: item.binding.amount, asset: item.binding.asset, taskHash: item.binding.taskHash }, instruction: { program: item.instruction.program, data: item.instruction.data, accounts: item.instruction.accounts.map((account) => ({ address: account.address, role: account.role })) }, state: item.state, createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.artifact ? { artifact: item.artifact } : {}), ...(item.signature ? { signature: item.signature } : {}), ...(item.lastValidBlockHeight ? { lastValidBlockHeight: item.lastValidBlockHeight } : {}) };
  });
}
export function readJudgeJournal(escrow: string) {
  if (!isAddress(escrow)) throw new Error('Invalid Escrow address.');
  const text = localStorage.getItem(key(escrow));
  if (text && text.length > 1_000_000) throw new Error('Judge journal exceeds 1 MB.');
  return text ? validate(JSON.parse(text), escrow) : [];
}
function write(escrow: string, values: JudgeAttempt[]) {
  const text = JSON.stringify(validate(values, escrow));
  if (text.length > 1_000_000) throw new Error('Judge journal exceeds 1 MB. Export before continuing.');
  localStorage.setItem(key(escrow), text);
  if (JSON.stringify(readJudgeJournal(escrow)) !== text) throw new Error('Could not persist Judge checkpoint.');
}
async function locked<T>(escrow: string, fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('Judge transactions require browser coordination locks.');
  return navigator.locks.request(`agentos:judge-send:${PROGRAM_ADDRESS}:${escrow}`, fn);
}
function locate(checkpoint: JudgeCheckpoint) {
  const item = readJudgeJournal(checkpoint.escrow).find((record) => record.id === checkpoint.id);
  if (!item) throw new Error('Judge checkpoint is missing. Restore the journal first.');
  return item;
}
function update(checkpoint: JudgeCheckpoint, patch: Pick<JudgeAttempt, 'state'> & Partial<Pick<JudgeAttempt, 'signature' | 'lastValidBlockHeight'>>) {
  const records = readJudgeJournal(checkpoint.escrow);
  const index = records.findIndex((record) => record.id === checkpoint.id);
  if (index < 0) throw new Error('Judge checkpoint is missing.');
  const old = records[index];
  if (!transitions[old.state].includes(patch.state) || old.signature && (patch.signature && patch.signature !== old.signature || patch.lastValidBlockHeight && patch.lastValidBlockHeight !== old.lastValidBlockHeight)) throw new Error('Judge checkpoint cannot reopen or change signature.');
  records[index] = { ...old, ...patch, updatedAt: new Date().toISOString() }; write(checkpoint.escrow, records);
}
const serialize = (instruction: Instruction) => ({ program: String(instruction.programAddress), data: hex(new Uint8Array(instruction.data ?? [])), accounts: (instruction.accounts ?? []).map((account) => ({ address: String(account.address), role: account.role })) });
const sameBinding = (item: JudgeAttempt, live: JudgeSnapshot) => item.binding.employer === live.employer && item.binding.worker === live.worker && item.binding.amount === live.amount && item.binding.asset === live.asset && item.binding.taskHash === live.taskHash;
async function verifyInstruction(item: JudgeAttempt, live: JudgeSnapshot) {
  if (!sameBinding(item, live)) throw new Error('Escrow differs from the reviewed Judge checkpoint.');
  const method = item.action === 'settle' ? item.binding.asset === 'SOL' ? 'settle_judged_escrow' : 'settle_judged_usdc_escrow' : { propose: 'propose_escrow_judge', accept: 'accept_escrow_judge', decline: 'decline_escrow_judge', record: 'record_escrow_judgment' }[item.action];
  if (item.instruction.data.slice(0, 16) !== (await judgeDigest(`global:${method}`)).slice(0, 16)) throw new Error('Checkpoint instruction does not match its Judge action.');
  const expected = { propose: [9, 16, 3], accept: [4, 112, 2], decline: [4, 8, -1], record: [9, 105, 5], settle: [item.binding.asset === 'SOL' ? 12 : 17, 8, 3] }[item.action];
  const accounts = item.instruction.accounts;
  if (accounts.length !== expected[0] || item.instruction.data.length !== expected[1] * 2 || (expected[2] >= 0 ? accounts[expected[2]].address !== item.escrow : accounts[3].address !== await deriveJudgeMandateAddress(address(item.escrow))) || accounts[item.action === 'record' ? 1 : 0].address !== item.feePayer) throw new Error('Judge instruction accounts differ from its saved review.');
  if (item.action === 'record') {
    const artifact = await parseJudgeArtifact(item.artifact!, live);
    const data = bytes(item.instruction.data);
    if (data[8] !== ['pass', 'fail', 'needs_review'].indexOf(artifact.verdict) || hex(data.slice(9, 41)) !== live.taskHash || hex(data.slice(41, 73)) !== live.resultHash || hex(data.slice(73)) !== artifact.hash) throw new Error('Saved assessment differs from its signed instruction.');
  }
}
function hasEffect(item: JudgeAttempt, live: JudgeSnapshot): boolean {
  if (item.action === 'propose') return Boolean(live.mandate); // Any proposal prevents a safe replay.
  if (item.action === 'accept') return Boolean(live.mandate?.accepted);
  if (item.action === 'decline') return Boolean(live.mandate?.declined);
  if (item.action === 'record') return Boolean(live.decision);
  return Boolean(live.decision?.settled) || !live.funded;
}
async function verifyEffect(item: JudgeAttempt, live: JudgeSnapshot) {
  const data = bytes(item.instruction.data), accounts = item.instruction.accounts;
  const mandate = live.mandate;
  if (!mandate) throw new Error('Original Judge action has no on-chain mandate.');
  if (item.action === 'propose') {
    const expiry = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(8, true);
    if (mandate.judge !== accounts[4].address || mandate.session !== accounts[6].address || BigInt(mandate.expiresAt) !== expiry) throw new Error('Proposal outcome does not match the original review.');
  } else if (item.action === 'accept') {
    const value = data.slice(8);
    if (!mandate.accepted || getBase58Decoder().decode(value.slice(0, 32)) !== mandate.judge || getBase58Decoder().decode(value.slice(32, 64)) !== mandate.session || hex(value.slice(72)) !== mandate.taskHash || BigInt(mandate.expiresAt) !== new DataView(value.buffer, value.byteOffset, value.byteLength).getBigInt64(64, true)) throw new Error('Acceptance outcome does not match the original review.');
  } else if (item.action === 'decline' && !mandate.declined) throw new Error('The original decline is not recorded.');
  else if (item.action === 'record' && (!live.decision || live.decision.session !== accounts[4].address || live.decision.judge !== accounts[2].address || live.decision.judgmentHash !== hex(data.slice(73)))) throw new Error('Decision outcome differs from the original review.');
  else if (item.action === 'settle' && (!live.decision?.settled || live.funded || (live.decision.verdict === 'pass' ? live.status !== 'released' : live.status !== 'refunded'))) throw new Error('Original Judge settlement is not recorded.');
}
export async function prepareJudgeTransaction(live: JudgeSnapshot, action: JudgeAction, feePayer: string, instruction: Instruction, artifact?: string): Promise<JudgeCheckpoint> {
  return locked(live.escrow, async () => {
    const records = readJudgeJournal(live.escrow);
    if (records.some((item) => ['prepared', 'signed', 'unknown'].includes(item.state) || item.action === action && item.state === 'confirmed')) throw new Error('Check or discard the existing Judge action before preparing another attempt.');
    const now = new Date().toISOString();
    const item: JudgeAttempt = { version: 1, id: crypto.randomUUID(), escrow: live.escrow, action, feePayer, binding: { employer: live.employer, worker: live.worker, amount: live.amount, asset: live.asset, taskHash: live.taskHash }, instruction: serialize(instruction), ...(artifact ? { artifact } : {}), state: 'prepared', createdAt: now, updatedAt: now };
    await verifyInstruction(item, live); write(live.escrow, [...records, item]); return { escrow: live.escrow, id: item.id };
  });
}
export async function discardJudgeTransaction(checkpoint: JudgeCheckpoint) {
  return locked(checkpoint.escrow, async () => { const item = locate(checkpoint); if (item.state !== 'prepared' || item.signature) throw new Error('A signed Judge action must be checked on-chain.'); update(checkpoint, { state: 'cancelled' }); });
}
export async function sendJudgeTransaction(client: AppClient, instruction: Instruction, checkpoint: JudgeCheckpoint, sponsor?: KeyPairSigner, safeguards?: { maxFeeLamports: bigint; assertAuthorized: () => Promise<void> }): Promise<string> {
  return locked(checkpoint.escrow, async () => {
    const item = locate(checkpoint);
    if (item.state !== 'prepared' || item.signature || JSON.stringify(item.instruction) !== JSON.stringify(serialize(instruction))) throw new Error('Judge review was discarded, already signed or changed.');
    const live = await loadJudgeSnapshot(client, item.escrow); await verifyInstruction(item, live);
    if (hasEffect(item, live)) throw new Error('This Judge action already has a chain outcome. Check the original transaction instead.');
    let persisted = false;
    const onSigned = (value: string, height: string) => { update(checkpoint, { state: 'signed', signature: value, lastValidBlockHeight: height }); persisted = true; };
    try {
      let result: string;
      if (sponsor) {
        if (sponsor.address !== item.feePayer) throw new Error('Judge fee sponsor changed.');
        result = await sendSessionSponsoredTransaction(client, instruction, sponsor, onSigned, safeguards);
      } else {
        const signed = await client.signTransaction([instruction]); const transaction = signed.context.transaction;
        assertIsFullySignedTransaction(transaction);
        if (signed.context.message.feePayer.address !== item.feePayer) throw new Error('Connected wallet fee payer changed.');
        onSigned(String(getSignatureFromTransaction(transaction)), signed.context.message.lifetimeConstraint.lastValidBlockHeight.toString());
        const simulation = await client.rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }).send();
        if (simulation.value.err !== null) throw new Error('Judge transaction simulation failed; no transaction was sent.');
        const send = sendAndConfirmTransactionFactory({ rpc: client.rpc, rpcSubscriptions: client.rpcSubscriptions });
        await send(transaction as Parameters<typeof send>[0], { commitment: 'confirmed' }); result = String(getSignatureFromTransaction(transaction));
      }
      update(checkpoint, { state: 'confirmed' }); return result;
    } catch (cause) { if (persisted && locate(checkpoint).state === 'signed') update(checkpoint, { state: 'unknown' }); throw cause; }
  });
}
export async function reconcileJudgeTransaction(client: AppClient, checkpoint: JudgeCheckpoint) {
  return locked(checkpoint.escrow, async () => {
    const item = locate(checkpoint);
    if (!item.signature || !item.lastValidBlockHeight || !['signed', 'unknown'].includes(item.state)) throw new Error('This Judge attempt has no unresolved signed transaction.');
    const live = await loadJudgeSnapshot(client, item.escrow); await verifyInstruction(item, live);
    const statuses = await client.rpc.getSignatureStatuses([signature(item.signature)], { searchTransactionHistory: true }).send();
    const status = statuses.value[0];
    if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) {
      const tx = await client.rpc.getTransaction(signature(item.signature), { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }).send();
      if (!tx?.meta) throw new Error('Original Judge transaction is unavailable. Keep its checkpoint.');
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const matches = tx.transaction.message.instructions.some((instruction) => keys[instruction.programIdIndex] === PROGRAM_ADDRESS && hex(new Uint8Array(getBase58Encoder().encode(instruction.data))) === item.instruction.data && instruction.accounts.length === item.instruction.accounts.length && instruction.accounts.every((index, at) => keys[index] === item.instruction.accounts[at].address));
      if (tx.transaction.signatures[0] !== item.signature || keys[0] !== item.feePayer || !matches) throw new Error('Signature does not contain the exact reviewed Judge instruction and fee payer.');
      if (status.err === null && tx.meta.err === null) { await verifyEffect(item, live); update(checkpoint, { state: 'confirmed' }); return; }
      if (status.confirmationStatus === 'finalized' && status.err !== null && tx.meta.err !== null) { update(checkpoint, { state: 'failed' }); return; }
    }
    if (!status && !hasEffect(item, live) && await client.rpc.getBlockHeight({ commitment: 'finalized' }).send() > BigInt(item.lastValidBlockHeight)) { update(checkpoint, { state: 'failed' }); return; }
    throw new Error('Judge signature remains unresolved; no transaction was retried.');
  });
}
export function exportJudgeJournal(escrow: string) { return JSON.stringify({ format: 'agentos-judge-journal', version: 1, programId: PROGRAM_ADDRESS, network: NETWORK_STORAGE, escrow, records: readJudgeJournal(escrow) }); }
export async function importJudgeJournal(client: AppClient, escrow: string, text: string) {
  if (text.length > 1_000_000) throw new Error('Judge backup exceeds 1 MB.');
  const backup = JSON.parse(text);
  if (backup?.format !== 'agentos-judge-journal' || backup.version !== 1 || backup.programId !== PROGRAM_ADDRESS || backup.network !== NETWORK_STORAGE || backup.escrow !== escrow) throw new Error('Judge backup belongs to another Program, network or Escrow.');
  const imported = validate(backup.records, escrow);
  const live = await loadJudgeSnapshot(client, escrow);
  for (const item of imported) await verifyInstruction(item, live);
  return locked(escrow, async () => {
    const records = readJudgeJournal(escrow);
    for (const item of imported) {
      const local = records.find((record) => record.id === item.id);
      if (local) {
        if (JSON.stringify(local.binding) !== JSON.stringify(item.binding) || JSON.stringify(local.instruction) !== JSON.stringify(item.instruction) || local.feePayer !== item.feePayer || local.action !== item.action || local.artifact !== item.artifact || local.createdAt !== item.createdAt || local.signature && item.signature && (local.signature !== item.signature || local.lastValidBlockHeight !== item.lastValidBlockHeight)) throw new Error('Imported Judge attempt conflicts with the local review.');
        if (!local.signature && item.signature) {
          if (local.state !== 'prepared') throw new Error('Imported signature conflicts with a discarded local review.');
          Object.assign(local, { signature: item.signature, lastValidBlockHeight: item.lastValidBlockHeight, state: 'unknown', updatedAt: item.updatedAt });
        }
      } else records.push({ ...item, state: item.signature ? 'unknown' : 'prepared' });
    }
    write(escrow, records);
  });
}
