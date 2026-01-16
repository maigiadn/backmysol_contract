import * as anchor from "@coral-xyz/anchor";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync, createMint, mintTo, transfer } from "@solana/spl-token";
import { Keypair, SystemProgram, Transaction, PublicKey } from "@solana/web3.js";

describe("create_trash", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;

    it("Create 3 Empty Token Accounts (Trash)", async () => {
        console.log("Đang tạo rác cho ví:", wallet.publicKey.toString());

        for (let i = 0; i < 3; i++) {
            // 1. Tạo một Token mới (Mint) tạm thời
            const mintKeypair = Keypair.generate();
            const lamports = await provider.connection.getMinimumBalanceForRentExemption(82);

            const createMintIx = SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: mintKeypair.publicKey,
                space: 82,
                lamports,
                programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            });

            // 2. Tạo Token Account cho ví của bạn (ATA)
            const ata = getAssociatedTokenAddressSync(
                mintKeypair.publicKey,
                wallet.publicKey
            );

            const createAtaIx = createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                ata,
                wallet.publicKey,
                mintKeypair.publicKey
            );

            // Gửi transaction (Mint account rỗng được tạo ra nhưng Balance = 0)
            // Đây chính là "Rác" vì nó chiếm dụng SOL Rent (~0.002 SOL)
            const tx = new Transaction().add(createMintIx, createAtaIx);
            await provider.sendAndConfirm(tx, [mintKeypair]);

            console.log(`Đã tạo tài khoản rác ${i + 1}: ${ata.toString()}`);
        }
        console.log("✅ Xong! Ví của bạn giờ đã có rác để dọn.");
    });
});