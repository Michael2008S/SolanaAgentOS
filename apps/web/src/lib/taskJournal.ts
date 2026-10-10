import { NETWORK_STORAGE } from './chainNetwork';
import type { Instruction } from '@solana/kit';
import { PROGRAM_ADDRESS } from './agentOs';

export type SkillResultAttempt = { id: string; session: string; feePayer: string; state: 'prepared' | 'signed' | 'unknown' | 'confirmed' | 'failed' | 'cancelled'; signature?: string; lastValidBlockHeight?: string; createdAt: string; updatedAt: string };
export type TaskPaymentReview = { program: string; feePayer: string; data: string; accounts: { address: string; role: number }[] };
export function taskPaymentReview(instruction: Instruction): TaskPaymentReview {
  if (!instruction.accounts?.[1]) throw new Error('Task payment needs a fee payer.');
  return { program: String(instruction.programAddress), feePayer: String(instruction.accounts[1].address), data: [...(instruction.data ?? [])].map(byte => byte.toString(16).padStart(2, '0')).join(''), accounts: instruction.accounts.map(account => ({ address: String(account.address), role: account.role })) };
}
export type TaskCheckpoint = {
  version: 1; agent: string; taskId: string; actionId: string; execution: string;
  kind: 'payment' | 'skill' | 'escrow'; asset: 'SOL' | 'USDC'; amount: string; inputHash: string;
  state: 'prepared' | 'signed' | 'confirmed' | 'unknown' | 'failed' | 'cancelled';
  signature?: string; lastValidBlockHeight?: string; createdAt: string; updatedAt: string;
  review?: TaskPaymentReview;
  skillRequest?: { skillId: string; skill: string; provider: string; endpoint: string; prompt: string };
  skillResult?: { skillId: string; content: string; outputHash: string; resultSignature?: string; attempts?: SkillResultAttempt[] };
  escrowTask?: { address: string; workerAgent: string; id: string; deadline: number; task: string };
};
const isAddress = (value: unknown): value is string => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const isU64 = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
const key = (agent: string) => `agentos:task-journal:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${agent}`;

export function readTaskJournal(agent: string): TaskCheckpoint[] {
  if (!isAddress(agent)) throw new Error('Invalid journal Agent.');
  const text = localStorage.getItem(key(agent));
  if (!text) return [];
  if (text.length > 500_000) throw new Error('Task journal exceeds its storage limit. Export it before continuing.');
  const values: unknown = JSON.parse(text);
  return validateTaskJournal(values, agent);
}

function validateTaskJournal(values: unknown, agent: string): TaskCheckpoint[] {
  if (!Array.isArray(values) || values.length > 500) throw new Error('Task journal is invalid.');
  const ids = new Set<string>();
  for (const value of values) {
    const item = value as TaskCheckpoint;
    if (!item || item.version !== 1 || item.agent !== agent || !isU64(item.taskId) || !isU64(item.actionId) || !isAddress(item.execution)
      || !['payment', 'skill', 'escrow'].includes(item.kind) || !['SOL', 'USDC'].includes(item.asset) || !isU64(item.amount) || BigInt(item.amount) === 0n
      || !/^[a-f0-9]{64}$/.test(item.inputHash) || !['prepared', 'signed', 'confirmed', 'unknown', 'failed', 'cancelled'].includes(item.state)
      || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))
      || (item.signature !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.signature))
      || (item.lastValidBlockHeight !== undefined && !isU64(item.lastValidBlockHeight))
      || (item.skillRequest !== undefined && (item.kind !== 'skill' || typeof item.skillRequest.skillId !== 'string' || item.skillRequest.skillId.length > 100 || !isAddress(item.skillRequest.skill) || !isAddress(item.skillRequest.provider) || typeof item.skillRequest.endpoint !== 'string' || item.skillRequest.endpoint.length > 2000 || typeof item.skillRequest.prompt !== 'string' || !item.skillRequest.prompt.trim() || item.skillRequest.prompt !== item.skillRequest.prompt.trim() || item.skillRequest.prompt.length > 1000))
      || (item.skillResult !== undefined && (item.kind !== 'skill' || typeof item.skillResult.skillId !== 'string' || item.skillResult.skillId.length > 100 || typeof item.skillResult.content !== 'string' || new TextEncoder().encode(item.skillResult.content).length > 65_536 || !/^[a-f0-9]{64}$/.test(item.skillResult.outputHash) || (item.skillResult.resultSignature !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.skillResult.resultSignature))))
      || (item.escrowTask !== undefined && (item.kind !== 'escrow' || !isAddress(item.escrowTask.address) || !isAddress(item.escrowTask.workerAgent) || !isU64(item.escrowTask.id) || !Number.isSafeInteger(item.escrowTask.deadline) || item.escrowTask.deadline < 0 || typeof item.escrowTask.task !== 'string' || !item.escrowTask.task.trim() || item.escrowTask.task.length > 400))
      || (['signed', 'unknown', 'confirmed'].includes(item.state) && (!item.signature || !item.lastValidBlockHeight))) throw new Error('Task journal contains an invalid checkpoint.');
    if (item.review !== undefined && (!item.review || item.review.program !== PROGRAM_ADDRESS || !isAddress(item.review.feePayer) || !/^[a-f0-9]{128,192}$/.test(item.review.data) || item.review.data.length % 2 || !Array.isArray(item.review.accounts) || item.review.accounts.length < 11 || item.review.accounts.length > 17 || !item.review.accounts.every(account => account && isAddress(account.address) && [0, 1, 2, 3].includes(account.role)) || item.review.accounts[1].address !== item.review.feePayer)) throw new Error('Invalid saved Task payment review.');
    if (['prepared', 'cancelled'].includes(item.state) && item.signature) throw new Error('An unsigned Task review cannot contain a signature.');
    if (item.skillResult?.attempts !== undefined) {
      if (!Array.isArray(item.skillResult.attempts) || item.skillResult.attempts.length > 20 || new Set(item.skillResult.attempts.map((attempt) => attempt?.id)).size !== item.skillResult.attempts.length) throw new Error('Invalid Skill result attempts.');
      for (const attempt of item.skillResult.attempts) {
        if (!attempt || !/^[0-9a-f-]{36}$/.test(attempt.id) || !isAddress(attempt.session) || !isAddress(attempt.feePayer) || !['prepared', 'signed', 'unknown', 'confirmed', 'failed', 'cancelled'].includes(attempt.state) || !Number.isFinite(Date.parse(attempt.createdAt)) || !Number.isFinite(Date.parse(attempt.updatedAt)) || attempt.signature !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(attempt.signature) || attempt.lastValidBlockHeight !== undefined && !isU64(attempt.lastValidBlockHeight) || ['signed', 'unknown', 'confirmed'].includes(attempt.state) && (!attempt.signature || !attempt.lastValidBlockHeight) || ['prepared', 'cancelled'].includes(attempt.state) && Boolean(attempt.signature)) throw new Error('Invalid Skill result signature checkpoint.');
      }
    }
    const id = `${item.taskId}:${item.actionId}`;
    if (ids.has(id)) throw new Error('Task journal contains duplicate actions.');
    ids.add(id);
  }
  // Only persist known checkpoint fields; imported extra fields are discarded.
  return (values as TaskCheckpoint[]).map((item) => ({ version: 1, agent: item.agent, taskId: item.taskId, actionId: item.actionId, execution: item.execution, kind: item.kind, asset: item.asset, amount: item.amount, inputHash: item.inputHash, state: item.state, createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.review ? { review: { program: item.review.program, feePayer: item.review.feePayer, data: item.review.data, accounts: item.review.accounts.map(account => ({ address: account.address, role: account.role })) } } : {}), ...(item.signature ? { signature: item.signature } : {}), ...(item.lastValidBlockHeight ? { lastValidBlockHeight: item.lastValidBlockHeight } : {}), ...(item.skillRequest ? { skillRequest: { skillId: item.skillRequest.skillId, skill: item.skillRequest.skill, provider: item.skillRequest.provider, endpoint: item.skillRequest.endpoint, prompt: item.skillRequest.prompt } } : {}), ...(item.skillResult ? { skillResult: { skillId: item.skillResult.skillId, content: item.skillResult.content, outputHash: item.skillResult.outputHash, ...(item.skillResult.attempts ? { attempts: item.skillResult.attempts.map((attempt) => ({ id: attempt.id, session: attempt.session, feePayer: attempt.feePayer, state: attempt.state, createdAt: attempt.createdAt, updatedAt: attempt.updatedAt, ...(attempt.signature ? { signature: attempt.signature } : {}), ...(attempt.lastValidBlockHeight ? { lastValidBlockHeight: attempt.lastValidBlockHeight } : {}) })) } : {}), ...(item.skillResult.resultSignature ? { resultSignature: item.skillResult.resultSignature } : {}) } } : {}), ...(item.escrowTask ? { escrowTask: { address: item.escrowTask.address, workerAgent: item.escrowTask.workerAgent, id: item.escrowTask.id, deadline: item.escrowTask.deadline, task: item.escrowTask.task } } : {}) }));
}

export function saveTaskCheckpoint(item: TaskCheckpoint): void {
  const records = readTaskJournal(item.agent);
  const index = records.findIndex((record) => record.taskId === item.taskId && record.actionId === item.actionId);
  if (index >= 0) {
    const previous = records[index];
    if (previous.execution !== item.execution || previous.amount !== item.amount || previous.inputHash !== item.inputHash || previous.kind !== item.kind || previous.asset !== item.asset) throw new Error('A checkpoint cannot change its reviewed payment.');
    if (JSON.stringify(previous.review) !== JSON.stringify(item.review)) throw new Error('A payment checkpoint cannot change or attach its saved review.');
    if (previous.signature && (previous.signature !== item.signature || previous.lastValidBlockHeight !== item.lastValidBlockHeight)) throw new Error('A signed checkpoint cannot change its transaction signature.');
    const transitions = { prepared: ['prepared', 'signed', 'cancelled'], signed: ['signed', 'unknown', 'confirmed', 'failed'], unknown: ['unknown', 'confirmed', 'failed'], confirmed: ['confirmed'], failed: ['failed'], cancelled: ['cancelled'] };
    if (!transitions[previous.state].includes(item.state)) throw new Error('The checkpoint state cannot move backwards or reopen a closed action.');
    if (previous.skillRequest && JSON.stringify(previous.skillRequest) !== JSON.stringify(item.skillRequest)) throw new Error('A saved Skill request cannot change its endpoint or prompt.');
    if (previous.skillResult && (previous.skillResult.content !== item.skillResult?.content || previous.skillResult.outputHash !== item.skillResult?.outputHash || previous.skillResult.skillId !== item.skillResult?.skillId)) throw new Error('A saved Skill result cannot change its response commitment.');
    if (previous.skillResult?.resultSignature && previous.skillResult.resultSignature !== item.skillResult?.resultSignature) throw new Error('A recorded Skill result signature cannot change.');
    for (const attempt of previous.skillResult?.attempts ?? []) {
      const next = item.skillResult?.attempts?.find((value) => value.id === attempt.id);
      if (!next || next.session !== attempt.session || next.feePayer !== attempt.feePayer || next.createdAt !== attempt.createdAt || attempt.signature && (next.signature !== attempt.signature || next.lastValidBlockHeight !== attempt.lastValidBlockHeight) || !transitions[attempt.state].includes(next.state)) throw new Error('A result attempt cannot be changed, deleted or reopened.');
    }
    if (previous.escrowTask && JSON.stringify(previous.escrowTask) !== JSON.stringify(item.escrowTask)) throw new Error('A saved Escrow cannot change its reviewed task.');
    records[index] = item;
  } else records.push(item);
  // Never silently prune unresolved actions or payment evidence.
  if (records.length > 500) throw new Error('Task journal is full. Export it before continuing.');
  const serialized = JSON.stringify(validateTaskJournal(records, item.agent));
  if (serialized.length > 500_000) throw new Error('Task journal exceeds its storage limit. Export it before continuing.');
  localStorage.setItem(key(item.agent), serialized);
  if (!readTaskJournal(item.agent).some((record) => record.actionId === item.actionId && record.taskId === item.taskId && JSON.stringify(record) === JSON.stringify(validateTaskJournal([item], item.agent)[0]))) throw new Error('Could not persist the task checkpoint.');
}

export function importTaskJournal(agent: string, text: string): void {
  if (text.length > 500_000) throw new Error('Task journal backup exceeds its storage limit.');
  const backup = JSON.parse(text);
  if (backup?.format !== 'agentos-task-journal' || backup.version !== 1 || backup.programId !== PROGRAM_ADDRESS || backup.network !== NETWORK_STORAGE || backup.agent !== agent) throw new Error('Journal backup belongs to another Program, network or Agent.');
  const imported = validateTaskJournal(backup.records, agent);
  const existing = readTaskJournal(agent);
  for (const item of imported) {
    const previous = existing.find((record) => record.taskId === item.taskId && record.actionId === item.actionId);
    if (previous) {
      if (previous.execution !== item.execution || previous.amount !== item.amount || previous.asset !== item.asset || previous.kind !== item.kind || previous.inputHash !== item.inputHash || previous.skillRequest && item.skillRequest && JSON.stringify(previous.skillRequest) !== JSON.stringify(item.skillRequest) || (previous.signature && item.signature && previous.signature !== item.signature)) throw new Error('Imported checkpoint conflicts with an existing payment.');
      if (item.review && JSON.stringify(previous.review) !== JSON.stringify(item.review)) throw new Error('Imported payment review conflicts with the original saved instruction.');
      if (!previous.signature && item.signature) {
        if (previous.state !== 'prepared') throw new Error('Imported payment signature conflicts with a discarded local review.');
        previous.signature = item.signature; previous.lastValidBlockHeight = item.lastValidBlockHeight; previous.state = 'unknown'; previous.updatedAt = new Date().toISOString();
      } else if (previous.signature && item.signature && previous.lastValidBlockHeight !== item.lastValidBlockHeight) throw new Error('Imported payment lifetime conflicts with its original signature.');
      if (!previous.skillRequest && item.skillRequest) previous.skillRequest = item.skillRequest;
      if (previous.skillResult && item.skillResult && (previous.skillResult.content !== item.skillResult.content || previous.skillResult.outputHash !== item.skillResult.outputHash || previous.skillResult.skillId !== item.skillResult.skillId)) throw new Error('Imported Skill response conflicts with the local commitment.');
      if (item.skillResult) {
        const normalize = (attempt: SkillResultAttempt): SkillResultAttempt => ({ ...attempt, state: attempt.signature ? 'unknown' : 'prepared' });
        if (!previous.skillResult) { const { resultSignature: _unverified, ...result } = item.skillResult; previous.skillResult = { ...result, attempts: result.attempts?.map(normalize) }; }
        else {
          const attempts = [...(previous.skillResult.attempts ?? [])];
          for (const incoming of item.skillResult.attempts ?? []) {
            const local = attempts.find((attempt) => attempt.id === incoming.id);
            if (local) {
              if (local.session !== incoming.session || local.feePayer !== incoming.feePayer || local.createdAt !== incoming.createdAt || local.signature && incoming.signature && (local.signature !== incoming.signature || local.lastValidBlockHeight !== incoming.lastValidBlockHeight)) throw new Error('Imported result attempt conflicts with its local signature.');
              if (!local.signature && incoming.signature) {
                if (local.state !== 'prepared') throw new Error('Imported signature conflicts with a discarded local review.');
                Object.assign(local, normalize(incoming));
              }
            } else attempts.push(normalize(incoming));
          }
          previous.skillResult = { ...previous.skillResult, attempts };
        }
      }
      continue; // Preserve locally recorded state; imported state is not chain proof.
    }
    const { resultSignature: _unverified, ...result } = item.skillResult ?? {};
    existing.push({ ...item, state: item.signature ? 'unknown' : 'prepared', ...(item.skillResult ? { skillResult: { ...item.skillResult, ...result, resultSignature: undefined, attempts: item.skillResult.attempts?.map((attempt) => ({ ...attempt, state: attempt.signature ? 'unknown' : 'prepared' })) } } : {}) });
  }
  validateTaskJournal(existing, agent);
  const serialized = JSON.stringify(existing);
  if (serialized.length > 500_000) throw new Error('Merged journal exceeds its storage limit.');
  localStorage.setItem(key(agent), serialized);
}

export function exportTaskJournal(agent: string): string {
  return JSON.stringify({ format: 'agentos-task-journal', version: 1, network: NETWORK_STORAGE, programId: PROGRAM_ADDRESS, agent, records: readTaskJournal(agent) });
}

export function reserveTaskAction(agent: string, taskId: string): bigint {
  const records = readTaskJournal(agent);
  if (records.some((record) => record.taskId === taskId && ['prepared', 'signed', 'unknown'].includes(record.state))) throw new Error('This task has an unresolved action. Check its saved transaction before preparing another payment.');
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = new DataView(bytes.buffer).getBigUint64(0, true);
  if (records.some((record) => record.taskId === taskId && record.actionId === id.toString())) throw new Error('Action ID collision. Prepare again.');
  return id;
}

export function updateTaskCheckpoint(item: TaskCheckpoint, patch: Partial<Pick<TaskCheckpoint, 'state' | 'signature' | 'lastValidBlockHeight'>>): TaskCheckpoint {
  const next = { ...item, ...patch, updatedAt: new Date().toISOString() };
  saveTaskCheckpoint(next);
  return next;
}
