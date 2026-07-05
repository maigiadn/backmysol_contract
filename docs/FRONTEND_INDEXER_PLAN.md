# Thiết kế Frontend + Indexer — Backer Guilds (backmysol.io)

> Căn cứ thực thi cho giai đoạn tiếp theo sau khi contract Giai đoạn 1 đã chạy trên devnet.
> Quyết định đã chốt với chủ dự án: **app mới riêng** (không đụng site dọn ví đang chạy),
> **indexer trên Cloudflare Worker + D1**, code đặt ở **repo mới `backmysol_app`** (monorepo).

## 1. Kiến trúc tổng thể

```
                          ┌──────────────────────────────┐
                          │   Solana (devnet → mainnet)  │
                          │   program Cjjs...vyB6        │
                          └───────┬──────────────┬───────┘
                 đọc giá/ký tx    │              │  event BackingBought/Sold
                 (RPC Helius #1)  │              │  (Helius Enhanced Webhook)
                          ┌───────┴──────┐   ┌───┴──────────────────────┐
                          │  Web app     │   │  Indexer Worker           │
                          │  Next.js     │◄──┤  /webhook  → parse event  │
                          │ app.backmysol.io  │  /api/*    → REST cho web │
                          │  wallet-adapter   │  cron 10ph → bù event rớt │
                          └──────────────┘   │  D1 (SQLite)              │
                                             └───────────────────────────┘
```

Nguyên tắc vàng: **nguồn sự thật luôn là on-chain**. Indexer/D1 chỉ phục vụ danh sách,
lịch sử, bảng xếp hạng. Mọi con số dùng để ký giao dịch (giá suất, supply, phí) đọc
trực tiếp từ `ChampionProfile`/`GameConfig` on-chain ngay trước khi ký. Không có private
key nào nằm ở server — mọi giao dịch ký trong ví người dùng.

## 2. Frontend — `apps/web` (Next.js)

**Stack**: Next.js (App Router, TypeScript) + Tailwind + `@solana/wallet-adapter`
(Phantom/Solflare/Backpack) + `@coral-xyz/anchor` 0.32 + TanStack Query.
Deploy Cloudflare qua `@opennextjs/cloudflare`. Cluster chọn qua env
`NEXT_PUBLIC_CLUSTER=devnet|mainnet-beta`.

**Các trang:**

| Route | Nội dung | Nguồn dữ liệu |
|---|---|---|
| `/` | Landing + danh sách Champion (sắp theo volume/suất), stats mùa hiện tại | API indexer |
| `/[code]` | Trang Champion: giá suất hiện tại + preview mua/bán, biểu đồ curve, lịch sử giao dịch, vị thế của tôi, countdown khóa 24h | On-chain (giá, supply, position) + API (lịch sử) |
| `/leaderboard` | Xếp hạng Champion/guild theo mùa | API indexer |
| `/me` | Suất đang giữ ở các Champion, link giới thiệu `?ref=CODE`, hoa hồng đã nhận | On-chain + API |
| `/register` | Đăng ký Champion: chọn mã (1–10 ký tự, check trùng on-chain), gọi `register_champion` | On-chain |

**Luồng mua/bán** (`/[code]`):
1. Fetch `ChampionProfile` + `GameConfig` on-chain → tính giá bằng hàm mirror `curve_cost`
   (port từ lib.rs, dùng BigInt — chung package `packages/shared`).
2. Hiển thị: tổng tiền = giá suất + phí, tách rõ phần phí đi đâu (Champion/quỹ mùa/referral/treasury).
3. Cảnh báo: giá xác định bởi supply tại thời điểm khớp — nếu người khác mua trước,
   số tiền thật do contract tính (hiển thị chênh lệch tối đa theo số suất đang mua).
4. Build instruction `buy_backing`/`sell_backing` với đầy đủ accounts
   (championProfile, championWallet, seasonVault theo `game_config.season_id`,
   referralState của backer nếu có, treasury = GlobalConfig.admin, position).
5. Sau khi confirm: refetch on-chain + invalidate cache API.

**Luồng referral**: link `app.backmysol.io/DUY?ref=CODE` → resolve `ReferralCodeMapping`
→ nếu backer **chưa có `ReferralState`** thì gợi ý đăng ký partner (1 giao dịch, tốn rent
nhỏ) trước khi mua — vì hoa hồng game **chỉ trả theo state on-chain**, không có fallback.

## 3. Indexer — `apps/indexer` (Cloudflare Worker + D1)

**Ingest**: Helius Enhanced Webhook đăng ký theo program id `Cjjs...vyB6` → `POST /webhook`.
- Xác thực bằng header `Authorization: <HELIUS_WEBHOOK_SECRET>` (secret của Worker).
- Parse: anchor event nằm trong log `Program data: <base64>` — decode bằng
  `BorshEventCoder` từ IDL (`BackingBought`, `BackingSold`).
- **Idempotent**: khóa chính `(signature, event_index)` — Helius retry không tạo bản ghi trùng.

**Reconciliation**: Worker Cron Trigger mỗi 10 phút chạy `getSignaturesForAddress`
từ `cursor.last_signature` để bù event bị rớt webhook (webhook là tối ưu độ trễ,
cron là lưới an toàn — indexer đúng dữ liệu kể cả khi webhook chết hẳn).

**Schema D1** (`migrations/0001_init.sql`):
```sql
CREATE TABLE champions (
  wallet TEXT PRIMARY KEY, code TEXT UNIQUE, shares_outstanding INTEGER NOT NULL DEFAULT 0,
  registered_at INTEGER, updated_at INTEGER
);
CREATE TABLE trades (
  signature TEXT NOT NULL, event_index INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('buy','sell')),
  champion TEXT NOT NULL, backer TEXT NOT NULL,
  amount INTEGER NOT NULL, lamports INTEGER NOT NULL, fee INTEGER NOT NULL,
  supply_after INTEGER NOT NULL, season_id INTEGER NOT NULL,
  slot INTEGER, ts INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX idx_trades_champion_ts ON trades(champion, ts DESC);
CREATE TABLE positions (
  champion TEXT NOT NULL, backer TEXT NOT NULL,
  shares INTEGER NOT NULL, updated_at INTEGER,
  PRIMARY KEY (champion, backer)
);
CREATE TABLE season_stats (
  season_id INTEGER NOT NULL, champion TEXT NOT NULL,
  volume INTEGER NOT NULL DEFAULT 0, unique_buyers INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season_id, champion)
);
CREATE TABLE cursor (id INTEGER PRIMARY KEY, last_signature TEXT);
```

**API** (cùng Worker, GET, cache edge 10–30s, CORS cho `app.backmysol.io`):
- `GET /api/champions?sort=volume|supply&season=N`
- `GET /api/champions/:code` — profile + 50 trade gần nhất
- `GET /api/leaderboard?season=N` — xếp theo `season_stats.volume`
- `GET /api/backers/:wallet/positions`

`register_champion` không emit event (Giai đoạn 1) → cron nhận diện champion mới qua
`getProgramAccounts` filter theo discriminator `ChampionProfile` (chạy trong cron 10 phút,
số account còn nhỏ). Khi contract Giai đoạn 2 bổ sung event `ChampionRegistered` thì bỏ bước này.

## 4. Bảo mật & vận hành

1. **THU HỒI API key Helius đang lộ**: key trong `Anchor.toml` đã nằm trong git history →
   tạo key mới trên dashboard Helius: key #1 cho RPC frontend (bật domain whitelist),
   key #2 cho webhook/cron của indexer. Key chỉ nằm trong env/secret, không bao giờ commit.
2. Secret của Worker qua `wrangler secret put` (HELIUS_WEBHOOK_SECRET, HELIUS_API_KEY).
3. Indexer là view thuần đọc — hỏng/chậm không ảnh hưởng tiền; frontend luôn ký theo
   dữ liệu on-chain.
4. Rate-limit `/webhook` và `/api/*` bằng Cloudflare (WAF rule cơ bản là đủ giai đoạn đầu).

## 5. Cấu trúc repo mới `backmysol_app` (monorepo yarn workspaces)

```
backmysol_app/
├── apps/
│   ├── web/        # Next.js (mục 2)
│   └── indexer/    # Worker: webhook + api + cron, wrangler.toml, migrations/
├── packages/
│   └── shared/     # IDL json + types + curve math (curveCost, bpsAmount) + PDA helpers
└── scripts/
    └── sync-idl.sh # copy target/idl/backmysol_contract.json từ repo contract sau anchor build
```

PDA helpers trong `shared` dùng đúng seeds của contract: `game_config_v1`, `champion`,
`backing`, `season_vault` (u32 LE), `referral`, `code` — tham chiếu bảng PDA trong
`CLAUDE.md` repo contract.

## 6. Lộ trình & ước lượng (làm tuần tự, chạy được từng bước)

| Tuần | Việc | Kết quả nghiệm thu |
|---|---|---|
| 1 | Dựng monorepo, `packages/shared` (IDL + curve + PDA), indexer webhook→D1 + API, đăng ký webhook Helius devnet | `curl /api/champions` trả champion thật trên devnet sau khi chạy `devnet_smoke.ts` |
| 2 | Web: connect ví, trang `/[code]` với mua/bán hoạt động trên devnet, trang `/register` | Mua/bán suất từ UI thành công trên devnet, số dư khớp |
| 3 | `/leaderboard`, `/me`, luồng referral `?ref=`, landing `/`, polish mobile | Demo end-to-end đủ 3 vai Champion/Backer/Promoter |
| 4 | Beta devnet nhóm nhỏ (10–20 người), sửa theo feedback | Checklist lỗi đóng hết |

Sau beta: **audit contract** (bắt buộc) → deploy mainnet → trỏ `app.backmysol.io`.

## 7. Kiểm chứng end-to-end (checklist trước khi gọi là xong)

- [ ] Mua suất trên UI devnet → trade xuất hiện trong D1 (< 30s) → leaderboard cập nhật.
- [ ] Tắt webhook thử → cron 10 phút tự bù đủ trade đã miss, không trùng bản ghi.
- [ ] Replay cùng payload webhook 2 lần → D1 không có dòng trùng (idempotency).
- [ ] Backer có referral: hoa hồng F1 hiển thị đúng trong `/me` khớp số on-chain.
- [ ] Bán trước 24h bị chặn trên UI với countdown đúng; bán sau khóa nhận đúng tiền.
- [ ] Đổi mùa trên devnet (`update_game_config`) → UI + leaderboard chuyển mùa đúng, mua đầu mùa không lỗi.

## 8. Điều kiện tiên quyết — ĐÃ HOÀN TẤT (2026-07-05)

1. ✅ Repo GitHub: **https://github.com/maigiadn/app_backmysol** (lưu ý tên repo là
   `app_backmysol`, không phải `backmysol_app` như bản nháp).
2. ✅ 2 API key Helius mới đã tạo (chủ dự án giữ, KHÔNG commit vào repo — chỉ đưa vào
   `.env.local` gitignored và `wrangler secret put`). Key nào bật domain whitelist trên
   dashboard Helius là key frontend; key còn lại cho indexer/webhook. Nhớ thu hồi key
   cũ từng lộ trong `Anchor.toml`.
3. ✅ Subdomain: `app.backmysol.io` — thêm DNS record khi deploy tuần 2.
4. ✅ Database D1 đã tạo sẵn và ÁP XONG SCHEMA mục 3 (idempotent, `IF NOT EXISTS`):
   - name: `backmysol-indexer`
   - database_id: `c13098f1-9271-4ce7-8d8f-45c863f69ef6` (region APAC)
   - Dùng ngay trong `wrangler.toml`:
     ```toml
     [[d1_databases]]
     binding = "DB"
     database_name = "backmysol-indexer"
     database_id = "c13098f1-9271-4ce7-8d8f-45c863f69ef6"
     ```
   - `migrations/0001_init.sql` trong repo mới phải viết `CREATE TABLE IF NOT EXISTS`
     để chạy đè lên schema đã áp mà không lỗi.
