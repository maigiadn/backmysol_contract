# CLAUDE.md — Ngữ cảnh dự án BackMySol

File này bàn giao ngữ cảnh cho Claude khi làm việc với repo. Đọc kèm `docs/GAME_CONCEPT.md`
trước khi sửa contract. Giao tiếp với chủ dự án bằng **tiếng Việt**; comment trong code
viết tiếng Việt theo phong cách sẵn có.

## 1. Dự án là gì

**BackMySol** (https://backmysol.io) — Anchor program trên Solana **mainnet**,
program id `CjjskajkSeYgfQxx88wcaLvPSe3RmGgbpzkHpnQevyB6`.

Hai mảng trong cùng một program (`programs/backmysol_contract/src/lib.rs`):

1. **Dịch vụ gốc — dọn ví**: user đóng các token account rỗng để hoàn SOL rent
   (`clean_and_distribute`), platform thu phí 20%, hoa hồng giới thiệu 2 tầng
   (F1 50% phí, F2 25% phí). Đang chạy thật trên mainnet.
2. **Game "Backer Guilds" (đang xây, Giai đoạn 1 đã code xong)**: SocialFi —
   backer mua "suất backing" của Champion (KOL/trader) theo bonding curve,
   phí giao dịch chia 4 phần, hướng tới guild + mùa giải chia thưởng SOL.
   Toàn bộ thiết kế, kinh tế, lộ trình 3 giai đoạn: xem `docs/GAME_CONCEPT.md`.

Quyết định thiết kế đã chốt với chủ dự án: **không phát hành token**, thưởng bằng SOL
từ doanh thu phí thật; **v1 không chia PnL trading** của Champion cho backer (rủi ro
pháp lý chứng khoán); pet/NFT chưa làm ở giai đoạn này.

## 2. Trạng thái hiện tại (branch `claude/backmysol-solana-game-ideas-cj02x2`)

Đã xong trên branch này:
- `docs/GAME_CONCEPT.md` — tài liệu concept hoàn chỉnh (10 phần).
- Code Giai đoạn 1 trong `lib.rs`: 5 instruction mới `initialize_game`,
  `update_game_config`, `register_champion`, `buy_backing`, `sell_backing`.
- **Vá lỗ hổng bảo mật** trong `clean_and_distribute`: nhánh fallback trước đây trả
  50% phí cho ví bất kỳ do frontend truyền lên → user có thể dùng ví phụ tự nhận
  hoa hồng. Giờ chỉ trả khi ví giới thiệu có `ReferralState` on-chain đăng ký trước
  (account optional mới `fallback_referrer_state`). **Frontend hiện tại phải cập nhật
  theo** khi deploy bản này.
- `tests/backer_guilds.ts` — 9 test case (curve, chia phí, self-back, khóa bán,
  referral, 2 case cho bản vá). Compile đã pass (`cargo check`), **test chưa chạy** —
  việc kế tiếp là chạy trên localnet.

Việc kế tiếp theo thứ tự: chạy test localnet → deploy devnet → frontend + indexer
(đọc event `BackingBought`/`BackingSold`) → Giai đoạn 2 (SeasonPool, settle merkle,
guild) → **audit bắt buộc trước khi lên mainnet** (contract sẽ giữ SOL người chơi).

## 3. Kiến trúc contract

| PDA | Seeds | Vai trò |
|---|---|---|
| `GlobalConfig` | `["config_v1"]` | Config dịch vụ dọn ví + admin (đã tồn tại trên mainnet — KHÔNG đổi layout, sẽ vỡ account cũ) |
| `ReferralState` | `["referral", user]` | Hoa hồng 2 tầng, dùng chung cho cả dọn ví và game |
| `ReferralCodeMapping` | `["code", code]` | Mã giới thiệu / mã tên Champion (dùng chung không gian mã) |
| `GameConfig` | `["game_config_v1"]` | Config game — tách riêng khỏi GlobalConfig để né migration mainnet |
| `ChampionProfile` | `["champion", wallet]` | Hồ sơ Champion; **két SOL của curve nằm ngay trên account này** |
| `BackingPosition` | `["backing", champion, backer]` | Suất đang giữ + `last_buy_ts` cho khóa bán |
| Season vault | `["season_vault", season_id_le]` | PDA chỉ giữ lamports, quỹ mùa giải (chưa có data — Giai đoạn 2) |

Ràng buộc quan trọng (đừng phá khi refactor):
- **Curve đối xứng**: giá suất thứ n = `n² × 1 SOL / curve_divisor` (mặc định 16000).
  Mua và bán cùng dải suất dùng chung `curve_cost()` → két luôn đủ tiền hoàn trả.
  Khi bán vẫn check giữ lại rent-exempt cho `ChampionProfile`.
- **Chia phí game** (bps trong `GameConfig`, mặc định): phí mua 5% / bán 7%;
  phí chia: Champion 50%, season vault 20%, F1 10%, F2 5%, còn lại treasury.
  Phần referral không trả được (chưa đăng ký) dồn về treasury.
- **Hoa hồng game chỉ trả theo `ReferralState` on-chain của backer** — không có
  fallback nhận ví từ frontend như bên dọn ví.
- Chặn: Champion tự back mình (`SelfBacking`), bán trong `lock_seconds` sau lần mua
  gần nhất (`SharesLocked`, mặc định 24h), cờ `paused` dừng khẩn cấp.
- Treasury luôn là `GlobalConfig.admin` (address constraint).

## 4. Build & test

```bash
# Kiểm tra biên dịch nhanh (không cần anchor CLI)
cargo check -p backmysol_contract

# Chạy test game trên localnet — PHẢI sửa tạm Anchor.toml trước (xem mục 5):
anchor build
anchor test
```

Toolchain đã xác nhận trên máy chủ dự án (Mac): anchor-cli 0.32.1, solana-cli 3.0.13
(Agave), rustc 1.89.0, node 24, yarn 1.22, ví localnet `~/.config/solana/id.json`.

## 5. Cạm bẫy — đọc kỹ trước khi chạy lệnh

1. **`Anchor.toml` đang trỏ MAINNET** (kèm API key Helius và ví deployer thật).
   Tuyệt đối không `anchor test` / `anchor deploy` khi chưa đổi `[provider]` sang
   localnet/devnet. Khi test localnet, sửa tạm và **không commit**:
   ```toml
   [provider]
   cluster = "localnet"
   wallet = "~/.config/solana/id.json"
   [scripts]
   test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/backer_guilds.ts"
   ```
2. **`tests/backmysol.ts` có `describe.only`** — chạy cả thư mục tests sẽ nuốt mọi
   suite khác. Các test cũ (`backmysol.ts`, `clean_and_distribute.ts`...) gọi
   `initializeReferral` không còn tồn tại — chúng lỗi thời so với lib.rs hiện tại;
   `tests/backer_guilds.ts` là bộ test chuẩn đang dùng.
3. **`declare_id` phải giữ `Cjjs...vyB6`** cho mainnet. Nếu localnet cần
   `anchor keys sync` thì nhớ revert trước khi commit.
4. Contract **chưa audit** (`security.txt: auditors: None`). Không đưa két giữ SOL
   người chơi lên mainnet trước khi audit.
5. Sửa bản vá fallback referrer thì phải sửa cả frontend gọi `clean_and_distribute`
   (thêm account `fallback_referrer_state`).

## 6. Quy ước làm việc

- Branch phát triển hiện tại: `claude/backmysol-solana-game-ideas-cj02x2`; không push
  thẳng `main`.
- Số tiền luôn tính bằng lamports, u64, nhân chia qua u128 trung gian
  (helper `bps_amount`, `curve_cost` trong lib.rs) — repo bật `overflow-checks`.
- Test mới viết theo phong cách `tests/backer_guilds.ts`: so khớp số dư chính xác
  từng lamport cho luồng tiền, dung sai nhỏ chỉ cho phí giao dịch mạng.
