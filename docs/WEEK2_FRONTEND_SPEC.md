# Tuần 2 — Spec cụ thể cho Claude trên VS Code (repo `app_backmysol`)

> Đọc kèm `docs/FRONTEND_INDEXER_PLAN.md` (kiến trúc tổng thể) trước khi làm. File này
> chỉ đặc tả phần việc Tuần 2 theo lộ trình đã chốt ở mục 6: **kết nối ví + trang
> `/[code]` mua/bán chạy được trên devnet + trang `/register`**. Nghiệm thu: mua/bán
> suất từ UI thành công trên devnet, số dư khớp công thức curve.

**Phạm vi Tuần 2 KHÔNG bao gồm** (để dành Tuần 3 theo đúng roadmap): luồng referral
`?ref=`, `/leaderboard`, `/me`, biểu đồ curve trực quan. Ở bước mua/bán, account
`referral_state`/`referrer_wallet`/`tier2_referrer_wallet` **truyền `null` cố định**
— để lại `// TODO tuần 3: luồng referral`.

Trước khi code, xác nhận lại cấu trúc thực tế mà Tuần 1 đã dựng (`packages/shared`,
`apps/indexer` migrations, IDL đã sync chưa) — nếu khác với mô tả dưới đây thì bám
theo cấu trúc thật của repo, không ép theo tài liệu này.

## 1. Env & cấu hình RPC (làm trước tiên)

Program id: `CjjskajkSeYgfQxx88wcaLvPSe3RmGgbpzkHpnQevyB6`. Cluster: devnet.

`.env.local` (KHÔNG commit, đã gitignore theo Next.js mặc định):
```
NEXT_PUBLIC_CLUSTER=devnet
NEXT_PUBLIC_RPC_URL=https://devnet.helius-rpc.com/?api-key=<KEY_FRONTEND>
NEXT_PUBLIC_PROGRAM_ID=CjjskajkSeYgfQxx88wcaLvPSe3RmGgbpzkHpnQevyB6
```

**Lưu ý bảo mật quan trọng**: biến `NEXT_PUBLIC_*` bị nhúng thẳng vào bundle client —
ai mở DevTools cũng thấy được key trong URL. Đây chính xác là lý do thiết kế ban đầu
tách 2 API key Helius: **chỉ dùng key đã bật domain whitelist** (giới hạn origin
`app.backmysol.io` + `localhost` lúc dev) cho biến này. Key còn lại (không giới hạn)
để riêng cho indexer, không bao giờ đưa vào biến `NEXT_PUBLIC_*`.

## 2. Wallet & Anchor provider

- `@solana/wallet-adapter-react` + `wallet-adapter-react-ui` + `wallet-adapter-wallets`
  (Phantom, Solflare tối thiểu).
- Component gốc `apps/web/app/providers.tsx`: bọc `ConnectionProvider` (endpoint =
  `NEXT_PUBLIC_RPC_URL`) → `WalletProvider` → `WalletModalProvider` → children.
- Helper `apps/web/lib/anchor.ts`: hook `useAnchorProgram()` dựng
  `AnchorProvider(connection, wallet, {})` rồi `new Program(idl, provider)` — IDL lấy
  từ `packages/shared` (đã sync ở Tuần 1 từ `target/idl/backmysol_contract.json` của
  repo contract).
- Nút "Connect Wallet" ở header dùng `WalletMultiButton` có sẵn của wallet-adapter-ui.

## 3. `packages/shared` — bổ sung nếu Tuần 1 chưa có đủ

Kiểm tra các hàm sau đã tồn tại chưa, thiếu thì viết thêm (port 1:1 từ
`programs/backmysol_contract/src/lib.rs` bên repo contract, dùng `bigint` thay `u128`):

```ts
// packages/shared/src/curve.ts
export function sumOfSquares(n: bigint): bigint { ... }          // n(n+1)(2n+1)/6
export function curveCost(supply: bigint, amount: bigint, divisor: bigint): bigint { ... }
export function bpsAmount(value: bigint, bps: number): bigint { ... }

// packages/shared/src/pda.ts (programId truyền vào, không hardcode)
export function gameConfigPda(programId): [PublicKey, number]
export function globalConfigPda(programId): [PublicKey, number]          // seeds ["config_v1"]
export function championProfilePda(programId, champion: PublicKey)
export function championCodePda(programId, code: string)                 // seeds ["code", code] — dùng chung ReferralCodeMapping
export function backingPositionPda(programId, champion: PublicKey, backer: PublicKey)
export function seasonVaultPda(programId, seasonId: number)              // seeds ["season_vault", u32LE(seasonId)]
export function referralStatePda(programId, wallet: PublicKey)           // seeds ["referral", wallet]
```

**Đối chiếu bắt buộc** khi viết `curveCost`/`bpsAmount`: phải khớp chính xác
`curve_cost()`/`bps_amount()` trong `lib.rs` — dùng `tests/backer_guilds.ts` (hàm
`curveCost`/`bps` ở đầu file) bên repo contract làm bảng đối chứng, không suy diễn lại.

## 4. Trang `/register`

`apps/web/app/register/page.tsx`:

1. Input text, validate client-side: 1–10 ký tự (khớp `ErrorCode::InvalidCodeLength`).
2. Nút "Kiểm tra" → `connection.getAccountInfo(championCodePda(programId, code))`;
   nếu account đã tồn tại → báo "Mã đã có người đăng ký", disable nút đăng ký.
3. Nút "Đăng ký làm Champion" (disable nếu chưa connect ví):
   ```ts
   await program.methods.registerChampion(code)
     .accounts({ user: wallet.publicKey! })
     .rpc();
   ```
   Anchor tự resolve `championProfile`, `championCode`, `gameConfig`, `systemProgram`
   qua seeds — không cần truyền tay nếu IDL có đủ seeds trong metadata (kiểm tra bằng
   cách thử trước; nếu Anchor không tự resolve được thì truyền tường minh theo PDA
   helper mục 3).
4. Thành công → `router.push(`/${code}`)`.
5. Bắt lỗi runtime cụ thể: hiển thị message thân thiện cho `InvalidCodeLength`,
   ví chưa đủ SOL trả rent (~0.003 SOL), lỗi mạng chung.

## 5. Trang `/[code]`

`apps/web/app/[code]/page.tsx` — Server Component fetch dữ liệu tĩnh (mô tả OG nếu có),
phần tương tác trong Client Component con `<BackingPanel code={code} />`.

### 5.1. Đọc dữ liệu on-chain (không qua indexer — mọi số dùng để ký phải on-chain)

Thứ tự fetch:
1. `championCodePda(programId, code)` → account `ReferralCodeMapping` → field `owner`
   (= ví Champion). Không tồn tại → hiện trang "Champion chưa tồn tại" + link `/register`.
2. `championProfilePda(programId, owner)` → `ChampionProfile` (`sharesOutstanding`,
   `seasonId`, `seasonVolume`).
3. `gameConfigPda(programId)` → `GameConfig` (`buyFeeBps`, `sellFeeBps`,
   `championShareBps`, `poolShareBps`, `ref1ShareBps`, `ref2ShareBps`, `curveDivisor`,
   `lockSeconds`, `seasonId`, `paused`).
4. `globalConfigPda(programId)` → `GlobalConfig.admin` (= treasury, bắt buộc phải
   đúng địa chỉ này theo `address` constraint trong contract).
5. Nếu ví đã connect: `backingPositionPda(programId, owner, wallet.publicKey)` —
   account có thể chưa tồn tại (backer chưa từng mua) → xử lý null, hiển thị 0 suất.

Dùng TanStack Query, `refetchInterval` ngắn (5–10s) hoặc refetch thủ công sau mỗi tx
thành công — KHÔNG cache lâu vì giá phụ thuộc `sharesOutstanding` thay đổi liên tục.

### 5.2. Hiển thị giá & preview

- Giá suất tiếp theo (n = `sharesOutstanding + 1`): dùng `curveCost(sharesOutstanding, 1n, curveDivisor)`.
- Input số lượng suất muốn mua/bán → preview trực tiếp bằng `curveCost`:
  - Mua: `cost = curveCost(supply, amount, divisor)`, `fee = bpsAmount(cost, buyFeeBps)`,
    tổng phải trả = `cost + fee`. Hiện rõ fee đi đâu: Champion/quỹ mùa/treasury
    (referral = 0 vì null ở Tuần 2, ghi chú "Chưa áp dụng — ra mắt Tuần 3").
  - Bán: `proceeds = curveCost(supply - amount, amount, divisor)` (yêu cầu
    `amount <= sharesOutstanding` và `amount <= vị thế đang giữ`),
    `fee = bpsAmount(proceeds, sellFeeBps)`, nhận về = `proceeds - fee`.
- Cảnh báo trượt giá: giá thật tính theo `supply` tại lúc lệnh khớp trên chain, có thể
  khác preview nếu người khác giao dịch trước — hiện dòng chú thích, KHÔNG cần
  slippage tolerance on-chain ở Tuần 2 (contract chưa hỗ trợ tham số này).

### 5.3. Nút Mua (`buy_backing`)

```ts
await program.methods.buyBacking(new BN(amount))
  .accounts({
    backer: wallet.publicKey!,
    championProfile: championProfilePda,
    championWallet: owner,
    seasonVault: seasonVaultPda(programId, gameConfig.seasonId),
    referralState: null,        // TODO tuần 3: luồng referral
    referrerWallet: null,       // TODO tuần 3
    tier2ReferrerWallet: null,  // TODO tuần 3
    treasury: globalConfig.admin,
    position: backingPositionPda(programId, owner, wallet.publicKey!),
  })
  .rpc();
```
Chặn phía UI trước khi gửi tx (khớp `require!` trong contract, để lỗi rõ ràng hơn
thông báo runtime chung chung):
- `owner === wallet.publicKey` → chặn, hiện "Champion không thể tự back chính mình".
- `gameConfig.paused === true` → disable toàn bộ nút mua/bán, hiện banner tạm dừng.

### 5.4. Nút Bán (`sell_backing`)

```ts
await program.methods.sellBacking(new BN(amount))
  .accounts({
    backer: wallet.publicKey!,
    championProfile: championProfilePda,
    championWallet: owner,
    seasonVault: seasonVaultPda(programId, gameConfig.seasonId),
    referralState: null,        // TODO tuần 3
    referrerWallet: null,
    tier2ReferrerWallet: null,
    treasury: globalConfig.admin,
    position: backingPositionPda(programId, owner, wallet.publicKey!),
  })
  .rpc();
```
Chặn phía UI trước khi gửi tx:
- `amount > position.shares` → disable, hiện "Vượt quá số suất đang giữ".
- Khóa bán: `now < position.lastBuyTs + gameConfig.lockSeconds` → disable nút bán,
  hiện countdown còn lại (đồng hồ đếm ngược đơn giản, không cần realtime chính xác).

### 5.5. Sau khi tx thành công (cả 2 nút)

- Toast xác nhận + link explorer devnet (`https://explorer.solana.com/tx/<sig>?cluster=devnet`).
- Invalidate/refetch toàn bộ query on-chain ở mục 5.1 (supply, position, số dư ví đổi).

## 6. Test thủ công trên devnet (checklist nghiệm thu Tuần 2)

Tái dùng đúng luồng của `tests/devnet_smoke.ts` bên repo contract nhưng thao tác bằng
tay qua UI, dùng ví Phantom devnet:

- [ ] `/register` với mã mới → tx thành công → tự chuyển sang `/<code>`.
- [ ] `/register` lại đúng mã đó bằng ví khác → bị chặn "mã đã có người đăng ký".
- [ ] `/<code>` hiển thị đúng giá suất kế tiếp khớp `curveCost(0, 1, 16000)`.
- [ ] Mua 3 suất bằng ví backer khác ví Champion → tx thành công, `sharesOutstanding`
      trên UI tăng đúng +3, số dư ví backer giảm đúng `cost + fee`.
- [ ] Thử bán ngay sau khi mua → nút bán bị disable, hiện countdown ~24h.
- [ ] Thử mua bằng chính ví Champion → bị chặn ở UI trước khi gửi tx.
- [ ] (Chỉ để verify, không phải luồng người dùng) admin hạ `lock_seconds=0` qua
      script/CLI có sẵn từ repo contract → nút bán trên UI mở lại → bán thành công,
      số dư nhận về khớp `curveCost(supply-amount, amount, divisor) - fee`.
- [ ] Tắt ví (disconnect) → trang `/<code>` vẫn xem được giá, nhưng nút mua/bán ẩn/disable
      với CTA "Kết nối ví để giao dịch".

## 7. Ngoài phạm vi — để lại TODO rõ ràng trong code, không tự ý mở rộng

- Referral (`?ref=`), `/leaderboard`, `/me` → Tuần 3.
- Biểu đồ curve trực quan (chart) → có thể làm bản tối giản (bảng giá 5 suất kế tiếp)
  nếu còn dư thời gian, nhưng không bắt buộc nghiệm thu Tuần 2.
- Toàn bộ dữ liệu từ indexer (`/api/*`) → chưa dùng ở trang `/<code>` trong Tuần 2
  (trang này 100% đọc on-chain); indexer sẽ được dùng bắt đầu từ `/leaderboard` Tuần 3.
