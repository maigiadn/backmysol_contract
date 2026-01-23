import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("BackMySol Full Scenario", () => {
    // 1. Env Setup
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;
    const admin = provider.wallet;

    // New wallets for scenario
    const partnerUser = Keypair.generate(); // User A (Partner)
    const clientUser = Keypair.generate();  // User B (Client/Victim with spam tokens)

    // PDAs
    let configPda: PublicKey;
    let partnerReferralState: PublicKey;
    let clientReferralState: PublicKey;
    let codeMappingPda: PublicKey;

    // Constants
    const SEED_CONFIG = "config_v1";
    const SEED_REFERRAL = "referral";
    const SEED_CODE = "code";
    const REFERRAL_CODE = "TESTPARTNER";

    before(async () => {
        // Find PDAs
        [configPda] = PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_CONFIG)],
            program.programId
        );
        [partnerReferralState] = PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_REFERRAL), partnerUser.publicKey.toBuffer()],
            program.programId
        );
        [clientReferralState] = PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_REFERRAL), clientUser.publicKey.toBuffer()],
            program.programId
        );
        [codeMappingPda] = PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_CODE), Buffer.from(REFERRAL_CODE)],
            program.programId
        );

        // Airdrop SOL
        await provider.connection.requestAirdrop(partnerUser.publicKey, 2 * 1e9).then(confirm);
        await provider.connection.requestAirdrop(clientUser.publicKey, 2 * 1e9).then(confirm);

        console.log("--- Setup Complete ---");
        console.log("Admin:", admin.publicKey.toBase58());
        console.log("Partner (A):", partnerUser.publicKey.toBase58());
        console.log("Client (B):", clientUser.publicKey.toBase58());
    });

    const confirm = async (sig: string) => {
        await provider.connection.confirmTransaction(sig, "confirmed");
    };

    it("1. Initialize Global Config (if not exists)", async () => {
        try {
            await program.account.globalConfig.fetch(configPda);
            console.log("Config already initialized.");
        } catch (e) {
            await program.methods.initialize(admin.publicKey)
                .accounts({
                    config: configPda,
                    admin: admin.publicKey,
                    systemProgram: SystemProgram.programId,
                }).rpc();
            console.log("Config initialized.");
        }

        const config = await program.account.globalConfig.fetch(configPda);
        expect(config.platformFeeBps).to.equal(2000);
        expect(config.tier1ShareBps).to.equal(5000);
    });

    it("2. Register Partner (User A)", async () => {
        // User A registers as a partner with NO referrer (or Admin as referrer implicitly)
        await program.methods.registerPartner(REFERRAL_CODE, null)
            .accounts({
                user: partnerUser.publicKey,
                config: configPda,
                referralCodeMapping: codeMappingPda,
                referralState: partnerReferralState,
                uplineReferrerState: null,
                systemProgram: SystemProgram.programId,
            })
            .signers([partnerUser])
            .rpc();

        const state = await program.account.referralState.fetch(partnerReferralState);
        const mapping = await program.account.referralCodeMapping.fetch(codeMappingPda);

        expect(mapping.owner.toBase58()).to.equal(partnerUser.publicKey.toBase58());
        // Default referrer is Admin
        expect(state.referrer.toBase58()).to.equal(admin.publicKey.toBase58());
        console.log(`Partner registered code: ${REFERRAL_CODE}`);
    });

    it("3. User B links to User A (via Code/Link)", async () => {
        // In this contract flow, linking happens either explicitly or during first interaction.
        // Based on register_partner signature, User B calls register_partner with User A as referrer.
        // NOTE: This call sets User B's upline to User A.

        const userBCode = "USERB";
        const [userBCodePda] = PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_CODE), Buffer.from(userBCode)],
            program.programId
        );

        await program.methods.registerPartner(userBCode, partnerUser.publicKey)
            .accounts({
                user: clientUser.publicKey,
                config: configPda,
                referralCodeMapping: userBCodePda,
                referralState: clientReferralState,
                uplineReferrerState: partnerReferralState,
                systemProgram: SystemProgram.programId,
            })
            .signers([clientUser])
            .rpc();

        const state = await program.account.referralState.fetch(clientReferralState);
        expect(state.referrer.toBase58()).to.equal(partnerUser.publicKey.toBase58());
        console.log("User B linked to Partner A.");
    });

    it("4. Clean and Distribute", async () => {
        // NOTE: Normally we would mint spam tokens here. 
        // For this test, if no spam tokens exist, we just verify the instruction runs without error (but no rent collected).
        // Or we can simulate closing an account if we create one.

        // Attempting to run instruction (even with 0 accounts) to verify accounts resolution.

        // Capture balances
        const preBalanceA = await provider.connection.getBalance(partnerUser.publicKey);
        const preBalanceAdmin = await provider.connection.getBalance(admin.publicKey);

        try {
            const tx = await program.methods.cleanAndDistribute()
                .accounts({
                    config: configPda,
                    user: clientUser.publicKey,
                    referralState: clientReferralState,
                    referrerWallet: partnerUser.publicKey, // F1 Wallet
                    tier2ReferrerWallet: null, // No F2
                    treasury: admin.publicKey,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .remainingAccounts([]) // No spam accounts to clean in basic test
                .signers([clientUser])
                .rpc();

            console.log("Clean transaction successful (even with 0 accounts). Tx:", tx);
        } catch (e) {
            console.error("Clean error:", e);
            throw e;
        }
    });

});
