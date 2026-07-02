import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { BackmysolContract } from "../target/types/backmysol_contract";
import {
    createMint,
    createInitializeAccountInstruction,
    TOKEN_PROGRAM_ID,
    ACCOUNT_SIZE,
} from "@solana/spl-token";
import { Keypair, SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";

// Chạy riêng file này trên localnet:
//   yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/backer_guilds.ts
// (lưu ý: tests/backmysol.ts đang dùng describe.only nên chạy cả thư mục sẽ bỏ qua file này)

const SEED_GAME_CONFIG = "game_config_v1";
const SEED_CHAMPION = "champion";
const SEED_BACKING = "backing";
const SEED_SEASON_VAULT = "season_vault";
const SEED_REFERRAL = "referral";

// Curve: giá suất thứ n = n^2 * 1e9 / 16000 lamports
const CURVE_DIVISOR = 16_000;
const sumSquares = (n: number) => (n * (n + 1) * (2 * n + 1)) / 6;
const curveCost = (supply: number, amount: number) =>
    Math.floor(((sumSquares(supply + amount) - sumSquares(supply)) * 1_000_000_000) / CURVE_DIVISOR);
const bps = (value: number, b: number) => Math.floor((value * b) / 10_000);

describe("backer_guilds", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;
    const admin = provider.wallet;

    const champion = Keypair.generate();
    const backer = Keypair.generate();
    const backer2 = Keypair.generate();
    const refWallet = Keypair.generate();

    const [gameConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(SEED_GAME_CONFIG)],
        program.programId
    );
    const [championProfilePda] = PublicKey.findProgramAddressSync(
        [Buffer.from(SEED_CHAMPION), champion.publicKey.toBuffer()],
        program.programId
    );
    const positionPda = (backerKey: PublicKey) =>
        PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_BACKING), champion.publicKey.toBuffer(), backerKey.toBuffer()],
            program.programId
        )[0];
    const seasonVaultPda = (seasonId: number) => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(seasonId);
        return PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_SEASON_VAULT), buf],
            program.programId
        )[0];
    };
    const referralStatePda = (wallet: PublicKey) =>
        PublicKey.findProgramAddressSync(
            [Buffer.from(SEED_REFERRAL), wallet.toBuffer()],
            program.programId
        )[0];

    const fund = async (pubkey: PublicKey, sol: number) => {
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: provider.wallet.publicKey,
                toPubkey: pubkey,
                lamports: Math.floor(sol * LAMPORTS_PER_SOL),
            })
        );
        await provider.sendAndConfirm(tx);
    };

    const balance = (pubkey: PublicKey) => provider.connection.getBalance(pubkey);

    before(async () => {
        await fund(champion.publicKey, 0.2);
        await fund(backer.publicKey, 0.2);
        await fund(backer2.publicKey, 0.2);
        await fund(refWallet.publicKey, 0.05);
    });

    it("1. Khởi tạo GlobalConfig + GameConfig", async () => {
        try {
            await program.methods.initialize(null)
                .accounts({ admin: admin.publicKey })
                .rpc();
        } catch (e) {
            console.log("GlobalConfig có thể đã tồn tại — bỏ qua");
        }

        try {
            await program.methods.initializeGame()
                .accounts({ admin: admin.publicKey })
                .rpc();
        } catch (e) {
            console.log("GameConfig có thể đã tồn tại — bỏ qua");
        }

        const gc = await program.account.gameConfig.fetch(gameConfigPda);
        assert.equal(gc.buyFeeBps, 500);
        assert.equal(gc.sellFeeBps, 700);
        assert.equal(gc.championShareBps, 5000);
        assert.equal(gc.poolShareBps, 2000);
        assert.equal(gc.seasonId, 1);
        assert.isFalse(gc.paused);
    });

    it("2. Đăng ký Champion với mã tên", async () => {
        await program.methods.registerChampion("CHAMP1")
            .accounts({ user: champion.publicKey })
            .signers([champion])
            .rpc();

        const profile = await program.account.championProfile.fetch(championProfilePda);
        assert.equal(profile.wallet.toBase58(), champion.publicKey.toBase58());
        assert.equal(profile.sharesOutstanding.toNumber(), 0);
        assert.equal(profile.seasonId, 1);
    });

    it("3. Mua 10 suất — kiểm tra giá curve và chia phí 4 phần", async () => {
        const cost = curveCost(0, 10);          // 385 * 62500 = 24_062_500
        const fee = bps(cost, 500);              // 1_203_125
        const championAmt = bps(fee, 5000);      // 601_562
        const poolAmt = bps(fee, 2000);          // 240_625
        // backer chưa có referral -> phần ref1+ref2 dồn về treasury
        const treasuryAmt = fee - championAmt - poolAmt; // 360_938

        const preVault = await balance(championProfilePda);
        const preChampion = await balance(champion.publicKey);
        const prePool = await balance(seasonVaultPda(1));
        const preTreasury = await balance(admin.publicKey);

        await program.methods.buyBacking(new BN(10))
            .accounts({
                backer: backer.publicKey,
                championProfile: championProfilePda,
                championWallet: champion.publicKey,
                seasonVault: seasonVaultPda(1),
                // @ts-ignore — optional accounts
                referralState: null,
                referrerWallet: null,
                tier2ReferrerWallet: null,
                treasury: admin.publicKey,
                position: positionPda(backer.publicKey),
            })
            .signers([backer])
            .rpc();

        assert.equal(await balance(championProfilePda) - preVault, cost, "Vốn phải vào két Champion");
        assert.equal(await balance(champion.publicKey) - preChampion, championAmt, "Champion nhận 50% phí");
        assert.equal(await balance(seasonVaultPda(1)) - prePool, poolAmt, "Quỹ mùa nhận 20% phí");
        assert.equal(await balance(admin.publicKey) - preTreasury, treasuryAmt, "Treasury nhận phần còn lại");

        const profile = await program.account.championProfile.fetch(championProfilePda);
        assert.equal(profile.sharesOutstanding.toNumber(), 10);
        assert.equal(profile.seasonVolume.toNumber(), cost);

        const pos = await program.account.backingPosition.fetch(positionPda(backer.publicKey));
        assert.equal(pos.shares.toNumber(), 10);
    });

    it("4. Champion không được tự back chính mình", async () => {
        try {
            await program.methods.buyBacking(new BN(1))
                .accounts({
                    backer: champion.publicKey,
                    championProfile: championProfilePda,
                    championWallet: champion.publicKey,
                    seasonVault: seasonVaultPda(1),
                    // @ts-ignore
                    referralState: null,
                    referrerWallet: null,
                    tier2ReferrerWallet: null,
                    treasury: admin.publicKey,
                    position: positionPda(champion.publicKey),
                })
                .signers([champion])
                .rpc();
            assert.fail("Phải bị chặn SelfBacking");
        } catch (e: any) {
            assert.include(e.toString(), "SelfBacking");
        }
    });

    it("5. Bán trong thời gian khóa 24h phải bị chặn", async () => {
        try {
            await program.methods.sellBacking(new BN(1))
                .accounts({
                    backer: backer.publicKey,
                    championProfile: championProfilePda,
                    championWallet: champion.publicKey,
                    seasonVault: seasonVaultPda(1),
                    // @ts-ignore
                    referralState: null,
                    referrerWallet: null,
                    tier2ReferrerWallet: null,
                    treasury: admin.publicKey,
                    position: positionPda(backer.publicKey),
                })
                .signers([backer])
                .rpc();
            assert.fail("Phải bị chặn SharesLocked");
        } catch (e: any) {
            assert.include(e.toString(), "SharesLocked");
        }
    });

    it("6. Admin mở khóa (lock=0) rồi bán 4 suất — tiền về đúng công thức", async () => {
        await program.methods.updateGameConfig(500, 700, 5000, 2000, 1000, 500, new BN(CURVE_DIVISOR), new BN(0), 1, false)
            .accounts({ admin: admin.publicKey })
            .rpc();

        const proceeds = curveCost(6, 4);       // (385-91) * 62500 = 18_375_000
        const fee = bps(proceeds, 700);          // 1_286_250
        const sellerAmt = proceeds - fee;        // 17_088_750
        const championAmt = bps(fee, 5000);      // 643_125
        const poolAmt = bps(fee, 2000);          // 257_250

        const preVault = await balance(championProfilePda);
        const preBacker = await balance(backer.publicKey);
        const preChampion = await balance(champion.publicKey);
        const prePool = await balance(seasonVaultPda(1));

        await program.methods.sellBacking(new BN(4))
            .accounts({
                backer: backer.publicKey,
                championProfile: championProfilePda,
                championWallet: champion.publicKey,
                seasonVault: seasonVaultPda(1),
                // @ts-ignore
                referralState: null,
                referrerWallet: null,
                tier2ReferrerWallet: null,
                treasury: admin.publicKey,
                position: positionPda(backer.publicKey),
            })
            .signers([backer])
            .rpc();

        assert.equal(preVault - await balance(championProfilePda), proceeds, "Két phải chi đúng proceeds");
        // backer trả phí giao dịch mạng nên so sánh có dung sai nhỏ
        const backerDiff = await balance(backer.publicKey) - preBacker;
        assert.isAtLeast(backerDiff, sellerAmt - 10_000, "Backer phải nhận proceeds - fee");
        assert.isAtMost(backerDiff, sellerAmt);
        assert.equal(await balance(champion.publicKey) - preChampion, championAmt);
        assert.equal(await balance(seasonVaultPda(1)) - prePool, poolAmt);

        const profile = await program.account.championProfile.fetch(championProfilePda);
        assert.equal(profile.sharesOutstanding.toNumber(), 6);
        const pos = await program.account.backingPosition.fetch(positionPda(backer.publicKey));
        assert.equal(pos.shares.toNumber(), 6);
    });

    it("7. Backer có referral on-chain: F1 nhận 10% phí khi mua", async () => {
        // backer2 đăng ký partner với refWallet là người giới thiệu.
        // Lưu ý: register_partner chỉ ghi nhận referrer khi được truyền kèm
        // PDA ReferralState của upline (dù account chưa được khởi tạo).
        await program.methods.registerPartner("B2CODE", refWallet.publicKey)
            .accounts({
                user: backer2.publicKey,
                // @ts-ignore
                uplineReferrerState: referralStatePda(refWallet.publicKey),
            })
            .signers([backer2])
            .rpc();

        const cost = curveCost(6, 5);            // (506-91) * 62500 = 25_937_500
        const fee = bps(cost, 500);               // 1_296_875
        const ref1Amt = bps(fee, 1000);           // 129_687

        const preRef = await balance(refWallet.publicKey);

        await program.methods.buyBacking(new BN(5))
            .accounts({
                backer: backer2.publicKey,
                championProfile: championProfilePda,
                championWallet: champion.publicKey,
                seasonVault: seasonVaultPda(1),
                referralState: referralStatePda(backer2.publicKey),
                referrerWallet: refWallet.publicKey,
                // @ts-ignore
                tier2ReferrerWallet: null,
                treasury: admin.publicKey,
                position: positionPda(backer2.publicKey),
            })
            .signers([backer2])
            .rpc();

        assert.equal(await balance(refWallet.publicKey) - preRef, ref1Amt, "F1 phải nhận 10% phí");
        const profile = await program.account.championProfile.fetch(championProfilePda);
        assert.equal(profile.sharesOutstanding.toNumber(), 11);
    });
});

describe("clean_and_distribute — vá lỗ hổng fallback referrer", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.BackmysolContract as Program<BackmysolContract>;
    const admin = provider.wallet;

    const freshUser = Keypair.generate();      // chưa có ReferralState
    const fakeReferrer = Keypair.generate();   // ví phụ, KHÔNG đăng ký partner
    const realReferrer = Keypair.generate();   // sẽ đăng ký partner

    const referralStatePda = (wallet: PublicKey) =>
        PublicKey.findProgramAddressSync(
            [Buffer.from("referral"), wallet.toBuffer()],
            program.programId
        )[0];

    const fund = async (pubkey: PublicKey, sol: number) => {
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: provider.wallet.publicKey,
                toPubkey: pubkey,
                lamports: Math.floor(sol * LAMPORTS_PER_SOL),
            })
        );
        await provider.sendAndConfirm(tx);
    };

    const createTrash = async (owner: Keypair): Promise<PublicKey> => {
        const mint = await createMint(provider.connection, owner, owner.publicKey, null, 9);
        const trashKeypair = Keypair.generate();
        const lamports = await provider.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
        const tx = new Transaction().add(
            SystemProgram.createAccount({
                fromPubkey: owner.publicKey,
                newAccountPubkey: trashKeypair.publicKey,
                space: ACCOUNT_SIZE,
                lamports,
                programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeAccountInstruction(trashKeypair.publicKey, mint, owner.publicKey)
        );
        await provider.sendAndConfirm(tx, [owner, trashKeypair]);
        return trashKeypair.publicKey;
    };

    before(async () => {
        await fund(freshUser.publicKey, 0.2);
        await fund(realReferrer.publicKey, 0.05);
        try {
            await program.methods.initialize(null)
                .accounts({ admin: admin.publicKey })
                .rpc();
        } catch (e) { /* đã tồn tại */ }
    });

    it("Ví giới thiệu CHƯA đăng ký -> không được trả hoa hồng (chặn ví phụ né phí)", async () => {
        const trash = await createTrash(freshUser);
        const preFake = await provider.connection.getBalance(fakeReferrer.publicKey);

        await program.methods.cleanAndDistribute()
            .accounts({
                user: freshUser.publicKey,
                // @ts-ignore — optional accounts
                referralState: null,
                referrerWallet: fakeReferrer.publicKey,
                tier2ReferrerWallet: null,
                fallbackReferrerState: null,
                treasury: admin.publicKey,
            })
            .remainingAccounts([{ pubkey: trash, isWritable: true, isSigner: false }])
            .signers([freshUser])
            .rpc();

        const postFake = await provider.connection.getBalance(fakeReferrer.publicKey);
        assert.equal(postFake - preFake, 0, "Ví chưa đăng ký không được nhận hoa hồng");
    });

    it("Ví giới thiệu ĐÃ đăng ký + kèm ReferralState -> nhận tier1 bình thường", async () => {
        await program.methods.registerPartner("REALREF", null)
            .accounts({
                user: realReferrer.publicKey,
                // @ts-ignore
                uplineReferrerState: null,
            })
            .signers([realReferrer])
            .rpc();

        const trash = await createTrash(freshUser);
        const rentReclaimed = await provider.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
        const grossFee = Math.floor((rentReclaimed * 2000) / 10_000);
        const tier1Amt = Math.floor((grossFee * 5000) / 10_000);

        const preReal = await provider.connection.getBalance(realReferrer.publicKey);

        await program.methods.cleanAndDistribute()
            .accounts({
                user: freshUser.publicKey,
                // @ts-ignore
                referralState: null,
                referrerWallet: realReferrer.publicKey,
                tier2ReferrerWallet: null,
                fallbackReferrerState: referralStatePda(realReferrer.publicKey),
                treasury: admin.publicKey,
            })
            .remainingAccounts([{ pubkey: trash, isWritable: true, isSigner: false }])
            .signers([freshUser])
            .rpc();

        const postReal = await provider.connection.getBalance(realReferrer.publicKey);
        assert.equal(postReal - preReal, tier1Amt, "Referrer đã đăng ký phải nhận 50% phí");
    });
});
