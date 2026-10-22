# SPEC — Redis Browser

> Viết 2026-10-21. Trạng thái: **Đã code W3 (chưa commit).** Đợt **W3** (sau `SPEC-STREAM-SHELL.md`).
> **Cập nhật 2026-10-22** — đã code, chưa commit. Các quyết định sau ngày viết spec được ghi ở bảng §0 (cột "Ai chốt") và mục Lối vào (§3–§4); phần nào mâu thuẫn với chúng thì phần mới thắng.
> Bản phác thảo: màn hình 2 (Redis — Browser) — https://claude.ai/artifact/KYsTkPaP7QczcFiZowTJgt
> Nguyên tắc chung (additive, không bịa số liệu, định nghĩa xong): `SPEC-STREAM-SHELL.md` §1.
> Mọi `file:line` đọc ở commit `f702b6a`.

---

## 0. Quyết định đã chốt

| # | Quyết định | Ai chốt |
|---|---|---|
| X1 | **Bỏ hẳn kiểu "mỗi key một tab"** — chọn key thì chi tiết hiện ở khung bên phải của Browser | Người dùng |
| X2 | Analysis (bộ nhớ theo prefix) để sau | Đề xuất |

---

## 1. Browser (mục chính)

- Danh sách key = `StreamTable` (kiểu, key, TTL, size) + khung chi tiết bên phải = `RedisKeyView` nhúng ở chế độ
  panel (prop `embedded`), **không mở tab mới**.
- Gom toàn bộ chức năng của `RedisExplorer.svelte` vào Browser: SCAN có trần + "Scan more", đổi db, lọc pattern,
  lọc theo kiểu, Add key, Flush, chế độ cây theo prefix. Nút **List / Tree** chuyển hai cách xem.
- Thanh số liệu đầu trang: Keys · Memory/maxmemory · Clients · Ops/s (từ `INFO`).
- Size/encoding chỉ đo cho **các key đang hiện trên màn hình** (§3), không đo cả keyspace.

## 2. Mục khác

| Mục | Nguồn |
|---|---|
| Workbench | CLI console có sẵn trong `RedisWorkspace.svelte` (hiện không ai mở) |
| Pub/Sub | `RedisPubSub` có sẵn |
| Slowlog | **mới** `redis_slowlog(count)` → `SLOWLOG GET`, bảng (id, thời điểm, µs, lệnh, client) |
| Server info | **mới** `redis_info()` dùng lại `parse_redis_info` (`commands/admin.rs:14`), hiển thị theo section |

## 3. Backend mới (`drivers/redis.rs`, `commands/redis.rs`)

- `redis_slowlog(count)`, `redis_info()` (như trên).
- `redis_key_meta(keys[])` — pipeline `MEMORY USAGE` + `OBJECT ENCODING` cho danh sách key (một round-trip);
  key không tồn tại → None. Có sẵn `memory_usage` từng key (`redis.rs:336`) — hàm mới chỉ gộp theo lô.
- Rename key: dùng `redis_command` có sẵn (`RENAME`), không cần lệnh riêng.

Mỗi lệnh: case trong `demo.ts`, wrapper `ipc.ts`, đăng ký `lib.rs`.

## 4. Lối vào

- Không có cây Explorer (`SPEC-STREAM-SHELL.md` D4); `RedisExplorer.svelte` đã xoá. Chọn connection = mở Browser
  (chọn db ở thanh trên). Xoá theo prefix nằm ở chế độ Tree của Browser.
- **Tab `redis`, `redis-key`, `redis-pubsub` đã xoá** (tab cũ đã lưu khôi phục thành Browser + key / Pub/Sub).
- Sửa **từng phần tử** (Hash value/field, List theo vị trí, Set member, Sorted set member + score) bằng một lệnh
  Lua atomic mỗi thao tác; xoá phần tử List theo vị trí (trước đây `LREM 0` xoá mọi phần tử trùng giá trị).

## 4b. Từ ngữ hiển thị (theo `SPEC-STREAM-SHELL.md` §1b)

| Khái niệm Redis | Hiển thị | Tooltip / ghi chú |
|---|---|---|
| Kiểu STRING / HASH / LIST / SET / ZSET / STREAM | **Text · Hash · List · Set · Sorted set · Stream** (nhãn có màu, chữ thường) | Một câu mỗi kiểu |
| TTL | **Expires in** 23 min · **Never** | Tooltip giờ hết hạn chính xác |
| db0, db1 | **Database 0** · 12,480 keys | — |
| `instantaneous_ops_per_sec` | **Commands / second** | — |
| `used_memory` / `maxmemory` | **Memory used** 48.2 MB of 2 GB | "No limit" khi maxmemory = 0 |
| Encoding (listpack, hashtable…) | chỉ trong *Advanced* của key | — |
| SLOWLOG | mục **Slow commands** (thời gian theo ms, lệnh rút gọn, client) | Ngưỡng hiện tại của server ghi rõ |
| FLUSHDB | **Delete all keys in Database 0** (U8: ghi số key) | — |

Server info hiện theo nhóm dễ đọc (Server · Memory · Clients · Persistence · Replication) với nhãn ngắn; bảng
INFO gốc nằm sau *Raw*.

## 5. Test

- **Integration** (container `redis:7-alpine`): slowlog có entry sau khi đặt `slowlog-log-slower-than 0`;
  `redis_key_meta` đúng size/encoding cho 5 kiểu dữ liệu; key không tồn tại → None; INFO có đủ section chính.
- **E2e:** chọn key không mở tab mới; sửa giá trị / Set TTL / Delete trong panel; List ↔ Tree; "Scan more" vẫn
  chạy; đổi db vẫn có chỉ báo đang quét.
- Spec cũ phải chuyển: `redis-explorer`, `redis-db-dropdown`, `payload-viewer` (phần Redis).

## 6. Ngoài phạm vi

Analysis (X2), giải mã MessagePack.

## 7. Ước tính

4 ngày làm việc.
