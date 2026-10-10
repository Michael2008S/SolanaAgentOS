import { NETWORK_STORAGE } from './chainNetwork';
import { address, getAddressEncoder } from '@solana/kit';

export type EscrowHandoffPackage = {
  format: 'agentos-escrow-handoff'; version: 1; network: typeof NETWORK_STORAGE;
  programId: string; escrow: string; agent: string; workerAgent: string;
  task: string; result: string | null; taskHash: string; resultHash: string | null;
};
const keys = ['format', 'version', 'network', 'programId', 'escrow', 'agent', 'workerAgent', 'task', 'result', 'taskHash', 'resultHash'].sort();
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function parseEscrowHandoffPackage(text: string): Promise<EscrowHandoffPackage> {
  if (new TextEncoder().encode(text).byteLength > 20_000) throw new Error('Handoff file exceeds the 20 KB limit.');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Handoff file must contain an object.');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== keys.join(',') || item.format !== 'agentos-escrow-handoff' || item.version !== 1 || item.network !== NETWORK_STORAGE) throw new Error('Unsupported handoff file format, version or network.');
  for (const key of ['programId', 'escrow', 'agent', 'workerAgent']) {
    if (typeof item[key] !== 'string') throw new Error('Handoff file contains an invalid address.');
    getAddressEncoder().encode(address(item[key]));
  }
  if (typeof item.task !== 'string' || !item.task || item.task.length > 400 || item.task !== item.task.trim()) throw new Error('Handoff task must contain 1–400 normalized characters.');
  if (item.result !== null && (typeof item.result !== 'string' || !item.result || item.result.length > 400 || item.result !== item.result.trim())) throw new Error('Handoff result must contain 1–400 normalized characters.');
  if (item.taskHash !== await hash(item.task) || (item.result === null ? item.resultHash !== null : item.resultHash !== await hash(item.result as string))) throw new Error('Handoff file text does not match its SHA-256 metadata.');
  return item as EscrowHandoffPackage;
}

export async function verifyEscrowHandoffPackage(file: EscrowHandoffPackage, programId: string, live: {
  address: string; agent: string; workerAgent: string; taskHash: string; resultHash: string | null;
}): Promise<void> {
  // Recheck bytes even when callers supplied an object instead of parsing a file.
  await parseEscrowHandoffPackage(JSON.stringify(file));
  if (file.programId !== programId || file.escrow !== live.address || file.agent !== live.agent || file.workerAgent !== live.workerAgent) throw new Error('Handoff file does not match the current Program, Escrow or participating Agents.');
  if (file.taskHash !== live.taskHash || (file.result !== null && file.resultHash !== live.resultHash)) throw new Error('Handoff text does not match the current on-chain commitments.');
}
