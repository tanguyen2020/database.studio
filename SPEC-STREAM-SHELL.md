# SPEC — Khung workspace dùng chung cho Cache & Streaming

> Viết 2026-10-21. Trạng thái: **ĐÃ CODE (W0), chưa commit.** Đợt **W0** — làm trước mọi spec engine.
> **Cập nhật 2026-10-22** — đã code, chưa commit. Các quyết định sau ngày viết spec được ghi ở bảng §0 (cột "Ai chốt") và mục Lối vào (§3–§4); phần nào mâu thuẫn với chúng thì phần mới thắng.
> Bản phác thảo giao diện: https://claude.ai/artifact/KYsTkPaP7QczcFiZowTJgt
> Spec engine dùng khung này (mỗi engine một file riêng):
> `SPEC-KAFKA-WORKSPACE.md` (W1) · `SPEC-RABBITMQ-WORKSPACE.md` (W2) · `SPEC-REDIS-BROWSER.md` (W3) ·
> `SPEC-NATS-WORKSPACE.md` (W4).
> Mọi `file:line` đọc ở commit `f702b6a`; nguồn sự thật cuối cùng là code.

---

## 0. Quyết định đã chốt

| # | Quyết định | Ai chốt |
|---|---|---|
| D1 | Cache/Streaming chuyển sang **workspace theo cluster**: sidebar chỉ điều hướng, dữ liệu nằm trong tab | Người dùng |
| D2 | ~~Hoãn cây hợp nhất~~ → **Đã làm (2026-10-22):** chế độ **One sidebar** = mỗi connection mở cây ngay dưới hàng của nó; bản cài mới mặc định One sidebar, vẫn chọn được layout 2 panel | Người dùng |
| D4 | **Redis · Kafka · NATS · RabbitMQ không có cây Explorer**: chọn connection = mở tab workspace (vào thẳng màn xem message, tự chọn mục đầu A→Z) | Người dùng (2026-10-22) |
| D3 | Thứ tự đợt: W0 (spec này) → W1 Kafka → W2 RabbitMQ → W3 Redis → W4 NATS; dừng chờ duyệt sau mỗi đợt | Đề xuất, người dùng chưa phản đối |

---

## 1. Nguyên tắc (áp cho spec này và mọi spec engine)

1. **Additive, khoanh vùng.** Chỉ đụng nhánh Kafka/RabbitMQ/Redis/NATS. Không sửa engine quan hệ, Mongo,
   Cassandra, Elasticsearch, DuckDB. Kiểu dùng chung (`types.ts`, `drivers/types.rs`) chỉ thêm field optional.
2. **Dùng lại màn hình đang chạy tốt** (nhúng vào khung), không viết lại khi không cần.
3. **Không bịa số liệu.** Ô nào backend không lấy được thì không hiện, hoặc hiện "?" kèm lý do.
4. **Định nghĩa xong mỗi đợt:** `npm run check` 0/0 · `npx vitest run` xanh · `npm run tokens:check` không
   tăng · e2e của đợt + spec cũ bị ảnh hưởng xanh · **integration trên container thật** cho mọi lệnh backend
   mới (demo/Playwright không thay được bước này).
5. Rule chung cũ vẫn áp: dialog có form thì backdrop không đóng; Refresh có spinner + guard; màu chỉ qua token;
   tiến trình dài dùng cửa sổ tiến trình.

---

## 1b. Giao diện thương mại — dễ dùng, tường minh, không thô kiểu lập trình (bắt buộc)

Yêu cầu của người dùng (2026-10-21). Áp cho khung này và **mọi** spec engine; mỗi spec engine có bảng
"Từ ngữ hiển thị" riêng theo quy tắc dưới đây. Màn hình nào vi phạm thì chưa được coi là xong.

| # | Quy tắc | Ví dụ đúng | Không được |
|---|---|---|---|
| U1 | **Nhãn nói ý nghĩa, không nói tên field của API.** Khái niệm gốc của engine (Topic, Queue, Consumer group, Partition) giữ nguyên tên nhưng có tooltip giải thích một câu | "Waiting" (tooltip: *messages no consumer has picked up yet*) | `messages_ready`, `Ready`, `RF`, `ISR` đứng trơ trọi |
| U2 | **Mỗi màn hình trả lời 3 câu:** đang ổn không · cái gì cần chú ý · nên làm gì. Đầu mục Overview có **một câu tình trạng** bằng lời | "2 partitions have fewer copies than configured — data on them is less protected. *Show partitions*" | Chỉ có con số "Under-replicated: 2" |
| U3 | **Giá trị kỹ thuật thô ẩn sau "Advanced" / "Raw".** Mặc định hiện bản đọc được | "Failed messages go to `payments.dlx`", "Max 5 delivery attempts" — bấm *Advanced* mới thấy `x-dead-letter-exchange` | Bảng arguments `x-*` hiện thẳng |
| U4 | **Số có định dạng và đơn vị**: 12.9k, 9.4 GB, "6 min ago" (tooltip giờ chính xác UTC), "1 day" thay cho 86400000 | "Keep messages for **7 days**" | `retention.ms = 604800000` |
| U5 | **Màu chỉ khi có nghĩa**: xanh = ổn, vàng = cần chú ý, đỏ = lỗi/nguy hiểm; kèm chữ, không chỉ màu | Badge "Needs attention" vàng | Tô màu trang trí |
| U6 | **Trạng thái trống có hướng dẫn + nút hành động** | "No topics yet. Topics hold your messages. **Create topic**" | Bảng trống, hoặc "No data" |
| U7 | **Lỗi nói bằng lời + cách sửa**; nguyên văn từ server nằm sau "Show details" | "Kafka refused: the group still has 4 running consumers. Stop them, then delete." | Ném nguyên exception |
| U8 | **Hành động nguy hiểm**: dialog nói rõ hậu quả bằng số cụ thể, nút đỏ ghi đúng động từ | "Purge 1,980 messages from payments.process? This cannot be undone." → nút **Purge 1,980 messages** | "Are you sure?" + OK |
| U9 | **Thao tác phức tạp = wizard có xem trước kết quả** (reset offset, sửa cấu hình topic, tạo queue) | Bảng "Before → After" từng partition trước khi áp | Ô nhập offset thô |
| U10 | **Không có nút chỉ có icon mà không nhãn/tooltip**; thao tác chính luôn có chữ | "+ Create topic" | Chỉ dấu "+" |
| U11 | **Font**: chữ giao diện cho nhãn và mô tả; mono chỉ cho tên kỹ thuật (topic, key, subject) và giá trị dữ liệu | — | Cả bảng mono |
| U12 | **Dòng mô tả ngắn dưới tiêu đề mỗi mục** cho người mới (một câu, ẩn được, nhớ lựa chọn) | "Consumer groups are the apps reading this cluster. *Behind* = messages they have not read yet." | Không giải thích gì |
| U13 | **Chữ trên giao diện bằng tiếng Anh** như toàn app (rule i18n AUDIT-7); spec viết tiếng Việt | — | Trộn ngôn ngữ |

Component khung hỗ trợ trực tiếp: `StreamShell` có slot câu tình trạng (U2) + dòng mô tả mục (U12);
`StreamTable` có trạng thái trống có nút (U6) và tooltip tiêu đề cột (U1); thêm `HelpTip.svelte` (dấu ⓘ +
tooltip một câu) và `AdvancedToggle.svelte` (U3). Pure `src/lib/stream/humanize.ts` (unit test): định dạng số,
dung lượng, thời lượng (ms → "7 days"), thời gian tương đối.

---

## 2. Tab type

- Thêm `'stream-workspace'` vào `TabContentType` (`src/lib/types.ts:214-253`).
- `tabs.openStreamWorkspace(connId, section?, focus?)` — **một tab cho mỗi connection** (singleton theo
  `connectionId`); gọi lại thì đổi `state.section` / `state.focus` và kích hoạt tab cũ.
- `state`: `{ section: string; focus?: string; sub?: string }` — `focus` = đối tượng đang chọn (topic, queue,
  key, bucket…), `sub` = tab con của khung chi tiết.
- Nhánh `{:else if}` trong `paneBody` của `App.svelte` (cạnh dòng 419–455) → `StreamWorkspace.svelte` dispatch
  theo `system` sang workspace của từng engine.

## 3. Component mới (`src/lib/components/stream/`)

| Component | Vai trò |
|---|---|
| `StreamShell.svelte` | Header (logo engine, tên connection, dòng thông tin, badge tình trạng, slot nút) + thanh mục (section nav, có số đếm) + slot nội dung |
| `StreamTable.svelte` | Bảng: cột cấu hình được, sắp xếp, lọc text, **cuộn ảo**, chọn dòng bằng chuột + ↑↓/Enter, zebra/hover/selected theo token `--tbl-*` |
| `SplitDetail.svelte` | Chia trái danh sách / phải chi tiết, kéo được, nhớ tỉ lệ theo engine (localStorage) |
| `StatCards.svelte` | Hàng thẻ chỉ số (giá trị, nhãn, dòng phụ, tone ok/warn/err) |
| `RateChart.svelte` | Biểu đồ đường nhỏ (SVG, không thêm thư viện) — dùng đầu tiên ở RabbitMQ |

Pure logic kèm unit test: `src/lib/stream/table.ts` (sort/filter/virtual window), `src/lib/stream/rates.ts`
(lấy mẫu, cửa sổ thời gian).

## 4. Lối vào

- ~~Explorer liệt kê các mục dưới node connection~~ — thay bằng D4: **4 engine này không có cây**. Chọn
  connection (Connections, Command Palette, màn hình bắt đầu) = `openStreamWorkspace(conn)`; tab mới vào thẳng
  mục xem message (`messagesSection`: kafka→topics, nats→streams, rabbitmq→queues, redis→browser) và tự chọn mục
  đầu (`autoPick`). Mở lại tab đã có thì giữ nguyên chỗ đang xem.
- **Tab type cũ đã xoá** (đợt dọn dẹp 2026-10-22): `kafka`, `kafka-schema-registry`, `kafka-consumer`,
  `kafka-producer`, `nats`, `nats-subject`, `redis`, `redis-key`, `redis-pubsub`, `rabbit-queue`,
  `rabbit-exchange`. Tab cũ đã lưu từ bản trước được `tabs.restore` chuyển sang `stream-workspace` đúng mục.

## 5. Test

Vitest cho `stream/table.ts` + `rates.ts`; e2e `stream-shell.spec.ts` **(đã có)**: 1 tab/connection, đổi mục bằng
click và ←/→, dòng giải thích ẩn được và nhớ qua restart, bảng 5.002 dòng (seam `?kafkaTopics=N`) chỉ vẽ dòng
đang thấy, cuộn tới cuối, Home/↓/End/Enter, lọc tức thì, khối main-thread dài nhất < 800 ms. Spec cũ bị ảnh
hưởng ở đợt này: `stream-fonts`.

## 5b. Thay đổi sau khi viết spec (2026-10-22)

- **Màu bảng dịu, không chữ trắng gắt:** token `--tbl-name/-cell/-zero/-th/-group/-child/-guide` (theme.css);
  tên = chữ thường (không màu link), số một bậc thấp hơn, ô chỉ có số 0 mờ hẳn; hàng chọn nền trung tính.
- **`StreamTable`:** hàng cao 30px; prop tuỳ chọn `min` cho cột co giãn; chế độ cây (`rowLevel/rowExpanded/
  rowKind/onToggle`) với hàng cha là dải nhóm và hàng con có đường dẫn; nhãn/tên dài kết thúc bằng "…" kèm tooltip.

## 6. Ước tính

2–3 ngày làm việc.
