use crate::*;

pub fn grant(ctx: Context<GrantWorkerDelivery>, expires_at: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    pending(&ctx.accounts.escrow)?;
    validate_session(&ctx.accounts.session, ctx.accounts.worker_agent.key(), &ctx.accounts.worker_agent, ctx.accounts.session.session_key, ESCROW)?;
    require!(!ctx.accounts.policy.paused && ctx.accounts.policy.allowed_actions & ESCROW == ESCROW, AgentOsError::InvalidPermission);
    require!(expires_at > now && expires_at <= ctx.accounts.session.expires_at && expires_at <= ctx.accounts.escrow.deadline, AgentOsError::InvalidExpiry);
    let permit = &mut ctx.accounts.permit;
    permit.escrow = ctx.accounts.escrow.key();
    permit.worker_agent = ctx.accounts.worker_agent.key();
    permit.session = ctx.accounts.session.key();
    permit.expires_at = expires_at;
    permit.revoked = false;
    permit.used = false;
    permit.bump = ctx.bumps.permit;
    emit!(WorkerDeliveryGranted { escrow: permit.escrow, worker_agent: permit.worker_agent, session: permit.session, expires_at });
    Ok(())
}

pub fn revoke(ctx: Context<RevokeWorkerDelivery>) -> Result<()> {
    ctx.accounts.permit.revoked = true;
    emit!(WorkerDeliveryRevoked { escrow: ctx.accounts.permit.escrow, worker_agent: ctx.accounts.worker_agent.key() });
    Ok(())
}

pub fn submit(ctx: Context<SubmitSessionEscrowResult>, result_hash: [u8; 32], sources: Vec<EscrowEvidenceSource>) -> Result<()> {
    pending(&ctx.accounts.escrow)?;
    require!(result_hash != [0; 32], AgentOsError::TaskResultRequired);
    validate_session(&ctx.accounts.session, ctx.accounts.worker_agent.key(), &ctx.accounts.worker_agent, ctx.accounts.session_key.key(), ESCROW)?;
    require!(!ctx.accounts.policy.paused && ctx.accounts.policy.allowed_actions & ESCROW == ESCROW, AgentOsError::InvalidPermission);
    let permit = &mut ctx.accounts.permit;
    require!(!permit.revoked && !permit.used && Clock::get()?.unix_timestamp < permit.expires_at, AgentOsError::InvalidWorkerDelivery);
    if sources.is_empty() {
        require!(ctx.accounts.evidence.is_none() && ctx.remaining_accounts.is_empty(), AgentOsError::InvalidEscrowEvidence);
    } else {
        validate_sources(&ctx.accounts.escrow, &sources, ctx.remaining_accounts, ctx.program_id)?;
        let evidence = ctx.accounts.evidence.as_mut().ok_or(AgentOsError::InvalidEscrowEvidence)?;
        evidence.escrow = ctx.accounts.escrow.key();
        evidence.result_hash = result_hash;
        evidence.sources = sources;
        evidence.bump = ctx.bumps.evidence.ok_or(AgentOsError::InvalidEscrowEvidence)?;
    }
    ctx.accounts.escrow.result_hash = Some(result_hash);
    permit.used = true;
    emit!(EscrowResultSubmitted { agent: ctx.accounts.escrow.agent, worker_agent: ctx.accounts.worker_agent.key(), task_id: ctx.accounts.escrow.task_id, result_hash });
    emit!(WorkerDeliverySubmitted { escrow: ctx.accounts.escrow.key(), session: ctx.accounts.session.key(), result_hash });
    Ok(())
}

fn pending(escrow: &Escrow) -> Result<()> {
    require!(escrow.status == EscrowStatus::Funded, AgentOsError::InvalidEscrowState);
    require!(escrow.result_hash.is_none(), AgentOsError::EscrowResultAlreadySubmitted);
    require!(Clock::get()?.unix_timestamp < escrow.deadline, AgentOsError::EscrowExpired);
    Ok(())
}

pub fn validate_sources(escrow: &Escrow, sources: &[EscrowEvidenceSource], accounts: &[AccountInfo], program_id: &Pubkey) -> Result<()> {
    require!(!sources.is_empty() && sources.len() <= 3 && sources.len() == accounts.len(), AgentOsError::InvalidEscrowEvidence);
    for (index, source) in sources.iter().enumerate() {
        require!(!sources[..index].iter().any(|prior| prior.execution == source.execution), AgentOsError::InvalidEscrowEvidence);
        let info = &accounts[index];
        require_keys_eq!(info.key(), source.execution, AgentOsError::InvalidEscrowEvidence);
        require_keys_eq!(*info.owner, *program_id, AgentOsError::InvalidEscrowEvidence);
        let data = info.try_borrow_data()?;
        let execution = Execution::try_deserialize(&mut &data[..])?;
        let expected = Pubkey::find_program_address(&[b"execution", escrow.worker_agent.as_ref(), &execution.execution_id.to_le_bytes()], program_id).0;
        require_keys_eq!(expected, source.execution, AgentOsError::InvalidEscrowEvidence);
        require!(execution.agent == escrow.worker_agent && matches!(execution.action, ExecutionAction::SkillPayment | ExecutionAction::TaskSkillPayment) && execution.status == ExecutionStatus::Completed && execution.output_hash == Some(source.output_hash), AgentOsError::InvalidEscrowEvidence);
    }
    Ok(())
}

#[derive(Accounts)]
pub struct GrantWorkerDelivery<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump, has_one = owner)] pub worker_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"policy", worker_agent.key().as_ref()], bump = policy.bump, constraint = policy.agent == worker_agent.key() @ AgentOsError::InvalidPermission)] pub policy: Box<Account<'info, Policy>>,
    #[account(seeds = [b"session", worker_agent.key().as_ref(), session.session_key.as_ref()], bump = session.bump, constraint = session.agent == worker_agent.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    #[account(seeds = [b"escrow", escrow.agent.as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorker)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(init_if_needed, payer = owner, space = 8 + WorkerDeliveryPermit::INIT_SPACE, seeds = [b"worker_delivery", escrow.key().as_ref()], bump)] pub permit: Box<Account<'info, WorkerDeliveryPermit>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct RevokeWorkerDelivery<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump, has_one = owner)] pub worker_agent: Box<Account<'info, Agent>>,
    #[account(mut, seeds = [b"worker_delivery", permit.escrow.as_ref()], bump = permit.bump, constraint = permit.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorkerDelivery)] pub permit: Box<Account<'info, WorkerDeliveryPermit>>,
}
#[derive(Accounts)]
pub struct SubmitSessionEscrowResult<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(seeds = [b"agent", worker_agent.owner.as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump)] pub worker_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"policy", worker_agent.key().as_ref()], bump = policy.bump, constraint = policy.agent == worker_agent.key() @ AgentOsError::InvalidPermission)] pub policy: Box<Account<'info, Policy>>,
    #[account(seeds = [b"session", worker_agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == worker_agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    #[account(mut, seeds = [b"escrow", escrow.agent.as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorker)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(mut, seeds = [b"worker_delivery", escrow.key().as_ref()], bump = permit.bump, constraint = permit.escrow == escrow.key() && permit.worker_agent == worker_agent.key() && permit.session == session.key() @ AgentOsError::InvalidWorkerDelivery)] pub permit: Box<Account<'info, WorkerDeliveryPermit>>,
    #[account(init, payer = fee_payer, space = 8 + EscrowEvidence::INIT_SPACE, seeds = [b"escrow_evidence", escrow.key().as_ref()], bump)] pub evidence: Option<Box<Account<'info, EscrowEvidence>>>,
    pub system_program: Program<'info, System>,
}
#[account]
#[derive(InitSpace)]
pub struct WorkerDeliveryPermit {
    pub escrow: Pubkey, pub worker_agent: Pubkey, pub session: Pubkey, pub expires_at: i64,
    pub revoked: bool, pub used: bool, pub bump: u8,
}
#[event] pub struct WorkerDeliveryGranted { pub escrow: Pubkey, pub worker_agent: Pubkey, pub session: Pubkey, pub expires_at: i64 }
#[event] pub struct WorkerDeliveryRevoked { pub escrow: Pubkey, pub worker_agent: Pubkey }
#[event] pub struct WorkerDeliverySubmitted { pub escrow: Pubkey, pub session: Pubkey, pub result_hash: [u8;32] }
