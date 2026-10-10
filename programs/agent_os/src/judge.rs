use crate::*;

/// A single immutable proposal, agreed before the Worker submits its result.
pub fn propose(ctx: Context<ProposeEscrowJudge>, expires_at: i64) -> Result<()> {
    open_before_result(&ctx.accounts.escrow)?;
    let judge = &ctx.accounts.judge_agent;
    require!(judge.key() != ctx.accounts.employer_agent.key() && judge.key() != ctx.accounts.worker_agent.key()
        && judge.owner != ctx.accounts.employer_agent.owner && judge.owner != ctx.accounts.worker_agent.owner,
        AgentOsError::JudgeMustBeIndependent);
    validate_judge(judge, &ctx.accounts.policy, &ctx.accounts.session, ctx.accounts.session.session_key)?;
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now && expires_at <= ctx.accounts.escrow.deadline && expires_at <= ctx.accounts.session.expires_at, AgentOsError::InvalidExpiry);
    let mandate = &mut ctx.accounts.mandate;
    mandate.escrow = ctx.accounts.escrow.key();
    mandate.employer_agent = ctx.accounts.employer_agent.key();
    mandate.worker_agent = ctx.accounts.worker_agent.key();
    mandate.judge_agent = judge.key();
    mandate.session = ctx.accounts.session.key();
    mandate.task_hash = ctx.accounts.escrow.task_hash;
    mandate.expires_at = expires_at;
    mandate.accepted_at = 0;
    mandate.accepted = false;
    mandate.declined = false;
    mandate.used = false;
    mandate.bump = ctx.bumps.mandate;
    emit!(EscrowJudgeProposed { escrow: mandate.escrow, judge_agent: mandate.judge_agent, session: mandate.session, expires_at });
    Ok(())
}

pub fn accept(ctx: Context<AcceptEscrowJudge>, expected: JudgeTerms) -> Result<()> {
    open_before_result(&ctx.accounts.escrow)?;
    let mandate = &mut ctx.accounts.mandate;
    require!(!mandate.accepted && !mandate.declined && !mandate.used, AgentOsError::InvalidJudgeMandate);
    require!(expected.judge_agent == mandate.judge_agent && expected.session == mandate.session
        && expected.task_hash == mandate.task_hash && expected.expires_at == mandate.expires_at,
        AgentOsError::JudgeTermsChanged);
    require!(Clock::get()?.unix_timestamp < mandate.expires_at, AgentOsError::JudgeExpired);
    mandate.accepted = true;
    mandate.accepted_at = Clock::get()?.unix_timestamp;
    emit!(EscrowJudgeAccepted { escrow: mandate.escrow, worker_agent: mandate.worker_agent });
    Ok(())
}

pub fn decline(ctx: Context<DeclineEscrowJudge>) -> Result<()> {
    let mandate = &mut ctx.accounts.mandate;
    require!(ctx.accounts.owner.key() == ctx.accounts.employer_agent.owner || ctx.accounts.owner.key() == ctx.accounts.worker_agent.owner, AgentOsError::UnauthorizedSettlementParty);
    require!(!mandate.accepted && !mandate.used && !mandate.declined, AgentOsError::InvalidJudgeMandate);
    mandate.declined = true;
    emit!(EscrowJudgeDeclined { escrow: mandate.escrow });
    Ok(())
}

pub fn record(ctx: Context<RecordEscrowJudgment>, verdict: JudgeVerdict, task_hash: [u8; 32], result_hash: [u8; 32], judgment_hash: [u8; 32]) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let mandate = &mut ctx.accounts.mandate;
    require!(escrow.status == EscrowStatus::Funded, AgentOsError::InvalidEscrowState);
    require!(mandate.accepted && !mandate.declined && !mandate.used, AgentOsError::InvalidJudgeMandate);
    require!(Clock::get()?.unix_timestamp < mandate.expires_at && Clock::get()?.unix_timestamp < escrow.deadline, AgentOsError::JudgeExpired);
    require!(task_hash == escrow.task_hash && task_hash == mandate.task_hash && escrow.result_hash == Some(result_hash)
        && result_hash != [0; 32] && judgment_hash != [0; 32], AgentOsError::JudgeCommitmentMismatch);
    validate_judge(&ctx.accounts.judge_agent, &ctx.accounts.policy, &ctx.accounts.session, ctx.accounts.session_key.key())?;
    let decision = &mut ctx.accounts.decision;
    decision.escrow = escrow.key();
    decision.mandate = mandate.key();
    decision.judge_agent = ctx.accounts.judge_agent.key();
    decision.session = ctx.accounts.session.key();
    decision.task_hash = task_hash;
    decision.result_hash = result_hash;
    decision.judgment_hash = judgment_hash;
    decision.verdict = verdict;
    decision.recorded_at = Clock::get()?.unix_timestamp;
    decision.settled = false;
    decision.bump = ctx.bumps.decision;
    mandate.used = true;
    emit!(EscrowJudgmentRecorded { escrow: escrow.key(), judge_agent: decision.judge_agent, verdict, judgment_hash });
    Ok(())
}

fn open_before_result(escrow: &Escrow) -> Result<()> {
    require!(escrow.status == EscrowStatus::Funded && escrow.result_hash.is_none(), AgentOsError::InvalidEscrowState);
    require!(Clock::get()?.unix_timestamp < escrow.deadline, AgentOsError::EscrowExpired);
    Ok(())
}

fn validate_judge(judge: &Account<Agent>, policy: &Policy, session: &Session, signer: Pubkey) -> Result<()> {
    validate_session(session, judge.key(), judge, signer, API)?;
    require!(!policy.paused && policy.agent == judge.key() && policy.allowed_actions & API == API, AgentOsError::InvalidPermission);
    Ok(())
}

fn check_settlement(escrow: &Escrow, mandate: &JudgeMandate, decision: &JudgeDecision) -> Result<()> {
    require!(escrow.status == EscrowStatus::Funded, AgentOsError::InvalidEscrowState);
    require!(mandate.accepted && !mandate.declined && mandate.used && !decision.settled, AgentOsError::InvalidJudgeMandate);
    require!(Clock::get()?.unix_timestamp < mandate.expires_at && Clock::get()?.unix_timestamp < escrow.deadline, AgentOsError::JudgeExpired);
    require!(decision.task_hash == mandate.task_hash && decision.task_hash == escrow.task_hash
        && escrow.result_hash == Some(decision.result_hash) && decision.judge_agent == mandate.judge_agent
        && decision.session == mandate.session && decision.recorded_at >= mandate.accepted_at
        && decision.recorded_at < mandate.expires_at, AgentOsError::JudgeCommitmentMismatch);
    require!(decision.verdict != JudgeVerdict::NeedsReview, AgentOsError::JudgeNeedsReview);
    Ok(())
}

pub fn settle_sol(ctx: Context<SettleJudgedEscrow>) -> Result<()> {
    check_settlement(&ctx.accounts.escrow, &ctx.accounts.mandate, &ctx.accounts.decision)?;
    require!(ctx.accounts.escrow.asset == ExecutionAsset::Sol, AgentOsError::InvalidAsset);
    let passed = ctx.accounts.decision.verdict == JudgeVerdict::Pass;
    if passed { record_escrow_execution_result(&ctx.accounts.escrow, &mut ctx.accounts.execution, ctx.accounts.decision.result_hash, ctx.program_id)?; }
    else { record_escrow_execution_refund(&ctx.accounts.escrow, &mut ctx.accounts.execution, ctx.program_id)?; }
    let destination = if passed { ctx.accounts.worker_vault.to_account_info() } else { ctx.accounts.employer_vault.to_account_info() };
    move_lamports(&ctx.accounts.escrow.to_account_info(), &destination, ctx.accounts.escrow.amount)?;
    complete(&mut ctx.accounts.escrow, &mut ctx.accounts.decision, &mut ctx.accounts.worker_reputation, ctx.accounts.employer_agent.owner != ctx.accounts.worker_agent.owner)?;
    task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)
}

pub fn settle_usdc(ctx: Context<SettleJudgedUsdcEscrow>) -> Result<()> {
    check_settlement(&ctx.accounts.escrow, &ctx.accounts.mandate, &ctx.accounts.decision)?;
    require!(ctx.accounts.escrow.asset == ExecutionAsset::Usdc, AgentOsError::InvalidAsset);
    require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
    let passed = ctx.accounts.decision.verdict == JudgeVerdict::Pass;
    if passed { record_escrow_execution_result(&ctx.accounts.escrow, &mut ctx.accounts.execution, ctx.accounts.decision.result_hash, ctx.program_id)?; }
    else { record_escrow_execution_refund(&ctx.accounts.escrow, &mut ctx.accounts.execution, ctx.program_id)?; }
    let task_id = ctx.accounts.escrow.task_id.to_le_bytes();
    let bump = [ctx.accounts.escrow.bump];
    let agent = ctx.accounts.escrow.agent;
    let seeds: &[&[u8]] = &[b"escrow", agent.as_ref(), &task_id, &bump];
    let destination = if passed { ctx.accounts.worker_token_account.to_account_info() } else { ctx.accounts.employer_token_account.to_account_info() };
    token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
        from: ctx.accounts.escrow_token_account.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
        to: destination, authority: ctx.accounts.escrow.to_account_info(),
    }, &[seeds]), ctx.accounts.escrow.amount, USDC_DECIMALS)?;
    complete(&mut ctx.accounts.escrow, &mut ctx.accounts.decision, &mut ctx.accounts.worker_reputation, ctx.accounts.employer_agent.owner != ctx.accounts.worker_agent.owner)?;
    task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)
}

fn complete(escrow: &mut Escrow, decision: &mut JudgeDecision, reputation: &mut Reputation, distinct_owners: bool) -> Result<()> {
    let passed = decision.verdict == JudgeVerdict::Pass;
    if distinct_owners {
        reputation.completed_tasks = reputation.completed_tasks.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        if passed {
            reputation.successful_tasks = reputation.successful_tasks.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
            let volume = if escrow.asset == ExecutionAsset::Sol { &mut reputation.total_volume_lamports } else { &mut reputation.total_volume_usdc };
            *volume = volume.checked_add(escrow.amount).ok_or(AgentOsError::MathOverflow)?;
            reputation.score = reputation.score.saturating_add(10).min(10_000);

        } else {
            reputation.failed_tasks = reputation.failed_tasks.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
            reputation.score = reputation.score.saturating_sub(10);

        }
    } else {
        emit!(ReputationExcludedSelfSettlement { worker_agent: escrow.worker_agent, task_id: escrow.task_id, amount: escrow.amount, asset: escrow.asset });
    }
    escrow.status = if passed { EscrowStatus::Released } else { EscrowStatus::Refunded };
    decision.settled = true;
    emit!(JudgedEscrowSettled { escrow_agent: escrow.agent, task_id: escrow.task_id, verdict: decision.verdict, amount: escrow.amount, asset: escrow.asset });
    Ok(())
}

#[derive(Accounts)]
pub struct ProposeEscrowJudge<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), employer_agent.agent_id.as_ref()], bump = employer_agent.bump, has_one = owner)] pub employer_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"agent", worker_agent.owner.as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump)] pub worker_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"escrow", employer_agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.agent == employer_agent.key() && escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidEscrow)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(seeds = [b"agent", judge_agent.owner.as_ref(), judge_agent.agent_id.as_ref()], bump = judge_agent.bump)] pub judge_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"policy", judge_agent.key().as_ref()], bump = policy.bump)] pub policy: Box<Account<'info, Policy>>,
    #[account(seeds = [b"session", judge_agent.key().as_ref(), session.session_key.as_ref()], bump = session.bump, constraint = session.agent == judge_agent.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    #[account(init, payer = owner, space = 8 + JudgeMandate::INIT_SPACE, seeds = [b"escrow_judge", escrow.key().as_ref()], bump)] pub mandate: Box<Account<'info, JudgeMandate>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptEscrowJudge<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump, has_one = owner)] pub worker_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"escrow", escrow.agent.as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorker)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(mut, seeds = [b"escrow_judge", escrow.key().as_ref()], bump = mandate.bump, constraint = mandate.escrow == escrow.key() && mandate.worker_agent == worker_agent.key() && mandate.employer_agent == escrow.agent && mandate.task_hash == escrow.task_hash @ AgentOsError::InvalidJudgeMandate)] pub mandate: Box<Account<'info, JudgeMandate>>,
}

#[derive(Accounts)]
pub struct DeclineEscrowJudge<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"agent", employer_agent.owner.as_ref(), employer_agent.agent_id.as_ref()], bump = employer_agent.bump)] pub employer_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"agent", worker_agent.owner.as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump)] pub worker_agent: Box<Account<'info, Agent>>,
    #[account(mut, seeds = [b"escrow_judge", mandate.escrow.as_ref()], bump = mandate.bump, constraint = mandate.employer_agent == employer_agent.key() && mandate.worker_agent == worker_agent.key() @ AgentOsError::InvalidJudgeMandate)] pub mandate: Box<Account<'info, JudgeMandate>>,
}

#[derive(Accounts)]
pub struct RecordEscrowJudgment<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(seeds = [b"agent", judge_agent.owner.as_ref(), judge_agent.agent_id.as_ref()], bump = judge_agent.bump)] pub judge_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"policy", judge_agent.key().as_ref()], bump = policy.bump)] pub policy: Box<Account<'info, Policy>>,
    #[account(seeds = [b"session", judge_agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == judge_agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    #[account(seeds = [b"escrow", escrow.agent.as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(mut, seeds = [b"escrow_judge", escrow.key().as_ref()], bump = mandate.bump, constraint = mandate.escrow == escrow.key() && mandate.judge_agent == judge_agent.key() && mandate.session == session.key() @ AgentOsError::InvalidJudgeMandate)] pub mandate: Box<Account<'info, JudgeMandate>>,
    #[account(init, payer = fee_payer, space = 8 + JudgeDecision::INIT_SPACE, seeds = [b"escrow_decision", escrow.key().as_ref()], bump)] pub decision: Box<Account<'info, JudgeDecision>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleJudgedEscrow<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [b"agent", employer_agent.owner.as_ref(), employer_agent.agent_id.as_ref()], bump = employer_agent.bump)] pub employer_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"agent", worker_agent.owner.as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump)] pub worker_agent: Box<Account<'info, Agent>>,
    #[account(mut, seeds = [b"escrow", employer_agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.agent == employer_agent.key() && escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidEscrow)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(seeds = [b"escrow_judge", escrow.key().as_ref()], bump = mandate.bump, constraint = mandate.escrow == escrow.key() && mandate.employer_agent == employer_agent.key() && mandate.worker_agent == worker_agent.key() @ AgentOsError::InvalidJudgeMandate)] pub mandate: Box<Account<'info, JudgeMandate>>,
    #[account(mut, seeds = [b"escrow_decision", escrow.key().as_ref()], bump = decision.bump, constraint = decision.escrow == escrow.key() && decision.mandate == mandate.key() @ AgentOsError::InvalidJudgeMandate)] pub decision: Box<Account<'info, JudgeDecision>>,
    /// CHECK: Funds can only return to the employer's canonical system-owned vault.
    #[account(mut, seeds = [b"vault", employer_agent.key().as_ref()], bump, constraint = employer_vault.owner == &system_program::ID && employer_vault.data_len() == 0)] pub employer_vault: UncheckedAccount<'info>,
    /// CHECK: Funds can only reach the worker's canonical system-owned vault.
    #[account(mut, seeds = [b"vault", worker_agent.key().as_ref()], bump, constraint = worker_vault.owner == &system_program::ID && worker_vault.data_len() == 0)] pub worker_vault: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"reputation", worker_agent.key().as_ref()], bump = worker_reputation.bump, constraint = worker_reputation.agent == worker_agent.key() @ AgentOsError::InvalidReputation)] pub worker_reputation: Box<Account<'info, Reputation>>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}

#[derive(Accounts)]
pub struct SettleJudgedUsdcEscrow<'info> {
    #[account(mut)] pub caller: Signer<'info>,
    #[account(seeds = [b"agent", employer_agent.owner.as_ref(), employer_agent.agent_id.as_ref()], bump = employer_agent.bump)] pub employer_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"agent", worker_agent.owner.as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump)] pub worker_agent: Box<Account<'info, Agent>>,
    #[account(mut, seeds = [b"escrow", employer_agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.agent == employer_agent.key() && escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidEscrow)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(seeds = [b"escrow_judge", escrow.key().as_ref()], bump = mandate.bump, constraint = mandate.escrow == escrow.key() && mandate.employer_agent == employer_agent.key() && mandate.worker_agent == worker_agent.key() @ AgentOsError::InvalidJudgeMandate)] pub mandate: Box<Account<'info, JudgeMandate>>,
    #[account(mut, seeds = [b"escrow_decision", escrow.key().as_ref()], bump = decision.bump, constraint = decision.escrow == escrow.key() && decision.mandate == mandate.key() @ AgentOsError::InvalidJudgeMandate)] pub decision: Box<Account<'info, JudgeDecision>>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = escrow)] pub escrow_token_account: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = caller, associated_token::mint = usdc_mint, associated_token::authority = employer_agent)] pub employer_token_account: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = caller, associated_token::mint = usdc_mint, associated_token::authority = worker_agent)] pub worker_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"reputation", worker_agent.key().as_ref()], bump = worker_reputation.bump, constraint = worker_reputation.agent == worker_agent.key() @ AgentOsError::InvalidReputation)] pub worker_reputation: Box<Account<'info, Reputation>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct JudgeTerms { pub judge_agent: Pubkey, pub session: Pubkey, pub expires_at: i64, pub task_hash: [u8; 32] }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum JudgeVerdict { Pass, Fail, NeedsReview }
#[account]
#[derive(InitSpace)]
pub struct JudgeMandate {
    pub escrow: Pubkey, pub employer_agent: Pubkey, pub worker_agent: Pubkey,
    pub judge_agent: Pubkey, pub session: Pubkey, pub task_hash: [u8; 32],
    pub expires_at: i64, pub accepted_at: i64, pub accepted: bool, pub declined: bool, pub used: bool, pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct JudgeDecision {
    pub escrow: Pubkey, pub mandate: Pubkey, pub judge_agent: Pubkey, pub session: Pubkey,
    pub task_hash: [u8; 32], pub result_hash: [u8; 32], pub judgment_hash: [u8; 32],
    pub verdict: JudgeVerdict, pub recorded_at: i64, pub settled: bool, pub bump: u8,
}
#[event] pub struct EscrowJudgeProposed { pub escrow: Pubkey, pub judge_agent: Pubkey, pub session: Pubkey, pub expires_at: i64 }
#[event] pub struct EscrowJudgeAccepted { pub escrow: Pubkey, pub worker_agent: Pubkey }
#[event] pub struct EscrowJudgeDeclined { pub escrow: Pubkey }
#[event] pub struct EscrowJudgmentRecorded { pub escrow: Pubkey, pub judge_agent: Pubkey, pub verdict: JudgeVerdict, pub judgment_hash: [u8;32] }
#[event] pub struct JudgedEscrowSettled { pub escrow_agent: Pubkey, pub task_id: u64, pub verdict: JudgeVerdict, pub amount: u64, pub asset: ExecutionAsset }
