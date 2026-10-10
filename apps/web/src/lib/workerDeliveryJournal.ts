import { NETWORK_STORAGE, ensureConfiguredNetwork } from './chainNetwork';
import { address, getBase58Decoder, getBase58Encoder, getBase64Encoder, signature as solanaSignature, type Instruction, type KeyPairSigner } from '@solana/kit';
import type { AppClient } from '../providers';
import { PROGRAM_ADDRESS, deriveEscrowAddress } from './agentOs';
import { sendSessionSponsoredTransaction } from './sessionSponsoredTransaction';
import { assertIsFullySignedTransaction, getBase64EncodedWireTransaction, getSignatureFromTransaction, sendAndConfirmTransactionFactory } from '@solana/kit';

export type DeliveryCheckpoint = {
  version: 1; id: string; worker: string; escrow: string; task: string; result: string; taskHash: string; resultHash: string;
  session?: string; feePayer: string; sources: { execution: string; contentHash: string }[];
  state: 'prepared' | 'signed' | 'unknown' | 'confirmed' | 'failed' | 'cancelled';
  signature?: string; lastValidBlockHeight?: string; createdAt: string; updatedAt: string;
};
const key = (worker: string) => `agentos:worker-delivery:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${worker}`;
const validAddress = (value: unknown): value is string => { try { return typeof value === 'string' && Boolean(address(value)); } catch { return false; } };
const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
function validate(records: unknown, worker: string): DeliveryCheckpoint[] {
  if (!validAddress(worker) || !Array.isArray(records) || records.length > 200) throw new Error('Invalid Worker delivery journal.');
  const ids = new Set<string>();
  for (const item of records as DeliveryCheckpoint[]) {
    if (!item || item.version !== 1 || item.worker !== worker || typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || ids.has(item.id)
      || !validAddress(item.escrow) || !validAddress(item.feePayer) || item.session !== undefined && !validAddress(item.session)
      || typeof item.task !== 'string' || !item.task.trim() || item.task !== item.task.trim() || item.task.length > 400
      || typeof item.result !== 'string' || !item.result.trim() || item.result !== item.result.trim() || item.result.length > 400
      || !validHash(item.taskHash) || !validHash(item.resultHash) || !['prepared', 'signed', 'unknown', 'confirmed', 'failed', 'cancelled'].includes(item.state)
      || !Array.isArray(item.sources) || item.sources.length > 3 || new Set(item.sources.map((source) => source.execution)).size !== item.sources.length || !item.sources.every((source) => validAddress(source.execution) && validHash(source.contentHash))
      || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))
      || item.signature !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.signature)
      || item.lastValidBlockHeight !== undefined && !/^(0|[1-9][0-9]{0,19})$/.test(item.lastValidBlockHeight)
      || ['signed', 'unknown', 'confirmed'].includes(item.state) && (!item.signature || !item.lastValidBlockHeight)
      || ['prepared', 'cancelled'].includes(item.state) && Boolean(item.signature)) throw new Error('Invalid Worker delivery checkpoint.');
    ids.add(item.id);
  }
  return (records as DeliveryCheckpoint[]).map((item) => ({ version: 1, id: item.id, worker: item.worker, escrow: item.escrow, task: item.task, result: item.result, taskHash: item.taskHash, resultHash: item.resultHash, ...(item.session ? { session: item.session } : {}), feePayer: item.feePayer, sources: item.sources.map((source) => ({ execution: source.execution, contentHash: source.contentHash })), state: item.state, ...(item.signature ? { signature: item.signature } : {}), ...(item.lastValidBlockHeight ? { lastValidBlockHeight: item.lastValidBlockHeight } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt }));
}
export function readDeliveryJournal(worker: string): DeliveryCheckpoint[] {
  const text = localStorage.getItem(key(worker));
  if (!text) return [];
  if (text.length > 500_000) throw new Error('Worker delivery journal is full; download it before continuing.');
  return validate(JSON.parse(text), worker);
}
function save(item: DeliveryCheckpoint) {
  const records = readDeliveryJournal(item.worker); const index = records.findIndex((record) => record.id === item.id);
  if (index >= 0) {
    const previous = records[index];
    const immutable = (record: DeliveryCheckpoint) => JSON.stringify({ id: record.id, worker: record.worker, escrow: record.escrow, task: record.task, result: record.result, taskHash: record.taskHash, resultHash: record.resultHash, session: record.session, feePayer: record.feePayer, sources: record.sources, createdAt: record.createdAt });
    if (immutable(previous) !== immutable(item) || previous.signature && (previous.signature !== item.signature || previous.lastValidBlockHeight !== item.lastValidBlockHeight)) throw new Error('A reviewed delivery or signed transaction cannot change.');
    const transitions: Record<DeliveryCheckpoint['state'], DeliveryCheckpoint['state'][]> = { prepared: ['signed', 'cancelled'], signed: ['unknown', 'confirmed', 'failed'], unknown: ['confirmed', 'failed'], confirmed: [], failed: [], cancelled: [] };
    if (item.state !== previous.state && !transitions[previous.state].includes(item.state)) throw new Error('Delivery state cannot reopen.');
    records[index] = item;
  } else records.push(item);
  validate(records, item.worker);
  const text = JSON.stringify(records);
  if (text.length > 500_000) throw new Error('Worker delivery journal is full.');
  localStorage.setItem(key(item.worker), text);
  if (localStorage.getItem(key(item.worker)) !== text) throw new Error('Could not save Worker delivery checkpoint.');
  return item;
}
export function updateDelivery(item: DeliveryCheckpoint, patch: Partial<Pick<DeliveryCheckpoint, 'state' | 'signature' | 'lastValidBlockHeight'>>) {
  return save({ ...item, ...patch, updatedAt: new Date().toISOString() });
}
export async function prepareDelivery(input: Omit<DeliveryCheckpoint, 'version' | 'id' | 'state' | 'createdAt' | 'updatedAt'>) {
  if (!navigator.locks) throw new Error('Worker delivery requires browser coordination locks.');
  return navigator.locks.request(`agentos:delivery:${PROGRAM_ADDRESS}:${input.escrow}`, async () => {
    if (readDeliveryJournal(input.worker).some((item) => item.escrow === input.escrow && !['failed', 'cancelled'].includes(item.state))) throw new Error('This Escrow has an existing delivery checkpoint. Check it before preparing another submission.');
    if (await digest(input.task) !== input.taskHash || await digest(input.result) !== input.resultHash) throw new Error('Delivery texts do not match reviewed commitments.');
    const now = new Date().toISOString();
    return save({ ...input, version: 1, id: crypto.randomUUID(), state: 'prepared', createdAt: now, updatedAt: now });
  });
}
export async function sendDelivery(client: AppClient, instruction: Instruction, checkpoint: DeliveryCheckpoint, signer?: KeyPairSigner) {
  if (!navigator.locks) throw new Error('Worker delivery requires browser coordination locks.');
  return navigator.locks.request(`agentos:delivery:${PROGRAM_ADDRESS}:${checkpoint.escrow}`, async () => {
    let current = readDeliveryJournal(checkpoint.worker).find((item) => item.id === checkpoint.id);
    if (!current || current.state !== 'prepared' || current.signature || await digest(current.task) !== current.taskHash || await digest(current.result) !== current.resultHash) throw new Error('Delivery is already signed or its saved texts are invalid.');
    const onSigned = (signature: string, lastValidBlockHeight: string) => { current = updateDelivery(current!, { state: 'signed', signature, lastValidBlockHeight }); };
    try {
      let result: string;
      if (signer) {
        if (signer.address !== current.feePayer) throw new Error('Delivery fee signer changed.');
        result = await sendSessionSponsoredTransaction(client, instruction, signer, onSigned);
      } else {
        const signed = await client.signTransaction([instruction]); const transaction = signed.context.transaction;
        assertIsFullySignedTransaction(transaction);
        onSigned(String(getSignatureFromTransaction(transaction)), signed.context.message.lifetimeConstraint.lastValidBlockHeight.toString());
        const simulation = await client.rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }).send();
        if (simulation.value.err !== null) throw new Error('Worker delivery simulation failed. No transaction was sent.');
        const send = sendAndConfirmTransactionFactory({ rpc: client.rpc, rpcSubscriptions: client.rpcSubscriptions });
        await send(transaction as Parameters<typeof send>[0], { commitment: 'confirmed' });
        result = String(getSignatureFromTransaction(transaction));
      }
      updateDelivery(current!, { state: 'confirmed' }); return result;
    } catch (error) { if (current!.signature) updateDelivery(current!, { state: 'unknown' }); throw error; }
  });
}
export async function reconcileDelivery(client: AppClient, item: DeliveryCheckpoint): Promise<DeliveryCheckpoint> {
  if (!item.signature || !item.lastValidBlockHeight || !['signed', 'unknown'].includes(item.state)) return item;
  await ensureConfiguredNetwork(client);
  if (await digest(item.task) !== item.taskHash || await digest(item.result) !== item.resultHash) throw new Error('Saved Worker delivery texts were changed.');
  const [status, account] = await Promise.all([
    client.rpc.getSignatureStatuses([solanaSignature(item.signature)], { searchTransactionHistory: true }).send(),
    client.rpc.getAccountInfo(address(item.escrow), { commitment: 'confirmed', encoding: 'base64' }).send(),
  ]);
  const info = account.value;
  if (!info || info.owner !== PROGRAM_ADDRESS) throw new Error('Worker Escrow is unavailable or has a different owner.');
  const data = new Uint8Array(getBase64Encoder().encode(info.data[0]));
  const discriminator = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account:Escrow'))).slice(0, 8);
  if (data.length !== 180 || data[128] > 1 || discriminator.some((byte, index) => data[index] !== byte) || getBase58Decoder().decode(data.slice(40, 72)) !== item.worker
    || await deriveEscrowAddress(address(getBase58Decoder().decode(data.slice(8, 40))), new DataView(data.buffer).getBigUint64(72, true)) !== item.escrow
    || [...data.slice(96, 128)].map((byte) => byte.toString(16).padStart(2, '0')).join('') !== item.taskHash) throw new Error('Escrow does not match the saved Worker delivery.');
  const chainHash = data[128] === 1 ? [...data.slice(129, 161)].map((byte) => byte.toString(16).padStart(2, '0')).join('') : null;
  const receipt = status.value[0];
  if (receipt && receipt.err === null && ['confirmed', 'finalized'].includes(receipt.confirmationStatus ?? '') && chainHash === item.resultHash) {
    const transaction = await client.rpc.getTransaction(solanaSignature(item.signature), { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 }).send();
    if (!transaction || transaction.meta?.err !== null) throw new Error('Original Worker delivery transaction is unavailable.');
    const keys = [...transaction.transaction.message.accountKeys, ...(transaction.meta.loadedAddresses?.writable ?? []), ...(transaction.meta.loadedAddresses?.readonly ?? [])];
    const method = item.session ? 'submit_session_escrow_result' : item.sources.length ? 'submit_escrow_result_with_sources' : 'submit_escrow_result';
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`global:${method}`))).slice(0, 8);
    const expectedWorker = item.session ? 2 : 1; const expectedEscrow = item.session ? 5 : 2;
    const matched = transaction.transaction.message.instructions.some((instruction) => {
      if (keys[instruction.programIdIndex] !== PROGRAM_ADDRESS || keys[instruction.accounts[expectedWorker]] !== item.worker || keys[instruction.accounts[expectedEscrow]] !== item.escrow || item.session && keys[instruction.accounts[4]] !== item.session) return false;
      const bytes = new Uint8Array(getBase58Encoder().encode(instruction.data));
      if (bytes.length < 40 || expected.some((byte, index) => bytes[index] !== byte) || [...bytes.slice(8, 40)].map((byte) => byte.toString(16).padStart(2, '0')).join('') !== item.resultHash) return false;
      if (!item.session && !item.sources.length) return bytes.length === 40;
      if (bytes.length !== 44 + item.sources.length * 64 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(40, true) !== item.sources.length) return false;
      return item.sources.every((source, index) => getBase58Decoder().decode(bytes.slice(44 + index * 64, 76 + index * 64)) === source.execution && [...bytes.slice(76 + index * 64, 108 + index * 64)].map((byte) => byte.toString(16).padStart(2, '0')).join('') === source.contentHash);
    });
    if (!matched || keys[0] !== item.feePayer) throw new Error('Saved signature does not prove this exact Worker delivery.');
    return updateDelivery(item, { state: 'confirmed' });
  }
  if (receipt?.confirmationStatus === 'finalized' && receipt.err !== null && chainHash === null) return updateDelivery(item, { state: 'failed' });
  if (!receipt && chainHash === null && await client.rpc.getBlockHeight({ commitment: 'finalized' }).send() > BigInt(item.lastValidBlockHeight)) return updateDelivery(item, { state: 'failed' });
  return item;
}

const autoKey = (worker: string) => `${key(worker)}:automatic`;
export function automaticDeliveries(worker: string): { escrow: string; session: string }[] {
  const text = localStorage.getItem(autoKey(worker)); if (!text) return [];
  if (text.length > 30_000) throw new Error('Automatic delivery settings exceed the storage limit.');
  const values: unknown = JSON.parse(text);
  if (!Array.isArray(values) || values.length > 200 || !values.every((item) => item && validAddress(item.escrow) && validAddress(item.session)) || new Set(values.map((item) => item.escrow)).size !== values.length) throw new Error('Invalid automatic delivery settings.');
  return values.map((item) => ({ escrow: item.escrow, session: item.session }));
}
export function enableAutomaticDelivery(worker: string, escrow: string, session: string, enabled: boolean) {
  if (!validAddress(worker) || !validAddress(escrow) || !validAddress(session)) throw new Error('Invalid automatic delivery scope.');
  const records = automaticDeliveries(worker).filter((item) => item.escrow !== escrow);
  if (enabled) records.push({ escrow, session });
  if (records.length > 200) throw new Error('Automatic delivery settings are full.');
  localStorage.setItem(autoKey(worker), JSON.stringify(records));
}

export function importDeliveryJournal(worker: string, text: string) {
  if (text.length > 520_000) throw new Error('Worker delivery backup exceeds the storage limit.');
  const backup = JSON.parse(text);
  if (backup?.format !== 'agentos-worker-delivery-journal' || backup.version !== 1 || backup.programId !== PROGRAM_ADDRESS || backup.network !== NETWORK_STORAGE || backup.worker !== worker) throw new Error('Backup belongs to a different Program, network or Worker.');
  const records = readDeliveryJournal(worker);
  for (const item of validate(backup.records, worker)) {
    const previous = records.find((record) => record.id === item.id);
    if (previous) {
      if (previous.escrow !== item.escrow || previous.resultHash !== item.resultHash || previous.taskHash !== item.taskHash || previous.result !== item.result || previous.task !== item.task || previous.signature !== item.signature || previous.session !== item.session || previous.feePayer !== item.feePayer || JSON.stringify(previous.sources) !== JSON.stringify(item.sources)) throw new Error('Imported delivery conflicts with a saved checkpoint.');
      continue;
    }
    records.push({ ...item, state: item.signature ? 'unknown' : item.state === 'cancelled' ? 'cancelled' : 'prepared' });
  }
  const data = JSON.stringify(validate(records, worker));
  if (data.length > 500_000) throw new Error('Merged delivery journal exceeds the storage limit.');
  localStorage.setItem(key(worker), data);
}

export async function verifyDeliveryTexts(item: DeliveryCheckpoint) {
  if (await digest(item.task) !== item.taskHash || await digest(item.result) !== item.resultHash) throw new Error('Saved Worker result text does not match its commitments.');
}

const toolSettingsKey = (worker: string) => `${key(worker)}:tools`;
export function automaticWorkerTools(worker: string): { escrow: string; session: string }[] {
  const text = localStorage.getItem(toolSettingsKey(worker)); if (!text) return [];
  if (text.length > 30_000) throw new Error('Worker tool settings exceed the storage limit.');
  const values: unknown = JSON.parse(text);
  if (!Array.isArray(values) || values.length > 200 || !values.every((item) => item && validAddress(item.escrow) && validAddress(item.session)) || new Set(values.map((item) => item.escrow)).size !== values.length) throw new Error('Invalid Worker tool settings.');
  return values.map((item) => ({ escrow: item.escrow, session: item.session }));
}
export function enableAutomaticWorkerTools(worker: string, escrow: string, session: string, enabled: boolean) {
  if (!validAddress(worker) || !validAddress(escrow) || !validAddress(session)) throw new Error('Invalid Worker tool scope.');
  const values = automaticWorkerTools(worker).filter((item) => item.escrow !== escrow); if (enabled) values.push({ escrow, session });
  if (values.length > 200) throw new Error('Worker tool settings are full.');
  localStorage.setItem(toolSettingsKey(worker), JSON.stringify(values));
}
