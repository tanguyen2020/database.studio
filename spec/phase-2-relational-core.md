# Phase 2 — Relational Core

> ⚠️ **Deprecated — checklist kế hoạch lịch sử.** Trạng thái `[ ]`/`[x]` không phản ánh hiện trạng. Nguồn
> sự thật: **code** + `SPEC-INDEX.md` + spec tính năng + `CLAUDE.md`. Giữ để tham chiếu.

**Mục tiêu:** Nâng cấp trải nghiệm SQL editor và data viewer — autocomplete, lint lúc gõ theo dialect (tầng 1), ClickHouse basics, SQLite PRAGMA panel, sửa dữ liệu trực tiếp, lịch sử query, DDL tools.
**Thời gian ước tính:** ~~3–4 tuần~~ → **1–2 tuần** (vibe coding)
**Yêu cầu:** Phase 1 hoàn thành

---

## Checklist

### 1. Schema-aware Autocomplete
- [ ] Sau khi kết nối: fetch schema (tables, columns, views, functions) lưu vào memory cache
- [ ] CodeMirror autocomplete provider: gợi ý table names, column names theo context
- [ ] Gợi ý sau `SELECT`, `FROM`, `WHERE`, `JOIN ... ON`
- [ ] Gợi ý column chỉ của table đang reference (`orders.` → gợi ý columns của orders)
- [ ] Function signatures + return type
- [ ] SQL keywords theo dialect (PG / MySQL / MariaDB / MSSQL / SQLite / ClickHouse)
- [ ] Trigger reload schema khi đổi connection trong tab

### 2. SQL Editor bổ sung
- [ ] Format SQL `Ctrl+Shift+F` (sql-formatter lib, dialect-aware)
- [ ] Explain / Explain Analyze: gửi lệnh, nhận kết quả text (visual plan → Phase 5)
- [ ] Query history: lưu mỗi query đã chạy vào SQLite (connection, timestamp, duration, sql, row count)
- [ ] Panel history: search theo text, click để paste vào editor
- [ ] Snippets: lưu đoạn SQL có tên, mở bằng shortcut / command palette

### 2b. Lint lúc gõ — TẦNG 1 (theo `QUERY_EDITOR_ERROR_HANDLING_ADDENDUM.md`)
- [ ] **Syntax lint**: backend dùng `sqlparser-rs` đúng dialect (Generic/PostgreSQL/MySQL/MSSQL/SQLite/ClickHouse), gọi qua Tauri command theo debounce ~400ms, parse-only — KHÔNG chạy DB
- [ ] Parser lỗi/không chắc → im lặng, KHÔNG vẽ squiggle (tránh báo nhầm); **không bao giờ chặn nút Run**
- [ ] **Rule pack đặc thù từng hệ** (semantic lint): PG (backtick sai, gợi ý RETURNING), MySQL/MariaDB (`ONLY_FULL_GROUP_BY`), MSSQL (dùng `TOP` thay `LIMIT`, `[ ]`, `;` trước CTE), SQLite (dynamic typing, RIGHT/FULL JOIN bản cũ), ClickHouse (không `OFFSET` kiểu SQL; UPDATE/DELETE phải là `ALTER TABLE ...`; không transaction; gợi ý `FINAL`)
- [ ] **Cảnh báo schema-aware** (tái dùng cache autocomplete): tên bảng/cột không tồn tại → squiggle vàng "Unknown table/column" + gợi ý fuzzy
- [ ] **Cảnh báo thao tác nguy hiểm**: `UPDATE`/`DELETE` thiếu `WHERE` (nổi bật); `DROP`/`TRUNCATE`/`ALTER ... DROP`
- [ ] Output chuẩn `LintDiagnostic { severity, message, from, to, rule, quickfix? }` → CodeMirror lint extension: squiggle đỏ/vàng, gutter marker, tooltip, quickfix
- [ ] Hoàn thiện ánh xạ vị trí lỗi tầng 2 (PG position, MSSQL line — đã làm cơ bản ở Phase 1)
- [ ] Redis/Kafka/NATS: KHÔNG parse SQL, không squiggle SQL nhầm

### 2c. ClickHouse basics (connect + query — nâng cao → Phase 5; theo `CLICKHOUSE_SPEC_ADDENDUM.md`)
- [ ] Form kết nối ClickHouse: host, port + **chọn protocol** (HTTP 8123 / native 9000), database, user, password, SSL; badge `CH` `#FFCC00`
- [ ] Driver: crate `clickhouse` (HTTP) — tham số hóa qua driver, không nối chuỗi
- [ ] Test connection
- [ ] Explorer tree cơ bản (`clickhouseTree`): Databases → Tables / Views / Dictionaries / Functions; database `system` read-only
- [ ] SQL editor chạy query ClickHouse, giữ shape trả về `{ ok, result: { cols, rows, total }, error }`; `total` dùng ước lượng `system.tables.total_rows`, KHÔNG đếm client-side
- [ ] Render đúng kiểu dữ liệu: `LowCardinality(...)`, `Nullable(...)`, `UInt*/Int*`, `Decimal`, `UUID`, `Date/DateTime/DateTime64`, `Enum`, `FixedString`, `Array/Map/Tuple/Nested`
- [ ] Không bọc query trong transaction (ClickHouse không có BEGIN/COMMIT)
- [ ] Lint rule pack ClickHouse (mục 2b) hoạt động khi connection là ClickHouse

### 2d. SQLite — file header + PRAGMA panel (theo README handoff)
- [ ] Strip **file-info header** trên editor toolbar cho tab SQLite: SL badge, file path, size, `WAL: ON`, SQLite version
- [ ] Nút **Integrity Check** → chạy `PRAGMA integrity_check` thật
- [ ] **PRAGMA panel** thu gọn (4 cột): editable `journal_mode`, `synchronous`, `foreign_keys`, `auto_vacuum` (đổi giá trị → chạy `PRAGMA key=value`); read-only `cache_size`, `page_size`, `page_count`

### 3. Result Grid — Editable
- [ ] Double-click cell → inline edit
- [ ] Insert row mới (empty row cuối grid)
- [ ] Delete row(s) (select + Delete key)
- [ ] Pending changes buffer: highlight row pending màu vàng
- [ ] Toolbar: nút "Apply" và "Discard"
- [ ] Preview diff dialog trước khi Apply: hiện SQL sẽ chạy (UPDATE / INSERT / DELETE)
- [ ] Apply → chạy SQL → refresh grid

### 4. Result Grid — View modes
- [ ] View mode toggle: **Grid** / **JSON** / **Single Row** (toolbar + phím tắt `Ctrl+Alt+G/J/R`)
- [ ] **JSON mode**: syntax highlight, collapsible nodes, Pretty/Compact toggle, word wrap, copy all / copy row, search `Ctrl+F`, pagination
- [ ] **Single Row mode**: form dọc, `←` `→` next/prev row, JSON field render cây, copy field value
- [ ] Inline JSON viewer trong Grid cell (click mở, không popup)

### 5. Table Data Viewer
- [ ] Mở từ Explorer double-click table/view → tab mới `table-viewer`
- [ ] Filter builder UI: chọn column → operator (=, !=, >, LIKE, IS NULL...) → value
- [ ] Nhiều conditions kết hợp AND/OR
- [ ] Sort đa cột: click header, Shift+click thêm cột
- [ ] Single Row mode (dùng lại component từ Result Grid)
- [ ] Pagination

### 6. Object Explorer — Đầy đủ
- [ ] Expand Trigger: event + table gắn với
- [ ] Expand Index: loại (BTREE/HASH/GIN) + columns + unique flag
- [ ] Expand Constraint: loại + definition
- [ ] MSSQL: thêm node Schemas, Table-Valued Functions, Scalar Functions, Synonyms, User-Defined Types
- [ ] MariaDB: dùng chung đường relational tree với MySQL (`selRel === true`)
- [ ] SQLite: hoàn thiện file tree (Views, Triggers; bảng hệ thống 🔒 read-only)
- [ ] ClickHouse: tree cơ bản Databases → Tables/Views/Dictionaries/Functions (engine badge + TTL/partition ops → Phase 5)
- [ ] Right-click context menu đầy đủ:
  - Table: Open Data, New Query, Design Table (Phase 5), Rename, Truncate, Drop, Copy Name, Copy SELECT
  - View: Open Data, View Definition, Rename, Drop, Copy Name
  - Stored Procedure: Open, Execute (dialog params), Rename, Drop
  - Function: Open, Execute/Preview, Rename, Drop
  - Trigger: Open, Enable/Disable, Drop
  - Column: Copy Name, Copy as `table.column`, Set as Filter
- [ ] Search/filter real-time trong sidebar (Ctrl+F)
- [ ] Pin objects lên đầu tree

### 7. DDL Viewer
- [ ] Right-click bất kỳ object → "View DDL" → mở tab SQL Editor với CREATE statement
- [ ] Syntax highlight DDL
- [ ] "Copy DDL" button

### 8. Connection Manager — bổ sung
- [ ] Import / export connection profiles (JSON file)
- [ ] Quick connect form (không lưu, dùng 1 lần)
- [ ] Group connections (folder)

### 9. Multi-Tab — bổ sung
- [ ] Double-click tab title để rename
- [ ] Right-click context menu: Pin / Duplicate / Close Others / Close to the Right
- [ ] Connection dropdown trong tab toolbar → đổi connection, reload autocomplete
- [ ] Banner "Disconnected · Reconnect" khi connection mất

---

## Definition of Done
- Gõ tên table vào editor → autocomplete gợi ý columns đúng
- Gõ SQL sai cú pháp theo đúng dialect → squiggle đỏ trong lúc gõ (best-effort), không chặn Run
- Gõ `LIMIT` ở MSSQL → lint gợi ý dùng `TOP`; `UPDATE`/`DELETE` thiếu `WHERE` → cảnh báo nổi bật
- Kết nối ClickHouse → chạy SELECT trả đúng cột/kiểu (LowCardinality, Nullable, UUID render đúng)
- Tab SQLite hiện file header + PRAGMA panel, đổi `journal_mode` chạy PRAGMA thật
- Sửa cell trực tiếp trong grid, Apply → database cập nhật
- Xem lịch sử query, click paste lại vào editor
- Switch result sang JSON mode, copy toàn bộ
- Filter builder tạo WHERE clause không cần viết tay
- Right-click table → View DDL → thấy CREATE statement

### Test (bắt buộc)
- Unit test đầy đủ cho toàn bộ logic phase này (lint rule pack từng dialect, autocomplete provider, diff pending changes, filter builder → WHERE...)
- Integration test đầy đủ cho **từng hệ trong phase** qua **testcontainers**: PG, MySQL, MariaDB, MSSQL, **ClickHouse** (connect + query + kiểu dữ liệu); SQLite test trên file thật

### UI đối chiếu 1:1 với `Database Studio.dc.html` (bắt buộc)
- Token màu/spacing/font grep trực tiếp từ HTML, không phỏng đoán
- Icon SVG copy nguyên vẹn từ HTML (icon ClickHouse: 4 thanh cột dọc `#FFCC00`)
- Bảng đối chiếu số đo các thành phần của phase (PRAGMA panel, lint squiggle/gutter, view modes...) — không còn dòng lệch
- Snapshot/DOM test cho các component UI mới của phase
