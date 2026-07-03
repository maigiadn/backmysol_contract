import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";
import { Keypair, SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";

// ============================================================
// SMOKE TEST DEVNET — chạy THỦ CÔNG, không nằm trong anchor test
//
// Yêu cầu: GameConfig đã initialize_game trên devnet, ví provider
// là admin (GlobalConfig.admin) và có >= 0.05 SOL devnet.
//
// Chạy trên máy có anchor (sau khi anchor build để có target/types):
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/id.json \
//   yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/devnet_smoke.ts
//
// Luồng: register_champion -> buy_backing(3) -> hạ lock=0 ->
// sell_backing(1) -> khôi phục lock cũ. In số dư từng bước.
// Tiêu tốn ~0.01 SOL devnet (fund 2 ví test + phí giao dịch).
// ============================================================

const url = process.env.ANCHOR_PROVIDER_URL ?? "";
if (!url.includes("devnet")) {
    throw new Error(
        `Smoke test chỉ chạy trên DEVNET. ANCHOR_PROVIDER_URL hiện tại: "${url}". ` +
        `Đặt ANCHOR_PROVIDER_URL=https://api.devnet.solana.com rồi chạy lại.`
    );
}

describe("devnet_smoke — Backer Guilds end-to-end", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;
    const admin = provider.wallet;

    // Champion/backer mới toanh mỗi lần chạy -> curve bắt đầu từ supply 0,
    // code ngẫu nhiên để không đụng mã đã chiếm trên devnet (tối đa 10 ký tự)
    const champion = Keypair.generate();
    const backer = Keypair.generate();
    const code = ("SMK" + Date.now().toString(36).toUpperCase()).slice(0, 10);

    const [gameConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("game_config_v1")], program.programId);
    const [championProfilePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("champion"), champion.publicKey.toBuffer()], program.programId);
    const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backing"), champion.publicKey.toBuffer(), backer.publicKey.toBuffer()],
        program.programId);
    const seasonVaultPda = (seasonId: number) => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(seasonId);
        return PublicKey.findProgramAddressSync(
            [Buffer.from("season_vault"), buf], program.programId)[0];
    };

    const balance = (p: PublicKey) => provider.connection.getBalance(p);
    const fmt = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(6) + " SOL";

    let gc: any;               // GameConfig hiện tại trên devnet
    let seasonVault: PublicKey;
    let prevLockSeconds: BN;   // để khôi phục sau khi test bán

    const logBalances = async (label: string) => {
        console.log(`--- ${label} ---`);
        console.log("  Két Champion (profile):", fmt(await balance(championProfilePda)));
        console.log("  Ví Champion:           ", fmt(await balance(champion.publicKey)));
        console.log("  Season vault:          ", fmt(await balance(seasonVault)));
        console.log("  Treasury (admin):      ", fmt(await balance(admin.publicKey)));
        console.log("  Backer:                ", fmt(await balance(backer.publicKey)));
    };

    before(async () => {
        gc = await program.account.gameConfig.fetch(gameConfigPda);
        seasonVault = seasonVaultPda(gc.seasonId);
        prevLockSeconds = gc.lockSeconds;
        console.log("GameConfig devnet: season", gc.seasonId,
            "| phí mua/bán:", gc.buyFeeBps, "/", gc.sellFeeBps, "bps",
            "| lock:", gc.lockSeconds.toString(), "s",
            "| paused:", gc.paused);

        // Fund 2 ví test từ ví admin
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: admin.publicKey,
                toPubkey: champion.publicKey,
                lamports: 0.01 * LAMPORTS_PER_SOL,
            }),
            SystemProgram.transfer({
                fromPubkey: admin.publicKey,
                toPubkey: backer.publicKey,
                lamports: 0.01 * LAMPORTS_PER_SOL,
            }),
        );
        await provider.sendAndConfirm(tx);
    });

    it("1. register_champion với mã " , async () => {
        const sig = await program.methods.registerChampion(code)
            .accounts({ user: champion.publicKey })
            .signers([champion])
            .rpc();
        console.log(`Champion đăng ký mã "${code}" — tx:`, sig);

        const profile = await program.account.championProfile.fetch(championProfilePda);
        assert.equal(profile.wallet.toBase58(), champion.publicKey.toBase58());
        assert.equal(profile.sharesOutstanding.toNumber(), 0);
    });

    it("2. buy_backing 3 suất", async () => {
        await logBalances("Trước khi mua");
        const sig = await program.methods.buyBacking(new BN(3))
            .accounts({
                backer: backer.publicKey,
                championProfile: championProfilePda,
                championWallet: champion.publicKey,
                seasonVault,
                // @ts-ignore — optional accounts
                referralState: null,
                referrerWallet: null,
                tier2ReferrerWallet: null,
                treasury: admin.publicKey,
                position: positionPda,
            })
            .signers([backer])
            .rpc();
        console.log("Mua 3 suất — tx:", sig);
        await logBalances("Sau khi mua");

        const profile = await program.account.championProfile.fetch(championProfilePda);
        assert.equal(profile.sharesOutstanding.toNumber(), 3);
        const pos = await program.account.backingPosition.fetch(positionPda);
        assert.equal(pos.shares.toNumber(), 3);
    });

    it("3. hạ lock=0, bán 1 suất, khôi phục lock", async () => {
        await program.methods.updateGameConfig(
            gc.buyFeeBps, gc.sellFeeBps,
            gc.championShareBps, gc.poolShareBps, gc.ref1ShareBps, gc.ref2ShareBps,
            gc.curveDivisor, new BN(0), gc.seasonId, gc.paused
        ).accounts({ seasonVault, admin: admin.publicKey }).rpc();
        console.log("Đã hạ lock_seconds = 0 (tạm)");

        try {
            const sig = await program.methods.sellBacking(new BN(1))
                .accounts({
                    backer: backer.publicKey,
                    championProfile: championProfilePda,
                    championWallet: champion.publicKey,
                    seasonVault,
                    // @ts-ignore
                    referralState: null,
                    referrerWallet: null,
                    tier2ReferrerWallet: null,
                    treasury: admin.publicKey,
                    position: positionPda,
                })
                .signers([backer])
                .rpc();
            console.log("Bán 1 suất — tx:", sig);
        } finally {
            // Dù bán lỗi vẫn phải trả lock về giá trị cũ
            await program.methods.updateGameConfig(
                gc.buyFeeBps, gc.sellFeeBps,
                gc.championShareBps, gc.poolShareBps, gc.ref1ShareBps, gc.ref2ShareBps,
                gc.curveDivisor, prevLockSeconds, gc.seasonId, gc.paused
            ).accounts({ seasonVault, admin: admin.publicKey }).rpc();
            console.log("Đã khôi phục lock_seconds =", prevLockSeconds.toString());
        }
        await logBalances("Sau khi bán");

        const profile = await program.account.championProfile.fetch(championProfilePda);
        assert.equal(profile.sharesOutstanding.toNumber(), 2);
        const pos = await program.account.backingPosition.fetch(positionPda);
        assert.equal(pos.shares.toNumber(), 2);
        console.log("✅ Smoke test devnet hoàn tất — luồng register/buy/sell chạy tốt");
    });
});
