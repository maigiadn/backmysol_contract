import * as anchor from "@coral-xyz/anchor";
import {
    createMint,
    createAssociatedTokenAccountInstruction,
    getAssociatedTokenAddressSync,
    mintTo
} from "@solana/spl-token";
import { Keypair, SystemProgram, Transaction, PublicKey } from "@solana/web3.js";

// Hàm chờ (sleep) để tránh bị RPC chặn vì spam quá nhanh
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mint_to_target", () => {
    // Cấu hình Provider
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const payer = provider.wallet as anchor.Wallet;

    // ĐỊA CHỈ VÍ ĐÍCH MUỐN TẠO TOKEN VÀO
    const TARGET_WALLET = new PublicKey("CmDe1vtVGaycKJxZ7DEbeAH5me8LUFtNBSJTgcL2L6gw");

    // SỐ LƯỢNG TÀI KHOẢN MUỐN TẠO (Đã sửa thành 20)
    const ACCOUNT_COUNT = 18;

    it("Create Empty Token Accounts for Target Wallet", async () => {
        console.log(`🚀 Bắt đầu tạo ${ACCOUNT_COUNT} token rác cho ví: ${TARGET_WALLET.toString()}...`);
        console.log(`💸 Người trả tiền Rent: ${payer.publicKey.toString()}`);

        for (let i = 0; i < ACCOUNT_COUNT; i++) {
            try {
                console.log(`\n--- Đang xử lý ${i + 1}/${ACCOUNT_COUNT} ---`);

                // 1. Tạo Token Mint mới
                const mintPubkey = await createMint(
                    provider.connection,
                    payer.payer,
                    payer.publicKey,
                    null,
                    0 // 0 Decimals
                );

                // 2. Tìm địa chỉ ATA cho ví đích
                const ata = getAssociatedTokenAddressSync(
                    mintPubkey,
                    TARGET_WALLET
                );

                console.log(`🔹 Mint: ${mintPubkey.toBase58()}`);
                console.log(`🔹 ATA : ${ata.toBase58()}`);

                // 3. Tạo lệnh khởi tạo ATA
                const createAtaTx = new Transaction().add(
                    createAssociatedTokenAccountInstruction(
                        payer.publicKey, // Payer
                        ata,             // ATA Address
                        TARGET_WALLET,   // Owner
                        mintPubkey       // Mint
                    )
                );

                await provider.sendAndConfirm(createAtaTx);
                console.log(`✅ Đã tạo thành công tài khoản thứ ${i + 1}`);

                // Nếu muốn Nạp tiền (Mint to) để test Burn, hãy bỏ comment phần dưới:
                /*
                await mintTo(
                  provider.connection,
                  payer.payer,
                  mintPubkey,
                  ata,
                  payer.payer,
                  100 // Số lượng
                );
                console.log("   -> Đã mint 100 token vào ví.");
                */

                // NGỦ 1 GIÂY để tránh lỗi "Too many requests" từ RPC
                await sleep(1000);

            } catch (error) {
                console.error(`❌ Lỗi ở tài khoản thứ ${i + 1}:`, error);
                // Script sẽ tiếp tục chạy cái tiếp theo dù cái này lỗi
            }
        }

        console.log("\n🎉 HOÀN TẤT TOÀN BỘ QUÁ TRÌNH!");
    });
});