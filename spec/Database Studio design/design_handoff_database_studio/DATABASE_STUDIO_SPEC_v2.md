# Database Studio — Spec v2 (Bản để Vibe Code)

> **Mục đích:** tài liệu tự đủ để bắt đầu code thật. Hợp nhất 3 nguồn:
> 1. Product spec gốc (`uploads/overview.md`) — tầm nhìn, tech stack, roadmap.
> 2. Feature catalog của prototype (`README.md` / `FEATURES.md`) — toàn bộ tính năng đã dựng.
> 3. Kết quả `runSelfTest()` — **trạng thái thật** của từng tính năng (logic thật vs vỏ UI vs hardcode).
>
> **Source of truth về UI/hành vi:** `Database Studio.dc.html` (đọc cả markup lẫn `class Component`).
> Prototype hiện chạy 100% trên **in-memory mock store**, chưa có backend/DB thật.
> HTML là bản tham chiếu thiết kế — **dựng lại trong codebase thật, không ship HTML**.
>
> Cập nhật: 01/07/2026.

---

## 0. Cách đọc nhãn trạng thái (QUAN TRỌNG)

Mỗi tính năng được gắn 1 nhãn để bạn biết cần làm gì khi code thật:

| Nhãn | Ý nghĩa | Hành động |
|---|---|---|
| ✅ **REAL** | Logic prototype đúng & phản ứng theo input (đã test tự động). | Giữ hành vi + shape trả về, chỉ thay data-source bằng backend thật. |
| 🟡 **NEEDS-REAL-IO** | Logic mô hình đúng nhưng chưa ghi ra DB/file/hạ tầng thật. | Nối vào I/O thật (dump tool, stream, transaction). |
| 🟠 **MOCK-UI** | UI dựng đầy đủ nhưng chạy trên dữ liệu giả/tĩnh (chưa test bằng harness). | Nối vào nguồn dữ liệu thật; verify từng cái. |
| 🔴 **SHELL** | Chỉ gọi `flash()`/toast, **không có side-effect**. | Phải implement thật từ đầu. |
| ⛔ **HARDCODED** | Output **không đổi theo input** (đã test & FAIL). | Bỏ dữ liệu cứng, tính toán thật. |

> Nhãn ✅/⛔/🔴 dựa trên `runSelfTest()` đã chạy thực tế. Nhãn 🟠 **MOCK-UI** là các tính năng
> chưa được harness kiểm; mặc định coi là chạy trên mock data và **cần verify** khi wiring backend.

---

## 1. Tổng quan sản phẩm

**Database Studio** — desktop client cá nhân kiểu IDE, một cửa sổ, dark theme mặc định (có light theme),
quản lý **10 hệ thống** qua một giao diện thống nhất với **màu nhận diện riêng từng hệ thống**.
Mục tiêu: nhẹ, nhanh, keyboard-first, không cần server.

**Bố cục:** Title bar → Sidebar (connection list + object explorer, resize được) → Tab bar →
Editor toolbar → Workspace trung tâm (SQL editor + result grid, hoặc trình duyệt chuyên biệt) →
Status bar. Có Object Properties panel bên phải (resize/thu gọn).

---

## 2. Hệ thống hỗ trợ (10) — cập nhật so với spec gốc

> ⚠️ Spec gốc chỉ nêu 6 hệ (PG/MySQL/MSSQL/Redis/Kafka/NATS). Prototype đã **mở rộng thành 10**:
> thêm **MariaDB, SQLite, ClickHouse, Cassandra**. Đây là danh sách chuẩn.

| Hệ thống | Nhóm | Port | Quoting định danh | Workspace |
|---|---|---|---|---|
| PostgreSQL | Relational | 5432 | `"..."` | SQL editor + grid |
| MySQL | Relational | 3306 | `` `...` `` | SQL editor + grid |
| MariaDB | Relational | 3306 | `` `...` `` | SQL editor + grid |
| SQL Server (MSSQL) | Relational | 1433 | `[...]` | SQL editor + grid |
| SQLite | Embedded | (file) | `"..."` | SQL editor + file tree |
| ClickHouse | Analytical | 8123 | `` `...` `` | SQL editor + grid |
| Cassandra | Wide Column | 9042 | `"..."` | CQL editor + grid |
| Redis | Cache | 6379 | — | Key browser |
| Kafka | Streaming | 9092 | — | Topic browser |
| NATS | Streaming | 4222 | — | Subject browser |

Mỗi hệ có: accent riêng, icon riêng, badge 2 ký tự (PG/MY/MA/MS/SL/CH/CS/RD/KF/NA), quy tắc quoting riêng —
áp dụng nhất quán ở tab, badge, accent biểu đồ, sidebar, status bar, viền toast.

**Color Identity (dark mode) — lấy từ prototype.** Đối chiếu lại token thật trong `.ds`/`.ds-light`
của `Database Studio.dc.html` trước khi hard-code. Accent tham chiếu: PG `#336791`, MySQL `#F29111`,
MSSQL `#CC2927`, Redis `#D82C20`, Kafka `#8B5CF6`, NATS `#27AE60` (MariaDB/SQLite/ClickHouse/Cassandra
xem trực tiếp trong code).

---

## 3. Kiến trúc & tech stack

**Đề xuất gốc (giữ nguyên nếu làm mới):**
- Desktop shell: **Tauri 2** (Rust) · Frontend: **Svelte 5 + TypeScript** · UI: **shadcn-svelte + Tailwind**
- SQL editor: **CodeMirror 6** (prototype dùng Monaco — chọn 1 khi build) · Data grid: **TanStack Table** (virtualization)
- State: Svelte stores · Storage cục bộ: **SQLite** (rusqlite) cho connections/history/snippets/tabs
- Drivers (Rust): `sqlx` (PG/MySQL/MariaDB), `tiberius` (MSSQL), `rusqlite` (SQLite),
  `clickhouse` client, `scylla`/`cdrs` (Cassandra), `redis-rs` (Redis), `rdkafka` (Kafka), `async-nats` (NATS)
- SSH tunnel: `russh` · Bảo mật mật khẩu: AES-256-GCM + OS keychain

**Luồng:** Frontend ↔ Tauri IPC (async commands) ↔ Rust backend (SSH tunnel optional) ↔ drivers.

> Nếu có codebase sẵn, dùng framework/UI-kit hiện có; vẫn coi HTML là source-of-truth về visual/behavior.

---

## 4. Query Engine — SQL/CQL Editor + Execute

### 4.1 Editor — 🟠 MOCK-UI
- Đa tab, chỉ báo "dirty" (●), **save-before-close**.
- Toolbar: chọn connection, ▶ Run (F5), Format, Explain, nút ngữ cảnh theo hệ.
- Multi-statement: 1 tab chạy nhiều lệnh → nhiều **sub-result tab** (label: `#N table · X rows`,
  `#N ✓ X affected`, `#N ✓ OK`, `#N ✗ error`); có sub-tab **Messages**; chạy tuần tự; dừng ở lỗi
  (tùy chọn "Continue on error").
- **SQL Linting** rule-based (không AI), debounce ~400ms: thiếu `;`, ngoặc lệch, chuỗi chưa khép,
  từ khóa sai (gợi ý), `SELECT *` + JOIN (warning), định danh sai schema. Gạch đỏ/vàng, gutter icon,
  tooltip, panel "Problems".
- **Split Editor**: Split Right/Down, mỗi pane có buffer + grid riêng, chung connection; F5 chạy pane focus.
- CQL editor cho Cassandra. Tab read-only cho DDL/definition viewer.
- Phím tắt: F5 (Run selection-aware), Ctrl+Enter (run tại cursor), Ctrl+S (Saved Queries),
  Ctrl+H (History), Ctrl+F5/Esc (cancel).
- **Cần khi code thật:** autocomplete schema-aware (keywords + table/column từ schema thật + function sig);
  Explain/Explain Analyze visual plan (PG/MySQL/MSSQL); Format đa dialect.

### 4.2 `execSql(connId, sql)` — ✅ REAL (engine chạy đúng)
Đã test 3 dạng query (simple SELECT, SELECT+WHERE, SELECT+JOIN) trên: **Postgres, MySQL, MariaDB, MSSQL,
ClickHouse, SQLite, Cassandra** → trả result đúng, WHERE lọc thật, JOIN ghép cột đúng.
**Redis/Kafka/NATS đúng khi từ chối SQL** (không phải hệ quan hệ).

**Cần khi code thật:**
- Thay engine in-memory bằng driver thật theo `conn.system`.
- **Giữ nguyên shape trả về** UI đang phụ thuộc:
  ```ts
  { ok: boolean, result?: { cols: [name, type][], rows: object[], total: number }, error?: string }
  ```
  `total` = tổng row thật của query (phục vụ phân trang), không phải `rows.length`.
- **Tham số hóa/prepared statements** — prototype nối chuỗi trực tiếp, KHÔNG bê lên production (SQL injection).
- Redis/Kafka/NATS route qua client riêng (mục 9), không qua SQL.

---

## 5. Result Viewer — 🟠 MOCK-UI

4 chế độ (toggle, không reload data): **Grid** (zebra, sticky header, badge NULL, badge kiểu cột,
phân trang khi >50 rows), **JSON** (highlight, fold, Pretty/Compact, wrap, copy, search),
**Single Row** (form dọc, ←/→ chuyển row), **Chart** (builder: Bar/Line/Pie/Area, trục X/Y, agg
sum/avg/count/min/max; render SVG theo accent; export PNG/SVG).

Thêm: **Column filter bar** (substring, đa cột, đếm trực tiếp); **Group By + Aggregation** (group key
+ SUM/AVG/COUNT/MIN/MAX, dòng nhóm thu/mở); **JSON/JSONB cell** (badge `{ }` → modal format + copy);
**chỉnh sửa inline** (highlight thay đổi, context menu ô); chọn/xóa dòng; xuất kết quả.

**Cần khi code thật:** grid virtualization cho dataset lớn (10M+ rows); phân trang **server-side**
(page size 100/500/1000); freeze columns; datetime local/UTC toggle; **editable grid** = pending-changes
buffer → **preview diff → Apply/Discard** commit bằng UPDATE/INSERT/DELETE thật trong transaction.

---

## 6. Import / Export / Backup

### 6.1 Import Wizard (5 bước) — ✅ REAL, input-sensitive
File (kéo-thả/Browse) → Preview → Mapping (cột nguồn→đích + kiểu) → Options (on-conflict/batch/encoding/
skip-header) → Execute (progress + kết quả). Test tự động: file 2 row → `inserted=2`; file 5 row →
`inserted=5`; store tăng đúng → **không hardcode**.

**Cần khi code thật:** thay bước commit (đang push vào store) bằng **batch INSERT thật trong 1 transaction**,
rollback nếu lỗi; validate kiểu theo `table.cols`; `impResult = { inserted, failed, errors[] }` lấy từ DB;
stream/chunk cho file lớn.

### 6.2 Export Wizard — 🟡 NEEDS-REAL-IO
`runExport()` build **Blob thật** từ row engine (CSV/JSON/SQL/Excel/Parquet), nội dung đổi theo bảng chọn.
**Cần:** với dataset lớn phải **stream export từ server** (query WHERE/LIMIT chạy trên DB), không kéo hết
row về client; đảm bảo mọi format sinh output hợp lệ (escape/encoding đúng dialect); đặt tên file chuẩn.

### 6.3 Backup & Restore — 🟡 NEEDS-REAL-IO (+ 🔴 download)
Mở từ context menu connection hoặc palette → tab `backup` theo connection. **Create Backup Now**: scope
(Full / Selected tables), format (`.sql`/`.dump`), gzip; progress bar. **Backup History**: bảng (timestamp/
scope/size/format/status = Completed·Failed·Running), mỗi dòng Restore/Download/Delete. **Restore**: modal
cảnh báo đỏ + checkbox bắt buộc ("I understand this action cannot be undone") trước khi submit; progress + toast.

Test tự động: `runBackup()` **thêm entry lịch sử thật** (có timestamp/sizeMB/status). Nhưng `sizeMB` là số
random, chưa có file thật; `downloadBackup(b)` là **🔴 SHELL** (chỉ toast).

**Cần khi code thật:** gọi tool thật theo hệ (`pg_dump`, `mysqldump`, `sqlcmd`/`BACKUP DATABASE`, …) hoặc API
backup hạ tầng; lưu artifact vào storage; entry mang `sizeMB` thật + đường dẫn artifact + log; job async
(`running → completed/failed`); `downloadBackup` trả file/signed-URL thật; restore nối job thật + kiểm quyền.

---

## 7. Structure Compare / Migrate — ⛔ HARDCODED (viết lại từ đầu — RỦI RO CAO NHẤT)

**Trạng thái (self-test FAIL):**
- `cmpSyncScript()` sinh script **giống hệt nhau bất kể chọn source/target là cặp nào** (`c1→c7` và
  `c2→c9` cho cùng output) vì đọc từ mảng cứng `CMP_DIFF`.
- `executeMigration()` chỉ **đổi field `status` trong mảng diff client-side**, KHÔNG ghi schema DB thật.
- `openCompare()` mở workspace thật (✅ OK).

**Cần code thật (làm lại toàn bộ):**
1. Bỏ mảng cứng `CMP_DIFF`.
2. Đọc schema thật của **source** và **target** từ catalog theo dialect (`information_schema`, `pg_catalog`,
   `sys.*`, `system.*`…): tables, columns (type/nullable/default), indexes, keys, views/definition.
3. Tính **diff thật** giữa 2 schema → added/removed/changed. **Output phải đổi theo cặp connection** (điểm test verify lại).
4. `cmpSyncScript()` sinh DDL migration thật từ diff (CREATE/ALTER/DROP) đúng dialect target.
5. `executeMigration()` chạy DDL trên **target thật** trong transaction (nếu dialect hỗ trợ), có dry-run + rollback + xác nhận.
6. Chặn khi source/target khác hệ hoặc không tương thích.

---

## 8. Sidebar, Explorer, ER Diagram, Designer, Panel toàn cục — 🟠 MOCK-UI

- **Connection list** nhóm theo category (RELATIONAL/ANALYTICAL/WIDE COLUMN/CACHE/STREAMING/EMBEDDED);
  tag môi trường PROD(đỏ)/STG(hổ phách)/DEV(xanh lá)/LOCAL(tím); search/filter; resize.
- **Object Explorer** dạng cây riêng từng hệ (schema→tables/views/functions/procs/triggers/sequences/
  indexes/constraints; SQLite file tree; Cassandra keyspace→partition/clustering key, MV, UDT, UDF, secondary
  index; Redis/Kafka/NATS tree). Icon + màu riêng từng loại object; metadata (số dòng, kiểu khóa);
  refresh node lẻ; pin; context menu phong phú theo loại (xem `overview.md` §3.2 để biết đầy đủ menu items);
  kéo-thả table vào ER.
- **ER Diagram** — xem quan hệ + kéo-thả từ Explorer; diagram trống dựng mới. **Cần:** auto-layout (Dagre),
  zoom/pan/fit, mini-map, cardinality, export PNG/SVG/**Mermaid**. Prototype vẽ SVG tĩnh — nối schema thật.
- **Table Designer** — cột/kiểu/độ dài/nullable/PK/default; **cần** preview DDL trước Apply → chạy ALTER/CREATE thật.
- **Query History** (Ctrl+H) · **Saved Queries** (Ctrl+S; My Queries/Shared/Analytics) · **Session Monitor**
  (auto-refresh, **Kill Session**, sub-tab Lock Monitor) · **Object Properties** (DDL + stats + index) ·
  **Favorites/Recent**. Tất cả đang chạy trên mock — nối truy vấn hệ thống thật + persist vào SQLite cục bộ.

---

## 9. Panel chuyên biệt theo hệ thống — 🟠 MOCK-UI (nối client thật)

- **PostgreSQL:** `pg_stat_activity` (qua Session Monitor); **Extension Manager** (`pg_available_extensions`,
  Install/Drop hiện chỉ flash `CREATE/DROP EXTENSION` → nối lệnh thật).
- **MySQL/MariaDB:** InnoDB status, processlist, temporal helpers.
- **MSSQL:** **Agent Jobs** (`sysjobs`, Start/Stop) · **Session Monitor + Kill** (`dm_exec_requests`) ·
  **Query Store** (top queries, toggle metric, **Force/Unforce plan**) · **Availability Groups** (Always On:
  health, listener, replica role/mode/sync/queue).
- **ClickHouse:** engine badges · **TTL Viewer** (parse TTL → DELETE/MOVE, nút MATERIALIZE TTL).
- **Redis:** Key browser theo kiểu (HASH/STRING/ZSET/LIST/STREAM), TTL (`redisSetTTL`), hash fields
  (`redisAddField`/`redisDelField`), **Pub/Sub Monitor** (pattern glob→regex, Subscribe/Pause, Publish),
  STREAM browser. → nối `redis`/`ioredis`, lệnh thật, SCAN cursor-based, DB selector 0–15, MEMORY USAGE.
- **Kafka:** Topic browser + consumer groups · **Producer modal** (partition/key/headers/payload/schema
  Avro·Protobuf·JSON → trả offset+partition) · **Schema Registry** (subject, version, compatibility). →
  nối `kafkajs`/`rdkafka`, consume theo offset/timestamp, lag per partition, reset offset, Avro decode.
- **NATS:** Subject browser, streams, KV · **Request/Reply** (`_INBOX`, độ trễ vòng) · **Object Store**
  (bucket, object name/size/chunks/modified, Get/Delete/Put). → nối `nats.js`, wildcard `>`/`*`, JetStream đầy đủ.
- **Cassandra:** CQL editor + grid · **Ring Topology** (SVG). → nối driver, local DC, consistency level.

---

## 10. Modal & Wizard — 🟠 MOCK-UI

- **Connection Manager** — tạo/sửa: name/host/port/db/user/password (AES-256)/group/**Environment**, SSH tunnel
  (password/key), SSL. Trường theo hệ: Cassandra (local DC, consistency), SQLite (file path, mode RW/RO/In-Memory),
  **MSSQL Auth** (SQL/Windows/Azure AD/Azure AD-MFA, trường điều kiện). **Test Connection** = 🔴 SHELL (xem mục 11).
  **Cần:** Duplicate/export/import profile (JSON); Quick connect; encrypt qua OS keychain.
- **Delete connection khi đang có tab** — dialog: Cancel / **Close tabs & Delete** / **Force Delete**
  (tab thành "orphaned": badge xám ⚠, banner "Connection đã bị xóa · [Reassign]"). ✅ hành vi này có state thật.
- **New-connection picker** (lưới chọn hệ) · **SQL Dialect Converter** (chuyển SQL giữa dialect + ghi chú) ·
  **Generate Test Data** (Faker, map cột→provider, output SQL) · **Generate Schema/Scripts** (DDL) ·
  **JSON Cell Viewer** · **Command palette** (⌘P, fuzzy actions + recent tabs).

---

## 11. Toolbar / Context-menu SHELL — 🔴 phải implement thật

Các handler chỉ gọi `flash()`/toast, không side-effect (đã test):

| Handler | Hiện tại | Cần làm |
|---|---|---|
| `exGrant` (🔒 Users & privileges) | Toast "Manage users & privileges" | UI + GRANT/REVOKE thật: list users/roles, quyền theo object, apply theo dialect |
| `testConn(id)` | Toast "connection successful · Nms" | Ping/handshake thật, đo latency thật, báo lỗi thật (auth/timeout/host) |
| `copyConnStr(id)` | Copy chuỗi vào clipboard | Giữ được — nhưng **không nhúng password** vào chuỗi |
| `downloadBackup(b)` | Toast (xem §6.3) | Trả artifact/file thật |

> Rà lại **mọi** nút được đánh dấu "UI shell" trong FEATURES.md theo cùng nguyên tắc: nút nào chỉ toast → nối logic thật.

---

## 12. Multi-tab system — 🟠 MOCK-UI (hành vi tab đã thật, cần persist)

Mỗi tab mang đủ context (`id`, `connectionId`, `connectionName`, `systemType`, `contentType`, `title`,
`isPinned`, `isDirty`, `state`). Không có "active connection" global. Tab bar: badge hệ + màu, tên connection,
title, dirty ●, pin icon; overflow scroll + "More tabs"; double-click rename; context menu Pin/Duplicate/Close/
Close Others/Close to Right/Move to new window. Phím tắt Ctrl+T/W/Shift+T/Tab/Shift+Tab/1..9, drag reorder.
Connection-aware: tab mới kế thừa connection tab active; đổi connection trong tab → reload autocomplete;
mất kết nối → banner "Disconnected · Reconnect" không chặn nội dung.

**Cần khi code thật:** persist toàn bộ tabs + state vào SQLite khi đóng app, restore đúng thứ tự (pinned trước);
tab split view (tối đa 2×2).

---

## 13. Hệ thống & tổng quát

Dark + Light theme (toggle title bar) · màu nhận diện nhất quán · toast/flash · toolbar gated theo lựa chọn ·
keyboard-first. **Bảo mật:** mật khẩu AES-256-GCM + OS keychain; SSH key chỉ lưu path; **parameterized queries
cho mọi query** (xem §4.2); Tauri strict CSP, no remote code.

---

## 14. Thứ tự ưu tiên đề xuất (để vibe code)

1. **Nền tảng:** network/driver layer + connection registry thật → bật §4.2 (giữ shape trả về).
2. **§7 Structure Compare** — rủi ro cao nhất, hiện hoàn toàn hardcode.
3. **§6.3 + §6.2 Backup/Restore + Export** — nối tool/stream thật.
4. **§11 SHELL** (Grant / testConn / downloadBackup) — bỏ vỏ.
5. **§9 Redis/Kafka/NATS** — client riêng.
6. **§6.1 Import** — commit sang transaction thật + validate.
7. **§5 editable grid** (pending changes → Apply thật) + **§12 persist tabs**.
8. **Security pass:** parameterize query, ẩn credential, phân quyền migration/restore.

Bám roadmap theo phase trong `overview.md` §5 (Tauri 2 + Svelte 5) nếu làm mới từ đầu.

---

## 15. Tiêu chí tự kiểm chứng sau khi code

Prototype có sẵn hàm `runSelfTest()` (gõ trong DevTools console) in bảng
*Tính năng | Input test | Output thật | Kỳ vọng | PASS/FAIL/CANNOT-VERIFY*. Port ý tưởng này sang test
backend và kỳ vọng:
- **§7:** `Structure Compare · diff source` chuyển **FAIL → PASS** (script đổi theo cặp connection).
- **§11:** các dòng `UI shell` chuyển từ "toast only" sang có side-effect thật.
- **§6.2/§6.3:** chuyển từ **CANNOT-VERIFY** sang **PASS** khi có integration test xác nhận ghi file/DB thật.
- Các mục 🟠 **MOCK-UI**: viết integration test riêng khi wiring backend — harness console không phủ được UI/animation.

---

## 16. Ngoài phạm vi (bản cá nhân)

Multi-user/team sharing · cloud sync · MongoDB · query scheduler · Kafka MirrorMaker · NATS clustering mgmt.

---

## Phụ lục — nguồn tham chiếu trong project

- `Database Studio.dc.html` — prototype đầy đủ (source of truth về UI/hành vi + hàm `runSelfTest()`).
- `uploads/overview.md` — product spec gốc (tầm nhìn, tech stack, roadmap, chi tiết UX từng màn hình).
- `README.md` / `FEATURES.md` — feature catalog đầy đủ.
- `design_handoff_database_studio/README.md` — handoff kỹ thuật (design tokens, màu, state fields, tab types).
- `handoff/SPEC_UPDATE.md` — bản delta ngắn chỉ tập trung "cái nào thật / cái nào cần code lại".
