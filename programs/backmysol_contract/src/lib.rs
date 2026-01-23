use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token};
use anchor_lang::solana_program::system_instruction;
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "BackMySol",
    project_url: "https://backmysol.io",
    source_code: "https://github.com/maigiadn/backmysol_contract",
    contacts: "email:admin@backmysol.io,link:https://t.me/backmysol_support",
    policy: "https://backmysol.io/security-policy",
    preferred_languages: "en,vi",
    auditors: "None"
}

declare_id!("CjjskajkSeYgfQxx88wcaLvPSe3RmGgbpzkHpnQevyB6");

#[program]
pub mod backmysol_contract {
    use super::*;

    // 1. Init Config
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
        
        config.platform_fee_bps = 2000; 
        config.tier1_share_bps = 5000; 
        config.tier2_share_bps = 2500; 
        
        Ok(())
    }

    // 2. Update Config
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

    // 3. REGISTER PARTNER (FREE - NO FEE)
    pub fn register_partner(
        ctx: Context<RegisterPartner>, 
        code: String, 
        referrer: Option<Pubkey>
    ) -> Result<()> {
        // --- A. XỬ LÝ MÃ CODE ---
        require!(code.len() > 0 && code.len() <= 10, ErrorCode::InvalidCodeLength);

        // Lưu mapping code -> user wallet
        let mapping = &mut ctx.accounts.referral_code_mapping;
        mapping.owner = ctx.accounts.user.key();
        mapping.bump = ctx.bumps.referral_code_mapping;

        // --- B. XỬ LÝ REFERRAL STATE & UPLINE ---
        let referral_state = &mut ctx.accounts.referral_state;
        
        // Chỉ setup nếu chưa từng setup
        if referral_state.referrer == Pubkey::default() && referral_state.total_rewards_generated == 0 {
            referral_state.total_rewards_generated = 0;
            referral_state.bump = ctx.bumps.referral_state;

            if let Some(upline_key) = referrer {
                require!(ctx.accounts.user.key() != upline_key, ErrorCode::SelfReferral);
                
                // Validate ví Upline
                if let Some(upline_acc_info) = &ctx.accounts.upline_referrer_state {
                    // Check PDA address
                    let (expected_pda, _bump) = Pubkey::find_program_address(
                        &[b"referral", upline_key.as_ref()],
                        ctx.program_id
                    );
                    require!(upline_acc_info.key() == expected_pda, ErrorCode::InvalidReferrerWallet);
                    
                    // Set Referrer (F1)
                    referral_state.referrer = upline_key;

                    // Tìm Tier 2 (F2)
                    if upline_acc_info.lamports() > 0 && upline_acc_info.owner == ctx.program_id {
                        let acc_data = upline_acc_info.try_borrow_data()?;
                        let mut slice: &[u8] = &acc_data;
                        if slice.len() >= 8 {
                            if let Ok(upline_state) = AccountDeserialize::try_deserialize(&mut slice) {
                                let state: ReferralState = upline_state;
                                referral_state.tier2_referrer = Some(state.referrer);
                            }
                        }
                    }
                }
            } else {
                // Default referrer là Admin
                referral_state.referrer = ctx.accounts.config.admin; 
                referral_state.tier2_referrer = None;
            }
        }

        Ok(())
    }

    // 4. CLEAN & DISTRIBUTE
    // 4. CLEAN & DISTRIBUTE (UPDATED FOR ZERO-COST REFERRAL)
    pub fn clean_and_distribute<'info>(ctx: Context<'_, '_, '_, 'info, CleanAndDistribute<'info>>) -> Result<()> {
        let config = &ctx.accounts.config;
        let user = &ctx.accounts.user;
        
        let mut ref1_pubkey: Option<Pubkey> = None;
        let mut ref2_pubkey: Option<Pubkey> = None;

        // --- LOGIC MỚI: Ưu tiên On-chain, nhưng Fallback về Ví gửi lên ---
        
        if let Some(ref_state) = &ctx.accounts.referral_state {
            // TRƯỜNG HỢP 1: Đã có Referral State (User cũ)
            // Lấy referrer từ dữ liệu on-chain để đảm bảo tính toàn vẹn
            ref1_pubkey = Some(ref_state.referrer);
            ref2_pubkey = ref_state.tier2_referrer;

            // Validate: Nếu Frontend có gửi ví referrer, nó phải khớp với on-chain
            if let Some(ref1_wallet) = &ctx.accounts.referrer_wallet {
                 require!(ref1_wallet.key() == ref_state.referrer, ErrorCode::InvalidReferrerWallet);
            }
            if let Some(ref2_wallet) = &ctx.accounts.tier2_referrer_wallet {
                 require!(
                    ref_state.tier2_referrer.is_some() && 
                    ref2_wallet.key() == ref_state.tier2_referrer.unwrap(), 
                    ErrorCode::InvalidReferrerWallet
                );
            }
        } else {
            // TRƯỜNG HỢP 2: Chưa có Referral State (User mới / Zero Cost)
            // Lấy referrer từ tham số context do Frontend gửi lên (từ link giới thiệu)
            if let Some(ref1_wallet) = &ctx.accounts.referrer_wallet {
                // Chặn tự giới thiệu bản thân
                require!(ref1_wallet.key() != user.key(), ErrorCode::SelfReferral);
                ref1_pubkey = Some(ref1_wallet.key());
            }
            
            // User mới thì chưa có Tier 2, bỏ qua.
        }

        let mut total_rent_reclaimed: u64 = 0;

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

        if total_rent_reclaimed > 0 {
            let gross_fee = (total_rent_reclaimed * config.platform_fee_bps as u64) / 10000;
            
            if gross_fee > 0 {
                let tier1_amt = (gross_fee * config.tier1_share_bps as u64) / 10000;
                let tier2_amt = (gross_fee * config.tier2_share_bps as u64) / 10000;
                let mut admin_amt = gross_fee; 

                // Chia tiền cho Ref 1 (Nếu tồn tại từ step trên)
                if let Some(_r1) = ref1_pubkey {
                    if tier1_amt > 0 {
                        // Logic cũ: lấy ví từ ctx.accounts.referrer_wallet
                        // Vì ở logic trên ta đã gán ref1_pubkey = ref1_wallet.key() nên chắc chắn ví này tồn tại
                        if let Some(ref1_wallet) = &ctx.accounts.referrer_wallet {
                            invoke_transfer(user, ref1_wallet, tier1_amt, &ctx.accounts.system_program)?;
                            admin_amt = admin_amt.saturating_sub(tier1_amt);
                        }
                    }
                }

                // Chia tiền cho Ref 2
                if let Some(_r2) = ref2_pubkey {
                    if tier2_amt > 0 {
                        if let Some(ref2_wallet) = &ctx.accounts.tier2_referrer_wallet {
                            invoke_transfer(user, ref2_wallet, tier2_amt, &ctx.accounts.system_program)?;
                            admin_amt = admin_amt.saturating_sub(tier2_amt);
                        }
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

// --- HELPERS ---
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

// --- CONTEXTS ---

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init, payer = admin, space = 8 + GlobalConfig::INIT_SPACE, 
        seeds = [b"config_v1"], bump
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub admin: Signer<'info>, 
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [b"config_v1"], bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(constraint = admin.key() == config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(code: String, referrer: Option<Pubkey>)]
pub struct RegisterPartner<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"config_v1"], bump)]
    pub config: Account<'info, GlobalConfig>,

    // Đã xóa Treasury ở đây

    #[account(
        init,
        payer = user,
        space = 8 + ReferralCodeMapping::INIT_SPACE,
        seeds = [b"code", code.as_bytes()],
        bump
    )]
    pub referral_code_mapping: Account<'info, ReferralCodeMapping>,

    #[account(
        init, 
        payer = user, 
        space = 8 + ReferralState::INIT_SPACE,
        seeds = [b"referral", user.key().as_ref()], 
        bump
    )]
    pub referral_state: Account<'info, ReferralState>,

    /// CHECK: Validated manually
    pub upline_referrer_state: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CleanAndDistribute<'info> {
    #[account(seeds = [b"config_v1"], bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub user: Signer<'info>,

    // ĐÃ FIX: Dùng cú pháp bump chuẩn của Anchor để tránh lỗi type mismatch
    #[account(
        seeds = [b"referral", user.key().as_ref()], 
        bump
    )]
    pub referral_state: Option<Account<'info, ReferralState>>,
    
    /// CHECK: Validated logic inside function
    #[account(mut)]
    pub referrer_wallet: Option<AccountInfo<'info>>,
    
    /// CHECK: Validated logic inside function
    #[account(mut)]
    pub tier2_referrer_wallet: Option<AccountInfo<'info>>,
    
    /// CHECK: Validated by address constraint
    #[account(mut, address = config.admin)]
    pub treasury: AccountInfo<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// --- DATA ---
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