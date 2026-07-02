# Execute Plan (chuẩn hóa) + Index Scan — Spec Addendum

> Bổ sung cho `DATABASE_STUDIO_SPEC_v2.md` và `phase-5-power-user.md` (mục 1 Query Plan
> Visualizer + mục 7/9 Index/Schema). Định nghĩa 2 tính năng xuyên suốt 10 hệ:
> (A) **Execute Plan** — mỗi hệ có cơ chế lấy plan KHÁC NHAU nhưng phải quy về CÙNG một
> output chuẩn trên Database Studio; (B) **Index Scan** — quét index của từng hệ, output
> phải thể hiện rõ thông tin index. Khi mâu thuẫn về 2 tính năng này, file này ghi đè.

---

## 0. Nguyên tắc kiến trúc chung

- Mỗi hệ có 1 **adapter** ở `backend/src/drivers/<system>/`. Adapter chịu trách nhiệm:
  chạy cơ chế native của hệ đó, rồi **map về struct chuẩn** dùng chung cho toàn app.
- Frontend chỉ làm việc với struct chuẩn, KHÔNG biết chi tiết từng dialect. Nhờ vậy 1
  component visualizer + 1 component index-viewer dùng được cho mọi hệ.
- Luôn giữ kèm **raw output gốc** (JSON/XML/text) để người dùng xem bản thô khi cần.
- Hệ không hỗ trợ (Redis/Kafka/NATS): trả trạng thái `not_applicable`, UI hiện empty
  state lịch sự, KHÔNG ném lỗi.

---

# A. EXECUTE PLAN (chuẩn hóa cùng một output)

## A.1. Cơ chế native theo từng hệ

| Hệ | Lệnh lấy plan (estimated / actual) | Format gốc |
|---|---|---|
| PostgreSQL | `EXPLAIN (FORMAT JSON)` / `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` | JSON tree |
| MySQL 8 | `EXPLAIN FORMAT=JSON` / `EXPLAIN ANALYZE` (TREE text, có actual) | JSON / text tree |
| MariaDB | `EXPLAIN FORMAT=JSON` / `ANALYZE FORMAT=JSON <stmt>` (có `r_rows`, `r_filtered`) | JSON |
| MSSQL | `SET SHOWPLAN_XML ON` / `SET STATISTICS XML ON` (actual) | XML showplan |
| SQLite | `EXPLAIN QUERY PLAN <stmt>` (mức cao: SCAN/SEARCH ... USING INDEX) | rows |
| ClickHouse | `EXPLAIN PLAN`, `EXPLAIN PIPELINE`, `EXPLAIN ESTIMATE`, `EXPLAIN indexes = 1` | text / rows |
| Cassandra | `TRACING ON` rồi chạy query → đọc session trace (không có EXPLAIN) | trace events |
| Redis / Kafka / NATS | không có khái niệm plan | `not_applicable` |

Lưu ý dialect:
- ClickHouse: dùng `EXPLAIN indexes = 1` để biết primary key / data-skipping index có được
  dùng không; `EXPLAIN ESTIMATE` cho số part/row ước tính; `EXPLAIN PIPELINE` cho luồng thực thi.
- Cassandra: TRACING không phải plan tree mà là **trace phân tán** — map thành các bước
  (coordinator → replica nodes, số partition đọc, có full scan / ALLOW FILTERING không, latency
  mỗi node). Đây là "plan" theo nghĩa của Cassandra.
- SQLite: `EXPLAIN QUERY PLAN` cho cây dễ đọc; KHÔNG dùng `EXPLAIN` thuần (bytecode VDBE) cho UI.

## A.2. Output chuẩn (struct dùng chung)

```
QueryPlan {
  system: string,                 // pg | mysql | mariadb | mssql | sqlite | clickhouse | cassandra
  mode: "estimated" | "actual",
  root: PlanNode,                 // cây node đã chuẩn hóa
  summary: {
    total_cost?: number,
    total_time_ms?: number,       // chỉ khi actual
    total_rows_estimated?: number,
    total_rows_actual?: number,   // chỉ khi actual
    node_count: number,
    warnings: string[]            // ví dụ: "Seq Scan trên bảng lớn", "ALLOW FILTERING full scan"
  },
  raw: { format: "json"|"xml"|"text"|"trace", content: string }  // luôn giữ bản gốc
}

PlanNode {
  id: string,
  operation: string,              // tên chuẩn hóa: SeqScan/IndexScan/IndexOnlyScan/HashJoin/NestedLoop/Sort/Aggregate/...
  target?: string,                // bảng / index / subquery
  index_used?: string,            // tên index nếu có
  estimated_cost?: number,
  estimated_rows?: number,
  actual_rows?: number,           // chỉ khi actual
  actual_time_ms?: number,        // chỉ khi actual
  loops?: number,
  extra?: Record<string,string>,  // buffers, filter, output cols, join cond...
  is_hotspot: boolean,            // node bị đánh dấu tốn kém
  children: PlanNode[]
}
```

Quy tắc map (adapter chịu trách nhiệm):
- Chuẩn hóa TÊN operation về một tập chung (SeqScan, IndexScan, IndexOnlyScan, BitmapScan,
  NestedLoop, HashJoin, MergeJoin, Sort, Aggregate, Limit, GroupBy, Materialize...). Mỗi hệ ánh
  xạ tên riêng của nó vào tập này; giữ tên gốc trong `extra.native_op`.
- `is_hotspot = true` khi: full/seq scan trên bảng lớn, actual_rows lệch xa estimated_rows
  (>10x), node chiếm phần lớn tổng thời gian, hoặc Cassandra dùng ALLOW FILTERING quét toàn cluster.
- Cassandra (trace): mỗi bước là 1 PlanNode phẳng theo thời gian, `target` = node/DC, `extra`
  chứa partition count + consistency + có full scan không.

## A.3. UI

- Mở từ SQL editor: `Ctrl+Shift+E` → tab `query-plan` (giữ đúng phím tắt phase-5).
- Render cây node (box + mũi tên), độ rộng mũi tên tỉ lệ row count, node hotspot tô cam/đỏ.
- Toggle **Estimated / Actual** (Actual chỉ bật khi hệ hỗ trợ và người dùng đồng ý chạy thật).
- Tooltip mỗi node: toàn bộ `extra`. Nút **View raw** mở bản gốc JSON/XML/trace.
- Panel summary: tổng cost/time, cảnh báo từ `summary.warnings`.
- Với Cassandra: hiển thị dạng timeline node thay vì cây, kèm cảnh báo full scan nếu có.
- Redis/Kafka/NATS: nút Explain ẩn hoặc disabled, tooltip "Không áp dụng cho hệ này".

## A.4. Slot vào phase

Mở rộng **phase-5 mục 1** từ 3 hệ (PG/MySQL/MSSQL) thành đầy đủ: thêm MariaDB, SQLite,
ClickHouse, và Cassandra (tracing). Đây là nâng cấp tại chỗ, không tạo phase mới.

---

# B. INDEX SCAN (quét & phân tích index)

## B.1. Mục tiêu

Quét toàn bộ index của 1 connection/schema, output **thể hiện rõ**: index nào, trên bảng nào,
gồm cột nào (thứ tự + ASC/DESC), loại index, unique/primary, kích thước, độ chọn lọc, mức sử
dụng, và **cờ sức khỏe** (unused / redundant / fragmented / invalid). Kèm gợi ý missing index
nếu hệ hỗ trợ.

## B.2. Nguồn dữ liệu theo từng hệ

| Hệ | Nguồn catalog | Đặc thù index |
|---|---|---|
| PostgreSQL | `pg_index`, `pg_class`, `pg_indexes`, `pg_stat_user_indexes` (idx_scan, idx_tup_read), `pg_relation_size()` | BTREE/HASH/GIN/GiST/BRIN/SP-GiST; partial (WHERE); expression index; unused khi idx_scan=0; invalid index |
| MySQL | `information_schema.STATISTICS`, `information_schema.TABLES` (size), `sys.schema_unused_indexes`, `sys.schema_redundant_indexes` | BTREE/HASH/FULLTEXT/SPATIAL; cardinality; non_unique; prefix index |
| MariaDB | `information_schema.STATISTICS` + `information_schema.INNODB_SYS_INDEXES` | tương tự MySQL; sys schema có thể khác/không có → fallback |
| MSSQL | `sys.indexes`, `sys.index_columns`, `sys.dm_db_index_usage_stats` (seeks/scans/lookups/updates), `sys.dm_db_index_physical_stats` (fragmentation), `sys.dm_db_missing_index_details` | CLUSTERED/NONCLUSTERED/COLUMNSTORE; included columns; filtered index; fragmentation %; missing index suggestions |
| SQLite | `PRAGMA index_list(table)`, `PRAGMA index_info/index_xinfo`, `sqlite_master WHERE type='index'` | tự động (auto-index) vs khai báo; partial index; không có usage stats |
| ClickHouse | `system.data_skipping_indices`, `SHOW CREATE TABLE` (ORDER BY / PRIMARY KEY), `system.parts` (granularity) | primary key **sparse** + data-skipping (minmax/set/bloom_filter/ngrambf); projections; KHÔNG có btree thứ cấp |
| Cassandra | `system_schema.indexes` | secondary index (COMPOSITES/KEYS), SASI, custom; kèm partition/clustering key là access path chính; cảnh báo secondary index cao-cardinality là anti-pattern |
| Redis | (chỉ khi có module RediSearch) `FT._LIST`, `FT.INFO` | mặc định `not_applicable`; nếu có RediSearch: liệt kê FT index + fields |
| Kafka / NATS | không có | `not_applicable` |

## B.3. Output chuẩn (struct dùng chung)

```
IndexScanResult {
  system: string,
  scope: { connection: string, database?: string, schema?: string },
  indexes: IndexInfo[],
  summary: {
    total: number,
    unique_count: number,
    total_size_bytes?: number,
    unused_count?: number,
    redundant_count?: number,
    fragmented_count?: number,
    missing_suggestions?: number
  }
}

IndexInfo {
  name: string,
  table: string,                  // hoặc keyspace.table / collection
  columns: { name: string, order?: "ASC"|"DESC", included?: boolean }[],
  type: string,                   // BTREE/HASH/GIN/GiST/BRIN/FULLTEXT/CLUSTERED/COLUMNSTORE/
                                  // sparse-primary/skip-minmax/skip-bloom/SASI/secondary...
  is_unique: boolean,
  is_primary: boolean,
  is_partial: boolean,
  partial_predicate?: string,     // điều kiện WHERE của partial/filtered index
  size_bytes?: number,
  cardinality?: number,           // hoặc selectivity
  usage?: { scans?: number, seeks?: number, last_used?: string },
  fragmentation_pct?: number,     // MSSQL
  health: ("healthy"|"unused"|"redundant"|"fragmented"|"invalid"|"anti_pattern")[],
  ddl?: string,                   // CREATE INDEX gốc
  native_meta?: Record<string,string>
}
```

Quy tắc phân tích (adapter):
- **unused**: PG idx_scan=0; MySQL trong `sys.schema_unused_indexes`; MSSQL usage_stats seeks+scans+lookups=0 nhưng updates>0.
- **redundant**: index là prefix của index khác cùng bảng (ví dụ `(a)` thừa khi có `(a,b)`);
  MySQL có `sys.schema_redundant_indexes`; các hệ khác tự tính từ danh sách cột.
- **fragmented**: MSSQL fragmentation_pct vượt ngưỡng (>30%).
- **invalid**: PG index `indisvalid=false`.
- **anti_pattern**: Cassandra secondary index trên cột cao-cardinality → gắn cờ + cảnh báo.
- **missing** (gợi ý, tách khỏi danh sách index hiện có): PG (từ plan seq-scan lặp lại),
  MSSQL (`dm_db_missing_index_details`). Hiển thị ở phần summary/suggestions.

## B.4. UI

- Mở từ: right-click connection/schema → **Scan Indexes**, hoặc tab `index-scanner`.
- Bảng chính (TanStack Table) cột: Index · Table · Columns · Type · Unique · Primary · Size ·
  Cardinality · Usage · Health. Cột Health render badge màu (healthy xám, unused vàng,
  redundant cam, fragmented cam, invalid đỏ, anti_pattern đỏ).
- Filter nhanh: All / Unused / Redundant / Fragmented / Invalid / Anti-pattern.
- Search theo tên index/bảng/cột. Sort mọi cột. Click 1 dòng → panel bên phải hiện `ddl`
  + `native_meta` + gợi ý xử lý (ví dụ "Có thể DROP: index chưa được dùng").
- Panel summary trên cùng: tổng số index, tổng dung lượng, đếm theo từng health flag,
  số gợi ý missing index.
- Export kết quả scan ra CSV/JSON.
- Hệ `not_applicable`: empty state "Hệ này không có index quan hệ" (Redis nêu thêm: cần
  RediSearch mới có index).

## B.5. Slot vào phase

Thêm mục mới vào **phase-5-power-user.md**: "Index Scanner / Analyzer" (đặt cạnh mục 7 Index &
FK Manager). Object Explorer (phase-2) vẫn hiển thị index cơ bản khi expand bảng — tính năng
này là bản quét toàn diện + phân tích sức khỏe, ở cấp connection/schema.

---

## C. Definition of Done (2 tính năng)

Execute Plan:
- 6 hệ SQL (PG, MySQL, MariaDB, MSSQL, SQLite, ClickHouse) chạy Explain → ra CÙNG một cây
  PlanNode chuẩn hóa, hiển thị được trong 1 component duy nhất.
- Cassandra bật tracing → ra timeline node + cảnh báo ALLOW FILTERING nếu có.
- Toggle Estimated/Actual hoạt động ở hệ hỗ trợ. Nút View raw mở đúng bản gốc.
- Redis/Kafka/NATS: nút Explain disabled, không lỗi.

Index Scan:
- Mỗi hệ SQL + Cassandra: scan ra danh sách IndexInfo đầy đủ cột (tên, bảng, columns có thứ
  tự, type, unique/primary, size nếu có, usage nếu có, health flags).
- Cờ unused/redundant/fragmented/invalid/anti_pattern tính đúng theo nguồn của từng hệ.
- Summary đếm đúng; export CSV/JSON mở được.
- Redis (không RediSearch)/Kafka/NATS: empty state đúng.

---

## D. Do NOT

- KHÔNG hiển thị plan/index bằng format thô của từng hệ ra UI chính — luôn map về struct chuẩn
  trước, bản thô chỉ nằm sau nút "View raw".
- KHÔNG chạy `EXPLAIN ANALYZE`/`STATISTICS XML`/actual plan mà không cho người dùng biết query
  sẽ THỰC SỰ chạy (có side-effect với INSERT/UPDATE/DELETE) — mặc định lấy estimated, actual phải
  người dùng chủ động bật.
- KHÔNG coi ORDER BY key của ClickHouse hay partition/clustering key của Cassandra như btree
  index thường — gắn đúng `type` và giải thích trong `native_meta`.
- KHÔNG tự DROP index — chỉ gợi ý; hành động xóa do người dùng xác nhận.
- KHÔNG nối chuỗi tên bảng/schema vào câu truy vấn catalog — tham số hóa để tránh injection.
