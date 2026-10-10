use super::*;

const SESSION_MARKER: [u8; 8] = *b"AGTASK01";

// Dedicated Sessions cannot evade a task cap by calling a legacy payment route.
pub(crate) fn validate_session_scope(session: &Session, expected: Option<u64>) -> Result<()> {
    let bound = session.reserved[8..] == SESSION_MARKER;
    match expected {
        Some(id) => require!(bound && session.reserved[..8] == id.to_le_bytes(), AgentOsError::InvalidTaskSession),
        None => require!(!bound, AgentOsError::InvalidTaskSession),
    }
    Ok(())
}

pub(crate) fn create(ctx: Context<CreateTask>, id: u64, task_hash: [u8; 32], max_sol: u64, max_usdc: u64, deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let session = &mut ctx.accounts.session;
    require!(ctx.accounts.agent.status == AgentStatus::Active && !session.revoked && session.expires_at > now, AgentOsError::InvalidSession);
    require!(session.reserved == [0; 16], AgentOsError::InvalidTaskSession);
    require!(max_sol > 0 || max_usdc > 0, AgentOsError::InvalidLimit);
    require!(max_sol <= session.max_total_lamports.checked_sub(session.spent_lamports).ok_or(AgentOsError::MathOverflow)? && max_usdc <= session.max_total_usdc.checked_sub(session.spent_usdc).ok_or(AgentOsError::MathOverflow)?, AgentOsError::InvalidLimit);
    require!(task_hash != [0; 32], AgentOsError::TaskResultRequired);
    require!(deadline > now && deadline <= session.expires_at && deadline <= now + MAX_SESSION_SECONDS, AgentOsError::InvalidExpiry);
    let task = &mut ctx.accounts.task;
    task.agent = ctx.accounts.agent.key();
    task.session = session.key();
    task.task_id = id;
    task.task_hash = task_hash;
    task.max_sol = max_sol;
    task.max_usdc = max_usdc;
    task.spent_sol = 0;
    task.spent_usdc = 0;
    task.status = TaskStatus::Ready;
    task.result_hash = None;
    task.created_at = now;
    task.updated_at = now;
    task.deadline = deadline;
    task.action_count = 0;
    task.pending_escrows = 0;
    task.pending_skill_results = 0;
    task.bump = ctx.bumps.task;
    session.reserved[..8].copy_from_slice(&id.to_le_bytes());
    session.reserved[8..].copy_from_slice(&SESSION_MARKER);
    emit!(TaskCreated { task: task.key(), agent: task.agent, session: task.session, task_id: id, task_hash, max_sol, max_usdc, deadline });
    Ok(())
}

pub(crate) fn update(ctx: Context<UpdateTask>, next: TaskStatus, result: Option<[u8; 32]>) -> Result<()> {
    let task = &mut ctx.accounts.task;
    require!(!task.status.terminal(), AgentOsError::InvalidTaskState);
    let now = Clock::get()?.unix_timestamp;
    let valid = match next {
        TaskStatus::Running => matches!(task.status, TaskStatus::Ready | TaskStatus::Paused),
        TaskStatus::Paused => matches!(task.status, TaskStatus::Running | TaskStatus::Waiting),
        TaskStatus::Completed => task.status == TaskStatus::Running,
        TaskStatus::Failed | TaskStatus::Cancelled => true,
        _ => false,
    };
    require!(valid, AgentOsError::InvalidTaskState);
    if next == TaskStatus::Running || next == TaskStatus::Completed { require!(now < task.deadline, AgentOsError::TaskExpired); }
    if next == TaskStatus::Completed {
        require!(task.pending_escrows == 0 && task.pending_skill_results == 0 && result.is_some() && result != Some([0; 32]), AgentOsError::TaskResultRequired);
    } else { require!(result.is_none(), AgentOsError::TaskResultRequired); }
    task.status = next;
    task.result_hash = result;
    task.updated_at = now;
    emit!(TaskStatusChanged { task: task.key(), status: next, result_hash: result });
    Ok(())
}

pub(crate) fn replace_session(ctx: Context<ReplaceTaskSession>) -> Result<()> {
    let task = &mut ctx.accounts.task;
    let session = &mut ctx.accounts.session;
    let now = Clock::get()?.unix_timestamp;
    require!(!task.status.terminal() && now < task.deadline, AgentOsError::InvalidTaskState);
    require!(!session.revoked && session.expires_at >= task.deadline && session.reserved == [0; 16], AgentOsError::InvalidTaskSession);
    let remaining_sol = task.max_sol.checked_sub(task.spent_sol).ok_or(AgentOsError::MathOverflow)?;
    let remaining_usdc = task.max_usdc.checked_sub(task.spent_usdc).ok_or(AgentOsError::MathOverflow)?;
    require!(remaining_sol <= session.max_total_lamports.checked_sub(session.spent_lamports).ok_or(AgentOsError::MathOverflow)? && remaining_usdc <= session.max_total_usdc.checked_sub(session.spent_usdc).ok_or(AgentOsError::MathOverflow)?, AgentOsError::InvalidLimit);
    // The previous Session remains task-bound. It cannot use legacy routes, and
    // has_one=session now rejects it on every scoped payment. Budgets never reset.
    session.reserved[..8].copy_from_slice(&task.task_id.to_le_bytes());
    session.reserved[8..].copy_from_slice(&SESSION_MARKER);
    let previous = task.session;
    task.session = session.key();
    task.updated_at = now;
    emit!(TaskSessionReplaced { task: task.key(), previous, session: task.session });
    Ok(())
}

fn charge(task: &mut Account<Task>, session: Pubkey, amount: u64, asset: ExecutionAsset) -> Result<()> {
    require!(task.status == TaskStatus::Running && task.session == session, AgentOsError::InvalidTaskState);
    let now = Clock::get()?.unix_timestamp;
    require!(now < task.deadline, AgentOsError::TaskExpired);
    require!(amount > 0, AgentOsError::InvalidAmount);
    let (spent, limit) = if asset == ExecutionAsset::Sol { (task.spent_sol, task.max_sol) } else { (task.spent_usdc, task.max_usdc) };
    let total = spent.checked_add(amount).ok_or(AgentOsError::MathOverflow)?;
    require!(total <= limit, AgentOsError::TaskBudgetExceeded);
    if asset == ExecutionAsset::Sol { task.spent_sol = total; } else { task.spent_usdc = total; }
    task.action_count = task.action_count.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    task.updated_at = now;
    Ok(())
}

fn receipt(record: &mut Account<TaskAction>, task: Pubkey, execution: Pubkey, amount: u64, asset: ExecutionAsset, action_id: u64, bump: u8) {
    record.task = task;
    record.execution = execution;
    record.amount = amount;
    record.asset = asset;
    record.action_id = action_id;
    record.bump = bump;
    emit!(TaskActionExecuted { task, execution, amount, asset, action_id });
}

pub(crate) fn pay_sol(ctx: Context<ExecuteTaskPayment>, amount: u64, input: [u8; 32], output: [u8; 32], id: u64, action_id: u64) -> Result<()> {
    let agent = ctx.accounts.agent.key();
    charge(&mut ctx.accounts.task, ctx.accounts.session.key(), amount, ExecutionAsset::Sol)?;
    spend_scoped(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, agent, ctx.accounts.session_key.key(), amount, PAY, Some(ctx.accounts.task.task_id))?;
    require!(ctx.accounts.agent.execution_count == id, AgentOsError::UnexpectedExecutionId);
    require!(ctx.accounts.vault.lamports() >= amount, AgentOsError::InsufficientFunds);
    let bump = [ctx.bumps.vault];
    let seeds: &[&[u8]] = &[b"vault", agent.as_ref(), &bump];
    system_program::transfer(CpiContext::new_with_signer(ctx.accounts.system_program.key(), Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.recipient.to_account_info() }, &[seeds]), amount)?;
    init_execution(&mut ctx.accounts.execution, agent, id, ExecutionAsset::Sol, ExecutionAction::Payment, amount, input, Some(output))?;
    ctx.accounts.agent.execution_count = id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    receipt(&mut ctx.accounts.task_action, ctx.accounts.task.key(), ctx.accounts.execution.key(), amount, ExecutionAsset::Sol, action_id, ctx.bumps.task_action);
    emit!(PaymentExecuted { agent, session_key: ctx.accounts.session.session_key, recipient: ctx.accounts.recipient.key(), amount, action: PAY, execution_id: id, input_hash: input, output_hash: output });
    Ok(())
}

pub(crate) fn pay_usdc(ctx: Context<ExecuteTaskUsdcPayment>, amount: u64, input: [u8; 32], output: [u8; 32], id: u64, action_id: u64) -> Result<()> {
    let agent = ctx.accounts.agent.key();
    charge(&mut ctx.accounts.task, ctx.accounts.session.key(), amount, ExecutionAsset::Usdc)?;
    spend_usdc_scoped(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, agent, ctx.accounts.session_key.key(), amount, PAY, Some(ctx.accounts.task.task_id))?;
    require!(ctx.accounts.agent.execution_count == id, AgentOsError::UnexpectedExecutionId);
    require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
    require!(ctx.accounts.vault_token_account.amount >= amount, AgentOsError::InsufficientFunds);
    let owner = ctx.accounts.agent.owner;
    let agent_id = ctx.accounts.agent.agent_id;
    let bump = [ctx.accounts.agent.bump];
    let seeds: &[&[u8]] = &[b"agent", owner.as_ref(), agent_id.as_ref(), &bump];
    token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked { from: ctx.accounts.vault_token_account.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(), to: ctx.accounts.recipient_token_account.to_account_info(), authority: ctx.accounts.agent.to_account_info() }, &[seeds]), amount, USDC_DECIMALS)?;
    init_execution(&mut ctx.accounts.execution, agent, id, ExecutionAsset::Usdc, ExecutionAction::Payment, amount, input, Some(output))?;
    ctx.accounts.agent.execution_count = id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    receipt(&mut ctx.accounts.task_action, ctx.accounts.task.key(), ctx.accounts.execution.key(), amount, ExecutionAsset::Usdc, action_id, ctx.bumps.task_action);
    emit!(UsdcPaymentExecuted { agent, session_key: ctx.accounts.session.session_key, recipient: ctx.accounts.recipient.key(), amount, execution_id: id, input_hash: input, output_hash: output });
    Ok(())
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct CreateTask<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump, has_one = owner)] pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session.session_key.as_ref()], bump = session.bump, has_one = agent)] pub session: Account<'info, Session>,
    #[account(init, payer = owner, space = 8 + Task::INIT_SPACE, seeds = [b"task", agent.key().as_ref(), task_id.to_le_bytes().as_ref()], bump)] pub task: Account<'info, Task>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTask<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump, has_one = owner)] pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent)] pub task: Account<'info, Task>,
}

#[derive(Accounts)]
pub struct ReplaceTaskSession<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump, has_one = owner)] pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent)] pub task: Account<'info, Task>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session.session_key.as_ref()], bump = session.bump, has_one = agent)] pub session: Account<'info, Session>,
}

#[derive(Accounts)]
#[instruction(amount: u64, input_hash: [u8; 32], output_hash: [u8; 32], execution_id: u64, action_id: u64)]
pub struct ExecuteTaskPayment<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump, has_one = agent)] pub policy: Account<'info, Policy>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, has_one = agent, constraint = session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
    /// CHECK: System-owned, zero-data canonical vault.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump, constraint = vault.owner == &system_program::ID && vault.data_len() == 0)] pub vault: UncheckedAccount<'info>,
    #[account(mut)] pub recipient: SystemAccount<'info>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent, has_one = session)] pub task: Box<Account<'info, Task>>,
    #[account(init, payer = fee_payer, space = 8 + TaskAction::INIT_SPACE, seeds = [b"task_action", task.key().as_ref(), action_id.to_le_bytes().as_ref()], bump)] pub task_action: Account<'info, TaskAction>,
}

#[derive(Accounts)]
#[instruction(amount: u64, input_hash: [u8; 32], output_hash: [u8; 32], execution_id: u64, action_id: u64)]
pub struct ExecuteTaskUsdcPayment<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Box<Account<'info, Agent>>,
    #[account(mut, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump, has_one = agent)] pub policy: Box<Account<'info, Policy>>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, has_one = agent, constraint = session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = agent)] pub vault_token_account: Account<'info, TokenAccount>,
    pub recipient: SystemAccount<'info>,
    #[account(init_if_needed, payer = fee_payer, associated_token::mint = usdc_mint, associated_token::authority = recipient)] pub recipient_token_account: Account<'info, TokenAccount>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent, has_one = session)] pub task: Box<Account<'info, Task>>,
    #[account(init, payer = fee_payer, space = 8 + TaskAction::INIT_SPACE, seeds = [b"task_action", task.key().as_ref(), action_id.to_le_bytes().as_ref()], bump)] pub task_action: Account<'info, TaskAction>,
}

#[account]
#[derive(InitSpace)]
pub struct Task {
    pub agent: Pubkey,
    pub session: Pubkey,
    pub task_id: u64,
    pub task_hash: [u8; 32],
    pub max_sol: u64,
    pub max_usdc: u64,
    pub spent_sol: u64,
    pub spent_usdc: u64,
    pub status: TaskStatus,
    pub result_hash: Option<[u8; 32]>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deadline: i64,
    pub action_count: u64,
    pub pending_escrows: u64,
    pub bump: u8,
    pub pending_skill_results: u64,
}

#[account]
#[derive(InitSpace)]
pub struct TaskAction {
    pub task: Pubkey,
    pub execution: Pubkey,
    pub amount: u64,
    pub asset: ExecutionAsset,
    pub action_id: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum TaskStatus { Ready, Running, Paused, Completed, Failed, Cancelled, Waiting }
impl TaskStatus {
    fn terminal(self) -> bool { matches!(self, Self::Completed | Self::Failed | Self::Cancelled) }
}

#[event]
pub struct TaskCreated { pub task: Pubkey, pub agent: Pubkey, pub session: Pubkey, pub task_id: u64, pub task_hash: [u8; 32], pub max_sol: u64, pub max_usdc: u64, pub deadline: i64 }
#[event]
pub struct TaskStatusChanged { pub task: Pubkey, pub status: TaskStatus, pub result_hash: Option<[u8; 32]> }
#[event]
pub struct TaskActionExecuted { pub task: Pubkey, pub execution: Pubkey, pub amount: u64, pub asset: ExecutionAsset, pub action_id: u64 }
#[event]
pub struct TaskSessionReplaced { pub task: Pubkey, pub previous: Pubkey, pub session: Pubkey }


pub(crate) fn pay_skill_sol(ctx: Context<PayTaskSkill>, expected_price: u64, input_hash: [u8; 32], execution_id: u64, action_id: u64) -> Result<()> {
    require!(ctx.accounts.skill.active, AgentOsError::SkillInactive);
    require!(ctx.accounts.skill.price_lamports == expected_price, AgentOsError::SkillPriceChanged);
    let amount = expected_price;
    charge(&mut ctx.accounts.task, ctx.accounts.session.key(), amount, ExecutionAsset::Sol)?;
    spend_scoped(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, API, Some(ctx.accounts.task.task_id))?;
    require!(ctx.accounts.agent.execution_count == execution_id, AgentOsError::UnexpectedExecutionId);
    require!(ctx.accounts.vault.lamports() >= amount, AgentOsError::InsufficientFunds);
    let agent_key = ctx.accounts.agent.key();
    let skill_id = ctx.accounts.skill.skill_id;
    let provider = ctx.accounts.provider.key();
    let bump = [ctx.bumps.vault];
    let seeds: &[&[u8]] = &[b"vault", agent_key.as_ref(), &bump];
    system_program::transfer(CpiContext::new_with_signer(ctx.accounts.system_program.key(), Transfer {
        from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.provider.to_account_info(),
    }, &[seeds]), amount)?;
    init_execution(&mut ctx.accounts.execution, agent_key, execution_id, ExecutionAsset::Sol, ExecutionAction::TaskSkillPayment, amount, input_hash, None)?;
    ctx.accounts.task.pending_skill_results = ctx.accounts.task.pending_skill_results.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    emit!(SkillPaymentExecuted { agent: agent_key, session_key: ctx.accounts.session.session_key, provider, skill_id, amount, execution_id, input_hash });
    receipt(&mut ctx.accounts.task_action, ctx.accounts.task.key(), ctx.accounts.execution.key(), amount, ExecutionAsset::Sol, action_id, ctx.bumps.task_action);
    Ok(())
}

#[derive(Accounts)]
#[instruction(expected_price: u64, input_hash: [u8; 32], execution_id: u64, action_id: u64)]
pub struct PayTaskSkill<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Box<Account<'info, Agent>>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Box<Account<'info, Policy>>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    /// CHECK: System-owned zero-data PDA vault.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump, constraint = vault.owner == &system_program::ID && vault.data_len() == 0)] pub vault: UncheckedAccount<'info>,
    #[account(has_one = provider, seeds = [b"skill", provider.key().as_ref(), skill.skill_id.as_ref()], bump = skill.bump)] pub skill: Box<Account<'info, Skill>>,
    #[account(mut)] pub provider: SystemAccount<'info>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent, has_one = session)] pub task: Box<Account<'info, Task>>,
    #[account(init, payer = fee_payer, space = 8 + TaskAction::INIT_SPACE, seeds = [b"task_action", task.key().as_ref(), action_id.to_le_bytes().as_ref()], bump)] pub task_action: Account<'info, TaskAction>,
}


pub(crate) fn pay_skill_usdc(ctx: Context<PayTaskUsdcSkill>, expected_price: u64, input_hash: [u8; 32], execution_id: u64, action_id: u64) -> Result<()> {
    require!(ctx.accounts.skill.active, AgentOsError::SkillInactive);
    require!(ctx.accounts.skill.price_usdc == expected_price, AgentOsError::SkillPriceChanged);
    let amount = expected_price;
    charge(&mut ctx.accounts.task, ctx.accounts.session.key(), amount, ExecutionAsset::Usdc)?;
    spend_usdc_scoped(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, API, Some(ctx.accounts.task.task_id))?;
    require!(ctx.accounts.agent.execution_count == execution_id, AgentOsError::UnexpectedExecutionId);
    require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
    require!(ctx.accounts.vault_token_account.amount >= amount, AgentOsError::InsufficientFunds);
    let owner_key = ctx.accounts.agent.owner;
    let agent_key = ctx.accounts.agent.key();
    let agent_id = ctx.accounts.agent.agent_id;
    let skill_id = ctx.accounts.skill.skill_id;
    let provider = ctx.accounts.provider.key();
    let bump = [ctx.accounts.agent.bump];
    let seeds: &[&[u8]] = &[b"agent", owner_key.as_ref(), agent_id.as_ref(), &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
            from: ctx.accounts.vault_token_account.to_account_info(),
            mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.provider_token_account.to_account_info(),
            authority: ctx.accounts.agent.to_account_info(),
        }, &[seeds]),
        amount,
        USDC_DECIMALS,
    )?;
    init_execution(&mut ctx.accounts.execution, agent_key, execution_id, ExecutionAsset::Usdc, ExecutionAction::TaskSkillPayment, amount, input_hash, None)?;
    ctx.accounts.task.pending_skill_results = ctx.accounts.task.pending_skill_results.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    emit!(UsdcSkillPaymentExecuted { agent: agent_key, session_key: ctx.accounts.session.session_key, provider, skill_id, amount, execution_id, input_hash });
    receipt(&mut ctx.accounts.task_action, ctx.accounts.task.key(), ctx.accounts.execution.key(), amount, ExecutionAsset::Usdc, action_id, ctx.bumps.task_action);
    Ok(())
}

#[derive(Accounts)]
#[instruction(expected_price: u64, input_hash: [u8; 32], execution_id: u64, action_id: u64)]
pub struct PayTaskUsdcSkill<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Box<Account<'info, Agent>>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Box<Account<'info, Policy>>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = agent)] pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(has_one = provider, seeds = [b"skill", provider.key().as_ref(), skill.skill_id.as_ref()], bump = skill.bump)] pub skill: Box<Account<'info, Skill>>,
    #[account(mut)] pub provider: SystemAccount<'info>,
    #[account(init_if_needed, payer = fee_payer, associated_token::mint = usdc_mint, associated_token::authority = provider)] pub provider_token_account: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent, has_one = session)] pub task: Box<Account<'info, Task>>,
    #[account(init, payer = fee_payer, space = 8 + TaskAction::INIT_SPACE, seeds = [b"task_action", task.key().as_ref(), action_id.to_le_bytes().as_ref()], bump)] pub task_action: Account<'info, TaskAction>,
}


// A task receipt links the paid Execution to this Task; replacement Sessions
// can record its result, but cannot commit another Task's result.
pub(crate) fn record_skill(ctx: Context<RecordTaskSkillResult>, output_hash: [u8; 32]) -> Result<()> {
    validate_session(&ctx.accounts.session, ctx.accounts.agent.key(), &ctx.accounts.agent, ctx.accounts.session_key.key(), API)?;
    validate_session_scope(&ctx.accounts.session, Some(ctx.accounts.task.task_id))?;
    require!(output_hash != [0; 32], AgentOsError::TaskResultRequired);
    let execution = &mut ctx.accounts.execution;
    require!(execution.action == ExecutionAction::TaskSkillPayment, AgentOsError::InvalidSkillExecution);
    require!(execution.output_hash.is_none(), AgentOsError::SkillResultAlreadyRecorded);
    ctx.accounts.task.pending_skill_results = ctx.accounts.task.pending_skill_results.checked_sub(1).ok_or(AgentOsError::MathOverflow)?;
    ctx.accounts.task.updated_at = Clock::get()?.unix_timestamp;
    execution.output_hash = Some(output_hash);
    emit!(SkillResultRecorded { agent: ctx.accounts.agent.key(), session_key: ctx.accounts.session.session_key, execution_id: execution.execution_id, input_hash: execution.input_hash, output_hash });
    Ok(())
}

#[derive(Accounts)]
pub struct RecordTaskSkillResult<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, has_one = agent, constraint = session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
    #[account(mut, seeds = [b"execution", agent.key().as_ref(), execution.execution_id.to_le_bytes().as_ref()], bump, has_one = agent)] pub execution: Account<'info, Execution>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent, has_one = session)] pub task: Box<Account<'info, Task>>,
    #[account(seeds = [b"task_action", task.key().as_ref(), task_action.action_id.to_le_bytes().as_ref()], bump = task_action.bump, has_one = task, has_one = execution)] pub task_action: Account<'info, TaskAction>,
}


pub(crate) fn escrow_sol(ctx: Context<CreateTaskEscrow>, amount: u64, task_id: u64, deadline: i64, task_hash: [u8; 32], execution_id: u64, action_id: u64) -> Result<()> {
    require!(deadline <= ctx.accounts.task.deadline && task_hash != [0; 32], AgentOsError::InvalidExpiry);
    charge(&mut ctx.accounts.task, ctx.accounts.session.key(), amount, ExecutionAsset::Sol)?;
    spend_scoped(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, ESCROW | HIRE_AGENT, Some(ctx.accounts.task.task_id))?;
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.worker_agent.key() != ctx.accounts.agent.key(), AgentOsError::InvalidWorker);
    require!(ctx.accounts.worker_agent.status == AgentStatus::Active, AgentOsError::AgentInactive);
    require!(deadline > now && deadline <= now + MAX_ESCROW_SECONDS, AgentOsError::InvalidExpiry);
    require!(ctx.accounts.agent.execution_count == execution_id, AgentOsError::UnexpectedExecutionId);
    require!(ctx.accounts.vault.lamports() >= amount, AgentOsError::InsufficientFunds);
    let agent = ctx.accounts.agent.key();
    let bump = [ctx.bumps.vault];
    let seeds: &[&[u8]] = &[b"vault", agent.as_ref(), &bump];
    system_program::transfer(CpiContext::new_with_signer(ctx.accounts.system_program.key(), Transfer {
        from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.escrow.to_account_info(),
    }, &[seeds]), amount)?;
    let escrow = &mut ctx.accounts.escrow;
    escrow.agent = agent;
    escrow.worker_agent = ctx.accounts.worker_agent.key();
    escrow.task_id = task_id;
    escrow.amount = amount;
    escrow.deadline = deadline;
    escrow.task_hash = task_hash;
    escrow.result_hash = None;
    escrow.status = EscrowStatus::Funded;
    escrow.bump = ctx.bumps.escrow;
    escrow.reserved = escrow_execution_reference(execution_id);
    escrow.reserved[8..].copy_from_slice(&TASK_ESCROW_EXECUTION_MARKER);
    escrow.asset = ExecutionAsset::Sol;
    init_execution(&mut ctx.accounts.execution, agent, execution_id, ExecutionAsset::Sol, ExecutionAction::Escrow, amount, task_hash, None)?;
    ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    emit!(EscrowFunded { agent, worker_agent: escrow.worker_agent, task_id, amount, deadline, task_hash });
    ctx.accounts.task.pending_escrows = ctx.accounts.task.pending_escrows.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    let link = &mut ctx.accounts.task_link;
    link.task = ctx.accounts.task.key();
    link.escrow = ctx.accounts.escrow.key();
    link.execution = ctx.accounts.execution.key();
    link.closed = false;
    link.bump = ctx.bumps.task_link;
    receipt(&mut ctx.accounts.task_action, ctx.accounts.task.key(), ctx.accounts.execution.key(), amount, ExecutionAsset::Sol, action_id, ctx.bumps.task_action);
    emit!(TaskEscrowFunded { task: ctx.accounts.task.key(), escrow: ctx.accounts.escrow.key(), action_id });
    Ok(())
}

#[derive(Accounts)]
#[instruction(amount: u64, task_id: u64, deadline: i64, task_hash: [u8; 32], execution_id: u64, action_id: u64)]
pub struct CreateTaskEscrow<'info> {
    pub session_key: Signer<'info>,
    /// The Agent owner, relayer, or another explicit fee sponsor pays transaction fees and account rent.
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Box<Account<'info, Agent>>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Box<Account<'info, Policy>>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    /// CHECK: System-owned zero-data PDA vault.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump, constraint = vault.owner == &system_program::ID && vault.data_len() == 0)] pub vault: UncheckedAccount<'info>,
    pub worker_agent: Box<Account<'info, Agent>>,
    #[account(init, payer = fee_payer, space = 8 + Escrow::INIT_SPACE, seeds = [b"escrow", agent.key().as_ref(), task_id.to_le_bytes().as_ref()], bump)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent, has_one = session)] pub task: Box<Account<'info, Task>>,
    #[account(init, payer = fee_payer, space = 8 + TaskAction::INIT_SPACE, seeds = [b"task_action", task.key().as_ref(), action_id.to_le_bytes().as_ref()], bump)] pub task_action: Account<'info, TaskAction>,
    #[account(init, payer = fee_payer, space = 8 + TaskEscrow::INIT_SPACE, seeds = [b"task_escrow", escrow.key().as_ref()], bump)] pub task_link: Account<'info, TaskEscrow>,
}


pub(crate) fn escrow_usdc(ctx: Context<CreateTaskUsdcEscrow>, amount: u64, task_id: u64, deadline: i64, task_hash: [u8; 32], execution_id: u64, action_id: u64) -> Result<()> {
    require!(deadline <= ctx.accounts.task.deadline && task_hash != [0; 32], AgentOsError::InvalidExpiry);
    charge(&mut ctx.accounts.task, ctx.accounts.session.key(), amount, ExecutionAsset::Usdc)?;
    spend_usdc_scoped(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, ESCROW | HIRE_AGENT, Some(ctx.accounts.task.task_id))?;
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.worker_agent.key() != ctx.accounts.agent.key(), AgentOsError::InvalidWorker);
    require!(ctx.accounts.worker_agent.status == AgentStatus::Active, AgentOsError::AgentInactive);
    require!(deadline > now && deadline <= now + MAX_ESCROW_SECONDS, AgentOsError::InvalidExpiry);
    require!(ctx.accounts.agent.execution_count == execution_id, AgentOsError::UnexpectedExecutionId);
    require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
    require!(ctx.accounts.vault_token_account.amount >= amount, AgentOsError::InsufficientFunds);
    let owner_key = ctx.accounts.agent.owner;
    let agent_key = ctx.accounts.agent.key();
    let agent_id = ctx.accounts.agent.agent_id;
    let bump = [ctx.accounts.agent.bump];
    let seeds: &[&[u8]] = &[b"agent", owner_key.as_ref(), agent_id.as_ref(), &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
            from: ctx.accounts.vault_token_account.to_account_info(),
            mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.agent.to_account_info(),
        }, &[seeds]),
        amount,
        USDC_DECIMALS,
    )?;
    let escrow = &mut ctx.accounts.escrow;
    escrow.agent = agent_key;
    escrow.worker_agent = ctx.accounts.worker_agent.key();
    escrow.task_id = task_id;
    escrow.amount = amount;
    escrow.deadline = deadline;
    escrow.task_hash = task_hash;
    escrow.result_hash = None;
    escrow.status = EscrowStatus::Funded;
    escrow.bump = ctx.bumps.escrow;
    escrow.reserved = escrow_execution_reference(execution_id);
    escrow.reserved[8..].copy_from_slice(&TASK_ESCROW_EXECUTION_MARKER);
    escrow.asset = ExecutionAsset::Usdc;
    init_execution(&mut ctx.accounts.execution, agent_key, execution_id, ExecutionAsset::Usdc, ExecutionAction::Escrow, amount, task_hash, None)?;
    ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    emit!(UsdcEscrowFunded { agent: agent_key, worker_agent: escrow.worker_agent, task_id, amount, deadline, task_hash });
    ctx.accounts.task.pending_escrows = ctx.accounts.task.pending_escrows.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    let link = &mut ctx.accounts.task_link;
    link.task = ctx.accounts.task.key();
    link.escrow = ctx.accounts.escrow.key();
    link.execution = ctx.accounts.execution.key();
    link.closed = false;
    link.bump = ctx.bumps.task_link;
    receipt(&mut ctx.accounts.task_action, ctx.accounts.task.key(), ctx.accounts.execution.key(), amount, ExecutionAsset::Usdc, action_id, ctx.bumps.task_action);
    emit!(TaskEscrowFunded { task: ctx.accounts.task.key(), escrow: ctx.accounts.escrow.key(), action_id });
    Ok(())
}

#[derive(Accounts)]
#[instruction(amount: u64, task_id: u64, deadline: i64, task_hash: [u8; 32], execution_id: u64, action_id: u64)]
pub struct CreateTaskUsdcEscrow<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Box<Account<'info, Agent>>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Box<Account<'info, Policy>>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = agent)] pub vault_token_account: Box<Account<'info, TokenAccount>>,
    pub worker_agent: Box<Account<'info, Agent>>,
    #[account(init, payer = fee_payer, space = 8 + Escrow::INIT_SPACE, seeds = [b"escrow", agent.key().as_ref(), task_id.to_le_bytes().as_ref()], bump)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(init_if_needed, payer = fee_payer, associated_token::mint = usdc_mint, associated_token::authority = escrow)] pub escrow_token_account: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent, has_one = session)] pub task: Box<Account<'info, Task>>,
    #[account(init, payer = fee_payer, space = 8 + TaskAction::INIT_SPACE, seeds = [b"task_action", task.key().as_ref(), action_id.to_le_bytes().as_ref()], bump)] pub task_action: Account<'info, TaskAction>,
    #[account(init, payer = fee_payer, space = 8 + TaskEscrow::INIT_SPACE, seeds = [b"task_escrow", escrow.key().as_ref()], bump)] pub task_link: Account<'info, TaskEscrow>,
}


#[account]
#[derive(InitSpace)]
pub struct TaskEscrow { pub task: Pubkey, pub escrow: Pubkey, pub execution: Pubkey, pub closed: bool, pub bump: u8 }

pub(crate) fn validate_task_escrow_session(escrow: &Escrow, task: &Option<Box<Account<Task>>>, session: &Account<Session>) -> Result<()> {
    if escrow.reserved[8..] == TASK_ESCROW_EXECUTION_MARKER {
        let task = task.as_ref().ok_or(AgentOsError::InvalidTaskSession)?;
        require_keys_eq!(task.session, session.key(), AgentOsError::InvalidTaskSession);
        validate_session_scope(session, Some(task.task_id))?;
    }
    Ok(())
}

// All terminal Escrow routes call this before returning. Missing task accounts
// cannot bypass the counter update, and transfer/counter changes roll back together.
pub(crate) fn finish_escrow(escrow: &Escrow, link: &mut Option<Box<Account<TaskEscrow>>>, task: &mut Option<Box<Account<Task>>>) -> Result<()> {
    if escrow.reserved[8..] != TASK_ESCROW_EXECUTION_MARKER {
        require!(link.is_none() && task.is_none(), AgentOsError::InvalidTaskSession);
        return Ok(());
    }
    let link = link.as_mut().ok_or(AgentOsError::InvalidTaskSession)?;
    let task = task.as_mut().ok_or(AgentOsError::InvalidTaskSession)?;
    require_keys_eq!(task.agent, escrow.agent, AgentOsError::InvalidTaskSession);
    require_keys_eq!(link.task, task.key(), AgentOsError::InvalidTaskSession);
    // The canonical link PDA was constrained against ctx.accounts.escrow.
    // Its stored Escrow and Execution references must agree as well.
    let escrow_key = Pubkey::find_program_address(&[b"escrow", escrow.agent.as_ref(), &escrow.task_id.to_le_bytes()], &crate::ID).0;
    require_keys_eq!(link.escrow, escrow_key, AgentOsError::InvalidEscrow);
    let execution_id = u64::from_le_bytes(escrow.reserved[..8].try_into().map_err(|_| error!(AgentOsError::InvalidEscrowExecution))?);
    let execution = Pubkey::find_program_address(&[b"execution", escrow.agent.as_ref(), &execution_id.to_le_bytes()], &crate::ID).0;
    require_keys_eq!(link.execution, execution, AgentOsError::InvalidEscrowExecution);
    require!(!link.closed && matches!(escrow.status, EscrowStatus::Released | EscrowStatus::Refunded | EscrowStatus::Cancelled | EscrowStatus::Settled), AgentOsError::InvalidEscrowState);
    task.pending_escrows = task.pending_escrows.checked_sub(1).ok_or(AgentOsError::MathOverflow)?;
    task.updated_at = Clock::get()?.unix_timestamp;
    link.closed = true;
    emit!(TaskEscrowClosed { task: task.key(), escrow: escrow_key, status: escrow.status });
    Ok(())
}

#[event]
pub struct TaskEscrowFunded { pub task: Pubkey, pub escrow: Pubkey, pub action_id: u64 }
#[event]
pub struct TaskEscrowClosed { pub task: Pubkey, pub escrow: Pubkey, pub status: EscrowStatus }
