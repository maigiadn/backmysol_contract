import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";
import { PublicKey, SystemProgram } from "@solana/web3.js";

async function main() {
    // 1. Setup Provider và Program
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;

    if (!program) {
        throw new Error("Không tìm thấy Program! Kiểm tra lại Anchor.toml");
    }

    console.log("---------------------------------------------");
    console.log("🛠  Đang chạy script Initialize...");
    console.log("Program ID:", program.programId.toString());

    // 2. Tìm PDA Config 
    // Seed "config_v1" (match contract)
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config_v1")],
        program.programId
    );
    console.log("Config Account PDA:", configPda.toString());

    // Admin Key: 4oRxPsW7GT7GNoPCW5LtEnwQHf8dzFNazQqfK3dtGSgB
    const adminKey = new PublicKey("4oRxPsW7GT7GNoPCW5LtEnwQHf8dzFNazQqfK3dtGSgB");

    try {
        console.log("🚀 Đang gửi lệnh Initialize...");

        const txInit = await program.methods
            .initialize(adminKey)
            .accounts({
                admin: provider.wallet.publicKey,
            })
            .rpc();
        console.log("✅ Giao dịch Initialize thành công:", txInit);
        console.log("Config Account đã được khởi tạo.");
    } catch (error: any) {
        // Kiểm tra nếu đã init rồi
        if (String(error).includes("already in use")) {
            console.log("⚠️  LƯU Ý: Contract ĐÃ được Initialize trước đó rồi.");
            console.log("Bạn có thể bỏ qua và sử dụng close_empty_accounts bình thường.");
        } else {
            console.error(error);
        }
    }
}

main().then(
    () => process.exit(0),
    (err) => {
        console.error(err);
        process.exit(1);
    }
);