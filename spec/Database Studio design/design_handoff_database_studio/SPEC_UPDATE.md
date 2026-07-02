# Spec Update — Database Studio (Handoff cho Claude Code)

> Nguồn: kết quả `runSelfTest()` chạy trong prototype `Database Studio.dc.html`
> (41 test case, tự động phát hiện hardcode & UI shell). Tài liệu này mô tả
> **trạng thái thật của từng tính năng** và **việc cần làm khi code thật**.
> Prototype hiện chạy hoàn toàn trên in-memory store — chưa có backend/DB thật.

---

## 0. Bối cảnh & nguyên tắc

- Prototype là **client-only**: mọi dữ liệu nằm trong `store()` (in-memory), không có network layer.
- Mục tiêu spec này: chỉ rõ **feature nào đã có logic đúng** (chỉ cần thay data-source bằng backend thật) và **feature nào mới chỉ là vỏ UI / dữ liệu cứng** (phải viết mới).
- Quy ước phân loại:
  - **REAL** — logic hoạt động đúng theo input, giữ nguyên hành vi, chỉ nối vào backend.
  - **SHELL** — chỉ gọi `flash()`/toast, không có side-effect → cần implement thật.
  - **HARDCODED** — output không đổi theo input → cần thay bằng tính toán thật.
  - **NEEDS-REAL-IO** — logic đúng ở mức mô hình nhưng chưa ghi ra DB/file thật.

---

## 1. Query Engine (execSql) — REAL, giữ logic, nối backend

**Trạng thái:** engine SQL thật (SELECT / WHERE / JOIN / ORDER BY / LIMIT) chạy đúng trên
store cho: Postgres, MySQL, MariaDB, MSSQL, ClickHouse, SQLite, Cassandra.
Redis / Kafka / NATS **đúng khi từ chối SQL** (không phải hệ quan hệ).

**Việc cần làm khi code thật:**
- Thay `execSql(connId, sql)` in-memory bằng lời gọi driver thật theo `conn.system`
  (pg, mysql2, tedious/mssql, @clickhouse/client, better-sqlite3, cassandra-driver).
- Giữ nguyên **shape trả về** mà UI đang phụ thuộc:
  `{ ok: boolean, result?: { cols: [[name,type],...], rows: [...], total: number }, error?: string }`.
- Redis/Kafka/NATS: không route qua SQL — dùng client riêng (xem mục 6).
- Bổ sung: prepared statements / tham số hóa để chống SQL injection (prototype nối chuỗi trực tiếp — **không** bê nguyên lên production).
- `total` phải là tổng số row thật của query (cho phân trang), không phải `rows.length`.

---

## 2. Import Wizard — REAL, input-sensitive, nối commit thật

**Trạng thái:** `runImport()` đọc `impRows`/`impMapping`/`impHeaders` và commit **đúng số row**
vào store (file 2 row → inserted 2; file 5 row → inserted 5). **Không hardcode.**

**Việc cần làm khi code thật:**
- Giữ nguyên pipeline parse → preview → mapping → `runImport()`.
- Thay bước commit (đang push vào `store[cid][table].rows`) bằng **batch INSERT** thật qua driver, trong 1 transaction; rollback nếu lỗi.
- Trả về `impResult = { inserted, failed, errors[] }` thật từ DB thay vì đếm client-side.
- Thêm validate kiểu dữ liệu theo `table.cols` trước khi insert (hiện chỉ map theo tên cột).
- Hỗ trợ file lớn: stream/chunk thay vì đọc toàn bộ vào `impRows`.

---

## 3. Export / Dump — NEEDS-REAL-IO (logic đúng, chưa ghi file server)

**Trạng thái:** `runExport()` build **Blob thật** từ row của engine (JSON/SQL...),
nội dung đổi theo bảng được chọn. Đúng ở phía client.

**Việc cần làm khi code thật:**
- Với dataset lớn phải **stream export từ server** (query có `WHERE`/`LIMIT` chạy trên DB),
  không kéo hết row về client rồi mới tạo Blob.
- Hỗ trợ đầy đủ format đang liệt kê trong UI (JSON, CSV, SQL INSERT, custom dump) — kiểm tra từng format sinh output hợp lệ.
- Đặt tên file, encoding, escape đúng chuẩn từng dialect.

---

## 4. Backup / Restore — NEEDS-REAL-IO (mô hình đúng, chưa gọi tool thật)

**Trạng thái:** `runBackup()` **thêm entry lịch sử thật** (`backupHistory[connId]`, có `timestamp`,
`sizeMB`, `status:'completed'`). Restore mở dialog, có state. Nhưng `sizeMB` là số random,
chưa có file backup thật.

**Việc cần làm khi code thật:**
- `runBackup()`: gọi tool thật theo hệ (`pg_dump`, `mysqldump`, `sqlcmd`/BACKUP DATABASE, ...) hoặc API backup của hạ tầng; lưu artifact vào object storage.
- Entry lịch sử phải mang `sizeMB` thật, đường dẫn/URL artifact, log, và `status` phản ánh kết quả job (async: `running → completed/failed`).
- `downloadBackup(b)` hiện là **SHELL** (chỉ toast) → phải trả file/artifact thật (signed URL hoặc stream).
- `askRestore()/restore`: nối vào job restore thật + xác nhận + kiểm tra quyền; hiện chỉ có UI + progress giả.

---

## 5. Structure Compare (Schema Diff) — HARDCODED, cần viết lại từ đầu

**Trạng thái (⚠ FAIL trong self-test):**
- `cmpSyncScript()` sinh script **giống hệt nhau bất kể** chọn source/target là cặp nào
  (`c1→c7` và `c2→c9` cho cùng output) vì đọc từ mảng cứng `CMP_DIFF`.
- `executeMigration()` chỉ **đổi field `status` trong mảng diff client-side**, không ghi schema DB thật.
- `openCompare()` mở workspace thật (OK).

**Việc cần làm khi code thật (đây là phần rủi ro nhất — làm lại toàn bộ):**
1. Bỏ mảng `CMP_DIFF` cứng.
2. Đọc schema thật của **source** và **target** (từ `information_schema` / catalog theo dialect): tables, columns (type/nullable/default), indexes, keys, views/definition.
3. Tính diff thật giữa 2 schema → danh sách thay đổi (added/removed/changed) — **output phải đổi theo cặp connection được chọn** (chính là điểm test sẽ verify lại).
4. `cmpSyncScript()` sinh DDL migration thật từ diff (CREATE/ALTER/DROP) theo đúng dialect target.
5. `executeMigration()` chạy DDL trên **target thật** trong transaction (nếu dialect hỗ trợ), có dry-run + rollback + xác nhận.
6. Chặn khi source/target khác hệ CSDL hoặc không tương thích.

---

## 6. Toolbar / Context-menu shells — SHELL, cần implement thật

Các handler dưới đây hiện **chỉ gọi `flash()`/toast**, không có side-effect:

| Handler | Hiện tại | Cần làm |
|---|---|---|
| `exGrant` (🔒 Users & privileges) | Toast "Manage users & privileges" | UI + backend GRANT/REVOKE thật: list users/roles, quyền theo object, apply lệnh GRANT/REVOKE theo dialect |
| `testConn(id)` | Toast "connection successful" | Ping/handshake thật tới DB, đo latency thật, báo lỗi thật (auth/timeout/host) |
| `copyConnStr(id)` | Copy chuỗi vào clipboard | Giữ được, nhưng cân nhắc **ẩn/không nhúng password** vào connection string |
| `downloadBackup(b)` | Toast (xem mục 4) | Trả artifact thật |

Ngoài ra rà lại toàn bộ nút được đánh dấu "UI shell" trong FEATURES.md theo cùng nguyên tắc: nút nào chỉ toast thì phải nối logic.

---

## 7. Redis / Kafka / NATS — client chuyên biệt (không dùng SQL)

**Trạng thái:** self-test xác nhận đúng khi **từ chối SQL**. Prototype có UI browser cho key/topic/subject
nhưng chạy trên store giả.

**Việc cần làm:**
- Redis: nối `redis`/`ioredis` — key browser, TTL (`redisSetTTL`), hash fields (`redisAddField`/`redisDelField`), Pub/Sub monitor phải bind vào lệnh thật.
- Kafka: nối `kafkajs` — list topics, consume/produce, consumer groups.
- NATS: nối `nats.js` — subjects, publish/subscribe.

---

## 8. CANNOT-VERIFY qua console — cần kiểm thử thủ công / e2e

Những thứ self-test **không** kết luận được (cần UI thật, không test qua console):
- Animation/transition (`flash` slide-in, progress bar backup, spinner).
- Hành vi download file thật ở trình duyệt (bị mock trong test).
- Kết quả ghi DB/file thật của Migration/Backup/Export (test chỉ kiểm mô hình client).

→ Sau khi có backend, viết **integration/e2e test** cho các mục 3, 4, 5 để thay thế phần "CANNOT-VERIFY".

---

## 9. Thứ tự ưu tiên đề xuất

1. **Nền tảng:** network/driver layer + connection registry thật (bật mục 1).
2. **Mục 5 (Structure Compare)** — rủi ro cao nhất, hiện hoàn toàn hardcode.
3. **Mục 4 + 3 (Backup/Restore + Export)** — nối tool/stream thật.
4. **Mục 6 (Grant / testConn / downloadBackup)** — bỏ shell.
5. **Mục 7 (Redis/Kafka/NATS)** — client riêng.
6. **Mục 2 (Import)** — chuyển commit sang transaction thật + validate.
7. **Security pass:** tham số hóa query (mục 1), ẩn credential (mục 6), phân quyền cho migration/restore.

---

## 10. Tự kiểm chứng lại sau khi code

Sau mỗi phần, chạy lại `runSelfTest()` trong prototype tương đương (hoặc port sang test backend) và kỳ vọng:
- Mục 5: `Structure Compare · diff source` chuyển từ **FAIL → PASS** (script đổi theo cặp connection).
- Mục 6: các dòng `UI shell` chuyển từ "toast only" sang có side-effect thật.
- Mục 3/4: chuyển từ **CANNOT-VERIFY** sang **PASS** khi có integration test xác nhận ghi thật.
