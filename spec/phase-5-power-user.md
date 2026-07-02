# Phase 5 — Power User

**Mục tiêu:** Công cụ nâng cao cho developer/DBA — query plan visualizer (đủ 10 hệ), index scanner/analyzer, ClickHouse nâng cao, table designer, ER diagram, import/export đầy đủ, command palette.
**Thời gian ước tính:** ~~4–5 tuần~~ → **2–3 tuần** (vibe coding)
**Yêu cầu:** Phase Cassandra hoàn thành

---

## Checklist

### 1. Query Plan Visualizer — ĐỦ 10 HỆ, adapter chuẩn hóa (theo `EXECUTE_PLAN_AND_INDEX_SCAN_ADDENDUM.md` phần A)

Mỗi hệ có 1 adapter ở driver layer: chạy cơ chế native rồi **map về struct chuẩn
`QueryPlan { system, mode, root: PlanNode, summary, raw }`**. Frontend chỉ làm việc với struct
chuẩn — 1 component visualizer duy nhất cho mọi hệ. Luôn giữ raw output gốc (JSON/XML/text/trace).

- [ ] PostgreSQL: `EXPLAIN (FORMAT JSON)` / `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` → parse JSON tree
- [ ] MySQL: `EXPLAIN FORMAT=JSON` / `EXPLAIN ANALYZE` (TREE text, có actual) → parse
- [ ] MariaDB: `EXPLAIN FORMAT=JSON` / `ANALYZE FORMAT=JSON <stmt>` (có `r_rows`, `r_filtered`) → parse
- [ ] MSSQL: `SET SHOWPLAN_XML ON` (estimated) / `SET STATISTICS XML ON` (actual) → parse XML showplan
- [ ] SQLite: `EXPLAIN QUERY PLAN <stmt>` (SCAN/SEARCH ... USING INDEX) — KHÔNG dùng `EXPLAIN` thuần (bytecode VDBE)
- [ ] ClickHouse: `EXPLAIN PLAN`, `EXPLAIN PIPELINE`, `EXPLAIN ESTIMATE`, `EXPLAIN indexes = 1` (biết primary key / data-skipping index có được dùng)
- [ ] Cassandra: `TRACING ON` rồi chạy query → đọc session trace, map thành các bước (coordinator → replica, số partition đọc, full scan / ALLOW FILTERING, latency mỗi node) — hiển thị dạng **timeline node** thay vì cây
- [ ] Redis / Kafka / NATS: trả `not_applicable` — nút Explain ẩn/disabled, tooltip "Không áp dụng cho hệ này", KHÔNG ném lỗi
- [ ] Chuẩn hóa tên operation về tập chung (SeqScan/IndexScan/IndexOnlyScan/BitmapScan/NestedLoop/HashJoin/MergeJoin/Sort/Aggregate/Limit/GroupBy/Materialize...); giữ tên gốc trong `extra.native_op`
- [ ] `is_hotspot = true` khi: full/seq scan bảng lớn; actual_rows lệch estimated_rows >10x; node chiếm phần lớn tổng thời gian; Cassandra ALLOW FILTERING quét toàn cluster
- [ ] Render visual node tree:
  - Mỗi node = 1 box: operation name, estimated cost, actual rows, actual time
  - Arrow nối các nodes theo thứ tự thực thi
  - Chiều rộng arrow tỉ lệ với row count
- [ ] Highlight hotspot nodes: cost/time vượt threshold → màu đỏ/cam
- [ ] Tooltip per node: hiện toàn bộ `extra` (loops, buffers, output columns, filter, join cond)
- [ ] Toggle: Estimated Plan / Actual Plan — actual chỉ bật khi hệ hỗ trợ và **người dùng chủ động bật** (query sẽ THỰC SỰ chạy, có side-effect với INSERT/UPDATE/DELETE)
- [ ] Panel summary: tổng cost/time, `summary.warnings` (vd "Seq Scan trên bảng lớn", "ALLOW FILTERING full scan")
- [ ] Nút **View raw**: mở bản gốc JSON/XML/trace
- [ ] Mở từ SQL Editor: `Ctrl+Shift+E` → tab `query-plan`

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

### 7b. Index Scanner / Analyzer (theo `EXECUTE_PLAN_AND_INDEX_SCAN_ADDENDUM.md` phần B)

Quét toàn bộ index của 1 connection/schema, phân tích sức khỏe — khác với hiển thị index cơ bản
khi expand bảng ở Object Explorer (Phase 2): đây là bản quét toàn diện ở cấp connection/schema.

- [ ] Adapter per hệ đọc catalog thật → map về **`IndexScanResult { system, scope, indexes: IndexInfo[], summary }`**:
  - PG: `pg_index`, `pg_class`, `pg_indexes`, `pg_stat_user_indexes` (idx_scan), `pg_relation_size()` — BTREE/HASH/GIN/GiST/BRIN/SP-GiST, partial, expression index, invalid index
  - MySQL: `information_schema.STATISTICS`, `sys.schema_unused_indexes`, `sys.schema_redundant_indexes`
  - MariaDB: `information_schema.STATISTICS` + `INNODB_SYS_INDEXES` (sys schema có thể không có → fallback)
  - MSSQL: `sys.indexes`, `sys.index_columns`, `sys.dm_db_index_usage_stats`, `sys.dm_db_index_physical_stats` (fragmentation), `sys.dm_db_missing_index_details`
  - SQLite: `PRAGMA index_list/index_info/index_xinfo`, `sqlite_master` — auto-index vs khai báo, không có usage stats
  - ClickHouse: `system.data_skipping_indices`, `SHOW CREATE TABLE` (ORDER BY / PRIMARY KEY sparse), `system.parts` — KHÔNG coi ORDER BY key như btree thường, gắn đúng `type` (sparse-primary/skip-minmax/skip-bloom...)
  - Cassandra: `system_schema.indexes` — secondary/SASI/custom; partition/clustering key là access path chính
  - Redis: `not_applicable` (nếu có RediSearch: `FT._LIST`/`FT.INFO`); Kafka/NATS: `not_applicable`
- [ ] `IndexInfo`: name, table, columns (thứ tự + ASC/DESC + included), type, unique/primary/partial (+predicate), size, cardinality, usage, fragmentation_pct, **health flags**, ddl, native_meta
- [ ] Cờ sức khỏe tính đúng theo nguồn từng hệ: **unused** (PG idx_scan=0; MySQL sys view; MSSQL usage=0 nhưng updates>0), **redundant** (index là prefix của index khác cùng bảng), **fragmented** (MSSQL >30%), **invalid** (PG `indisvalid=false`), **anti_pattern** (Cassandra secondary index cao-cardinality)
- [ ] Gợi ý **missing index** tách riêng ở summary (PG từ plan seq-scan lặp lại, MSSQL `dm_db_missing_index_details`)
- [ ] UI: right-click connection/schema → **Scan Indexes** → tab `index-scanner`; bảng TanStack (Index · Table · Columns · Type · Unique · Primary · Size · Cardinality · Usage · Health badge màu); filter nhanh All/Unused/Redundant/Fragmented/Invalid/Anti-pattern; search; sort; click dòng → panel DDL + native_meta + gợi ý xử lý
- [ ] Panel summary: tổng index, tổng dung lượng, đếm theo health flag, số gợi ý missing
- [ ] Export kết quả scan ra CSV/JSON
- [ ] KHÔNG tự DROP index — chỉ gợi ý, hành động xóa do người dùng xác nhận; KHÔNG nối chuỗi tên bảng/schema vào query catalog (tham số hóa)

### 7c. ClickHouse nâng cao (theo `CLICKHOUSE_SPEC_ADDENDUM.md`)
- [ ] **Engine badge** trên node table trong explorer: MergeTree / ReplacingMergeTree(ver) / SummingMergeTree(cols) / AggregatingMergeTree / CollapsingMergeTree / VersionedCollapsingMergeTree / Log / Memory / Distributed / MaterializedView / Dictionary — đọc từ `system.tables` / `SHOW CREATE TABLE`, không từ mảng cứng
- [ ] **TTL Policy Viewer**: context-menu table → "TTL Policy…" — parse mệnh đề TTL thật thành rule dễ đọc (biểu thức thô + badge **DELETE**/**MOVE** + mô tả tự nhiên + engine + ngưỡng TTL merge); nút **MATERIALIZE TTL** → mở SQL tab `ALTER TABLE … MATERIALIZE TTL`; bảng không TTL → empty state
- [ ] **Table/Partition ops** (context menu, query `system.parts`/`system.tables`): Optimize Table (FINAL), Show Partitions / Show Engine / Settings, Detach / Drop / Freeze Partition
- [ ] **Mutations**: UPDATE/DELETE = mutation async qua `ALTER TABLE … UPDATE/DELETE WHERE …`, theo dõi qua `system.mutations` — editable grid KHÔNG commit kiểu OLTP: dịch pending changes thành mutation async + báo là job async (hoặc tắt inline-edit + route sang "Generate mutation" kèm cảnh báo chi phí); KHÔNG giả vờ cập nhật xong ngay; INSERT theo lô lớn
- [ ] Toggle "SELECT … FINAL" khi xem bảng Replacing/Summing/Aggregating (key không unique cho tới khi merge)
- [ ] **Materialized View / Dictionary**: menu tạo trong schema (thay Sequence/Procedure của hệ quan hệ); MV là **insert-triggered**, KHÔNG sinh `REFRESH MATERIALIZED VIEW`; Dictionary context menu: Show Definition (`SHOW CREATE DICTIONARY`), Query, Reload (`SYSTEM RELOAD DICTIONARY`), Drop, Copy Name
- [ ] DDL generator native ClickHouse: `ENGINE = ...`, `PARTITION BY`, `ORDER BY`, `PRIMARY KEY` (nếu khác ORDER BY), `TTL`, `SETTINGS`, `CODEC` — không tái dùng generator Postgres

### 8. ER Diagram

**Dependencies:** thêm `@xyflow/svelte`, `dagre` vào frontend

#### Render & Layout
- [ ] Tab `er-diagram` mở từ right-click schema → "View ER Diagram"
- [ ] Table picker dialog: checkbox chọn subset tables trước khi render (mặc định tick tất cả)
- [ ] Fetch schema: tables + columns (tên, type, PK/FK/nullable) + foreign key constraints
- [ ] Render nodes Svelte Flow (`@xyflow/svelte`): header tên table + màu accent theo system, rows columns
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
- [ ] ClickHouse được phép compare (CH ↔ CH) nhưng diff/DDL theo dialect ClickHouse (engine/partition/order-by/TTL), không theo `information_schema` chuẩn
- [ ] Cassandra chỉ compare Cassandra ↔ Cassandra, diff theo keyspace/table/UDT/MV — KHÔNG so chéo với hệ quan hệ
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
- **Execute Plan:** 6 hệ SQL (PG, MySQL, MariaDB, MSSQL, SQLite, ClickHouse) chạy Explain → ra CÙNG một cây PlanNode chuẩn hóa, hiển thị trong 1 component duy nhất
- Cassandra bật tracing → ra timeline node + cảnh báo ALLOW FILTERING nếu có
- Toggle Estimated/Actual hoạt động ở hệ hỗ trợ; View raw mở đúng bản gốc; Redis/Kafka/NATS: nút Explain disabled, không lỗi
- **Index Scan:** mỗi hệ SQL + Cassandra scan ra danh sách IndexInfo đầy đủ cột; cờ unused/redundant/fragmented/invalid/anti_pattern tính đúng theo nguồn từng hệ; summary đếm đúng; export CSV/JSON mở được; Redis (không RediSearch)/Kafka/NATS: empty state đúng
- **ClickHouse:** TTL Viewer parse rule DELETE/MOVE đúng từ bảng có TTL (không TTL → empty state); `ALTER TABLE … UPDATE` → job xuất hiện trong `system.mutations`, không "xong ngay"; bảng ReplacingMergeTree chèn 2 row cùng key → SELECT thường thấy 2, `SELECT … FINAL` thấy 1; DDL round-trip khớp `SHOW CREATE TABLE`
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

### Test (bắt buộc)
- Unit test đầy đủ cho toàn bộ logic phase này (adapter map plan từng hệ → PlanNode, quy tắc hotspot, tính cờ sức khỏe index, diff engine Schema Compare, Mermaid generator...)
- Integration test đầy đủ cho **từng hệ trong phase** qua **testcontainers**: Execute Plan + Index Scan chạy trên PG, MySQL, MariaDB, MSSQL, ClickHouse, Cassandra thật (SQLite trên file thật); ClickHouse nâng cao test trên container CH

### UI đối chiếu 1:1 với `Database Studio.dc.html` (bắt buộc)
- Token màu/spacing/font grep trực tiếp từ HTML, không phỏng đoán
- Icon SVG copy nguyên vẹn từ HTML
- Bảng đối chiếu số đo các thành phần của phase (plan visualizer, index scanner, TTL Viewer, ER diagram, compare view...) — không còn dòng lệch
- Snapshot/DOM test cho các component UI mới của phase
