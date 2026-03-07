// GHOST Protocol v1.9 — 2026-03-07
// Changes from v1.8:
//   - Added 0.5% protocol fee on execute_transfer and execute_whole_vault_transfer
//     Fee is deducted from transfer amount, sent to PROTOCOL_FEE_WALLET token account
//     Fee account validated via token::authority = PROTOCOL_FEE_WALLET constraint
//     Burns (execute_burn, execute_whole_vault_burn) have no fee — nothing to collect
//   - Added 0.02 SOL registration fee on initialize_ghost → BOT_OPS_WALLET
//     Funds the executor bot for tx fees and rent costs
//     Bot wallet address hardcoded as constant, validated via constraint
//   - New constants: EXECUTION_FEE_BPS, REGISTRATION_FEE_LAMPORTS, PROTOCOL_FEE_WALLET, BOT_OPS_WALLET
//   - New accounts in InitializeGhost: bot_ops_wallet (receives SOL fee)
//   - New accounts in ExecuteTransfer: fee_token_account (receives token fee)
//   - New accounts in ExecuteWholeVaultTransfer: fee_token_account (receives token fee)
//   - No GhostAccount struct changes — no migration needed, no schema version bump
//   - No changes to: ping, beneficiaries, settings, recovery, deposit, withdraw, abandon, migrate
//
// DEPLOYMENT CHECKLIST (v1.9):
//   1. Replace PROTOCOL_FEE_WALLET and BOT_OPS_WALLET byte arrays with real pubkeys
//   2. anchor build && anchor deploy (program upgrade)
//   3. Update bot.js: pass fee_token_account in execute_transfer/execute_whole_vault_transfer
//   4. Update bot.js: ensure fee wallet token accounts exist before each execute call
//   5. Update frontend initializeGhost: pass bot_ops_wallet account
//   6. Bot and frontend must deploy simultaneously with program upgrade
//
// GHOST Protocol v1.8 — 2026-03-02
// Changes from v1.7b:
//   - MIN_INTERVAL reduced from 7 days to 1 hour (for testing flexibility)
//   - MIN_GRACE_PERIOD reduced from 24h to 0 (allow instant execution / zero grace)
//   - Added migrate_ghost instruction: on-chain account layout upgrade (v1.7 → v1.8)
//   - abandon_ghost is now callable from frontend (was stub)
//   - schema_version properly added as last field in GhostAccount struct
//   - New accounts initialize with schema_version = SCHEMA_VERSION_V18
//
// ═══════════════════════════════════════════════════════════════════════
// UPGRADE GUIDE — READ THIS BEFORE EVERY FUTURE PROGRAM VERSION
// ═══════════════════════════════════════════════════════════════════════
//
// ADDING A NEW FIELD (e.g. for v1.9):
//   1. Append the new field at the END of GhostAccount struct. Never reorder or insert.
//   2. Increase GHOST_ACCOUNT_SPACE by the byte size of the new field.
//   3. Add a new SCHEMA_VERSION_V19: u8 = 19 constant below.
//   4. Update CURRENT_SCHEMA_VERSION to point to the new constant.
//   5. In initialize_ghost: set new_field = default_value; schema_version = CURRENT_SCHEMA_VERSION;
//   6. In migrate_ghost: add realloc to new GHOST_ACCOUNT_SPACE, set new_field = default_value,
//      set schema_version = CURRENT_SCHEMA_VERSION.
//   7. In the frontend: bump MIN_SUPPORTED_VERSION and gate new UI features with isVersionSufficient().
//
// NEVER:
//   - Reorder existing fields (breaks Borsh deserialization on all existing accounts)
//   - Remove or rename existing fields (use _deprecated_fieldname: u8 tombstones instead)
//   - Change a field's type (same byte-break risk as reordering)
//   - Decrease GHOST_ACCOUNT_SPACE
//
// MIGRATION PHILOSOPHY:
//   - Old accounts are NOT broken — they just see a migration banner in the UI
//   - New features are gated in the frontend via isVersionSufficient(minVersion)
//   - migrate_ghost is the single upgrade path: realloc + fill defaults + bump schema_version
//   - Existing core features (ping, heartbeat, beneficiaries, vault) always work regardless of version
// ═══════════════════════════════════════════════════════════════════════
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, TokenAccount, TokenInterface, TransferChecked, Mint};

declare_id!("3Es13GXc4qwttE6uSgAAfi1zvBD3qzLkZpY21KfT3sZ3");

pub const GHOST_SEED: &[u8] = b"ghost";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MIN_STAKE: u64 = 10_000 * 1_000_000;
pub const MIN_INTERVAL: i64 = 60 * 60;          // 1 hour minimum (was 7 days)
pub const MIN_GRACE_PERIOD: i64 = 0;             // 0 = instant execution allowed (was 24h)
pub const MAX_BENEFICIARIES: usize = 10;
pub const MAX_RECOVERY_WALLETS: usize = 3;
pub const SILENCE_BOUNTY_BPS: u64 = 500;
pub const BURN_ON_ABANDON_BPS: u64 = 5_000;
pub const EXECUTION_FEE_BPS: u64 = 50;           // 0.5% fee on executed asset transfers
pub const REGISTRATION_FEE_LAMPORTS: u64 = 20_000_000; // 0.02 SOL bot operations fee

// ── Fee wallet addresses ─────────────────────────────────────────────
// PROTOCOL_FEE_WALLET: receives 0.5% of executed token transfers
// BOT_OPS_WALLET: receives 0.02 SOL registration fee for executor bot funding
// TODO: Replace these byte arrays with your actual wallet pubkey bytes.
// Use: `solana-keygen pubkey --outfile` or decode base58 in JS to get the 32 bytes.
pub const PROTOCOL_FEE_WALLET: Pubkey = Pubkey::new_from_array([28, 176, 224, 21, 248, 34, 78, 192, 133, 185, 51, 229, 201, 59, 102, 254, 168, 177, 75, 146, 239, 52, 155, 164, 9, 137, 78, 138, 119, 191, 10, 243]); // 2vzr1Wpir7BmwcCetiQ4sJC48vztMdQQ7qRYkZ8udob8
pub const BOT_OPS_WALLET: Pubkey = Pubkey::new_from_array([181, 207, 57, 180, 202, 88, 132, 168, 31, 89, 196, 244, 9, 255, 246, 157, 112, 66, 149, 202, 217, 247, 181, 5, 203, 75, 29, 147, 135, 97, 101, 59]); // DEi4jzA8bsZDzEhhbf64kFXba7ABnzBNAWbMQKwKGPqC
// ── Schema version constants ─────────────────────────────────────────────
// When adding a new version: add SCHEMA_VERSION_VXX constant, update CURRENT_SCHEMA_VERSION,
// update GHOST_ACCOUNT_SPACE, and follow the UPGRADE GUIDE at the top of this file.
pub const SCHEMA_VERSION_V17: u8 = 17;           // legacy accounts — schema_version field did not exist yet
pub const SCHEMA_VERSION_V18: u8 = 18;           // v1.8: schema_version added as last struct field
pub const CURRENT_SCHEMA_VERSION: u8 = SCHEMA_VERSION_V18; // always points to latest — update on each upgrade

// ── Account space ────────────────────────────────────────────────────────
// GHOST_ACCOUNT_SPACE must equal the exact Borsh-serialized byte size of GhostAccount
// (excluding the 8-byte Anchor discriminator prefix added automatically).
// When adding a new field: increase this by the field's byte size.
//   v1.7 = 1220 bytes (schema_version was a raw trailing byte, not in struct)
//   v1.8 = 1221 bytes (schema_version: u8 added as proper last struct field)
pub const GHOST_ACCOUNT_SPACE: usize = 1221;

fn is_recovery_wallet(wallets: &[Option<Pubkey>; 3], key: Pubkey) -> bool {
    wallets.iter().any(|slot| slot.map_or(false, |w| w == key))
}

#[program]
pub mod ghost_protocol {
    use super::*;

    pub fn initialize_ghost(
        ctx: Context<InitializeGhost>,
        interval_seconds: i64,
        grace_period_seconds: i64,
        stake_amount: u64,
    ) -> Result<()> {
        require!(stake_amount >= MIN_STAKE, GhostError::InsufficientStake);
        require!(interval_seconds >= MIN_INTERVAL, GhostError::IntervalTooShort);
        require!(grace_period_seconds >= MIN_GRACE_PERIOD, GhostError::GracePeriodTooShort);

        let ghost = &mut ctx.accounts.ghost;
        let clock = Clock::get()?;

        ghost.owner = ctx.accounts.signer.key();
        ghost.recovery_wallets = [None, None, None];
        ghost.last_heartbeat = clock.unix_timestamp;
        ghost.interval_seconds = interval_seconds;
        ghost.grace_period_seconds = grace_period_seconds;
        ghost.awakened = false;
        ghost.awakened_at = None;
        ghost.executed = false;
        ghost.executed_at = None;
        ghost.staked_ghost = stake_amount;
        ghost.bump = ctx.bumps.ghost;
        ghost.vault_bump = ctx.bumps.vault;
        ghost.registered_at = clock.unix_timestamp;
        ghost.ping_count = 0;
        ghost.beneficiary_count = 0;
        ghost.whole_vault_action = 0;
        ghost.display_name = [0u8; 32];
        ghost.image_uri = [0u8; 128];
        ghost.whole_vault_recipient = None;
        ghost.paused = false;
        ghost.pending_owner = None;
        for i in 0..10 {
            ghost.beneficiaries[i] = Beneficiary::default();
        }
        // v1.8: set schema_version on new accounts so they never need migration.
        // Future versions: update this line to use CURRENT_SCHEMA_VERSION (which you
        // should update to point to the new SCHEMA_VERSION_VXX constant).
        ghost.schema_version = CURRENT_SCHEMA_VERSION;

        // ── Registration fee: 0.02 SOL → bot operations wallet ──────────────
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.signer.key(),
            &BOT_OPS_WALLET,
            REGISTRATION_FEE_LAMPORTS,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.signer.to_account_info(),
                ctx.accounts.bot_ops_wallet.to_account_info(),
            ],
        )?;

        // ── Stake $GHOST transfer ───────────────────────────────────────────
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.signer_token_account.to_account_info(),
                to: ctx.accounts.ghost_stake_vault.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
                mint: ctx.accounts.ghost_mint.to_account_info(),
            },
        );
        token_interface::transfer_checked(cpi_ctx, stake_amount, ctx.accounts.ghost_mint.decimals)?;

        emit!(GhostRegistered {
            soul: ghost.owner,
            interval: interval_seconds,
            grace_period: grace_period_seconds,
            recovery_wallets: [None, None, None],
            staked: stake_amount,
            timestamp: clock.unix_timestamp,
        });

        msg!("Ghost initialized for {}", ghost.owner);
        Ok(())
    }

    pub fn ping(ctx: Context<Ping>) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(!ghost.executed, GhostError::GhostAlreadyExecuted);
        let clock = Clock::get()?;
        ghost.last_heartbeat = clock.unix_timestamp;
        ghost.ping_count += 1;
        if ghost.awakened {
            ghost.awakened = false;
            ghost.awakened_at = None;
            msg!("Ping received - awakening cancelled");
        } else {
            msg!("Heartbeat #{} recorded", ghost.ping_count);
        }
        emit!(HeartbeatReceived { soul: ghost.owner, timestamp: clock.unix_timestamp, ping_number: ghost.ping_count });
        Ok(())
    }

    pub fn add_beneficiary(ctx: Context<ManageBeneficiaries>, recipient: Pubkey, amount: u64, token_mint: Option<Pubkey>, action: u8) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(!ghost.awakened, GhostError::GhostAlreadyAwakened);
        require!(!ghost.paused, GhostError::GhostPausedError);
        require!((ghost.beneficiary_count as usize) < MAX_BENEFICIARIES, GhostError::TooManyBeneficiaries);
        let idx = ghost.beneficiary_count as usize;
        ghost.beneficiaries[idx] = Beneficiary { recipient, amount, token_mint, action, executed: false };
        ghost.beneficiary_count += 1;
        emit!(BeneficiaryAdded { soul: ghost.owner, recipient, amount, action });
        msg!("Beneficiary added: {} receives {}", recipient, amount);
        Ok(())
    }

    pub fn remove_beneficiary(ctx: Context<ManageBeneficiaries>, index: u8) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(!ghost.awakened, GhostError::GhostAlreadyAwakened);
        require!((index as usize) < ghost.beneficiary_count as usize, GhostError::InvalidBeneficiary);
        let count = ghost.beneficiary_count as usize;
        for i in (index as usize)..(count - 1) { ghost.beneficiaries[i] = ghost.beneficiaries[i + 1]; }
        ghost.beneficiary_count -= 1;
        msg!("Beneficiary at index {} removed", index);
        Ok(())
    }

    pub fn update_beneficiary(ctx: Context<ManageBeneficiaries>, index: u8, recipient: Pubkey, amount: u64, token_mint: Option<Pubkey>, action: u8) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(!ghost.awakened, GhostError::GhostAlreadyAwakened);
        require!(!ghost.paused, GhostError::GhostPausedError);
        require!((index as usize) < ghost.beneficiary_count as usize, GhostError::InvalidBeneficiary);
        let slot = &mut ghost.beneficiaries[index as usize];
        let old_recipient = slot.recipient;
        let old_amount = slot.amount;
        slot.recipient = recipient; slot.amount = amount; slot.token_mint = token_mint; slot.action = action; slot.executed = false;
        emit!(BeneficiaryUpdated { soul: ghost.owner, index, old_recipient, new_recipient: recipient, old_amount, new_amount: amount, action });
        msg!("Beneficiary at index {} updated", index);
        Ok(())
    }

    pub fn guardian_remove_beneficiary(ctx: Context<GuardianManageBeneficiaries>, index: u8) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(is_recovery_wallet(&ghost.recovery_wallets, ctx.accounts.recovery_wallet.key()), GhostError::Unauthorized);
        require!(!ghost.executed, GhostError::GhostAlreadyExecuted);
        require!((index as usize) < ghost.beneficiary_count as usize, GhostError::InvalidBeneficiary);
        let count = ghost.beneficiary_count as usize;
        for i in (index as usize)..(count - 1) { ghost.beneficiaries[i] = ghost.beneficiaries[i + 1]; }
        ghost.beneficiary_count -= 1;
        msg!("Guardian removed beneficiary at index {}", index);
        Ok(())
    }

    pub fn guardian_clear_beneficiaries(ctx: Context<GuardianManageBeneficiaries>) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(is_recovery_wallet(&ghost.recovery_wallets, ctx.accounts.recovery_wallet.key()), GhostError::Unauthorized);
        require!(!ghost.executed, GhostError::GhostAlreadyExecuted);
        let cleared_count = ghost.beneficiary_count;
        for i in 0..MAX_BENEFICIARIES { ghost.beneficiaries[i] = Beneficiary::default(); }
        ghost.beneficiary_count = 0;
        emit!(BeneficiariesCleared { soul: ghost.owner, cleared_by: ctx.accounts.recovery_wallet.key(), count: cleared_count });
        msg!("Guardian cleared {} beneficiaries", cleared_count);
        Ok(())
    }

    pub fn guardian_set_whole_vault_recipient(ctx: Context<GuardianManageBeneficiaries>, recipient: Option<Pubkey>, action: u8) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(is_recovery_wallet(&ghost.recovery_wallets, ctx.accounts.recovery_wallet.key()), GhostError::Unauthorized);
        require!(!ghost.executed, GhostError::GhostAlreadyExecuted);
        let previous = ghost.whole_vault_recipient;
        ghost.whole_vault_recipient = recipient;
        ghost.whole_vault_action = if recipient.is_some() { action } else { 0 };
        emit!(WholeVaultRecipientSet { soul: ghost.owner, recipient, cleared: recipient.is_none(), previous });
        msg!("Guardian updated whole vault recipient — action: {}", action);
        Ok(())
    }

    pub fn set_whole_vault_recipient(ctx: Context<UpdateSettings>, recipient: Option<Pubkey>, action: u8) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(!ghost.awakened, GhostError::GhostAlreadyAwakened);
        require!(!ghost.executed, GhostError::GhostAlreadyExecuted);
        let previous = ghost.whole_vault_recipient;
        ghost.whole_vault_recipient = recipient;
        ghost.whole_vault_action = if recipient.is_some() { action } else { 0 };
        emit!(WholeVaultRecipientSet { soul: ghost.owner, recipient, cleared: recipient.is_none(), previous });
        msg!("Whole vault recipient updated — action: {}", action);
        Ok(())
    }

    pub fn set_ghost_profile(ctx: Context<UpdateSettings>, display_name: [u8; 32], image_uri: [u8; 128]) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        ghost.display_name = display_name;
        ghost.image_uri = image_uri;
        msg!("Ghost profile updated");
        Ok(())
    }

    pub fn pause_ghost(ctx: Context<UpdateSettings>) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(!ghost.paused, GhostError::GhostPausedError);
        require!(!ghost.executed, GhostError::GhostAlreadyExecuted);
        ghost.paused = true;
        let clock = Clock::get()?;
        emit!(GhostPaused { soul: ghost.owner, timestamp: clock.unix_timestamp });
        msg!("Ghost paused by owner");
        Ok(())
    }

    pub fn resume_ghost(ctx: Context<UpdateSettings>) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(ghost.paused, GhostError::GhostNotPaused);
        ghost.paused = false;
        let clock = Clock::get()?;
        emit!(GhostResumed { soul: ghost.owner, timestamp: clock.unix_timestamp });
        msg!("Ghost resumed by owner");
        Ok(())
    }

    pub fn transfer_ownership(ctx: Context<UpdateSettings>, new_owner: Pubkey) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(!ghost.executed, GhostError::GhostAlreadyExecuted);
        require!(new_owner != ghost.owner, GhostError::Unauthorized);
        ghost.pending_owner = Some(new_owner);
        let clock = Clock::get()?;
        emit!(OwnershipTransferInitiated { soul: ghost.owner, pending_owner: new_owner, timestamp: clock.unix_timestamp });
        msg!("Ownership transfer initiated to {}", new_owner);
        Ok(())
    }

    pub fn accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(ghost.pending_owner.map_or(false, |p| p == ctx.accounts.new_owner.key()), GhostError::NoPendingOwnerTransfer);
        let old_owner = ghost.owner;
        ghost.owner = ctx.accounts.new_owner.key();
        ghost.pending_owner = None;
        let clock = Clock::get()?;
        emit!(OwnershipTransferAccepted { old_owner, new_owner: ghost.owner, timestamp: clock.unix_timestamp });
        msg!("Ownership transferred from {} to {}", old_owner, ghost.owner);
        Ok(())
    }

    pub fn update_interval_and_grace(ctx: Context<UpdateSettings>, interval_seconds: i64, grace_period_seconds: i64) -> Result<()> {
        require!(interval_seconds >= MIN_INTERVAL, GhostError::IntervalTooShort);
        require!(grace_period_seconds >= MIN_GRACE_PERIOD, GhostError::GracePeriodTooShort);
        ctx.accounts.ghost.interval_seconds = interval_seconds;
        ctx.accounts.ghost.grace_period_seconds = grace_period_seconds;
        msg!("Interval set to {}s, grace period set to {}s", interval_seconds, grace_period_seconds);
        Ok(())
    }

    pub fn update_interval(ctx: Context<UpdateSettings>, interval_seconds: i64) -> Result<()> {
        require!(interval_seconds >= MIN_INTERVAL, GhostError::IntervalTooShort);
        ctx.accounts.ghost.interval_seconds = interval_seconds;
        msg!("Interval updated to {}s", interval_seconds);
        Ok(())
    }

    pub fn update_grace_period(ctx: Context<UpdateSettings>, grace_period_seconds: i64) -> Result<()> {
        require!(grace_period_seconds >= MIN_GRACE_PERIOD, GhostError::GracePeriodTooShort);
        ctx.accounts.ghost.grace_period_seconds = grace_period_seconds;
        msg!("Grace period updated to {}s", grace_period_seconds);
        Ok(())
    }

    pub fn update_recovery_wallet(ctx: Context<UpdateSettings>, index: u8, wallet: Option<Pubkey>) -> Result<()> {
        require!((index as usize) < MAX_RECOVERY_WALLETS, GhostError::InvalidRecoveryWalletIndex);
        ctx.accounts.ghost.recovery_wallets[index as usize] = wallet;
        msg!("Recovery wallet slot {} updated", index);
        Ok(())
    }

    pub fn check_silence(ctx: Context<CheckSilence>) -> Result<()> {
        let clock = Clock::get()?;
        let owner = ctx.accounts.ghost.owner;
        let awakened = ctx.accounts.ghost.awakened;
        let executed = ctx.accounts.ghost.executed;
        let last_heartbeat = ctx.accounts.ghost.last_heartbeat;
        let interval_seconds = ctx.accounts.ghost.interval_seconds;
        let grace_period_seconds = ctx.accounts.ghost.grace_period_seconds;
        let staked_ghost = ctx.accounts.ghost.staked_ghost;
        let bump = ctx.accounts.ghost.bump;
        let caller_key = ctx.accounts.caller.key();
        require!(!awakened, GhostError::GhostAlreadyAwakened);
        require!(!executed, GhostError::GhostAlreadyExecuted);
        require!(!ctx.accounts.ghost.paused, GhostError::GhostPausedError);
        let silence = clock.unix_timestamp - last_heartbeat;
        require!(silence > interval_seconds, GhostError::SoulStillAlive);
        let bounty = staked_ghost.checked_mul(SILENCE_BOUNTY_BPS).unwrap().checked_div(10_000).unwrap();
        ctx.accounts.ghost.awakened = true;
        ctx.accounts.ghost.awakened_at = Some(clock.unix_timestamp);
        let seeds = &[GHOST_SEED, owner.as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.ghost_stake_vault.to_account_info(),
                to: ctx.accounts.caller_token_account.to_account_info(),
                authority: ctx.accounts.ghost.to_account_info(),
                mint: ctx.accounts.ghost_mint.to_account_info(),
            },
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, bounty, ctx.accounts.ghost_mint.decimals)?;
        emit!(GhostAwakened { soul: owner, silence_duration: silence, awakened_at: clock.unix_timestamp, grace_period_ends: clock.unix_timestamp + grace_period_seconds, bounty_paid: bounty, caller: caller_key });
        msg!("Ghost awakened! Grace period: {}s", grace_period_seconds);
        Ok(())
    }

    pub fn cancel_awakening(ctx: Context<CancelAwakening>) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(ghost.awakened, GhostError::GhostNotAwakened);
        require!(!ghost.executed, GhostError::GhostAlreadyExecuted);
        let clock = Clock::get()?;
        let grace_end = ghost.awakened_at.unwrap() + ghost.grace_period_seconds;
        require!(clock.unix_timestamp <= grace_end, GhostError::GracePeriodExpired);
        let caller = ctx.accounts.signer.key();
        require!(caller == ghost.owner || is_recovery_wallet(&ghost.recovery_wallets, caller), GhostError::Unauthorized);
        ghost.awakened = false;
        ghost.awakened_at = None;
        ghost.last_heartbeat = clock.unix_timestamp;
        emit!(AwakeningCancelled { soul: ghost.owner, cancelled_by: caller, timestamp: clock.unix_timestamp });
        msg!("Awakening cancelled by {}", caller);
        Ok(())
    }

    pub fn execute_legacy(ctx: Context<ExecuteLegacy>) -> Result<()> {
        let ghost = &mut ctx.accounts.ghost;
        require!(ghost.awakened, GhostError::GhostNotAwakened);
        require!(!ghost.executed, GhostError::GhostAlreadyExecuted);
        let clock = Clock::get()?;
        let grace_end = ghost.awakened_at.unwrap() + ghost.grace_period_seconds;
        require!(clock.unix_timestamp > grace_end, GhostError::GracePeriodActive);
        ghost.executed = true;
        ghost.executed_at = Some(clock.unix_timestamp);
        emit!(LegacyExecuted { soul: ghost.owner, executed_at: clock.unix_timestamp, beneficiary_count: ghost.beneficiary_count });
        msg!("Ghost executed. {} beneficiaries to distribute.", ghost.beneficiary_count);
        Ok(())
    }

    pub fn execute_transfer(ctx: Context<ExecuteTransfer>, beneficiary_index: u8) -> Result<()> {
        require!(ctx.accounts.ghost.executed, GhostError::GhostNotExecuted);
        require!((beneficiary_index as usize) < ctx.accounts.ghost.beneficiary_count as usize, GhostError::InvalidBeneficiary);
        let beneficiary = ctx.accounts.ghost.beneficiaries[beneficiary_index as usize];
        require!(!beneficiary.executed, GhostError::BeneficiaryAlreadyPaid);
        require!(beneficiary.action == 0, GhostError::NotATransferBeneficiary);
        require!(beneficiary.recipient == ctx.accounts.recipient.key(), GhostError::WrongRecipient);
        require!(Some(ctx.accounts.token_mint.key()) == beneficiary.token_mint, GhostError::WrongMint);
        let owner = ctx.accounts.ghost.owner;
        let vault_bump = ctx.accounts.ghost.vault_bump;
        let seeds = &[VAULT_SEED, owner.as_ref(), &[vault_bump]];
        let signer_seeds = &[&seeds[..]];

        // 0.5% protocol fee
        let fee_amount = beneficiary.amount.checked_mul(EXECUTION_FEE_BPS).unwrap_or(0) / 10_000;
        let transfer_amount = beneficiary.amount.saturating_sub(fee_amount);

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked { from: ctx.accounts.vault_token_account.to_account_info(), to: ctx.accounts.recipient_token_account.to_account_info(), authority: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.token_mint.to_account_info() },
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, transfer_amount, ctx.accounts.token_mint.decimals)?;

        if fee_amount > 0 {
            let fee_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked { from: ctx.accounts.vault_token_account.to_account_info(), to: ctx.accounts.fee_token_account.to_account_info(), authority: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.token_mint.to_account_info() },
                signer_seeds,
            );
            token_interface::transfer_checked(fee_ctx, fee_amount, ctx.accounts.token_mint.decimals)?;
        }

        ctx.accounts.ghost.beneficiaries[beneficiary_index as usize].executed = true;
        emit!(TransferExecuted { soul: owner, recipient: beneficiary.recipient, amount: transfer_amount });
        msg!("Transferred {} to {} (fee: {})", transfer_amount, beneficiary.recipient, fee_amount);
        Ok(())
    }

    pub fn execute_burn(ctx: Context<ExecuteBurn>, beneficiary_index: u8) -> Result<()> {
        require!(ctx.accounts.ghost.executed, GhostError::GhostNotExecuted);
        require!((beneficiary_index as usize) < ctx.accounts.ghost.beneficiary_count as usize, GhostError::InvalidBeneficiary);
        let beneficiary = ctx.accounts.ghost.beneficiaries[beneficiary_index as usize];
        require!(!beneficiary.executed, GhostError::BeneficiaryAlreadyPaid);
        require!(beneficiary.action == 1, GhostError::NotABurnBeneficiary);
        require!(Some(ctx.accounts.mint.key()) == beneficiary.token_mint, GhostError::WrongMint);
        let owner = ctx.accounts.ghost.owner;
        let vault_bump = ctx.accounts.ghost.vault_bump;
        let seeds = &[VAULT_SEED, owner.as_ref(), &[vault_bump]];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn { mint: ctx.accounts.mint.to_account_info(), from: ctx.accounts.vault_token_account.to_account_info(), authority: ctx.accounts.vault.to_account_info() },
            signer_seeds,
        );
        token_interface::burn(cpi_ctx, beneficiary.amount)?;
        ctx.accounts.ghost.beneficiaries[beneficiary_index as usize].executed = true;
        emit!(BurnExecuted { soul: owner, mint: ctx.accounts.mint.key(), amount: beneficiary.amount });
        msg!("Burned {} tokens from vault", beneficiary.amount);
        Ok(())
    }

    pub fn execute_whole_vault_transfer(ctx: Context<ExecuteWholeVaultTransfer>) -> Result<()> {
        require!(ctx.accounts.ghost.executed, GhostError::GhostNotExecuted);
        require!(ctx.accounts.ghost.whole_vault_action == 0, GhostError::NotATransferBeneficiary);
        require!(ctx.accounts.ghost.whole_vault_recipient.is_some(), GhostError::InvalidBeneficiary);
        require!(ctx.accounts.ghost.whole_vault_recipient.unwrap() == ctx.accounts.recipient.key(), GhostError::WrongRecipient);
        let amount = ctx.accounts.vault_token_account.amount;
        require!(amount > 0, GhostError::Overflow);
        let owner = ctx.accounts.ghost.owner;
        let vault_bump = ctx.accounts.ghost.vault_bump;
        let seeds = &[VAULT_SEED, owner.as_ref(), &[vault_bump]];
        let signer_seeds = &[&seeds[..]];

        // 0.5% protocol fee
        let fee_amount = amount.checked_mul(EXECUTION_FEE_BPS).unwrap_or(0) / 10_000;
        let transfer_amount = amount.saturating_sub(fee_amount);

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked { from: ctx.accounts.vault_token_account.to_account_info(), to: ctx.accounts.recipient_token_account.to_account_info(), authority: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.token_mint.to_account_info() },
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, transfer_amount, ctx.accounts.token_mint.decimals)?;

        if fee_amount > 0 {
            let fee_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked { from: ctx.accounts.vault_token_account.to_account_info(), to: ctx.accounts.fee_token_account.to_account_info(), authority: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.token_mint.to_account_info() },
                signer_seeds,
            );
            token_interface::transfer_checked(fee_ctx, fee_amount, ctx.accounts.token_mint.decimals)?;
        }

        emit!(TransferExecuted { soul: owner, recipient: ctx.accounts.recipient.key(), amount: transfer_amount });
        msg!("Whole vault transfer: {} to {} (fee: {})", transfer_amount, ctx.accounts.recipient.key(), fee_amount);
        Ok(())
    }

    pub fn execute_whole_vault_burn(ctx: Context<ExecuteWholeVaultBurn>) -> Result<()> {
        require!(ctx.accounts.ghost.executed, GhostError::GhostNotExecuted);
        require!(ctx.accounts.ghost.whole_vault_action == 1, GhostError::NotABurnBeneficiary);
        let amount = ctx.accounts.vault_token_account.amount;
        require!(amount > 0, GhostError::Overflow);
        let owner = ctx.accounts.ghost.owner;
        let vault_bump = ctx.accounts.ghost.vault_bump;
        let seeds = &[VAULT_SEED, owner.as_ref(), &[vault_bump]];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn { mint: ctx.accounts.token_mint.to_account_info(), from: ctx.accounts.vault_token_account.to_account_info(), authority: ctx.accounts.vault.to_account_info() },
            signer_seeds,
        );
        token_interface::burn(cpi_ctx, amount)?;
        emit!(BurnExecuted { soul: owner, mint: ctx.accounts.token_mint.key(), amount });
        msg!("Whole vault burn: {} of mint {}", amount, ctx.accounts.token_mint.key());
        Ok(())
    }

    pub fn deposit_to_vault(ctx: Context<DepositToVault>, amount: u64) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked { from: ctx.accounts.owner_token_account.to_account_info(), to: ctx.accounts.vault_token_account.to_account_info(), authority: ctx.accounts.signer.to_account_info(), mint: ctx.accounts.ghost_mint.to_account_info() },
        );
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.ghost_mint.decimals)?;
        emit!(VaultDeposit { soul: ctx.accounts.ghost.owner, amount });
        msg!("Deposited {} to vault", amount);
        Ok(())
    }

    pub fn withdraw_from_vault(ctx: Context<WithdrawFromVault>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.ghost.awakened, GhostError::GhostAlreadyAwakened);
        let owner = ctx.accounts.ghost.owner;
        let vault_bump = ctx.accounts.ghost.vault_bump;
        let seeds = &[VAULT_SEED, owner.as_ref(), &[vault_bump]];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked { from: ctx.accounts.vault_token_account.to_account_info(), to: ctx.accounts.owner_token_account.to_account_info(), authority: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.ghost_mint.to_account_info() },
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.ghost_mint.decimals)?;
        emit!(VaultWithdrawal { soul: owner, amount });
        msg!("Withdrew {} from vault", amount);
        Ok(())
    }

    pub fn recovery_withdraw(ctx: Context<RecoveryWithdraw>, amount: u64) -> Result<()> {
        let ghost = &ctx.accounts.ghost;
        require!(is_recovery_wallet(&ghost.recovery_wallets, ctx.accounts.recovery_wallet.key()), GhostError::Unauthorized);
        require!(!ghost.executed, GhostError::GhostAlreadyExecuted);
        let owner = ghost.owner;
        let vault_bump = ghost.vault_bump;
        let seeds = &[VAULT_SEED, owner.as_ref(), &[vault_bump]];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked { from: ctx.accounts.vault_token_account.to_account_info(), to: ctx.accounts.recipient_token_account.to_account_info(), authority: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.ghost_mint.to_account_info() },
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.ghost_mint.decimals)?;
        emit!(RecoveryWithdrawal { soul: owner, recovery_wallet: ctx.accounts.recovery_wallet.key(), amount });
        msg!("Recovery withdrawal: {} tokens moved by guardian", amount);
        Ok(())
    }

    pub fn abandon_ghost(ctx: Context<AbandonGhost>) -> Result<()> {
        let owner = ctx.accounts.ghost.owner;
        let staked = ctx.accounts.ghost.staked_ghost;
        let bump = ctx.accounts.ghost.bump;
        let burn_amount = staked.checked_mul(BURN_ON_ABANDON_BPS).unwrap().checked_div(10_000).unwrap();
        let return_amount = staked.checked_sub(burn_amount).unwrap();
        let seeds = &[GHOST_SEED, owner.as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];
        let burn_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn { mint: ctx.accounts.ghost_mint.to_account_info(), from: ctx.accounts.ghost_stake_vault.to_account_info(), authority: ctx.accounts.ghost.to_account_info() },
            signer_seeds,
        );
        token_interface::burn(burn_ctx, burn_amount)?;
        let return_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked { from: ctx.accounts.ghost_stake_vault.to_account_info(), to: ctx.accounts.owner_token_account.to_account_info(), authority: ctx.accounts.ghost.to_account_info(), mint: ctx.accounts.ghost_mint.to_account_info() },
            signer_seeds,
        );
        token_interface::transfer_checked(return_ctx, return_amount, ctx.accounts.ghost_mint.decimals)?;
        emit!(GhostAbandoned { soul: owner, burned: burn_amount, returned: return_amount });
        msg!("Ghost abandoned. Burned: {}, Returned: {}", burn_amount, return_amount);
        Ok(())
    }

    /// migrate_ghost — upgrades a pre-v1.8 GhostAccount to the current layout.
    ///
    /// HOW MIGRATION WORKS (read before modifying):
    ///   1. Reallocs the account to GHOST_ACCOUNT_SPACE if it's smaller (pays rent diff via system_program).
    ///   2. Sets any new fields introduced since the account was created to their sensible defaults.
    ///   3. Bumps schema_version to CURRENT_SCHEMA_VERSION so the frontend unlocks new features.
    ///
    /// FOR FUTURE VERSIONS (e.g. v1.9):
    ///   - Add `ghost.your_new_field = default_value;` below the existing field assignments.
    ///   - GHOST_ACCOUNT_SPACE will have been increased — the realloc handles the size change.
    ///   - Update CURRENT_SCHEMA_VERSION constant to SCHEMA_VERSION_V19.
    ///   - Do NOT change the realloc target — always use GHOST_ACCOUNT_SPACE.
    ///
    /// Security: only callable by ghost.owner. Idempotent — safe to run multiple times.
    /// All beneficiaries, heartbeat, stake, vault assets — all untouched.
    pub fn migrate_ghost(ctx: Context<MigrateGhost>) -> Result<()> {
        let ghost_info = ctx.accounts.ghost.to_account_info();
        let owner = ctx.accounts.ghost.owner;
        let clock = Clock::get()?;
        let current_len = ghost_info.data_len();

        // Realloc to current GHOST_ACCOUNT_SPACE if account is smaller.
        // GHOST_ACCOUNT_SPACE grows by the byte size of each new field added per version.
        // The +8 accounts for the Anchor discriminator prefix.
        let target_len = GHOST_ACCOUNT_SPACE + 8;
        if current_len < target_len {
            let rent = Rent::get()?;
            let new_minimum = rent.minimum_balance(target_len);
            let current_lamports = ghost_info.lamports();
            if current_lamports < new_minimum {
                let diff = new_minimum - current_lamports;
                anchor_lang::system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        anchor_lang::system_program::Transfer {
                            from: ctx.accounts.signer.to_account_info(),
                            to: ghost_info.clone(),
                        },
                    ),
                    diff,
                )?;
            }
            ghost_info.realloc(target_len, false)?;
        }

        // Set new fields introduced in v1.8.
        // For each future version, append new field assignments here — do NOT remove old ones.
        // v1.8 fields:
        ctx.accounts.ghost.schema_version = CURRENT_SCHEMA_VERSION;
        // v1.9 fields would go here:
        // ctx.accounts.ghost.your_new_field = default_value;

        emit!(MigrationComplete {
            soul: owner,
            old_size: current_len as u16,
            new_size: target_len as u16,
            schema_version: CURRENT_SCHEMA_VERSION,
            timestamp: clock.unix_timestamp,
        });
        msg!(
            "Ghost migrated for {} — {} -> {} bytes, schema_version={}",
            owner, current_len, target_len, CURRENT_SCHEMA_VERSION
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub struct Beneficiary {
    pub recipient: Pubkey,
    pub amount: u64,
    pub token_mint: Option<Pubkey>,
    pub action: u8,
    pub executed: bool,
}

impl Default for Beneficiary {
    fn default() -> Self {
        Self { recipient: Pubkey::default(), amount: 0, token_mint: None, action: 0, executed: false }
    }
}

#[account]
pub struct GhostAccount {
    pub owner: Pubkey,                           // 32
    pub recovery_wallets: [Option<Pubkey>; 3],   // 3–99 (Borsh variable)
    pub last_heartbeat: i64,                     // 8
    pub interval_seconds: i64,                   // 8
    pub grace_period_seconds: i64,               // 8
    pub awakened: bool,                          // 1
    pub awakened_at: Option<i64>,                // 1 or 9
    pub executed: bool,                          // 1
    pub executed_at: Option<i64>,                // 1 or 9
    pub staked_ghost: u64,                       // 8
    pub bump: u8,                                // 1
    pub vault_bump: u8,                          // 1
    pub registered_at: i64,                      // 8
    pub ping_count: u64,                         // 8
    pub beneficiary_count: u8,                   // 1
    pub beneficiaries: [Beneficiary; 10],        // 750
    pub whole_vault_recipient: Option<Pubkey>,   // 1 or 33
    pub paused: bool,                            // 1
    pub pending_owner: Option<Pubkey>,           // 1 or 33
    pub whole_vault_action: u8,                  // 1
    pub display_name: [u8; 32],                  // 32
    pub image_uri: [u8; 128],                    // 128
    // ── Versioning — always the last field ──────────────────────────────────
    // schema_version tracks which program version wrote this account.
    // UPGRADE RULE: when adding new fields in a future version —
    //   1. Append them ABOVE this comment, never below or in the middle.
    //   2. schema_version must always remain the last field in the struct.
    //   3. Increase GHOST_ACCOUNT_SPACE by the new field's byte size.
    //   4. Add a SCHEMA_VERSION_VXX constant and update CURRENT_SCHEMA_VERSION.
    // Frontend reads this field to gate new features via isVersionSufficient().
    pub schema_version: u8,                      // 1 — v1.8+
}

#[derive(Accounts)]
pub struct InitializeGhost<'info> {
    // space = GHOST_ACCOUNT_SPACE (1221 for v1.8) — update this when GHOST_ACCOUNT_SPACE grows
    #[account(init, payer = signer, space = GHOST_ACCOUNT_SPACE, seeds = [GHOST_SEED, signer.key().as_ref()], bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    /// CHECK: Vault PDA — bump derivation only
    #[account(seeds = [VAULT_SEED, signer.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub ghost_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = signer, seeds = [b"stake_vault", signer.key().as_ref()], bump, token::mint = ghost_mint, token::authority = ghost, token::token_program = token_program)]
    pub ghost_stake_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = ghost_mint, token::authority = signer, token::token_program = token_program)]
    pub signer_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: Bot operations wallet — receives registration fee. Validated by address constraint.
    #[account(mut, constraint = bot_ops_wallet.key() == BOT_OPS_WALLET @ GhostError::Unauthorized)]
    pub bot_ops_wallet: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Ping<'info> {
    #[account(mut, seeds = [GHOST_SEED, signer.key().as_ref()], bump = ghost.bump, constraint = ghost.owner == signer.key() @ GhostError::Unauthorized)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    #[account(mut)] pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ManageBeneficiaries<'info> {
    #[account(mut, seeds = [GHOST_SEED, signer.key().as_ref()], bump = ghost.bump, constraint = ghost.owner == signer.key() @ GhostError::Unauthorized)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    #[account(mut)] pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct GuardianManageBeneficiaries<'info> {
    #[account(mut, seeds = [GHOST_SEED, owner.key().as_ref()], bump = ghost.bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    /// CHECK: Owner pubkey — PDA derivation only
    pub owner: UncheckedAccount<'info>,
    #[account(mut)] pub recovery_wallet: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptOwnership<'info> {
    #[account(mut, seeds = [GHOST_SEED, ghost.owner.as_ref()], bump = ghost.bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    #[account(mut)] pub new_owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CheckSilence<'info> {
    #[account(mut, seeds = [GHOST_SEED, ghost.owner.as_ref()], bump = ghost.bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    #[account(mut)] pub caller: Signer<'info>,
    pub ghost_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = ghost_mint, token::token_program = token_program)]
    pub ghost_stake_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = ghost_mint, token::token_program = token_program)]
    pub caller_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelAwakening<'info> {
    #[account(mut, seeds = [GHOST_SEED, ghost.owner.as_ref()], bump = ghost.bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    #[account(mut)] pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteLegacy<'info> {
    #[account(mut, seeds = [GHOST_SEED, ghost.owner.as_ref()], bump = ghost.bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteTransfer<'info> {
    #[account(mut, seeds = [GHOST_SEED, ghost.owner.as_ref()], bump = ghost.bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    /// CHECK: Vault PDA authority
    #[account(seeds = [VAULT_SEED, ghost.owner.as_ref()], bump = ghost.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)] pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = token_mint, token::token_program = token_program)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: validated in instruction
    pub recipient: UncheckedAccount<'info>,
    #[account(mut, token::mint = token_mint, token::token_program = token_program)]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    /// Protocol fee token account — must match mint and be owned by PROTOCOL_FEE_WALLET
    #[account(mut, token::mint = token_mint, token::authority = PROTOCOL_FEE_WALLET, token::token_program = token_program)]
    pub fee_token_account: InterfaceAccount<'info, TokenAccount>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteWholeVaultTransfer<'info> {
    #[account(mut, seeds = [GHOST_SEED, ghost.owner.as_ref()], bump = ghost.bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    /// CHECK: Vault PDA authority
    #[account(seeds = [VAULT_SEED, ghost.owner.as_ref()], bump = ghost.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)] pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = token_mint, token::token_program = token_program)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: validated in instruction
    pub recipient: UncheckedAccount<'info>,
    #[account(mut, token::mint = token_mint, token::token_program = token_program)]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    /// Protocol fee token account — must match mint and be owned by PROTOCOL_FEE_WALLET
    #[account(mut, token::mint = token_mint, token::authority = PROTOCOL_FEE_WALLET, token::token_program = token_program)]
    pub fee_token_account: InterfaceAccount<'info, TokenAccount>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteWholeVaultBurn<'info> {
    #[account(mut, seeds = [GHOST_SEED, ghost.owner.as_ref()], bump = ghost.bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    /// CHECK: Vault PDA authority
    #[account(seeds = [VAULT_SEED, ghost.owner.as_ref()], bump = ghost.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)] pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = token_mint, token::token_program = token_program)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteBurn<'info> {
    #[account(mut, seeds = [GHOST_SEED, ghost.owner.as_ref()], bump = ghost.bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    /// CHECK: Vault PDA authority
    #[account(seeds = [VAULT_SEED, ghost.owner.as_ref()], bump = ghost.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)] pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositToVault<'info> {
    #[account(seeds = [GHOST_SEED, signer.key().as_ref()], bump = ghost.bump, constraint = ghost.owner == signer.key() @ GhostError::Unauthorized)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    #[account(mut)] pub signer: Signer<'info>,
    pub ghost_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = ghost_mint, token::token_program = token_program)]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = ghost_mint, token::token_program = token_program)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawFromVault<'info> {
    #[account(seeds = [GHOST_SEED, signer.key().as_ref()], bump = ghost.bump, constraint = ghost.owner == signer.key() @ GhostError::Unauthorized)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    /// CHECK: Vault PDA authority
    #[account(seeds = [VAULT_SEED, signer.key().as_ref()], bump = ghost.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)] pub signer: Signer<'info>,
    pub ghost_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = ghost_mint, token::token_program = token_program)]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = ghost_mint, token::token_program = token_program)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RecoveryWithdraw<'info> {
    #[account(mut, seeds = [GHOST_SEED, owner.key().as_ref()], bump = ghost.bump)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    /// CHECK: Owner pubkey — PDA derivation
    pub owner: UncheckedAccount<'info>,
    /// CHECK: Vault PDA
    #[account(seeds = [VAULT_SEED, owner.key().as_ref()], bump = ghost.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)] pub recovery_wallet: Signer<'info>,
    pub ghost_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = ghost_mint, token::token_program = token_program)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = ghost_mint, token::token_program = token_program)]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UpdateSettings<'info> {
    #[account(mut, seeds = [GHOST_SEED, signer.key().as_ref()], bump = ghost.bump, constraint = ghost.owner == signer.key() @ GhostError::Unauthorized)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    #[account(mut)] pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct AbandonGhost<'info> {
    #[account(mut, seeds = [GHOST_SEED, signer.key().as_ref()], bump = ghost.bump, constraint = ghost.owner == signer.key() @ GhostError::Unauthorized, close = signer)]
    pub ghost: Box<Account<'info, GhostAccount>>,
    #[account(mut)] pub signer: Signer<'info>,
    pub ghost_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = ghost_mint, token::token_program = token_program)]
    pub ghost_stake_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = ghost_mint, token::token_program = token_program)]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// MigrateGhost — upgrades account from v1.7 (1220 bytes) to v1.8 (1221 bytes)
/// The signer must be the ghost owner and must pay for the extra byte via realloc.
/// system_program required by Anchor for realloc rent-exempt top-up.
#[derive(Accounts)]
pub struct MigrateGhost<'info> {
    #[account(
        mut,
        seeds = [GHOST_SEED, signer.key().as_ref()],
        bump = ghost.bump,
        constraint = ghost.owner == signer.key() @ GhostError::Unauthorized,
    )]
    pub ghost: Box<Account<'info, GhostAccount>>,
    #[account(mut)] pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[event] pub struct GhostRegistered { pub soul: Pubkey, pub interval: i64, pub grace_period: i64, pub recovery_wallets: [Option<Pubkey>; 3], pub staked: u64, pub timestamp: i64 }
#[event] pub struct HeartbeatReceived { pub soul: Pubkey, pub timestamp: i64, pub ping_number: u64 }
#[event] pub struct GhostAwakened { pub soul: Pubkey, pub silence_duration: i64, pub awakened_at: i64, pub grace_period_ends: i64, pub bounty_paid: u64, pub caller: Pubkey }
#[event] pub struct AwakeningCancelled { pub soul: Pubkey, pub cancelled_by: Pubkey, pub timestamp: i64 }
#[event] pub struct LegacyExecuted { pub soul: Pubkey, pub executed_at: i64, pub beneficiary_count: u8 }
#[event] pub struct TransferExecuted { pub soul: Pubkey, pub recipient: Pubkey, pub amount: u64 }
#[event] pub struct BeneficiaryAdded { pub soul: Pubkey, pub recipient: Pubkey, pub amount: u64, pub action: u8 }
#[event] pub struct VaultDeposit { pub soul: Pubkey, pub amount: u64 }
#[event] pub struct VaultWithdrawal { pub soul: Pubkey, pub amount: u64 }
#[event] pub struct GhostAbandoned { pub soul: Pubkey, pub burned: u64, pub returned: u64 }
#[event] pub struct WholeVaultRecipientSet { pub soul: Pubkey, pub recipient: Option<Pubkey>, pub cleared: bool, pub previous: Option<Pubkey> }
#[event] pub struct RecoveryWithdrawal { pub soul: Pubkey, pub recovery_wallet: Pubkey, pub amount: u64 }
#[event] pub struct BeneficiaryUpdated { pub soul: Pubkey, pub index: u8, pub old_recipient: Pubkey, pub new_recipient: Pubkey, pub old_amount: u64, pub new_amount: u64, pub action: u8 }
#[event] pub struct BeneficiariesCleared { pub soul: Pubkey, pub cleared_by: Pubkey, pub count: u8 }
#[event] pub struct GhostPaused { pub soul: Pubkey, pub timestamp: i64 }
#[event] pub struct GhostResumed { pub soul: Pubkey, pub timestamp: i64 }
#[event] pub struct OwnershipTransferInitiated { pub soul: Pubkey, pub pending_owner: Pubkey, pub timestamp: i64 }
#[event] pub struct OwnershipTransferAccepted { pub old_owner: Pubkey, pub new_owner: Pubkey, pub timestamp: i64 }
#[event] pub struct BurnExecuted { pub soul: Pubkey, pub mint: Pubkey, pub amount: u64 }
#[event] pub struct MigrationComplete { pub soul: Pubkey, pub old_size: u16, pub new_size: u16, pub schema_version: u8, pub timestamp: i64 }

#[error_code]
pub enum GhostError {
    #[msg("Insufficient $GHOST staked. Minimum 10,000 $GHOST required.")] InsufficientStake,
    #[msg("Heartbeat interval too short. Minimum 1 hour.")] IntervalTooShort,
    #[msg("Grace period invalid.")] GracePeriodTooShort,
    #[msg("This ghost has already awakened.")] GhostAlreadyAwakened,
    #[msg("This ghost has not yet awakened.")] GhostNotAwakened,
    #[msg("This ghost has already been executed.")] GhostAlreadyExecuted,
    #[msg("This ghost has not been executed yet.")] GhostNotExecuted,
    #[msg("Soul is still alive. Heartbeat detected within interval.")] SoulStillAlive,
    #[msg("Grace period is still active. Cannot execute yet.")] GracePeriodActive,
    #[msg("Grace period has expired. Cannot cancel.")] GracePeriodExpired,
    #[msg("Unauthorized.")] Unauthorized,
    #[msg("Too many beneficiaries. Maximum 10.")] TooManyBeneficiaries,
    #[msg("Invalid beneficiary index.")] InvalidBeneficiary,
    #[msg("Beneficiary already paid.")] BeneficiaryAlreadyPaid,
    #[msg("Wrong recipient account.")] WrongRecipient,
    #[msg("Arithmetic overflow.")] Overflow,
    #[msg("Ghost is paused. Resume before modifying beneficiaries.")] GhostPausedError,
    #[msg("Ghost is not paused.")] GhostNotPaused,
    #[msg("No pending ownership transfer. Call transfer_ownership first.")] NoPendingOwnerTransfer,
    #[msg("Invalid recovery wallet index. Must be 0, 1, or 2.")] InvalidRecoveryWalletIndex,
    #[msg("Beneficiary action is not Burn (action must be 1).")] NotABurnBeneficiary,
    #[msg("Beneficiary action is not Transfer (action must be 0).")] NotATransferBeneficiary,
    #[msg("Wrong token mint — does not match beneficiary.token_mint.")] WrongMint,
    #[msg("Account size invalid for this operation. Expected v1.7 layout (1220 bytes).")] InvalidAccountSize,
    #[msg("Account is already on the latest schema version.")] AlreadyMigrated,
}