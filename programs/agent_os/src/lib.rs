use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};
mod worker_delivery;
pub use worker_delivery::*;
mod task_budget;
pub use task_budget::*;
mod task_completion;
pub use task_completion::*;
mod judge;
pub use judge::*;

const TASK_ESCROW_EXECUTION_MARKER: [u8; 8] = *b"AGTSK001";
const ESCROW_EXECUTION_MARKER: [u8; 8] = *b"AGEXE001";

declare_id!("HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv");

pub const PAY: u8 = 1;
pub const ESCROW: u8 = 2;
pub const API: u8 = 4;
pub const HIRE_AGENT: u8 = 8;
const ACTIONS: u8 = PAY | ESCROW | API | HIRE_AGENT;
const MAX_SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;
const MAX_ESCROW_SECONDS: i64 = 30 * 24 * 60 * 60;
const ESCROW_SETTLEMENT_WINDOW_SECONDS: i64 = 72 * 60 * 60;
pub const DEVNET_USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDC_DECIMALS: u8 = 6;

#[program]
pub mod agent_os {
    use super::*;

    pub fn propose_escrow_judge(ctx: Context<ProposeEscrowJudge>, expires_at: i64) -> Result<()> { judge::propose(ctx, expires_at) }
    pub fn accept_escrow_judge(ctx: Context<AcceptEscrowJudge>, expected: JudgeTerms) -> Result<()> { judge::accept(ctx, expected) }
    pub fn decline_escrow_judge(ctx: Context<DeclineEscrowJudge>) -> Result<()> { judge::decline(ctx) }
    pub fn record_escrow_judgment(ctx: Context<RecordEscrowJudgment>, verdict: JudgeVerdict, task_hash: [u8; 32], result_hash: [u8; 32], judgment_hash: [u8; 32]) -> Result<()> { judge::record(ctx, verdict, task_hash, result_hash, judgment_hash) }
    pub fn settle_judged_escrow(ctx: Context<SettleJudgedEscrow>) -> Result<()> { judge::settle_sol(ctx) }
    pub fn settle_judged_usdc_escrow(ctx: Context<SettleJudgedUsdcEscrow>) -> Result<()> { judge::settle_usdc(ctx) }

    pub fn create_task(ctx: Context<CreateTask>, task_id: u64, task_hash: [u8; 32], max_sol: u64, max_usdc: u64, deadline: i64) -> Result<()> {
        task_budget::create(ctx, task_id, task_hash, max_sol, max_usdc, deadline)
    }

    pub fn set_task_status(ctx: Context<UpdateTask>, status: TaskStatus, result_hash: Option<[u8; 32]>) -> Result<()> {
        task_budget::update(ctx, status, result_hash)
    }

    pub fn replace_task_session(ctx: Context<ReplaceTaskSession>) -> Result<()> {
        task_budget::replace_session(ctx)
    }

    pub fn grant_task_completion(ctx: Context<GrantTaskCompletion>, plan_hash: [u8; 32], expected_actions: u64, expires_at: i64, start_task: bool) -> Result<()> {
        task_completion::grant(ctx, plan_hash, expected_actions, expires_at, start_task)
    }

    pub fn revoke_task_completion(ctx: Context<RevokeTaskCompletion>) -> Result<()> { task_completion::revoke(ctx) }

    pub fn complete_session_task(ctx: Context<CompleteSessionTask>, plan_hash: [u8; 32], result_hash: [u8; 32], spent_sol: u64, spent_usdc: u64) -> Result<()> {
        task_completion::complete(ctx, plan_hash, result_hash, spent_sol, spent_usdc)
    }

    pub fn execute_task_payment(ctx: Context<ExecuteTaskPayment>, amount: u64, input_hash: [u8; 32], output_hash: [u8; 32], execution_id: u64, action_id: u64) -> Result<()> {
        task_budget::pay_sol(ctx, amount, input_hash, output_hash, execution_id, action_id)
    }

    pub fn execute_task_usdc_payment(ctx: Context<ExecuteTaskUsdcPayment>, amount: u64, input_hash: [u8; 32], output_hash: [u8; 32], execution_id: u64, action_id: u64) -> Result<()> {
        task_budget::pay_usdc(ctx, amount, input_hash, output_hash, execution_id, action_id)
    }

    pub fn pay_task_skill(ctx: Context<PayTaskSkill>, expected_price: u64, input_hash: [u8; 32], execution_id: u64, action_id: u64) -> Result<()> {
        task_budget::pay_skill_sol(ctx, expected_price, input_hash, execution_id, action_id)
    }

    pub fn pay_task_usdc_skill(ctx: Context<PayTaskUsdcSkill>, expected_price: u64, input_hash: [u8; 32], execution_id: u64, action_id: u64) -> Result<()> {
        task_budget::pay_skill_usdc(ctx, expected_price, input_hash, execution_id, action_id)
    }

    pub fn record_task_skill_result(ctx: Context<RecordTaskSkillResult>, output_hash: [u8; 32]) -> Result<()> {
        task_budget::record_skill(ctx, output_hash)
    }

    pub fn create_task_escrow(ctx: Context<CreateTaskEscrow>, amount: u64, task_id: u64, deadline: i64, task_hash: [u8; 32], execution_id: u64, action_id: u64) -> Result<()> {
        task_budget::escrow_sol(ctx, amount, task_id, deadline, task_hash, execution_id, action_id)
    }

    pub fn create_task_usdc_escrow(ctx: Context<CreateTaskUsdcEscrow>, amount: u64, task_id: u64, deadline: i64, task_hash: [u8; 32], execution_id: u64, action_id: u64) -> Result<()> {
        task_budget::escrow_usdc(ctx, amount, task_id, deadline, task_hash, execution_id, action_id)
    }

    pub fn initialize_agent(ctx: Context<InitializeAgent>, agent_id: [u8; 32], name: [u8; 32], daily_limit: u64, per_tx_limit: u64, daily_limit_usdc: u64, per_tx_limit_usdc: u64, allowed_actions: u8) -> Result<()> {
        require!(name[0] != 0, AgentOsError::EmptyName);
        validate_limits(daily_limit, per_tx_limit)?;
        validate_limits(daily_limit_usdc, per_tx_limit_usdc)?;
        require!(allowed_actions & !ACTIONS == 0, AgentOsError::InvalidPermission);
        let now = Clock::get()?.unix_timestamp;
        let agent = &mut ctx.accounts.agent;
        agent.owner = ctx.accounts.owner.key();
        agent.agent_id = agent_id;
        agent.name = name;
        agent.status = AgentStatus::Active;
        agent.created_at = now;
        agent.execution_count = 0;
        agent.bump = ctx.bumps.agent;
        agent.reserved = [0; 16];
        let policy = &mut ctx.accounts.policy;
        policy.agent = agent.key();
        policy.daily_limit_lamports = daily_limit;
        policy.per_tx_limit_lamports = per_tx_limit;
        policy.spent_today_lamports = 0;
        policy.day_index = day_index(now);
        policy.allowed_actions = allowed_actions;
        policy.paused = false;
        policy.bump = ctx.bumps.policy;
        policy.reserved = [0; 16];
        policy.daily_limit_usdc = daily_limit_usdc;
        policy.per_tx_limit_usdc = per_tx_limit_usdc;
        policy.spent_today_usdc = 0;
        policy.day_index_usdc = day_index(now);
        let reputation = &mut ctx.accounts.reputation;
        reputation.agent = agent.key();
        reputation.completed_tasks = 0;
        reputation.successful_tasks = 0;
        reputation.failed_tasks = 0;
        reputation.total_volume_lamports = 0;
        reputation.score = 0;
        reputation.disputes = 0;
        reputation.bump = ctx.bumps.reputation;
        reputation.reserved = [0; 16];
        reputation.total_volume_usdc = 0;
        emit!(AgentCreated { agent: agent.key(), owner: agent.owner, created_at: now });
        Ok(())
    }

    pub fn update_policy(ctx: Context<UpdatePolicy>, daily_limit: u64, per_tx_limit: u64, daily_limit_usdc: u64, per_tx_limit_usdc: u64, allowed_actions: u8, paused: bool) -> Result<()> {
        validate_limits(daily_limit, per_tx_limit)?;
        validate_limits(daily_limit_usdc, per_tx_limit_usdc)?;
        require!(allowed_actions & !ACTIONS == 0, AgentOsError::InvalidPermission);
        let policy = &mut ctx.accounts.policy;
        policy.daily_limit_lamports = daily_limit;
        policy.per_tx_limit_lamports = per_tx_limit;
        policy.daily_limit_usdc = daily_limit_usdc;
        policy.per_tx_limit_usdc = per_tx_limit_usdc;
        policy.allowed_actions = allowed_actions;
        policy.paused = paused;
        emit!(PolicyUpdated { agent: ctx.accounts.agent.key(), daily_limit, per_tx_limit, daily_limit_usdc, per_tx_limit_usdc, allowed_actions, paused });
        Ok(())
    }

    pub fn set_agent_status(ctx: Context<UpdateAgentStatus>, status: AgentStatus) -> Result<()> {
        ctx.accounts.agent.status = status;
        emit!(AgentStatusChanged { agent: ctx.accounts.agent.key(), status });
        Ok(())
    }

    pub fn create_session(ctx: Context<CreateSession>, expires_at: i64, max_per_tx: u64, max_total: u64, max_per_tx_usdc: u64, max_total_usdc: u64, permissions: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now && expires_at <= now + MAX_SESSION_SECONDS, AgentOsError::InvalidExpiry);
        require!(max_per_tx > 0 && max_total >= max_per_tx && max_per_tx <= ctx.accounts.policy.per_tx_limit_lamports, AgentOsError::InvalidLimit);
        require!(max_per_tx_usdc > 0 && max_total_usdc >= max_per_tx_usdc && max_per_tx_usdc <= ctx.accounts.policy.per_tx_limit_usdc && max_total_usdc <= ctx.accounts.policy.daily_limit_usdc, AgentOsError::InvalidLimit);
        require!(permissions & !ACTIONS == 0 && permissions & !ctx.accounts.policy.allowed_actions == 0, AgentOsError::InvalidPermission);
        require!(ctx.accounts.agent.status == AgentStatus::Active, AgentOsError::AgentInactive);
        let session = &mut ctx.accounts.session;
        session.agent = ctx.accounts.agent.key();
        session.session_key = ctx.accounts.session_key.key();
        session.expires_at = expires_at;
        session.max_per_tx_lamports = max_per_tx;
        session.max_total_lamports = max_total;
        session.spent_lamports = 0;
        session.permissions = permissions;
        session.revoked = false;
        session.bump = ctx.bumps.session;
        session.reserved = [0; 16];
        session.max_per_tx_usdc = max_per_tx_usdc;
        session.max_total_usdc = max_total_usdc;
        session.spent_usdc = 0;
        emit!(SessionCreated { agent: session.agent, session_key: session.session_key, expires_at, max_total });
        Ok(())
    }

    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        ctx.accounts.session.revoked = true;
        emit!(SessionRevoked { agent: ctx.accounts.agent.key(), session_key: ctx.accounts.session.session_key });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, AgentOsError::InvalidAmount);
        system_program::transfer(CpiContext::new(ctx.accounts.system_program.key(), Transfer {
            from: ctx.accounts.owner.to_account_info(), to: ctx.accounts.vault.to_account_info(),
        }), amount)?;
        emit!(VaultFunded { agent: ctx.accounts.agent.key(), amount });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0 && ctx.accounts.vault.lamports() >= amount, AgentOsError::InsufficientFunds);
        let agent = ctx.accounts.agent.key();
        let bump = [ctx.bumps.vault];
        let seeds: &[&[u8]] = &[b"vault", agent.as_ref(), &bump];
        system_program::transfer(CpiContext::new_with_signer(ctx.accounts.system_program.key(), Transfer {
            from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.destination.to_account_info(),
        }, &[seeds]), amount)?;
        emit!(VaultWithdrawn { agent, destination: ctx.accounts.destination.key(), amount });
        Ok(())
    }

    pub fn deposit_usdc(ctx: Context<DepositUsdc>, amount: u64) -> Result<()> {
        require!(amount > 0, AgentOsError::InvalidAmount);
        require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.owner_token_account.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            }),
            amount,
            USDC_DECIMALS,
        )?;
        emit!(UsdcVaultFunded { agent: ctx.accounts.agent.key(), owner: ctx.accounts.owner.key(), amount });
        Ok(())
    }

    pub fn withdraw_usdc(ctx: Context<WithdrawUsdc>, amount: u64) -> Result<()> {
        require!(amount > 0 && ctx.accounts.vault_token_account.amount >= amount, AgentOsError::InsufficientFunds);
        require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
        let owner_key = ctx.accounts.owner.key();
        let agent_key = ctx.accounts.agent.key();
        let agent_id = ctx.accounts.agent.agent_id;
        let bump = [ctx.accounts.agent.bump];
        let seeds: &[&[u8]] = &[b"agent", owner_key.as_ref(), agent_id.as_ref(), &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.vault_token_account.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.destination_token_account.to_account_info(),
                authority: ctx.accounts.agent.to_account_info(),
            }, &[seeds]),
            amount,
            USDC_DECIMALS,
        )?;
        emit!(UsdcVaultWithdrawn { agent: agent_key, owner: owner_key, amount });
        Ok(())
    }

    pub fn execute_payment(ctx: Context<ExecutePayment>, amount: u64, input_hash: [u8; 32], output_hash: [u8; 32], execution_id: u64) -> Result<()> {
        spend(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, PAY)?;
        require!(ctx.accounts.agent.execution_count == execution_id, AgentOsError::UnexpectedExecutionId);
        require!(ctx.accounts.vault.lamports() >= amount, AgentOsError::InsufficientFunds);
        let agent = ctx.accounts.agent.key();
        let bump = [ctx.bumps.vault];
        let seeds: &[&[u8]] = &[b"vault", agent.as_ref(), &bump];
        system_program::transfer(CpiContext::new_with_signer(ctx.accounts.system_program.key(), Transfer {
            from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.recipient.to_account_info(),
        }, &[seeds]), amount)?;
        init_execution(&mut ctx.accounts.execution, agent, execution_id, ExecutionAsset::Sol, ExecutionAction::Payment, amount, input_hash, Some(output_hash))?;
        ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        emit!(PaymentExecuted { agent, session_key: ctx.accounts.session.session_key, recipient: ctx.accounts.recipient.key(), amount, action: PAY, execution_id, input_hash, output_hash });
        Ok(())
    }

    // Standard paid HTTP resources do not require Skill registry adaptation.
    // Both direct-payment and API authority are required; record the response later.
    pub fn pay_service(ctx: Context<ExecutePayment>, amount: u64, input_hash: [u8; 32], output_hash: [u8; 32], execution_id: u64) -> Result<()> {
        require!(output_hash == [0; 32], AgentOsError::InvalidSkillExecution);
        spend(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, PAY | API)?;
        require!(ctx.accounts.agent.execution_count == execution_id, AgentOsError::UnexpectedExecutionId);
        require!(ctx.accounts.vault.lamports() >= amount, AgentOsError::InsufficientFunds);
        let agent = ctx.accounts.agent.key();
        let bump = [ctx.bumps.vault];
        let seeds: &[&[u8]] = &[b"vault", agent.as_ref(), &bump];
        system_program::transfer(CpiContext::new_with_signer(ctx.accounts.system_program.key(), Transfer {
            from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.recipient.to_account_info(),
        }, &[seeds]), amount)?;
        init_execution(&mut ctx.accounts.execution, agent, execution_id, ExecutionAsset::Sol, ExecutionAction::SkillPayment, amount, input_hash, None)?;
        ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        emit!(ServicePaymentExecuted { agent, session_key: ctx.accounts.session.session_key, recipient: ctx.accounts.recipient.key(), amount, asset: ExecutionAsset::Sol, execution_id, input_hash });
        Ok(())
    }


    pub fn pay_usdc_service(ctx: Context<ExecuteUsdcPayment>, amount: u64, input_hash: [u8; 32], output_hash: [u8; 32], execution_id: u64) -> Result<()> {
        require!(output_hash == [0; 32], AgentOsError::InvalidSkillExecution);
        spend_usdc(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, PAY | API)?;
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
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.agent.to_account_info(),
            }, &[seeds]),
            amount,
            USDC_DECIMALS,
        )?;
        init_execution(&mut ctx.accounts.execution, agent_key, execution_id, ExecutionAsset::Usdc, ExecutionAction::SkillPayment, amount, input_hash, None)?;
        ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        emit!(ServicePaymentExecuted { agent: agent_key, session_key: ctx.accounts.session.session_key, recipient: ctx.accounts.recipient.key(), amount, asset: ExecutionAsset::Usdc, execution_id, input_hash });
        Ok(())
    }


    pub fn pay_skill(ctx: Context<PaySkill>, expected_price: u64, input_hash: [u8; 32], execution_id: u64) -> Result<()> {
        require!(ctx.accounts.skill.active, AgentOsError::SkillInactive);
        require!(ctx.accounts.skill.price_lamports == expected_price, AgentOsError::SkillPriceChanged);
        let amount = expected_price;
        spend(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, API)?;
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
        init_execution(&mut ctx.accounts.execution, agent_key, execution_id, ExecutionAsset::Sol, ExecutionAction::SkillPayment, amount, input_hash, None)?;
        ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        emit!(SkillPaymentExecuted { agent: agent_key, session_key: ctx.accounts.session.session_key, provider, skill_id, amount, execution_id, input_hash });
        Ok(())
    }

    pub fn pay_usdc_skill(ctx: Context<PayUsdcSkill>, expected_price: u64, input_hash: [u8; 32], execution_id: u64) -> Result<()> {
        require!(ctx.accounts.skill.active, AgentOsError::SkillInactive);
        require!(ctx.accounts.skill.price_usdc == expected_price, AgentOsError::SkillPriceChanged);
        let amount = expected_price;
        spend_usdc(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, API)?;
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
        init_execution(&mut ctx.accounts.execution, agent_key, execution_id, ExecutionAsset::Usdc, ExecutionAction::SkillPayment, amount, input_hash, None)?;
        ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        emit!(UsdcSkillPaymentExecuted { agent: agent_key, session_key: ctx.accounts.session.session_key, provider, skill_id, amount, execution_id, input_hash });
        Ok(())
    }

    pub fn record_skill_result(ctx: Context<RecordSkillResult>, output_hash: [u8; 32]) -> Result<()> {
        let agent_key = ctx.accounts.agent.key();
        validate_session(&ctx.accounts.session, agent_key, &ctx.accounts.agent, ctx.accounts.session_key.key(), API)?;
        task_budget::validate_session_scope(&ctx.accounts.session, None)?;
        let execution = &mut ctx.accounts.execution;
        require!(execution.agent == agent_key && execution.action == ExecutionAction::SkillPayment, AgentOsError::InvalidSkillExecution);
        require!(execution.output_hash.is_none(), AgentOsError::SkillResultAlreadyRecorded);
        execution.output_hash = Some(output_hash);
        emit!(SkillResultRecorded { agent: agent_key, session_key: ctx.accounts.session.session_key, execution_id: execution.execution_id, input_hash: execution.input_hash, output_hash });
        Ok(())
    }

    pub fn execute_usdc_payment(ctx: Context<ExecuteUsdcPayment>, amount: u64, input_hash: [u8; 32], output_hash: [u8; 32], execution_id: u64) -> Result<()> {
        spend_usdc(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, PAY)?;
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
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.agent.to_account_info(),
            }, &[seeds]),
            amount,
            USDC_DECIMALS,
        )?;
        init_execution(&mut ctx.accounts.execution, agent_key, execution_id, ExecutionAsset::Usdc, ExecutionAction::Payment, amount, input_hash, Some(output_hash))?;
        ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        emit!(UsdcPaymentExecuted { agent: agent_key, session_key: ctx.accounts.session.session_key, recipient: ctx.accounts.recipient.key(), amount, execution_id, input_hash, output_hash });
        Ok(())
    }

    pub fn register_skill(ctx: Context<RegisterSkill>, skill_id: [u8; 32], endpoint_hash: [u8; 32], price: u64, price_usdc: u64, active: bool) -> Result<()> {
        require!(price > 0 || price_usdc > 0, AgentOsError::InvalidAmount);
        let skill = &mut ctx.accounts.skill;
        skill.provider = ctx.accounts.provider.key();
        skill.skill_id = skill_id;
        skill.endpoint_hash = endpoint_hash;
        skill.price_lamports = price;
        skill.price_usdc = price_usdc;
        skill.active = active;
        skill.bump = ctx.bumps.skill;
        skill.reserved = [0; 8];
        emit!(SkillRegistered { provider: skill.provider, skill_id, price, price_usdc, active });
        Ok(())
    }

    pub fn update_skill(ctx: Context<UpdateSkill>, price: u64, price_usdc: u64, active: bool, endpoint_hash: [u8; 32]) -> Result<()> {
        require!(price > 0 || price_usdc > 0, AgentOsError::InvalidAmount);
        let skill = &mut ctx.accounts.skill;
        skill.price_lamports = price;
        skill.price_usdc = price_usdc;
        skill.active = active;
        skill.endpoint_hash = endpoint_hash;
        emit!(SkillUpdated { provider: skill.provider, skill_id: skill.skill_id, price, price_usdc, active });
        Ok(())
    }

    pub fn create_escrow(ctx: Context<CreateEscrow>, amount: u64, task_id: u64, deadline: i64, task_hash: [u8; 32], execution_id: u64) -> Result<()> {
        spend(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, ESCROW | HIRE_AGENT)?;
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
        escrow.asset = ExecutionAsset::Sol;
        init_execution(&mut ctx.accounts.execution, agent, execution_id, ExecutionAsset::Sol, ExecutionAction::Escrow, amount, task_hash, None)?;
        ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        emit!(EscrowFunded { agent, worker_agent: escrow.worker_agent, task_id, amount, deadline, task_hash });
        Ok(())
    }

    pub fn create_usdc_escrow(ctx: Context<CreateUsdcEscrow>, amount: u64, task_id: u64, deadline: i64, task_hash: [u8; 32], execution_id: u64) -> Result<()> {
        spend_usdc(&mut ctx.accounts.policy, &mut ctx.accounts.session, &ctx.accounts.agent, ctx.accounts.agent.key(), ctx.accounts.session_key.key(), amount, ESCROW | HIRE_AGENT)?;
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
        escrow.asset = ExecutionAsset::Usdc;
        init_execution(&mut ctx.accounts.execution, agent_key, execution_id, ExecutionAsset::Usdc, ExecutionAction::Escrow, amount, task_hash, None)?;
        ctx.accounts.agent.execution_count = execution_id.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        emit!(UsdcEscrowFunded { agent: agent_key, worker_agent: escrow.worker_agent, task_id, amount, deadline, task_hash });
        Ok(())
    }

    pub fn grant_worker_delivery(ctx: Context<GrantWorkerDelivery>, expires_at: i64) -> Result<()> { worker_delivery::grant(ctx, expires_at) }
    pub fn revoke_worker_delivery(ctx: Context<RevokeWorkerDelivery>) -> Result<()> { worker_delivery::revoke(ctx) }
    pub fn submit_session_escrow_result(ctx: Context<SubmitSessionEscrowResult>, result_hash: [u8; 32], sources: Vec<EscrowEvidenceSource>) -> Result<()> { worker_delivery::submit(ctx, result_hash, sources) }

    pub fn submit_escrow_result(ctx: Context<SubmitEscrowResult>, result_hash: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Funded, AgentOsError::InvalidEscrowState);
        require!(escrow.result_hash.is_none(), AgentOsError::EscrowResultAlreadySubmitted);
        require!(Clock::get()?.unix_timestamp < escrow.deadline, AgentOsError::EscrowExpired);
        escrow.result_hash = Some(result_hash);
        emit!(EscrowResultSubmitted { agent: escrow.agent, worker_agent: escrow.worker_agent, task_id: escrow.task_id, result_hash });
        Ok(())
    }

    pub fn submit_escrow_result_with_sources(ctx: Context<SubmitEscrowResultWithSources>, result_hash: [u8; 32], sources: Vec<EscrowEvidenceSource>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Funded, AgentOsError::InvalidEscrowState);
        require!(escrow.result_hash.is_none(), AgentOsError::EscrowResultAlreadySubmitted);
        require!(Clock::get()?.unix_timestamp < escrow.deadline, AgentOsError::EscrowExpired);
        worker_delivery::validate_sources(escrow, &sources, ctx.remaining_accounts, ctx.program_id)?;
        escrow.result_hash = Some(result_hash);
        let evidence = &mut ctx.accounts.evidence;
        evidence.escrow = escrow.key();
        evidence.result_hash = result_hash;
        evidence.sources = sources;
        evidence.bump = ctx.bumps.evidence;
        emit!(EscrowResultSubmitted { agent: escrow.agent, worker_agent: escrow.worker_agent, task_id: escrow.task_id, result_hash });
        Ok(())
    }

    pub fn propose_escrow_settlement(ctx: Context<ProposeEscrowSettlement>, worker_amount: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let settlement = &mut ctx.accounts.settlement;
        let now = Clock::get()?.unix_timestamp;
        require!(ctx.accounts.employer_agent.owner != ctx.accounts.worker_agent.owner, AgentOsError::SettlementNeedsDistinctOwners);
        require!(worker_amount <= escrow.amount, AgentOsError::InvalidSettlementAmount);
        let proposal_deadline = settlement_proposal_deadline(escrow.status, now, escrow.deadline, settlement.deadline)?;
        if escrow.status == EscrowStatus::Funded {
            settlement.escrow = escrow.key();
            settlement.deadline = proposal_deadline;
            settlement.bump = ctx.bumps.settlement;
        } else {
            require!(settlement.escrow == escrow.key(), AgentOsError::InvalidEscrow);
        }
        require!(ctx.accounts.proposer.key() == ctx.accounts.employer_agent.owner || ctx.accounts.proposer.key() == ctx.accounts.worker_agent.owner, AgentOsError::UnauthorizedSettlementParty);
        settlement.proposer = ctx.accounts.proposer.key();
        settlement.worker_amount = worker_amount;
        escrow.status = EscrowStatus::SettlementProposed;
        emit!(EscrowSettlementProposed {
            agent: escrow.agent,
            worker_agent: escrow.worker_agent,
            task_id: escrow.task_id,
            proposer: ctx.accounts.proposer.key(),
            worker_amount,
            settlement_deadline: settlement.deadline,
        });
        Ok(())
    }

    pub fn accept_escrow_settlement_v2(ctx: Context<AcceptEscrowSettlement>, expected: EscrowSettlementTerms) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.asset == ExecutionAsset::Sol, AgentOsError::InvalidAsset);
        require!(escrow.status == EscrowStatus::SettlementProposed, AgentOsError::InvalidEscrowState);
        require!(ctx.accounts.settlement.escrow == escrow.key(), AgentOsError::InvalidEscrow);
        let (worker_amount, employer_amount) = validate_settlement_acceptance(
            &ctx.accounts.settlement, &expected, ctx.accounts.employer_agent.owner,
            ctx.accounts.worker_agent.owner, ctx.accounts.accepter.key(),
            Clock::get()?.unix_timestamp, escrow.amount,
        )?;
        settle_escrow_execution(escrow, &mut ctx.accounts.execution, ctx.program_id)?;
        move_lamports(&escrow.to_account_info(), &ctx.accounts.worker_vault.to_account_info(), worker_amount)?;
        move_lamports(&escrow.to_account_info(), &ctx.accounts.employer_vault.to_account_info(), employer_amount)?;
        escrow.status = EscrowStatus::Settled;
        ctx.accounts.worker_reputation.disputes = ctx.accounts.worker_reputation.disputes.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        ctx.accounts.employer_reputation.disputes = ctx.accounts.employer_reputation.disputes.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        emit!(EscrowSettlementAccepted { agent: escrow.agent, worker_agent: escrow.worker_agent, task_id: escrow.task_id, worker_amount, employer_amount });
        task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)?;
        Ok(())
    }

    pub fn accept_usdc_escrow_settlement_v2(ctx: Context<AcceptUsdcEscrowSettlement>, expected: EscrowSettlementTerms) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.asset == ExecutionAsset::Usdc, AgentOsError::InvalidAsset);
        require!(escrow.status == EscrowStatus::SettlementProposed, AgentOsError::InvalidEscrowState);
        require!(ctx.accounts.settlement.escrow == escrow.key(), AgentOsError::InvalidEscrow);
        let (worker_amount, employer_amount) = validate_settlement_acceptance(
            &ctx.accounts.settlement, &expected, ctx.accounts.employer_agent.owner,
            ctx.accounts.worker_agent.owner, ctx.accounts.accepter.key(),
            Clock::get()?.unix_timestamp, escrow.amount,
        )?;
        require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
        let employer_key = ctx.accounts.employer_agent.key();
        let task_id = escrow.task_id.to_le_bytes();
        let bump = [escrow.bump];
        let seeds: &[&[u8]] = &[b"escrow", employer_key.as_ref(), &task_id, &bump];
        let escrow_account_info = escrow.to_account_info();
        if worker_amount > 0 {
            token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.escrow_token_account.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.worker_token_account.to_account_info(), authority: escrow_account_info.clone(),
            }, &[seeds]), worker_amount, USDC_DECIMALS)?;
        }
        if employer_amount > 0 {
            token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.escrow_token_account.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.employer_token_account.to_account_info(), authority: escrow_account_info,
            }, &[seeds]), employer_amount, USDC_DECIMALS)?;
        }
        let escrow = &mut ctx.accounts.escrow;
        settle_escrow_execution(escrow, &mut ctx.accounts.execution, ctx.program_id)?;
        escrow.status = EscrowStatus::Settled;
        ctx.accounts.worker_reputation.disputes = ctx.accounts.worker_reputation.disputes.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        ctx.accounts.employer_reputation.disputes = ctx.accounts.employer_reputation.disputes.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
        emit!(EscrowSettlementAccepted { agent: escrow.agent, worker_agent: escrow.worker_agent, task_id: escrow.task_id, worker_amount, employer_amount });
        task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)?;
        Ok(())
    }

    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.asset == ExecutionAsset::Sol, AgentOsError::InvalidAsset);
        require!(escrow.status == EscrowStatus::Funded && escrow.result_hash.is_none() && Clock::get()?.unix_timestamp < escrow.deadline, AgentOsError::EscrowCannotBeCancelled);
        let amount = escrow.amount;
        record_escrow_execution_refund(escrow, &mut ctx.accounts.execution, ctx.program_id)?;
        move_lamports(&escrow.to_account_info(), &ctx.accounts.employer_vault.to_account_info(), amount)?;
        escrow.status = EscrowStatus::Cancelled;
        emit!(EscrowCancelled { agent: escrow.agent, worker_agent: escrow.worker_agent, task_id: escrow.task_id, amount });
        task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)?;
        Ok(())
    }

    pub fn cancel_usdc_escrow(ctx: Context<CancelUsdcEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.asset == ExecutionAsset::Usdc, AgentOsError::InvalidAsset);
        require!(escrow.status == EscrowStatus::Funded && escrow.result_hash.is_none() && Clock::get()?.unix_timestamp < escrow.deadline, AgentOsError::EscrowCannotBeCancelled);
        require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
        record_escrow_execution_refund(escrow, &mut ctx.accounts.execution, ctx.program_id)?;
        let employer_key = ctx.accounts.employer_agent.key();
        let task_id = escrow.task_id.to_le_bytes();
        let bump = [escrow.bump];
        let seeds: &[&[u8]] = &[b"escrow", employer_key.as_ref(), &task_id, &bump];
        let escrow_account_info = escrow.to_account_info();
        token::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.employer_token_account.to_account_info(),
                authority: escrow_account_info,
            }, &[seeds]),
            escrow.amount,
            USDC_DECIMALS,
        )?;
        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Cancelled;
        emit!(UsdcEscrowCancelled { agent: escrow.agent, worker_agent: escrow.worker_agent, task_id: escrow.task_id, amount: escrow.amount });
        task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)?;
        Ok(())
    }

    pub fn release_escrow(ctx: Context<ReleaseEscrow>) -> Result<()> {
        validate_session(&ctx.accounts.session, ctx.accounts.agent.key(), &ctx.accounts.agent, ctx.accounts.session_key.key(), ESCROW)?;
        task_budget::validate_task_escrow_session(&ctx.accounts.escrow, &ctx.accounts.task, &ctx.accounts.session)?;
        let result_hash = ctx.accounts.escrow.result_hash.ok_or(AgentOsError::EscrowResultMissing)?;
        record_escrow_execution_result(&ctx.accounts.escrow, &mut ctx.accounts.execution, result_hash, ctx.program_id)?;
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.asset == ExecutionAsset::Sol, AgentOsError::InvalidAsset);
        require!(escrow.status == EscrowStatus::Funded, AgentOsError::InvalidEscrowState);
        move_lamports(&escrow.to_account_info(), &ctx.accounts.worker_vault.to_account_info(), escrow.amount)?;
        escrow.status = EscrowStatus::Released;
        escrow.result_hash = Some(result_hash);
        record_worker_release(&mut ctx.accounts.worker_reputation, ctx.accounts.agent.owner,
            ctx.accounts.worker_agent.owner, escrow.worker_agent, escrow.task_id, escrow.amount, ExecutionAsset::Sol)?;
        emit!(EscrowReleased { agent: escrow.agent, worker_agent: escrow.worker_agent, task_id: escrow.task_id, amount: escrow.amount, result_hash });
        task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)?;
        Ok(())
    }

    pub fn release_usdc_escrow(ctx: Context<ReleaseUsdcEscrow>) -> Result<()> {
        validate_session(&ctx.accounts.session, ctx.accounts.agent.key(), &ctx.accounts.agent, ctx.accounts.session_key.key(), ESCROW)?;
        task_budget::validate_task_escrow_session(&ctx.accounts.escrow, &ctx.accounts.task, &ctx.accounts.session)?;
        let result_hash = ctx.accounts.escrow.result_hash.ok_or(AgentOsError::EscrowResultMissing)?;
        record_escrow_execution_result(&ctx.accounts.escrow, &mut ctx.accounts.execution, result_hash, ctx.program_id)?;
        require!(ctx.accounts.escrow.asset == ExecutionAsset::Usdc, AgentOsError::InvalidAsset);
        require!(ctx.accounts.escrow.status == EscrowStatus::Funded, AgentOsError::InvalidEscrowState);
        require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
        let agent_key = ctx.accounts.agent.key();
        let task_id_value = ctx.accounts.escrow.task_id;
        let amount = ctx.accounts.escrow.amount;
        let task_id = task_id_value.to_le_bytes();
        let bump = [ctx.accounts.escrow.bump];
        let seeds: &[&[u8]] = &[b"escrow", agent_key.as_ref(), &task_id, &bump];
        let escrow_account_info = ctx.accounts.escrow.to_account_info();
        token::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.worker_token_account.to_account_info(),
                authority: escrow_account_info,
            }, &[seeds]),
            amount,
            USDC_DECIMALS,
        )?;
        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Released;
        escrow.result_hash = Some(result_hash);
        record_worker_release(&mut ctx.accounts.worker_reputation, ctx.accounts.agent.owner,
            ctx.accounts.worker_agent.owner, escrow.worker_agent, escrow.task_id, escrow.amount, ExecutionAsset::Usdc)?;
        emit!(UsdcEscrowReleased { agent: escrow.agent, worker_agent: escrow.worker_agent, task_id: escrow.task_id, amount: escrow.amount, result_hash });
        task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)?;
        Ok(())
    }

    pub fn refund_expired_escrow(ctx: Context<RefundExpiredEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.asset == ExecutionAsset::Sol, AgentOsError::InvalidAsset);
        require!(escrow.status == EscrowStatus::Funded, AgentOsError::InvalidEscrowState);
        require!(Clock::get()?.unix_timestamp >= escrow.deadline, AgentOsError::EscrowNotExpired);
        record_escrow_execution_refund(escrow, &mut ctx.accounts.execution, ctx.program_id)?;
        move_lamports(&escrow.to_account_info(), &ctx.accounts.employer_vault.to_account_info(), escrow.amount)?;
        escrow.status = EscrowStatus::Refunded;
        emit!(EscrowRefunded { agent: escrow.agent, task_id: escrow.task_id, amount: escrow.amount });
        task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)?;
        Ok(())
    }

    pub fn refund_expired_usdc_escrow(ctx: Context<RefundExpiredUsdcEscrow>) -> Result<()> {
        require!(ctx.accounts.escrow.asset == ExecutionAsset::Usdc, AgentOsError::InvalidAsset);
        require!(ctx.accounts.escrow.status == EscrowStatus::Funded, AgentOsError::InvalidEscrowState);
        require!(Clock::get()?.unix_timestamp >= ctx.accounts.escrow.deadline, AgentOsError::EscrowNotExpired);
        require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
        record_escrow_execution_refund(&ctx.accounts.escrow, &mut ctx.accounts.execution, ctx.program_id)?;
        let agent_key = ctx.accounts.agent.key();
        let task_id_value = ctx.accounts.escrow.task_id;
        let amount = ctx.accounts.escrow.amount;
        let task_id = task_id_value.to_le_bytes();
        let bump = [ctx.accounts.escrow.bump];
        let seeds: &[&[u8]] = &[b"escrow", agent_key.as_ref(), &task_id, &bump];
        let escrow_account_info = ctx.accounts.escrow.to_account_info();
        token::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.employer_token_account.to_account_info(),
                authority: escrow_account_info,
            }, &[seeds]),
            amount,
            USDC_DECIMALS,
        )?;
        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Refunded;
        emit!(UsdcEscrowRefunded { agent: escrow.agent, task_id: escrow.task_id, amount: escrow.amount });
        task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)?;
        Ok(())
    }

    pub fn refund_disputed_escrow(ctx: Context<RefundDisputedEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.asset == ExecutionAsset::Sol, AgentOsError::InvalidAsset);
        require!(escrow.status == EscrowStatus::SettlementProposed, AgentOsError::InvalidEscrowState);
        require!(ctx.accounts.settlement.escrow == escrow.key(), AgentOsError::InvalidEscrow);
        require!(Clock::get()?.unix_timestamp >= ctx.accounts.settlement.deadline, AgentOsError::SettlementExpired);
        record_escrow_execution_refund(escrow, &mut ctx.accounts.execution, ctx.program_id)?;
        move_lamports(&escrow.to_account_info(), &ctx.accounts.employer_vault.to_account_info(), escrow.amount)?;
        escrow.status = EscrowStatus::Refunded;
        emit!(EscrowRefunded { agent: escrow.agent, task_id: escrow.task_id, amount: escrow.amount });
        task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)?;
        Ok(())
    }

    pub fn refund_disputed_usdc_escrow(ctx: Context<RefundDisputedUsdcEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.asset == ExecutionAsset::Usdc, AgentOsError::InvalidAsset);
        require!(escrow.status == EscrowStatus::SettlementProposed, AgentOsError::InvalidEscrowState);
        require!(ctx.accounts.settlement.escrow == escrow.key(), AgentOsError::InvalidEscrow);
        require!(Clock::get()?.unix_timestamp >= ctx.accounts.settlement.deadline, AgentOsError::SettlementExpired);
        require!(ctx.accounts.usdc_mint.decimals == USDC_DECIMALS, AgentOsError::InvalidMint);
        record_escrow_execution_refund(&ctx.accounts.escrow, &mut ctx.accounts.execution, ctx.program_id)?;
        let agent_key = ctx.accounts.agent.key();
        let task_id_value = ctx.accounts.escrow.task_id;
        let amount = ctx.accounts.escrow.amount;
        let task_id = task_id_value.to_le_bytes();
        let bump = [ctx.accounts.escrow.bump];
        let seeds: &[&[u8]] = &[b"escrow", agent_key.as_ref(), &task_id, &bump];
        let escrow_account_info = ctx.accounts.escrow.to_account_info();
        token::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.escrow_token_account.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.employer_token_account.to_account_info(), authority: escrow_account_info,
            }, &[seeds]), amount, USDC_DECIMALS,
        )?;
        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Refunded;
        emit!(UsdcEscrowRefunded { agent: escrow.agent, task_id: escrow.task_id, amount: escrow.amount });
        task_budget::finish_escrow(&ctx.accounts.escrow, &mut ctx.accounts.task_link, &mut ctx.accounts.task)?;
        Ok(())
    }
}

fn settlement_proposal_deadline(status: EscrowStatus, now: i64, escrow_deadline: i64, existing_deadline: i64) -> Result<i64> {
    if status == EscrowStatus::Funded {
        require!(now < escrow_deadline, AgentOsError::EscrowExpired);
        return now.checked_add(ESCROW_SETTLEMENT_WINDOW_SECONDS).ok_or_else(|| error!(AgentOsError::MathOverflow));
    }
    require!(status == EscrowStatus::SettlementProposed, AgentOsError::InvalidEscrowState);
    require!(now < existing_deadline, AgentOsError::SettlementExpired);
    Ok(existing_deadline)
}

fn validate_settlement_acceptance(
    proposal: &EscrowSettlement,
    expected: &EscrowSettlementTerms,
    employer_owner: Pubkey,
    worker_owner: Pubkey,
    accepter: Pubkey,
    now: i64,
    funded_amount: u64,
) -> Result<(u64, u64)> {
    require!(proposal.proposer == expected.proposer && proposal.worker_amount == expected.worker_amount && proposal.deadline == expected.deadline, AgentOsError::SettlementTermsChanged);
    require!(now < proposal.deadline, AgentOsError::SettlementExpired);
    require!(employer_owner != worker_owner, AgentOsError::SettlementNeedsDistinctOwners);
    let accepted = proposal.proposer == employer_owner && accepter == worker_owner
        || proposal.proposer == worker_owner && accepter == employer_owner;
    require!(accepted, AgentOsError::UnauthorizedSettlementParty);
    let employer_amount = funded_amount.checked_sub(proposal.worker_amount).ok_or(AgentOsError::InvalidSettlementAmount)?;
    Ok((proposal.worker_amount, employer_amount))
}

fn validate_limits(daily: u64, per_tx: u64) -> Result<()> {
    require!(daily > 0 && per_tx > 0 && per_tx <= daily, AgentOsError::InvalidLimit);
    Ok(())
}
fn day_index(ts: i64) -> i64 { ts.div_euclid(86_400) }
fn validate_session(session: &Session, agent_key: Pubkey, agent: &Agent, session_key: Pubkey, action: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(agent.status == AgentStatus::Active, AgentOsError::AgentInactive);
    require!(!session.revoked, AgentOsError::SessionRevoked);
    require!(session.agent == agent_key && session.session_key == session_key && now < session.expires_at, AgentOsError::InvalidSession);
    require!(session.permissions & action == action, AgentOsError::InvalidPermission);
    Ok(())
}
fn spend(policy: &mut Policy, session: &mut Session, agent: &Agent, agent_key: Pubkey, session_key: Pubkey, amount: u64, action: u8) -> Result<()> {
    spend_scoped(policy, session, agent, agent_key, session_key, amount, action, None)
}
fn spend_scoped(policy: &mut Policy, session: &mut Session, agent: &Agent, agent_key: Pubkey, session_key: Pubkey, amount: u64, action: u8, task_id: Option<u64>) -> Result<()> {
    task_budget::validate_session_scope(session, task_id)?;
    require!(amount > 0, AgentOsError::InvalidAmount);
    validate_session(session, agent_key, agent, session_key, action)?;
    require!(!policy.paused && policy.agent == agent_key, AgentOsError::PolicyPaused);
    require!(policy.allowed_actions & action == action, AgentOsError::InvalidPermission);
    require!(amount <= policy.per_tx_limit_lamports && amount <= session.max_per_tx_lamports, AgentOsError::PerTransactionLimitExceeded);
    let today = day_index(Clock::get()?.unix_timestamp);
    if policy.day_index != today { policy.day_index = today; policy.spent_today_lamports = 0; }
    let daily = policy.spent_today_lamports.checked_add(amount).ok_or(AgentOsError::MathOverflow)?;
    let total = session.spent_lamports.checked_add(amount).ok_or(AgentOsError::MathOverflow)?;
    require!(daily <= policy.daily_limit_lamports, AgentOsError::DailyLimitExceeded);
    require!(total <= session.max_total_lamports, AgentOsError::SessionLimitExceeded);
    policy.spent_today_lamports = daily;
    session.spent_lamports = total;
    Ok(())
}
fn spend_usdc(policy: &mut Policy, session: &mut Session, agent: &Agent, agent_key: Pubkey, session_key: Pubkey, amount: u64, action: u8) -> Result<()> {
    spend_usdc_scoped(policy, session, agent, agent_key, session_key, amount, action, None)
}
fn spend_usdc_scoped(policy: &mut Policy, session: &mut Session, agent: &Agent, agent_key: Pubkey, session_key: Pubkey, amount: u64, action: u8, task_id: Option<u64>) -> Result<()> {
    task_budget::validate_session_scope(session, task_id)?;
    require!(amount > 0, AgentOsError::InvalidAmount);
    validate_session(session, agent_key, agent, session_key, action)?;
    require!(!policy.paused && policy.agent == agent_key, AgentOsError::PolicyPaused);
    require!(policy.allowed_actions & action == action, AgentOsError::InvalidPermission);
    require!(amount <= policy.per_tx_limit_usdc && amount <= session.max_per_tx_usdc, AgentOsError::PerTransactionLimitExceeded);
    let today = day_index(Clock::get()?.unix_timestamp);
    if policy.day_index_usdc != today { policy.day_index_usdc = today; policy.spent_today_usdc = 0; }
    let daily = policy.spent_today_usdc.checked_add(amount).ok_or(AgentOsError::MathOverflow)?;
    let total = session.spent_usdc.checked_add(amount).ok_or(AgentOsError::MathOverflow)?;
    require!(daily <= policy.daily_limit_usdc, AgentOsError::DailyLimitExceeded);
    require!(total <= session.max_total_usdc, AgentOsError::SessionLimitExceeded);
    policy.spent_today_usdc = daily;
    session.spent_usdc = total;
    Ok(())
}
fn init_execution(account: &mut Account<Execution>, agent: Pubkey, id: u64, asset: ExecutionAsset, action: ExecutionAction, amount: u64, input: [u8; 32], output: Option<[u8; 32]>) -> Result<()> {
    account.agent = agent;
    account.execution_id = id;
    account.asset = asset;
    account.action = action;
    account.amount = amount;
    account.created_at = Clock::get()?.unix_timestamp;
    account.input_hash = input;
    account.output_hash = output;
    account.status = ExecutionStatus::Completed;
    Ok(())
}

fn has_escrow_execution_reference(escrow: &Escrow) -> bool {
    escrow.reserved[8..] == ESCROW_EXECUTION_MARKER || escrow.reserved[8..] == TASK_ESCROW_EXECUTION_MARKER
}

fn escrow_execution_reference(execution_id: u64) -> [u8; 16] {
    let mut reference = [0; 16];
    reference[..8].copy_from_slice(&execution_id.to_le_bytes());
    reference[8..].copy_from_slice(&ESCROW_EXECUTION_MARKER);
    reference
}

fn record_escrow_execution_result(
    escrow: &Account<Escrow>,
    execution: &mut Option<Account<Execution>>,
    result_hash: [u8; 32],
    program_id: &Pubkey,
) -> Result<()> {
    if !has_escrow_execution_reference(escrow) {
        require!(execution.is_none(), AgentOsError::InvalidEscrowExecution);
        return Ok(());
    }
    let execution = execution.as_mut().ok_or_else(|| error!(AgentOsError::InvalidEscrowExecution))?;
    validate_escrow_execution_reference(escrow, execution, program_id)?;
    execution.output_hash = Some(result_hash);
    Ok(())
}

fn record_escrow_execution_refund(
    escrow: &Account<Escrow>,
    execution: &mut Option<Account<Execution>>,
    program_id: &Pubkey,
) -> Result<()> {
    if !has_escrow_execution_reference(escrow) {
        require!(execution.is_none(), AgentOsError::InvalidEscrowExecution);
        return Ok(());
    }
    let execution = execution.as_mut().ok_or_else(|| error!(AgentOsError::InvalidEscrowExecution))?;
    validate_escrow_execution_reference(escrow, execution, program_id)?;
    execution.status = ExecutionStatus::Refunded;
    Ok(())
}

fn settle_escrow_execution(
    escrow: &Account<Escrow>,
    execution: &mut Option<Account<Execution>>,
    program_id: &Pubkey,
) -> Result<()> {
    if !has_escrow_execution_reference(escrow) {
        require!(execution.is_none(), AgentOsError::InvalidEscrowExecution);
        return Ok(());
    }
    let execution = execution.as_mut().ok_or_else(|| error!(AgentOsError::InvalidEscrowExecution))?;
    validate_escrow_execution_reference(escrow, execution, program_id)?;
    execution.output_hash = escrow.result_hash;
    execution.status = ExecutionStatus::Settled;
    Ok(())
}

fn validate_escrow_execution_reference(
    escrow: &Account<Escrow>,
    execution: &Account<Execution>,
    program_id: &Pubkey,
) -> Result<()> {
    require!(has_escrow_execution_reference(escrow), AgentOsError::InvalidEscrowExecution);
    let execution_id = u64::from_le_bytes(escrow.reserved[..8].try_into().map_err(|_| error!(AgentOsError::InvalidEscrowExecution))?);
    let expected = Pubkey::find_program_address(
        &[b"execution", escrow.agent.as_ref(), &execution_id.to_le_bytes()],
        program_id,
    ).0;
    require_keys_eq!(execution.key(), expected, AgentOsError::InvalidEscrowExecution);
    require!(
        execution.agent == escrow.agent
            && execution.execution_id == execution_id
            && execution.action == ExecutionAction::Escrow
            && execution.input_hash == escrow.task_hash
            && execution.output_hash.is_none()
            && execution.status == ExecutionStatus::Completed,
        AgentOsError::InvalidEscrowExecution,
    );
    Ok(())
}
fn move_lamports<'info>(source: &AccountInfo<'info>, destination: &AccountInfo<'info>, amount: u64) -> Result<()> {
    require!(source.owner == &crate::ID, AgentOsError::InvalidEscrow);
    let floor = Rent::get()?.minimum_balance(source.data_len());
    let source_after = source.lamports().checked_sub(amount).ok_or(AgentOsError::InsufficientFunds)?;
    require!(source_after >= floor, AgentOsError::InsufficientFunds);
    let destination_after = destination.lamports().checked_add(amount).ok_or(AgentOsError::MathOverflow)?;
    **source.try_borrow_mut_lamports()? = source_after;
    **destination.try_borrow_mut_lamports()? = destination_after;
    Ok(())
}

// Self-controlled Agent transfers may settle, but must not manufacture public reputation.
fn record_worker_release(reputation: &mut Reputation, employer_owner: Pubkey, worker_owner: Pubkey,
    worker_agent: Pubkey, task_id: u64, amount: u64, asset: ExecutionAsset) -> Result<()> {
    if employer_owner == worker_owner {
        emit!(ReputationExcludedSelfSettlement { worker_agent, task_id, amount, asset });
        return Ok(());
    }
    reputation.completed_tasks = reputation.completed_tasks.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    reputation.successful_tasks = reputation.successful_tasks.checked_add(1).ok_or(AgentOsError::MathOverflow)?;
    let volume = if asset == ExecutionAsset::Sol { &mut reputation.total_volume_lamports } else { &mut reputation.total_volume_usdc };
    *volume = volume.checked_add(amount).ok_or(AgentOsError::MathOverflow)?;
    reputation.score = reputation.score.saturating_add(10).min(10_000);
    Ok(())
}

#[event]
pub struct ReputationExcludedSelfSettlement { pub worker_agent: Pubkey, pub task_id: u64, pub amount: u64, pub asset: ExecutionAsset }

#[derive(Accounts)]
#[instruction(agent_id: [u8; 32])]
pub struct InitializeAgent<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Agent::INIT_SPACE, seeds = [b"agent", owner.key().as_ref(), agent_id.as_ref()], bump)] pub agent: Account<'info, Agent>,
    #[account(init, payer = owner, space = 8 + Policy::INIT_SPACE, seeds = [b"policy", agent.key().as_ref()], bump)] pub policy: Account<'info, Policy>,
    #[account(init, payer = owner, space = 8 + Reputation::INIT_SPACE, seeds = [b"reputation", agent.key().as_ref()], bump)] pub reputation: Account<'info, Reputation>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner, seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Account<'info, Policy>,
}
#[derive(Accounts)]
pub struct UpdateAgentStatus<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner, seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
}
#[derive(Accounts)]
pub struct CreateSession<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(has_one = owner, seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(seeds = [b"policy", agent.key().as_ref()], bump = policy.bump, has_one = agent)] pub policy: Account<'info, Policy>,
    /// CHECK: Stored as a session capability key; it must sign every session-authorized instruction.
    pub session_key: UncheckedAccount<'info>,
    #[account(init, payer = owner, space = 8 + Session::INIT_SPACE, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump)] pub session: Account<'info, Session>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct RevokeSession<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner, seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session.session_key.as_ref()], bump = session.bump, constraint = session.agent == agent.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
}
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(has_one = owner, seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    /// CHECK: System-owned zero-data PDA vault for this Agent.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump, constraint = vault.owner == &system_program::ID && vault.data_len() == 0)] pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner, seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    /// CHECK: System-owned zero-data PDA; only this program can debit it with PDA signer seeds.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump, constraint = vault.owner == &system_program::ID && vault.data_len() == 0)] pub vault: UncheckedAccount<'info>,
    #[account(mut)] pub destination: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct DepositUsdc<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(has_one = owner, seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = owner)] pub owner_token_account: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = owner, associated_token::mint = usdc_mint, associated_token::authority = agent)] pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct WithdrawUsdc<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(has_one = owner, seeds = [b"agent", owner.key().as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(init_if_needed, payer = owner, associated_token::mint = usdc_mint, associated_token::authority = agent)] pub vault_token_account: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = owner, associated_token::mint = usdc_mint, associated_token::authority = owner)] pub destination_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(amount: u64, input_hash: [u8; 32], output_hash: [u8; 32], execution_id: u64)]
pub struct ExecutePayment<'info> {
    pub session_key: Signer<'info>,
    /// The Agent owner, relayer, or another explicit fee sponsor pays transaction fees and Execution rent.
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Account<'info, Policy>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
    /// CHECK: System-owned zero-data PDA vault.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump, constraint = vault.owner == &system_program::ID && vault.data_len() == 0)] pub vault: UncheckedAccount<'info>,
    #[account(mut)] pub recipient: SystemAccount<'info>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(expected_price: u64, input_hash: [u8; 32], execution_id: u64)]
pub struct PaySkill<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Account<'info, Policy>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
    /// CHECK: System-owned zero-data PDA vault.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump, constraint = vault.owner == &system_program::ID && vault.data_len() == 0)] pub vault: UncheckedAccount<'info>,
    #[account(has_one = provider, seeds = [b"skill", provider.key().as_ref(), skill.skill_id.as_ref()], bump = skill.bump)] pub skill: Account<'info, Skill>,
    #[account(mut)] pub provider: SystemAccount<'info>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(expected_price: u64, input_hash: [u8; 32], execution_id: u64)]
pub struct PayUsdcSkill<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Account<'info, Policy>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = agent)] pub vault_token_account: Account<'info, TokenAccount>,
    #[account(has_one = provider, seeds = [b"skill", provider.key().as_ref(), skill.skill_id.as_ref()], bump = skill.bump)] pub skill: Account<'info, Skill>,
    #[account(mut)] pub provider: SystemAccount<'info>,
    #[account(init_if_needed, payer = fee_payer, associated_token::mint = usdc_mint, associated_token::authority = provider)] pub provider_token_account: Account<'info, TokenAccount>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct RecordSkillResult<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
    #[account(mut, seeds = [b"execution", agent.key().as_ref(), execution.execution_id.to_le_bytes().as_ref()], bump, constraint = execution.agent == agent.key() @ AgentOsError::InvalidSkillExecution)] pub execution: Account<'info, Execution>,
}
#[derive(Accounts)]
#[instruction(amount: u64, input_hash: [u8; 32], output_hash: [u8; 32], execution_id: u64)]
pub struct ExecuteUsdcPayment<'info> {
    pub session_key: Signer<'info>,
    /// The Agent owner, relayer, or another explicit fee sponsor pays transaction fees and rent.
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Account<'info, Policy>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = agent)] pub vault_token_account: Account<'info, TokenAccount>,
    pub recipient: SystemAccount<'info>,
    #[account(init_if_needed, payer = fee_payer, associated_token::mint = usdc_mint, associated_token::authority = recipient)] pub recipient_token_account: Account<'info, TokenAccount>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(skill_id: [u8; 32])]
pub struct RegisterSkill<'info> {
    #[account(mut)] pub provider: Signer<'info>,
    #[account(init, payer = provider, space = 8 + Skill::INIT_SPACE, seeds = [b"skill", provider.key().as_ref(), skill_id.as_ref()], bump)] pub skill: Account<'info, Skill>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct UpdateSkill<'info> {
    pub provider: Signer<'info>,
    #[account(mut, has_one = provider, seeds = [b"skill", provider.key().as_ref(), skill.skill_id.as_ref()], bump = skill.bump)] pub skill: Account<'info, Skill>,
}
#[derive(Accounts)]
#[instruction(amount: u64, task_id: u64, deadline: i64, task_hash: [u8; 32], execution_id: u64)]
pub struct CreateEscrow<'info> {
    pub session_key: Signer<'info>,
    /// The Agent owner, relayer, or another explicit fee sponsor pays transaction fees and account rent.
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Account<'info, Policy>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
    /// CHECK: System-owned zero-data PDA vault.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump, constraint = vault.owner == &system_program::ID && vault.data_len() == 0)] pub vault: UncheckedAccount<'info>,
    pub worker_agent: Account<'info, Agent>,
    #[account(init, payer = fee_payer, space = 8 + Escrow::INIT_SPACE, seeds = [b"escrow", agent.key().as_ref(), task_id.to_le_bytes().as_ref()], bump)] pub escrow: Account<'info, Escrow>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(amount: u64, task_id: u64, deadline: i64, task_hash: [u8; 32], execution_id: u64)]
pub struct CreateUsdcEscrow<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"policy", agent.key().as_ref()], bump = policy.bump)] pub policy: Account<'info, Policy>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = agent)] pub vault_token_account: Account<'info, TokenAccount>,
    pub worker_agent: Account<'info, Agent>,
    #[account(init, payer = fee_payer, space = 8 + Escrow::INIT_SPACE, seeds = [b"escrow", agent.key().as_ref(), task_id.to_le_bytes().as_ref()], bump)] pub escrow: Account<'info, Escrow>,
    #[account(init_if_needed, payer = fee_payer, associated_token::mint = usdc_mint, associated_token::authority = escrow)] pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(init, payer = fee_payer, space = 8 + Execution::INIT_SPACE, seeds = [b"execution", agent.key().as_ref(), execution_id.to_le_bytes().as_ref()], bump)] pub execution: Account<'info, Execution>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SubmitEscrowResult<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump, has_one = owner)] pub worker_agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"escrow", escrow.agent.as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorker)] pub escrow: Account<'info, Escrow>,
}
#[derive(Accounts)]
pub struct SubmitEscrowResultWithSources<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump, has_one = owner)] pub worker_agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"escrow", escrow.agent.as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorker)] pub escrow: Account<'info, Escrow>,
    #[account(init, payer = owner, space = 8 + EscrowEvidence::INIT_SPACE, seeds = [b"escrow_evidence", escrow.key().as_ref()], bump)] pub evidence: Box<Account<'info, EscrowEvidence>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ProposeEscrowSettlement<'info> {
    #[account(mut)] pub proposer: Signer<'info>,
    #[account(seeds = [b"agent", employer_agent.owner.as_ref(), employer_agent.agent_id.as_ref()], bump = employer_agent.bump)] pub employer_agent: Account<'info, Agent>,
    #[account(seeds = [b"agent", worker_agent.owner.as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump)] pub worker_agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"escrow", employer_agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.agent == employer_agent.key() @ AgentOsError::InvalidEscrow, constraint = escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorker)] pub escrow: Account<'info, Escrow>,
    #[account(init_if_needed, payer = proposer, space = 8 + EscrowSettlement::INIT_SPACE, seeds = [b"escrow_settlement", escrow.key().as_ref()], bump)] pub settlement: Account<'info, EscrowSettlement>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct AcceptEscrowSettlement<'info> {
    #[account(mut)] pub accepter: Signer<'info>,
    #[account(seeds = [b"agent", employer_agent.owner.as_ref(), employer_agent.agent_id.as_ref()], bump = employer_agent.bump)] pub employer_agent: Account<'info, Agent>,
    #[account(seeds = [b"agent", worker_agent.owner.as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump)] pub worker_agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"escrow", employer_agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.agent == employer_agent.key() @ AgentOsError::InvalidEscrow, constraint = escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorker)] pub escrow: Account<'info, Escrow>,
    #[account(mut, close = accepter, seeds = [b"escrow_settlement", escrow.key().as_ref()], bump = settlement.bump, constraint = settlement.escrow == escrow.key() @ AgentOsError::InvalidEscrow)] pub settlement: Account<'info, EscrowSettlement>,
    /// CHECK: Employer vault PDA is validated against the employer Agent.
    #[account(mut, seeds = [b"vault", employer_agent.key().as_ref()], bump, constraint = employer_vault.owner == &system_program::ID && employer_vault.data_len() == 0)] pub employer_vault: UncheckedAccount<'info>,
    /// CHECK: Worker vault PDA is validated against the worker Agent.
    #[account(mut, seeds = [b"vault", worker_agent.key().as_ref()], bump, constraint = worker_vault.owner == &system_program::ID && worker_vault.data_len() == 0)] pub worker_vault: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"reputation", employer_agent.key().as_ref()], bump = employer_reputation.bump, constraint = employer_reputation.agent == employer_agent.key() @ AgentOsError::InvalidReputation)] pub employer_reputation: Account<'info, Reputation>,
    #[account(mut, seeds = [b"reputation", worker_agent.key().as_ref()], bump = worker_reputation.bump, constraint = worker_reputation.agent == worker_agent.key() @ AgentOsError::InvalidReputation)] pub worker_reputation: Account<'info, Reputation>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}
#[derive(Accounts)]
pub struct AcceptUsdcEscrowSettlement<'info> {
    #[account(mut)] pub accepter: Signer<'info>,
    #[account(seeds = [b"agent", employer_agent.owner.as_ref(), employer_agent.agent_id.as_ref()], bump = employer_agent.bump)] pub employer_agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"agent", worker_agent.owner.as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump)] pub worker_agent: Box<Account<'info, Agent>>,
    #[account(mut, seeds = [b"escrow", employer_agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.agent == employer_agent.key() @ AgentOsError::InvalidEscrow, constraint = escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorker)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(mut, close = accepter, seeds = [b"escrow_settlement", escrow.key().as_ref()], bump = settlement.bump, constraint = settlement.escrow == escrow.key() @ AgentOsError::InvalidEscrow)] pub settlement: Box<Account<'info, EscrowSettlement>>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = escrow)] pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = accepter, associated_token::mint = usdc_mint, associated_token::authority = worker_agent)] pub worker_token_account: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = accepter, associated_token::mint = usdc_mint, associated_token::authority = employer_agent)] pub employer_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"reputation", employer_agent.key().as_ref()], bump = employer_reputation.bump, constraint = employer_reputation.agent == employer_agent.key() @ AgentOsError::InvalidReputation)] pub employer_reputation: Box<Account<'info, Reputation>>,
    #[account(mut, seeds = [b"reputation", worker_agent.key().as_ref()], bump = worker_reputation.bump, constraint = worker_reputation.agent == worker_agent.key() @ AgentOsError::InvalidReputation)] pub worker_reputation: Box<Account<'info, Reputation>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}
#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump, has_one = owner)] pub worker_agent: Account<'info, Agent>,
    #[account(seeds = [b"agent", employer_agent.owner.as_ref(), employer_agent.agent_id.as_ref()], bump = employer_agent.bump)] pub employer_agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"escrow", employer_agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.agent == employer_agent.key() @ AgentOsError::InvalidEscrow, constraint = escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorker)] pub escrow: Account<'info, Escrow>,
    /// CHECK: Employer vault PDA derived from the validated employer Agent.
    #[account(mut, seeds = [b"vault", employer_agent.key().as_ref()], bump, constraint = employer_vault.owner == &system_program::ID && employer_vault.data_len() == 0)] pub employer_vault: UncheckedAccount<'info>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}
#[derive(Accounts)]
pub struct CancelUsdcEscrow<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(seeds = [b"agent", owner.key().as_ref(), worker_agent.agent_id.as_ref()], bump = worker_agent.bump, has_one = owner)] pub worker_agent: Account<'info, Agent>,
    #[account(seeds = [b"agent", employer_agent.owner.as_ref(), employer_agent.agent_id.as_ref()], bump = employer_agent.bump)] pub employer_agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"escrow", employer_agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump, constraint = escrow.agent == employer_agent.key() @ AgentOsError::InvalidEscrow, constraint = escrow.worker_agent == worker_agent.key() @ AgentOsError::InvalidWorker)] pub escrow: Account<'info, Escrow>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = escrow)] pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = owner, associated_token::mint = usdc_mint, associated_token::authority = employer_agent)] pub employer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}
#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    pub session_key: Signer<'info>,
    /// The Agent owner or another explicit fee sponsor pays transaction fees.
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Account<'info, Session>,
    #[account(mut, has_one = agent, seeds = [b"escrow", agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump)] pub escrow: Account<'info, Escrow>,
    #[account(constraint = worker_agent.key() == escrow.worker_agent @ AgentOsError::InvalidWorker)] pub worker_agent: Account<'info, Agent>,
    /// CHECK: Worker vault PDA derived from the validated worker Agent.
    #[account(mut, seeds = [b"vault", worker_agent.key().as_ref()], bump, constraint = worker_vault.owner == &system_program::ID && worker_vault.data_len() == 0)] pub worker_vault: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"reputation", worker_agent.key().as_ref()], bump = worker_reputation.bump, constraint = worker_reputation.agent == worker_agent.key() @ AgentOsError::InvalidReputation)] pub worker_reputation: Account<'info, Reputation>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}
#[derive(Accounts)]
pub struct ReleaseUsdcEscrow<'info> {
    pub session_key: Signer<'info>,
    #[account(mut)] pub fee_payer: Signer<'info>,
    #[account(seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Box<Account<'info, Agent>>,
    #[account(mut, seeds = [b"session", agent.key().as_ref(), session_key.key().as_ref()], bump = session.bump, constraint = session.agent == agent.key() && session.session_key == session_key.key() @ AgentOsError::InvalidSession)] pub session: Box<Account<'info, Session>>,
    #[account(mut, has_one = agent, seeds = [b"escrow", agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump)] pub escrow: Box<Account<'info, Escrow>>,
    #[account(constraint = worker_agent.key() == escrow.worker_agent @ AgentOsError::InvalidWorker)] pub worker_agent: Box<Account<'info, Agent>>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = escrow)] pub escrow_token_account: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = fee_payer, associated_token::mint = usdc_mint, associated_token::authority = worker_agent)] pub worker_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"reputation", worker_agent.key().as_ref()], bump = worker_reputation.bump, constraint = worker_reputation.agent == worker_agent.key() @ AgentOsError::InvalidReputation)] pub worker_reputation: Box<Account<'info, Reputation>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}
#[derive(Accounts)]
pub struct RefundExpiredEscrow<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"escrow", agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump)] pub escrow: Account<'info, Escrow>,
    /// CHECK: Employer vault PDA derived from the validated employer Agent.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump, constraint = employer_vault.owner == &system_program::ID && employer_vault.data_len() == 0)] pub employer_vault: UncheckedAccount<'info>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}
#[derive(Accounts)]
pub struct RefundExpiredUsdcEscrow<'info> {
    #[account(mut)] pub caller: Signer<'info>,
    #[account(seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"escrow", agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump)] pub escrow: Account<'info, Escrow>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = escrow)] pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = caller, associated_token::mint = usdc_mint, associated_token::authority = agent)] pub employer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}
#[derive(Accounts)]
pub struct RefundDisputedEscrow<'info> {
    #[account(mut)] pub caller: Signer<'info>,
    #[account(seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"escrow", agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump)] pub escrow: Account<'info, Escrow>,
    #[account(mut, close = caller, seeds = [b"escrow_settlement", escrow.key().as_ref()], bump = settlement.bump, constraint = settlement.escrow == escrow.key() @ AgentOsError::InvalidEscrow)] pub settlement: Account<'info, EscrowSettlement>,
    /// CHECK: Employer vault PDA is validated against the employer Agent.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump, constraint = employer_vault.owner == &system_program::ID && employer_vault.data_len() == 0)] pub employer_vault: UncheckedAccount<'info>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}
#[derive(Accounts)]
pub struct RefundDisputedUsdcEscrow<'info> {
    #[account(mut)] pub caller: Signer<'info>,
    #[account(seeds = [b"agent", agent.owner.as_ref(), agent.agent_id.as_ref()], bump = agent.bump)] pub agent: Account<'info, Agent>,
    #[account(mut, has_one = agent, seeds = [b"escrow", agent.key().as_ref(), escrow.task_id.to_le_bytes().as_ref()], bump = escrow.bump)] pub escrow: Account<'info, Escrow>,
    #[account(mut, close = caller, seeds = [b"escrow_settlement", escrow.key().as_ref()], bump = settlement.bump, constraint = settlement.escrow == escrow.key() @ AgentOsError::InvalidEscrow)] pub settlement: Account<'info, EscrowSettlement>,
    #[account(address = DEVNET_USDC_MINT)] pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = escrow)] pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = caller, associated_token::mint = usdc_mint, associated_token::authority = agent)] pub employer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(mut)] pub execution: Option<Account<'info, Execution>>,
    #[account(mut, seeds = [b"task_escrow", escrow.key().as_ref()], bump = task_link.bump)] pub task_link: Option<Box<Account<'info, TaskEscrow>>>,
    #[account(mut, seeds = [b"task", task.agent.as_ref(), task.task_id.to_le_bytes().as_ref()], bump = task.bump)] pub task: Option<Box<Account<'info, Task>>>,
}

#[account]
#[derive(InitSpace)]
pub struct Agent { pub owner: Pubkey, pub agent_id: [u8;32], pub name: [u8;32], pub status: AgentStatus, pub created_at: i64, pub execution_count: u64, pub bump: u8, pub reserved: [u8;16] }
#[account]
#[derive(InitSpace)]
pub struct Policy { pub agent: Pubkey, pub daily_limit_lamports: u64, pub per_tx_limit_lamports: u64, pub spent_today_lamports: u64, pub day_index: i64, pub allowed_actions: u8, pub paused: bool, pub bump: u8, pub reserved: [u8;16], pub daily_limit_usdc: u64, pub per_tx_limit_usdc: u64, pub spent_today_usdc: u64, pub day_index_usdc: i64 }
#[account]
#[derive(InitSpace)]
pub struct Session { pub agent: Pubkey, pub session_key: Pubkey, pub expires_at: i64, pub max_per_tx_lamports: u64, pub max_total_lamports: u64, pub spent_lamports: u64, pub permissions: u8, pub revoked: bool, pub bump: u8, pub reserved: [u8;16], pub max_per_tx_usdc: u64, pub max_total_usdc: u64, pub spent_usdc: u64 }
#[account]
#[derive(InitSpace)]
pub struct Skill { pub provider: Pubkey, pub skill_id: [u8;32], pub endpoint_hash: [u8;32], pub price_lamports: u64, pub active: bool, pub bump: u8, pub price_usdc: u64, pub reserved: [u8;8] }
#[account]
#[derive(InitSpace)]
pub struct Escrow { pub agent: Pubkey, pub worker_agent: Pubkey, pub task_id: u64, pub amount: u64, pub deadline: i64, pub task_hash: [u8;32], pub result_hash: Option<[u8;32]>, pub status: EscrowStatus, pub bump: u8, pub reserved: [u8;16], pub asset: ExecutionAsset }
#[account]
#[derive(InitSpace)]
pub struct EscrowSettlement { pub escrow: Pubkey, pub proposer: Pubkey, pub worker_amount: u64, pub deadline: i64, pub bump: u8 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct EscrowEvidenceSource { pub execution: Pubkey, pub output_hash: [u8; 32] }
#[account]
#[derive(InitSpace)]
pub struct EscrowEvidence { pub escrow: Pubkey, pub result_hash: [u8; 32], #[max_len(3)] pub sources: Vec<EscrowEvidenceSource>, pub bump: u8 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EscrowSettlementTerms { pub proposer: Pubkey, pub worker_amount: u64, pub deadline: i64 }
#[account]
#[derive(InitSpace)]
pub struct Execution { pub agent: Pubkey, pub execution_id: u64, pub asset: ExecutionAsset, pub action: ExecutionAction, pub amount: u64, pub created_at: i64, pub input_hash: [u8;32], pub output_hash: Option<[u8;32]>, pub status: ExecutionStatus }
#[account]
#[derive(InitSpace)]
pub struct Reputation { pub agent: Pubkey, pub completed_tasks: u64, pub successful_tasks: u64, pub failed_tasks: u64, pub total_volume_lamports: u64, pub score: u64, pub disputes: u64, pub bump: u8, pub reserved: [u8;16], pub total_volume_usdc: u64 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum AgentStatus { Active, Paused }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum EscrowStatus { Funded, Released, Refunded, Cancelled, SettlementProposed, Settled }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum ExecutionAction { Payment, SkillPayment, Escrow, TaskSkillPayment }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum ExecutionAsset { Sol, Usdc }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum ExecutionStatus { Completed, Refunded, Settled }

#[event] pub struct AgentCreated { pub agent: Pubkey, pub owner: Pubkey, pub created_at: i64 }
#[event] pub struct AgentStatusChanged { pub agent: Pubkey, pub status: AgentStatus }
#[event] pub struct PolicyUpdated { pub agent: Pubkey, pub daily_limit: u64, pub per_tx_limit: u64, pub daily_limit_usdc: u64, pub per_tx_limit_usdc: u64, pub allowed_actions: u8, pub paused: bool }
#[event] pub struct SessionCreated { pub agent: Pubkey, pub session_key: Pubkey, pub expires_at: i64, pub max_total: u64 }
#[event] pub struct SessionRevoked { pub agent: Pubkey, pub session_key: Pubkey }
#[event] pub struct VaultFunded { pub agent: Pubkey, pub amount: u64 }
#[event] pub struct VaultWithdrawn { pub agent: Pubkey, pub destination: Pubkey, pub amount: u64 }
#[event] pub struct UsdcVaultFunded { pub agent: Pubkey, pub owner: Pubkey, pub amount: u64 }
#[event] pub struct UsdcVaultWithdrawn { pub agent: Pubkey, pub owner: Pubkey, pub amount: u64 }
#[event] pub struct ServicePaymentExecuted { pub agent: Pubkey, pub session_key: Pubkey, pub recipient: Pubkey, pub amount: u64, pub asset: ExecutionAsset, pub execution_id: u64, pub input_hash: [u8;32] }
#[event] pub struct PaymentExecuted { pub agent: Pubkey, pub session_key: Pubkey, pub recipient: Pubkey, pub amount: u64, pub action: u8, pub execution_id: u64, pub input_hash: [u8;32], pub output_hash: [u8;32] }
#[event] pub struct UsdcPaymentExecuted { pub agent: Pubkey, pub session_key: Pubkey, pub recipient: Pubkey, pub amount: u64, pub execution_id: u64, pub input_hash: [u8;32], pub output_hash: [u8;32] }
#[event] pub struct SkillRegistered { pub provider: Pubkey, pub skill_id: [u8;32], pub price: u64, pub price_usdc: u64, pub active: bool }
#[event] pub struct SkillUpdated { pub provider: Pubkey, pub skill_id: [u8;32], pub price: u64, pub price_usdc: u64, pub active: bool }
#[event] pub struct SkillPaymentExecuted { pub agent: Pubkey, pub session_key: Pubkey, pub provider: Pubkey, pub skill_id: [u8;32], pub amount: u64, pub execution_id: u64, pub input_hash: [u8;32] }
#[event] pub struct UsdcSkillPaymentExecuted { pub agent: Pubkey, pub session_key: Pubkey, pub provider: Pubkey, pub skill_id: [u8;32], pub amount: u64, pub execution_id: u64, pub input_hash: [u8;32] }
#[event] pub struct SkillResultRecorded { pub agent: Pubkey, pub session_key: Pubkey, pub execution_id: u64, pub input_hash: [u8;32], pub output_hash: [u8;32] }
#[event] pub struct EscrowFunded { pub agent: Pubkey, pub worker_agent: Pubkey, pub task_id: u64, pub amount: u64, pub deadline: i64, pub task_hash: [u8;32] }
#[event] pub struct UsdcEscrowFunded { pub agent: Pubkey, pub worker_agent: Pubkey, pub task_id: u64, pub amount: u64, pub deadline: i64, pub task_hash: [u8;32] }
#[event] pub struct EscrowResultSubmitted { pub agent: Pubkey, pub worker_agent: Pubkey, pub task_id: u64, pub result_hash: [u8;32] }
#[event] pub struct EscrowReleased { pub agent: Pubkey, pub worker_agent: Pubkey, pub task_id: u64, pub amount: u64, pub result_hash: [u8;32] }
#[event] pub struct UsdcEscrowReleased { pub agent: Pubkey, pub worker_agent: Pubkey, pub task_id: u64, pub amount: u64, pub result_hash: [u8;32] }
#[event] pub struct EscrowRefunded { pub agent: Pubkey, pub task_id: u64, pub amount: u64 }
#[event] pub struct UsdcEscrowRefunded { pub agent: Pubkey, pub task_id: u64, pub amount: u64 }
#[event] pub struct EscrowCancelled { pub agent: Pubkey, pub worker_agent: Pubkey, pub task_id: u64, pub amount: u64 }
#[event] pub struct UsdcEscrowCancelled { pub agent: Pubkey, pub worker_agent: Pubkey, pub task_id: u64, pub amount: u64 }
#[event] pub struct EscrowSettlementProposed { pub agent: Pubkey, pub worker_agent: Pubkey, pub task_id: u64, pub proposer: Pubkey, pub worker_amount: u64, pub settlement_deadline: i64 }
#[event] pub struct EscrowSettlementAccepted { pub agent: Pubkey, pub worker_agent: Pubkey, pub task_id: u64, pub worker_amount: u64, pub employer_amount: u64 }

#[error_code]
pub enum AgentOsError {
    #[msg("Agent name cannot be empty")] EmptyName,
    #[msg("Spending limits are invalid")] InvalidLimit,
    #[msg("Action is not permitted by policy or session")] InvalidPermission,
    #[msg("Agent is not active")] AgentInactive,
    #[msg("Session has been revoked")] SessionRevoked,
    #[msg("Session is invalid or expired")] InvalidSession,
    #[msg("Policy is paused or does not belong to this Agent")] PolicyPaused,
    #[msg("Per-transaction spending limit exceeded")] PerTransactionLimitExceeded,
    #[msg("Daily spending limit exceeded")] DailyLimitExceeded,
    #[msg("Session spending limit exceeded")] SessionLimitExceeded,
    #[msg("Vault has insufficient funds")] InsufficientFunds,
    #[msg("Amount must be greater than zero")] InvalidAmount,
    #[msg("Expiry or deadline is outside the allowed range")] InvalidExpiry,
    #[msg("Worker Agent is invalid")] InvalidWorker,
    #[msg("Skill is inactive")] SkillInactive,
    #[msg("Skill price changed since the payment was reviewed")] SkillPriceChanged,
    #[msg("The configured mint is not the expected Devnet USDC mint")] InvalidMint,
    #[msg("The Escrow contains a different asset than this instruction supports")] InvalidAsset,
    #[msg("Escrow state does not allow this operation")] InvalidEscrowState,
    #[msg("Escrow has not expired")] EscrowNotExpired,
    #[msg("Escrow owner or rent reserve is invalid")] InvalidEscrow,
    #[msg("Reputation account does not match worker Agent")] InvalidReputation,
    #[msg("Execution ID is not the next sequence number")] UnexpectedExecutionId,
    #[msg("Execution record is not a Skill payment for this Agent")] InvalidSkillExecution,
    #[msg("Execution record does not match this Escrow")] InvalidEscrowExecution,
    #[msg("Skill result has already been recorded")] SkillResultAlreadyRecorded,
    #[msg("Arithmetic overflow")] MathOverflow,
    #[msg("Escrow result has already been submitted")] EscrowResultAlreadySubmitted,
    #[msg("Escrow result has not been submitted by the Worker Agent owner")] EscrowResultMissing,
    #[msg("Escrow has expired and can no longer accept a result")] EscrowExpired,
    #[msg("A Worker can cancel only a funded Escrow before submitting a result and before its deadline")] EscrowCannotBeCancelled,
    #[msg("Only the employer or worker Agent owner can propose or accept settlement")] UnauthorizedSettlementParty,
    #[msg("Mutual settlement requires different employer and worker owners")] SettlementNeedsDistinctOwners,
    #[msg("The proposed worker amount exceeds the funded Escrow amount")] InvalidSettlementAmount,
    #[msg("The mutual settlement proposal has expired")] SettlementExpired,
    #[msg("Settlement terms changed since review; refresh and review the current split")] SettlementTermsChanged,
    #[msg("Escrow evidence requires one to three distinct completed Skill results belonging to the Worker")] InvalidEscrowEvidence,
    #[msg("Task status does not allow this operation")] InvalidTaskState,
    #[msg("Task deadline has expired")] TaskExpired,
    #[msg("Independent task spending limit exceeded")] TaskBudgetExceeded,
    #[msg("Session is bound to another task or requires a task-scoped instruction")] InvalidTaskSession,
    #[msg("Task completion requires a result hash and no pending Escrows")] TaskResultRequired,
    #[msg("Worker delivery permit is revoked, used, expired or does not match the Escrow and Session")] InvalidWorkerDelivery,
    #[msg("Judge mandate is not accepted, was declined, used or does not match these accounts")] InvalidJudgeMandate,
    #[msg("Judge must have a different Agent and owner from both Escrow parties")] JudgeMustBeIndependent,
    #[msg("Judge authorization or settlement deadline has expired")] JudgeExpired,
    #[msg("Judge authorization terms changed since review")] JudgeTermsChanged,
    #[msg("Judgment commitments do not match the authorized task and submitted result")] JudgeCommitmentMismatch,
    #[msg("This judgment requires manual review and cannot move funds")] JudgeNeedsReview,
    #[msg("Task completion permit is revoked, used, expired or does not match the plan")] InvalidTaskCompletion,
    #[msg("Task action count or spending changed since completion was prepared")] TaskCompletionChanged,
}

#[cfg(test)]
mod settlement_tests {
    use super::*;
    use anchor_lang::InstructionData;

    fn fixture() -> (EscrowSettlement, EscrowSettlementTerms, Pubkey, Pubkey) {
        let employer = Pubkey::new_from_array([1; 32]);
        let worker = Pubkey::new_from_array([2; 32]);
        (EscrowSettlement { escrow: Pubkey::new_from_array([3; 32]), proposer: employer, worker_amount: 40, deadline: 1_000, bump: 255 },
         EscrowSettlementTerms { proposer: employer, worker_amount: 40, deadline: 1_000 }, employer, worker)
    }

    fn assert_error<T>(result: Result<T>, expected: &str) {
        match result {
            Err(anchor_lang::error::Error::AnchorError(error)) => assert_eq!(error.error_name, expected),
            _ => panic!("expected Anchor error {expected}"),
        }
    }

    #[test]
    fn both_counterparties_can_accept_exact_terms() {
        let (mut proposal, mut terms, employer, worker) = fixture();
        assert_eq!(validate_settlement_acceptance(&proposal, &terms, employer, worker, worker, 999, 100).unwrap(), (40, 60));
        proposal.proposer = worker;
        terms.proposer = worker;
        assert_eq!(validate_settlement_acceptance(&proposal, &terms, employer, worker, employer, 999, 100).unwrap(), (40, 60));
    }

    #[test]
    fn review_cannot_accept_a_changed_split_proposer_or_deadline() {
        let (proposal, terms, employer, worker) = fixture();
        let changed = [
            EscrowSettlementTerms { worker_amount: 41, ..terms.clone() },
            EscrowSettlementTerms { proposer: worker, ..terms.clone() },
            EscrowSettlementTerms { deadline: 1_001, ..terms.clone() },
        ];
        for reviewed in changed {
            assert_error(validate_settlement_acceptance(&proposal, &reviewed, employer, worker, worker, 999, 100), "SettlementTermsChanged");
        }
    }

    #[test]
    fn proposer_and_unrelated_wallet_cannot_accept() {
        let (proposal, terms, employer, worker) = fixture();
        for accepter in [employer, Pubkey::new_from_array([4; 32])] {
            assert_error(validate_settlement_acceptance(&proposal, &terms, employer, worker, accepter, 999, 100), "UnauthorizedSettlementParty");
        }
        assert_error(validate_settlement_acceptance(&proposal, &terms, employer, employer, employer, 999, 100), "SettlementNeedsDistinctOwners");
    }

    #[test]
    fn expiry_boundary_is_exclusive() {
        let (proposal, terms, employer, worker) = fixture();
        for now in [1_000, 1_001] {
            assert_error(validate_settlement_acceptance(&proposal, &terms, employer, worker, worker, now, 100), "SettlementExpired");
        }
    }

    #[test]
    fn extreme_splits_conserve_the_entire_funded_amount() {
        let (mut proposal, mut terms, employer, worker) = fixture();
        for worker_amount in [0, 1, u64::MAX] {
            proposal.worker_amount = worker_amount;
            terms.worker_amount = worker_amount;
            let (worker_share, employer_share) = validate_settlement_acceptance(&proposal, &terms, employer, worker, worker, 999, u64::MAX).unwrap();
            assert_eq!(worker_share.checked_add(employer_share), Some(u64::MAX));
        }
        assert_error(validate_settlement_acceptance(&proposal, &terms, employer, worker, worker, 999, u64::MAX - 1), "InvalidSettlementAmount");
    }

    #[test]
    fn both_asset_instructions_encode_the_reviewed_terms() {
        let (_, terms, _, _) = fixture();
        let sol = crate::instruction::AcceptEscrowSettlementV2 { expected: terms.clone() }.data();
        let usdc = crate::instruction::AcceptUsdcEscrowSettlementV2 { expected: terms.clone() }.data();
        let mut expected = terms.proposer.to_bytes().to_vec();
        expected.extend_from_slice(&terms.worker_amount.to_le_bytes());
        expected.extend_from_slice(&terms.deadline.to_le_bytes());
        assert_eq!(&sol[8..], expected.as_slice());
        assert_eq!(&usdc[8..], expected.as_slice());
        assert_ne!(&sol[..8], &usdc[..8]);
    }

    #[test]
    fn initial_proposal_requires_open_task_and_starts_one_72_hour_window() {
        assert_eq!(settlement_proposal_deadline(EscrowStatus::Funded, 999, 1_000, 0).unwrap(), 999 + 72 * 60 * 60);
        assert_error(settlement_proposal_deadline(EscrowStatus::Funded, 1_000, 1_000, 0), "EscrowExpired");
    }

    #[test]
    fn counter_proposals_use_the_remaining_window_after_original_task_expiry() {
        assert_eq!(settlement_proposal_deadline(EscrowStatus::SettlementProposed, 2_000, 1_000, 3_000).unwrap(), 3_000);
        assert_error(settlement_proposal_deadline(EscrowStatus::SettlementProposed, 3_000, 1_000, 3_000), "SettlementExpired");
    }

    #[test]
    fn terminal_escrows_cannot_restart_negotiation() {
        for status in [EscrowStatus::Released, EscrowStatus::Refunded, EscrowStatus::Cancelled, EscrowStatus::Settled] {
            assert_error(settlement_proposal_deadline(status, 999, 1_000, 3_000), "InvalidEscrowState");
        }
    }

    #[test]
    fn proposal_deadline_cannot_overflow() {
        assert_error(settlement_proposal_deadline(EscrowStatus::Funded, i64::MAX - 1, i64::MAX, 0), "MathOverflow");
    }
}
