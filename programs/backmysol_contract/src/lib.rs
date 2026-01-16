use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token};
use anchor_lang::solana_program::system_instruction;

declare_id!("CjjskajkSeYgfQxx88wcaLvPSe3RmGgbpzkHpnQevyB6");

#[program]
pub mod backmysol_contract {
    use super::*;

    // 1. Khởi tạo cấu hình Admin
    pub fn initialize(
        ctx: Context<Initialize>,
        admin: Option<Pubkey> 
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(admin_key) = admin {
            config.admin = admin_key;
        } else {
            config.admin = *ctx.accounts.admin.key; 
        } 
        
        // Cấu hình Fee mặc định
        config.platform_fee_bps = 2000; // 20%
        config.tier1_share_bps = 5000;  // 50%
        config.tier2_share_bps = 2500;  // 25%
        
        Ok(())
    }

    // 2. Update cấu hình
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_platform_fee_bps: u16,
        new_tier1_share_bps: u16,
        new_tier2_share_bps: u16,
        new_admin: Option<Pubkey>
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.platform_fee_bps = new_platform_fee_bps;
        config.tier1_share_bps = new_tier1_share_bps;
        config.tier2_share_bps = new_tier2_share_bps;
        
        if let Some(admin_pubkey) = new_admin {
            config.admin = admin_pubkey;
        }
        Ok(())
    }

    // 3. (FEATURE) Mua Mã Giới Thiệu Tuỳ Chỉnh (Phí 0.001 SOL)
    pub fn register_referral_code(ctx: Context<RegisterReferralCode>, code: String) -> Result<()> {
        // Validate
        require!(code.len() > 0 && code.len() <= 10, ErrorCode::InvalidCodeLength);

        // Thu phí 0.001 SOL (1,000,000 lamports)
        let fee_amount: u64 = 1_000_000; 
        
        let transfer_ix = system_instruction::transfer(
            ctx.accounts.user.key,
            ctx.accounts.treasury.key,
            fee_amount
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Lưu PDA
        let mapping = &mut ctx.accounts.referral_code_mapping;
        mapping.owner = ctx.accounts.user.key();
        mapping.bump = ctx.bumps.referral_code_mapping;

        // msg!("Registered custom code '{}'. Fee collected.", code);
        Ok(())
    }

    // 4. Initialize Referral (Ghi nhận người giới thiệu)
    pub fn initialize_referral(ctx: Context<InitializeReferral>, referrer: Pubkey) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        require!(user_key != referrer, ErrorCode::SelfReferral);

        let referral_state = &mut ctx.accounts.referral_state;
        referral_state.referrer = referrer;
        referral_state.total_rewards_generated = 0;
        referral_state.bump = ctx.bumps.referral_state;

        // Truy vết Cấp 2
        if let Some(referrer_state) = &ctx.accounts.referrer_state {
            referral_state.tier2_referrer = Some(referrer_state.referrer);
        } else {
            referral_state.tier2_referrer = None;
        }

        Ok(())
    }

    // 5. Clean & Distribute (Chia tiền)
    pub fn clean_and_distribute<'info>(ctx: Context<'_, '_, '_, 'info, CleanAndDistribute<'info>>) -> Result<()> {
        let config = &ctx.accounts.config;
        let user = &ctx.accounts.user;
        let referral_state = &ctx.accounts.referral_state;
        
        if let Some(ref1_wallet) = &ctx.accounts.referrer_wallet {
            require!(ref1_wallet.key() == referral_state.referrer, ErrorCode::InvalidReferrerWallet);
        }
        
        if let Some(ref2_wallet) = &ctx.accounts.tier2_referrer_wallet {
             require!(
                referral_state.tier2_referrer.is_some() && 
                ref2_wallet.key() == referral_state.tier2_referrer.unwrap(), 
                ErrorCode::InvalidReferrerWallet
            );
        }

        let mut total_rent_reclaimed: u64 = 0;

        // Đóng Account
        for account_info in ctx.remaining_accounts.iter() {
            if account_info.owner != &ctx.accounts.token_program.key() { continue; }
            total_rent_reclaimed += account_info.lamports();

            let cpi_accounts = CloseAccount {
                account: account_info.clone(),
                destination: user.to_account_info(),
                authority: user.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
            token::close_account(cpi_ctx)?;
        }

        // Chia tiền
        if total_rent_reclaimed > 0 {
            let gross_fee = (total_rent_reclaimed * config.platform_fee_bps as u64) / 10000;
            
            if gross_fee > 0 {
                let tier1_amt = (gross_fee * config.tier1_share_bps as u64) / 10000;
                let tier2_amt = (gross_fee * config.tier2_share_bps as u64) / 10000;
                let mut admin_amt = gross_fee; 

                if tier1_amt > 0 {
                    if let Some(ref1_wallet) = &ctx.accounts.referrer_wallet {
                        invoke_transfer(user, ref1_wallet, tier1_amt, &ctx.accounts.system_program)?;
                        admin_amt = admin_amt.saturating_sub(tier1_amt);
                    }
                }

                if tier2_amt > 0 {
                    if referral_state.tier2_referrer.is_some() && ctx.accounts.tier2_referrer_wallet.is_some() {
                        let ref2_wallet = ctx.accounts.tier2_referrer_wallet.as_ref().unwrap();
                        invoke_transfer(user, ref2_wallet, tier2_amt, &ctx.accounts.system_program)?;
                        admin_amt = admin_amt.saturating_sub(tier2_amt);
                    }
                }

                if admin_amt > 0 {
                    invoke_transfer(user, &ctx.accounts.treasury, admin_amt, &ctx.accounts.system_program)?;
                }
            }
        }
        Ok(())
    }
}

// --- HELPER ---
fn invoke_transfer<'info>(
    from: &Signer<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    system_program: &Program<'info, System>,
) -> Result<()> {
    let transfer_ix = system_instruction::transfer(from.key, to.key, amount);
    anchor_lang::solana_program::program::invoke(
        &transfer_ix,
        &[from.to_account_info(), to.to_account_info(), system_program.to_account_info()],
    )?;
    Ok(())
}

// --- ACCOUNTS ---

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init, payer = admin, space = 8 + GlobalConfig::INIT_SPACE, 
        // QUAN TRỌNG: Đổi seed thành config_v1 để tạo account mới
        seeds = [b"config_v1"], bump
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub admin: Signer<'info>, 
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    // QUAN TRỌNG: Đổi seed thành config_v1
    #[account(mut, seeds = [b"config_v1"], bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(constraint = admin.key() == config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
}

// Updated Context cho Custom Code
#[derive(Accounts)]
#[instruction(code: String)]
pub struct RegisterReferralCode<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    // QUAN TRỌNG: Đổi seed thành config_v1
    #[account(seeds = [b"config_v1"], bump)]
    pub config: Account<'info, GlobalConfig>,

    /// CHECK: Validated by checking address == config.admin
    #[account(mut, address = config.admin)]
    pub treasury: AccountInfo<'info>,

    #[account(
        init,
        payer = user,
        space = 8 + ReferralCodeMapping::INIT_SPACE,
        seeds = [b"code", code.as_bytes()],
        bump
    )]
    pub referral_code_mapping: Account<'info, ReferralCodeMapping>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(referrer: Pubkey)]
pub struct InitializeReferral<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init, payer = user, space = 8 + ReferralState::INIT_SPACE,
        seeds = [b"referral", user.key().as_ref()], bump
    )]
    pub referral_state: Account<'info, ReferralState>,
    #[account(seeds = [b"referral", referrer.key().as_ref()], bump)]
    pub referrer_state: Option<Account<'info, ReferralState>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CleanAndDistribute<'info> {
    // QUAN TRỌNG: Đổi seed thành config_v1
    #[account(seeds = [b"config_v1"], bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [b"referral", user.key().as_ref()], bump = referral_state.bump)]
    pub referral_state: Account<'info, ReferralState>,
    
    /// CHECK: Validated logic in instruction
    #[account(mut)]
    pub referrer_wallet: Option<AccountInfo<'info>>,
    
    /// CHECK: Validated logic in instruction
    #[account(mut)]
    pub tier2_referrer_wallet: Option<AccountInfo<'info>>,
    
    /// CHECK: Validated by address check against config
    #[account(mut, address = config.admin)]
    pub treasury: AccountInfo<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// --- DATA ---
// ... (Phần Data Structures giữ nguyên không thay đổi)
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub platform_fee_bps: u16,
    pub tier1_share_bps: u16,
    pub tier2_share_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct ReferralState {
    pub referrer: Pubkey,
    pub tier2_referrer: Option<Pubkey>,
    pub total_rewards_generated: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ReferralCodeMapping {
    pub owner: Pubkey,
    pub bump: u8,
}

#[error_code]
pub enum ErrorCode {
    #[msg("You are not authorized to perform this action.")]
    Unauthorized,
    #[msg("You cannot refer yourself.")]
    SelfReferral,
    #[msg("The provided referrer wallet does not match the on-chain referral state.")]
    InvalidReferrerWallet,
    #[msg("Referral code must be between 1 and 10 characters.")]
    InvalidCodeLength,
}