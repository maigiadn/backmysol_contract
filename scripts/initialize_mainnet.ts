import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";
import { PublicKey } from "@solana/web3.js";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;

    console.log("--- CẬP NHẬT CẤU HÌNH (UPDATE CONFIG) ---");
    console.log("Ví đang thực hiện:", provider.wallet.publicKey.toString());

    // 1. Cấu hình phí mong muốn (Sửa ở đây khi cần thay đổi)
    const PLATFORM_FEE_BPS = 2000; // 20%
    const TIER1_SHARE_BPS = 5000;  // 50%
    const TIER2_SHARE_BPS = 2000;  // 20%

    // 2. Admin mới (Để null nghĩa là KHÔNG đổi Admin, giữ nguyên người cũ)
    const newAdmin = null;

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config_v1")],
        program.programId
    );

    try {
        console.log(`⚙️ Đang cập nhật: Phí ${PLATFORM_FEE_BPS / 100}% | Tier1 ${TIER1_SHARE_BPS / 100}% | Tier2 ${TIER2_SHARE_BPS / 100}%`);

        const tx = await program.methods
            .updateConfig(
                PLATFORM_FEE_BPS,
                TIER1_SHARE_BPS,
                TIER2_SHARE_BPS,
                newAdmin // Truyền null để giữ nguyên Admin hiện tại
            )
            .accounts({
                config: configPda,
                admin: provider.wallet.publicKey,
            } as any)
            .rpc();

        console.log("✅ Cập nhật thành công!");
        console.log("Tx Signature:", tx);

    } catch (error) {
        console.error("❌ Lỗi:", error);
    }
}

main();