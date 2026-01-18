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

    it("2. Tạo Genesis Referrer (Admin tự kích hoạt)", async () => {
        // Bước này cực quan trọng: Admin phải tự tạo State cho mình trước
        // Để sau này User A có thể trỏ vào Admin mà không bị lỗi "AccountNotInitialized"
        try {
            await program.account.referralState.fetch(adminReferralStatePda);
            console.log("Admin State đã tồn tại (Genesis OK).");
        } catch (e) {
            console.log("Đang tạo Genesis Referrer (Admin)...");
            try {
                // Admin dùng Dummy Referrer (SystemProgram) để khởi tạo Genesis
                // Vì referrer_state của SystemProgram không tồn tại -> Contract sẽ coi như không có uplink => Genesis
                const dummyReferrer = anchor.web3.SystemProgram.programId;
                const [dummyReferrerStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
                    [Buffer.from(SEED_REFERRAL), dummyReferrer.toBuffer()],
                    program.programId
                );

                await program.methods
                    .initializeReferral(dummyReferrer)
                    .accounts({
                        user: admin.publicKey,
                        referrerState: dummyReferrerStatePda, // Explicitly pass the derived address
                    })
                    .rpc();
                console.log("✅ Tạo Genesis Admin thành công!");
            } catch (err) {
                console.log("ℹ️ Admin Init Msg:", err.message);
            }
        }
    });

    it("3. User A đăng ký (Referrer = Admin)", async () => {
        const referralCode = "SOLFAN";
        [referralCodeMappingPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_CODE), Buffer.from(referralCode)],
            program.programId
        );

        // --- KHỞI TẠO STATE CHO USER A ---
        try {
            await program.account.referralState.fetch(referrerStatePda);
            console.log("State User A đã có.");
        } catch (e) {
            console.log("Đang khởi tạo state cho User A...");

            try {
                // SỬA LỖI CHÍNH: Truyền Admin Key vào làm Referrer (thay vì null)
                await program.methods
                    .initializeReferral(admin.publicKey)
                    .accounts({
                        user: userA.publicKey,
                        referrerState: adminReferralStatePda,
                    })
                    .signers([userA])
                    .rpc();
                console.log("✅ User A Init State thành công!");
            } catch (rpcError) {
                if (rpcError.message.includes("already in use")) {
                    console.log("ℹ️ State User A đã tồn tại.");
                } else if (rpcError.message.includes("AccountNotInitialized")) {
                    console.error("❌ Lỗi: Admin chưa được khởi tạo (Bước 2 thất bại). Contract yêu cầu Referrer phải có State.");
                } else {
                    console.error("❌ Lỗi Init User A:", rpcError);
                }
            }
        }

        // --- Đăng ký Code ---
        try {
            await program.methods
                .registerReferralCode(referralCode)
                .accounts({
                    user: userA.publicKey,
                    treasury: admin.publicKey, // Dùng Admin làm Treasury cho khớp constraint
                })
                .signers([userA])
                .rpc();
            console.log(`✅ User A đã đăng ký code: ${referralCode}`);
        } catch (e) {
            console.log("ℹ️ Code info:", e.message);
        }
    });

    it("4. User B liên kết User A và dọn dẹp", async () => {
        // Kiểm tra State A
        try {
            await program.account.referralState.fetch(referrerStatePda);
        } catch (e) {
            throw new Error("CRITICAL: User A chưa có State. Test dừng lại.");
        }

        // B link với A
        try {
            await program.methods
                .initializeReferral(userA.publicKey)
                .accounts({
                    user: userB.publicKey,
                    referrerState: referrerStatePda,
                })
                .signers([userB])
                .rpc();
            console.log("✅ User B đã liên kết với A.");
        } catch (e) {
            if (e.message.includes("already in use") || e.message.includes("0x0")) {
                console.log("ℹ️ User B đã có state.");
            } else {
                console.log("⚠️ Lỗi Link User B:", e.message);
            }
        }

        console.log("🚀 Bắt đầu dọn dẹp (Clean & Distribute)...");
        const preBalanceA = await provider.connection.getBalance(userA.publicKey);
        const preBalanceB = await provider.connection.getBalance(userB.publicKey);
        const preBalanceAdmin = await provider.connection.getBalance(admin.publicKey);

        try {
            const builder = program.methods.cleanAndDistribute()
                .accounts({
                    user: userB.publicKey,
                    referrerWallet: userA.publicKey,
                    tier2ReferrerWallet: null,
                    treasury: admin.publicKey,
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