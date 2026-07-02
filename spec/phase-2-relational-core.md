# Phase 2 — Relational Core

**Mục tiêu:** Nâng cấp trải nghiệm SQL editor và data viewer — autocomplete, sửa dữ liệu trực tiếp, lịch sử query, DDL tools.
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
- [ ] SQL keywords theo dialect (PG / MySQL / MSSQL)
- [ ] Trigger reload schema khi đổi connection trong tab

### 2. SQL Editor bổ sung
- [ ] Format SQL `Ctrl+Shift+F` (sql-formatter lib, dialect-aware)
- [ ] Explain / Explain Analyze: gửi lệnh, nhận kết quả text (visual plan → Phase 5)
- [ ] Query history: lưu mỗi query đã chạy vào SQLite (connection, timestamp, duration, sql, row count)
- [ ] Panel history: search theo text, click để paste vào editor
- [ ] Snippets: lưu đoạn SQL có tên, mở bằng shortcut / command palette

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
- Sửa cell trực tiếp trong grid, Apply → database cập nhật
- Xem lịch sử query, click paste lại vào editor
- Switch result sang JSON mode, copy toàn bộ
- Filter builder tạo WHERE clause không cần viết tay
- Right-click table → View DDL → thấy CREATE statement
