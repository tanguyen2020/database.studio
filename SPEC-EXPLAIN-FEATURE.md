# SPEC — Chức năng EXPLAIN (Query Plan Analyzer)

> **Tài liệu này là single source of truth cho Claude Code khi implement chức năng Explain.**
> Đọc toàn bộ file trước khi viết bất kỳ dòng code nào.

---

## 0. SCOPE & GUARDRAILS (BẮT BUỘC ĐỌC TRƯỚC)

### 0.1. Phạm vi

- **CHỈ** implement chức năng Explain: thu thập execution plan → normalize qua LLM → render UI kiểu SSMS.
- **KHÔNG** được sửa, refactor, "tiện tay cải thiện" bất kỳ module nào ngoài phạm vi Explain. Bao gồm nhưng không giới hạn: Grid, Group-By popover, Streaming I/O, Copy Table, connection manager, query editor, schema browser.
- Nếu Explain cần dùng hạ tầng có sẵn (connection pool, query executor, dialect detection), **chỉ được GỌI qua interface public hiện có**, không sửa signature, không đổi behavior của chúng.
- Nếu phát hiện hạ tầng hiện có thiếu API cần thiết → **DỪNG LẠI, báo cáo, đề xuất**, không tự ý sửa.

### 0.2. Cấu trúc code — isolation

Toàn bộ code mới nằm trong module riêng, ví dụ:

```
src/features/explain/
├── acquisition/          # Layer 1 — lấy raw plan theo dialect
│   ├── index.ts          # router theo dialect
│   ├── postgres.ts
│   ├── mysql.ts
│   ├── mariadb.ts
│   ├── mssql.ts
│   ├── clickhouse.ts
│   ├── sqlite.ts
│   └── cassandra.ts
├── parsing/              # Layer 1.5 — pre-parse structured plan (không dùng LLM)
│   ├── postgres-parser.ts
│   ├── mysql-parser.ts
│   └── mssql-parser.ts
├── analysis/             # Layer 2 — gọi LLM, validate output
│   ├── prompt-builder.ts # ghép system prompt + dialect block + context
│   ├── dialect-blocks.ts # 7 dialect knowledge blocks (§6)
│   ├── llm-client.ts
│   └── schema-validator.ts
├── rendering/            # Layer 3 — SSMS-style UI
│   ├── PlanTree.tsx      # cây operator right-to-left
│   ├── PlanNode.tsx
│   ├── PlanArrow.tsx     # độ dày theo rows
│   ├── MissingIndexBanner.tsx
│   ├── NodeDetailPanel.tsx
│   ├── SummaryBar.tsx
│   └── layout.ts         # thuật toán tree layout
├── types.ts              # UnifiedExplainResult + toàn bộ types (§4)
└── explain.test.ts
```

- Không import ngược từ `explain/` vào các feature khác.
- Entry point duy nhất từ UI hiện có: một nút/command "Explain" trong query editor gọi `runExplain(connection, sql, mode)`.

### 0.3. Gate verification (KHÔNG ĐƯỢC BỎ QUA)

- **CẤM báo cáo task hoàn thành nếu chưa chạy và pass toàn bộ gates**: `check` (typecheck/lint), `vitest`, `playwright`, Rust unit tests, integration tests.
- Sau khi implement, chạy lại **toàn bộ** test suite của project (không chỉ test của Explain) để chứng minh không phá chức năng khác. Nếu bất kỳ test cũ nào fail → đó là regression do mình gây ra, phải fix trước khi báo cáo.
- Mỗi task con kết thúc bằng output của lệnh chạy gates, nguyên văn, không tóm tắt.

### 0.4. An toàn khi thực thi

- Mode **Actual** thực thi query thật. Quy tắc:
  - Postgres: wrap trong `BEGIN; ... ROLLBACK;` khi query là DML (INSERT/UPDATE/DELETE).
  - MSSQL: wrap trong `BEGIN TRAN ... ROLLBACK TRAN` cho DML.
  - MySQL/MariaDB: `EXPLAIN ANALYZE` với DML **bị chặn** (hiện dialog cảnh báo, chỉ cho phép Estimated) vì DDL/một số storage engine không rollback tin cậy.
  - ClickHouse, Cassandra, SQLite: chặn Actual với mọi statement ghi dữ liệu.
- Phát hiện DML bằng parse statement type, không regex thô trên chuỗi (dùng parser SQL hiện có của project nếu có; nếu không có, dùng heuristic keyword đầu statement sau khi strip comment + CTE).
- Timeout riêng cho Explain: mặc định 30s, configurable, hủy được từ UI.

---

## 1. KIẾN TRÚC 3 TẦNG

```
[SQL + Connection] 
   → Layer 1: Acquisition (chạy lệnh EXPLAIN đúng dialect, trả raw plan)
   → Layer 1.5: Pre-parse (Postgres/MySQL/MSSQL: parse structured plan bằng code)
   → Layer 2: LLM Analysis (system prompt + dialect block + raw plan + pre-parsed + DDL 
              → UnifiedExplainResult JSON)
   → Layer 2.5: Validation (JSON schema validate, retry 1 lần nếu fail)
   → Layer 3: Rendering (SSMS-style plan tree)
```

Nguyên tắc phân công:
- **Số liệu** (cost, rows, timing) lấy từ pre-parser khi dialect có structured plan. LLM **không được bịa số** — với 3 dialect có parser, LLM chỉ được copy số từ pre-parsed data.
- **Phán đoán** (bottleneck, index suggestion, rewrite, severity) là việc của LLM.
- Với SQLite/Cassandra (plan nghèo), LLM dựng tree từ text/trace, các field số không có thì để `null`, UI hiển thị badge "Limited analysis".

---

## 2. LAYER 1 — ACQUISITION THEO DIALECT

| Dialect | Mode Estimated | Mode Actual | Ghi chú |
|---|---|---|---|
| `postgres` | `EXPLAIN (FORMAT JSON, VERBOSE, COSTS, BUFFERS) <sql>` | `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) <sql>` | DML wrap rollback. Output: JSON array, lấy `[0].Plan` |
| `mysql` | `EXPLAIN FORMAT=JSON <sql>` | `EXPLAIN ANALYZE <sql>` (≥8.0.18) | ANALYZE trả TREE text — gửi cả JSON estimated + TREE actual cho LLM khi mode=actual. Check version trước, fallback estimated |
| `mariadb` | `EXPLAIN FORMAT=JSON <sql>` | `ANALYZE FORMAT=JSON <sql>` | ANALYZE của MariaDB trả JSON có `r_rows`, `r_total_time_ms` — KHÁC MySQL, không dùng chung parser |
| `mssql` | `SET SHOWPLAN_XML ON` → execute → `SET SHOWPLAN_XML OFF` | `SET STATISTICS XML ON` → execute → OFF | XML showplan. Actual: kết quả query bị discard, chỉ lấy plan XML. DML wrap rollback |
| `clickhouse` | Chạy 3 lệnh, gộp kết quả: `EXPLAIN indexes = 1 <sql>` + `EXPLAIN ESTIMATE <sql>` + `EXPLAIN PIPELINE <sql>` | Estimated + chạy query kèm `SETTINGS log_queries=1` rồi đọc `system.query_log` (nếu quyền cho phép; nếu không → chỉ estimated, note trong result) | Version cần ≥21.x cho `indexes=1`, check và degrade |
| `sqlite` | `EXPLAIN QUERY PLAN <sql>` | Không hỗ trợ actual — luôn estimated | Output rất nghèo. Gửi kèm `PRAGMA index_list` + `PRAGMA table_info` của các bảng liên quan |
| `cassandra` | Không có EXPLAIN | `TRACING ON` → execute (chỉ SELECT) → thu trace events từ `system_traces.sessions` + `system_traces.events` | Non-SELECT: từ chối, hiện message "Cassandra chỉ hỗ trợ analyze SELECT". Gửi kèm table schema (`DESCRIBE TABLE`) |

### 2.1. Context bổ sung gửi kèm cho LLM (mọi dialect)

Bắt buộc thu thập trước khi gọi LLM:

1. **DDL của các bảng trong query** (CREATE TABLE + toàn bộ index hiện có). Trích tên bảng từ plan (ưu tiên) hoặc từ SQL. Lấy DDL qua catalog query chuẩn của từng dialect (information_schema / pg_catalog / sys.* / system.tables / sqlite_master / system_schema.tables).
2. **Row count ước lượng mỗi bảng** (từ statistics catalog, KHÔNG chạy COUNT(*)):
   - postgres: `pg_class.reltuples`
   - mysql/mariadb: `information_schema.TABLES.TABLE_ROWS`
   - mssql: `sys.dm_db_partition_stats`
   - clickhouse: `system.tables.total_rows`
   - sqlite: không có → `null`
   - cassandra: `nodetool` không khả dụng từ client → `null`
3. **Server version** (đã lấy được từ bước check version).

Nếu bước thu thập context fail (thiếu quyền) → vẫn tiếp tục, đánh dấu `context_incomplete: true`, LLM sẽ hạ confidence.

---

## 3. VOCABULARY CHUẨN — OPERATION NORMALIZATION

LLM phải map mọi operation về đúng 16 giá trị sau (enum đóng, validator reject giá trị lạ):

| # | `operation` chuẩn | `icon` | Postgres | MySQL/MariaDB | MSSQL | ClickHouse | SQLite | Cassandra |
|---|---|---|---|---|---|---|---|---|
| 1 | `Full Table Scan` | `table_scan` | Seq Scan | type=ALL | Table Scan, Clustered Index Scan | ReadFromMergeTree với granules x/y, x≈y | SCAN TABLE | full partition range scan / ALLOW FILTERING |
| 2 | `Index Seek` | `index_seek` | Index Scan có Index Cond hẹp, Index Only Scan có cond | type=ref/eq_ref/const | Index Seek, Clustered Index Seek | ReadFromMergeTree granules lọc tốt (x≪y) | SEARCH TABLE USING INDEX | single partition read by key |
| 3 | `Index Scan` | `index_scan` | Index Scan không cond / full index | type=index | Index Scan (nonclustered) | quét toàn bộ theo ORDER BY key | SCAN TABLE USING INDEX | — |
| 4 | `Index Only Scan` | `index_only` | Index Only Scan | Using index (covering) | Index Seek covering (không lookup) | — | SEARCH ... USING COVERING INDEX | — |
| 5 | `Key Lookup` | `key_lookup` | Heap Fetches trong Index Only / Bitmap Heap Scan phần fetch | — | Key Lookup, RID Lookup | — | — | — |
| 6 | `Bitmap Scan` | `bitmap` | Bitmap Index Scan + Bitmap Heap Scan (gộp làm 1 node, detail ghi rõ) | index_merge | — | — | — | — |
| 7 | `Nested Loop Join` | `nl_join` | Nested Loop | nested loop (default join) | Nested Loops | — | (join mặc định) | — |
| 8 | `Hash Join` | `hash_join` | Hash Join | hash join (8.0.18+) | Hash Match (join) | HashJoin / các Join step | — | — |
| 9 | `Merge Join` | `merge_join` | Merge Join | — | Merge Join | MergeJoin | — | — |
| 10 | `Sort` | `sort` | Sort, Incremental Sort | Using filesort | Sort | MergingSorted / PartialSorting / Sorting | USE TEMP B-TREE FOR ORDER BY | — |
| 11 | `Aggregate` | `aggregate` | Aggregate, HashAggregate, GroupAggregate, WindowAgg | Using temporary (group) | Hash Match (aggregate), Stream Aggregate | Aggregating / AggregatingTransform | — | coordinator aggregation |
| 12 | `Filter` | `filter` | node Filter riêng / subplan filter | attached_condition đáng kể | Filter | Filter step | — | replica filtering |
| 13 | `Materialize` | `materialize` | Materialize, CTE Scan, Memoize | Using temporary | Table Spool, Index Spool | — | MATERIALIZE / CO-ROUTINE | — |
| 14 | `Result` | `result` | Result, Limit, Gather (root wrap) | root | SELECT / result root | Expression root | root | coordinator result |
| 15 | `Parallel` | `parallel` | Gather, Gather Merge (khi là node đáng chú ý) | — | Parallelism (Gather/Repartition Streams) | nhiều pipeline threads | — | multi-replica fan-out |
| 16 | `Other` | `other` | mọi thứ còn lại — GHI TÊN GỐC vào `raw_operation` | tương tự | tương tự | tương tự | tương tự | tương tự |

Quy tắc: field `raw_operation` LUÔN chứa tên gốc từ plan (vd `"Seq Scan"`, `"Hash Match"`), để developer đối chiếu. Field `operation` chứa tên chuẩn.

---

## 4. UNIFIED JSON SCHEMA (Layer 2 output)

File `types.ts` — đây là contract giữa LLM, validator và UI. Viết JSON Schema (draft-07) tương ứng trong `schema-validator.ts` để validate runtime (dùng ajv hoặc tương đương đã có trong project; nếu chưa có ajv, dùng zod nếu project đã dùng zod — KHÔNG thêm dependency mới nếu tránh được).

```typescript
export type Dialect =
  | "postgres" | "mysql" | "mariadb" | "mssql"
  | "clickhouse" | "sqlite" | "cassandra";

export type ExplainMode = "estimated" | "actual";
export type Verdict = "good" | "warning" | "critical";
export type Severity = "ok" | "warning" | "critical";
export type Confidence = "high" | "medium" | "low";
export type CostBasis = "cost" | "duration" | "rows_proxy" | "none";

export type OperationName =
  | "Full Table Scan" | "Index Seek" | "Index Scan" | "Index Only Scan"
  | "Key Lookup" | "Bitmap Scan" | "Nested Loop Join" | "Hash Join"
  | "Merge Join" | "Sort" | "Aggregate" | "Filter" | "Materialize"
  | "Result" | "Parallel" | "Other";

export type IconName =
  | "table_scan" | "index_seek" | "index_scan" | "index_only"
  | "key_lookup" | "bitmap" | "nl_join" | "hash_join" | "merge_join"
  | "sort" | "aggregate" | "filter" | "materialize" | "result"
  | "parallel" | "other";

export type WarningType =
  | "cardinality_mismatch"   // estimate lệch actual >10x
  | "implicit_conversion"    // so sánh khác kiểu dữ liệu làm mất index
  | "spill_to_disk"          // sort/hash tràn ra disk (external merge, tempdb spill)
  | "no_join_predicate"      // cartesian / cross join không chủ đích
  | "stale_statistics"       // statistics cũ (suy ra từ estimate lệch trên bảng lớn)
  | "missing_index"          // scan có predicate nhưng không index nào áp dụng được
  | "lossy_bitmap"           // Postgres bitmap lossy
  | "allow_filtering"        // Cassandra: query dùng ALLOW FILTERING
  | "tombstone_scan"         // Cassandra: đọc nhiều tombstones
  | "full_granule_scan"      // ClickHouse: primary key không lọc granule nào
  | "filesort"               // MySQL: Using filesort trên tập lớn
  | "temp_table";            // MySQL: Using temporary trên tập lớn

export interface PlanWarning {
  type: WarningType;
  message: string;            // tiếng Việt, ngắn gọn, có số liệu
}

export interface PlanNode {
  id: string;                 // "n1", "n2", ...
  parent_id: string | null;   // null = root
  child_order: number;        // 0 = outer/build side, 1 = inner/probe side
  operation: OperationName;
  raw_operation: string;      // tên gốc trong plan
  icon: IconName;
  op_category: "scan" | "join" | "sort" | "aggregate" | "filter" | "other";
  target: string | null;      // tên bảng/index tác động
  index_used: string | null;
  rows_estimated: number | null;
  rows_actual: number | null; // null khi mode=estimated hoặc dialect không có
  rows_out: number | null;    // số rows node này đẩy lên parent (quyết định độ dày mũi tên)
  cost_self: number | null;   // self cost (đã trừ children) — quy tắc tính theo §6 từng dialect
  cost_pct: number;           // % trên tổng, 0-100, tổng toàn tree ≈ 100 (±2 do làm tròn)
  duration_ms: number | null;
  severity: Severity;
  warnings: PlanWarning[];
  detail: string;             // 1-2 câu tiếng Việt: node này làm gì, có gì đáng chú ý
  tooltip: {                  // panel chi tiết khi click
    predicate: string | null;     // filter/join condition nguyên văn
    output_columns: string | null;
    extra: Record<string, string>; // dialect-specific: buffers, loops, workers, granules...
  };
}

export interface IndexSuggestion {
  table: string;
  columns: string[];
  include_columns: string[];  // covering columns (MSSQL INCLUDE, PG INCLUDE)
  reason: string;             // tiếng Việt
  ddl: string;                // ĐÚNG cú pháp dialect hiện tại
  impact_pct: number | null;  // MSSQL: từ MissingIndexes; khác: ước lượng từ cost_pct node liên quan
  impact_estimated: boolean;  // true nếu impact là ước lượng của LLM
  confidence: Confidence;
  related_node_ids: string[];
}

export interface QueryRewrite {
  suggestion: string;         // tiếng Việt
  sql: string;
  confidence: Confidence;
}

export interface Bottleneck {
  node_id: string;
  type: "full_scan" | "bad_estimate" | "expensive_sort" | "nested_loop_large"
      | "spill_to_disk" | "key_lookup_storm" | "excessive_data_movement" | "other";
  explanation: string;        // tiếng Việt
}

export interface UnifiedExplainResult {
  dialect: Dialect;
  mode: ExplainMode;
  cost_basis: CostBasis;      // "cost" | "duration" | "rows_proxy" | "none" — UI hiện chú thích khi != "cost"
  limited_analysis: boolean;  // true cho sqlite/cassandra hoặc khi context_incomplete
  verdict: Verdict;
  summary: string;            // 1-2 câu tiếng Việt tổng kết
  total: {
    cost: number | null;
    duration_ms: number | null;
    rows_estimated: number | null;
    rows_actual: number | null;
  };
  plan_tree: PlanNode[];      // flat list, dựng tree bằng parent_id
  bottlenecks: Bottleneck[];
  missing_index_banner: {     // banner xanh lá kiểu SSMS — null nếu không có đề xuất nào confidence >= medium
    impact_pct: number;
    impact_estimated: boolean;
    ddl: string;
    reason: string;
  } | null;
  index_suggestions: IndexSuggestion[];  // đầy đủ, banner chỉ là cái tốt nhất
  query_rewrites: QueryRewrite[];
}
```

### 4.1. Validation rules (schema-validator.ts)

- Validate đúng JSON Schema. Fail → retry LLM đúng 1 lần, đính kèm lỗi validation vào prompt retry. Fail lần 2 → hiện raw plan + error UI, KHÔNG hiện kết quả sai.
- Rules bổ sung ngoài schema:
  - Đúng 1 node có `parent_id: null`.
  - Mọi `parent_id` khác phải tồn tại trong danh sách id. Không có cycle.
  - `sum(cost_pct)` trong [95, 105].
  - `missing_index_banner.ddl` và mọi `index_suggestions[].ddl`: check cú pháp thô theo dialect (postgres/mysql/mariadb/sqlite: bắt đầu `CREATE INDEX`; mssql: `CREATE [NONCLUSTERED] INDEX`; clickhouse: `ALTER TABLE ... ADD INDEX` hoặc comment đề xuất ORDER BY; cassandra: `CREATE CUSTOM INDEX`/`CREATE INDEX` hoặc đề xuất redesign — cho phép `ddl` là chuỗi rỗng với cassandra khi đề xuất là redesign).
  - Mọi index trong `index_suggestions` không được trùng tên/cột với index đã tồn tại trong DDL context (so sánh tập cột + thứ tự cột prefix).

---

## 5. SYSTEM PROMPT (prompt-builder.ts)

Prompt cuối = `SYSTEM_PROMPT` + `DIALECT_BLOCK[dialect]` + user content. Nhiệt độ 0 (hoặc thấp nhất API cho phép). Yêu cầu JSON-only output.

### 5.1. SYSTEM_PROMPT (hằng số, tiếng Anh để ổn định, output tiếng Việt)

```
You are a database query-plan analysis engine inside a Database Studio tool.
Your ONLY output is a single JSON object conforming EXACTLY to the schema
provided below. No markdown, no code fences, no prose outside JSON.

<output_schema>
{...paste JSON Schema draft-07 generated from types.ts...}
</output_schema>

INPUT you will receive:
- <sql>: the original query
- <raw_plan>: the raw execution plan (format varies by dialect)
- <pre_parsed> (optional): plan already parsed by code into nodes with exact
  numbers (cost, rows, timing). WHEN PRESENT, you MUST copy all numeric
  fields (rows_estimated, rows_actual, cost_self, duration_ms, rows_out)
  from pre_parsed verbatim. You may NOT invent or adjust any number.
- <table_context>: CREATE TABLE DDL + existing indexes + estimated row counts
- <dialect_notes>: dialect-specific interpretation rules — these OVERRIDE
  general rules when in conflict.

MANDATORY RULES:
1. operation MUST be one of the 16 canonical names. Map using the
   normalization table in dialect_notes. Preserve the original name in
   raw_operation. Unknown operators -> "Other" + raw_operation.
2. cost_pct: compute self-cost per node using the dialect's cost rule
   (in dialect_notes), then cost_pct = self / total * 100, rounded to
   integers, sum across all nodes must be 95-105.
3. severity="critical" when ANY of: Full Table Scan on a table whose
   estimated row count in table_context exceeds 10,000; 
   rows_actual/rows_estimated ratio > 10 or < 0.1 (only when both known);
   spill_to_disk warning; Nested Loop Join whose outer side rows_out > 10,000.
   severity="warning" for milder versions (full scan on 1k-10k rows,
   ratio 3x-10x, filesort/temp_table on large sets). Else "ok".
4. verdict = worst severity across nodes ("ok"->good).
5. warnings[].type MUST come from the closed WarningType enum. Do not
   invent types. If nothing fits, omit the warning and mention it in detail.
6. index_suggestions: ONLY suggest indexes that do NOT already exist
   (cross-check table_context DDL, including column order / prefix rules).
   DDL must use the exact syntax of the current dialect. If an existing
   index covers the need but the query defeats it (e.g. implicit
   conversion, function on column), use query_rewrites instead and add
   the implicit_conversion warning to the relevant node.
7. missing_index_banner = the single best suggestion with confidence
   high or medium; null if none qualifies. impact_pct: use engine-provided
   impact when available (MSSQL MissingIndexes), else estimate as the
   cost_pct of the node(s) the index would eliminate, and set
   impact_estimated=true.
8. If mode=estimated, all rows_actual and duration_ms are null, and every
   conclusion drops one confidence level (high->medium etc).
9. All human-readable strings (summary, detail, message, reason,
   explanation, suggestion) are in VIETNAMESE, concise, written for a
   developer, and must reference concrete numbers from the plan.
10. Never fabricate numbers absent from raw_plan/pre_parsed. Unknown -> null.
11. rows_out = rows the node emits to its parent (actual if available,
    else estimated). Root node rows_out = final result rows.
12. child_order: for joins, 0 = outer/build/first input, 1 = inner/probe.
    Preserve the plan's own ordering.
```

### 5.2. User content template

```
<sql>
{original SQL}
</sql>

<dialect>{dialect}</dialect>
<server_version>{version}</server_version>
<mode>{estimated|actual}</mode>

<raw_plan format="{json|xml|tree_text|trace_events|text}">
{raw plan, truncate về 50KB nếu lớn hơn — giữ nguyên đầu, cắt giữa, giữ nguyên cuối, chèn marker [...TRUNCATED...]}
</raw_plan>

<pre_parsed>
{JSON từ parser — chỉ có với postgres/mysql/mariadb/mssql}
</pre_parsed>

<table_context complete="{true|false}">
{DDL + indexes + row counts từng bảng}
</table_context>
```

---

## 6. DIALECT BLOCKS (dialect-blocks.ts)

Mỗi block là hằng số string, chèn vào sau SYSTEM_PROMPT. **Đây là phần quan trọng nhất — copy nguyên văn.**

### 6.1. postgres

```
<dialect_notes db="postgres">
PLAN STRUCTURE: raw_plan is EXPLAIN JSON. Root is [0].Plan, children in
"Plans" array. pre_parsed is provided — copy its numbers verbatim.

COST RULE (self-cost): Postgres "Total Cost" is CUMULATIVE (includes
children). cost_self = node.TotalCost - sum(children.TotalCost).
Clamp negative results to 0 (can happen with InitPlans/CTE).
cost_basis = "cost". If mode=actual, duration is also cumulative per node:
duration_self = ActualTotalTime*ActualLoops - sum(children duration_self
adjusted for loops). Prefer cost for cost_pct; report duration_ms as the
self duration.

ROWS: rows_estimated = Plan Rows. rows_actual = Actual Rows * Actual Loops
(IMPORTANT: multiply by loops — a node with Actual Rows=1, Loops=50000
processed 50000 rows).

NORMALIZATION SPECIFICS:
- Seq Scan -> Full Table Scan.
- Index Scan with Index Cond -> Index Seek. Index Scan without Index Cond
  (or cond matching ~whole table) -> Index Scan.
- Index Only Scan -> Index Only Scan; if "Heap Fetches" > 20% of rows, add
  a Key Lookup mention in detail and consider warning missing_index is NOT
  right here — instead note VACUUM need in detail.
- Bitmap Index Scan + Bitmap Heap Scan: merge into ONE node
  operation="Bitmap Scan", target = the table, index_used = the bitmap
  index; mention both phases in detail. If "Lossy" blocks > 0 -> warning
  lossy_bitmap.
- Gather / Gather Merge -> Parallel; put "Workers Planned/Launched" into
  tooltip.extra.
- Sort: if "Sort Method" contains "external" -> warning spill_to_disk.
- HashJoin "Batches" > 1 -> warning spill_to_disk.

WARNING TRIGGERS:
- cardinality_mismatch: |Actual Rows*Loops vs Plan Rows| ratio > 10.
- stale_statistics: cardinality_mismatch on a base-table scan node.
- Rows Removed by Filter > 90% of scanned rows on a Seq Scan -> that scan
  is the prime missing_index candidate; predicate = the Filter expression.

INDEX DDL SYNTAX: CREATE INDEX idx_name ON table (col1, col2) INCLUDE (col3);
Partial index allowed when predicate is highly selective constant:
CREATE INDEX ... ON table (col) WHERE status = 'paid';
Column order: equality columns first, then range, then ORDER BY columns.
</dialect_notes>
```

### 6.2. mysql

```
<dialect_notes db="mysql">
PLAN STRUCTURE: mode=estimated -> raw_plan is EXPLAIN FORMAT=JSON
(query_block tree). mode=actual -> raw_plan contains BOTH the estimated
JSON and the EXPLAIN ANALYZE tree text; use the tree text for actual
rows/timing, the JSON for cost numbers.

COST RULE: use cost_info fields. cost_self for a table node =
read_cost + eval_cost. For query_block/nested_loop wrappers use
query_cost minus children costs, clamp to 0. cost_basis = "cost".
ANALYZE tree lines look like:
  -> Nested loop inner join (cost=X rows=Y) (actual time=A..B rows=R loops=L)
rows_actual = R * L. duration_ms of a node = B * L (B is per-loop
cumulative); self duration = subtract children the same way as postgres.

NORMALIZATION SPECIFICS:
- access_type ALL -> Full Table Scan. index -> Index Scan.
  ref/eq_ref/const/range with key -> Index Seek. Covering ("using_index":
  true) -> Index Only Scan.
- index_merge -> Bitmap Scan.
- "Using filesort" -> a Sort node child-of the reading node; warning
  filesort if input rows > 10,000.
- "Using temporary" -> Materialize node; warning temp_table if large.
- Hash join lines in ANALYZE tree -> Hash Join. Default joins in the JSON
  (nested_loop array) -> Nested Loop Join.
- attached_condition on a scan = tooltip.predicate.

WARNING TRIGGERS:
- implicit_conversion: attached_condition contains CAST/CONVERT around an
  indexed column, or comparing string column to number literal.
- missing_index: access_type ALL with attached_condition on a table whose
  row count in table_context > 10,000.

INDEX DDL SYNTAX: CREATE INDEX idx_name ON table (col1, col2);
No INCLUDE — covering = append columns to key list; mention the trade-off
in reason. Prefix index for long VARCHAR: col(20) — suggest only when
column length is large and note selectivity caveat.
</dialect_notes>
```

### 6.3. mariadb

```
<dialect_notes db="mariadb">
PLAN STRUCTURE: EXPLAIN FORMAT=JSON (estimated) or ANALYZE FORMAT=JSON
(actual). MariaDB's JSON differs from MySQL: actual metrics are INLINE:
r_rows (actual rows per scan), r_loops, r_total_time_ms, r_filtered.

COST RULE: MariaDB JSON often lacks cost_info. If cost numbers absent:
mode=actual -> cost_basis="duration", rank by r_total_time_ms;
mode=estimated -> cost_basis="rows_proxy", rank by rows * (filtered/100).
When cost_info exists use it like MySQL (cost_basis="cost").

rows_actual = r_rows * r_loops. duration_ms = r_total_time_ms (already
total, do NOT multiply by loops).

NORMALIZATION: same table as MySQL (access_type mapping). Additional:
- "Using join buffer (flat, BNL join)" -> Hash Join? NO — Block Nested
  Loop: keep operation="Nested Loop Join", put join buffer info in detail;
  BNLH/hash variants -> Hash Join.
- rowid filter -> mention in detail, keep parent operation.

WARNING TRIGGERS: same as MySQL, plus:
- cardinality_mismatch: r_rows*r_loops vs rows ratio > 10.

INDEX DDL SYNTAX: CREATE INDEX idx_name ON table (col1, col2);
Same rules as MySQL.
</dialect_notes>
```

### 6.4. mssql

```
<dialect_notes db="mssql">
PLAN STRUCTURE: raw_plan is Showplan XML. pre_parsed provided — copy
numbers verbatim. Key elements: RelOp nodes (PhysicalOp/LogicalOp,
EstimatedTotalSubtreeCost, EstimateRows), RunTimeInformation
(ActualRows, ActualElapsedms) when mode=actual, and MissingIndexes.

COST RULE (this mirrors what SSMS itself shows):
cost_self = EstimatedTotalSubtreeCost - sum(direct children's
EstimatedTotalSubtreeCost). Clamp to 0. cost_basis="cost".
cost_pct = cost_self / root.EstimatedTotalSubtreeCost * 100 — this must
match the "Cost: N%" a developer sees in SSMS.

ROWS: rows_estimated = EstimateRows * EstimateRebinds+1 context — keep
simple: EstimateRows. rows_actual = sum of ActualRows across threads in
RunTimeInformation.

NORMALIZATION SPECIFICS:
- PhysicalOp "Clustered Index Scan"/"Table Scan" -> Full Table Scan
  (yes, Clustered Index Scan IS a full scan — say so in detail, many
  developers misread it).
- "Index Seek"/"Clustered Index Seek" -> Index Seek.
- "Index Scan" -> Index Scan. "Key Lookup"/"RID Lookup" -> Key Lookup.
- "Hash Match" with LogicalOp containing "Join" -> Hash Join; with
  "Aggregate" -> Aggregate. "Stream Aggregate" -> Aggregate.
- "Nested Loops" -> Nested Loop Join. "Merge Join" -> Merge Join.
- "Sort" -> Sort. "Table Spool"/"Index Spool"/"Lazy Spool" -> Materialize.
- "Parallelism" -> Parallel. "Compute Scalar" -> Other (usually 0-cost,
  fine to keep severity ok).

WARNINGS — the XML gives them to you, extract don't infer:
- <Warnings> element: SpillToTempDb -> spill_to_disk;
  PlanAffectingConvert -> implicit_conversion;
  NoJoinPredicate -> no_join_predicate;
  ColumnsWithNoStatistics -> stale_statistics.
- Key Lookup with high executions (ActualRebinds/loops > 1000) ->
  bottleneck type key_lookup_storm.

MISSING INDEX: <MissingIndexes> element has Impact + column groups
(EQUALITY, INEQUALITY, INCLUDE). Convert directly:
impact_pct = Impact (impact_estimated=false),
ddl = CREATE NONCLUSTERED INDEX [IX_table_cols] ON [schema].[table]
([eq cols], [ineq cols]) INCLUDE ([include cols]);
</dialect_notes>
```

### 6.5. clickhouse

```
<dialect_notes db="clickhouse">
PLAN STRUCTURE: raw_plan contains up to 3 sections:
[EXPLAIN_INDEXES] step tree with index usage per ReadFromMergeTree
  ("Granules: x/y", "Parts: a/b", PrimaryKey/MinMax/Partition/Skip index
  conditions),
[EXPLAIN_ESTIMATE] table with parts/rows/marks to read,
[QUERY_LOG] (optional, mode=actual) read_rows, read_bytes, elapsed.

CLICKHOUSE HAS NO PER-NODE COST. cost rule:
mode=actual with QUERY_LOG -> cost_basis="duration", distribute by stage
if breakdown exists, else put total on the ReadFromMergeTree node.
Otherwise cost_basis="rows_proxy": cost_self proxy = rows the step
processes (from ESTIMATE for reads; carry-through for transforms).
NEVER output a fabricated "cost" number: total.cost = null.

MENTAL MODEL SHIFT (explain this way in detail/summary):
"index" here means: (a) primary key = ORDER BY key -> sparse index over
granules; (b) skip indexes (minmax/set/bloom_filter); (c) partition key
pruning. There are NO row-level secondary indexes.

NORMALIZATION:
- ReadFromMergeTree with Granules x/y where x/y > 0.5 -> Full Table Scan
  + warning full_granule_scan; message must include "đọc x/y granules".
  x/y < 0.2 -> Index Seek (primary key lọc tốt). Between -> Index Scan.
- Sorting steps -> Sort. Aggregating -> Aggregate. Filter -> Filter.
  Joins -> Hash Join (default algo) unless plan says otherwise.
- PIPELINE thread counts -> tooltip.extra.threads; a wide pipeline is
  Parallel info, usually not its own node.

SUGGESTIONS (index_suggestions semantics differ):
1. Skip index: ddl = ALTER TABLE t ADD INDEX idx_name (col) TYPE
   bloom_filter GRANULARITY 4; (choose type: minmax for ranges on
   correlated cols, set(N) for low cardinality, bloom_filter for point
   lookups on high cardinality).
2. ORDER BY redesign: when the filter column should lead the sort key,
   ddl = "-- Đề xuất tạo lại bảng với ORDER BY (col_a, col_b)" and explain
   migration cost in reason, confidence never above medium.
3. PREWHERE rewrite -> query_rewrites, not index_suggestions.
</dialect_notes>
```

### 6.6. sqlite

```
<dialect_notes db="sqlite">
PLAN STRUCTURE: raw_plan is EXPLAIN QUERY PLAN text: indented rows like
`SCAN t`, `SEARCH t USING INDEX idx (col=?)`, `USE TEMP B-TREE FOR ORDER
BY`, `MATERIALIZE`, `CO-ROUTINE`. table_context includes PRAGMA
index_list/table_info output.

limited_analysis = true ALWAYS for sqlite. No cost, no timing:
cost_basis = "rows_proxy" using table row counts from table_context when
available, else "none" with all cost_pct heuristic: give the SCAN nodes
the bulk (e.g. one SCAN -> 80%+), trivial nodes near 0. Keep cost_pct
summing ~100 anyway (UI depends on it) but confidence of every
conclusion is capped at medium.

NORMALIZATION:
- SCAN t -> Full Table Scan. SEARCH t USING INDEX/PK -> Index Seek.
- USING COVERING INDEX -> Index Only Scan.
- USE TEMP B-TREE FOR ORDER BY/GROUP BY -> Sort (warning filesort if the
  scanned table is known-large). MATERIALIZE/CO-ROUTINE -> Materialize.
- Joins are implicit by nesting order: outer loop = first listed table.
  Emit a Nested Loop Join node as parent of each join pair, child_order
  by listing order.

INDEX DDL SYNTAX: CREATE INDEX idx_name ON table (col1, col2);
Partial: CREATE INDEX ... WHERE cond; Expression indexes allowed.
Cross-check sqlite_master DDL in table_context before suggesting.
</dialect_notes>
```

### 6.7. cassandra

```
<dialect_notes db="cassandra">
PLAN STRUCTURE: raw_plan is TRACE EVENTS (system_traces): rows of
(activity, source, source_elapsed_us, thread). There is no plan tree —
YOU build one from the trace phases:
  Result (root, coordinator)
   └─ Aggregate (coordinator merge, if applicable)
       └─ Parallel (fan-out to replicas, if >1 replica contacted)
           └─ per-replica read: Index Seek (single-partition read) or
              Full Table Scan (range scan / ALLOW FILTERING)
               └─ Filter (if post-read filtering happened)
Collapse replicas into ONE representative node; put replica count and
per-replica timings into tooltip.extra.

limited_analysis = true ALWAYS. cost_basis = "duration":
cost_self from source_elapsed_us deltas grouped by phase. duration_ms =
elapsed/1000 rounded.

CRITICAL PATTERNS to detect from activity text:
- "ALLOW FILTERING" in the query, or activities showing per-row filtering
  across partitions -> warning allow_filtering + severity critical.
- "Read N live rows and M tombstone cells" with M > N -> warning
  tombstone_scan; message includes both numbers.
- Query WHERE clause lacking the full partition key (check against
  table_context DESCRIBE) -> that read is Full Table Scan, severity
  critical, explanation: "query không dùng partition key (pk là ...)".

SUGGESTIONS — do NOT default to secondary indexes:
- Secondary index: ONLY for low-cardinality columns queried within a
  known partition; confidence low otherwise. ddl = CREATE INDEX ON t (col);
- Preferred suggestions (as index_suggestions with empty ddl + reason, or
  query_rewrites): redesign table with a different PRIMARY KEY, create a
  denormalized query table, or SAI index (CREATE CUSTOM INDEX ... USING
  'StorageAttachedIndex') if server_version supports it (Cassandra 5.x).
- missing_index_banner: only when a concrete DDL exists with confidence
  >= medium; otherwise null and put redesign advice in summary.
</dialect_notes>
```

---

## 7. LAYER 1.5 — PRE-PARSERS (parsing/)

Chỉ 4 dialect có structured plan đáng parse: **postgres (JSON), mysql (JSON + tree text), mariadb (JSON), mssql (XML)**. Parser output là mảng node trung gian:

```typescript
export interface PreParsedNode {
  path: string;               // "0.1.0" — vị trí trong tree để LLM đối chiếu
  raw_operation: string;
  relation: string | null;
  index: string | null;
  cost_total: number | null;  // cumulative
  cost_self: number | null;   // đã trừ children theo quy tắc §6
  rows_estimated: number | null;
  rows_actual: number | null; // đã nhân loops
  loops: number | null;
  duration_total_ms: number | null;
  duration_self_ms: number | null;
  extra: Record<string, string | number>;
}
```

- Parser tính sẵn `cost_self` và `duration_self` (trừ children, clamp 0) — vì đây là số học dễ sai nhất nếu để LLM làm.
- MSSQL parser trích luôn `<MissingIndexes>` và `<Warnings>` ra field riêng, đưa vào `<pre_parsed>`.
- Unit test cho mỗi parser với fixture plan thật (đặt trong `parsing/__fixtures__/`). Tối thiểu mỗi dialect 3 fixtures: simple select, join 2-3 bảng, query có sort/aggregate.

---

## 8. LAYER 3 — RENDERING SPEC (SSMS-STYLE)

### 8.1. Layout (layout.ts)

- Cây vẽ **phải sang trái**: root (Result) sát mép trái, leaves sát phải.
- Thuật toán: tính depth mỗi node (root=0); cột x = `PADDING + depth * COLUMN_WIDTH`, nhưng render đảo: node depth lớn nhất nằm phải... **Cách đơn giản đúng chuẩn SSMS**: layered tree layout với root bên trái:
  - `x = depth * (NODE_W + H_GAP)`, node vẽ từ trái.
  - `y`: post-order — leaf xếp tuần tự từ trên xuống theo `child_order`; node cha `y = trung bình y của children`.
  - `NODE_W = 180, NODE_H = 56, H_GAP = 70, V_GAP = 24`.
- Mũi tên đi từ node con (phải) → node cha (trái), tức là **ngược hướng đọc, thuận hướng data flow** — đầu mũi tên chỉ vào node cha, giống SSMS.

### 8.2. PlanArrow

- Độ dày: `clamp(1.5, 1.5 + log10(max(rows_out,1)) * 1.3, 8)` px.
- Label rows đặt trên mũi tên, format gọn: `985K rows`, `1.2M rows` (locale-aware).
- Hover mũi tên → tooltip: estimated vs actual rows.

### 8.3. PlanNode

- Icon theo `icon` field (map sang icon set có sẵn của project — nếu chưa có đủ icon, dùng bộ icon chung + chữ, KHÔNG thêm icon library mới).
- Dòng 1: `{operation}` (+ ` · {target}` nếu có). Dòng 2: `Cost: {cost_pct}%` + duration nếu có.
- Viền/màu nền theo `severity`: ok = mặc định, warning = vàng nhạt, critical = đỏ nhạt.
- Badge ⚠ góc trên phải khi `warnings.length > 0`; hover badge → liệt kê warnings.
- Click node → mở `NodeDetailPanel` (predicate, est vs actual rows kèm ratio, index_used, duration, toàn bộ `tooltip.extra`, `detail`).

### 8.4. MissingIndexBanner

- Chỉ hiện khi `missing_index_banner != null`. Nền xanh lá nhạt, text: `Missing index (Impact {~}{impact_pct}%): {ddl}` — thêm `~` khi `impact_estimated`.
- Nút **Copy DDL** và nút mở panel `reason`.
- Click banner scroll + highlight node trong `related_node_ids` của suggestion tương ứng.

### 8.5. SummaryBar (trên cùng, dưới banner)

- Verdict pill (good/warning/critical) + `summary` text.
- KPI: total duration (nếu có), total rows, số bottlenecks, mode + dialect + badge `Limited analysis` khi `limited_analysis`, chú thích `Cost ước lượng từ {duration|rows}` khi `cost_basis != "cost"`.

### 8.6. Trạng thái phụ

- Loading (đang chạy EXPLAIN → đang phân tích, 2 bước hiển thị riêng, có Cancel).
- Error: hiện raw plan trong `<pre>` + thông báo lỗi — **luôn cho xem raw plan** kể cả khi LLM fail, đây là fallback bắt buộc.
- Tab "Raw plan": mọi lúc đều có tab xem raw plan gốc.

---

## 9. TASK BREAKDOWN CHO CLAUDE CODE

Thực hiện tuần tự, mỗi task pass gates rồi mới sang task sau:

- **T-EX1** — `types.ts` + JSON Schema + `schema-validator.ts` + unit tests validator (bao gồm test các rule §4.1: cycle, sum cost_pct, index trùng).
- **T-EX2** — Layer 1 acquisition cho postgres + mysql + mssql (3 dialect chính), gồm safety wrap DML + timeout + version check. Integration test với DB test containers nếu project đã có sẵn hạ tầng testcontainer; nếu chưa có → mock ở tầng driver, KHÔNG thêm testcontainer mới.
- **T-EX3** — Acquisition cho mariadb + clickhouse + sqlite + cassandra.
- **T-EX4** — Pre-parsers (postgres, mysql, mariadb, mssql) + fixtures + unit tests. Đây là task nhiều edge case nhất — mỗi quy tắc cost_self trong §6 phải có test riêng.
- **T-EX5** — `prompt-builder.ts` + `dialect-blocks.ts` (copy nguyên văn §5, §6) + `llm-client.ts` + retry-on-validation-fail. Unit test: snapshot prompt cho từng dialect; test truncation 50KB.
- **T-EX6** — Rendering: layout.ts + PlanTree/PlanNode/PlanArrow (vitest cho layout math: depth, y trung bình, arrow width formula).
- **T-EX7** — MissingIndexBanner + NodeDetailPanel + SummaryBar + trạng thái loading/error/raw-plan tab.
- **T-EX8** — Wire vào query editor (1 entry point duy nhất) + Playwright e2e: chạy Explain trên 1 query mẫu (mock LLM response bằng fixture UnifiedExplainResult), assert banner, node critical màu đỏ, click node mở panel, tab raw plan.
- **T-EX9** — Chạy TOÀN BỘ test suite của project (mọi gate), xác nhận zero regression, báo cáo kèm output nguyên văn.

### Definition of Done (toàn feature)

1. 7 dialect đều chạy được Explain (estimated tối thiểu; actual với dialect hỗ trợ).
2. Mọi LLM output qua validator; fail 2 lần → fallback raw plan, không crash, không hiện dữ liệu sai.
3. UI khớp §8: right-to-left tree, cost %, arrow theo rows, banner, detail panel, raw plan tab.
4. Không sửa file nào ngoài `src/features/explain/` trừ đúng 1 chỗ wire entry point (nêu rõ file + diff trong báo cáo).
5. Toàn bộ gates xanh, bao gồm test cũ của các feature khác.
