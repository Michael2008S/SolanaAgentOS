import { NETWORK_IDENTITY, ensureConfiguredNetwork } from './chainNetwork';
import { address, getAddressEncoder, getBase58Decoder, getBase64Encoder, getProgramDerivedAddress } from '@solana/kit';
import type { AppClient } from '../providers';
import { PROGRAM_ADDRESS, deriveEscrowAddress, deriveExecutionAddress, deriveJudgeDecisionAddress, deriveJudgeMandateAddress, deriveTaskEscrowAddress, type JudgeVerdict } from './agentOs';
const decoder = getBase58Decoder();
const publicKey = (data: Uint8Array, offset: number) => decoder.decode(data.slice(offset, offset + 32));
const hex = (data: Uint8Array) => [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('');
export const judgeDigest = async (text: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
export const judgeHashBytes = (hash: string) => { if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid SHA-256.'); return Uint8Array.from(hash.match(/../g)!, (byte) => parseInt(byte, 16)); };
export type JudgeMandateView = { address: string; employer: string; worker: string; judge: string; session: string; taskHash: string; expiresAt: number; acceptedAt: number; accepted: boolean; declined: boolean; used: boolean };
export type JudgeDecisionView = { address: string; judge: string; session: string; taskHash: string; resultHash: string; judgmentHash: string; verdict: JudgeVerdict; recordedAt: number; settled: boolean };
export type JudgeSnapshot = { escrow: string; employer: string; worker: string; employerOwner: string; workerOwner: string; amount: string; asset: 'SOL' | 'USDC'; deadline: number; funded: boolean; status: 'funded' | 'released' | 'refunded' | 'cancelled' | 'settlement_proposed' | 'settled'; taskHash: string; resultHash: string | null; execution?: string; task?: string; mandate: JudgeMandateView | null; decision: JudgeDecisionView | null };
async function read(client: AppClient, key: string, type: string, length: number, optional = false) {
  const account = await client.rpc.getAccountInfo(address(key), { commitment: 'confirmed', encoding: 'base64' }).send();
  if (!account.value && optional) return null;
  if (!account.value || account.value.owner !== PROGRAM_ADDRESS) throw new Error(`${type} is missing or belongs to another Program.`);
  const data = new Uint8Array(getBase64Encoder().encode(account.value.data[0]));
  const discriminator = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`account:${type}`))).slice(0, 8);
  if (data.length !== length || discriminator.some((byte, index) => byte !== data[index])) throw new Error(`${type} account layout is invalid.`);
  return data;
}
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const time = (data: Uint8Array, offset: number) => { const value = Number(view(data).getBigInt64(offset, true)); if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Judge timestamp.'); return value; };
async function owner(client: AppClient, key: string) {
  const data = (await read(client, key, 'Agent', 138))!;
  const owner = publicKey(data, 8);
  const [expected, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('agent'), getAddressEncoder().encode(address(owner)), data.slice(40, 72)] });
  if (expected !== key || data[121] !== bump || data[104] > 1) throw new Error('Agent is not canonical.');
  return owner;
}
export async function loadJudgeSnapshot(client: AppClient, escrow: string): Promise<JudgeSnapshot> {
  await ensureConfiguredNetwork(client);
  const data = (await read(client, escrow, 'Escrow', 180))!;
  if (data[128] > 1) throw new Error('Invalid Escrow output hash tag.');
  const employer = publicKey(data, 8), worker = publicKey(data, 40);
  const offset = data[128] === 1 ? 161 : 129;
  if (data[offset] > 5 || data[offset + 18] > 1 || await deriveEscrowAddress(address(employer), view(data).getBigUint64(72, true)) !== escrow) throw new Error('Invalid Escrow state or PDA.');
  const mandateKey = await deriveJudgeMandateAddress(address(escrow)), decisionKey = await deriveJudgeDecisionAddress(address(escrow));
  const [mandateData, decisionData, employerOwner, workerOwner] = await Promise.all([read(client, mandateKey, 'JudgeMandate', 220, true), read(client, decisionKey, 'JudgeDecision', 243, true), owner(client, employer), owner(client, worker)]);
  const taskHash = hex(data.slice(96, 128));
  let mandate: JudgeMandateView | null = null;
  if (mandateData) {
    const [expected, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('escrow_judge'), getAddressEncoder().encode(address(escrow))] });
    if (expected !== mandateKey || mandateData[219] !== bump || publicKey(mandateData, 8) !== escrow || publicKey(mandateData, 40) !== employer || publicKey(mandateData, 72) !== worker || hex(mandateData.slice(168, 200)) !== taskHash || [216, 217, 218].some((at) => mandateData[at] > 1)) throw new Error('Judge mandate does not match this Escrow.');
    mandate = { address: mandateKey, employer, worker, judge: publicKey(mandateData, 104), session: publicKey(mandateData, 136), taskHash, expiresAt: time(mandateData, 200), acceptedAt: time(mandateData, 208), accepted: Boolean(mandateData[216]), declined: Boolean(mandateData[217]), used: Boolean(mandateData[218]) };
  }
  let decision: JudgeDecisionView | null = null;
  if (decisionData) {
    const [expected, bump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('escrow_decision'), getAddressEncoder().encode(address(escrow))] });
    if (!mandate || expected !== decisionKey || decisionData[242] !== bump || decisionData[232] > 2 || decisionData[241] > 1 || publicKey(decisionData, 8) !== escrow || publicKey(decisionData, 40) !== mandateKey || publicKey(decisionData, 72) !== mandate.judge || publicKey(decisionData, 104) !== mandate.session || hex(decisionData.slice(136, 168)) !== taskHash || data[128] !== 1 || hex(decisionData.slice(168, 200)) !== hex(data.slice(129, 161))) throw new Error('Judge decision does not match its mandate and submitted result.');
    decision = { address: decisionKey, judge: mandate.judge, session: mandate.session, taskHash, resultHash: hex(decisionData.slice(168, 200)), judgmentHash: hex(decisionData.slice(200, 232)), verdict: (['pass', 'fail', 'needs_review'] as const)[decisionData[232]], recordedAt: time(decisionData, 233), settled: Boolean(decisionData[241]) };
  }
  const marker = new TextDecoder().decode(data.slice(offset + 10, offset + 18));
  const execution = ['AGEXE001', 'AGTSK001'].includes(marker) ? await deriveExecutionAddress(address(employer), view(data).getBigUint64(offset + 2, true)) : undefined;
  let task: string | undefined;
  if (marker === 'AGTSK001') {
    const link = (await read(client, await deriveTaskEscrowAddress(address(escrow)), 'TaskEscrow', 106))!;
    if (publicKey(link, 40) !== escrow || publicKey(link, 72) !== execution) throw new Error('Task Escrow link is invalid.');
    task = publicKey(link, 8);
  }
  return { escrow, employer, worker, employerOwner, workerOwner, amount: view(data).getBigUint64(80, true).toString(), asset: data[offset + 18] === 0 ? 'SOL' : 'USDC', deadline: time(data, 88), funded: data[offset] === 0, status: (['funded', 'released', 'refunded', 'cancelled', 'settlement_proposed', 'settled'] as const)[data[offset]], taskHash, resultHash: data[128] ? hex(data.slice(129, 161)) : null, execution, task, mandate, decision };
}

/** Hash the same ordered fields as Runtime's Judge response. No text rewriting. */
export async function parseJudgeArtifact(text: string, snapshot: JudgeSnapshot) {
  if (new TextEncoder().encode(text).length > 32_768) throw new Error('Judge artifact exceeds 32 KB.');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.network !== NETWORK_IDENTITY || value.programId !== PROGRAM_ADDRESS || value.taskHash !== snapshot.taskHash || value.resultHash !== snapshot.resultHash || !['pass', 'fail', 'needs_review'].includes(value.verdict) || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 600 || !Array.isArray(value.checks) || value.checks.length > 8 || !value.checks.every((check: { criterion?: unknown; status?: unknown; evidence?: unknown }) => check && typeof check.criterion === 'string' && check.criterion.length > 0 && check.criterion.length <= 240 && typeof check.evidence === 'string' && check.evidence.length <= 400 && ['met', 'not_met', 'unclear'].includes(String(check.status))) || !Array.isArray(value.limitations) || value.limitations.length > 6 || !value.limitations.every((item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 240) || typeof value.model !== 'string' || !Number.isFinite(Date.parse(value.evaluatedAt))) throw new Error('Judge artifact fields do not match this task and result.');
  if (value.verdict === 'pass' && (!value.checks.length || value.checks.some((check: { status: string }) => check.status !== 'met')) || value.verdict === 'fail' && !value.checks.some((check: { status: string }) => check.status === 'not_met')) throw new Error('Judge verdict lacks the required criterion checks.');
  const body = { taskHash: value.taskHash, resultHash: value.resultHash, verdict: value.verdict, confidence: value.confidence, summary: value.summary, checks: value.checks, limitations: value.limitations, model: value.model, evaluatedAt: value.evaluatedAt };
  const content = JSON.stringify(body);
  const hash = await judgeDigest(content);
  if (hash !== value.judgmentHash) throw new Error('Judge body differs from its judgment SHA-256.');
  return { content, hash, verdict: value.verdict as JudgeVerdict, summary: value.summary as string };
}


export async function validateAutomaticJudgeSession(client: AppClient, judge: string, session: string, signer: string) {
  await ensureConfiguredNetwork(client);
  const [policy, policyBump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('policy'), getAddressEncoder().encode(address(judge))] });
  const [sessionKey, sessionBump] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('session'), getAddressEncoder().encode(address(judge)), getAddressEncoder().encode(address(signer))] });
  if (sessionKey !== session) throw new Error('Judge Session signer differs from its canonical address.');
  const [agentData, policyData, sessionData] = await Promise.all([read(client, judge, 'Agent', 138), read(client, policy, 'Policy', 123), read(client, session, 'Session', 147), owner(client, judge)]);
  if (agentData![104] !== 0 || publicKey(policyData!, 8) !== judge || policyData![73] !== 0 || policyData![74] !== policyBump || (policyData![72] & 4) !== 4 || publicKey(sessionData!, 8) !== judge || publicKey(sessionData!, 40) !== signer || sessionData![106] !== sessionBump || sessionData![105] !== 0 || (sessionData![104] & 4) !== 4 || time(sessionData!, 72) <= Math.floor(Date.now() / 1_000)) throw new Error('Judge Agent, Policy or Session is inactive, paused, revoked, expired or lacks API permission.');
}


export async function validateProposedJudgeSession(client: AppClient, judge: string, session: string, snapshot: JudgeSnapshot, expiresAt: number) {
  await ensureConfiguredNetwork(client);
  const sessionData = (await read(client, session, 'Session', 147))!;
  const judgeOwner = await owner(client, judge);
  if ([snapshot.employer, snapshot.worker].includes(judge) || [snapshot.employerOwner, snapshot.workerOwner].includes(judgeOwner)) throw new Error('Judge Agent and Owner must be independent from both parties.');
  await validateAutomaticJudgeSession(client, judge, session, publicKey(sessionData, 40));
  if (expiresAt > time(sessionData, 72)) throw new Error('Judge deadline exceeds its Session expiry.');
}

export type JudgeDirectoryEntry = {
  escrow: string; mandate: string; employer: string; worker: string; judge: string; session: string;
  taskHash: string; resultHash: string | null; amount: string; asset: 'SOL' | 'USDC'; deadline: number; expiresAt: number;
  accepted: boolean; declined: boolean; used: boolean; escrowStatus: string; readyForAssessment: boolean;
  decision: { address: string; verdict: 'pass' | 'fail' | 'needs_review'; judgmentHash: string; recordedAt: number; settled: boolean } | null;
};
export async function readJudgeDirectory(judge: string): Promise<{ tasks: JudgeDirectoryEntry[]; truncated: boolean; failures: number }> {
  const response = await fetch(`/api/on-chain/judge-tasks?judge=${encodeURIComponent(judge)}`, { cache: 'no-store', signal: AbortSignal.timeout(45_000) });
  const text = await response.text(); if (text.length > 300_000) throw new Error('Judge directory response exceeds 300 KB.');
  const payload = JSON.parse(text);
  if (!response.ok) throw new Error(payload.error ?? 'Could not discover Judge tasks.');
  if (payload.network !== NETWORK_IDENTITY || payload.programId !== PROGRAM_ADDRESS || payload.judge !== judge || payload.limit !== 100 || typeof payload.truncated !== 'boolean' || !Array.isArray(payload.tasks) || payload.tasks.length > 100 || payload.count !== payload.tasks.length || !Array.isArray(payload.failures) || payload.failures.length > 100) throw new Error('Invalid Judge directory response.');
  const ids = new Set<string>();
  for (const task of payload.tasks as JudgeDirectoryEntry[]) {
    if (!task || task.judge !== judge || ids.has(task.escrow)) throw new Error('Judge directory contains a foreign or duplicate task.');
    for (const key of [task.escrow, task.mandate, task.employer, task.worker, task.judge, task.session]) getAddressEncoder().encode(address(key));
    if (!/^[a-f0-9]{64}$/.test(task.taskHash) || task.resultHash !== null && !/^[a-f0-9]{64}$/.test(task.resultHash) || !/^(0|[1-9][0-9]{0,19})$/.test(task.amount) || BigInt(task.amount) > 18_446_744_073_709_551_615n || !['SOL', 'USDC'].includes(task.asset) || !Number.isSafeInteger(task.deadline) || task.deadline <= 0 || !Number.isSafeInteger(task.expiresAt) || task.expiresAt <= 0 || [task.accepted, task.declined, task.used, task.readyForAssessment].some((item) => typeof item !== 'boolean') || !['funded', 'released', 'refunded', 'cancelled', 'settlement_proposed', 'settled'].includes(task.escrowStatus)) throw new Error('Judge directory task metadata is invalid.');
    if (task.decision !== null && (!task.decision || !['pass', 'fail', 'needs_review'].includes(task.decision.verdict) || !/^[a-f0-9]{64}$/.test(task.decision.judgmentHash) || typeof task.decision.settled !== 'boolean' || !Number.isSafeInteger(task.decision.recordedAt))) throw new Error('Judge directory decision metadata is invalid.');
    ids.add(task.escrow);
  }
  return { tasks: payload.tasks, truncated: payload.truncated, failures: payload.failures.length };
}
export async function readSharedJudgeTexts(client: AppClient, escrow: string) {
  const response = await fetch(`/api/escrow/handoff?escrow=${encodeURIComponent(escrow)}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  const text = await response.text(); if (text.length > 32_000) throw new Error('Shared handoff response exceeds 32 KB.');
  const payload = JSON.parse(text);
  if (!response.ok) throw new Error(payload.error ?? 'No shared Worker result found.');
  const value = payload.handoff;
  if (payload.network !== NETWORK_IDENTITY || payload.programId !== PROGRAM_ADDRESS || !value || value.escrow !== escrow || typeof value.task !== 'string' || !value.task.trim() || value.task !== value.task.trim() || value.task.length > 400 || typeof value.result !== 'string' || !value.result.trim() || value.result !== value.result.trim() || value.result.length > 6_000 || await judgeDigest(value.task) !== value.taskHash || await judgeDigest(value.result) !== value.resultHash) throw new Error('Shared Judge text fields or hashes are invalid.');
  const live = await loadJudgeSnapshot(client, escrow);
  if (live.taskHash !== value.taskHash || live.resultHash !== value.resultHash) throw new Error('Shared texts differ from fresh Devnet commitments.');
  return { snapshot: live, task: value.task as string, result: value.result as string };
}
