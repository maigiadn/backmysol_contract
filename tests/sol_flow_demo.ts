import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";
import { Keypair } from "@solana/web3.js";
import fs from "fs";

describe("sol_flow_demo", () => {
    // 1. Env Setup
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;
    const admin = provider.wallet;

    // 2. Load Keys
    const userA = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync("./tests/keypairs/user_a.json", "utf8")))
    );
    const userB = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync("./tests/keypairs/user_b.json", "utf8")))
    );

    console.log("--- SETUP ---");
    console.log("Admin:", admin.publicKey.toBase58());
    console.log("User A (Referrer):", userA.publicKey.toBase58());
    console.log("User B (Target):", userB.publicKey.toBase58());

    it("Dọn dẹp ví User B và hiển thị dòng tiền", async () => {
        // 3. Capture Pre-Balances
        const preBalanceB = await provider.connection.getBalance(userB.publicKey);
        const preBalanceA = await provider.connection.getBalance(userA.publicKey);
        const preBalanceAdmin = await provider.connection.getBalance(admin.publicKey);

        console.log("\n💰 [TRƯỚC KHI CLEAN]");
        console.log(`   User B: ${(preBalanceB / 1e9).toFixed(5)} SOL`);
        console.log(`   User A: ${(preBalanceA / 1e9).toFixed(5)} SOL`);
        console.log(`   Admin : ${(preBalanceAdmin / 1e9).toFixed(5)} SOL`);

        // 4. Find Empty Accounts
        console.log("\n🔎 Đang tìm tài khoản rác của User B...");
        const tokenAccounts = await provider.connection.getTokenAccountsByOwner(userB.publicKey, {
            programId: new anchor.web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        });

        console.log(`   -> Tìm thấy: ${tokenAccounts.value.length} tài khoản.`);

        if (tokenAccounts.value.length === 0) {
            console.log("⚠️ KHÔNG CÓ TÀI KHOẢN RÁC! Hãy chạy 'npm run test-mint' hoặc tương tự trước.");
            return;
        }

        const remainingAccounts = tokenAccounts.value.map(t => ({
            pubkey: t.pubkey,
            isWritable: true,
            isSigner: false
        }));

        // 5. Execute Clean
        console.log("🚀 Đang chạy lệnh cleanAndDistribute...");
        try {
            const tx = await program.methods.cleanAndDistribute()
                .accounts({
                    user: userB.publicKey,
                    referrerWallet: userA.publicKey,
                    tier2ReferrerWallet: null,
                    treasury: admin.publicKey,
                })
                .remainingAccounts(remainingAccounts)
                .signers([userB])
                .rpc();

            console.log("✅ Thành công! Tx:", tx);

            // 6. Capture Post-Balances
            // Wait a bit for finality? Devnet is fast.
            const postBalanceB = await provider.connection.getBalance(userB.publicKey);
            const postBalanceA = await provider.connection.getBalance(userA.publicKey);
            const postBalanceAdmin = await provider.connection.getBalance(admin.publicKey);

            console.log("\n📊 [KẾT QUẢ DÒNG TIỀN]");
            console.log(`👤 User B (Nhận lại Rent):`);
            console.log(`   Trước: ${(preBalanceB / 1e9).toFixed(5)}`);
            console.log(`   Sau  : ${(postBalanceB / 1e9).toFixed(5)}`);
            console.log(`   Change: +${(postBalanceB - preBalanceB) / 1e9} SOL`);

            console.log(`👥 User A (Hoa hồng):`);
            console.log(`   Change: +${(postBalanceA - preBalanceA) / 1e9} SOL`);

            console.log(`🏦 Admin (Fee):`);
            console.log(`   Change: +${(postBalanceAdmin - preBalanceAdmin) / 1e9} SOL`);

        } catch (e) {
            console.error("❌ Lỗi:", e);
        }
    });
});
