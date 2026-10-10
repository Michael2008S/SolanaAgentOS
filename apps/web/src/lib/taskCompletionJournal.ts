import { address, assertIsFullySignedTransaction, getAddressDecoder, getAddressEncoder, getBase58Encoder, getBase64EncodedWireTransaction, getProgramDerivedAddress, getSignatureFromTransaction, sendAndConfirmTransactionFactory, signature, type Base58EncodedBytes, type Instruction, type KeyPairSigner } from '@solana/kit';
import type { AppClient } from '../providers';
import { NETWORK_STORAGE, ensureConfiguredNetwork } from './chainNetwork';
import { buildCompleteSessionTask, buildGrantTaskCompletion, buildRevokeTaskCompletion, deriveTaskAddress, deriveTaskCompletionAddress, PROGRAM_ADDRESS } from './agentOs';
import { decodeChainTask, decodeTaskCompletion, type ChainTask } from './taskClient';
import { readTaskProofAccount } from './taskPaymentProof';
import { inspectTaskPlan } from './taskPlanEvidence';
import { readTaskPlans, taskDigest, validateTaskPlan, verifyTaskPlan, type TaskPlan } from './taskPlan';
import { readTaskLifecycle } from './taskLifecycle';
import { sendSessionSponsoredTransaction } from './sessionSponsoredTransaction';

type State = 'prepared' | 'signed' | 'unknown' | 'confirmed' | 'failed' | 'cancelled';
export type TaskCompletionCheckpoint = { agent: string; id: string };
type SavedInstruction = { program: string; data: string; accounts: { address: string; role: number }[] };
export type TaskCompletionAttempt = {
  version: 1; id: string; action: 'grant' | 'revoke' | 'complete'; plan: TaskPlan;
  owner: string; feePayer: string; signer: string; expiresAt: number; startTask: boolean;
  spentSol: string; spentUsdc: string; artifact?: string; resultHash?: string;
  instruction: SavedInstruction; state: State; signature?: string; lastValidBlockHeight?: string;
  createdAt: string; updatedAt: string;
};
const transitions: Record<State, State[]> = { prepared: ['signed', 'cancelled'], signed: ['unknown', 'confirmed', 'failed'], unknown: ['confirmed', 'failed'], confirmed: [], failed: [], cancelled: [] };
const key = (agent: string) => `agentos:task-completion:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${agent}`;
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const hashBytes = (hash: string) => Uint8Array.from(hash.match(/../g)!, byte => parseInt(byte, 16));
const isU64 = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const serialize = (instruction: Instruction): SavedInstruction => ({ program: String(instruction.programAddress), data: hex(new Uint8Array(instruction.data ?? [])), accounts: (instruction.accounts ?? []).map(item => ({ address: String(item.address), role: item.role })) });
export function validateTaskCompletionJournal(values: unknown, agent: string): TaskCompletionAttempt[] {
  address(agent);
  if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid completion journal or its 100-attempt limit was exceeded.');
  const ids = new Set<string>();
  return values.map((value: TaskCompletionAttempt) => {
    const plan = validateTaskPlan(value?.plan);
    if (value.version !== 1 || !/^[0-9a-f-]{36}$/.test(value.id) || ids.has(value.id) || !['grant', 'revoke', 'complete'].includes(value.action) || plan.agent !== agent || plan.network !== NETWORK_STORAGE || !Object.hasOwn(transitions, value.state) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 || typeof value.startTask !== 'boolean' || !isU64(value.spentSol) || !isU64(value.spentUsdc) || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid completion attempt.');
    for (const publicKey of [value.owner, value.feePayer, value.signer]) address(publicKey);
    if (value.action === 'complete' ? typeof value.artifact !== 'string' || new TextEncoder().encode(value.artifact).length > 450000 || !/^[a-f0-9]{64}$/.test(value.resultHash ?? '') || value.startTask || value.feePayer !== value.signer : value.artifact !== undefined || value.resultHash !== undefined || value.feePayer !== value.owner || value.signer !== value.owner || value.action === 'revoke' && value.startTask) throw new Error('Invalid completion signing scope.');
    if (value.signature !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value.signature) || value.lastValidBlockHeight !== undefined && !isU64(value.lastValidBlockHeight) || ['signed', 'unknown', 'confirmed'].includes(value.state) && (!value.signature || !value.lastValidBlockHeight) || ['prepared', 'cancelled'].includes(value.state) && (value.signature !== undefined || value.lastValidBlockHeight !== undefined)) throw new Error('Invalid completion signature checkpoint.');
    const instruction = value.instruction;
    if (!instruction || instruction.program !== PROGRAM_ADDRESS || !/^[a-f0-9]{16,176}$/.test(instruction.data) || instruction.data.length % 2 || !Array.isArray(instruction.accounts) || instruction.accounts.length < 4 || instruction.accounts.length > 7) throw new Error('Invalid saved completion instruction.');
    for (const account of instruction.accounts) { address(account.address); if (![0, 1, 2, 3].includes(account.role)) throw new Error('Invalid completion account role.'); }
    ids.add(value.id);
    return { version: 1, id: value.id, action: value.action, plan, owner: value.owner, feePayer: value.feePayer, signer: value.signer, expiresAt: value.expiresAt, startTask: value.startTask, spentSol: value.spentSol, spentUsdc: value.spentUsdc, ...(value.artifact !== undefined ? { artifact: value.artifact, resultHash: value.resultHash } : {}), instruction: { program: instruction.program, data: instruction.data, accounts: instruction.accounts.map(account => ({ address: account.address, role: account.role })) }, state: value.state, ...(value.signature ? { signature: value.signature, lastValidBlockHeight: value.lastValidBlockHeight } : {}), createdAt: value.createdAt, updatedAt: value.updatedAt };
  });
}
export function readTaskCompletionJournal(agent: string): TaskCompletionAttempt[] {
  address(agent); const text = localStorage.getItem(key(agent));
  if (text && text.length > 2000000) throw new Error('Completion journal exceeds 2 MB. Export it before continuing.');
  return text ? validateTaskCompletionJournal(JSON.parse(text), agent) : [];
}
function write(agent: string, records: TaskCompletionAttempt[]) {
  const text = JSON.stringify(validateTaskCompletionJournal(records, agent));
  if (text.length > 2000000) throw new Error('Completion journal is full. Preserve its evidence before continuing.');
  localStorage.setItem(key(agent), text);
  if (JSON.stringify(readTaskCompletionJournal(agent)) !== text) throw new Error('Completion checkpoint persistence failed.');
}
function locate(checkpoint: TaskCompletionCheckpoint) {
  const item = readTaskCompletionJournal(checkpoint.agent).find(item => item.id === checkpoint.id);
  if (!item) throw new Error('Restore the missing completion checkpoint before continuing.');
  return item;
}
function update(checkpoint: TaskCompletionCheckpoint, state: State, signed?: { signature: string; lastValidBlockHeight: string }) {
  const records = readTaskCompletionJournal(checkpoint.agent), index = records.findIndex(item => item.id === checkpoint.id), item = records[index];
  if (!item || !transitions[item.state].includes(state) || item.signature && signed && (item.signature !== signed.signature || item.lastValidBlockHeight !== signed.lastValidBlockHeight)) throw new Error('A completion attempt cannot reopen or change its signature.');
  records[index] = { ...item, ...signed, state, updatedAt: new Date().toISOString() }; write(checkpoint.agent, records);
}
async function locked<T>(agent: string, taskId: string, operation: () => Promise<T>) {
  if (!navigator.locks) throw new Error('Completion transactions require browser coordination locks.');
  return navigator.locks.request(`agentos:completion-journal:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${agent}`, () => navigator.locks.request(`agentos:task-send:${agent}:${taskId}`, operation));
}

export async function loadTaskCompletionState(client: AppClient, plan: TaskPlan) {
  await ensureConfiguredNetwork(client); await verifyTaskPlan(plan);
  if (await deriveTaskAddress(address(plan.agent), BigInt(plan.taskId)) !== plan.task) throw new Error('The planned Task PDA is not canonical.');
  const bytes = (await readTaskProofAccount(client, plan.task, 'Task', 227))!;
  const task = await decodeChainTask(plan.task, bytes, plan.agent);
  if (task.taskHash !== plan.taskHash || task.session !== plan.session || task.id !== plan.taskId) throw new Error('Task commitment or bound Session changed since planning.');
  const permitAddress = await deriveTaskCompletionAddress(address(plan.task));
  const permitBytes = await readTaskProofAccount(client, permitAddress, 'TaskCompletionPermit', 155, true);
  const permit = permitBytes ? await decodeTaskCompletion(permitAddress, permitBytes, task) : null;
  return { task, permit };
}
export function assertCompletionPermit(plan: TaskPlan, task: ChainTask, permit: Awaited<ReturnType<typeof loadTaskCompletionState>>['permit'], now = Math.floor(Date.now() / 1000)) {
  if (!permit || task.address !== plan.task || task.agent !== plan.agent || task.session !== plan.session || task.taskHash !== plan.taskHash || permit.task !== plan.task || permit.agent !== plan.agent || permit.session !== plan.session || permit.planHash !== plan.planHash || permit.expectedActions !== String(plan.actions.length) || permit.revoked || permit.used || permit.expiresAt <= now || task.deadline <= now || task.status !== 'running') throw new Error('Task completion authorization is absent, mismatched, paused, used, revoked or expired.');
}
async function instructionFor(item: TaskCompletionAttempt, signer?: KeyPairSigner): Promise<Instruction> {
  if (item.action === 'grant') return (await buildGrantTaskCompletion(address(item.owner), address(item.plan.agent), address(item.plan.session), BigInt(item.plan.taskId), hashBytes(item.plan.planHash), BigInt(item.plan.actions.length), BigInt(item.expiresAt), item.startTask)).instruction;
  if (item.action === 'revoke') return (await buildRevokeTaskCompletion(address(item.owner), address(item.plan.agent), BigInt(item.plan.taskId))).instruction;
  return (await buildCompleteSessionTask({ agent: address(item.plan.agent), session: address(item.plan.session), sessionSigner: signer ?? { address: address(item.signer) } as KeyPairSigner, taskId: BigInt(item.plan.taskId), planHash: hashBytes(item.plan.planHash), resultHash: hashBytes(item.resultHash!), spentSol: BigInt(item.spentSol), spentUsdc: BigInt(item.spentUsdc) })).instruction;
}
async function verifyInstruction(item: TaskCompletionAttempt) {
  await verifyTaskPlan(item.plan);
  if (item.artifact !== undefined && await taskDigest(item.artifact) !== item.resultHash || JSON.stringify(serialize(await instructionFor(item))) !== JSON.stringify(item.instruction)) throw new Error('Saved completion body or instruction differs from its commitments.');
}
async function assertEligible(client: AppClient, item: TaskCompletionAttempt) {
  await verifyInstruction(item);
  const { task, permit } = await loadTaskCompletionState(client, item.plan);
  const agent = (await readTaskProofAccount(client, item.plan.agent, 'Agent', 138))!;
  const [canonicalAgent, agentBump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('agent'), agent.slice(8, 40), agent.slice(40, 72)] });
  if (canonicalAgent !== item.plan.agent || agent[121] !== agentBump || getAddressDecoder().decode(agent.slice(8, 40)) !== item.owner) throw new Error('Completion Owner or Agent PDA changed.');
  if (item.action === 'revoke') { if (!permit) throw new Error('Completion permit is absent.'); return; }
  const session = (await readTaskProofAccount(client, item.plan.session, 'Session', 147))!;
  const [canonicalSession, sessionBump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('session'), getAddressEncoder().encode(address(item.plan.agent)), session.slice(40, 72)] });
  const signer = getAddressDecoder().decode(session.slice(40, 72)), now = Math.floor(Date.now() / 1000), view = new DataView(session.buffer, session.byteOffset, session.byteLength);
  const [policyAddress, policyBump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('policy'), getAddressEncoder().encode(address(item.plan.agent))] });
  const policy = (await readTaskProofAccount(client, policyAddress, 'Policy', 123))!;
  if (agent[104] !== 0 || policy[73] !== 0 || policy[74] !== policyBump || getAddressDecoder().decode(policy.slice(8, 40)) !== item.plan.agent || session[105] !== 0 || canonicalSession !== item.plan.session || session[106] !== sessionBump || getAddressDecoder().decode(session.slice(8, 40)) !== item.plan.agent || view.getBigInt64(72, true) <= BigInt(now) || view.getBigUint64(107, true).toString() !== item.plan.taskId || new TextDecoder().decode(session.slice(115, 123)) !== 'AGTASK01') throw new Error('Completion Agent, Policy or bound Session is inactive, paused, revoked or invalid.');
  if (item.action === 'grant') {
    if (!['ready', 'running', 'paused'].includes(task.status) || item.startTask && task.status !== 'ready' || permit?.used || item.expiresAt <= now || item.expiresAt > task.deadline || BigInt(item.expiresAt) > view.getBigInt64(72, true) || BigInt(task.actionCount) > BigInt(item.plan.actions.length)) throw new Error('Completion grant terms no longer match the Task.');
    return;
  }
  assertCompletionPermit(item.plan, task, permit, now);
  if (signer !== item.signer || item.expiresAt !== permit!.expiresAt) throw new Error('Completion Session signer or deadline changed.');
  const savedPlan = readTaskPlans({ network: NETWORK_STORAGE, agent: item.plan.agent }).find(plan => plan.task === item.plan.task);
  if (!savedPlan || JSON.stringify(savedPlan) !== JSON.stringify(item.plan)) throw new Error('Restore the exact fixed plan and its original receipt bindings before completing.');
  const evidence = await inspectTaskPlan(client, item.plan, task);
  if (!evidence.ready || evidence.artifact !== item.artifact || evidence.resultHash !== item.resultHash || task.sol.spent !== item.spentSol || task.usdc.spent !== item.spentUsdc) throw new Error('Task evidence changed or is incomplete; completion was not sent.');
}
export async function prepareTaskCompletion(client: AppClient, input: { plan: TaskPlan; owner: string; action: 'grant' | 'revoke' | 'complete'; expiresAt: number; startTask?: boolean; signer?: KeyPairSigner; artifact?: string; resultHash?: string; spentSol?: string; spentUsdc?: string }) {
  return locked(input.plan.agent, input.plan.taskId, async () => {
    if (readTaskCompletionJournal(input.plan.agent).some(item => item.plan.task === input.plan.task && ['prepared', 'signed', 'unknown'].includes(item.state)) || readTaskLifecycle(input.plan.agent).some(item => item.task === input.plan.task && ['prepared', 'signed', 'unknown'].includes(item.state))) throw new Error('Check or discard the unresolved Task lifecycle or completion transaction before preparing another.');
    const now = new Date().toISOString(), feePayer = input.action === 'complete' ? String(input.signer?.address ?? '') : input.owner;
    const item: TaskCompletionAttempt = { version: 1, id: crypto.randomUUID(), action: input.action, plan: validateTaskPlan(input.plan), owner: input.owner, signer: feePayer, feePayer, expiresAt: input.expiresAt, startTask: input.startTask ?? false, spentSol: input.spentSol ?? '0', spentUsdc: input.spentUsdc ?? '0', ...(input.artifact === undefined ? {} : { artifact: input.artifact, resultHash: input.resultHash }), instruction: { program: PROGRAM_ADDRESS, data: '', accounts: [] }, state: 'prepared', createdAt: now, updatedAt: now };
    const instruction = await instructionFor(item, input.signer); item.instruction = serialize(instruction);
    validateTaskCompletionJournal([item], input.plan.agent); await assertEligible(client, item);
    write(input.plan.agent, [...readTaskCompletionJournal(input.plan.agent), item]);
    return { instruction, checkpoint: { agent: input.plan.agent, id: item.id } };
  });
}
export async function discardTaskCompletion(checkpoint: TaskCompletionCheckpoint) {
  const item = locate(checkpoint);
  return locked(checkpoint.agent, item.plan.taskId, async () => { const current = locate(checkpoint); if (current.state !== 'prepared' || current.signature) throw new Error('Signed completion attempts must be checked by their original signature.'); update(checkpoint, 'cancelled'); });
}
export async function sendTaskCompletion(client: AppClient, instruction: Instruction, checkpoint: TaskCompletionCheckpoint, sessionSigner?: KeyPairSigner, assertLocalAuthorization?: () => Promise<void>) {
  const original = locate(checkpoint);
  return locked(checkpoint.agent, original.plan.taskId, async () => {
    const item = locate(checkpoint);
    if (item.state !== 'prepared' || item.signature || JSON.stringify(serialize(instruction)) !== JSON.stringify(item.instruction)) throw new Error('Completion transaction is already signed, discarded or changed.');
    const check = async () => { await assertLocalAuthorization?.(); await assertEligible(client, item); };
    await check();
    try {
      let value: string;
      if (item.action === 'complete') {
        if (!sessionSigner || sessionSigner.address !== item.signer || !assertLocalAuthorization) throw new Error('Automatic completion needs the exact opted-in Session signer and fresh local authorization.');
        value = await sendSessionSponsoredTransaction(client, instruction, sessionSigner, (signature, lastValidBlockHeight) => update(checkpoint, 'signed', { signature, lastValidBlockHeight }), { maxFeeLamports: 10000n, assertAuthorized: check });
      } else {
        const signed = await client.signTransaction([instruction]), transaction = signed.context.transaction;
        assertIsFullySignedTransaction(transaction);
        if (signed.context.message.feePayer.address !== item.owner) throw new Error('Connected Owner wallet changed.');
        value = String(getSignatureFromTransaction(transaction));
        update(checkpoint, 'signed', { signature: value, lastValidBlockHeight: signed.context.message.lifetimeConstraint.lastValidBlockHeight.toString() });
        await check();
        const simulation = await client.rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }).send();
        if (simulation.value.err !== null) throw new Error('Task completion authorization simulation failed. No transaction was sent.');
        const send = sendAndConfirmTransactionFactory({ rpc: client.rpc, rpcSubscriptions: client.rpcSubscriptions });
        await check(); await send(transaction as Parameters<typeof send>[0], { commitment: 'confirmed' });
      }
      update(checkpoint, 'confirmed'); return value;
    } catch (cause) { if (locate(checkpoint).state === 'signed') update(checkpoint, 'unknown'); throw cause; }
  });
}
export async function reconcileTaskCompletion(client: AppClient, checkpoint: TaskCompletionCheckpoint) {
  const initial = locate(checkpoint);
  return locked(checkpoint.agent, initial.plan.taskId, async () => {
    const item = locate(checkpoint); await verifyInstruction(item);
    if (!item.signature || !item.lastValidBlockHeight || !['signed', 'unknown'].includes(item.state)) throw new Error('There is no unresolved completion signature to check.');
    await ensureConfiguredNetwork(client);
    const status = (await client.rpc.getSignatureStatuses([signature(item.signature)], { searchTransactionHistory: true }).send()).value[0];
    if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) {
      const tx = await client.rpc.getTransaction(signature(item.signature), { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }).send();
      if (!tx?.meta) throw new Error('Original completion transaction is unavailable; keep its checkpoint.');
      const message = tx.transaction.message, keys = [...message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const exact = message.instructions.some((ix: { programIdIndex: number; data: Base58EncodedBytes; accounts: readonly number[] }) => keys[ix.programIdIndex] === PROGRAM_ADDRESS && hex(new Uint8Array(getBase58Encoder().encode(ix.data))) === item.instruction.data && ix.accounts.length === item.instruction.accounts.length && ix.accounts.every((index, at) => keys[index] === item.instruction.accounts[at].address) && ix.accounts[0] >= 0 && ix.accounts[0] < message.header.numRequiredSignatures);
      if (!exact || keys[0] !== item.feePayer || tx.transaction.signatures[0] !== item.signature) throw new Error('Original completion transaction differs from its exact instruction or signer.');
      if (status.err === null && tx.meta.err === null) {
        if (item.action === 'complete') {
          const live = await loadTaskCompletionState(client, item.plan);
          if (live.task.status !== 'completed' || live.task.resultHash !== item.resultHash || !live.permit?.used || live.permit.planHash !== item.plan.planHash || live.permit.session !== item.plan.session) throw new Error('Completed Task does not match the original result commitment and consumed permit.');
        }
        // Grant/revoke may legitimately be superseded later. The original exact
        // successful transaction is authoritative, not today's mutable flag.
        update(checkpoint, 'confirmed'); return;
      }
      if (status.confirmationStatus === 'finalized' && status.err !== null && tx.meta.err !== null) { update(checkpoint, 'failed'); return; }
    }
    // Mutable permits cannot establish that a missing signature never landed.
    // Keep unresolved attempts until their original transaction can be checked.
    throw new Error('Completion signature remains unresolved. No transaction was repeated.');
  });
}
export function exportTaskCompletionJournal(agent: string) { return JSON.stringify({ format: 'agentos-task-completion', version: 1, network: NETWORK_STORAGE, programId: PROGRAM_ADDRESS, agent, records: readTaskCompletionJournal(agent) }); }
export async function importTaskCompletionJournal(agent: string, text: string) {
  if (text.length > 2000000) throw new Error('Completion backup exceeds 2 MB.');
  const backup = JSON.parse(text);
  if (backup?.format !== 'agentos-task-completion' || backup.version !== 1 || backup.network !== NETWORK_STORAGE || backup.programId !== PROGRAM_ADDRESS || backup.agent !== agent) throw new Error('Completion backup belongs to another network, Program or Agent.');
  const incoming = validateTaskCompletionJournal(backup.records, agent);
  for (const item of incoming) await verifyInstruction(item);
  // Import only merges evidence. It never grants local automatic execution.
  if (!navigator.locks) throw new Error('Completion backup restore requires browser coordination locks.');
  return navigator.locks.request(`agentos:completion-journal:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${agent}`, async () => {
    const records = readTaskCompletionJournal(agent);
    const identity = (item: TaskCompletionAttempt) => { const { state: _state, signature: _sig, lastValidBlockHeight: _height, updatedAt: _updated, ...rest } = item; return JSON.stringify(rest); };
    for (const item of incoming) {
      const previous = records.find(record => record.id === item.id);
      if (previous) {
        if (identity(previous) !== identity(item) || previous.signature && item.signature && (previous.signature !== item.signature || previous.lastValidBlockHeight !== item.lastValidBlockHeight)) throw new Error('Imported completion evidence conflicts with the local attempt.');
        if (!previous.signature && item.signature) { if (previous.state !== 'prepared') throw new Error('Imported signature conflicts with a discarded attempt.'); Object.assign(previous, { signature: item.signature, lastValidBlockHeight: item.lastValidBlockHeight, state: 'unknown', updatedAt: new Date().toISOString() }); }
      } else records.push({ ...item, state: item.signature ? 'unknown' : 'prepared' });
    }
    write(agent, records);
  });
}
