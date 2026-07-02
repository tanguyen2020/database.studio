# Phase 5 — Power User

**Mục tiêu:** Công cụ nâng cao cho developer/DBA — query plan visualizer, table designer, ER diagram, import/export đầy đủ, command palette.
**Thời gian ước tính:** ~~4–5 tuần~~ → **2–3 tuần** (vibe coding)
**Yêu cầu:** Phase 4 hoàn thành

---

## Checklist

### 1. Query Plan Visualizer
- [ ] PostgreSQL: chạy `EXPLAIN (ANALYZE, FORMAT JSON)` → parse kết quả
- [ ] MySQL: chạy `EXPLAIN FORMAT=JSON` → parse
- [ ] MSSQL: parse XML execution plan từ `SET STATISTICS XML ON`
- [ ] Render visual node tree:
  - Mỗi node = 1 box: operation name, estimated cost, actual rows, actual time
  - Arrow nối các nodes theo thứ tự thực thi
  - Chiều rộng arrow tỉ lệ với row count
- [ ] Highlight slow nodes: cost/time vượt threshold → màu đỏ/cam
- [ ] Tooltip per node: hiện chi tiết (loops, width, output columns, filter)
- [ ] Toggle: Estimated Plan / Actual Plan (nếu ANALYZE)
- [ ] Mở từ SQL Editor: `Ctrl+Shift+E` → run Explain, mở tab `query-plan`

### 2. Redis — Power features
- [ ] **Pub/Sub Monitor tab**: subscribe nhiều channels/patterns cùng lúc, stream messages realtime
  - Filter by channel pattern
  - Timestamp · channel · payload
  - Export messages to JSON
- [ ] **Memory Analysis**:
  - Top N keys by memory usage (`MEMORY USAGE` scan)
  - Breakdown by type (String/Hash/List...)
  - Breakdown by prefix
  - Progress bar khi đang scan (SCAN cursor)

### 3. Table Designer GUI
- [ ] Mở từ right-click table → "Design Table" hoặc "New Table"
- [ ] Tab `table-designer` dạng form:
  - Columns grid: tên, data type (dropdown theo dialect), length/precision, nullable, default value
  - Checkboxes: PK, unique, auto-increment / IDENTITY / SERIAL
  - Thêm / xóa / reorder columns
- [ ] Index manager tab trong designer:
  - List indexes, thêm index mới: tên, columns, type (BTREE/HASH/GIN/...), unique flag
  - Xóa index
- [ ] Foreign Key manager:
  - List FKs, thêm FK: columns → references table.column, ON DELETE/UPDATE action
  - Xóa FK
- [ ] Preview DDL: hiện SQL `CREATE TABLE` / `ALTER TABLE` diff realtime khi thay đổi
- [ ] Apply: chạy DDL → refresh Explorer

### 4. Import CSV → Table
- [ ] Wizard 3 bước:
  1. Chọn file CSV + preview 5 dòng đầu
  2. Mapping columns: CSV column → DB column (dropdown), bỏ qua column
  3. Options: delimiter, skip header, on conflict (skip / update / error)
- [ ] Progress bar khi import
- [ ] Kết quả: X rows inserted, Y rows skipped, Z errors

### 5. Export đầy đủ
- [ ] Export query result: CSV, JSON, Excel (.xlsx), SQL INSERT statements
- [ ] Export table data: chọn bảng, filter (optional) → export
- [ ] Database dump:
  - Schema only (DDL)
  - Data only (INSERT statements)
  - Schema + Data
  - Chọn tables cụ thể hoặc toàn bộ
- [ ] Progress bar cho large exports

### 6. Command Palette
- [ ] Mở bằng `Ctrl+P`
- [ ] Fuzzy search tất cả actions:
  - Connections: "Connect to Prod PG", "New connection"
  - Tabs: "New SQL Editor", "Close current tab"
  - Recent tabs: "orders · query", "users · SELECT"
  - Object Explorer: "Open table orders", "View DDL users"
  - Settings: "Toggle dark mode", "Open settings"
- [ ] Keyboard navigation (↑ ↓ Enter)
- [ ] Recent searches
- [ ] Nhóm kết quả theo category

### 7. Schema Designer — Index & FK Manager (standalone)
- [ ] Right-click table → "Manage Indexes" → tab riêng (không cần vào Table Designer)
- [ ] Right-click table → "Manage Foreign Keys" → tab riêng

### 8. ER Diagram

**Dependencies:** thêm `@xyflow/svelte`, `dagre` vào frontend

#### Render & Layout
- [ ] Tab `er-diagram` mở từ right-click schema → "View ER Diagram"
- [ ] Table picker dialog: checkbox chọn subset tables trước khi render (mặc định tick tất cả)
- [ ] Fetch schema: tables + columns (tên, type, PK/FK/nullable) + foreign key constraints
- [ ] Render nodes React Flow: header tên table + màu accent theo system, rows columns
- [ ] PK row: icon `🔑`, FK row: icon `🔗`
- [ ] Toggle "Show all columns" / "Show PK+FK only" per node và global
- [ ] Auto-layout Dagre hierarchical khi lần đầu render
- [ ] Drag node để reposition thủ công
- [ ] Zoom scroll, Pan drag background, nút "Fit to screen"
- [ ] Mini-map hiện khi có > 10 tables

#### Edges
- [ ] Vẽ edge nối FK column → PK column referenced table
- [ ] Ký hiệu cardinality đầu mút: `1` và `N`
- [ ] Label tên FK constraint (hiện khi hover edge)
- [ ] Highlight table + edges liên quan khi hover node

#### Search
- [ ] `Ctrl+F` trong tab → input tìm tên table → highlight + auto-pan tới node

#### Export
- [ ] **PNG**: canvas snapshot toàn bộ diagram, độ phân giải 2x, nền trắng/transparent
- [ ] **SVG**: export vector giữ nguyên text, màu
- [ ] **Mermaid**: sinh `erDiagram` syntax từ schema — copy to clipboard hoặc save file
- [ ] Nút Export toolbar: dropdown chọn format → trigger download

#### Refresh
- [ ] Nút Refresh: re-fetch schema và re-render (giữ vị trí nodes đã drag thủ công)

### 9. Schema Compare

- [ ] UI picker: chọn Source connection + schema, Target connection + schema (cùng system type)
- [ ] Validate cùng loại trước khi compare — báo lỗi nếu chọn PG vs MySQL
- [ ] Fetch schema song song từ 2 connections
- [ ] Diff engine: so sánh Tables, Views, Stored Procedures, Functions, Triggers
  - Per table: columns (tên, type, nullable, default, PK/FK), indexes, constraints
  - Per view / proc / function: so sánh DDL text
- [ ] Hiển thị kết quả dạng table với status: `● Identical` / `✎ Different` / `✚ Src only` / `✖ Tgt only`
- [ ] Filter: All / Different only / Src only / Tgt only / Identical
- [ ] Search object theo tên
- [ ] Click "View diff" → split pane DDL với highlight: xanh (Source only), đỏ (Target only), vàng (changed line)
- [ ] Generate Migration SQL:
  - [ ] Checkbox chọn objects muốn include
  - [ ] Sinh ALTER TABLE / CREATE TABLE / DROP / CREATE INDEX...
  - [ ] Mở trong SQL Editor tab mới để review
  - [ ] Export ra file `.sql`
- [ ] Re-compare button (refresh cả 2 bên)

### 10. UX / General
- [ ] Dark mode / Light mode / System auto toggle
- [ ] Notification toast: query done (với duration), query error, long-running warning (> 10s)
- [ ] Long-running query: badge "running Xs" trên tab, nút Cancel ngay trong tab toolbar

---

## Definition of Done
- Chạy EXPLAIN → xem visual plan với nodes màu theo cost
- Design table GUI: thêm column, thêm index, preview DDL, Apply không lỗi
- Import CSV 10k rows vào table thành công
- Export table → Excel file mở được
- `Ctrl+P` → tìm "orders" → jump tới tab/object đúng
- Redis: scan top 20 keys tốn nhiều memory nhất
- ER Diagram: mở schema 20 tables → tự layout, kéo nodes, zoom in/out
- Export diagram PNG → ảnh rõ nét 2x
- Export Mermaid → paste vào GitHub README render đúng
- Schema Compare: chọn Prod PG vs Dev PG → thấy 3 objects khác nhau
- View diff DDL → thấy highlight đúng column bị thay đổi
- Generate Migration SQL → mở editor, chạy được không lỗi
