# SPEC — RabbitMQ workspace

> Viết 2026-10-21. Trạng thái: **Đã code W2 (chưa commit).** Đợt **W2** (sau `SPEC-STREAM-SHELL.md`).
> **Cập nhật 2026-10-22** — đã code, chưa commit. Các quyết định sau ngày viết spec được ghi ở bảng §0 (cột "Ai chốt") và mục Lối vào (§3–§4); phần nào mâu thuẫn với chúng thì phần mới thắng.
> Bản phác thảo: màn hình 7 (Overview), 8 (Queues › chi tiết) —
> https://claude.ai/artifact/KYsTkPaP7QczcFiZowTJgt
> Nguyên tắc chung (additive, không bịa số liệu, định nghĩa xong): `SPEC-STREAM-SHELL.md` §1.
> Mọi `file:line` đọc ở commit `f702b6a`.

---

## 0. Quyết định đã chốt

| # | Quyết định | Ai chốt |
|---|---|---|
| R1 | RabbitMQ được đưa vào khung chung (trước đó chưa có trong bản phác thảo) | Người dùng |
| R2 | Giữ nguyên các màn hình đang có: chi tiết queue/exchange, Live, form tạo, Users & access | Đề xuất |

---

## 1. Mục và nguồn dữ liệu

| Mục | Nội dung | Nguồn |
|---|---|---|
| Overview | Thẻ (ready, unacked, queues, consumers, connections, alarms) + **biểu đồ publish/deliver/ack** + queue cần chú ý + Nodes tóm tắt | `rabbit_overview` (thêm field tốc độ, §2) + `rabbit_nodes` |
| Queues | `StreamTable` (tên, type, features, ready, unacked, consumers, in/s, out/s) → chi tiết nhúng `RabbitQueueView` + tab **Consumers** mới | `rabbit_queues` (thêm tốc độ) + `rabbit_consumers` |
| Exchanges | Bảng → chi tiết nhúng `RabbitExchangeView` | có sẵn |
| Connections | Bảng (client, user, vhost, channels, TLS, nhận/gửi) + **Close connection** (confirm) | **mới** |
| Nodes | Bảng (memory/ngưỡng, disk free/limit, file descriptors, processes, uptime, alarm) | **mới** |
| Users & access | Nhúng `RabbitUserManager` | có sẵn |

Biểu đồ tốc độ: frontend lấy mẫu `rabbit_overview` mỗi 5 s khi mục Overview đang hiển thị (dừng khi tab ẩn),
giữ 10 phút gần nhất (`RateChart` của khung chung).

"Queue cần chú ý" = không có consumer mà còn message · có message chờ ở queue dead-letter · unacked cao so với
số consumer. Chỉ dựa trên số liệu API trả về.

## 2. Backend mới (`drivers/rabbitmq.rs`, `commands/rabbitmq.rs`)

- `RabbitOverview` (`rabbitmq.rs:57`) + `RabbitQueue`: thêm field **optional** `publish_rate`, `deliver_rate`,
  `ack_rate` (đọc `message_stats.*_details.rate`) — sửa `parse_overview` (`:277`), `parse_queue` (`:315`).
- `rabbit_nodes` → `GET /api/nodes`
- `rabbit_connections` → `GET /api/connections`
- `rabbit_close_connection(name)` → `DELETE /api/connections/{name}`
- `rabbit_consumers(vhost)` → `GET /api/consumers/{vhost}`
- Lỗi 401 thiếu tag dùng lại `missing_tag` (user không có `monitoring`/`administrator` → nói rõ thiếu tag nào).

Mỗi lệnh: case trong `demo.ts` (demo broker stateful `src/lib/rabbitmq/demo.ts`), wrapper `ipc.ts`, đăng ký
`lib.rs`.

## 3. Lối vào

- Không có cây Explorer (`SPEC-STREAM-SHELL.md` D4); `RabbitExplorer.svelte` đã xoá. Chọn connection = mở
  workspace ở mục Queues, tự chọn queue đầu A→Z; ô chọn virtual host nằm trên header workspace.
- `openRabbitQueue` / `openRabbitExchange` (`stream/rabbitmq-nav.ts`) mở `openStreamWorkspace(conn, 'queues' |
  'exchanges', name)`. **Tab `rabbit-queue` / `rabbit-exchange` đã xoá** cùng các method cũ trong `tabs`;
  `RabbitQueueView` / `RabbitExchangeView` chỉ còn dùng nhúng trong workspace.

## 3b. Từ ngữ hiển thị (theo `SPEC-STREAM-SHELL.md` §1b)

| Khái niệm RabbitMQ | Hiển thị | Tooltip / ghi chú |
|---|---|---|
| Ready | **Waiting** | Messages no consumer has picked up yet |
| Unacknowledged | **In progress** | Delivered to a consumer, not confirmed yet |
| Feature D / AD / Excl | **Durable** · **Auto-delete** · **Exclusive** (chip chữ đầy đủ) | Một câu mỗi chip |
| `x-message-ttl` | **Messages expire after 1 day** | Advanced: tên argument thật |
| `x-dead-letter-exchange` | **Failed messages go to** `payments.dlx` (link) | — |
| `x-delivery-limit` | **Max 5 delivery attempts** | — |
| `x-max-length` | **Keeps at most 10,000 messages** (+ hành vi khi đầy) | — |
| Prefetch | **Messages held at once** | Advanced: prefetch count |
| Consumer tag, channel | ẩn trong *Advanced*; hiện tên ứng dụng client + máy | — |
| Memory high watermark | **Memory limit** | Above it, publishers are paused |
| Disk free limit | **Disk safety margin** | Below it, publishers are paused |
| File descriptors, Erlang processes | chỉ trong *Advanced* của Nodes | — |
| publish/deliver/ack rate | **Incoming / Delivered / Confirmed per second** | — |

Arguments của queue hiện dạng danh sách câu đọc được (U3); bảng `x-*` gốc nằm sau *Advanced*.
"Queue cần chú ý" luôn kèm **lý do bằng lời** và **hành động gợi ý** (vd. "No consumers — 2,104 messages
waiting. *Open queue*").

## 4. Test

- **Integration** (container `rabbitmq:3.13-management-alpine`, `tests/rabbitmq_integration.rs`): publish liên
  tục → tốc độ > 0; nodes có memory/disk; connection mở bằng client test xuất hiện rồi đóng được; consumer
  đăng ký hiện đúng queue/prefetch; user thiếu tag nhận lỗi thiếu tag, không phải "Authentication failed".
- **E2e:** Overview có biểu đồ; Queues → chi tiết → Consumers; Close connection có confirm.
- Spec cũ phải chuyển: `rabbitmq`.

## 5. Ngoài phạm vi

Channels, Export/Import definitions, Shovel/Federation — làm sau khi khung ổn định.

## 6. Ước tính

5–6 ngày làm việc.
