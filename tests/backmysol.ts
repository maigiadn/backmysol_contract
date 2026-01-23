import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";
import { expect } from "chai";
import fs from "fs";

describe.only("backmysol_contract", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;
    const admin = provider.wallet;

    // --- HÀM ĐỌC VÍ ---
    function loadKeypair(path: string): anchor.web3.Keypair {
        if (!fs.existsSync(path)) throw new Error(`Không tìm thấy file: ${path}`);
        const secret = JSON.parse(fs.readFileSync(path, 'utf8'));
        return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(secret));
    }

    const userA = loadKeypair("./tests/keypairs/user_a.json");
    const userB = loadKeypair("./tests/keypairs/user_b.json");

    console.log("Admin (Genesis):", admin.publicKey.toBase58());
    console.log("User A:", userA.publicKey.toBase58());

    let configPda: anchor.web3.PublicKey;
    let userBReferralState: anchor.web3.PublicKey;
    let referralCodeMappingPda: anchor.web3.PublicKey;
    let referrerStatePda: anchor.web3.PublicKey; // State của User A

    // State của Admin (Người giới thiệu gốc)
    let adminReferralStatePda: anchor.web3.PublicKey;

    const SEED_CONFIG = "config_v1";
    const SEED_REFERRAL = "referral";
    const SEED_CODE = "code";

    before(async () => {
        [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_CONFIG)],
            program.programId
        );
        [userBReferralState] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_REFERRAL), userB.publicKey.toBuffer()],
            program.programId
        );
        [referrerStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_REFERRAL), userA.publicKey.toBuffer()],
            program.programId
        );
        // Tính địa chỉ State của Admin
        [adminReferralStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_REFERRAL), admin.publicKey.toBuffer()],
            program.programId
        );
    });

    it("1. Khởi tạo Global Config", async () => {
        try {
            await program.account.globalConfig.fetch(configPda);
            console.log("Config đã tồn tại.");
        } catch (e) {
            await program.methods.initialize(admin.publicKey)
                .accounts({
                    admin: admin.publicKey,
                }).rpc();
            console.log("Đã khởi tạo Config.");
        }
    });

    // Step 2 Removed: Genesis Referrer concept is simplified in new logic.
    // Admin is default referrer if none specified.

    it("2. User A đăng ký Partner (Referrer = Admin mặc định)", async () => {
        const referralCode = "SOLFAN";
        [referralCodeMappingPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_CODE), Buffer.from(referralCode)],
            program.programId
        );

        try {
            await program.account.referralCodeMapping.fetch(referralCodeMappingPda);
            console.log("ℹ️ User A đã đăng ký code trước đó via fetch check.");
        } catch {
            try {
                await program.methods
                    .registerPartner(referralCode, null) // No referrer -> Admin
                    .accounts({
                        user: userA.publicKey,
                        config: configPda,
                        referralCodeMapping: referralCodeMappingPda,
                        referralState: referrerStatePda,
                        uplineReferrerState: null,
                        systemProgram: anchor.web3.SystemProgram.programId
                    })
                    .signers([userA])
                    .rpc();
                console.log(`✅ User A đã đăng ký code: ${referralCode}`);
            } catch (e) {
                console.log("ℹ️ Register msg:", e.message);
            }
        }
    });

    it("3. User B liên kết User A và dọn dẹp", async () => {
        // User B register partner (hoặc chỉ link)
        // Trong contract mới, registerPartner cũng xử lý việc link referrer.
        // Ta dùng 1 code dummy cho B để init state của B
        const userBCode = "USERB";
        const [userBCodeMapping] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_CODE), Buffer.from(userBCode)],
            program.programId
        );

        try {
            await program.account.referralCodeMapping.fetch(userBCodeMapping);
            console.log("ℹ️ User B đã liên kết trước đó.");
        } catch {
            try {
                await program.methods
                    .registerPartner(userBCode, userA.publicKey)
                    .accounts({
                        user: userB.publicKey,
                        config: configPda,
                        referralCodeMapping: userBCodeMapping,
                        referralState: userBReferralState,
                        uplineReferrerState: referrerStatePda,
                        systemProgram: anchor.web3.SystemProgram.programId
                    })
                    .signers([userB])
                    .rpc();
                console.log("✅ User B đã liên kết với A.");
            } catch (e) {
                console.log("ℹ️ User B Link msg:", e.message);
            }
        }

        console.log("🚀 Bắt đầu dọn dẹp (Clean & Distribute)...");
        const preBalanceA = await provider.connection.getBalance(userA.publicKey);
        const preBalanceB = await provider.connection.getBalance(userB.publicKey);
        const preBalanceAdmin = await provider.connection.getBalance(admin.publicKey);

        try {
            const builder = program.methods.cleanAndDistribute()
                .accounts({
                    config: configPda,
                    user: userB.publicKey,
                    referralState: userBReferralState, // Add this
                    referrerWallet: userA.publicKey,
                    tier2ReferrerWallet: null,
                    treasury: admin.publicKey,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                });

            // 1. Tìm các tài khoản Token của User B để đóng
            console.log("DEBUG: Start fetching token accounts...");
            const tokenAccounts = await provider.connection.getTokenAccountsByOwner(userB.publicKey, {
                programId: new anchor.web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
            });

            console.log(`🔎 Tìm thấy ${tokenAccounts.value.length} token accounts để dọn dẹp.`);

            // 2. Chuyển đổi sang format AccountMeta
            const remainingAccounts = tokenAccounts.value.map(t => ({
                pubkey: t.pubkey,
                isWritable: true,
                isSigner: false
            }));

            if (remainingAccounts.length > 0) {
                const tx = await builder
                    .remainingAccounts(remainingAccounts)
                    .signers([userB])
                    .rpc();


                console.log("✅ Giao dịch Clean thành công! Signature:", tx);

                const postBalanceA = await provider.connection.getBalance(userA.publicKey);
                const postBalanceB = await provider.connection.getBalance(userB.publicKey);
                const postBalanceAdmin = await provider.connection.getBalance(admin.publicKey);

                console.log("\n📊 --- KẾT QUẢ DÒNG TIỀN ---");
                console.log(`👤 User B (Người được dọn dẹp):`);
                console.log(`   - Trước: ${(preBalanceB / 1e9).toFixed(5)} SOL`);
                console.log(`   - Sau  : ${(postBalanceB / 1e9).toFixed(5)} SOL`);
                console.log(`   -> Thay đổi: +${(postBalanceB - preBalanceB) / 1e9} SOL (Nhận lại Rent)`);

                console.log(`👥 User A (Referrer):`);
                console.log(`   - Trước: ${(preBalanceA / 1e9).toFixed(5)} SOL`);
                console.log(`   - Sau  : ${(postBalanceA / 1e9).toFixed(5)} SOL`);
                console.log(`   -> Thay đổi: +${(postBalanceA - preBalanceA) / 1e9} SOL (Nhận hoa hồng Tier 1)`);

                console.log(`🏦 Admin (Treasury):`);
                console.log(`   - Trước: ${(preBalanceAdmin / 1e9).toFixed(5)} SOL`);
                console.log(`   - Sau  : ${(postBalanceAdmin / 1e9).toFixed(5)} SOL`);
                console.log(`   -> Thay đổi: +${(postBalanceAdmin - preBalanceAdmin) / 1e9} SOL (Nhận phí nền tảng + phần thừa)`);

            } else {
                console.log("⚠️ Không có token rác nào để dọn dẹp. Vui lòng chạy mint_to_target.ts trước.");
            }
        } catch (cleanError) {
            console.error("❌ Lỗi Clean:", cleanError);
        }
    });
});