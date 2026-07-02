# Backer Guilds — Game Concept cho backmysol.io

> **English summary:** Backer Guilds turns the BackMySol brand into a SocialFi game on Solana.
> Users ("Backers") buy bonding-curve "backing shares" of creators/traders ("Champions") with SOL.
> Trading fees are split between the Champion, a seasonal prize pool, a 2-tier referral system
> (reused from the existing contract), and the platform treasury. Backers of the same Champion form
> a Guild and compete in 30-day seasons for the SOL prize pool. No new token is issued; rewards come
> from real platform revenue. V1 deliberately does NOT share Champions' trading PnL with backers to
> avoid securities risk.

---

## 1. Tổng quan & định vị thương hiệu

**"Back My SOL"** — cái tên nói lên tất cả: *"hãy hậu thuẫn SOL cho tôi"*.

Backer Guilds là game xã hội (SocialFi) trên Solana, nơi cộng đồng dùng SOL để **hậu thuẫn
(back)** những người chơi nổi bật — trader, KOL, game thủ — và cùng hưởng thành quả khi người
mình chọn thành công. Đây không còn là tool tiện ích, mà là một sân chơi "chọn mặt gửi vàng":

- Chọn đúng người → suất backing tăng giá.
- Vào sớm → mua rẻ hơn người đến sau.
- Kéo được bạn bè → nhận hoa hồng giới thiệu 2 tầng.
- Hội (guild) của mình thắng mùa giải → chia quỹ thưởng bằng SOL thật.

Thương hiệu giữ nguyên **backmysol.io**. Mỗi Champion có một đường link riêng mang đúng thông
điệp thương hiệu, ví dụ `backmysol.io/DUY` — nghĩa đen là *"back SOL cho DUY"*.

## 2. Ba vai người chơi

| Vai | Họ là ai | Họ làm gì | Họ kiếm gì |
|---|---|---|---|
| **Champion** | Trader, KOL, game thủ, streamer | Đăng ký hồ sơ, lấy mã tên riêng, kéo fan về back mình, hoạt động sôi nổi để guild thắng mùa giải | % phí trên MỌI giao dịch mua/bán suất backing của chính mình — thu nhập thụ động tỷ lệ với độ hot |
| **Backer** | Người hâm mộ, degen săn kèo | Mua suất backing của Champion mình tin, tham gia guild, làm quest mùa giải | Chênh lệch giá suất (mua sớm bán muộn), phần chia quỹ thưởng khi guild thắng mùa |
| **Promoter** | Bất kỳ ai có mạng lưới | Chia sẻ link giới thiệu (hệ referral 2 tầng sẵn có) | % phí từ mọi giao dịch của người mình giới thiệu (F1) và người F1 giới thiệu tiếp (F2) |

Một người có thể giữ cả 3 vai cùng lúc — Champion cũng có thể đi back Champion khác và giới
thiệu bạn bè.

## 3. Cơ chế mua bán suất backing & cách chia phí

### 3.1. Giá suất — bonding curve

Mỗi Champion có một "két" SOL riêng. Giá suất backing được tính bằng công thức on-chain,
tăng dần theo tổng số suất đã bán (mô hình friend.tech đã kiểm chứng):

```
giá suất thứ n = n² / 16000  (SOL)
```

Ví dụ cụ thể:

| Suất thứ | Giá (SOL) | Ghi chú |
|---|---|---|
| 1 | 0.0000625 | Gần như miễn phí — dễ khởi động |
| 10 | 0.00625 | ~$1 |
| 50 | 0.15625 | ~$23 |
| 100 | 0.625 | ~$94 |
| 200 | 2.5 | ~$375 — Champion hot thật sự |

*(quy đổi minh họa theo SOL ≈ $150; hệ số 16000 có thể chỉnh qua config)*

Tiền mua suất nằm trong két của Champion đó. Khi backer bán suất, contract trả SOL từ két
theo đúng công thức — **thanh khoản luôn có sẵn, không cần người mua đối ứng**.

### 3.2. Chia phí — tái dùng bộ máy chia phí hiện có

Mỗi lệnh mua/bán thu phí trên giá trị giao dịch, chia làm 4 phần (tỷ lệ bps chỉnh được qua
`GlobalConfig`, giống hệt cách `platform_fee_bps` / `tier1_share_bps` / `tier2_share_bps`
đang vận hành):

Đề xuất khởi điểm — **phí mua 5%, phí bán 7%** (bán đắt hơn mua để chống lướt sóng xả hàng):

| Phần | Tỷ lệ trên phí | Ví dụ: lệnh mua 1 SOL (phí 0.05 SOL) |
|---|---|---|
| Champion | 50% | 0.025 SOL |
| Quỹ thưởng mùa giải (SeasonPool) | 20% | 0.01 SOL |
| Promoter F1 / F2 | 10% / 5% | 0.005 / 0.0025 SOL |
| Treasury (platform) | 15% | 0.0075 SOL |

Nếu người giao dịch không có người giới thiệu, phần F1/F2 dồn về treasury — đúng logic
fallback đang có trong `clean_and_distribute`.

## 4. Vì sao game này hấp dẫn

1. **Thương hiệu và gameplay là một.** "Back My SOL" chính là lời mời của mỗi Champion —
   không tốn một dòng giải thích nào cho người mới.
2. **Chơi theo hội, không chơi một mình.** Cổ vũ thần tượng, đua bảng xếp hạng, ganh đua
   giữa các guild — chất keo giữ chân mạnh hơn nhiều so với tool tiện ích một lần dùng.
3. **Vào sớm có lợi thế thật.** Giá suất tăng theo số người mua — cảm giác "săn kèo sớm"
   rất hợp văn hóa degen Solana.
4. **Mô hình lõi đã được chứng minh.** friend.tech trên Base tạo ra hàng chục triệu USD phí
   giao dịch với đúng cơ chế bonding curve + chia phí cho creator. Backer Guilds thêm lớp
   guild + mùa giải để thành game có nhịp, thay vì chỉ là chợ mua bán rồi nguội.
5. **Champion là kênh marketing tự thân.** Thu nhập Champion tỷ lệ thuận với lượng người
   back mình → mỗi KOL tham gia sẽ tự kéo fan về platform, không tốn phí quảng cáo.

## 5. Guild & mùa giải

- **Guild**: tất cả backer đang giữ suất của cùng một Champion tạo thành guild của Champion đó.
- **Mùa giải**: mỗi mùa 30 ngày. Điểm guild tính từ ba nguồn, cân để không nguồn nào độc chiếm:
  - **Volume giao dịch** suất backing của Champion trong mùa (50%).
  - **Tuyển quân**: số backer MỚI tham gia guild trong mùa (30%).
  - **Hoạt động**: quest tuần của backer — giữ suất đủ 7 ngày, back thêm Champion mới... (20%).
- **Chia thưởng**: kết mùa, SeasonPool (gom 20% phí cả mùa) chia cho top guild — ví dụ
  top 1 nhận 40%, top 2 nhận 25%, top 3 nhận 15%, top 4–10 chia 20% còn lại. Trong mỗi guild,
  thưởng chia theo tỷ trọng suất đang giữ + điểm quest cá nhân.
- Điểm số gốc ghi on-chain (cộng dồn ngay trong instruction mua/bán), bảng xếp hạng do
  indexer off-chain tổng hợp và hiển thị realtime.

## 6. Các chiêu gian lận và cách chặn

| Chiêu | Cách chặn |
|---|---|
| Champion tự mua suất của mình để bơm điểm volume | Cấm ví Champion mua suất chính mình (tái dùng pattern `SelfReferral` sẵn có); volume từ ví lặp lại bị indexer giảm trọng số |
| Mua rồi bán ngay (wash trading) để cày điểm | Phí bán 7% > phí mua 5% → mỗi vòng wash lỗ ≥12%; suất mới mua bị khóa bán 24h |
| Người mua sớm xả lên đầu người sau (pump-dump) | Curve hoàn tiền theo đúng công thức nên không "sập" kiểu thanh khoản cạn; khóa 24h + phí bán cao làm chậm nhịp xả |
| Chiếm mã tên đẹp của KOL (squatting) | Mã tên Champion cần chữ ký của chính ví đăng ký (như `register_partner` hiện tại) + admin có quyền thu hồi mã vi phạm thương hiệu trong giai đoạn đầu |
| Tự giới thiệu bản thân bằng ví phụ để hoàn phí | Hoa hồng F1/F2 chỉ trả khi ví giới thiệu có `ReferralState` on-chain đăng ký TRƯỚC giao dịch — vá luôn lỗ hổng fallback đang tồn tại ở `clean_and_distribute` |

## 7. Thiết kế kỹ thuật

### 7.1. Tái dùng từ contract hiện tại (`programs/backmysol_contract/src/lib.rs`)

- **`GlobalConfig`** (PDA `config_v1`): giữ nguyên, thêm trường `buy_fee_bps`, `sell_fee_bps`,
  `champion_share_bps`, `pool_share_bps`, `season_id`, `curve_divisor`.
- **`ReferralState` + logic 2 tầng**: dùng nguyên cho hoa hồng Promoter trên mỗi giao dịch.
- **`ReferralCodeMapping`** (PDA `["code", code]`): dùng làm mã tên Champion.
- **`invoke_transfer` + cấu trúc chia phí bps**: dùng lại cho việc chia 4 phần phí.

### 7.2. Phần mới

| Account (PDA) | Seeds | Lưu gì |
|---|---|---|
| `ChampionProfile` | `["champion", wallet]` | tổng suất đã bán, két SOL (lamports giữ ngay trong PDA), điểm mùa hiện tại, trạng thái active |
| `BackingPosition` | `["backing", champion, backer]` | số suất đang giữ, giá vốn trung bình, timestamp mua gần nhất (cho khóa 24h), điểm quest |
| `SeasonPool` | `["season", season_id]` | SOL quỹ thưởng, trạng thái đã chốt/chưa, merkle root kết quả chia thưởng |

| Instruction | Việc làm |
|---|---|
| `register_champion(code)` | Tạo profile + chiếm mã tên (dùng lại flow `register_partner`) |
| `buy_backing(amount)` | Tính giá theo curve, chuyển SOL vào két, thu & chia phí 4 phần, cộng điểm mùa |
| `sell_backing(amount)` | Kiểm tra khóa 24h, trả SOL từ két theo curve, thu & chia phí |
| `settle_season(merkle_root)` | Admin chốt mùa, ghi root kết quả |
| `claim_season_reward(proof)` | Backer tự claim phần thưởng theo merkle proof |

Bonding curve là công thức thuần (vài chục dòng, dùng `u128` trung gian chống tràn số).
Frontend + indexer (theo dõi event để dựng bảng xếp hạng) là phần việc song song ngoài contract.

## 8. Rủi ro pháp lý & vận hành — và cách né

- **Rủi ro chứng khoán**: nếu backer được chia *lợi nhuận trading* của Champion, sản phẩm dễ bị
  xem là hợp đồng đầu tư. **V1 tuyệt đối không chia PnL** — backer chỉ hưởng (a) chênh lệch giá
  suất và (b) thưởng mùa giải từ doanh thu phí của platform. Đây là ranh giới friend.tech đã
  vận hành công khai mà chưa bị xử lý.
- **Cold-start**: không có Champion thì không có gì để chơi. Kế hoạch ra mắt phải bắt đầu bằng
  10–20 KOL hạt giống (lợi thế sân nhà: cộng đồng crypto Việt Nam), kèm ưu đãi Champion sáng
  lập (share phí cao hơn trong mùa 1).
- **An toàn két tiền**: contract sẽ giữ SOL của người chơi trong két — **bắt buộc audit trước
  mainnet** (security.txt hiện ghi `auditors: None`). Thêm giới hạn két tối đa trong giai đoạn
  beta và quyền tạm dừng khẩn cấp (pause) cho admin.
- **Nhịp game nguội giữa mùa**: quest tuần + sự kiện flash (x2 điểm cuối tuần) để giữ nhịp.

## 9. Đánh giá khả thi & con số

**Kỹ thuật — khả thi cao.** Phần mới là pattern Anchor chuẩn (PDA, CPI transfer, merkle claim).
Ước lượng: contract 4–8 tuần, frontend + indexer 4–6 tuần chạy song song. So sánh: hướng
"dọn rác kiếm thưởng" chỉ thu ~$6 gộp/user và dùng một lần; ở đây doanh thu lặp lại theo volume.

**Kinh tế — ba kịch bản** (phí mua 5% + bán 7%, treasury nhận 15% phí, quỹ mùa nhận 20% phí):

| Kịch bản | Champion / Backer hoạt động | Volume giao dịch/tháng | Tổng phí/tháng | Treasury/tháng | Quỹ thưởng/mùa |
|---|---|---|---|---|---|
| Khởi động | 15 / 300 | 400 SOL | ~24 SOL | ~3.6 SOL (~$540) | ~4.8 SOL (~$720) |
| Bám rễ | 50 / 2,000 | 3,000 SOL | ~180 SOL | ~27 SOL (~$4,000) | ~36 SOL (~$5,400) |
| Bùng nổ | 200 / 15,000 | 25,000 SOL | ~1,500 SOL | ~225 SOL (~$34,000) | ~300 SOL (~$45,000) |

*(giả định phí trung bình ~6% trên volume; quy đổi SOL ≈ $150; con số để định cỡ, không phải cam kết)*

**Yếu tố quyết định thành bại không phải công nghệ mà là phân phối**: kéo được lứa KOL hạt
giống đầu tiên. Xác suất thành công thẳng thắn: hoàn thành sản phẩm ~90%; đạt kịch bản "bám rễ"
~30–40% (phụ thuộc KOL + chu kỳ thị trường); bùng nổ kiểu friend.tech <10%.

## 10. Lộ trình 3 giai đoạn

**Giai đoạn 1 — Chợ backing (6–8 tuần):**
`register_champion`, `buy_backing`, `sell_backing`, chia phí 4 phần + hoa hồng referral 2 tầng,
khóa 24h chống wash. Ra mắt devnet → audit → mainnet beta với 10–20 Champion hạt giống.

**Giai đoạn 2 — Guild & mùa giải (4–6 tuần sau GĐ1):**
SeasonPool, tính điểm mùa on-chain, `settle_season` + `claim_season_reward` (merkle),
bảng xếp hạng realtime, quest tuần. Đây là lúc "chợ" trở thành "game".

**Giai đoạn 3 — Mở rộng:**
Giải đấu hiệu suất on-chain cho Champion (trading league đo bằng indexer/oracle — cân nhắc kỹ
pháp lý trước khi bật), mobile app, huy hiệu NFT cho backer trung thành, và chỉ khi cộng đồng
đủ lớn mới cân nhắc token riêng.

---

*Tài liệu này là căn cứ thiết kế cho giai đoạn phát triển tiếp theo của backmysol.io.
Contract hiện tại (dịch vụ dọn ví) vẫn vận hành bình thường và độc lập trong lúc xây Giai đoạn 1.*
