import { ensureConfiguredNetwork } from './chainNetwork';
import { address, getAddressEncoder, getBase58Decoder, getBase58Encoder, getBase64Encoder, getProgramDerivedAddress, signature, assertIsFullySignedTransaction, getSignatureFromTransaction, getBase64EncodedWireTransaction, sendAndConfirmTransactionFactory, type Instruction, type KeyPairSigner } from '@solana/kit';
import type { AppClient } from '../providers';
import { assertPlannedTaskAction } from './taskPlanAuthorization';
import { PROGRAM_ADDRESS, deriveTaskAddress, deriveExecutionAddress } from './agentOs';
import { readTaskJournal, saveTaskCheckpoint, type SkillResultAttempt } from './taskJournal';
import { sendSessionSponsoredTransaction } from './sessionSponsoredTransaction';
export type SkillResultCheckpoint = { agent: string; execution: string; attemptId: string };
const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const locate = (agent: string, execution: string) => { const item = readTaskJournal(agent).find((record) => record.execution === execution && record.kind === 'skill'); if (!item?.skillResult) throw new Error('Restore the paid Skill response journal first.'); return item; };
async function locked<T>(agent: string, execution: string, fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('Skill result recovery requires browser coordination locks.');
  const item = locate(agent, execution);
  return navigator.locks.request(`agentos:task-send:${agent}:${item.taskId}`, fn);
}
function update(checkpoint: SkillResultCheckpoint, patch: Partial<Pick<SkillResultAttempt, 'state' | 'signature' | 'lastValidBlockHeight'>>, finalSignature?: string) {
  const item = locate(checkpoint.agent, checkpoint.execution);
  const attempts = item.skillResult!.attempts?.map((attempt) => attempt.id === checkpoint.attemptId ? { ...attempt, ...patch, updatedAt: new Date().toISOString() } : attempt);
  if (!attempts?.some((attempt) => attempt.id === checkpoint.attemptId)) throw new Error('Skill result attempt is missing.');
  saveTaskCheckpoint({ ...item, skillResult: { ...item.skillResult!, attempts, ...(finalSignature ? { resultSignature: finalSignature } : {}) }, updatedAt: new Date().toISOString() });
}
export async function prepareSkillResult(agent: string, execution: string, session: string, feePayer: string): Promise<SkillResultCheckpoint> {
  return locked(agent, execution, async () => {
    const item = locate(agent, execution);
    if (item.state !== 'confirmed' || !item.signature || await digest(item.skillResult!.content) !== item.skillResult!.outputHash) throw new Error('Skill payment or saved response cannot be verified.');
    if (item.skillResult!.resultSignature || item.skillResult!.attempts?.some((attempt) => !['failed', 'cancelled'].includes(attempt.state))) throw new Error('An existing result attempt must be checked before another registration.');
    const now = new Date().toISOString(); const attempt: SkillResultAttempt = { id: crypto.randomUUID(), session, feePayer, state: 'prepared', createdAt: now, updatedAt: now };
    saveTaskCheckpoint({ ...item, skillResult: { ...item.skillResult!, attempts: [...(item.skillResult!.attempts ?? []), attempt] }, updatedAt: now });
    return { agent, execution, attemptId: attempt.id };
  });
}
export async function discardSkillResult(checkpoint: SkillResultCheckpoint) {
  return locked(checkpoint.agent, checkpoint.execution, async () => {
    const attempt = locate(checkpoint.agent, checkpoint.execution).skillResult!.attempts?.find((item) => item.id === checkpoint.attemptId);
    if (attempt?.state === 'prepared' && !attempt.signature) update(checkpoint, { state: 'cancelled' });
  });
}
export async function sendSkillResult(client: AppClient, instruction: Instruction, checkpoint: SkillResultCheckpoint, signer?: KeyPairSigner) {
  return locked(checkpoint.agent, checkpoint.execution, async () => {
    const item = locate(checkpoint.agent, checkpoint.execution);
    const attempt = item.skillResult!.attempts?.find((value) => value.id === checkpoint.attemptId);
    if (!attempt || attempt.state !== 'prepared' || attempt.signature || await digest(item.skillResult!.content) !== item.skillResult!.outputHash) throw new Error('Skill result is already signed or its saved response changed.');
    const task = await deriveTaskAddress(address(item.agent), BigInt(item.taskId));
    const action = new Uint8Array(8); new DataView(action.buffer).setBigUint64(0, BigInt(item.actionId), true);
    const [receipt] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('task_action'), getAddressEncoder().encode(task), action] });
    const method = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global:record_task_skill_result'))).slice(0, 8);
    const bytes = instruction.data;
    if (instruction.programAddress !== PROGRAM_ADDRESS || instruction.accounts?.length !== 7 || instruction.accounts[1].address !== attempt.feePayer || instruction.accounts[2].address !== item.agent || instruction.accounts[3].address !== attempt.session || instruction.accounts[4].address !== item.execution || instruction.accounts[5].address !== task || instruction.accounts[6].address !== receipt || bytes?.length !== 40 || !method.every((byte, index) => bytes[index] === byte) || [...bytes.slice(8)].map((byte) => byte.toString(16).padStart(2, '0')).join('') !== item.skillResult!.outputHash) throw new Error('Result instruction differs from its saved review.');
    let savedSignature: string | undefined;
    const onSigned = (value: string, height: string) => { update(checkpoint, { state: 'signed', signature: value, lastValidBlockHeight: height }); savedSignature = value; };
    try {
      let result: string;
      if (signer) {
        if (signer.address !== attempt.feePayer) throw new Error('Result registration fee signer changed.');
        result = await sendSessionSponsoredTransaction(client, instruction, signer, onSigned, { maxFeeLamports: 10000n, assertAuthorized: () => assertPlannedTaskAction(client, item, true) });
      } else {
        const signed = await client.signTransaction([instruction]); const transaction = signed.context.transaction;
        assertIsFullySignedTransaction(transaction);
        if (signed.context.message.feePayer.address !== attempt.feePayer) throw new Error('The connected wallet fee payer changed. Prepare a new review.');
        onSigned(String(getSignatureFromTransaction(transaction)), signed.context.message.lifetimeConstraint.lastValidBlockHeight.toString());
        const simulation = await client.rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }).send();
        if (simulation.value.err !== null) throw new Error('Skill result simulation failed; no transaction was sent.');
        const send = sendAndConfirmTransactionFactory({ rpc: client.rpc, rpcSubscriptions: client.rpcSubscriptions });
        await send(transaction as Parameters<typeof send>[0], { commitment: 'confirmed' }); result = String(getSignatureFromTransaction(transaction));
      }
      update(checkpoint, { state: 'confirmed' }, result); return result;
    } catch (error) { if (savedSignature) update(checkpoint, { state: 'unknown' }); throw error; }
  });
}
export async function reconcileSkillResult(client: AppClient, checkpoint: SkillResultCheckpoint) {
  return locked(checkpoint.agent, checkpoint.execution, async () => {
    await ensureConfiguredNetwork(client);
    const item = locate(checkpoint.agent, checkpoint.execution);
    const attempt = item.skillResult!.attempts?.find((value) => value.id === checkpoint.attemptId);
    if (!attempt?.signature || !attempt.lastValidBlockHeight || !['signed', 'unknown'].includes(attempt.state)) throw new Error('This result attempt has no unresolved signed transaction.');
    if (await digest(item.skillResult!.content) !== item.skillResult!.outputHash) throw new Error('Saved response differs from its output commitment.');
    const [statuses, account] = await Promise.all([client.rpc.getSignatureStatuses([signature(attempt.signature)], { searchTransactionHistory: true }).send(), client.rpc.getAccountInfo(address(item.execution), { commitment: 'confirmed', encoding: 'base64' }).send()]);
    if (!account.value || account.value.owner !== PROGRAM_ADDRESS) throw new Error('Execution is missing or belongs to a different Program.');
    const data = new Uint8Array(getBase64Encoder().encode(account.value.data[0]));
    const disc = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account:Execution'))).slice(0, 8);
    if (data.length !== 132 || data[98] <= 1 && data[data[98] === 1 ? 131 : 99] !== 0 || data[49] !== 3 || data[98] > 1 || disc.some((byte, index) => data[index] !== byte) || getBase58Decoder().decode(data.slice(8, 40)) !== item.agent || await deriveExecutionAddress(address(item.agent), new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(40, true)) !== item.execution || new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(50, true).toString() !== item.amount || data[48] !== (item.asset === 'SOL' ? 0 : 1) || [...data.slice(66, 98)].map((byte) => byte.toString(16).padStart(2, '0')).join('') !== item.inputHash) throw new Error('Execution does not match the saved Task Skill payment.');
    const chainHash = data[98] === 1 ? [...data.slice(99, 131)].map((byte) => byte.toString(16).padStart(2, '0')).join('') : null;
    const status = statuses.value[0];
    if (status && status.err === null && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? '') && chainHash === item.skillResult!.outputHash && data[131] === 0) {
      const tx = await client.rpc.getTransaction(signature(attempt.signature), { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }).send();
      if (!tx || tx.meta?.err !== null) throw new Error('Original result transaction is unavailable.');
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const method = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global:record_task_skill_result'))).slice(0, 8);
      const task = await deriveTaskAddress(address(item.agent), BigInt(item.taskId));
      const action = new Uint8Array(8); new DataView(action.buffer).setBigUint64(0, BigInt(item.actionId), true);
      const [receipt] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('task_action'), getAddressEncoder().encode(task), action] });
      const matched = tx.transaction.message.instructions.some((instruction) => {
        const bytes = new Uint8Array(getBase58Encoder().encode(instruction.data));
        return keys[instruction.programIdIndex] === PROGRAM_ADDRESS && keys[instruction.accounts[1]] === attempt.feePayer && keys[instruction.accounts[2]] === item.agent && keys[instruction.accounts[3]] === attempt.session && keys[instruction.accounts[4]] === item.execution && keys[instruction.accounts[5]] === task && keys[instruction.accounts[6]] === receipt && bytes.length === 40 && method.every((byte, index) => bytes[index] === byte) && [...bytes.slice(8)].map((byte) => byte.toString(16).padStart(2, '0')).join('') === item.skillResult!.outputHash;
      });
      if (!matched || keys[0] !== attempt.feePayer) throw new Error('Saved signature does not contain this exact Task Skill result registration.');
      update(checkpoint, { state: 'confirmed' }, attempt.signature); return;
    }
    if (status?.confirmationStatus === 'finalized' && status.err !== null && chainHash === null) { update(checkpoint, { state: 'failed' }); return; }
    if (!status && chainHash === null && await client.rpc.getBlockHeight({ commitment: 'finalized' }).send() > BigInt(attempt.lastValidBlockHeight)) { update(checkpoint, { state: 'failed' }); return; }
    throw new Error('Result transaction is unresolved; no registration was retried.');
  });
}
