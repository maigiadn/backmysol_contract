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
            // Chỉ trả hoa hồng khi ví giới thiệu ĐÃ có ReferralState on-chain đăng ký từ trước,
            // chặn việc user truyền ví phụ của chính mình vào để né bớt phí.
            if let Some(ref1_wallet) = &ctx.accounts.referrer_wallet {
                // Chặn tự giới thiệu bản thân
                require!(ref1_wallet.key() != user.key(), ErrorCode::SelfReferral);

                if let Some(ref_state_info) = &ctx.accounts.fallback_referrer_state {
                    let (expected_pda, _bump) = Pubkey::find_program_address(
                        &[b"referral", ref1_wallet.key().as_ref()],
                        ctx.program_id
                    );
                    if ref_state_info.key() == expected_pda
                        && ref_state_info.owner == ctx.program_id
                        && ref_state_info.lamports() > 0
                    {
                        let acc_data = ref_state_info.try_borrow_data()?;
                        let mut slice: &[u8] = &acc_data;
                        if ReferralState::try_deserialize(&mut slice).is_ok() {
                            ref1_pubkey = Some(ref1_wallet.key());
                        }
                    }
                }
                // Referrer chưa đăng ký -> không trả hoa hồng, phần tier1 dồn về treasury
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

    // ============================================================
    // BACKER GUILDS (GAME) — GIAI ĐOẠN 1
    // Backer mua "suất backing" của Champion theo bonding curve,
    // phí giao dịch chia: Champion / SeasonPool / Referral 2 tầng / Treasury
    // ============================================================

    // 5. INIT GAME CONFIG (admin, một lần)
    pub fn initialize_game(ctx: Context<InitializeGame>) -> Result<()> {
        let gc = &mut ctx.accounts.game_config;
        gc.buy_fee_bps = 500;         // phí mua 5%
        gc.sell_fee_bps = 700;        // phí bán 7% (cao hơn mua để chống wash trading)
        gc.champion_share_bps = 5000; // 50% phí cho Champion
        gc.pool_share_bps = 2000;     // 20% phí vào quỹ mùa giải
        gc.ref1_share_bps = 1000;     // 10% phí cho F1
        gc.ref2_share_bps = 500;      // 5% phí cho F2 (còn lại 15% về treasury)
        gc.curve_divisor = 16_000;    // giá suất thứ n = n^2 / 16000 SOL
        gc.lock_seconds = 86_400;     // khóa bán 24h sau lần mua gần nhất
        gc.season_id = 1;
        gc.paused = false;
        gc.bump = ctx.bumps.game_config;

        // Cấp vốn rent-exempt ban đầu cho season_vault mùa 1. PDA này chỉ giữ
        // lamports (không có data) — nếu để trống, lần credit phí đầu tiên
        // (thường rất nhỏ vì giá suất khởi điểm gần như miễn phí) sẽ khiến cả
        // transaction fail do vi phạm rent-exempt.
        let rent_exempt_min = Rent::get()?.minimum_balance(0);
        anchor_lang::solana_program::program::invoke(
            &system_instruction::transfer(
                ctx.accounts.admin.key,
                ctx.accounts.season_vault.key,
                rent_exempt_min,
            ),
            &[
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.season_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        Ok(())
    }

    // 6. UPDATE GAME CONFIG (admin)
    pub fn update_game_config(
        ctx: Context<UpdateGameConfig>,
        buy_fee_bps: u16,
        sell_fee_bps: u16,
        champion_share_bps: u16,
        pool_share_bps: u16,
        ref1_share_bps: u16,
        ref2_share_bps: u16,
        curve_divisor: u64,
        lock_seconds: i64,
        season_id: u32,
        paused: bool,
    ) -> Result<()> {
        require!(buy_fee_bps <= 2000 && sell_fee_bps <= 2000, ErrorCode::InvalidFeeConfig);
        require!(
            (champion_share_bps as u32)
                + (pool_share_bps as u32)
                + (ref1_share_bps as u32)
                + (ref2_share_bps as u32) <= 10_000,
            ErrorCode::InvalidFeeConfig
        );
        require!(curve_divisor > 0 && lock_seconds >= 0, ErrorCode::InvalidFeeConfig);

        let gc = &mut ctx.accounts.game_config;
        gc.buy_fee_bps = buy_fee_bps;
        gc.sell_fee_bps = sell_fee_bps;
        gc.champion_share_bps = champion_share_bps;
        gc.pool_share_bps = pool_share_bps;
        gc.ref1_share_bps = ref1_share_bps;
        gc.ref2_share_bps = ref2_share_bps;
        gc.curve_divisor = curve_divisor;
        gc.lock_seconds = lock_seconds;
        gc.season_id = season_id;
        gc.paused = paused;

        // Vá season rollover: vault của mùa được trỏ tới phải rent-exempt.
        // Khi đổi sang mùa mới, PDA vault mùa đó còn rỗng — nếu không cấp vốn
        // ngay tại đây, lần credit phí đầu tiên của mùa (rất nhỏ) sẽ khiến cả
        // giao dịch mua fail, y hệt bug mùa 1 đã vá trong initialize_game.
        // Mùa không đổi thì vault hiện tại đã đủ tiền, phần bù = 0.
        let rent_exempt_min = Rent::get()?.minimum_balance(0);
        let vault_lamports = ctx.accounts.season_vault.lamports();
        if vault_lamports < rent_exempt_min {
            invoke_transfer(
                &ctx.accounts.admin,
                &ctx.accounts.season_vault,
                rent_exempt_min - vault_lamports,
                &ctx.accounts.system_program,
            )?;
        }
        Ok(())
    }

    // 7. REGISTER CHAMPION — tạo hồ sơ + chiếm mã tên (backmysol.io/<CODE>)
    pub fn register_champion(ctx: Context<RegisterChampion>, code: String) -> Result<()> {
        require!(code.len() > 0 && code.len() <= 10, ErrorCode::InvalidCodeLength);

        let mapping = &mut ctx.accounts.champion_code;
        mapping.owner = ctx.accounts.user.key();
        mapping.bump = ctx.bumps.champion_code;

        let profile = &mut ctx.accounts.champion_profile;
        profile.wallet = ctx.accounts.user.key();
        profile.shares_outstanding = 0;
        profile.season_id = ctx.accounts.game_config.season_id;
        profile.season_volume = 0;
        profile.bump = ctx.bumps.champion_profile;
        Ok(())
    }

    // 8. BUY BACKING — mua `amount` suất theo bonding curve, vốn vào két Champion
    pub fn buy_backing(ctx: Context<BuyBacking>, amount: u64) -> Result<()> {
        let gc = &ctx.accounts.game_config;
        require!(!gc.paused, ErrorCode::GamePaused);
        require!(amount > 0, ErrorCode::InvalidAmount);
        // Cấm Champion tự back chính mình (chống bơm volume)
        require!(
            ctx.accounts.backer.key() != ctx.accounts.champion_profile.wallet,
            ErrorCode::SelfBacking
        );

        let supply = ctx.accounts.champion_profile.shares_outstanding;
        let cost = curve_cost(supply, amount, gc.curve_divisor)?;
        let fee = bps_amount(cost, gc.buy_fee_bps);

        // 1. Vốn mua suất nằm trong két (chính là account ChampionProfile)
        invoke_transfer(
            &ctx.accounts.backer,
            &ctx.accounts.champion_profile.to_account_info(),
            cost,
            &ctx.accounts.system_program,
        )?;

        // 2. Chia phí 4 phần (backer trả thêm phí, ngoài giá suất)
        if fee > 0 {
            let champion_amt = bps_amount(fee, gc.champion_share_bps);
            let pool_amt = bps_amount(fee, gc.pool_share_bps);
            let ref1_amt = bps_amount(fee, gc.ref1_share_bps);
            let ref2_amt = bps_amount(fee, gc.ref2_share_bps);
            let mut treasury_amt = fee;

            if champion_amt > 0 {
                invoke_transfer(
                    &ctx.accounts.backer,
                    &ctx.accounts.champion_wallet,
                    champion_amt,
                    &ctx.accounts.system_program,
                )?;
                treasury_amt -= champion_amt;
            }
            if pool_amt > 0 {
                invoke_transfer(
                    &ctx.accounts.backer,
                    &ctx.accounts.season_vault,
                    pool_amt,
                    &ctx.accounts.system_program,
                )?;
                treasury_amt -= pool_amt;
            }
            // Hoa hồng 2 tầng: CHỈ trả theo ReferralState on-chain của backer
            if let Some(state) = &ctx.accounts.referral_state {
                if ref1_amt > 0 {
                    if let Some(w) = &ctx.accounts.referrer_wallet {
                        require!(w.key() == state.referrer, ErrorCode::InvalidReferrerWallet);
                        invoke_transfer(&ctx.accounts.backer, w, ref1_amt, &ctx.accounts.system_program)?;
                        treasury_amt -= ref1_amt;
                    }
                }
                if ref2_amt > 0 {
                    if let (Some(w), Some(t2)) = (&ctx.accounts.tier2_referrer_wallet, state.tier2_referrer) {
                        require!(w.key() == t2, ErrorCode::InvalidReferrerWallet);
                        invoke_transfer(&ctx.accounts.backer, w, ref2_amt, &ctx.accounts.system_program)?;
                        treasury_amt -= ref2_amt;
                    }
                }
            }
            if treasury_amt > 0 {
                invoke_transfer(&ctx.accounts.backer, &ctx.accounts.treasury, treasury_amt, &ctx.accounts.system_program)?;
            }
        }

        // 3. Cập nhật state
        let clock = Clock::get()?;
        let season_id = gc.season_id;
        let profile = &mut ctx.accounts.champion_profile;
        profile.shares_outstanding = supply.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
        if profile.season_id != season_id {
            profile.season_id = season_id;
            profile.season_volume = 0;
        }
        profile.season_volume = profile.season_volume.saturating_add(cost);

        let pos = &mut ctx.accounts.position;
        pos.champion = profile.wallet;
        pos.backer = ctx.accounts.backer.key();
        pos.shares = pos.shares.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
        pos.last_buy_ts = clock.unix_timestamp;
        pos.bump = ctx.bumps.position;

        emit!(BackingBought {
            champion: profile.wallet,
            backer: pos.backer,
            amount,
            cost,
            fee,
            supply_after: profile.shares_outstanding,
            season_id,
        });
        Ok(())
    }

    // 9. SELL BACKING — bán `amount` suất, nhận SOL từ két theo đúng công thức curve
    pub fn sell_backing(ctx: Context<SellBacking>, amount: u64) -> Result<()> {
        let gc = &ctx.accounts.game_config;
        require!(!gc.paused, ErrorCode::GamePaused);
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(ctx.accounts.position.shares >= amount, ErrorCode::InsufficientShares);

        // Khóa bán sau lần mua gần nhất (chống mua-bán chớp nhoáng cày điểm)
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp.saturating_sub(ctx.accounts.position.last_buy_ts) >= gc.lock_seconds,
            ErrorCode::SharesLocked
        );

        let supply = ctx.accounts.champion_profile.shares_outstanding;
        require!(supply >= amount, ErrorCode::InsufficientShares);

        // Đối xứng với giá mua cùng dải suất -> két luôn đủ tiền trả
        let proceeds = curve_cost(supply - amount, amount, gc.curve_divisor)?;
        let fee = bps_amount(proceeds, gc.sell_fee_bps);
        let seller_amt = proceeds - fee;

        // Rút từ két nhưng phải giữ lại đủ rent cho account
        let profile_info = ctx.accounts.champion_profile.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(profile_info.data_len());
        require!(
            profile_info.lamports().saturating_sub(proceeds) >= rent_min,
            ErrorCode::VaultInsufficient
        );
        debit_lamports(&profile_info, proceeds)?;
        credit_lamports(&ctx.accounts.backer.to_account_info(), seller_amt)?;

        // Chia phí 4 phần từ két (cùng tỷ lệ với buy)
        if fee > 0 {
            let champion_amt = bps_amount(fee, gc.champion_share_bps);
            let pool_amt = bps_amount(fee, gc.pool_share_bps);
            let ref1_amt = bps_amount(fee, gc.ref1_share_bps);
            let ref2_amt = bps_amount(fee, gc.ref2_share_bps);
            let mut treasury_amt = fee;

            if champion_amt > 0 {
                credit_lamports(&ctx.accounts.champion_wallet, champion_amt)?;
                treasury_amt -= champion_amt;
            }
            if pool_amt > 0 {
                credit_lamports(&ctx.accounts.season_vault, pool_amt)?;
                treasury_amt -= pool_amt;
            }
            if let Some(state) = &ctx.accounts.referral_state {
                if ref1_amt > 0 {
                    if let Some(w) = &ctx.accounts.referrer_wallet {
                        require!(w.key() == state.referrer, ErrorCode::InvalidReferrerWallet);
                        credit_lamports(w, ref1_amt)?;
                        treasury_amt -= ref1_amt;
                    }
                }
                if ref2_amt > 0 {
                    if let (Some(w), Some(t2)) = (&ctx.accounts.tier2_referrer_wallet, state.tier2_referrer) {
                        require!(w.key() == t2, ErrorCode::InvalidReferrerWallet);
                        credit_lamports(w, ref2_amt)?;
                        treasury_amt -= ref2_amt;
                    }
                }
            }
            if treasury_amt > 0 {
                credit_lamports(&ctx.accounts.treasury, treasury_amt)?;
            }
        }

        // Cập nhật state
        let season_id = gc.season_id;
        let profile = &mut ctx.accounts.champion_profile;
        profile.shares_outstanding = supply - amount;
        if profile.season_id != season_id {
            profile.season_id = season_id;
            profile.season_volume = 0;
        }
        profile.season_volume = profile.season_volume.saturating_add(proceeds);

        let pos = &mut ctx.accounts.position;
        pos.shares -= amount;

        emit!(BackingSold {
            champion: profile.wallet,
            backer: pos.backer,
            amount,
            proceeds,
            fee,
            supply_after: profile.shares_outstanding,
            season_id,
        });
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

/// Tổng bình phương 1^2 + 2^2 + ... + n^2 = n(n+1)(2n+1)/6
fn sum_of_squares(n: u64) -> u128 {
    let n = n as u128;
    n * (n + 1) * (2 * n + 1) / 6
}

/// Chi phí mua (hoặc tiền nhận khi bán) `amount` suất khi đang có `supply` suất lưu hành.
/// Giá suất thứ n = n^2 * 1 SOL / divisor. Mua và bán cùng dải suất cho ra đúng
/// một con số -> két Champion luôn đủ tiền hoàn trả.
fn curve_cost(supply: u64, amount: u64, divisor: u64) -> Result<u64> {
    let end = supply.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
    let sum = sum_of_squares(end) - sum_of_squares(supply);
    let lamports = sum
        .checked_mul(1_000_000_000)
        .ok_or(ErrorCode::MathOverflow)?
        / divisor as u128;
    u64::try_from(lamports).map_err(|_| error!(ErrorCode::MathOverflow))
}

/// Tính phần theo basis points (1 bps = 0.01%)
fn bps_amount(value: u64, bps: u16) -> u64 {
    ((value as u128) * (bps as u128) / 10_000) as u64
}

/// Trừ lamports khỏi account do program sở hữu (rút từ két)
fn debit_lamports(info: &AccountInfo, amount: u64) -> Result<()> {
    let mut lamports = info.try_borrow_mut_lamports()?;
    **lamports = lamports.checked_sub(amount).ok_or(ErrorCode::VaultInsufficient)?;
    Ok(())
}

/// Cộng lamports vào account bất kỳ (writable)
fn credit_lamports(info: &AccountInfo, amount: u64) -> Result<()> {
    let mut lamports = info.try_borrow_mut_lamports()?;
    **lamports = lamports.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
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

    /// CHECK: ReferralState PDA của referrer_wallet — bắt buộc có (và hợp lệ)
    /// thì hoa hồng fallback mới được trả cho referrer_wallet
    pub fallback_referrer_state: Option<AccountInfo<'info>>,

    /// CHECK: Validated by address constraint
    #[account(mut, address = config.admin)]
    pub treasury: AccountInfo<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// --- GAME CONTEXTS (BACKER GUILDS) ---

#[derive(Accounts)]
pub struct InitializeGame<'info> {
    #[account(seeds = [b"config_v1"], bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        init, payer = admin, space = 8 + GameConfig::INIT_SPACE,
        seeds = [b"game_config_v1"], bump
    )]
    pub game_config: Account<'info, GameConfig>,

    /// CHECK: PDA quỹ mùa giải mùa 1, chỉ giữ lamports — cấp vốn rent-exempt ngay khi init game
    #[account(mut, seeds = [b"season_vault", &1u32.to_le_bytes()], bump)]
    pub season_vault: AccountInfo<'info>,

    #[account(mut, constraint = admin.key() == config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    buy_fee_bps: u16,
    sell_fee_bps: u16,
    champion_share_bps: u16,
    pool_share_bps: u16,
    ref1_share_bps: u16,
    ref2_share_bps: u16,
    curve_divisor: u64,
    lock_seconds: i64,
    season_id: u32
)]
pub struct UpdateGameConfig<'info> {
    #[account(seeds = [b"config_v1"], bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(mut, seeds = [b"game_config_v1"], bump = game_config.bump)]
    pub game_config: Account<'info, GameConfig>,

    /// CHECK: PDA quỹ mùa của season_id truyền vào — được cấp vốn rent-exempt
    /// ngay trong instruction nếu còn thiếu (quan trọng khi đổi mùa)
    #[account(mut, seeds = [b"season_vault", &season_id.to_le_bytes()], bump)]
    pub season_vault: AccountInfo<'info>,

    #[account(mut, constraint = admin.key() == config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(code: String)]
pub struct RegisterChampion<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"game_config_v1"], bump = game_config.bump)]
    pub game_config: Account<'info, GameConfig>,

    #[account(
        init, payer = user, space = 8 + ChampionProfile::INIT_SPACE,
        seeds = [b"champion", user.key().as_ref()], bump
    )]
    pub champion_profile: Account<'info, ChampionProfile>,

    // Mã tên Champion dùng chung không gian mã với referral (backmysol.io/<CODE>)
    #[account(
        init, payer = user, space = 8 + ReferralCodeMapping::INIT_SPACE,
        seeds = [b"code", code.as_bytes()], bump
    )]
    pub champion_code: Account<'info, ReferralCodeMapping>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyBacking<'info> {
    #[account(seeds = [b"config_v1"], bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(seeds = [b"game_config_v1"], bump = game_config.bump)]
    pub game_config: Account<'info, GameConfig>,

    #[account(mut)]
    pub backer: Signer<'info>,

    // Két SOL của Champion nằm ngay trong account này
    #[account(
        mut,
        seeds = [b"champion", champion_profile.wallet.as_ref()],
        bump = champion_profile.bump
    )]
    pub champion_profile: Account<'info, ChampionProfile>,

    /// CHECK: phải đúng ví của Champion trong profile
    #[account(mut, address = champion_profile.wallet @ ErrorCode::InvalidChampionWallet)]
    pub champion_wallet: AccountInfo<'info>,

    /// CHECK: PDA quỹ mùa giải, chỉ giữ lamports
    #[account(mut, seeds = [b"season_vault", &game_config.season_id.to_le_bytes()], bump)]
    pub season_vault: AccountInfo<'info>,

    // ReferralState CỦA BACKER — chỉ trả hoa hồng theo dữ liệu on-chain này
    #[account(seeds = [b"referral", backer.key().as_ref()], bump)]
    pub referral_state: Option<Account<'info, ReferralState>>,

    /// CHECK: đối chiếu với referral_state.referrer trong hàm
    #[account(mut)]
    pub referrer_wallet: Option<AccountInfo<'info>>,

    /// CHECK: đối chiếu với referral_state.tier2_referrer trong hàm
    #[account(mut)]
    pub tier2_referrer_wallet: Option<AccountInfo<'info>>,

    /// CHECK: Validated by address constraint
    #[account(mut, address = config.admin)]
    pub treasury: AccountInfo<'info>,

    #[account(
        init_if_needed, payer = backer, space = 8 + BackingPosition::INIT_SPACE,
        seeds = [b"backing", champion_profile.wallet.as_ref(), backer.key().as_ref()],
        bump
    )]
    pub position: Account<'info, BackingPosition>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SellBacking<'info> {
    #[account(seeds = [b"config_v1"], bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(seeds = [b"game_config_v1"], bump = game_config.bump)]
    pub game_config: Account<'info, GameConfig>,

    #[account(mut)]
    pub backer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"champion", champion_profile.wallet.as_ref()],
        bump = champion_profile.bump
    )]
    pub champion_profile: Account<'info, ChampionProfile>,

    /// CHECK: phải đúng ví của Champion trong profile
    #[account(mut, address = champion_profile.wallet @ ErrorCode::InvalidChampionWallet)]
    pub champion_wallet: AccountInfo<'info>,

    /// CHECK: PDA quỹ mùa giải, chỉ giữ lamports
    #[account(mut, seeds = [b"season_vault", &game_config.season_id.to_le_bytes()], bump)]
    pub season_vault: AccountInfo<'info>,

    #[account(seeds = [b"referral", backer.key().as_ref()], bump)]
    pub referral_state: Option<Account<'info, ReferralState>>,

    /// CHECK: đối chiếu với referral_state.referrer trong hàm
    #[account(mut)]
    pub referrer_wallet: Option<AccountInfo<'info>>,

    /// CHECK: đối chiếu với referral_state.tier2_referrer trong hàm
    #[account(mut)]
    pub tier2_referrer_wallet: Option<AccountInfo<'info>>,

    /// CHECK: Validated by address constraint
    #[account(mut, address = config.admin)]
    pub treasury: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"backing", champion_profile.wallet.as_ref(), backer.key().as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, BackingPosition>,

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

// --- GAME DATA (BACKER GUILDS) ---

#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    pub buy_fee_bps: u16,
    pub sell_fee_bps: u16,
    pub champion_share_bps: u16,
    pub pool_share_bps: u16,
    pub ref1_share_bps: u16,
    pub ref2_share_bps: u16,
    pub curve_divisor: u64,
    pub lock_seconds: i64,
    pub season_id: u32,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ChampionProfile {
    pub wallet: Pubkey,
    pub shares_outstanding: u64,
    pub season_id: u32,
    pub season_volume: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BackingPosition {
    pub champion: Pubkey,
    pub backer: Pubkey,
    pub shares: u64,
    pub last_buy_ts: i64,
    pub bump: u8,
}

// --- EVENTS (cho indexer dựng bảng xếp hạng) ---

#[event]
pub struct BackingBought {
    pub champion: Pubkey,
    pub backer: Pubkey,
    pub amount: u64,
    pub cost: u64,
    pub fee: u64,
    pub supply_after: u64,
    pub season_id: u32,
}

#[event]
pub struct BackingSold {
    pub champion: Pubkey,
    pub backer: Pubkey,
    pub amount: u64,
    pub proceeds: u64,
    pub fee: u64,
    pub supply_after: u64,
    pub season_id: u32,
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
    #[msg("The game is paused.")]
    GamePaused,
    #[msg("Champions cannot back themselves.")]
    SelfBacking,
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Not enough backing shares.")]
    InsufficientShares,
    #[msg("Shares are still locked after the latest buy.")]
    SharesLocked,
    #[msg("Champion wallet does not match the champion profile.")]
    InvalidChampionWallet,
    #[msg("Invalid fee configuration.")]
    InvalidFeeConfig,
    #[msg("Math overflow.")]
    MathOverflow,
    #[msg("Champion vault has insufficient balance.")]
    VaultInsufficient,
}