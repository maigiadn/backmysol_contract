import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";
import {
    createMint,
    createAssociatedTokenAccountInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
    createInitializeAccountInstruction,
    ACCOUNT_SIZE
} from "@solana/spl-token";
import { Keypair, SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";

describe("clean_and_distribute", () => {
    // Configure the client to use the local cluster.
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;

    // Accounts
    const admin = provider.wallet;
    const user = Keypair.generate();
    const referrer = Keypair.generate();
    const tier2Referrer = Keypair.generate(); // Grandparent
    const treasuryKeypair = Keypair.generate(); // Treasury wallet (simulate)

    const TREASURY_PUBKEY = treasuryKeypair.publicKey;

    // PDAs
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config_v1")],
        program.programId
    );

    // Derived manually for verification but not passed to instruction if auto-resolved
    const [userReferralStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("referral"), user.publicKey.toBuffer()],
        program.programId
    );

    const [referrerReferralStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("referral"), referrer.publicKey.toBuffer()],
        program.programId
    );

    let trashTokenAccount: PublicKey;

    it("Initialize Config and Referrers", async () => {
        // 1. Fund User & Referrers via Transfer from Provider (Airdrop is unreliable on devnet/mainnet)
        const fund = async (pubkey: PublicKey, amount: number) => {
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: provider.wallet.publicKey,
                    toPubkey: pubkey,
                    lamports: amount,
                })
            );
            await provider.sendAndConfirm(tx);
            console.log(`Funded ${pubkey.toString()} with ${amount / LAMPORTS_PER_SOL} SOL`);
        }

        try {
            await fund(user.publicKey, 0.1 * LAMPORTS_PER_SOL);
            await fund(referrer.publicKey, 0.05 * LAMPORTS_PER_SOL);
            await fund(tier2Referrer.publicKey, 0.05 * LAMPORTS_PER_SOL);
        } catch (e) {
            console.error("Funding failed. Ensure provider wallet has SOL.", e);
            throw e;
        }

        await new Promise(r => setTimeout(r, 1000));

        // 2. Initialize Config
        try {
            await program.methods.initialize(null)
                .accounts({
                    // config: configPda, // Auto-resolved
                    admin: admin.publicKey,
                    // systemProgram: SystemProgram.programId, // Auto-resolved
                })
                .rpc();
            console.log("Config initialized");
        } catch (e) {
            console.log("Config might already be initialized");
        }

        // 3. Initialize Tier 2 Referrer (Grandparent)
        await program.methods.initializeReferral(anchor.web3.PublicKey.default)
            .accounts({
                user: tier2Referrer.publicKey,
                // @ts-ignore
                referrerState: null,
            })
            .signers([tier2Referrer])
            .rpc();

        // 4. Initialize Referrer (Parent), referred by Tier 2
        await program.methods.initializeReferral(tier2Referrer.publicKey)
            .accounts({
                user: referrer.publicKey,
            })
            .signers([referrer])
            .rpc();

        // 5. Initialize User, referred by Referrer
        await program.methods.initializeReferral(referrer.publicKey)
            .accounts({
                user: user.publicKey,
            })
            .signers([user])
            .rpc();

        console.log("Referral chain initialized: Tier2 -> Referrer -> User");
    });

    it("Create Trash Token Account", async () => {
        const mint = await createMint(
            provider.connection,
            user,
            user.publicKey,
            null,
            9
        );

        const trashKeypair = Keypair.generate();
        trashTokenAccount = trashKeypair.publicKey;
        const space = ACCOUNT_SIZE;
        const lamports = await provider.connection.getMinimumBalanceForRentExemption(space);

        const tx = new Transaction().add(
            SystemProgram.createAccount({
                fromPubkey: user.publicKey,
                newAccountPubkey: trashTokenAccount,
                space,
                lamports,
                programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeAccountInstruction(
                trashTokenAccount,
                mint,
                user.publicKey
            )
        );

        await provider.sendAndConfirm(tx, [user, trashKeypair]);
        console.log("Trash account created:", trashTokenAccount.toString(), "Balance:", lamports);
    });

    it("Clean and Distribute", async () => {
        const preUserBalance = await provider.connection.getBalance(user.publicKey);
        const preReferrerBalance = await provider.connection.getBalance(referrer.publicKey);
        const preTier2Balance = await provider.connection.getBalance(tier2Referrer.publicKey);
        const preAdminBalance = await provider.connection.getBalance(admin.publicKey);

        // Call Clean and Distribute
        await program.methods.cleanAndDistribute()
            .accounts({
                // config: configPda, // Auto
                user: user.publicKey,
                // referralState: ... // Auto
                referrerWallet: referrer.publicKey,
                tier2ReferrerWallet: tier2Referrer.publicKey,
                treasury: admin.publicKey,
                // tokenProgram: ... // Auto
                // systemProgram: ... // Auto
            })
            .remainingAccounts([
                { pubkey: trashTokenAccount ?? anchor.web3.PublicKey.default, isWritable: true, isSigner: false }
            ])
            .signers([user])
            .rpc();

        // Check Balances
        const postUserBalance = await provider.connection.getBalance(user.publicKey);
        const postReferrerBalance = await provider.connection.getBalance(referrer.publicKey);
        const postTier2Balance = await provider.connection.getBalance(tier2Referrer.publicKey);

        console.log("User Diff:", postUserBalance - preUserBalance);
        console.log("Ref1 Diff:", postReferrerBalance - preReferrerBalance);
        console.log("Ref2 Diff:", postTier2Balance - preTier2Balance);

        assert.isTrue(postReferrerBalance > preReferrerBalance, "Referrer should receive reward");
        assert.isTrue(postTier2Balance > preTier2Balance, "Tier 2 Referrer should receive reward");
    });
});
