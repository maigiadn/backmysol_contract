# Tuần 3 — Spec cụ thể cho Claude trên VS Code (repo `app_backmysol`)

> Đọc kèm `docs/FRONTEND_INDEXER_PLAN.md` (kiến trúc) và `docs/WEEK2_FRONTEND_SPEC.md`
> (những gì đã xong). Phạm vi Tuần 3 theo roadmap mục 6: **luồng referral `?ref=`,
> `/leaderboard`, `/me`, landing `/`, polish mobile**. Nghiệm thu: demo end-to-end đủ
> 3 vai Champion / Backer / Promoter trên devnet.

Như thường lệ: xác nhận cấu trúc thật của repo trước khi code; số dùng để ký giao dịch
luôn đọc on-chain; API key không vào git.

## 1. Luồng referral `?ref=CODE` — phần quan trọng nhất tuần này

### 1.1. Sự thật contract cần nắm (đối chiếu `lib.rs` repo contract)

- Hoa hồng game (10% phí cho F1, 5% cho F2) **chỉ trả theo `ReferralState` on-chain
  của backer** — backer chưa đăng ký thì phần này dồn về treasury.
- Instruction duy nhất tạo `ReferralState` là `register_partner(code, referrer)` —
  nó đồng thời bắt user **chiếm một mã riêng** (init `ReferralCodeMapping`). Hệ quả
  thiết kế: backer nào kích hoạt referral cũng tự động trở thành Promoter có mã riêng
  → tận dụng làm viral loop, hiển thị luôn link giới thiệu của họ sau khi kích hoạt.
- **Bẫy đã biết**: `register_partner` chỉ ghi nhận upline khi được truyền account
  `upline_referrer_state` = PDA `["referral", upline_wallet]` (kể cả khi account đó
  CHƯA tồn tại — cứ truyền địa chỉ PDA). Truyền `null` là mất upline. Xem cách gọi
  đúng trong test 7 của `tests/backer_guilds.ts` bên repo contract.
- `ReferralState.referrer` mặc định là admin nếu đăng ký không có upline.
- `total_rewards_generated` KHÔNG được contract cập nhật, và event `BackingBought`
  không chứa số hoa hồng → **không có nguồn dữ liệu chính xác cho "tổng hoa hồng đã
  nhận"**. Tuần 3 KHÔNG hiển thị con số này (xem mục 3).

### 1.2. Bắt và lưu mã giới thiệu

- Mọi trang nhận query `?ref=CODE` (landing, `/[code]`): validate 1–10 ký tự →
  lưu `localStorage["bms_ref"]` (chỉ lưu mã, resolve ví khi dùng). Mã đã lưu không bị
  ghi đè bởi mã đến sau (first-touch), trừ khi mã cũ resolve thất bại.
- Component `ReferralBanner`: nếu có `bms_ref` và ví đã connect nhưng **chưa có
  `ReferralState`** → hiện banner "Kích hoạt mã giới thiệu của X để người giới thiệu
  nhận hoa hồng khi bạn giao dịch" + nút mở modal kích hoạt (mục 1.3).

### 1.3. Modal "Kích hoạt referral" (dùng chung cho banner và `/me`)

1. Resolve upline: `championCodePda(programId, bms_ref)` → `ReferralCodeMapping.owner`
   = ví upline. Mã không tồn tại → bỏ qua upline (đăng ký không upline vẫn được).
2. User chọn **mã riêng của mình** (input + nút check trùng, tái dùng logic `/register`).
3. Gọi:
   ```ts
   await program.methods.registerPartner(myCode, uplineWallet ?? null)
     .accounts({
       user: wallet.publicKey!,
       uplineReferrerState: uplineWallet ? referralStatePda(programId, uplineWallet) : null,
     })
     .rpc();
   ```
   (LUÔN truyền `uplineReferrerState` khi có upline — xem bẫy 1.1.)
4. Thành công → xóa banner, invalidate query `ReferralState`, hiện link giới thiệu mới.
5. Chặn edge: `uplineWallet === wallet.publicKey` → bỏ upline (contract sẽ reject
   `SelfReferral`); user đã có `ReferralState` → không hiện modal.

### 1.4. Nối referral vào mua/bán (gỡ TODO Tuần 2)

Trong `BackingPanel`, trước khi build tx: fetch `referralStatePda(programId, backer)`.
- Không tồn tại → giữ nguyên 3 account `null` như Tuần 2.
- Tồn tại → truyền:
  ```ts
  referralState: referralStatePda(programId, wallet.publicKey!),
  referrerWallet: state.referrer,                       // contract require khớp
  tier2ReferrerWallet: state.tier2Referrer ?? null,     // Option<Pubkey> trong state
  ```
- Cập nhật preview phí: phần F1/F2 hiển thị "→ người giới thiệu của bạn" thay vì
  gộp vào treasury.

## 2. `/leaderboard`

- Dữ liệu: `GET /api/leaderboard?season=N` (indexer, đã có từ Tuần 1 — kiểm tra hoạt
  động; thiếu/sai thì sửa Worker trong cùng tuần này).
- Mùa hiện tại lấy từ `GameConfig.seasonId` on-chain; dropdown chọn mùa cũ.
- Bảng: hạng, mã Champion (link `/[code]`), volume mùa (SOL), số backer duy nhất,
  suất đang lưu hành. Highlight dòng Champion mà ví đang connect có vị thế.
- Ghi chú dưới bảng: "Xếp hạng phục vụ chia thưởng SeasonPool — cơ chế chia thưởng
  on-chain ra mắt Giai đoạn 2" (đừng hứa ngày).
- Empty state khi mùa chưa có giao dịch.

## 3. `/me`

Bố cục 3 khối:

1. **Vị thế của tôi**: `GET /api/backers/:wallet/positions` để liệt kê nhanh, nhưng
   số suất hiển thị đối chiếu on-chain (`BackingPosition`) cho các dòng — indexer chỉ
   để khỏi phải quét mọi champion. Mỗi dòng: mã Champion, số suất, giá trị bán ước
   tính hiện tại (`curveCost(supply - shares, shares, divisor)` trừ phí bán), countdown
   khóa nếu còn, nút → `/[code]`.
2. **Referral của tôi**:
   - Chưa có `ReferralState` → CTA mở modal kích hoạt (mục 1.3).
   - Đã có → hiện mã của mình (tra ngược không có sẵn on-chain map ví→mã, nên khi
     đăng ký thành công lưu `localStorage["bms_mycode"]`; mất localStorage thì cho
     user gõ lại mã để verify bằng `ReferralCodeMapping.owner === wallet`), link copy
     `https://app.backmysol.io/?ref=<MYCODE>`, ví upline (rút gọn).
   - **KHÔNG hiển thị "tổng hoa hồng đã nhận"** — contract/event hiện chưa có nguồn
     dữ liệu chính xác (xem 1.1). Đặt placeholder "Thống kê hoa hồng — sắp ra mắt".
     Ghi TODO tham chiếu: cần Giai đoạn 2 thêm ref amounts vào event.
3. **Champion của tôi** (nếu ví có `ChampionProfile`): supply, volume mùa, số dư két
   (lamports của account profile trừ rent), link trang của mình.

## 4. Landing `/`

- Hero: tagline + 2 CTA "Khám phá Champion" (cuộn xuống danh sách) / "Trở thành
  Champion" (→ `/register`).
- Danh sách Champion: `GET /api/champions?sort=volume` — card: mã, giá suất kế tiếp
  (tính client từ `sharesOutstanding` indexer trả về — chấp nhận trễ vài giây ở
  landing; trang `/[code]` mới là nguồn chuẩn), volume mùa.
- Khối "Cách chơi" 3 bước (Backer/Champion/Promoter) — nội dung rút từ mục 2 của
  `docs/GAME_CONCEPT.md`.
- Footer: link X/Telegram, program id + link explorer, câu miễn trừ "Không phải lời
  khuyên đầu tư; phần thưởng đến từ phí giao dịch thật, xem tài liệu."

## 5. Polish mobile + ví

- Test toàn bộ luồng trong **in-app browser của Phantom mobile** (devnet) — đây là
  cách phần lớn user mobile sẽ vào. Wallet-adapter hoạt động sẵn trong đó; chỉ cần
  đảm bảo layout responsive và nút không bị che.
- Số SOL hiển thị: 4–6 chữ số lẻ, tooltip lamports đầy đủ; địa chỉ ví rút gọn `abcd…wxyz`.
- Trạng thái loading/skeleton cho mọi fetch on-chain; retry nút khi RPC lỗi.

## 6. Indexer — việc phát sinh trong tuần (nếu kiểm tra thấy thiếu)

- `/api/leaderboard` và `/api/backers/:wallet/positions` chạy đúng với dữ liệu thật
  devnet; CORS cho `http://localhost:3000` + `https://app.backmysol.io`.
- `positions` trong D1 phải được cập nhật từ cả event buy lẫn sell (kiểm tra handler).
- Champion mới (không có event) được cron nhận diện qua `getProgramAccounts` — xác
  nhận champion đăng ký từ UI Tuần 2 đã xuất hiện trong `GET /api/champions`.

## 7. Checklist nghiệm thu Tuần 3 (devnet, 3 ví: A=Champion, B=Backer, C=Promoter)

- [ ] C kích hoạt referral (không upline), lấy link `?ref=C_CODE`.
- [ ] B mở link của C → banner hiện → kích hoạt với upline C → mua suất của A →
      số dư ví C tăng đúng 10% phí (đối chiếu explorer).
- [ ] Preview phí của B hiển thị dòng "người giới thiệu" thay vì treasury.
- [ ] `/leaderboard` hiện A với volume khớp tổng giao dịch; đổi season dropdown không lỗi.
- [ ] `/me` của B: vị thế đúng số suất, countdown khóa đúng; `/me` của C: link referral
      copy được; `/me` của A: khối Champion hiện supply + két.
- [ ] Landing hiện A trong danh sách với giá suất kế tiếp đúng công thức.
- [ ] Toàn bộ luồng trên chạy được trong Phantom mobile in-app browser.
- [ ] `?ref=` mã rác (không tồn tại/quá dài) không làm crash trang, bị bỏ qua êm.

## 8. Ngoài phạm vi Tuần 3

- Chia thưởng SeasonPool, settle mùa → Giai đoạn 2 contract (chưa có instruction).
- Thống kê hoa hồng chính xác → cần contract Giai đoạn 2 bổ sung event.
- Deploy production `app.backmysol.io` → Tuần 4 (beta) sau khi checklist trên xanh.
