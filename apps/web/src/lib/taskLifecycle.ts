import { NETWORK_STORAGE, ensureConfiguredNetwork } from './chainNetwork';
import { address, assertIsFullySignedTransaction, getAddressDecoder, getAddressEncoder, getBase58Encoder, getBase64EncodedWireTransaction, getProgramDerivedAddress, getSignatureFromTransaction, sendAndConfirmTransactionFactory, signature, type Instruction } from '@solana/kit';
import type { AppClient } from '../providers';
import { buildCreateTask, buildReplaceTaskSession, buildSetTaskStatus, deriveTaskAddress, PROGRAM_ADDRESS, type TaskStatus } from './agentOs';
import { decodeChainTask, type ChainTask } from './taskClient';

export type TaskLifecycleCheckpoint = { agent: string; id: string };
type State = 'prepared' | 'signed' | 'unknown' | 'confirmed' | 'failed' | 'cancelled';
type Binding = { taskHash: string; maxSol: string; maxUsdc: string; deadline: number };
export type TaskLifecycleAttempt = {
  version: 1; id: string; agent: string; task: string; taskId: string; owner: string;
  action: 'create' | 'status' | 'session'; binding: Binding;
  previous?: { status: TaskStatus; session: string; resultHash: string | null };
  session?: string; next?: TaskStatus; description?: string; resultText?: string;
  instruction: { program: string; data: string; accounts: { address: string; role: number }[] };
  state: State; signature?: string; lastValidBlockHeight?: string; createdAt: string; updatedAt: string;
};
const transitions: Record<State, State[]> = { prepared: ['prepared', 'signed', 'cancelled'], signed: ['signed', 'unknown', 'confirmed', 'failed'], unknown: ['unknown', 'confirmed', 'failed'], confirmed: ['confirmed'], failed: ['failed'], cancelled: ['cancelled'] };
const statuses = ['ready', 'running', 'paused', 'completed', 'failed', 'cancelled', 'waiting'];
const unresolved = (item: TaskLifecycleAttempt) => ['prepared', 'signed', 'unknown'].includes(item.state);
const key = (agent: string) => `agentos:task-lifecycle:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${agent}`;
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const hash = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const isKey = (value: unknown): value is string => { try { if (typeof value !== 'string') return false; getAddressEncoder().encode(address(value)); return true; } catch { return false; } };
const isU64 = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const serialize = (instruction: Instruction) => ({ program: String(instruction.programAddress), data: hex(new Uint8Array(instruction.data ?? [])), accounts: (instruction.accounts ?? []).map(account => ({ address: String(account.address), role: account.role })) });
function validate(values: unknown, agent: string): TaskLifecycleAttempt[] {
  if (!isKey(agent) || !Array.isArray(values) || values.length > 200) throw new Error('Invalid Task lifecycle journal or its 200-record limit was exceeded.');
  const ids = new Set<string>();
  return values.map((item: TaskLifecycleAttempt) => {
    if (!item || item.version !== 1 || item.agent !== agent || !/^[0-9a-f-]{36}$/.test(item.id) || ids.has(item.id) || !isKey(item.task) || !isU64(item.taskId) || !isKey(item.owner) || !['create', 'status', 'session'].includes(item.action) || !item.binding || !isHash(item.binding.taskHash) || !isU64(item.binding.maxSol) || !isU64(item.binding.maxUsdc) || BigInt(item.binding.maxSol) + BigInt(item.binding.maxUsdc) === 0n || !Number.isSafeInteger(item.binding.deadline) || item.binding.deadline <= 0 || !Object.hasOwn(transitions, item.state) || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt)) || item.signature !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.signature) || item.lastValidBlockHeight !== undefined && !isU64(item.lastValidBlockHeight) || ['signed', 'unknown', 'confirmed'].includes(item.state) && (!item.signature || !item.lastValidBlockHeight) || ['prepared', 'cancelled'].includes(item.state) && Boolean(item.signature)) throw new Error('Invalid Task lifecycle record.');
    if (item.action === 'create' ? !isKey(item.session) || typeof item.description !== 'string' || item.description !== item.description.trim() || item.description.length < 4 || item.description.length > 800 || item.previous !== undefined || item.next !== undefined || item.resultText !== undefined : !item.previous || !statuses.includes(item.previous.status) || !isKey(item.previous.session) || item.previous.resultHash !== null && !isHash(item.previous.resultHash) || item.description !== undefined) throw new Error('Invalid Task lifecycle review fields.');
    if (item.action === 'session' && (!isKey(item.session) || item.next !== undefined || item.resultText !== undefined) || item.action === 'status' && (item.session !== undefined || !['running', 'paused', 'completed', 'failed', 'cancelled'].includes(item.next ?? '') || (item.next === 'completed' ? typeof item.resultText !== 'string' || !item.resultText.trim() || item.resultText !== item.resultText.trim() || item.resultText.length > 4000 : item.resultText !== undefined))) throw new Error('Invalid Task lifecycle target.');
    if (!item.instruction || item.instruction.program !== PROGRAM_ADDRESS || !/^[a-f0-9]{16,160}$/.test(item.instruction.data) || item.instruction.data.length % 2 || !Array.isArray(item.instruction.accounts) || item.instruction.accounts.length > 5 || !item.instruction.accounts.every(a => a && isKey(a.address) && [0, 1, 2, 3].includes(a.role))) throw new Error('Invalid saved Task instruction.');
    ids.add(item.id);
    return { version: 1, id: item.id, agent, task: item.task, taskId: item.taskId, owner: item.owner, action: item.action, binding: { taskHash: item.binding.taskHash, maxSol: item.binding.maxSol, maxUsdc: item.binding.maxUsdc, deadline: item.binding.deadline }, ...(item.previous ? { previous: { status: item.previous.status, session: item.previous.session, resultHash: item.previous.resultHash } } : {}), ...(item.session ? { session: item.session } : {}), ...(item.next ? { next: item.next } : {}), ...(item.description ? { description: item.description } : {}), ...(item.resultText ? { resultText: item.resultText } : {}), instruction: { program: item.instruction.program, data: item.instruction.data, accounts: item.instruction.accounts.map(a => ({ address: a.address, role: a.role })) }, state: item.state, createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.signature ? { signature: item.signature } : {}), ...(item.lastValidBlockHeight ? { lastValidBlockHeight: item.lastValidBlockHeight } : {}) };
  });
}
export function readTaskLifecycle(agent: string): TaskLifecycleAttempt[] {
  if (!isKey(agent)) throw new Error('Invalid lifecycle Agent.');
  const text = localStorage.getItem(key(agent));
  if (text && text.length > 500000) throw new Error('Task lifecycle journal exceeds 500 KB.');
  return text ? validate(JSON.parse(text), agent) : [];
}
function write(agent: string, records: TaskLifecycleAttempt[]) {
  const text = JSON.stringify(validate(records, agent));
  if (text.length > 500000) throw new Error('Task lifecycle journal is full. Export it before continuing.');
  localStorage.setItem(key(agent), text);
  if (JSON.stringify(readTaskLifecycle(agent)) !== text) throw new Error('Could not persist Task lifecycle review.');
}
async function locked<T>(agent: string, run: () => Promise<T>) {
  if (!navigator.locks) throw new Error('Task lifecycle recovery requires browser coordination locks.');
  return navigator.locks.request(`agentos:task-lifecycle:${PROGRAM_ADDRESS}:${agent}`, run);
}
function locate(checkpoint: TaskLifecycleCheckpoint) {
  const item = readTaskLifecycle(checkpoint.agent).find(record => record.id === checkpoint.id);
  if (!item) throw new Error('Task lifecycle checkpoint is missing. Restore its backup first.');
  return item;
}
function update(checkpoint: TaskLifecycleCheckpoint, state: State, signed?: { signature: string; lastValidBlockHeight: string }) {
  const records = readTaskLifecycle(checkpoint.agent), index = records.findIndex(item => item.id === checkpoint.id);
  const item = records[index];
  if (!item || !transitions[item.state].includes(state) || item.signature && signed && (item.signature !== signed.signature || item.lastValidBlockHeight !== signed.lastValidBlockHeight)) throw new Error('Task lifecycle attempt cannot reopen or change its signature.');
  records[index] = { ...item, ...signed, state, updatedAt: new Date().toISOString() }; write(checkpoint.agent, records);
}
async function read(client: AppClient, key: string, kind: string, length: number, optional = false) {
  const result = await client.rpc.getAccountInfo(address(key), { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!result.value && optional) return null;
  if (!result.value || result.value.owner !== PROGRAM_ADDRESS || result.value.data[1] !== 'base64') throw new Error(`${kind} is missing or has the wrong owner.`);
  const bytes = Uint8Array.from(atob(result.value.data[0]), char => char.charCodeAt(0));
  const disc = (await hash(`account:${kind}`)).slice(0, 8);
  if (bytes.length !== length || disc.some((byte, index) => bytes[index] !== byte)) throw new Error(`${kind} layout is invalid.`);
  return bytes;
}
async function load(client: AppClient, item: TaskLifecycleAttempt) {
  await ensureConfiguredNetwork(client);
  const a = (await read(client, item.agent, 'Agent', 138))!;
  const [expected, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('agent'), a.slice(8, 40), a.slice(40, 72)] });
  if (expected !== item.agent || a[121] !== bump || getAddressDecoder().decode(a.slice(8, 40)) !== item.owner) throw new Error('Task lifecycle Owner or Agent PDA differs from the review.');
  const bytes = await read(client, item.task, 'Task', 227, true);
  const task = bytes ? await decodeChainTask(item.task, bytes, item.agent) : null;
  if (task && (task.id !== item.taskId || task.taskHash !== item.binding.taskHash || task.sol.maximum !== item.binding.maxSol || task.usdc.maximum !== item.binding.maxUsdc || task.deadline !== item.binding.deadline)) throw new Error('Task immutable binding differs from the review.');
  return task;
}
async function verifyInstruction(item: TaskLifecycleAttempt) {
  if (await deriveTaskAddress(address(item.agent), BigInt(item.taskId)) !== item.task) throw new Error('Saved Task PDA is invalid.');
  const built = item.action === 'create'
    ? await buildCreateTask(address(item.owner), address(item.agent), address(item.session!), BigInt(item.taskId), await hash(item.description!), BigInt(item.binding.maxSol), BigInt(item.binding.maxUsdc), BigInt(item.binding.deadline))
    : item.action === 'session' ? await buildReplaceTaskSession(address(item.owner), address(item.agent), BigInt(item.taskId), address(item.session!))
    : await buildSetTaskStatus(address(item.owner), address(item.agent), BigInt(item.taskId), item.next!, item.resultText ? await hash(item.resultText) : undefined);
  if (item.action === 'create' && hex(await hash(item.description!)) !== item.binding.taskHash || JSON.stringify(serialize(built.instruction)) !== JSON.stringify(item.instruction)) throw new Error('Task instruction differs from the saved review.');
}
const binding = (task: ChainTask): Binding => ({ taskHash: task.taskHash, maxSol: task.sol.maximum, maxUsdc: task.usdc.maximum, deadline: task.deadline });
export async function prepareTaskLifecycle(client: AppClient, input: { agent: string; owner: string; taskId: string; instruction: Instruction } & ({ action: 'create'; description: string; session: string; maxSol: string; maxUsdc: string; deadline: number } | { action: 'status' | 'session'; previous: ChainTask; next?: TaskStatus; session?: string; resultText?: string })): Promise<TaskLifecycleCheckpoint> {
  return locked(input.agent, async () => {
    const records = readTaskLifecycle(input.agent), task = String(await deriveTaskAddress(address(input.agent), BigInt(input.taskId)));
    if (records.some(item => unresolved(item) && (item.task === task || input.action !== 'status' && item.action !== 'status' && item.session === input.session))) throw new Error('Check or discard the saved lifecycle attempt before preparing another review.');
    if (input.action !== 'create' && (input.previous.address !== task || input.previous.agent !== input.agent || input.previous.id !== input.taskId)) throw new Error('Previous Task snapshot belongs to another task.');
    const now = new Date().toISOString();
    const item: TaskLifecycleAttempt = { version: 1, id: crypto.randomUUID(), agent: input.agent, task, taskId: input.taskId, owner: input.owner, action: input.action, binding: input.action === 'create' ? { taskHash: hex(await hash(input.description)), maxSol: input.maxSol, maxUsdc: input.maxUsdc, deadline: input.deadline } : binding(input.previous), ...(input.action === 'create' ? { description: input.description, session: input.session } : { previous: { status: input.previous.status, session: input.previous.session, resultHash: input.previous.resultHash }, ...(input.next ? { next: input.next } : {}), ...(input.session ? { session: input.session } : {}), ...(input.resultText ? { resultText: input.resultText } : {}) }), instruction: serialize(input.instruction), state: 'prepared', createdAt: now, updatedAt: now };
    validate([item], input.agent); await verifyInstruction(item); await assertEligible(client, item, await load(client, item));
    write(input.agent, [...records, item]); return { agent: input.agent, id: item.id };
  });
}
function assertBefore(item: TaskLifecycleAttempt, task: ChainTask | null) {
  if (item.action === 'create' ? task !== null : !task || task.status !== item.previous!.status || task.session !== item.previous!.session || task.resultHash !== item.previous!.resultHash) throw new Error('Task state changed since this review. Check or discard the saved attempt.');
}
async function assertEligible(client: AppClient, item: TaskLifecycleAttempt, task: ChainTask | null) {
  assertBefore(item, task);
  const now = Math.floor(Date.now() / 1000);
  if (item.action === 'status') {
    const current = task!;
    const valid = !['completed', 'failed', 'cancelled'].includes(current.status) && (item.next === 'running' ? ['ready', 'paused'].includes(current.status) : item.next === 'paused' ? ['running', 'waiting'].includes(current.status) : item.next === 'completed' ? current.status === 'running' && current.pendingEscrows === '0' && current.pendingSkillResults === '0' : true);
    if (!valid || ['running', 'completed'].includes(item.next!) && now >= current.deadline) throw new Error('This Task cannot make the reviewed status transition.');
    return;
  }
  if (now >= item.binding.deadline || item.action === 'session' && ['completed', 'failed', 'cancelled'].includes(task!.status)) throw new Error('This Task is expired or terminal.');
  const s = (await read(client, item.session!, 'Session', 147))!;
  const [expected, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('session'), getAddressEncoder().encode(address(item.agent)), s.slice(40, 72)] });
  const view = new DataView(s.buffer, s.byteOffset, s.byteLength);
  if (expected !== item.session || s[106] !== bump || getAddressDecoder().decode(s.slice(8, 40)) !== item.agent || s[105] !== 0 || view.getBigInt64(72, true) < BigInt(item.binding.deadline) || s.slice(107, 123).some(byte => byte !== 0)) throw new Error('The selected Session is revoked, expired, already bound or noncanonical.');
  const solAvailable = view.getBigUint64(88, true) - view.getBigUint64(96, true), usdcAvailable = view.getBigUint64(131, true) - view.getBigUint64(139, true);
  if (solAvailable < BigInt(task?.sol.remaining ?? item.binding.maxSol) || usdcAvailable < BigInt(task?.usdc.remaining ?? item.binding.maxUsdc)) throw new Error('The selected Session cannot cover this Task’s remaining budgets.');
  if (item.action === 'create') {
    const a = (await read(client, item.agent, 'Agent', 138))!;
    if (a[104] !== 0 || item.binding.deadline > now + 30 * 24 * 3600) throw new Error('Task creation needs an active Agent and a deadline within 30 days.');
  }
}
export async function discardTaskLifecycle(checkpoint: TaskLifecycleCheckpoint) {
  return locked(checkpoint.agent, async () => { const item = locate(checkpoint); if (item.signature || item.state !== 'prepared') throw new Error('Signed lifecycle attempts must be checked on-chain.'); update(checkpoint, 'cancelled'); });
}
export async function sendTaskLifecycle(client: AppClient, instruction: Instruction, checkpoint: TaskLifecycleCheckpoint) {
  return locked(checkpoint.agent, async () => {
    const item = locate(checkpoint);
    return navigator.locks.request(`agentos:task-send:${item.agent}:${item.taskId}`, async () => {
      if (item.state !== 'prepared' || item.signature || JSON.stringify(serialize(instruction)) !== JSON.stringify(item.instruction)) throw new Error('Lifecycle attempt is already signed, discarded or changed.');
      await verifyInstruction(item); await assertEligible(client, item, await load(client, item));
      let persisted = false;
      try {
        const signed = await client.signTransaction([instruction]), transaction = signed.context.transaction;
        assertIsFullySignedTransaction(transaction);
        if (signed.context.message.feePayer.address !== item.owner) throw new Error('Connected Owner wallet changed.');
        const value = String(getSignatureFromTransaction(transaction));
        update(checkpoint, 'signed', { signature: value, lastValidBlockHeight: signed.context.message.lifetimeConstraint.lastValidBlockHeight.toString() }); persisted = true;
        await assertEligible(client, item, await load(client, item));
        const simulation = await client.rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }).send();
        if (simulation.value.err !== null) throw new Error('Task lifecycle simulation failed. No transaction was sent.');
        const send = sendAndConfirmTransactionFactory({ rpc: client.rpc, rpcSubscriptions: client.rpcSubscriptions });
        await send(transaction as Parameters<typeof send>[0], { commitment: 'confirmed' });
        update(checkpoint, 'confirmed'); return value;
      } catch (cause) { if (persisted && locate(checkpoint).state === 'signed') update(checkpoint, 'unknown'); throw cause; }
    });
  });
}
export async function reconcileTaskLifecycle(client: AppClient, checkpoint: TaskLifecycleCheckpoint) {
  return locked(checkpoint.agent, async () => {
    const item = locate(checkpoint);
    if (!item.signature || !item.lastValidBlockHeight || !['signed', 'unknown'].includes(item.state)) throw new Error('This lifecycle attempt has no unresolved signed transaction.');
    await verifyInstruction(item); const task = await load(client, item);
    const statuses = await client.rpc.getSignatureStatuses([signature(item.signature)], { searchTransactionHistory: true }).send(), status = statuses.value[0];
    if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) {
      const tx = await client.rpc.getTransaction(signature(item.signature), { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }).send();
      if (!tx?.meta) throw new Error('Original Task transaction is unavailable. Keep its checkpoint.');
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const matches = tx.transaction.message.instructions.some(ix => keys[ix.programIdIndex] === PROGRAM_ADDRESS && hex(new Uint8Array(getBase58Encoder().encode(ix.data))) === item.instruction.data && ix.accounts.length === item.instruction.accounts.length && ix.accounts.every((index, at) => keys[index] === item.instruction.accounts[at].address) && ix.accounts[0] < tx.transaction.message.header.numRequiredSignatures);
      if (tx.transaction.signatures[0] !== item.signature || keys[0] !== item.owner || !matches) throw new Error('Original transaction differs from the lifecycle instruction or Owner.');
      if (status.err === null && tx.meta.err === null) {
        if (!task || ['failed', 'cancelled'].includes(item.next ?? '') && task.status !== item.next || item.next === 'completed' && (task.status !== 'completed' || task.resultHash !== hex(await hash(item.resultText!)))) throw new Error('Task outcome does not match its immutable commitment.');
        // Running/paused/Session outcomes may have legitimately changed again.
        update(checkpoint, 'confirmed'); return;
      }
      if (status.confirmationStatus === 'finalized' && status.err !== null && tx.meta.err !== null) { update(checkpoint, 'failed'); return; }
    }
    if (!status && item.action === 'create' && !task && await client.rpc.getBlockHeight({ commitment: 'finalized' }).send() > BigInt(item.lastValidBlockHeight)) { update(checkpoint, 'failed'); return; }
    throw new Error('Lifecycle signature remains unresolved. No transaction was retried; mutable status and Session changes require the original transaction.');
  });
}
export function exportTaskLifecycle(agent: string) { return JSON.stringify({ format: 'agentos-task-lifecycle', version: 1, programId: PROGRAM_ADDRESS, network: NETWORK_STORAGE, agent, records: readTaskLifecycle(agent) }); }
export async function importTaskLifecycle(client: AppClient, agent: string, text: string) {
  if (text.length > 500000) throw new Error('Task lifecycle backup exceeds 500 KB.');
  const backup = JSON.parse(text);
  if (backup?.format !== 'agentos-task-lifecycle' || backup.version !== 1 || backup.programId !== PROGRAM_ADDRESS || backup.network !== NETWORK_STORAGE || backup.agent !== agent) throw new Error('Lifecycle backup belongs to another Agent, Program or network.');
  const imported = validate(backup.records, agent);
  for (const item of imported) { await verifyInstruction(item); await load(client, item); }
  return locked(agent, async () => {
    const records = readTaskLifecycle(agent);
    for (const item of imported) {
      const old = records.find(record => record.id === item.id);
      const identity = (record: TaskLifecycleAttempt) => { const { state: _state, signature: _signature, lastValidBlockHeight: _height, updatedAt: _updatedAt, ...rest } = record; return JSON.stringify(rest); };
      if (old) {
        if (identity(old) !== identity(item) || old.signature && item.signature && (old.signature !== item.signature || old.lastValidBlockHeight !== item.lastValidBlockHeight)) throw new Error('Imported lifecycle attempt conflicts with the local review.');
        if (!old.signature && item.signature) { if (old.state !== 'prepared') throw new Error('Imported signature conflicts with a discarded local review.'); Object.assign(old, { signature: item.signature, lastValidBlockHeight: item.lastValidBlockHeight, state: 'unknown', updatedAt: new Date().toISOString() }); }
      } else records.push({ ...item, state: item.signature ? 'unknown' : 'prepared' });
    }
    write(agent, records);
  });
}
