import { assertJudgeAutomationBinding, assertJudgeTerminalOutcome } from './judgeAutomationBinding';
import { NETWORK_STORAGE } from './chainNetwork';
import { address, type KeyPairSigner } from '@solana/kit';
import type { AppClient } from '../providers';
import { PROGRAM_ADDRESS, deriveUsdcTokenAddress, buildRecordEscrowJudgment, buildSettleJudgedEscrow } from './agentOs';
import { judgeDigest, judgeHashBytes, loadJudgeSnapshot, parseJudgeArtifact, validateAutomaticJudgeSession, readSharedJudgeTexts, type JudgeSnapshot } from './judgeClient';
import { prepareJudgeTransaction, readJudgeJournal, sendJudgeTransaction } from './judgeJournal';
export type AutomaticJudgeSession = { address: string; signer?: KeyPairSigner; backupSaved?: boolean; sponsorPaymentFees?: boolean; automationsPaused?: boolean };
export type AutomaticJudgePlan = {
  version: 1; id: string; escrow: string; judge: string; session: string; feePayer: string;
  employer: string; worker: string; amount: string; asset: 'SOL' | 'USDC'; taskHash: string; resultHash: string | null; task: string; result: string; generate: boolean; artifact?: string;
  settle: boolean; enabled: boolean; phase: 'ready' | 'evaluating' | 'recorded' | 'complete' | 'needs_review' | 'error';
  recordRentLimit: string; settleRentLimit: string; maxFeeLamports: string; expiresAt: number; createdAt: string; updatedAt: string; error?: string;
};
const key = (escrow: string) => `agentos:automatic-judge:${NETWORK_STORAGE}:${PROGRAM_ADDRESS}:${escrow}`;
const validAddress = (value: unknown) => { try { return typeof value === 'string' && Boolean(address(value)); } catch { return false; } };
const validAmount = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
function validate(value: AutomaticJudgePlan, escrow: string): AutomaticJudgePlan {
  if (!value || value.version !== 1 || value.escrow !== escrow || !validAddress(escrow) || !validAddress(value.judge) || !validAddress(value.session) || !validAddress(value.feePayer) || !validAddress(value.employer) || !validAddress(value.worker) || !validAmount(value.amount) || BigInt(value.amount) === 0n || !['SOL', 'USDC'].includes(value.asset) || !/^[a-f0-9-]{36}$/.test(value.id) || !/^[a-f0-9]{64}$/.test(value.taskHash) || (value.resultHash !== null && !/^[a-f0-9]{64}$/.test(value.resultHash) || value.resultHash === null && (!value.generate || value.result !== '' || value.artifact !== undefined)) || typeof value.task !== 'string' || value.task.length > 400 || typeof value.result !== 'string' || value.result.length > 6_000 || [value.generate, value.settle, value.enabled].some((item) => typeof item !== 'boolean') || !['ready', 'evaluating', 'recorded', 'complete', 'needs_review', 'error'].includes(value.phase) || [value.recordRentLimit, value.settleRentLimit, value.maxFeeLamports].some((item) => !validAmount(item)) || value.maxFeeLamports !== '10000' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)) || value.artifact !== undefined && (typeof value.artifact !== 'string' || new TextEncoder().encode(value.artifact).length > 32_768) || value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 500)) throw new Error('Invalid automatic Judge settings.');
  return { version: 1, id: value.id, escrow, judge: value.judge, session: value.session, feePayer: value.feePayer, employer: value.employer, worker: value.worker, amount: value.amount, asset: value.asset, taskHash: value.taskHash, resultHash: value.resultHash, task: value.task, result: value.result, generate: value.generate, settle: value.settle, enabled: value.enabled, phase: value.phase, recordRentLimit: value.recordRentLimit, settleRentLimit: value.settleRentLimit, maxFeeLamports: value.maxFeeLamports, expiresAt: value.expiresAt, createdAt: value.createdAt, updatedAt: value.updatedAt, ...(value.artifact ? { artifact: value.artifact } : {}), ...(value.error ? { error: value.error } : {}) };
}
export function readAutomaticJudge(escrow: string): AutomaticJudgePlan | null {
  const text = localStorage.getItem(key(escrow));
  if (!text) return null;
  if (text.length > 64_000) throw new Error('Automatic Judge settings exceed 64 KB.');
  return validate(JSON.parse(text), escrow);
}
function save(plan: AutomaticJudgePlan) {
  const text = JSON.stringify(validate(plan, plan.escrow));
  if (text.length > 64_000) throw new Error('Automatic Judge settings exceed 64 KB.');
  localStorage.setItem(key(plan.escrow), text);
  if (localStorage.getItem(key(plan.escrow)) !== text) throw new Error('Could not persist automatic Judge settings.');
  return plan;
}
function patch(plan: AutomaticJudgePlan, values: Partial<Pick<AutomaticJudgePlan, 'phase' | 'artifact' | 'enabled' | 'error' | 'resultHash' | 'task' | 'result'>>) {
  const current = readAutomaticJudge(plan.escrow);
  if (!current || current.id !== plan.id) throw new Error('Automatic Judge authorization changed.');
  return save({ ...current, ...values, updatedAt: new Date().toISOString() });
}
export function disableAutomaticJudge(escrow: string) { const plan = readAutomaticJudge(escrow); if (plan) patch(plan, { enabled: false }); }
function requireSession(session: AutomaticJudgeSession | null, plan?: AutomaticJudgePlan) {
  if (!session?.signer || !session.backupSaved || !session.sponsorPaymentFees || session.automationsPaused || plan && (session.address !== plan.session || session.signer.address !== plan.feePayer)) throw new Error('Restore the authorized Session signer, save its encrypted backup, enable fee sponsorship and resume its automation first.');
  return session.signer;
}
const binding = assertJudgeAutomationBinding;

/** Observe a completed Escrow without a signing key or renewing authorization. */
export async function reconcileAutomaticJudgeOutcome(client: AppClient, escrow: string): Promise<JudgeSnapshot | null> {
  if (!navigator.locks) return null;
  return navigator.locks.request(`agentos:judge-auto:${PROGRAM_ADDRESS}:${escrow}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return null;
    const plan = readAutomaticJudge(escrow);
    if (!plan?.enabled) return null;
    const live = await loadJudgeSnapshot(client, escrow);
    if (live.funded && !live.decision?.settled) return null;
    // Ignore time only for a read-only terminal observation. Fixed participants,
    // economics, mandate and any previously bound result still must match.
    assertJudgeTerminalOutcome(plan, live);
    patch(plan, { phase: 'complete', enabled: false, error: undefined });
    return live;
  });
}

async function rent(client: AppClient, live: JudgeSnapshot, action: 'record' | 'settle') {
  if (action === 'record') return live.decision ? 0n : await client.rpc.getMinimumBalanceForRentExemption(243n).send();
  if (live.asset === 'SOL') return 0n;
  const tokenAccounts = await Promise.all([deriveUsdcTokenAddress(address(live.employer)), deriveUsdcTokenAddress(address(live.worker))]);
  const missing = await Promise.all(tokenAccounts.map(async (account) => (await client.rpc.getAccountInfo(account, { commitment: 'confirmed' }).send()).value === null));
  return BigInt(missing.filter(Boolean).length) * await client.rpc.getMinimumBalanceForRentExemption(165n).send();
}
export async function previewAutomaticJudge(client: AppClient, escrow: string, judge: string, session: AutomaticJudgeSession | null, task: string, result: string, generate: boolean, artifact: string, settle: boolean): Promise<AutomaticJudgePlan> {
  const signer = requireSession(session);
  const live = await loadJudgeSnapshot(client, escrow);
  const mandate = live.mandate;
  if (!mandate?.accepted || mandate.declined || mandate.judge !== judge || mandate.session !== session!.address || !live.funded || !live.resultHash && !generate || Math.floor(Date.now() / 1_000) >= mandate.expiresAt) throw new Error('Load a live accepted Judge mandate. Waiting for delivery requires Runtime assessment to be enabled.');
  if (readJudgeJournal(escrow).some((item) => item.state !== 'cancelled' && (['prepared', 'signed', 'unknown'].includes(item.state) || item.action === 'record' && item.state !== 'confirmed' && !live.decision || item.action === 'settle'))) throw new Error('Resolve existing Judge attempts manually before enabling automatic work.');
  await validateAutomaticJudgeSession(client, judge, session!.address, signer.address);
  if (generate && !live.decision) {
    if (live.resultHash && (await judgeDigest(task.trim()) !== live.taskHash || await judgeDigest(result.trim()) !== live.resultHash)) throw new Error('Exact task and result text must match the chain before enabling automatic assessment.');
  } else {
    const parsed = await parseJudgeArtifact(artifact, live);
    if (live.decision && parsed.hash !== live.decision.judgmentHash) throw new Error('Saved assessment differs from the existing chain decision.');
  }
  const [recordRent, settleRent] = await Promise.all([rent(client, live, 'record'), settle ? rent(client, live, 'settle') : Promise.resolve(0n)]);
  const now = new Date().toISOString();
  return validate({ version: 1, id: crypto.randomUUID(), escrow, judge, session: session!.address, feePayer: signer.address, employer: live.employer, worker: live.worker, amount: live.amount, asset: live.asset, taskHash: live.taskHash, resultHash: live.resultHash, task: live.resultHash ? task.trim() : '', result: live.resultHash ? result.trim() : '', generate: generate && !live.decision, ...(!generate || live.decision ? { artifact } : {}), settle, enabled: false, phase: live.decision ? 'recorded' : 'ready', recordRentLimit: recordRent.toString(), settleRentLimit: settleRent.toString(), maxFeeLamports: '10000', expiresAt: mandate.expiresAt, createdAt: now, updatedAt: now }, escrow);
}
export async function enableAutomaticJudge(client: AppClient, plan: AutomaticJudgePlan, session: AutomaticJudgeSession | null) {
  if (!navigator.locks) throw new Error('Automatic Judge requires browser coordination locks.');
  return navigator.locks.request(`agentos:judge-auto:${PROGRAM_ADDRESS}:${plan.escrow}`, async () => {
    const signer = requireSession(session, plan);
    const live = await loadJudgeSnapshot(client, plan.escrow); binding(plan, live);
    if (!live.funded || readJudgeJournal(plan.escrow).some((item) => item.state !== 'cancelled' && (['prepared', 'signed', 'unknown'].includes(item.state) || item.action === 'record' && item.state !== 'confirmed' && !live.decision || item.action === 'settle'))) throw new Error('Resolve existing attempts before enabling automation.');
    await validateAutomaticJudgeSession(client, plan.judge, plan.session, signer.address);
    if (plan.generate && plan.resultHash !== null && (await judgeDigest(plan.task) !== plan.taskHash || await judgeDigest(plan.result) !== plan.resultHash)) throw new Error('Automatic assessment text commitment changed.');
    if (plan.artifact) await parseJudgeArtifact(plan.artifact, live);
    const reserve = await client.rpc.getBalance(signer.address, { commitment: 'confirmed' }).send();
    if (reserve.value < BigInt(plan.recordRentLimit) + BigInt(plan.settleRentLimit) + 2n * BigInt(plan.maxFeeLamports)) throw new Error('Session fee reserve cannot cover the reviewed rent and fee ceilings.');
    return save({ ...plan, enabled: true, updatedAt: new Date().toISOString() });
  });
}
/** One durable phase per tick. Neither interrupted model requests nor transactions are replayed. */
export async function advanceAutomaticJudge(client: AppClient, escrow: string, currentSession: () => AutomaticJudgeSession | null, permitted: () => boolean): Promise<{ snapshot?: JudgeSnapshot; message?: string }> {
  if (!navigator.locks) throw new Error('Automatic Judge requires browser coordination locks.');
  return navigator.locks.request(`agentos:judge-auto:${PROGRAM_ADDRESS}:${escrow}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return {};
    let plan = readAutomaticJudge(escrow);
    if (!plan?.enabled) return {};
    const originalId = plan.id;
    const guard = async () => {
      const saved = readAutomaticJudge(escrow);
      if (!permitted() || !saved?.enabled || saved.id !== originalId) throw new Error('Automatic Judge was paused, disabled or replaced.');
      const signer = requireSession(currentSession(), saved);
      await validateAutomaticJudgeSession(client, saved.judge, saved.session, signer.address);
      binding(saved, await loadJudgeSnapshot(client, escrow));
    };
    const fundedGuard = (action: 'record' | 'settle') => async () => {
      await guard();
      const saved = readAutomaticJudge(escrow)!;
      const signer = requireSession(currentSession(), saved);
      const live = await loadJudgeSnapshot(client, escrow);
      if (!live.funded || action === 'record' && (live.decision || live.mandate?.used) || action === 'settle' && (!live.decision || live.decision.settled || live.decision.verdict === 'needs_review')) throw new Error('Automatic Judge action no longer has a live on-chain outcome to commit.');
      const quotedRent = await rent(client, live, action);
      const limit = BigInt(action === 'record' ? saved.recordRentLimit : saved.settleRentLimit);
      if (quotedRent > limit || (await client.rpc.getBalance(signer.address, { commitment: 'confirmed' }).send()).value < quotedRent + BigInt(saved.maxFeeLamports)) throw new Error('Reviewed rent ceiling or Session fee reserve no longer permits this transaction.');
    };
    try {
      const terminal = await loadJudgeSnapshot(client, escrow);
      if (!terminal.funded || terminal.decision?.settled) {
        assertJudgeTerminalOutcome(plan, terminal);
        patch(plan, { phase: 'complete', enabled: false, error: undefined });
        return { snapshot: terminal, message: 'Escrow has already completed; no signing key or further transaction is required.' };
      }
      await guard();
      let live = await loadJudgeSnapshot(client, escrow); binding(plan, live);
      if (!live.funded || live.decision?.settled) { patch(plan, { phase: 'complete', enabled: false }); return { snapshot: live, message: 'Escrow has already completed.' }; }
      if (plan.resultHash === null) {
        if (!live.resultHash) return { snapshot: live, message: 'Automatic Judge is waiting for the Worker result commitment.' };
        let shared: Awaited<ReturnType<typeof readSharedJudgeTexts>>;
        try { shared = await readSharedJudgeTexts(client, escrow); }
        catch (cause) { return { snapshot: live, message: `Waiting for verified Worker text handoff: ${cause instanceof Error ? cause.message : 'not available'}` }; }
        await guard();
        if (!shared.snapshot.resultHash || shared.snapshot.taskHash !== plan.taskHash) throw new Error('Worker handoff does not match the authorized task.');
        plan = patch(plan, { resultHash: shared.snapshot.resultHash, task: shared.task, result: shared.result });
        return { snapshot: shared.snapshot, message: 'Worker result bound to the automatic Judge authorization after fresh chain hash verification.' };
      }
      const records = readJudgeJournal(escrow);
      if (records.some((item) => ['prepared', 'signed', 'unknown'].includes(item.state))) throw new Error('Check the unresolved Judge transaction manually; no automatic replay.');
      if (!live.decision) {
        if (live.mandate?.used) throw new Error('Judge mandate was consumed but its decision read is unavailable. No assessment or transaction was repeated.');
        if (records.some((item) => item.action === 'record' && item.state !== 'cancelled')) throw new Error('A previous Judge record attempt exists. Recover or handle it manually.');
        if (plan.phase === 'evaluating') throw new Error('Assessment was interrupted. No model request was repeated; explicitly prepare a new automation after checking the prior result.');
        if (!plan.artifact) {
          if (!plan.generate || await judgeDigest(plan.task) !== plan.taskHash || await judgeDigest(plan.result) !== plan.resultHash) throw new Error('Automatic assessment has no verified exact text.');
          plan = patch(plan, { phase: 'evaluating' }); await guard();
          const requestBody = JSON.stringify({ task: plan.task, result: plan.result, taskHash: plan.taskHash, resultHash: plan.resultHash });
          if (new TextEncoder().encode(requestBody).length > 32_000) throw new Error('Automatic assessment request exceeds 32 KB.');
          const response = await fetch('/api/escrow/judge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody, signal: AbortSignal.timeout(120_000) });
          const artifact = await response.text();
          if (!response.ok) throw new Error(JSON.parse(artifact).error ?? 'Automatic assessment failed.');
          await guard(); await parseJudgeArtifact(artifact, live);
          plan = patch(plan, { phase: 'ready', artifact });
        }
        live = await loadJudgeSnapshot(client, escrow); await guard();
        const parsed = await parseJudgeArtifact(plan.artifact!, live);
        const signer = requireSession(currentSession(), plan);
        const rentRequired = await rent(client, live, 'record');
        if (rentRequired > BigInt(plan.recordRentLimit) || (await client.rpc.getBalance(signer.address, { commitment: 'confirmed' }).send()).value < rentRequired + BigInt(plan.maxFeeLamports)) throw new Error('Judge decision rent exceeds its reviewed ceiling or fee reserve is insufficient.');
        const instruction = await buildRecordEscrowJudgment({ feePayer: signer.address, judge: address(plan.judge), session: address(plan.session), signer, escrow: address(escrow), verdict: parsed.verdict, taskHash: judgeHashBytes(plan.taskHash), resultHash: judgeHashBytes(plan.resultHash!), judgmentHash: judgeHashBytes(parsed.hash) });
        await guard(); const checkpoint = await prepareJudgeTransaction(live, 'record', signer.address, instruction, plan.artifact);
        const signature = await sendJudgeTransaction(client, instruction, checkpoint, signer, { maxFeeLamports: BigInt(plan.maxFeeLamports), assertAuthorized: fundedGuard('record') });
        plan = patch(plan, { phase: parsed.verdict === 'needs_review' ? 'needs_review' : 'recorded', enabled: parsed.verdict !== 'needs_review' && plan.settle && Boolean(readAutomaticJudge(escrow)?.enabled) });
        return { snapshot: await loadJudgeSnapshot(client, escrow), message: `Automatic judgment recorded · ${signature.slice(0, 8)}…` };
      }
      const parsed = plan.artifact ? await parseJudgeArtifact(plan.artifact, live) : null;
      if (!parsed || live.decision.judgmentHash !== parsed.hash) throw new Error('Chain decision differs from the saved automatic assessment.');
      if (live.decision.verdict === 'needs_review') { patch(plan, { phase: 'needs_review', enabled: false }); return { snapshot: live, message: 'Judge needs manual review; no settlement was sent.' }; }
      if (!plan.settle) { patch(plan, { phase: 'recorded', enabled: false }); return { snapshot: live }; }
      if (records.some((item) => item.action === 'settle' && item.state !== 'cancelled')) throw new Error('A previous settlement attempt exists. Check its original transaction manually.');
      const signer = requireSession(currentSession(), plan);
      const rentRequired = await rent(client, live, 'settle');
      if (rentRequired > BigInt(plan.settleRentLimit) || (await client.rpc.getBalance(signer.address, { commitment: 'confirmed' }).send()).value < rentRequired + BigInt(plan.maxFeeLamports)) throw new Error('USDC account rent exceeds its reviewed ceiling or Session reserve is insufficient.');
      const instruction = await buildSettleJudgedEscrow({ caller: signer.address, employer: address(live.employer), worker: address(live.worker), escrow: address(escrow), asset: live.asset, execution: live.execution ? address(live.execution) : undefined, task: live.task ? address(live.task) : undefined });
      await guard(); const checkpoint = await prepareJudgeTransaction(live, 'settle', signer.address, instruction);
      const signature = await sendJudgeTransaction(client, instruction, checkpoint, signer, { maxFeeLamports: BigInt(plan.maxFeeLamports), assertAuthorized: fundedGuard('settle') });
      patch(plan, { phase: 'complete', enabled: false });
      return { snapshot: await loadJudgeSnapshot(client, escrow), message: `Automatic Judge settlement confirmed · ${signature.slice(0, 8)}…` };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'Automatic Judge failed.';
      const saved = readAutomaticJudge(escrow);
      if (saved?.id === originalId) patch(saved, { phase: 'error', enabled: false, error: error.slice(0, 500) });
      throw cause;
    }
  });
}
