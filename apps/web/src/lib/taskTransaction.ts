import { getBase58Encoder, signature as solanaSignature, assertIsFullySignedTransaction, getBase64EncodedWireTransaction, getSignatureFromTransaction, sendAndConfirmTransactionFactory, type Instruction, type KeyPairSigner } from '@solana/kit';
import type { AppClient } from '../providers';
import { PROGRAM_ADDRESS } from './agentOs';
import { assertTaskPaymentUnsent, loadTaskPaymentProof } from './taskPaymentProof';
import { sendSessionSponsoredTransaction } from './sessionSponsoredTransaction';
import { readTaskJournal, taskPaymentReview, updateTaskCheckpoint, type TaskCheckpoint } from './taskJournal';
import { assertPlannedTaskAction } from './taskPlanAuthorization';

/** Persists the signature before broadcast. Recovery never silently sends again. */
export async function sendCheckpointedTransaction(client: AppClient, instruction: Instruction, checkpoint: TaskCheckpoint, signer?: KeyPairSigner): Promise<string> {
  if (!navigator.locks) throw new Error('This browser must support transaction coordination locks to send Task payments.');
  return navigator.locks.request(`agentos:task-send:${checkpoint.agent}:${checkpoint.taskId}`, async () => sendLocked(client, instruction, checkpoint, signer));
}

async function sendLocked(client: AppClient, instruction: Instruction, checkpoint: TaskCheckpoint, signer?: KeyPairSigner): Promise<string> {
  const saved = readTaskJournal(checkpoint.agent).find((record) => record.taskId === checkpoint.taskId && record.actionId === checkpoint.actionId);
  if (!saved || saved.state !== 'prepared' || saved.signature) throw new Error('This Task action was already signed or its review was discarded. Check its saved transaction before continuing.');
  if (!saved.review || JSON.stringify(saved.review) !== JSON.stringify(taskPaymentReview(instruction))) throw new Error('Task payment instruction differs from its saved review. Discard legacy unsent reviews before preparing a new one.');
  await assertTaskPaymentUnsent(client, saved);
  await assertPlannedTaskAction(client, saved);
  let current = saved;
  const onSigned = (signature: string, lastValidBlockHeight: string) => { current = updateTaskCheckpoint(current, { state: 'signed', signature, lastValidBlockHeight }); };
  try {
    let signature: string;
    if (signer) {
      if (signer.address !== saved.review.feePayer) throw new Error('Task payment fee sponsor changed.');
      signature = await sendSessionSponsoredTransaction(client, instruction, signer, onSigned, { maxFeeLamports: 10000n, assertAuthorized: async () => { await assertTaskPaymentUnsent(client, saved); await assertPlannedTaskAction(client, saved); } });
    }
    else {
      const result = await client.signTransaction([instruction]);
      const transaction = result.context.transaction;
      assertIsFullySignedTransaction(transaction);
      if (result.context.message.feePayer.address !== saved.review.feePayer) throw new Error('Task payment wallet fee payer changed.');
      onSigned(String(getSignatureFromTransaction(transaction)), result.context.message.lifetimeConstraint.lastValidBlockHeight.toString());
      await assertPlannedTaskAction(client, saved);
      const simulation = await client.rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }).send();
      if (simulation.value.err !== null) throw new Error('Task transaction simulation failed. No transaction was sent.');
      await assertTaskPaymentUnsent(client, saved);
      const send = sendAndConfirmTransactionFactory({ rpc: client.rpc, rpcSubscriptions: client.rpcSubscriptions });
      await send(transaction as Parameters<typeof send>[0], { commitment: 'confirmed' });
      signature = String(getSignatureFromTransaction(transaction));
    }
    updateTaskCheckpoint(current, { state: 'confirmed' });
    return signature;
  } catch (cause) {
    if (current.signature) updateTaskCheckpoint(current, { state: 'unknown' });
    throw cause;
  }
}

/** Original signature + exact reviewed instruction + canonical accounting evidence. */
export async function reconcileCheckpointedTransaction(client: AppClient, checkpoint: TaskCheckpoint) {
  if (!navigator.locks) throw new Error('Task recovery requires browser coordination locks.');
  return navigator.locks.request(`agentos:task-send:${checkpoint.agent}:${checkpoint.taskId}`, async () => {
    const item = readTaskJournal(checkpoint.agent).find(record => record.taskId === checkpoint.taskId && record.actionId === checkpoint.actionId);
    if (!item?.signature || !item.lastValidBlockHeight || !['signed', 'unknown'].includes(item.state)) throw new Error('This Task action has no unresolved signed transaction.');
    const live = await loadTaskPaymentProof(client, item, true);
    const statuses = await client.rpc.getSignatureStatuses([solanaSignature(item.signature)], { searchTransactionHistory: true }).send();
    const status = statuses.value[0];
    if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) {
      const tx = await client.rpc.getTransaction(solanaSignature(item.signature), { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }).send();
      if (!tx?.meta) throw new Error('Original payment transaction is unavailable. Keep its checkpoint.');
      const message = tx.transaction.message;
      const keys = [...message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const reviewed = item.review!;
      const matches = message.instructions.some(ix => keys[ix.programIdIndex] === PROGRAM_ADDRESS && [...getBase58Encoder().encode(ix.data)].map(byte => byte.toString(16).padStart(2, '0')).join('') === reviewed.data && ix.accounts.length === reviewed.accounts.length && ix.accounts.every((index, at) => keys[index] === reviewed.accounts[at].address) && [0, 1].every(at => ix.accounts[at] >= 0 && ix.accounts[at] < message.header.numRequiredSignatures));
      if (tx.transaction.signatures[0] !== item.signature || keys[0] !== reviewed.feePayer || !matches) throw new Error('Signature does not contain the exact reviewed payment, accounts and fee payer.');
      if (status.err === null && tx.meta.err === null) {
        const proof = await loadTaskPaymentProof(client, item);
        if (!proof.receipt || !proof.execution) throw new Error('Original successful payment lacks matching TaskAction and Execution.');
        updateTaskCheckpoint(item, { state: 'confirmed' }); return;
      }
      if (status.confirmationStatus === 'finalized' && status.err !== null && tx.meta.err !== null && !live.receipt) { updateTaskCheckpoint(item, { state: 'failed' }); return; }
    }
    const outcome = !status && !live.receipt ? await loadTaskPaymentProof(client, item) : null;
    if (!status && outcome && !outcome.receipt && !outcome.execution && !outcome.escrow && !outcome.link && await client.rpc.getBlockHeight({ commitment: 'finalized' }).send() > BigInt(item.lastValidBlockHeight)) { updateTaskCheckpoint(item, { state: 'failed' }); return; }
    throw new Error('Payment remains unresolved. Keep its checkpoint; no transaction was retried.');
  });
}
