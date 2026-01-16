import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";

async function main() {
    // 1. Cấu hình Provider (Sử dụng ví Admin hiện tại)
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    // 2. Kết nối tới Program đã deploy
    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;

    console.log("🚀 Đang cập nhật Config cho program:", program.programId.toString());

    // 3. Tìm địa chỉ PDA của Config (Seed: "config_v1")
    // LƯU Ý: Phải khớp chính xác seed trong code Rust của bạn
    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config_v1")],
        program.programId
    );

    console.log("📍 Config Account Address:", configPda.toString());

    try {
        // 4. Gọi hàm update_config
        // Tham số: (platform_fee, tier1_share, tier2_share, new_admin)
        // 20% = 2000 bps
        const tx = await program.methods
            .updateConfig(
                2000, // Platform Fee: 20% (Giữ nguyên)
                5000, // Tier 1 Share: 50% (Giữ nguyên)
                2000, // Tier 2 Share: 20% (THAY ĐỔI TỪ 2500 -> 2000)
                null  // New Admin: null (Không đổi admin)
            )
            .accounts({
                admin: provider.wallet.publicKey, // Ví chạy lệnh này phải là Admin
            })
            .rpc();

        console.log("✅ Update thành công!");
        console.log("📝 Transaction Signature:", tx);

        // 5. Kiểm tra lại dữ liệu sau khi update
        const configAccount = await program.account.globalConfig.fetch(configPda);
        console.log("--- CẤU HÌNH MỚI ---");
        console.log("Platform Fee:", configAccount.platformFeeBps);
        console.log("Tier 1 Share:", configAccount.tier1ShareBps);
        console.log("Tier 2 Share:", configAccount.tier2ShareBps);

    } catch (error) {
        console.error("❌ Lỗi khi update:", error);
    }
}

main().then(() => process.exit());