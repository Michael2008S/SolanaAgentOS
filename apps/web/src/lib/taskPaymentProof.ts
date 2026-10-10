import { ensureConfiguredNetwork } from './chainNetwork';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { AppClient } from '../providers';
import { deriveEscrowAddress, deriveExecutionAddress, deriveTaskAddress, deriveTaskEscrowAddress, deriveUsdcTokenAddress, DEVNET_USDC_MINT, PROGRAM_ADDRESS } from './agentOs';
import { decodeChainTask } from './taskClient';
import type { TaskCheckpoint } from './taskJournal';
const utf8 = (value: string) => new TextEncoder().encode(value);
const encode = (key: string) => getAddressEncoder().encode(address(key));
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text)));
const keyAt = (bytes: Uint8Array, at: number) => getAddressDecoder().decode(bytes.slice(at, at + 32));
const u64 = (value: string) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true); return bytes; };
export async function readTaskProofAccount(client: AppClient, key: string, kind: string, length: number, optional = false) {
  const result = await client.rpc.getAccountInfo(address(key), { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!result.value && optional) return null;
  if (!result.value || result.value.owner !== PROGRAM_ADDRESS || result.value.data[1] !== 'base64') throw new Error(`${kind} is absent or has a different owner.`);
  const bytes = Uint8Array.from(atob(result.value.data[0]), char => char.charCodeAt(0));
  const disc = (await digest(`account:${kind}`)).slice(0, 8);
  if (bytes.length !== length || disc.some((byte, index) => bytes[index] !== byte)) throw new Error(`${kind} has an invalid layout.`);
  return bytes;
}
/** Bind saved review to canonical task accounting; no keys or requests are restored. */
export async function verifyTaskPaymentReview(item: TaskCheckpoint) {
  const review = item.review;
  if (!review) throw new Error('This legacy checkpoint has no complete payment review. Keep it for manual transaction verification; it cannot be replayed or automatically confirmed.');
  const data = Uint8Array.from(review.data.match(/../g) ?? [], pair => parseInt(pair, 16));
  const view = new DataView(data.buffer), usdc = item.asset === 'USDC';
  const specification = item.kind === 'payment'
    ? { method: usdc ? 'execute_task_usdc_payment' : 'execute_task_payment', length: 96, count: usdc ? 15 : 11, execution: usdc ? 9 : 7, task: usdc ? 13 : 9, hash: 16, executionId: 80, actionId: 88 }
    : item.kind === 'skill'
    ? { method: usdc ? 'pay_task_usdc_skill' : 'pay_task_skill', length: 64, count: usdc ? 16 : 12, execution: usdc ? 10 : 8, task: usdc ? 14 : 10, hash: 16, executionId: 48, actionId: 56 }
    : { method: usdc ? 'create_task_usdc_escrow' : 'create_task_escrow', length: 80, count: usdc ? 17 : 13, execution: usdc ? 10 : 8, task: usdc ? 14 : 10, hash: 32, executionId: 64, actionId: 72 };
  const disc = (await digest(`global:${specification.method}`)).slice(0, 8);
  if (review.program !== PROGRAM_ADDRESS || data.length !== specification.length || disc.some((byte, index) => byte !== data[index]) || view.getBigUint64(8, true).toString() !== item.amount || hex(data.slice(specification.hash, specification.hash + 32)) !== item.inputHash || view.getBigUint64(specification.actionId, true).toString() !== item.actionId || review.accounts.length !== specification.count || review.accounts[1].address !== review.feePayer || review.accounts[2].address !== item.agent || ![2, 3].includes(review.accounts[0].role) || review.accounts[1].role !== 3) throw new Error('Task payment data, amount or signer accounts differ from the saved checkpoint.');
  const executionId = view.getBigUint64(specification.executionId, true), task = await deriveTaskAddress(address(item.agent), BigInt(item.taskId));
  const [receipt, receiptBump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('task_action'), encode(task), u64(item.actionId)] });
  const [policy] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('policy'), encode(item.agent)] });
  if (await deriveExecutionAddress(address(item.agent), executionId) !== item.execution || review.accounts[specification.execution].address !== item.execution || review.accounts[specification.task].address !== task || review.accounts[specification.task + 1].address !== receipt || review.accounts[3].address !== policy) throw new Error('Task payment PDA bindings differ from its review.');
  const accounts = review.accounts;
  if (usdc) {
    if (accounts[5].address !== DEVNET_USDC_MINT || accounts[6].address !== await deriveUsdcTokenAddress(address(item.agent))) throw new Error('Task payment Mint or source ATA differs.');
  } else {
    const [vault] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('vault'), encode(item.agent)] });
    if (accounts[5].address !== vault) throw new Error('Task payment Vault is not canonical.');
  }
  if (usdc) {
    const base = item.kind === 'payment' ? 10 : 11;
    if (accounts[base].address !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || accounts[base + 1].address !== 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' || accounts[base + 2].address !== '11111111111111111111111111111111') throw new Error('Task payment token or system programs differ.');
  } else if (accounts[specification.task - 1].address !== '11111111111111111111111111111111') throw new Error('Task payment system program differs.');
  if (usdc && item.kind !== 'payment' && accounts[9].address !== await deriveUsdcTokenAddress(address(accounts[8].address))) throw new Error('Provider or Escrow destination ATA differs.');
  if (item.kind === 'payment' && usdc && accounts[8].address !== await deriveUsdcTokenAddress(address(accounts[7].address))) throw new Error('Task recipient ATA differs.');
  if (item.kind === 'skill' && item.skillRequest) {
    if (accounts[usdc ? 7 : 6].address !== item.skillRequest.skill || accounts[usdc ? 8 : 7].address !== item.skillRequest.provider || hex(await digest(JSON.stringify({ skill: item.skillRequest.skill, prompt: item.skillRequest.prompt }))) !== item.inputHash) throw new Error('Saved Skill request differs from the reviewed provider or input hash.');
  }
  if (item.kind === 'escrow') {
    const saved = item.escrowTask;
    if (!saved || saved.id !== view.getBigUint64(16, true).toString() || BigInt(saved.deadline) !== view.getBigInt64(24, true) || hex(await digest(saved.task.trim())) !== item.inputHash || await deriveEscrowAddress(address(item.agent), BigInt(saved.id)) !== saved.address || accounts[usdc ? 7 : 6].address !== saved.workerAgent || accounts[usdc ? 8 : 7].address !== saved.address || accounts[specification.task + 2].address !== await deriveTaskEscrowAddress(address(saved.address))) throw new Error('Saved Worker Escrow differs from the original review.');
  }
  return { task, receipt, receiptBump, executionId, data, specification, session: accounts[4].address, signer: accounts[0].address };
}
export async function loadTaskPaymentProof(client: AppClient, item: TaskCheckpoint, receiptOnly = false) {
  await ensureConfiguredNetwork(client);
  const binding = await verifyTaskPaymentReview(item);
  const taskBytes = (await readTaskProofAccount(client, binding.task, 'Task', 227))!;
  const task = await decodeChainTask(binding.task, taskBytes, item.agent);
  const receipt = await readTaskProofAccount(client, binding.receipt, 'TaskAction', 90, true);
  const execution = receiptOnly ? null : await readTaskProofAccount(client, item.execution, 'Execution', 132, true);
  if (receipt) {
    const v = new DataView(receipt.buffer);
    if (keyAt(receipt, 8) !== binding.task || keyAt(receipt, 40) !== item.execution || v.getBigUint64(72, true).toString() !== item.amount || receipt[80] !== (item.asset === 'USDC' ? 1 : 0) || v.getBigUint64(81, true).toString() !== item.actionId || receipt[89] !== binding.receiptBump) throw new Error('TaskAction does not match the original payment.');
  }
  if (execution) {
    const v = new DataView(execution.buffer), kind = item.kind === 'payment' ? 0 : item.kind === 'skill' ? 3 : 2;
    if (keyAt(execution, 8) !== item.agent || v.getBigUint64(40, true) !== binding.executionId || execution[48] !== (item.asset === 'USDC' ? 1 : 0) || execution[49] !== kind || v.getBigUint64(50, true).toString() !== item.amount || hex(execution.slice(66, 98)) !== item.inputHash || execution[98] > 1) throw new Error('Execution does not match the original task payment.');
    const statusOffset = execution[98] === 1 ? 131 : 99;
    if (execution[statusOffset] > 2 || item.kind !== 'escrow' && execution[statusOffset] !== 0 || item.kind === 'payment' && (execution[98] !== 1 || hex(execution.slice(99, 131)) !== hex(binding.data.slice(48, 80)))) throw new Error('Payment Execution has a different output or outcome.');
  }
  let escrow = null, link = null;
  if (item.kind === 'escrow' && !receiptOnly) {
    const saved = item.escrowTask!;
    escrow = await readTaskProofAccount(client, saved.address, 'Escrow', 180, true);
    link = await readTaskProofAccount(client, await deriveTaskEscrowAddress(address(saved.address)), 'TaskEscrow', 106, true);
    if (escrow) {
      const v = new DataView(escrow.buffer), statusAt = escrow[128] === 1 ? 161 : 129;
      const [, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('escrow'), encode(item.agent), u64(saved.id)] });
      if (escrow[128] > 1 || keyAt(escrow, 8) !== item.agent || keyAt(escrow, 40) !== saved.workerAgent || v.getBigUint64(72, true).toString() !== saved.id || v.getBigUint64(80, true).toString() !== item.amount || v.getBigInt64(88, true) !== BigInt(saved.deadline) || hex(escrow.slice(96, 128)) !== item.inputHash || escrow[statusAt] > 5 || escrow[statusAt + 1] !== bump || escrow[statusAt + 18] !== (item.asset === 'USDC' ? 1 : 0) || v.getBigUint64(statusAt + 2, true) !== binding.executionId || new TextDecoder().decode(escrow.slice(statusAt + 10, statusAt + 18)) !== 'AGTSK001') throw new Error('Worker Escrow differs from its reviewed task funding.');
    }
    if (link) {
      const [expected, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('task_escrow'), encode(saved.address)] });
      if (expected !== await deriveTaskEscrowAddress(address(saved.address)) || keyAt(link, 8) !== binding.task || keyAt(link, 40) !== saved.address || keyAt(link, 72) !== item.execution || link[104] > 1 || link[105] !== bump) throw new Error('Worker TaskEscrow link differs from its original funding.');
    }
    if (escrow && link && link[104] !== ([1, 2, 3, 5].includes(escrow[escrow[128] === 1 ? 161 : 129]) ? 1 : 0)) throw new Error('TaskEscrow closed state differs from its Escrow outcome.');
    if (receipt && (!escrow || !link)) throw new Error('Worker funding receipt lacks its Escrow or TaskEscrow link.');
  }
  return { ...binding, task, receipt, execution, escrow, link };
}
export async function assertTaskPaymentUnsent(client: AppClient, item: TaskCheckpoint) {
  const live = await loadTaskPaymentProof(client, item);
  if (live.receipt || live.execution || live.escrow || live.link) throw new Error('This payment already has chain records. Check its original transaction before continuing.');
  if (live.task.status !== 'running' || live.task.session !== live.session || live.task.deadline <= Math.floor(Date.now() / 1000) || BigInt(item.amount) > BigInt(item.asset === 'SOL' ? live.task.sol.remaining : live.task.usdc.remaining)) throw new Error('Task state or Session changed since the payment review.');
  const session = (await readTaskProofAccount(client, live.session, 'Session', 147))!;
  const [expected, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [utf8('session'), encode(item.agent), encode(live.signer)] });
  if (session[105] !== 0 || new DataView(session.buffer).getBigInt64(72, true) <= BigInt(Math.floor(Date.now() / 1000)) || expected !== live.session || session[106] !== bump || keyAt(session, 8) !== item.agent || keyAt(session, 40) !== live.signer || hex(session.slice(107, 115)) !== hex(u64(item.taskId)) || new TextDecoder().decode(session.slice(115, 123)) !== 'AGTASK01') throw new Error('Payment Session is not bound to this Task and signer.');
}
