# SPEC — Query Plan / EXPLAIN (Visualizer chuẩn hóa đa-engine)

> **Tài liệu này dành cho DEV MỞ RỘNG tính năng**, không phải người dùng cuối. Nó mô tả kiến
> trúc EXPLAIN **đúng như code hiện tại**, kèm `file:line` ở các điểm quan trọng.
>
> ### ⚠️ Deprecated — bản spec trước (KHÔNG còn đúng, giữ lại để ghi nhận)
> Bản `SPEC-EXPLAIN-FEATURE.md` cũ mô tả một thiết kế **LLM-based 3 tầng viết bằng TypeScript** ở
> `src/features/explain/` (acquisition → pre-parse → LLM analysis → JSON-Schema validator → rendering
> SSMS), với contract `UnifiedExplainResult`, vocabulary 16 tên có `icon`, `prompt-builder`/`dialect-blocks`/
> `llm-client`/`schema-validator`. **Thiết kế đó CHƯA từng được build.** `Glob src/features/explain/**` =
> không có file nào; không có LLM, prompt, hay validator trong code. Toàn bộ nội dung LLM/TS ở bản cũ =
> Deprecated. Bản dưới đây mô tả hiện thực thật: **parser thuần Rust, không LLM.**

---

## 1. Mục đích & phạm vi

Chạy `EXPLAIN` (hoặc cơ chế tương đương) trên câu lệnh của người dùng, rồi **map kết quả native của
mỗi engine về MỘT struct chuẩn `QueryPlan`** để một component visualizer duy nhất hiển thị cho mọi hệ.

Hỗ trợ: PostgreSQL, MySQL, MariaDB, MSSQL, SQLite, ClickHouse, Cassandra (tracing), Oracle, MongoDB
(`.explain()`). Redis/Kafka/NATS trả `not_applicable` (nút Explain disabled, không lỗi).

Hai chế độ: **estimated** (mặc định, không chạy query thật) và **actual** (chạy thật —
`EXPLAIN ANALYZE`/`SET STATISTICS XML`/tracing/`executionStats`), chỉ bật khi người dùng chủ động chọn
và engine hỗ trợ (`capability().supports_actual`).

---

## 2. Kiến trúc & ranh giới module

Ba tầng, tách bạch rõ:

| Tầng | File | Trách nhiệm | KHÔNG được lẫn |
|---|---|---|---|
| **Parser thuần** | `src-tauri/src/drivers/plan.rs` | Nhận text/JSON/XML/rows thô → dựng `QueryPlan`. **Không I/O**, unit-test được. | Không chạy DB, không biết `conn_id`, không gọi registry. |
| **Orchestration** | `src-tauri/src/commands/plan.rs` | Chọn câu EXPLAIN theo dialect, chạy qua registry, lấy rows, gọi parser. Guard an toàn (chặn câu ghi). | Không chứa logic parse cây (uỷ cho `plan.rs`). |
| **Frontend** | `src/lib/ipc.ts` + `PlanVisualizer.svelte` + `ResultPlanView.svelte` | Gọi command, render cây node. Chỉ làm việc với struct chuẩn. | Không tự parse plan; không tự đoán engine nào có actual (hỏi `explain_capability`). |

**Luồng gọi (estimated, engine SQL thường):**
`PlanVisualizer.svelte:47` → `ipc.explainPlan` (`ipc.ts:651`) → command `explain_plan`
(`commands/plan.rs:14`) → `build_explain` (`commands/plan.rs:255`) → `registry.exec_statement` →
`parse_for_system` (`commands/plan.rs:276`) → `plan::parse_*` (`drivers/plan.rs`) → trả `QueryPlan`.

Command đăng ký ở `src-tauri/src/lib.rs:157-158` (`explain_plan`, `explain_capability`) — **command chưa
đăng ký ở đây là command chết**.

Các engine KHÔNG đi qua `build_explain`/`parse_for_system` mà có nhánh riêng trong `explain_plan`
(vì cơ chế khác SQL EXPLAIN thuần):
- **MongoDB** → `explain_mongo` (`commands/plan.rs:233`) → driver `.explain_mongo()` → `parse_mongodb` (`plan.rs:995`).
- **Cassandra** → `explain_cassandra` (`:210`) → driver `.trace_cql()` → `parse_cassandra_trace` (`plan.rs:937`).
- **MSSQL** → `explain_mssql` (`:113`) → `SET SHOWPLAN_XML/STATISTICS XML` → `parse_mssql_xml` (`plan.rs:788`).
- **Oracle** → `explain_oracle` (`:152`) → `EXPLAIN PLAN … FOR` + đọc `PLAN_TABLE` → `parse_oracle` (`plan.rs:1140`).
- **PostgreSQL + câu GHI + actual** → `explain_pg_actual_dml` (`:184`) → bọc `BEGIN … ROLLBACK`.

---

## 3. Điểm mở rộng (extension points)

### 3.1. Thêm EXPLAIN cho một engine SQL mới (đi qua đường chung)
1. **`drivers/plan.rs`**: viết `pub fn parse_<engine>(...) -> QueryPlan` (hoặc `Result<QueryPlan,String>`),
   dùng `QueryPlan_ok(...)` (`plan.rs:1115`) để đóng gói + `assign_cost_pct` (`:1204`) + `mark_hotspot`
   (`:1241`). Ánh xạ tên toán tử gốc qua `normalize_op` (`:179`) — thêm nhánh nếu engine có tên mới.
2. **`plan.rs::capability`** (`:141`): thêm `"<engine>" => (has_planner, ActualKind, CostBasis)`.
3. **`commands/plan.rs::build_explain`** (`:255`): thêm nhánh sinh câu EXPLAIN native.
4. **`commands/plan.rs::parse_for_system`** (`:276`): thêm nhánh gọi `plan::parse_<engine>`.
5. Nếu engine cần cơ chế đặc biệt (không phải `EXPLAIN <sql>` trả rows) → thêm nhánh riêng trong
   `explain_plan` TRƯỚC khối `build_explain` chung (như MSSQL/Oracle/Cassandra/Mongo).
6. Frontend thường KHÔNG cần đổi (dùng chung `explainPlan`/`QueryPlan`). UI tự bật/tắt toggle Actual theo
   `explain_capability`.

### 3.2. Thêm engine không-SQL / cơ chế riêng
Viết `async fn explain_<engine>(state, conn_id, sql, …)` trong `commands/plan.rs`, gọi driver qua
`registry.with_driver(...)` (xem `explain_cassandra:210`, `explain_mongo:233`), trả `QueryPlan`. Thêm
short-circuit trong `explain_plan` theo `system`.

### 3.3. Ví dụ thật đã tồn tại — "Oracle được thêm như thế nào" (đường đi mẫu)
Truy ngược Oracle để thấy đủ các chạm:
- `commands/plan.rs:74`: short-circuit `if system == "oracle" { return explain_oracle(...) }`.
- `commands/plan.rs:152` `explain_oracle`: `EXPLAIN PLAN SET STATEMENT_ID='dbstudio' FOR <sql>` (chỉ nạp
  `PLAN_TABLE`, KHÔNG chạy câu lệnh → an toàn cả với câu ghi) → `SELECT id, parent_id, operation, options,
  object_name, cardinality, cost FROM plan_table … ORDER BY id` → `plan::parse_oracle(&rows)`.
- `drivers/plan.rs:1140` `parse_oracle`: dựng cây theo `parent_id`; `normalize_op` map "TABLE ACCESS FULL"
  → SeqScan, "INDEX UNIQUE SCAN" → IndexSeek (`plan.rs:183-193`).
- `plan.rs:152` `capability("oracle")` = `(true, ActualKind::None, CostBasis::Cost)` → estimated-only.
- `ipc.ts` không đổi. FE bật/tắt toggle Actual theo `explain_capability`.
- Test: `tests/oracle_o0.rs` (Oracle `#[ignore]` — cần Instant Client).

Làm engine mới → lặp đúng bộ chạm này. MongoDB là ví dụ cho nhánh không-SQL (`explain_mongo` + `parse_mongodb`).

---

## 4. Hợp đồng dữ liệu & interface (KHÔNG đổi tuỳ tiện)

Struct Rust `drivers/plan.rs` và interface TS `ipc.ts:623-662` phải **khớp field 1:1** (serde snake_case).

```
QueryPlan {                               // plan.rs:72 / ipc.ts:642
  system: string,
  mode: "estimated"|"actual"|"tracing"|"not_applicable",
  root?: PlanNode,
  summary: { total_cost?, total_time_ms?, warnings: string[] },   // plan.rs:54
  raw: string,                            // bản gốc JSON/XML/text/trace cho nút "View raw"
  missing_index?: { impact_pct, table, ddl, reason }   // plan.rs:64 — hiện chỉ MSSQL
}
PlanNode {                                // plan.rs:11 / ipc.ts:623
  operation: string,        // TÊN CHUẨN HÓA (SeqScan/IndexScan/IndexSeek/HashJoin/Sort/Aggregate/…)
  native_op: string,        // tên gốc engine (giữ để tham chiếu) — KHÔNG nằm trong `extra`
  estimated_rows?, actual_rows?, estimated_cost?,
  cost_self?,               // = cost node − Σ cost con (engine cumulative)
  cost_pct?,                // % self-cost trên tổng cây (kiểu "Cost: N%")
  actual_time_ms?,
  extra: Record<string, any>,   // relation/filter/join cond/buffers/loops…
  children: PlanNode[],
  is_hotspot: boolean
}
EngineCapability {                        // plan.rs:130 / ipc.ts:655
  has_planner: boolean,
  supports_actual: boolean,               // = actual_kind != None
  actual_kind: "none"|"analyze"|"tracing",
  cost_basis: "cost"|"duration"|"rows_proxy"|"none"
}
```

Bảng `capability()` hiện tại (`plan.rs:141-167`):

| system | has_planner | actual_kind | cost_basis |
|---|---|---|---|
| postgres, mariadb, mysql, mssql | true | Analyze | Cost |
| sqlite, clickhouse | true | None | RowsProxy |
| oracle | true | None | Cost |
| mongodb | true | Analyze | RowsProxy |
| cassandra | false | Tracing | Duration |
| khác (redis/kafka/nats/unknown) | false | None | None |

> **Lưu ý:** đây KHÔNG phải `UnifiedExplainResult` của spec cũ. Không có `verdict`, `bottlenecks`,
> `index_suggestions[]`, `query_rewrites`, `cost_basis` (ở cấp result), hay `id/parent_id/child_order/
> icon/op_category/severity/tooltip` trên node. `warnings` là `string[]` tự do, KHÔNG phải enum `WarningType`.

---

## 5. Bất biến & giả định

- **Parser `plan.rs` phải thuần** (không I/O). Phá bất biến này → mất unit-test + rối tầng.
- **`operation` luôn là tên đã chuẩn hóa; `native_op` giữ tên gốc.** UI dựa vào `operation`.
- **`raw` luôn được giữ** (chuỗi gốc) cho nút "View raw".
- **An toàn actual:** câu GHI (`is_write_statement`, `commands/plan.rs:401`) + `actual=true` chỉ được phép
  ở **PostgreSQL** (bọc `BEGIN…ROLLBACK`, `explain_pg_actual_dml:184`); engine khác trả lỗi
  (`commands/plan.rs:53-59`). Cassandra chặn câu ghi ở CẢ 2 mode vì tracing = chạy thật (`:45`).
- **Redis/Kafka/NATS** → `QueryPlan::not_applicable` (`plan.rs:88`), không bao giờ ném lỗi.
- `capability()` là **nguồn duy nhất** cho biết engine có actual/cost hay không — UI KHÔNG tự suy diễn.

---

## 6. Quy ước phải theo

- Câu EXPLAIN luôn `sql.trim().trim_end_matches(';')` trước khi ghép (xem `build_explain`).
- SET options MSSQL (SHOWPLAN/STATISTICS) phải **tắt lại best-effort** kể cả khi query lỗi
  (`explain_mssql:129`); transaction PG phải **ROLLBACK best-effort** (`explain_pg_actual_dml:198`). Không
  để connection kẹt.
- Lỗi trả `AppError::Driver(...)` với thông điệp đọc được; **không panic** (parser trả `Result`/fallback
  `not_applicable`, xem `parse_oracle:1197`).
- Thêm parser → thêm unit test thuần trong `plan.rs` (đã có nhiều `#[test]` cạnh parser) + integration
  test container ở `tests/explain_verification.rs`.

---

## 7. Cạm bẫy đã biết (gotchas)

- **`normalize_op` — thứ tự nhánh QUAN TRỌNG** (`plan.rs:174-244`): `seek` phải xét TRƯỚC mọi nhánh scan
  ("Clustered Index Seek" ≠ scan). "Clustered Index Scan"/"Table Scan" là **FULL SCAN** dù có chữ "index"
  → SeqScan. `SCAN t` trần (SQLite, không index) → SeqScan; `SEARCH … USING INDEX` → IndexScan.
- **MSSQL SET phải chạy qua raw batch:** `execute()` = sp_executesql KHÔNG giữ SET option → SHOWPLAN im
  lặng hỏng. Driver route `SET …` qua `simple_query` (`is_raw_batch` trong `drivers/mssql.rs`). Đây là lý
  do MSSQL plan từng vỡ.
- **PG estimated cố ý KHÔNG có `BUFFERS`/`VERBOSE`** (`build_explain:261` chỉ `EXPLAIN (FORMAT JSON)`) để
  tránh lỗi trên PG < 16. Chỉ actual mới `(ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` (`:260`).
- **ClickHouse chỉ chạy `EXPLAIN indexes = 1`** (`build_explain:271`) — KHÔNG `EXPLAIN ESTIMATE`/`PIPELINE`;
  không có nhánh actual (`capability` = RowsProxy, ActualKind::None).
- **`assign_cost_pct(root, cumulative)`** (`plan.rs:1204`): PG dùng `cumulative=true` (Total Cost tích
  luỹ) — sai cờ này thì % cost lệch. Self-cost = total − Σ con, clamp ≥ 0.
- Cassandra tracing → hiển thị **timeline node** (không phải cây); cờ ALLOW FILTERING suy ở normalize.
- `parse_for_system` trả **typed error** (không panic) khi EXPLAIN không trả rows (`commands/plan.rs:87`;
  test `parse_for_system_non_rows_is_typed_error:482`).

---

## 8. Giới hạn hiện tại & TODO

- **Oracle**: chỉ estimated (`ActualKind::None`); actual qua `GATHER_PLAN_STATISTICS` + `DISPLAY_CURSOR`
  là refinement sau (`plan.rs:150-151` ghi rõ).
- **ClickHouse**: không actual; không dùng `EXPLAIN ESTIMATE/PIPELINE`.
- **MSSQL actual + câu GHI**: bị chặn (chỉ PG bọc rollback). Có thể mở bằng `BEGIN TRAN … ROLLBACK`.
- **`missing_index`**: hiện chỉ MSSQL (`<MissingIndexes>` trong SHOWPLAN, `parse_mssql_missing_index:813`).
  PG/khác chưa có gợi ý missing-index trong QueryPlan (Index Scanner có nhánh riêng — xem addendum
  EXECUTE_PLAN_AND_INDEX_SCAN + `drivers/index_scan.rs`).
- Không có tầng "index_suggestions/query_rewrites/verdict/bottlenecks" như spec cũ (chủ đích bỏ).

---

## 9. Cách chạy & test cục bộ

**Unit test thuần (không cần DB)** — parser + `is_write_statement`/`build_explain`:
```
cargo test --lib plan::
```

**Integration test container thật** — `tests/explain_verification.rs` phủ:
- SQLite `xv_t1_sqlite_scan_vs_index` (`:92`)
- PostgreSQL `xv_t1_postgres_scan_index_actual_errors` (`:183`), `xv_p0_postgres_actual_dml_rolls_back` (`:310`)
- MySQL `xv_t1_mysql_scan_index_and_actual` (`:366`)
- MariaDB `xv_t2_mariadb_scan_index_analyze_actual` (`:465`)
- MSSQL `xv_t2_mssql_scan_index_and_actual` (`:533`)
- ClickHouse `xv_t2_clickhouse_fullread_vs_key` (`:653`)
- Cassandra `xv_t2_cassandra_tracing_no_fabricated_cost` (`:729`)
```
cargo test --test explain_verification xv_t1_postgres_scan_index_actual_errors -- --nocapture --test-threads=1
```
> MongoDB explain có test ở `tests/mongo_integration.rs`; Oracle ở `tests/oracle_o0.rs` (`#[ignore]`, cần
> Oracle Instant Client). `explain_verification.rs` KHÔNG bao Mongo/Oracle.

**Frontend (demo, không cần Tauri):** `explain_plan`/`explain_capability` có case trong `src/lib/demo.ts`
→ Vitest/Playwright chạy được đường explain qua demo path. Tab `query-plan` mở qua
`tabs.openQueryPlan` (`stores/tabs.svelte.ts:567`); kết quả nạp ở `stores/results.svelte.ts:102`.
