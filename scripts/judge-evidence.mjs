// Read-only Judge evidence. Helpers enforce finalized Devnet and Program ownership.
export async function verifyJudgeEvidence(endpoint, programId, input, h) {
  const { requireThat: must, account, pda, pubkey, addressBytes, addressText, digest, transaction } = h;
  must(input && typeof input.task === 'string' && input.task.trim() && input.task.length <= 400 && typeof input.result === 'string' && input.result.trim() && input.result.length <= 6000, 'Judge evidence needs exact task and result text.');
  const escrow = pubkey(input.escrow);
  const key = (bytes, offset) => addressText.decode(bytes.subarray(offset, offset + 32));
  const seed = (value) => addressBytes.encode(pubkey(value));
  const e = (await account(endpoint, escrow, programId, 'Escrow')).bytes;
  must(e.length === 180 && e[128] === 1 && e[161] <= 5 && e[179] <= 1, 'Judge Escrow layout or result commitment is invalid.');
  const employer = key(e, 8), worker = key(e, 40);
  must(await pda(programId, [Buffer.from('escrow'), seed(employer), e.subarray(72, 80)]) === escrow, 'Judge Escrow PDA is not canonical.');
  const taskHash = e.subarray(96, 128).toString('hex'), resultHash = e.subarray(129, 161).toString('hex');
  must(digest(input.task.trim()) === taskHash && digest(input.result.trim()) === resultHash, 'Judge task or delivery text differs from chain commitments.');
  // Bind both authorization parties and the immutable decision to this Escrow.
  const mandate = await pda(programId, [Buffer.from('escrow_judge'), seed(escrow)]);
  const decision = await pda(programId, [Buffer.from('escrow_decision'), seed(escrow)]);
  const m = (await account(endpoint, mandate, programId, 'JudgeMandate')).bytes;
  const d = (await account(endpoint, decision, programId, 'JudgeDecision')).bytes;
  must(m.length === 220 && key(m, 8) === escrow && key(m, 40) === employer && key(m, 72) === worker && m[216] === 1 && m[217] === 0 && m[218] === 1 && m.subarray(168, 200).toString('hex') === taskHash, 'Judge mandate is not accepted, consumed and bound to the parties.');
  const judge = key(m, 104), session = key(m, 136), expiry = m.readBigInt64LE(200), acceptedAt = m.readBigInt64LE(208);
  must(d.length === 243 && key(d, 8) === escrow && key(d, 40) === mandate && key(d, 72) === judge && key(d, 104) === session && d.subarray(136, 168).toString('hex') === taskHash && d.subarray(168, 200).toString('hex') === resultHash && d[232] <= 2 && d[241] <= 1, 'Judge decision does not match its mandate and commitments.');
  const recordedAt = d.readBigInt64LE(233), judgmentHash = d.subarray(200, 232).toString('hex');
  must(acceptedAt > 0n && acceptedAt <= recordedAt && recordedAt < expiry && expiry <= e.readBigInt64LE(88) && judgmentHash !== '0'.repeat(64), 'Judge timestamps or judgment hash are invalid.');
  const agents = {};
  for (const agent of [employer, worker, judge]) {
    const a = (await account(endpoint, agent, programId, 'Agent')).bytes;
    must(a.length === 138 && await pda(programId, [Buffer.from('agent'), a.subarray(8, 40), a.subarray(40, 72)]) === agent, 'Judge party Agent PDA or layout is invalid.');
    agents[agent] = key(a, 8);
  }
  must(judge !== employer && judge !== worker && agents[judge] !== agents[employer] && agents[judge] !== agents[worker], 'Judge is not independent of both parties.');
  const s = (await account(endpoint, session, programId, 'Session')).bytes;
  must(s.length === 147 && key(s, 8) === judge && await pda(programId, [Buffer.from('session'), seed(judge), s.subarray(40, 72)]) === session && recordedAt < s.readBigInt64LE(72), 'Judge Session layout, signer or historical expiry is invalid.');
  const signer = key(s, 40), policy = await pda(programId, [Buffer.from('policy'), seed(judge)]);
  // Recreate Runtime’s ordered commitment without rewriting nested check fields.
  const artifact = input.artifact;
  must(artifact && Buffer.byteLength(JSON.stringify(artifact)) <= 32768 && artifact.network === 'devnet-preview' && artifact.programId === programId && artifact.taskHash === taskHash && artifact.resultHash === resultHash, 'Provide the original Judge artifact for this Program and result.');
  const verdicts = ['pass', 'fail', 'needs_review'], verdict = verdicts[d[232]];
  must(artifact.verdict === verdict && Number.isFinite(artifact.confidence) && artifact.confidence >= 0 && artifact.confidence <= 1 && typeof artifact.summary === 'string' && artifact.summary.trim() && artifact.summary.length <= 600 && Array.isArray(artifact.checks) && artifact.checks.length <= 8 && artifact.checks.every(c => c && typeof c.criterion === 'string' && c.criterion.length > 0 && c.criterion.length <= 240 && ['met', 'not_met', 'unclear'].includes(c.status) && typeof c.evidence === 'string' && c.evidence.length <= 400) && Array.isArray(artifact.limitations) && artifact.limitations.length <= 6 && artifact.limitations.every(v => typeof v === 'string' && v.length > 0 && v.length <= 240) && typeof artifact.model === 'string' && Number.isFinite(Date.parse(artifact.evaluatedAt)), 'Judge artifact fields are invalid.');
  must(verdict !== 'pass' || artifact.checks.length > 0 && artifact.checks.every(c => c.status === 'met'), 'Pass lacks met criteria.');
  must(verdict !== 'fail' || artifact.checks.some(c => c.status === 'not_met'), 'Fail lacks a failed criterion.');
  const body = { taskHash, resultHash, verdict, confidence: artifact.confidence, summary: artifact.summary, checks: artifact.checks, limitations: artifact.limitations, model: artifact.model, evaluatedAt: artifact.evaluatedAt };
  must(digest(JSON.stringify(body)) === judgmentHash && artifact.judgmentHash === judgmentHash, 'Judge artifact differs from the signed judgment commitment.');
  // Required signer positions are static message signers, not lookup-table entries.
  const proposal = await transaction(endpoint, input.proposalSignature, programId, ['propose_escrow_judge'], { 0: agents[employer], 1: employer, 2: worker, 3: escrow, 4: judge, 5: policy, 6: session, 7: mandate }, data => data.length === 16 && data.readBigInt64LE(8) === expiry, [0]);
  const acceptance = await transaction(endpoint, input.acceptanceSignature, programId, ['accept_escrow_judge'], { 0: agents[worker], 1: worker, 2: escrow, 3: mandate }, data => data.length === 112 && key(data, 8) === judge && key(data, 40) === session && data.readBigInt64LE(72) === expiry && data.subarray(80).toString('hex') === taskHash, [0]);
  const recording = await transaction(endpoint, input.recordingSignature, programId, ['record_escrow_judgment'], { 0: signer, 2: judge, 3: policy, 4: session, 5: escrow, 6: mandate, 7: decision }, data => data.length === 105 && data[8] === d[232] && data.subarray(9, 41).toString('hex') === taskHash && data.subarray(41, 73).toString('hex') === resultHash && data.subarray(73).toString('hex') === judgmentHash, [0, 1]);
  must(proposal.slot <= acceptance.slot && acceptance.slot <= recording.slot && Number.isSafeInteger(acceptance.blockTime) && BigInt(acceptance.blockTime) < expiry && Number.isSafeInteger(recording.blockTime) && BigInt(recording.blockTime) < expiry, 'Judge transaction sequence or recorded timestamps differ.');
  let settlement = null; let workerReputation = null;
  if (input.settlementSignature) {
    must(verdict !== 'needs_review' && d[241] === 1 && e[161] === (verdict === 'pass' ? 1 : 2), 'Judge decision is not settled in its fixed outcome.');
    const reputation = await pda(programId, [Buffer.from('reputation'), seed(worker)]);
    const positions = { 1: employer, 2: worker, 3: escrow, 4: mandate, 5: decision, [e[179] === 0 ? 8 : 10]: reputation };
    if (e[179] === 0) {
      positions[6] = await pda(programId, [Buffer.from('vault'), seed(employer)]);
      positions[7] = await pda(programId, [Buffer.from('vault'), seed(worker)]);
    } else {
      const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const associated = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
      const mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
      positions[6] = mint;
      for (const [index, authority] of [[7, escrow], [8, employer], [9, worker]]) positions[index] = await pda(associated, [seed(authority), seed(token), seed(mint)]);
      positions[11] = token; positions[12] = associated; positions[13] = '11111111111111111111111111111111';
    }
    const r = (await account(endpoint, reputation, programId, 'Reputation')).bytes;
    must(r.length === 113 && key(r, 8) === worker && r.readBigUInt64LE(72) <= 10000n, 'Judge Worker Reputation snapshot is invalid.');
    workerReputation = { address: reputation, completedTasks: r.readBigUInt64LE(40).toString(), successfulTasks: r.readBigUInt64LE(48).toString(), failedTasks: r.readBigUInt64LE(56).toString(), score: r.readBigUInt64LE(72).toString() };
    const taskScoped = e.subarray(171, 179).equals(Buffer.from('AGTSK001'));
    must(taskScoped || e.subarray(171, 179).equals(Buffer.from('AGEXE001')), 'Judge settlement lacks a linked funding Execution.');
    const execution = await pda(programId, [Buffer.from('execution'), seed(employer), e.subarray(163, 171)]);
    positions[e[179] === 0 ? 9 : 14] = execution;
    const x = (await account(endpoint, execution, programId, 'Execution')).bytes;
    must(x.length === 132 && key(x, 8) === employer && x.subarray(40, 48).equals(e.subarray(163, 171)) && x[48] === e[179] && x[49] === 2 && x.readBigUInt64LE(50) === e.readBigUInt64LE(80) && x.subarray(66, 98).toString('hex') === taskHash, 'Judge funding Execution binding is invalid.');
    must(verdict === 'pass' ? x[98] === 1 && x[131] === 0 && x.subarray(99, 131).toString('hex') === resultHash : x[98] === 0 && x[99] === 1, 'Judge funding Execution has a different settlement outcome.');
    if (taskScoped) {
      const link = await pda(programId, [Buffer.from('task_escrow'), seed(escrow)]);
      const l = (await account(endpoint, link, programId, 'TaskEscrow')).bytes;
      must(l.length === 106 && key(l, 40) === escrow && key(l, 72) === execution && l[104] === 1, 'Judge TaskEscrow link is not closed.');
      const parent = key(l, 8), t = (await account(endpoint, parent, programId, 'Task')).bytes;
      must(t.length === 227 && key(t, 8) === employer && await pda(programId, [Buffer.from('task'), seed(employer), t.subarray(72, 80)]) === parent, 'Judge parent Task is invalid.');
      positions[e[179] === 0 ? 10 : 15] = link;
      positions[e[179] === 0 ? 11 : 16] = parent;
    }
    settlement = await transaction(endpoint, input.settlementSignature, programId, [e[179] === 0 ? 'settle_judged_escrow' : 'settle_judged_usdc_escrow'], positions, data => data.length === 8, [0]);
    must(recording.slot <= settlement.slot && Number.isSafeInteger(settlement.blockTime) && BigInt(settlement.blockTime) < expiry && BigInt(settlement.blockTime) < e.readBigInt64LE(88), 'Judge settlement is out of order or beyond its deadline.');
  } else must(d[241] === 0, 'Settled Judge decision requires its settlement signature.');
  return { status: settlement ? 'verified-judge-fixed-settlement' : 'verified-judge-decision-unsettled', escrow, employer, worker, judge, session, signer, mandate, decision, verdict, amount: e.readBigUInt64LE(80).toString(), asset: e[179] === 0 ? 'SOL' : 'USDC', taskHash, resultHash, judgmentHash, artifact, escrowStatus: ['funded', 'released', 'refunded', 'cancelled', 'settlement_proposed', 'settled'][e[161]], proposal, acceptance, recording, settlement, workerReputation, reputationAttribution: { employerOwner: agents[employer], workerOwner: agents[worker], sameOwner: agents[employer] === agents[worker], latestSourceRule: 'same-owner-settlements-excluded', historicalIncrementVerified: false, limitation: 'A current Reputation snapshot is not a transaction delta or historical deployed-binary proof.' }, limitations: ['Funding and Worker submission transactions are not verified by this Judge report. Successful Program execution enforces fixed settlement destinations; this report does not calculate recipient balance deltas.', 'The artifact matches the signed commitment; model invocation, assessment quality, browser automation and reputation increments are not proved.', 'Current Session revocation or Policy changes do not invalidate a historical successful judgment. Unsettled decisions do not prove any payout or refund.'] };
}
