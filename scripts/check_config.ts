import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";
import { PublicKey } from "@solana/web3.js";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;

    // Seed "config_v1"
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config_v1")],
        program.programId
    );
    console.log("Reading Config PDA:", configPda.toString());

    try {
        const configParams = await program.account.globalConfig.fetch(configPda);
        console.log("-----------------------------------------");
        console.log("✅ Current On-Chain Config:");
        console.log("Admin (Fee Receiver):", configParams.admin.toString());
        console.log("Platform Fee (bps):", configParams.platformFeeBps);
        console.log("Tier 1 Share (bps):", configParams.tier1ShareBps);
        console.log("Tier 2 Share (bps):", configParams.tier2ShareBps);
        console.log("-----------------------------------------");

        const expectedAdmin = "4oRxPsW7GT7GNoPCW5LtEnwQHf8dzFNazQqfK3dtGSgB";
        if (configParams.admin.toString() === expectedAdmin) {
            console.log("🎉 SUCCESS! Admin is correctly set.");
        } else {
            console.log("⚠️ WARNING! Admin does NOT match expected wallet.");
        }

    } catch (e) {
        console.error("Error fetching account:", e);
    }
}

main();
