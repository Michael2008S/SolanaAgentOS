import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  compileTransaction,
  getBase64Decoder,
  type TransactionMessageBytesBase64,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import type { AppClient } from '../providers';

/** Quote the exact message shape used by the Session sender without signing. */
export async function quoteSessionNetworkFee(client: AppClient, instruction: Instruction, signer: KeyPairSigner): Promise<bigint> {
  const { value: lifetime } = await client.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = appendTransactionMessageInstructions([instruction], setTransactionMessageLifetimeUsingBlockhash(lifetime,
    setTransactionMessageFeePayerSigner(signer, createTransactionMessage({ version: 0 }))));
  const fee = await client.rpc.getFeeForMessage(getBase64Decoder().decode(compileTransaction(message).messageBytes) as TransactionMessageBytesBase64, { commitment: 'confirmed' }).send();
  if (fee.value === null) throw new Error('The Session network fee cannot be quoted.');
  return fee.value;
}

/** Sends one reviewed transaction with the opted-in Session key paying its fee. */
export async function sendSessionSponsoredTransaction(
  client: AppClient,
  instruction: Instruction,
  signer: KeyPairSigner,
  onSigned?: (signature: string, lastValidBlockHeight: string) => void,
  safeguards?: { maxFeeLamports?: bigint; assertAuthorized: () => Promise<void> },
): Promise<string> {
  const { value: lifetime } = await client.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = appendTransactionMessageInstructions(
    [instruction],
    setTransactionMessageLifetimeUsingBlockhash(
      lifetime,
      setTransactionMessageFeePayerSigner(
        signer,
        createTransactionMessage({ version: 0 }),
      ),
    ),
  );
  if (safeguards?.maxFeeLamports !== undefined) {
    const fee = await client.rpc.getFeeForMessage(getBase64Decoder().decode(compileTransaction(message).messageBytes) as TransactionMessageBytesBase64, { commitment: 'confirmed' }).send();
    if (fee.value === null || fee.value > safeguards.maxFeeLamports) throw new Error('The Session network fee exceeds its reviewed ceiling or cannot be quoted.');
  }
  await safeguards?.assertAuthorized();
  const transaction = await signTransactionMessageWithSigners(message);
  onSigned?.(String(getSignatureFromTransaction(transaction)), lifetime.lastValidBlockHeight.toString());
  const simulation = await client.rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }).send();
  if (simulation.value.err !== null) throw new Error(`The Session transaction simulation failed (${JSON.stringify(simulation.value.err)}). No transaction was sent.`);
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc: client.rpc,
    rpcSubscriptions: client.rpcSubscriptions,
  });
  // The builder above always sets a blockhash lifetime. Kit's signer type widens
  // that lifetime to a blockhash-or-nonce union, while this confirmation helper
  // accepts only the blockhash branch.
  await safeguards?.assertAuthorized();
  await sendAndConfirm(transaction as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' });
  return String(getSignatureFromTransaction(transaction));
}
