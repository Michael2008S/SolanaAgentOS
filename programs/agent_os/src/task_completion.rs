use crate::*;

// This capability delegates the completion declaration, not assessment quality.
// The browser must verify the committed plan and its individual receipts.
pub fn grant(ctx: Context<GrantTaskCompletion>, plan_hash: [u8; 32], expected_actions: u64, expires_at: i64, start_task: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let task = &ctx.accounts.task;
    require!(matches!(task.status, TaskStatus::Ready | TaskStatus::Running | TaskStatus::Paused), AgentOsError::InvalidTaskState);
    authorize(&ctx.accounts.agent, &ctx.accounts.policy, &ctx.accounts.session, ctx.accounts.agent.key(), task.task_id)?;
    require!(plan_hash != [0; 32] && expected_actions > 0 && expected_actions >= task.action_count, AgentOsError::InvalidTaskCompletion);
    require!(expires_at > now && expires_at <= task.deadline && expires_at <= ctx.accounts.session.expires_at, AgentOsError::InvalidExpiry);
    require!(!ctx.accounts.permit.used, AgentOsError::InvalidTaskCompletion);
    let permit = &mut ctx.accounts.permit;
    permit.task = task.key();
    permit.agent = ctx.accounts.agent.key();
    permit.session = ctx.accounts.session.key();
    permit.plan_hash = plan_hash;
    permit.expected_actions = expected_actions;
    permit.expires_at = expires_at;
    permit.revoked = false;
    permit.used = false;
    permit.bump = ctx.bumps.permit;
    emit!(TaskCompletionGranted { task: task.key(), session: permit.session, plan_hash, expected_actions, expires_at });
    if start_task {
        require!(ctx.accounts.task.status == TaskStatus::Ready, AgentOsError::InvalidTaskState);
        ctx.accounts.task.status = TaskStatus::Running;
        ctx.accounts.task.updated_at = now;
        emit!(TaskStatusChanged { task: ctx.accounts.task.key(), status: TaskStatus::Running, result_hash: None });
    }
    Ok(())
}

pub fn revoke(ctx: Context<RevokeTaskCompletion>) -> Result<()> {
    ctx.accounts.permit.revoked = true;
    emit!(TaskCompletionRevoked { task: ctx.accounts.task.key() });
    Ok(())
}

fn authorize(agent: &Agent, policy: &Policy, session: &Session, agent_key: Pubkey, task_id: u64) -> Result<()> {
    // No spending permission is repurposed as completion permission. The separate
    // Owner-issued permit is the capability; action=0 only checks Session liveness.
    validate_session(session, agent_key, agent, session.session_key, 0)?;
    require!(!policy.paused, AgentOsError::PolicyPaused);
    task_budget::validate_session_scope(session, Some(task_id))
}

pub(crate) fn check_completion(task: &Task, permit: &TaskCompletionPermit, now: i64, plan_hash: [u8; 32], result_hash: [u8; 32], spent_sol: u64, spent_usdc: u64) -> Result<()> {
    require!(task.status == TaskStatus::Running, AgentOsError::InvalidTaskState);
    require!(now < task.deadline, AgentOsError::TaskExpired);
    require!(!permit.revoked && !permit.used && now < permit.expires_at && permit.plan_hash == plan_hash, AgentOsError::InvalidTaskCompletion);
    require!(permit.expected_actions > 0 && task.action_count == permit.expected_actions && task.spent_sol == spent_sol && task.spent_usdc == spent_usdc, AgentOsError::TaskCompletionChanged);
    require!(task.pending_escrows == 0 && task.pending_skill_results == 0 && result_hash != [0; 32], AgentOsError::TaskResultRequired);
    Ok(())
}

pub fn complete(ctx: Context<CompleteSessionTask>, plan_hash: [u8; 32], result_hash: [u8; 32], spent_sol: u64, spent_usdc: u64) -> Result<()> {
    authorize(&ctx.accounts.agent, &ctx.accounts.policy, &ctx.accounts.session, ctx.accounts.agent.key(), ctx.accounts.task.task_id)?;
    let now = Clock::get()?.unix_timestamp;
    check_completion(&ctx.accounts.task, &ctx.accounts.permit, now, plan_hash, result_hash, spent_sol, spent_usdc)?;
    ctx.accounts.task.status = TaskStatus::Completed;
    ctx.accounts.task.result_hash = Some(result_hash);
    ctx.accounts.task.updated_at = now;
    ctx.accounts.permit.used = true;
    emit!(TaskStatusChanged { task: ctx.accounts.task.key(), status: TaskStatus::Completed, result_hash: Some(result_hash) });
    emit!(TaskCompletedBySession { task: ctx.accounts.task.key(), session: ctx.accounts.session.key(), plan_hash, result_hash });
    Ok(())
}

#[derive(Accounts)]
pub struct GrantTaskCompletion<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump, has_one = owner)] pub agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"policy", agent.key().as_ref()], bump = policy.bump, has_one = agent)] pub policy: Box<Account<'info, Policy>>,
    #[account(seeds = [b"session", agent.key().as_ref(), session.session_key.as_ref()], bump = session.bump, has_one = agent)] pub session: Box<Account<'info, Session>>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent, has_one = session)] pub task: Box<Account<'info, Task>>,
    #[account(init_if_needed, payer = owner, space = 8 + TaskCompletionPermit::INIT_SPACE, seeds = [b"task_completion", task.key().as_ref()], bump)] pub permit: Box<Account<'info, TaskCompletionPermit>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeTaskCompletion<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump, has_one = owner)] pub agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent)] pub task: Box<Account<'info, Task>>,
    #[account(mut, seeds = [b"task_completion", task.key().as_ref()], bump = permit.bump, has_one = task, has_one = agent)] pub permit: Box<Account<'info, TaskCompletionPermit>>,
}

#[derive(Accounts)]
pub struct CompleteSessionTask<'info> {
    pub session_key: Signer<'info>,
    #[account(seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"policy", agent.key().as_ref()], bump = policy.bump, has_one = agent)] pub policy: Box<Account<'info, Policy>>,
    #[account(seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, has_one = agent, constraint = session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    #[account(mut, seeds = [b"task", agent.key().as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump, has_one = agent, has_one = session)] pub task: Box<Account<'info, Task>>,
    #[account(mut, seeds = [b"task_completion", task.key().as_ref()], bump = permit.bump, has_one = task, has_one = agent, has_one = session)] pub permit: Box<Account<'info, TaskCompletionPermit>>,
}

#[account]
#[derive(InitSpace)]
pub struct TaskCompletionPermit {
    pub task: Pubkey, pub agent: Pubkey, pub session: Pubkey, pub plan_hash: [u8; 32],
    pub expected_actions: u64, pub expires_at: i64, pub revoked: bool, pub used: bool, pub bump: u8,
}
#[event] pub struct TaskCompletionGranted { pub task: Pubkey, pub session: Pubkey, pub plan_hash: [u8; 32], pub expected_actions: u64, pub expires_at: i64 }
#[event] pub struct TaskCompletionRevoked { pub task: Pubkey }
#[event] pub struct TaskCompletedBySession { pub task: Pubkey, pub session: Pubkey, pub plan_hash: [u8; 32], pub result_hash: [u8; 32] }

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Task, TaskCompletionPermit) {
        let task = Task { agent: Pubkey::default(), session: Pubkey::default(), task_id: 1, task_hash: [1; 32], max_sol: 100, max_usdc: 100, spent_sol: 10, spent_usdc: 20, status: TaskStatus::Running, result_hash: None, created_at: 0, updated_at: 0, deadline: 1000, action_count: 2, pending_escrows: 0, bump: 255, pending_skill_results: 0 };
        let permit = TaskCompletionPermit { task: Pubkey::default(), agent: Pubkey::default(), session: Pubkey::default(), plan_hash: [2; 32], expected_actions: 2, expires_at: 900, revoked: false, used: false, bump: 255 };
        (task, permit)
    }

    fn checked(task: &Task, permit: &TaskCompletionPermit) -> Result<()> {
        check_completion(task, permit, 800, [2; 32], [3; 32], 10, 20)
    }

    #[test]
    fn completed_plan_accepts_exact_snapshot() {
        let (task, permit) = fixture();
        assert!(checked(&task, &permit).is_ok());
        assert_eq!(TaskCompletionPermit::INIT_SPACE + 8, 155);
    }

    #[test]
    fn pending_work_and_empty_results_block_completion() {
        let (mut task, permit) = fixture();
        task.pending_escrows = 1;
        assert!(checked(&task, &permit).is_err());
        task.pending_escrows = 0;
        task.pending_skill_results = 1;
        assert!(checked(&task, &permit).is_err());
        task.pending_skill_results = 0;
        assert!(check_completion(&task, &permit, 800, [2; 32], [0; 32], 10, 20).is_err());
    }

    #[test]
    fn changed_count_spending_and_plan_block_completion() {
        let (mut task, permit) = fixture();
        for count in [0, 1, 3] { task.action_count = count; assert!(checked(&task, &permit).is_err()); }
        task.action_count = 2;
        assert!(check_completion(&task, &permit, 800, [2; 32], [3; 32], 11, 20).is_err());
        assert!(check_completion(&task, &permit, 800, [2; 32], [3; 32], 10, 21).is_err());
        assert!(check_completion(&task, &permit, 800, [4; 32], [3; 32], 10, 20).is_err());
    }

    #[test]
    fn revocation_replay_expiry_pause_and_terminal_state_block_completion() {
        let (mut task, mut permit) = fixture();
        permit.revoked = true; assert!(checked(&task, &permit).is_err());
        permit.revoked = false; permit.used = true; assert!(checked(&task, &permit).is_err());
        permit.used = false;
        assert!(check_completion(&task, &permit, 900, [2; 32], [3; 32], 10, 20).is_err());
        for status in [TaskStatus::Ready, TaskStatus::Paused, TaskStatus::Waiting, TaskStatus::Completed, TaskStatus::Failed, TaskStatus::Cancelled] {
            task.status = status; assert!(checked(&task, &permit).is_err());
        }
        task.status = TaskStatus::Running; task.deadline = 800; assert!(checked(&task, &permit).is_err());
    }
}
