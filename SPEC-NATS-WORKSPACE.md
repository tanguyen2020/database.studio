# SPEC — NATS workspace

> Viết 2026-10-21. Trạng thái: **Đã code W4 (chưa commit).** Đợt **W4** (sau `SPEC-STREAM-SHELL.md`).
> **Cập nhật 2026-10-22** — đã code, chưa commit. Các quyết định sau ngày viết spec được ghi ở bảng §0 (cột "Ai chốt") và mục Lối vào (§3–§4); phần nào mâu thuẫn với chúng thì phần mới thắng.
> Bản phác thảo: màn hình 6 (NATS — KV buckets) — https://claude.ai/artifact/KYsTkPaP7QczcFiZowTJgt
> Nguyên tắc chung (additive, không bịa số liệu, định nghĩa xong): `SPEC-STREAM-SHELL.md` §1.
> Mọi `file:line` đọc ở commit `f702b6a`.

---

## 0. Quyết định đã chốt

| # | Quyết định | Ai chốt |
|---|---|---|
| N1 | ~~Object store UI và Core subjects để sau~~ → **Đã làm (2026-10-22):** mục **Object stores** + mục **Publish & subscribe**, thay hẳn tab NATS cũ | Người dùng |
| N2 | **Streams là cây Stream → Subject**: subject nằm dưới stream của nó, thu/mở bằng chevron, double-click, ←/→ hoặc nút Collapse all / Expand all; lọc theo tên stream hoặc subject | Người dùng (2026-10-22) |

---

## 1. Mục và nguồn dữ liệu

| Mục | Nội dung | Nguồn |
|---|---|---|
| Overview | Phiên bản server, JetStream bật/tắt, **dung lượng account** (memory/storage, số stream, consumer) | `nats_info` (`server_info`, `nats.rs:111`) + **mới** `nats_account_info` |
| Streams | Bảng stream → chi tiết: Subjects (nhúng `NatsSubjectMessages`, giữ phân trang theo con trỏ + search subject) · Consumers · Config | `nats_js_*` có sẵn (`NatsWorkspace.svelte`) |
| KV buckets | Danh sách bucket (keys, history, TTL, storage, size) → keys (value, **revision**, thời điểm) → chi tiết: value + **lịch sử** + **Watch** | `nats_kv_*` có sẵn (`nats.rs:118-175`) + lệnh mới §2 |
| Object stores | Bucket (tạo bằng form trong app, báo trùng tên) → file (upload/download trên desktop, xoá có xác nhận nêu tên + dung lượng); xoá bucket nêu số file | `nats_obj_*` có sẵn |
| Publish & subscribe | **Listen** một subject (kiểm subject hợp lệ, Pause/Stop/Clear, giữ nghe khi xem mục khác, dừng khi đóng tab) · **Send**: Publish hoặc Request (chờ reply có thời hạn, báo "không ai trả lời" bằng lời) | `nats_subscribe/publish/request` có sẵn |

## 2. Backend mới (`drivers/nats.rs`, `commands/nats.rs`)

| Lệnh | API async-nats | Ghi chú |
|---|---|---|
| `nats_account_info` | `jetstream::Context::query_account` | memory/storage dùng và giới hạn |
| `nats_kv_status(bucket)` | `kv::Store::status` | history, TTL, storage, số key, bytes |
| `nats_kv_entry(bucket, key)` | `kv::Store::entry` | value kèm revision + thời điểm (thay `nats_kv_get` ở màn hình mới; lệnh cũ giữ) |
| `nats_kv_history(bucket, key)` | `kv::Store::history` | gồm cả marker DEL/PURGE |
| `nats_kv_watch(bucket, pattern)` / `nats_kv_unwatch` | `kv::Store::watch` | Đẩy event qua Tauri; dừng khi đóng tab hoặc disconnect |

**Kiểm trước khi code:** xác nhận phiên bản async-nats đang dùng có đủ các API trên.

Mỗi lệnh: case trong `demo.ts`, wrapper `ipc.ts`, đăng ký `lib.rs`.

## 3. Lối vào

- Không có cây Explorer (`SPEC-STREAM-SHELL.md` D4): chọn connection NATS = mở workspace ở mục Streams, tự chọn
  stream đầu và subject đầu A→Z.
- `openNatsSubject` mở workspace (mục Streams, stream + subject). **Tab `nats` và `nats-subject` đã xoá**
  cùng `NatsWorkspace.svelte` và `tabs.openNatsTab`; tab cũ đã lưu khôi phục thành mục tương ứng.
- **Mở message theo sequence** (Peek của tab cũ) — đã làm 2026-10-22: ô "# Sequence" + "Open message" trong chi tiết
  stream, mở popup xem message; số không hợp lệ báo bằng lời trước khi hỏi server; server không còn message đó →
  "There is no message #N in STREAM. It was deleted or expired…" kèm khoảng sequence stream đang giữ.

## 3b. Từ ngữ hiển thị (theo `SPEC-STREAM-SHELL.md` §1b)

| Khái niệm NATS | Hiển thị | Tooltip / ghi chú |
|---|---|---|
| JetStream | **Persistence (JetStream)** — Enabled / Disabled | Stores messages so they can be read later |
| KV bucket | **Key-value bucket** | — |
| Revision | **Version** #48 | — |
| History (cấu hình bucket) | **Versions kept** 10 | — |
| Marker PUT / DEL / PURGE | **Updated · Deleted · Cleared** | — |
| Bucket TTL | **Keys expire after** 30 min · **Never** | — |
| Storage file / memory, Replicas | **Stored on disk / in memory · 3 copies** | — |
| Watch | **Watch for changes** (nút bật/tắt + chỉ báo đang theo dõi) | — |
| Account limits | **Storage used** 1.8 GB of 10 GB | — |

## 4. Test

- **Integration** (container `nats` chạy `-js`): put 3 lần → history 3 revision đúng thứ tự; delete tạo marker
  DEL; status trả history/TTL đúng cấu hình bucket; watch nhận put mới; account info có số stream đúng.
- **E2e:** KV bucket → key → lịch sử; Watch hiện thay đổi mới; Overview có dung lượng.
- Spec cũ phải chuyển: `nats-workspace`, `nats-pagination`, `nats-subject-search`, `streaming-explorer` (phần
  NATS), `message-actions`, `payload-viewer` (phần NATS).

## 5. Ngoài phạm vi

NKey/JWT.

## 6. Ước tính

3–4 ngày làm việc.
