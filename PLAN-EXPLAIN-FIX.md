# PLAN — Sửa chức năng EXPLAIN (hướng deterministic)

> **Single source of truth khi implement các bản sửa EXPLAIN.**
> Hướng đi: **KHÔNG dùng LLM**. Giữ nguyên kiến trúc parser Rust deterministic hiện có,
> sửa cho đúng bản chất từng engine. Đi theo Verification Report + 5 phát hiện bổ sung.
> Đọc `EXPLAIN_VERIFICATION_REPORT.md` và artifact tư vấn trước khi bắt đầu.
> **KHÔNG** implement `SPEC-EXPLAIN-FEATURE.md` (bản LLM — đã loại).

---

## 0. NGUYÊN TẮC & GUARDRAILS (BẮT BUỘC)

### 0.1. Phạm vi & isolation
- **CHỈ** sửa các file EXPLAIN liệt kê ở §0.4. Không refactor, không "tiện tay cải thiện" module khác (Grid, ObjectExplorer, connection manager, results…).
- Nếu cần API hạ tầng chưa có (vd chạy nhiều statement trong 1 transaction từ command) → **DỪNG, báo cáo, đề xuất**, không tự đổi signature của registry/driver.
- Giữ **4 nền tảng tốt** (không rewrite): 1 model `QueryPlan` chung · `raw` luôn preserved · parser thuần tách I/O · `native_op` giữ tên gốc.

### 0.2. Kỷ luật test (không bỏ qua)
- Mỗi task kết thúc bằng **output nguyên văn** của gates, không tóm tắt.
- Gates bắt buộc: `npm run check` (0/0) · `npx vitest run` · `npx playwright test` (spec liên quan) · `cargo test --lib plan::` · integration khi đụng backend.
- **Integration test theo đúng methodology CLAUDE.md**: prebuild `--no-run` trước, chạy **one-shot** với `timeout`, ghi log, in EXIT, đọc log cùng lệnh. KHÔNG background, KHÔNG `docker rm`/prune theo label testcontainers.
- 1 task/commit. Unit + integration xanh mới commit. **KHÔNG nới assertion** để test qua.
- Chạy **toàn bộ** suite sau mỗi task để chứng minh zero regression (đặc biệt `explain_verification.rs`).

### 0.3. An toàn khi Actual
- Mode Actual thực thi query THẬT. Với DML phải bảo vệ (xem P0). Không để confirm() là hàng rào duy nhất.

### 0.4. File inventory (chạm vào đúng những file này)

**Backend**
- `src-tauri/src/commands/plan.rs` — orchestration (build_explain, explain_mssql/cassandra, parse_for_system, +DML guard, +capability).
- `src-tauri/src/drivers/plan.rs` — normalize_op, parse_*, mark_hotspot, QueryPlan/PlanNode, +capability descriptor, unit tests.

**Frontend**
- `src/lib/ipc.ts` — type `QueryPlan`/`PlanNode` (thêm field nếu đổi shape) + type capability.
- `src/lib/demo.ts` — mock `explain_plan` phải khớp shape mới (nếu không → Playwright/browser vỡ).
- `src/lib/components/workspace/PlanVisualizer.svelte` — badge mode, toggle Actual (đọc capability), tracing note.
- `src/lib/components/workspace/PlanNodeBox.svelte` — hiển thị op mới / cost% (P3).

**Tests**
- `src-tauri/src/drivers/plan.rs` `#[cfg(test)]` — unit parser/normalize.
- `src-tauri/tests/explain_verification.rs` (harness đã có) hoặc `drivers_integration.rs` — integration per-engine.
- `tests/visual/*.spec.ts` — e2e render (mock plan qua demo).

### 0.5. Checklist xuyên suốt (kiểm mỗi task đụng shape)
Khi thêm/đổi field trong `QueryPlan`/`PlanNode` hoặc thêm mode value:
1. `plan.rs` struct + serialize.
2. `ipc.ts` type khớp.
3. `demo.ts` mock khớp (nếu không, e2e vỡ).
4. `PlanVisualizer`/`PlanNodeBox` render field mới có guard `null`.
5. Unit test parser cập nhật cùng lúc (không để lệch bộ op).

---

## 1. BẢN ĐỒ TASK → DEFECT

| Phase | Task | Defect đóng | Loại |
|---|---|---|---|
| **P0** | EXP-P0.1 | SAFE-ACTUAL-DML (High, mới) | Safety |
| **P1** | EXP-P1.1 | Nền: EngineCapability + UI toggle honesty → phần "misleading" của DEF-MYSQL-ACTUAL-NOOP | Lòng tin |
| **P1** | EXP-P1.2 | DEF-MSSQL-CLUSTERED-SCAN (High) + DEF-SQLITE-LABEL (Low) | Lòng tin |
| **P1** | EXP-P1.3 | DEF-CASS-ACTUAL-BADGE (High) | Lòng tin |
| **P2** | EXP-P2.1 | DEF-PG-HOTSPOT (Med) + DEF-PG-LOOPS (Med, mới) | Độ đúng |
| **P2** | EXP-P2.2 | DEF-CH-GRANULE-BLIND (Med) + DEF-CH-METADATA-NODES (Low) | Độ đúng |
| **P2** | EXP-P2.3 | DEF-MYSQL-TREE-PARTIAL (Med, mới) | Độ đúng |
| **P3** | EXP-P3.1 | FEAT cost% self-cost | Giá trị |
| **P3** | EXP-P3.2 | FEAT MSSQL Missing-Index banner | Giá trị |
| **P3** | EXP-P3.3 | Actual thật cho MySQL/MSSQL (phần còn lại DEF-MYSQL-ACTUAL-NOOP + MSSQL estimated-only) | Giá trị (stretch) |
| **P3** | EXP-P3.4 | Phủ test G2/G3/G4 | Coverage |

---

## P0 — AN TOÀN (làm trước mọi thứ)

### EXP-P0.1 — Chặn/rollback Actual trên DML — ✅ DONE
> Commit `EXP-P0.1`. Guard trong `commands/plan.rs`: `is_write_statement` (strip comment + verb đầu + CTE ghi) → Cassandra ghi bị chặn (tracing thực thi cả 2 mode); Actual+ghi: PostgreSQL bọc `BEGIN…ROLLBACK` (`explain_pg_actual_dml`, rollback luôn chạy), hệ khác trả typed error. Frontend đổi message confirm. **Lệch nhẹ so với plan gốc** (an toàn hơn): plan viết "PG/MSSQL wrap, còn lại block" nhưng thực tế chỉ PG actual THỰC THI query (MSSQL SHOWPLAN + MySQL/CH/SQLite không execute) → chọn "PG wrap, tất cả còn lại block". Gates: check 0/0, vitest 510, `cargo test --lib plan::` 13 (2 mới), integration `xv_p0_postgres_actual_dml_rolls_back` EXIT=0 (wrapped giữ 100 rows + mode=actual; bare EXPLAIN ANALYZE DELETE → 0 rows = ground truth wrap cần thiết). MySQL-blocked chỉ unit-covered (`write_detection`) vì block nằm ở command layer, không có cơ chế driver để integration.

**Vì sao:** `PlanVisualizer.toggleActual` chỉ `confirm()` rồi `explain_plan(actual=true)` → `EXPLAIN (ANALYZE…) <sql>` chạy & commit thật với `DELETE/UPDATE/INSERT`. Rủi ro mất dữ liệu.

**Backend (`commands/plan.rs`)**
1. Thêm hàm `is_write_statement(sql) -> bool`: strip comment + leading CTE (`WITH …`) rồi lấy keyword đầu; write = `INSERT|UPDATE|DELETE|MERGE|REPLACE|TRUNCATE|DROP|ALTER|CREATE`. (Dùng heuristic keyword — KHÔNG thêm dependency parser mới.)
2. Trong `explain_plan`, khi `actual == true` và `is_write_statement`:
   - **postgres / mssql**: bọc transaction — chạy tuần tự trên cùng connection (registry là 1-conn-per-profile nên cùng session): `BEGIN` → `EXPLAIN (ANALYZE…) <sql>` (lấy rows) → **luôn** `ROLLBACK` (kể cả lỗi, best-effort như `explain_mssql` đã làm với SHOWPLAN OFF). MSSQL dùng `BEGIN TRAN`/`ROLLBACK TRAN`.
   - **mysql / mariadb / clickhouse / sqlite**: trả typed error `AppError::Driver("Actual plan is disabled for write statements on <system>. Use Estimated.")` (không rollback tin cậy được).
3. SELECT (đọc) giữ nguyên hành vi hiện tại.

**Frontend (`PlanVisualizer.svelte`)**
- Giữ `confirm()` nhưng đổi message rõ hơn: "Actual runs the query. Write statements are rolled back (PG/MSSQL) or blocked (others)."
- Bắt error từ backend, hiện ở khối `error` sẵn có (đã có §render).

**Tests**
- Unit (Rust): `is_write_statement` — SELECT/WITH…SELECT = false; INSERT/UPDATE/DELETE/`WITH x AS (…) DELETE …` = true; comment-first `/*..*/ delete` = true.
- Integration `pg_explain_actual_dml_rolls_back`: seed N rows → `explain_plan(actual, "DELETE FROM t")` → `SELECT count(*)` vẫn = N (rollback) + plan có node/actual_rows.
- Integration `mysql_explain_actual_dml_blocked`: `explain_plan(actual, "DELETE …")` → `.is_err()`.

**DoD:** DML + Actual không bao giờ commit; gates xanh; `explain_verification.rs` không regress.

---

## P1 — LÒNG TIN (2 High + nền)

### EXP-P1.1 — EngineCapability descriptor + UI toggle honesty (nền) — ✅ DONE
> Commit `EXP-P1.1`. `drivers/plan.rs`: enum `ActualKind`(none/analyze/tracing) + `CostBasis`(cost/duration/rows_proxy/none) + `EngineCapability{has_planner,supports_actual,actual_kind,cost_basis}` + `capability(system)`. Command `explain_capability` (commands/plan.rs) + register lib.rs. Frontend: `ipc.EngineCapability` + `explainCapability`; demo mock (resolve system từ DEMO_PROFILES); `PlanVisualizer` fetch cap → **chỉ hiện toggle Actual khi `actual_kind==='analyze'`** (ẩn cho MySQL/MSSQL/SQLite/ClickHouse/Cassandra) + ép về estimated khi đổi sang engine không hỗ trợ. Gates: check 0/0, vitest 510, `cargo test --lib plan::` 14 (mới `capabilities`), e2e `query-plan` 2/2 (PG hiện Actual · MySQL ẩn Actual). Full playwright chỉ `table-viewer-footer` fail = **pre-existing** (đã verify fail trên `main` sạch).

**Vì sao:** `mode="actual"` đang gánh 3 nghĩa; toggle Actual hiện cho cả engine không hỗ trợ (MySQL/MSSQL/CH/SQLite) → im lặng trả estimated (phần "misleading" của DEF-MYSQL-ACTUAL-NOOP).

**Backend (`drivers/plan.rs` hoặc `commands/plan.rs`)**
1. Thêm struct + hàm thuần:
   ```
   pub struct EngineCapability {
     pub has_planner: bool,
     pub actual_kind: ActualKind,   // None | Analyze | Tracing
     pub cost_basis: CostBasis,     // Cost | Duration | RowsProxy | NoneBasis
   }
   pub fn capability(system: &str) -> EngineCapability
   ```
   Bảng: postgres/mariadb → `Analyze`,`Cost`; mysql → hiện tại `None` (đổi thành `Analyze` ở P3.3), `Cost`; mssql → `None`,`Cost` (→`Analyze` ở P3.3); sqlite → `None`,`RowsProxy`; clickhouse → `None`,`RowsProxy`; cassandra → `Tracing`,`Duration`; redis/kafka/nats → `has_planner=false`.
2. Command mới `explain_capability(conn_id) -> EngineCapability` (thin wrapper, resolve system như `explain_plan`). Đăng ký trong `invoke_handler!` (`lib.rs`).
3. Thêm giá trị mode `"tracing"` vào tài liệu contract (dùng ở P1.3).

**Frontend**
- `ipc.ts`: type `EngineCapability` + `explainCapability()`.
- `demo.ts`: mock `explain_capability` (theo system của conn demo).
- `PlanVisualizer.svelte`: fetch capability khi đổi connection; **ẩn/disable** toggle Actual khi `actual_kind == None`; tooltip "Engine này không hỗ trợ Actual". Không đổi hành vi PG/MariaDB.

**Tests**
- Unit (Rust): `capability()` cho 10 system.
- e2e: mở plan trên conn MySQL demo → toggle Actual disabled; PG demo → enabled.

**DoD:** UI không còn hứa Actual với engine không làm được; capability là 1 nguồn cho P1.3/P2/P3.

---

### EXP-P1.2 — MSSQL scan vs seek (+ SQLite label)
**Vì sao:** `normalize_op` gộp "Clustered Index Scan" (full scan) và "Index Seek" cùng ra `IndexScan` → thay đổi vật lý vô hình, full scan không flag. SQLite full scan giữ nhãn gốc `"SCAN t"`.

**Backend (`drivers/plan.rs`)**
1. `normalize_op` — thêm op `IndexSeek`; **thứ tự nhánh** (quan trọng, tránh gộp sai):
   1. chứa `"seek"` → `IndexSeek` (bắt cả "Clustered Index Seek").
   2. `"index only scan"` → `IndexOnlyScan`.
   3. `"bitmap"` → `BitmapScan`.
   4. full scan: `"seq scan"` | starts_with(`"scan"`) | `"table scan"` | `"clustered index scan"` | chứa `"full"` → `SeqScan`. *(→ MSSQL Clustered Index Scan và SQLite `SCAN t` cùng ra `SeqScan` — đóng luôn DEF-SQLITE-LABEL.)*
   5. `"index scan"` | `"index range"` → `IndexScan`.
   6. còn lại giữ như hiện tại.
2. `mark_hotspot`: flag `SeqScan` bảng lớn giữ nguyên; MSSQL có thể dùng `EstimateRows`/`TableCardinality` (đọc thêm attribute trong `build_mssql_node` nếu cần) để chắc chắn Clustered Index Scan quét nhiều → hotspot.
3. Giữ `native_op` nguyên bản (Index Seek / Clustered Index Scan) — không đổi.

**Frontend:** `PlanNodeBox` hiện `operation` dạng text nên op mới render tự nhiên; không bắt buộc thêm icon. (Tùy chọn: map `IndexSeek`/`SeqScan` → icon/màu.)

**Tests**
- Unit: `normalize_op("Clustered Index Scan")=="SeqScan"`, `normalize_op("Index Seek")=="IndexSeek"`, `normalize_op("Clustered Index Seek")=="IndexSeek"`, `normalize_op("SCAN t")=="SeqScan"`, và **giữ** các assertion cũ (`"Index Scan"=="IndexScan"`, `"Seq Scan"=="SeqScan"`…).
- Integration `mssql_clustered_scan_vs_seek`: query không index → `SeqScan` + `is_hotspot=true`; query có index (seek) → `IndexSeek` + `is_hotspot=false`.

**DoD:** scan↔seek phân biệt được trong `operation`; full scan MSSQL bị flag; test cũ không bị nới.

---

### EXP-P1.3 — Cassandra tracing badge (không phải "actual")
**Vì sao:** tracing gán `mode="actual"`, UI hiện "ACTUAL" y hệt EXPLAIN ANALYZE thật → hiểu nhầm Cassandra có planner.

**Backend (`drivers/plan.rs`)**
- `parse_cassandra_trace`: `mode = "tracing"` (thay `"actual"`). Giữ nguyên số liệu (không bịa cost/rows, `total_cost=None`).

**Frontend (`PlanVisualizer.svelte`)**
- Badge khi `mode === 'tracing'`: hiện `"TRACING · DIAGNOSTICS"` (màu khác actual) + dòng chú thích nhỏ: "Cassandra không có cost planner — đây là timeline thực thi, không phải cost plan."
- `demo.ts`: mock cassandra explain trả `mode:"tracing"`.

**Tests**
- Unit: `parse_cassandra_trace` → `mode=="tracing"`.
- e2e (nếu có cassandra demo): badge hiện "TRACING", không hiện "ACTUAL".
- Integration `cassandra_trace_mode_is_tracing` (nếu container có sẵn trong harness): ALLOW FILTERING → `mode="tracing"` + hotspot + warning.

**DoD:** DBA nhìn badge biết ngay là diagnostics; regression `explain_verification.rs` cassandra cập nhật kỳ vọng mode.

**→ Sau P1: đủ điều kiện DBA sign-off (2 High đóng).**

---

## P2 — ĐỘ ĐÚNG (Medium normalize)

### EXP-P2.1 — PG hotspot theo rows quét + nhân loops
**Backend (`drivers/plan.rs` `parse_pg_node` + `mark_hotspot`)**
1. `actual_rows = "Actual Rows" × "Actual Loops"` (đọc thêm `Actual Loops`, mặc định 1). Áp cả `actual_time_ms` self nếu tính về sau.
2. Đọc thêm `"Rows Removed by Filter"` vào `extra`.
3. `mark_hotspot` cho scan: đánh giá theo **rows quét** (`Actual Rows×Loops + Rows Removed by Filter`, hoặc estimated tương ứng) thay vì rows đầu ra. Seq Scan quét nhiều nhưng trả ít (selective full scan) → flag missing-index.

**Tests**
- Unit: fixture PG Nested Loop có `Actual Loops>1` → `actual_rows` nhân đúng; fixture Seq Scan Plan Rows=1 nhưng quét lớn → hotspot.
- Integration `pg_selective_seqscan_flagged`: bảng 50k, WHERE trả 1 dòng, không index → `SeqScan` `is_hotspot=true`; sau `CREATE INDEX` → không hotspot.

---

### EXP-P2.2 — ClickHouse granule ratio + gộp metadata
**Backend (`drivers/plan.rs` `parse_clickhouse`)**
1. Parse `"Granules: x/y"` và `"Parts: a/b"` theo node ReadFromMergeTree; lưu vào `extra`.
2. `uses_index` xét **per-node theo tỉ lệ**: đọc ≥ ~50% granule **hoặc** thấy `Condition: true` → coi là full read → `SeqScan` + `is_hotspot=true` + warning "reads x/y granules"; tỉ lệ thấp → không flag.
3. **Gộp metadata lines** (`Condition: …`, `Parts: …`, `Granules: …`, `PrimaryKey`, `Skip`, `MinMax`) vào `extra` của node đọc thay vì tạo node riêng → đóng DEF-CH-METADATA-NODES.

**Tests**
- Unit: fixture 6/6 → hotspot + warning; 1/6 → không; metadata không thành node riêng (cây chỉ có ReadFromMergeTree/Aggregating/Sorting…).
- Integration `clickhouse_fullread_vs_key`: `WHERE v=7` (6/6) → hotspot; `WHERE id=42` (1/6) → không.

---

### EXP-P2.3 — MySQL parser đủ nhánh
**Backend (`drivers/plan.rs` `parse_mysql_block`)**
- Mở rộng đệ quy các khối bỏ sót: `ordering_operation` (→ node `Sort`, warning filesort nếu input lớn), `grouping_operation` (→ `Aggregate`/`Materialize`, warning temp table), `materialized_from_subquery`, `attached_subqueries`, `union_result`. Giữ nhánh `nested_loop`/`table` hiện có.
- `attached_condition` → `extra["Filter"]`.

**Tests**
- Unit: fixture ORDER BY (filesort) → có node Sort + warning; fixture GROUP BY (temp) → node Aggregate/Materialize; fixture subquery → node con xuất hiện.
- Integration `mysql_plan_surfaces_filesort_and_temp`: query ORDER BY không index + GROUP BY → plan có Sort + warning.

---

## P3 — GIÁ TRỊ + PHỦ TEST

### EXP-P3.1 — Cost % (self-cost) kiểu SSMS
**Backend:** thêm `cost_self`/`cost_pct` vào `PlanNode` (Option). Tính self-cost = `estimated_cost(node) − Σ estimated_cost(children)` clamp 0 (PG/MSSQL cumulative); `cost_pct = self / root_total × 100`. MySQL dùng `read_cost+eval_cost`.
**Frontend:** `PlanNodeBox` hiện `Cost: N%` (khi có); giữ cost tuyệt đối trong tooltip.
**Tests:** unit tính self-cost + tổng %≈100; e2e hiển thị %.
**Checklist §0.5** (đổi shape → ipc/demo/render/unit).

### EXP-P3.2 — MSSQL Missing-Index banner
**Backend:** `build_mssql_node`/`parse_mssql_xml` trích `<MissingIndexes>` (Impact + EQUALITY/INEQUALITY/INCLUDE) → field mới `missing_index` trong `QueryPlan` hoặc `summary` (Impact% + DDL `CREATE NONCLUSTERED INDEX …`).
**Frontend:** banner xanh "Missing index (Impact ~N%)" + nút Copy DDL.
**Tests:** unit parse fixture XML có MissingIndexes; integration MSSQL query thiếu index → banner có DDL.
**Checklist §0.5.**

### EXP-P3.3 — Actual thật cho MySQL/MSSQL (stretch)
- MySQL ≥ 8.0.18: `build_explain` mysql+actual → `EXPLAIN ANALYZE` (TREE text); parser tree text → actual rows/time; capability `actual_kind=Analyze`.
- MSSQL: `SET STATISTICS XML ON` → actual plan; capability `actual_kind=Analyze`.
- **Tùy dung lượng** — nếu hoãn, capability vẫn giữ `None` và toggle disabled (đã honest từ P1.1).
**Tests:** integration actual rows captured; version check fallback.

### EXP-P3.4 — Phủ test còn thiếu (G2/G3/G4)
- **G2:** error-path EXPLAIN cho mysql/mariadb/mssql/sqlite/clickhouse/cassandra (syntax / missing table / non-explainable) — hiện chỉ PG có.
- **G3:** timeout + mid-query disconnect trên đường EXPLAIN (ít nhất 1 engine).
- **G4:** e2e `explain_plan` command + render (Playwright qua demo fixture): badge, hotspot đỏ, click node mở tooltip, tab raw.

---

## 2. TRÌNH TỰ & PHỤ THUỘC

```
P0.1 (safety, độc lập, làm ngay)
        │
P1.1 (capability) ──┬── P1.3 (tracing mode dùng capability)
        │           └── P3.3 (actual dùng capability)
P1.2 (op scan/seek) ── P2.1/P2.2 (hotspot dựa op mới)
P2.3 (mysql tree, độc lập)
P3.1/P3.2 (shape mới, sau khi op ổn định)
P3.4 (test, sau cùng)
```

- **Làm P0 trước tiên** (rủi ro dữ liệu).
- **P1.1 trước P1.3 và P3.3** (chúng đọc capability).
- **P1.2 trước P2.1/P2.2** (hotspot mới dựa trên bộ op đã tách scan/seek).
- P2.3, P3.1, P3.2 tương đối độc lập.

## 3. RỦI RO CẦN CANH
- **Đổi bộ op (P1.2)** làm lệch unit test cũ + kỳ vọng trong `explain_verification.rs` → cập nhật đồng bộ, **không** nới assertion, chạy lại harness.
- **Đổi shape `QueryPlan` (P1.1 mode, P3.1/P3.2 field)** → luôn theo checklist §0.5 (demo.ts là nơi dễ quên nhất → vỡ Playwright).
- **Transaction wrap (P0)** giả định 1-conn-per-profile (đúng theo T21). Nếu registry đổi sang pool đa-conn trong tương lai, BEGIN/ROLLBACK phải cùng connection — ghi chú lại.
- **MySQL EXPLAIN ANALYZE (P3.3)** trả TREE text (không JSON) → parser riêng, nhiều edge case; hoãn được nhờ capability honesty.

## 4. DEFINITION OF DONE (toàn workstream)
1. Actual + DML không bao giờ commit (P0).
2. scan≠seek trong `operation`; full scan MSSQL/CH/SQLite đều flag (P1.2, P2.2).
3. Cassandra hiển thị rõ là tracing/diagnostics (P1.3).
4. Toggle Actual chỉ bật cho engine hỗ trợ thật (P1.1).
5. Hotspot PG đúng (rows quét, nhân loops); CH granule-aware; MySQL tree đủ nhánh (P2).
6. (Nếu làm) cost% + missing-index banner (P3).
7. Mọi gate xanh gồm test cũ + `explain_verification.rs`; báo cáo kèm output nguyên văn.
8. Không sửa file ngoài §0.4 (trừ `lib.rs` đăng ký command mới — nêu rõ trong báo cáo).
