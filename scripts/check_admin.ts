import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";
import { PublicKey } from "@solana/web3.js";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;

    console.log("🕵️‍♂️ Đang kiểm tra dữ liệu Config trên mạng...");

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config_v1")],
        program.programId
    );

    try {
        const configData = await program.account.globalConfig.fetch(configPda);

        console.log("-------------------------------------------");
        console.log("👑 ADMIN HIỆN TẠI LÀ:", configData.admin.toString());
        console.log("-------------------------------------------");

        console.log("Ví bạn đang dùng script:", provider.wallet.publicKey.toString());

        if (configData.admin.toString() !== provider.wallet.publicKey.toString()) {
            console.log("❌ LỆCH VÍ! Bạn phải dùng ví Admin hiện tại để chạy lệnh Update.");
        } else {
            console.log("✅ Khớp ví! Bạn có quyền Update.");
        }

    } catch (e) {
        console.log("❌ Không tìm thấy Config (Contract chưa khởi tạo hoặc sai Program ID).");
        console.log(e);
    }
}

main();