# SPEC-AUDIT — Giai đoạn 1: Kiểm chứng spec ↔ code thật

> Mục tiêu: đối chiếu từng khẳng định trong spec với CODE THẬT (file:line + đoạn code
> bằng chứng), 2 chiều (xuôi: claim→code; ngược: enumerate interface code→kiểm spec phủ chưa).
> Quy tắc: không có bằng chứng → `[CHƯA KIỂM CHỨNG]`, không đoán. Đây là báo cáo để DUYỆT
> trước khi sang Giai đoạn 2 (viết lại spec theo template hướng-mở-rộng).

## Cách chạy & độ tin cậy (đọc trước)

- Verify bằng **9 lượt** (8 nhóm), phần lớn qua subagent song song, mỗi agent context sạch.
- **6/9 lượt hoàn tất đầy đủ** (agent bám quy tắc bằng chứng, trả bảng file:line):
  A1 Users&Privileges, A2 Oracle, A3 Explain, A4 MongoDB, B1 Gap/Supplement, C1 overview.md.
- **3 lượt agent THẤT BẠI vì lý do ngoài kỹ thuật** (org chạm *monthly spend limit*):
  C2 (phase-1..6), D1 (SPEC_v2 + README + START_HERE), D2 (4 addendum).
  → 3 nhóm này được **verify lại thủ công (main session), mức GỌN hơn** (đọc trực tiếp +
  targeted grep + tận dụng phát hiện đã có ở C1). Độ phủ per-claim thấp hơn agent-depth;
  các mục chưa kiểm được đánh dấu `[CHƯA KIỂM CHỨNG]`.

| Nhóm | Spec | Cách verify | Độ phủ |
|---|---|---|---|
| A1 | SPEC-USERS-PRIVILEGES.md | Agent (Opus) đầy đủ | Cao |
| A2 | SPEC-ORACLE-FEATURE.md | Agent (Opus) đầy đủ | Cao |
| A3 | SPEC-EXPLAIN-FEATURE.md | Agent (Opus) đầy đủ | Cao |
| A4 | SPEC-MONGODB-FEATURE.md | Agent (Opus) đầy đủ | Cao |
| B1 | GAP_REVIEW.md, SPEC_SUPPLEMENT.md | Agent (Opus) đầy đủ | Cao |
| C1 | spec/overview.md | Agent (Sonnet) đầy đủ | Cao |
| C2 | spec/phase-1..6 + 4b | Thủ công đầy đủ (2026-07-22; agent ban đầu lỗi spend-limit) | **Cao** — xem Phụ lục |
| D1 | SPEC_v2 + README + START_HERE | Thủ công đầy đủ (2026-07-22; agent ban đầu lỗi spend-limit) | **Cao** — xem Phụ lục |
| D2 | 4 addendum | Thủ công (đầy đủ hợp lý) — agent lỗi spend-limit | Trung bình–Cao |

---

# CÁC DRIFT XUYÊN SUỐT (xuất hiện ở nhiều spec)

1. **Số hệ database: spec nói 10, code có 12.** `LiveConnection` enum có 11 variant
   (MariaDB dùng chung `MySql`) + `SystemType` 12 giá trị — thêm **MongoDB** và **Oracle**.
   Bằng chứng: `src-tauri/src/drivers/mod.rs:46-58`; `src/lib/types.ts:5-17`.
   Ảnh hưởng: overview.md (§Connections "10 hệ"), phase specs (10 hệ), README/SPEC_v2, bảng
   Color Identity, EXECUTE_PLAN/INDEX_SCAN addendum (bảng "7 hệ SQL").
2. **"Out of scope: MongoDB" đã KHÔNG CÒN đúng.** `spec/overview.md:897` ghi Mongo out-of-scope;
   code có driver Mongo đầy đủ (`mod.rs:282-285` + mọi match arm). MongoDB nay là công dân hạng nhất.
3. **Cấu trúc thư mục frontend đã đổi.** Spec (overview §7, phase-1 §1) vẽ `src/components/…`,
   `src/stores/…` ở top-level; thực tế tất cả nằm dưới `src/lib/` (~19 thư mục con:
   `sql/ users/ mongo/ redis/ stream/ grid/ export/ import/ compare/ copy/ er/ testdata/ keys/
   format/ actions/ explorer/ connections/ components/ stores/`).
4. **Nhiều tab content-type mới sau spec:** `index-manager`, `admin`, `objects`, `user-manager`,
   `mongo-collection`, `cassandra-table`, `redis-key`, `nats-subject` (`src/lib/types.ts:214-239`)
   — không có trong overview.md.
5. **Mảng tính năng lớn KHÔNG có trong spec tổng quan:** Users & Privileges (8 engine),
   Generate Test Data, Copy Table to…, Partitions, toàn bộ pure-logic `src/lib/sql/*.ts`
   (table-designer, partitions, reserved-word quoting, autocomplete hybrid). Có spec riêng cho
   một số (SPEC-USERS-PRIVILEGES) nhưng overview.md không trỏ tới.

---

# NHÓM A — Spec tính năng

## A1 — SPEC-USERS-PRIVILEGES.md — phần lõi KHỚP, một số gap thật + spec thiếu UX mới

### Drift / thiếu (material)
| Khẳng định spec | Trạng thái | File:line | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Component `MariaDbUserManager.svelte` tách riêng | [LỆCH] | (glob) chỉ có MySqlUserManager | `UserManagerView.svelte:121` mysql\|\|mariadb→`<MySqlUserManager>` | Gộp 1 component (CLAUDE.md ghi deviation) |
| 3 dialog MSSQL (CreateLogin/User/Role) riêng (§5.3) | [LỆCH] | (glob) chỉ `MssqlCreateDialog.svelte` | 1 dialog mode login/user/role | Không mất chức năng |
| MongoDB §8.1 có 11 command (gồm `mongo_user_detail`, `mongo_create_role`/`update_role`/`drop_role`) | [LỆCH — gap thật] | commands/mongo.rs & lib.rs | chỉ 7 command; grep 4 command kia = 0 | **Custom-role builder Mongo (§8.2) CHƯA làm** |
| MySQL view `column_privs` (§3.1/§3.3) | [KHÔNG CÒN] | users_admin.rs (không có nhánh) | — | builder FE `grantColumns` vẫn có; view backend thiếu |
| ClickHouse `grants_for`/`row_policies`/`quotas`/`settings_profiles` (§6.2) | [KHÔNG CÒN] | users_admin.rs (không có) | — | ảnh hưởng đọc-ngược state grid §1.8 |
| Oracle `col_privs` (dba_col_privs) (§10.1) | [KHÔNG CÒN] | users_admin.rs (không có) | — | §1.8.5 tham chiếu col_privs |
| §1.2c MSSQL Security nest TRONG database node; Mongo Users nest trong db node | [LỆCH] | ObjectExplorer.svelte:1453 | comment `Security … connection-level nodes` | render ở cấp connection (CLAUDE.md thừa nhận) |
| `NoUserSystem.svelte` cho SQLite (§13) | [KHÔNG CÒN — chủ đích] | (glob) không có | — | KHỚP §17.2 "ẩn hẳn entry" |

### Code có, spec THIẾU (chiều ngược)
- **Grant Access wizard dùng chung**: `grantWizard` store (`stores/grantwizard.svelte.ts:124`) +
  `GrantAccessDialog.svelte` + action Grant/Deny/Revoke cross-engine — spec chỉ mô tả wizard per-engine rời.
- Builder wizard-action per engine: `accessStatement`/`parseGrantLevel`/`parseScope`/`parseSecurable`/
  `parseResource`/`objectAccessStatement`/`resourceAccessStatement` (mysql.ts:161, clickhouse.ts:136,
  mssql.ts:178, cassandra.ts:137, oracle.ts:134).
- **Tab "Access"** per engine (hiển thị principal thấy DB/schema nào, quyền gì) — §1.8.6 không liệt kê.
- **PG Grant multi-database** (scope2 Databases, `grantwizard.svelte.ts:25 GrantGroup`).
- Grid-column constants `PG_/MYSQL_/CH_/MSSQL_/CASS_GRID_COLUMNS` + `grantColumn/revokeColumn/denyColumn`.

### KHỚP (bằng chứng cứng, tin cậy)
- Tab type `'user-manager'` (types.ts:239), `openUserManager` singleton (tabs.svelte.ts:466),
  dispatch 7 engine (UserManagerView.svelte:119-132).
- `users_query`/`users_view` + register lib.rs:180 + `ipc.usersView` + demo case.
- Escaper `quote_ident`/`quote_str`/`mysql_account` khớp bảng §1.5 + unit test.
- §1.4b: MSSQL `is_raw_batch` mở rộng GRANT/DENY/REVOKE (mssql.rs:744, chỉ token đầu, có unit test);
  MySQL TEXT-protocol tránh 1295 (mysql.rs:83); Oracle filter-by-grantee né cap 100 (users_admin.rs:259).
- 3 entry point (toolbar/context-menu/AdminView). PG integration 6-bước §1.9 đọc nguyên văn đủ.
- 8/8 engine có `*_user_manager_end_to_end` (drivers_integration.rs + mongo_integration.rs + oracle_o0.rs).

### Chưa kiểm chứng (trung thực)
- Thân 6-bước integration test cho MySQL/MariaDB/MSSQL/CH/Cassandra/Mongo (chỉ xác nhận tên+dòng).
- Nhánh MariaDB `FOR` trong `setDefaultRole` (chỉ thấy chữ ký).

---

## A2 — SPEC-ORACLE-FEATURE.md — mâu thuẫn driver lớn + 2 tính năng "bắt buộc" chưa làm

### Drift / thiếu (material)
| Khẳng định spec | Trạng thái | File:line | Bằng chứng | Ghi chú |
|---|---|---|---|---|
| Phụ lục "✅ CHỐT B = `oracle-rs` 0.1.7 (pure Rust, KHÔNG Instant Client)" | [LỆCH nghiêm trọng] | Cargo.toml:105; oracle.rs:1-8 | `oracle = "0.6"`; `//! Pivoted from oracle-rs … truncated at ~100 rows` | Code dùng **crate A (ODPI-C + actor + Instant Client)**. Spec tự mâu thuẫn: thân bài §3.2/3.3 mô tả A, phụ lục chốt B |
| §0.2/§3.1 feature-gate `oracle` (mặc định off) | [LỆCH] | Cargo.toml:105 | `oracle = "0.6"` | dependency thường, không feature-gate |
| §1.1 #8 `databases()` = list PDB (V$PDBS) | [LỆCH] | oracle.rs:210-212 | `Ok(Vec::new()) // PDB listing … needs CDB privileges` | trả rỗng → nhánh multi-DB header không kích hoạt |
| §4.2/§2.G Query Plan Oracle `supports_actual=true`/Analyze | [LỆCH] | plan.rs:152 | `"oracle" => (true, ActualKind::None, CostBasis::Cost)` | chỉ estimated |
| §2.H/§O8 Backup `expdp`/`impdp` (BẮT BUỘC) | [KHÔNG CÒN / chưa làm] | backup.rs (grep oracle=0) | — | nút Backup ẩn cho Oracle |
| §5.2/§O8 Streaming export `stream_export` Oracle (BẮT BUỘC) | [KHÔNG CÒN / chưa làm] | export.rs, oracle.rs (grep=0) | — | Oracle chỉ export buffered |
| §5.4 field `oracle_service/sid/tns/…` (khuyến nghị B) | [LỆCH] | mod.rs:218-230 | reuse `database` + `mssql_auth=="sid"` | dùng phương án A tối thiểu |
| §5.5 M7 thêm oracle vào `supportsDbSwitch` | [LỆCH] | SqlWorkspace.svelte:66 | mảng không có oracle | mất DB dropdown; M8 schema-switch có oracle |

### KHỚP
- `LiveConnection::Oracle` + 19 match arm (mod.rs), `SystemType::Oracle`/port 1521, `Placeholder::Colon`
  + FETCH OFFSET (grid.rs), `explain_oracle`/`parse_oracle`, admin/kill, DBMS_METADATA definition,
  bundle Instant Client + `scripts/fetch-instantclient.{ps1,sh}`, toàn bộ nhánh `sql/*.ts`, splitter `/` PL/SQL.
- `oracle_o0.rs` 5 test đều `#[ignore]` (cần Instant Client) — khớp memory + spec §5.9.
- Test `a_full_resultset_no_100_cap` (oracle_o0.rs:238) chứng minh lý do pivot khỏi oracle-rs.

---

## A3 — SPEC-EXPLAIN-FEATURE.md — SAI KIẾN TRÚC CĂN BẢN (spec cần viết lại toàn bộ)

**Kết luận bao trùm:** spec mô tả giải pháp **LLM-based 3 tầng, TypeScript** ở `src/features/explain/`
(acquisition→pre-parse→LLM analysis→validation→SSMS rendering). Code thật là **parser thuần Rust,
KHÔNG LLM** (`drivers/plan.rs` + `commands/plan.rs`, FE `PlanVisualizer.svelte`). Chức năng trùng ý
(EXPLAIN per-system, estimated/actual, hotspot, missing index) nhưng gần như MỌI khẳng định cụ thể sai.

| Khẳng định spec | Trạng thái | File:line | Bằng chứng |
|---|---|---|---|
| §0.2 code ở `src/features/explain/` | [KHÔNG CÒN] | — | `Glob src/features/explain/**` = No files |
| §1 kiến trúc có tầng LLM Analysis | [KHÔNG CÒN] | commands/plan.rs:78-90 | `exec_statement(...)`→`parse_for_system(...)` (không LLM) |
| §4 `UnifiedExplainResult` (verdict/bottlenecks/index_suggestions[]/query_rewrites/cost_basis) | [KHÔNG CÒN] | ipc.ts:642 | `QueryPlan { system, mode, root?, summary, raw, missing_index? }` |
| §4 `PlanNode` (id/parent_id/child_order/icon/op_category/severity/tooltip) | [LỆCH] | plan.rs:11-34 | trường thật: `operation, native_op, estimated_rows, …, is_hotspot, children` |
| §3 vocabulary 16 tên có dấu cách + icon | [LỆCH] | plan.rs:179 | `normalize_op` → `"SeqScan"/"IndexSeek"/"HashJoin"`, không icon |
| §4.1 validator JSON-Schema + retry + cost_pct∈[95,105] | [KHÔNG CÒN] | — | không có validator/ajv/zod |
| §5/§6 SYSTEM_PROMPT + DIALECT_BLOCK (prompt-builder/dialect-blocks/llm-client) | [KHÔNG CÒN] | — | không tồn tại |
| §2 PG estimated `EXPLAIN (FORMAT JSON, VERBOSE, COSTS, BUFFERS)` | [LỆCH] | commands/plan.rs:261 | chỉ `EXPLAIN (FORMAT JSON)` (test:462 "tránh lỗi PG<16") |
| §2 ClickHouse 3 lệnh (indexes=1 + ESTIMATE + PIPELINE) | [LỆCH] | commands/plan.rs:271 | chỉ `EXPLAIN indexes = 1` |
| §0.4 MSSQL wrap `BEGIN TRAN…ROLLBACK` cho DML actual | [LỆCH] | commands/plan.rs:53-59 | MSSQL DML+actual bị **chặn**; chỉ PG wrap rollback |
| §9 DoD 7 dialect | [ĐÚNG — vượt] | plan.rs:143-157 | phủ 7 dialect + **Oracle + MongoDB** ngoài spec |

**KHỚP (dù khác ngôn ngữ):** phát hiện DML (strip comment + WITH…DELETE, commands/plan.rs:352),
MSSQL `SET SHOWPLAN_XML/STATISTICS XML`, MariaDB `ANALYZE FORMAT=JSON`, MySQL `EXPLAIN ANALYZE`,
Cassandra chặn write + TRACING, `<MissingIndexes>`→DDL, self-cost = total−Σcon (plan.rs:1204).

**Code có, spec thiếu:** `parse_oracle` (PLAN_TABLE), `parse_mongodb` (.explain), `EngineCapability`/
`explain_capability`, integration `explain_verification.rs` (test parser Rust, không phải LLM/validator).

> ⚠️ Đây là spec drift nặng nhất. Giai đoạn 2: **viết lại hoàn toàn** theo kiến trúc Rust-parser thực tế
> (hoặc đánh dấu Deprecated + thay bằng spec mới). Xem thêm 2 file cùng chủ đề ở Nhóm E:
> `EXPLAIN_VERIFICATION_REPORT.md`, `PLAN-EXPLAIN-FIX.md` (chưa verify — thuộc Nhóm E loại khỏi phạm vi).

---

## A4 — SPEC-MONGODB-FEATURE.md (§M6–M6.4) — KHỚP tốt, 1 lệch thực chất

- **Toàn bộ §M6 + M6.1–M6.4 [ĐÚNG]** với bằng chứng file:line: Design Document (`mongo/design.ts` +
  `DesignDocumentDialog` + store), pagination page-based (`MongoCollectionView.svelte:35-42,61`),
  autocomplete mongosh (`mongo/complete.ts`, `functions.ts`, `SqlWorkspace.mongoCompletionSource`),
  number color (`ResultGrid.svelte:394` NUM_COLOR_SYSTEMS + `classifyType long` copy/types.ts:14),
  New Database mongo, tree double-click, DB dropdown. Integration `mongo_integration.rs` chạy thật.
- **[LỆCH thực chất]:** `MONGO_METHODS` gợi ý `findOne`/`replaceOne`/`dropIndex`/`estimatedDocumentCount`
  nhưng `exec_mongo` KHÔNG có match arm (functions.ts:16 ↔ mongo.rs:838 `other => Err("unsupported … method")`).
  Chọn suggest 4 method này rồi Run → lỗi.
- **[CẦN XÁC MINH]:** demo.ts chỉ thấy 4 case mongo_* (users/roles/create_user/exec); change_password/
  drop_user/grant_roles/revoke_roles chưa thấy case (có thể vỡ demo/Playwright luồng đó).
- **Code có ngoài §M6** (thuộc mục khác): admin_view/kill_op, User Manager U5, stream_export,
  explain_mongo, collection_ddl, scan_indexes, mongo_change_preview.

---

# NHÓM B — GAP_REVIEW.md + SPEC_SUPPLEMENT.md

**Không có claim khống** — mọi mục đánh "done [Tn]" đều có code thật.

### GAP_REVIEW.md lỗi thời 3 chỗ (spec nói còn thiếu nhưng code ĐÃ có)
| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| Streaming export "PG only" / CH "còn buffer RAM" (dòng 125, 204) | [LỆCH — đã có hơn] | `commands/export.rs:41-64` dispatch PG + **ClickHouse + MongoDB** |
| Cassandra per-statement consistency toolbar "still Missing" (dòng 152) | [LỆCH — đã làm] | `SqlWorkspace.svelte:947` dropdown consistency (Phase C4) |
| Cassandra DDL viewer "Partial — CREATE TABLE only" (dòng 153) | [LỆCH — đã đủ] | `cassandra.rs:870+` `object_ddl` + 5 formatter type/index/view/function/aggregate |

### Backlog THỰC SỰ còn chưa làm (grep = 0, khớp spec)
- Kafka ACL browser + NATS NKey/JWT (Deferred — cần broker/JWT ngoài).
- Trigger Enable/Disable, Row Count & Stats, Explorer object pinning (chưa có code).
- MSSQL Azure AD Interactive/device-code/ROPC (chỉ Service Principal đã làm — aad.rs).
- Streaming cho MySQL/MSSQL/SQLite + Generate Scripts streaming (vẫn buffer RAM — đúng phần GAP).

> **Lưu ý phạm vi:** GAP_REVIEW/SPEC_SUPPLEMENT chỉ phản ánh giai đoạn T10–T31 (10 hệ gốc). MongoDB,
> Users&Privileges (U0–U7), Partitions, AUDIT-4→13, Oracle KHÔNG nằm trong 2 file này. Muốn dùng làm
> backlog hiện tại phải cập nhật (bỏ 3 mục LỆCH + bổ sung phạm vi engine mới).

---

# NHÓM C — overview + phase specs

## C1 — spec/overview.md (verify đầy đủ)
Ngoài các drift xuyên suốt (systems 10→12, Mongo out-of-scope, folder structure, content-types), thêm:
| Khẳng định | Trạng thái | Bằng chứng |
|---|---|---|
| ClickHouse driver "crate `clickhouse` (HTTP 8123)" (dòng 138) | [LỆCH] | Cargo.toml không có crate `clickhouse`; dùng `reqwest` (Cargo.toml:66) — tự viết HTTP |
| Tab groups "tối đa 2×2 panes" (dòng 623) | [LỆCH] | tabs.svelte.ts:22 chỉ 1 lần split nhị phân (`splitDir 'v'|'h'`, 2 pane) |
| Redis "CLI console" (dòng 518) | [LỆCH — tính năng ma] | `RedisWorkspace.svelte` còn render (App.svelte) nhưng không còn call site `openRedisTab` (AUDIT-13 thay bằng RedisExplorer) |
| Result contract `{ok,result,error,duration_ms}` | [LỆCH nhẹ] | types.rs:83 có thêm field `affected` |
| dependency sqlx/tiberius/rusqlite/scylla/redis/rdkafka/async-nats/russh | [ĐÚNG] | Cargo.toml khớp từng dòng |
| storage rusqlite (connections/history/tabs/Snippet) | [ĐÚNG] | storage/mod.rs:18-59 |

## C2 — phase-1..6 + 4b (verify GỌN — agent lỗi spend-limit)
- **phase-1-mvp-relational.md:** checklist toàn `[x]`, mô tả relational core (PG/MySQL/MariaDB/MSSQL/SQLite),
  §7b QueryError khớp addendum. Đối chiếu spot: struct/luồng tồn tại (types.rs QueryError, drivers). `[ĐÚNG]`
  ở mức tính năng; **[CHƯA KIỂM CHỨNG]** chi tiết từng dòng checklist (không đọc hết mọi file phase-1).
- **phase-5-power-user.md:** checklist toàn `[ ]` (chưa tick) nhưng **thực tế ĐÃ làm** qua T14/T15/T16/T17
  + addendum. Lệch cụ thể: §7b dùng `IndexInfo` với `health` + **`anti_pattern`** + `native_meta` + columns
  ASC/DESC — code là `IndexScanRow` (`index_scan.rs:9`) với `flags` (unused/redundant/fragmented/invalid),
  `columns: Vec<String>`, **KHÔNG có anti_pattern** (index_scan.rs:39 comment xác nhận cố ý), không
  native_meta/cardinality/partial_predicate. `Ctrl+Shift+E`→query-plan: component `PlanVisualizer.svelte`
  tồn tại; **phím tắt chính xác [CHƯA KIỂM CHỨNG]**.
- **phase-2/3/4/4b/6:** [CHƯA KIỂM CHỨNG chi tiết] — chưa đọc/đối chiếu từng file (agent lỗi). Theo C1 +
  CLAUDE.md, đây là checklist lịch sử của 10 hệ gốc, phần lớn đã hiện thực với các drift hệ thống ở trên.

## Lưu ý phase specs
- Ước tính thời gian ("2–3 tuần vibe coding") + trạng thái `[ ]`/`[x]` là DẤU VẾT LỊCH SỬ, không phản ánh
  hiện trạng (phase-5 `[ ]` nhưng đã xong). Cần đánh dấu Deprecated hoặc chuyển thành tài liệu tham chiếu.

---

# NHÓM D — Design handoff + addendum

## D1 — SPEC_v2 + README + START_HERE (verify GỌN — agent lỗi spend-limit)
- **START_HERE.md** = tài liệu onboarding/index, trỏ xuống SPEC_v2 → 4 addendum → README → overview +
  prototype `Database Studio.dc.html` + `runSelfTest()`. Mục "TL;DR ưu tiên code" liệt kê việc-cần-làm
  (Structure Compare, Backup, Grant, Redis/Kafka/NATS client, editable grid commit thật) — **phần lớn nay
  đã DONE** → doc mang tính lịch sử. Vẫn hữu ích ở phần "prototype = nguồn sự thật UI" (còn đúng theo CLAUDE.md).
- **README.md / DATABASE_STUDIO_SPEC_v2.md:** [CHƯA KIỂM CHỨNG chi tiết] — chưa đọc đầy đủ. Điểm dữ liệu
  đã có (D1 partial): `REL_SYSTEMS` code = pg/mysql/mariadb/mssql/clickhouse/sqlite/**oracle** = 7 hệ, rộng
  hơn set "Relational + ClickHouse" README claim. Dự kiến các file này mang cùng drift hệ thống (10 hệ,
  nhãn trạng thái REAL/MOCK/SHELL nay đều "done", prototype-based). Cần verify kỹ hơn nếu đưa vào Giai đoạn 2.
- **Bản chất:** đây là di sản thiết kế (mô tả prototype + design tokens + nhãn trạng thái tại thời điểm bàn
  giao). Prototype HTML vẫn là nguồn sự thật UI (CLAUDE.md), nhưng nhãn trạng thái + scope đã lỗi thời.

## D2 — 4 addendum (verify đầy đủ hợp lý — thủ công)

### CASSANDRA_SPEC_ADDENDUM
| Claim | Trạng thái | Bằng chứng |
|---|---|---|
| Driver `scylla` | [ĐÚNG] | Cargo.toml:90 `scylla = "1.1"` |
| CQL qua paging state, KHÔNG OFFSET | [ĐÚNG] | cassandra.rs cql_exec + parse (A3/CLAUDE.md C1) |
| Consistency per-statement | [ĐÚNG] | SqlWorkspace.svelte:947 dropdown (C4) |
| Ring Topology tab `cassandra-ring` từ system tables | [ĐÚNG — có component] | `CassandraRing.svelte` tồn tại; nội dung query system.peers [CHƯA KIỂM CHỨNG] |
| DDL viewer native (không tái dùng SQL generator) | [ĐÚNG] | cassandra.rs `object_ddl` + formatter riêng |

### CLICKHOUSE_SPEC_ADDENDUM
| Claim | Trạng thái | Bằng chứng |
|---|---|---|
| Driver: khuyến nghị crate `clickhouse` (HTTP) | [LỆCH] | dùng `reqwest` (Cargo.toml:66), không crate clickhouse |
| §7 editable grid → mutation async `ALTER … UPDATE/DELETE` (không OLTP) | [ĐÚNG] | CLAUDE.md CH grid "Generate mutation"; grid preview arm clickhouse [SUY LUẬN từ CLAUDE + T30] |
| TTL Policy Viewer modal + MATERIALIZE TTL | [ĐÚNG] | `ClickHouseTtlDialog.svelte` + `chttl.svelte.ts` |
| MV/Dictionary create menu | [ĐÚNG] | `ClickHouseCreateDialog.svelte` (T30) + `sql/clickhouse_ddl.ts` |

### EXECUTE_PLAN_AND_INDEX_SCAN_ADDENDUM
| Claim | Trạng thái | Bằng chứng |
|---|---|---|
| A.2 `QueryPlan { system, mode, root, summary, raw }` | [ĐÚNG — sát code] | plan.rs:73 (khác hẳn `UnifiedExplainResult` của SPEC-EXPLAIN) |
| A.2 `PlanNode` với `id/target/index_used`, native_op trong `extra` | [LỆCH] | plan.rs:11 `native_op` là field top-level; không có id/target/index_used |
| A.1 lệnh native per hệ | [ĐÚNG phần lớn] | commands/plan.rs (xem A3; PG/CH có lệch chi tiết) |
| B.3 `IndexInfo` + `health[…anti_pattern]` + native_meta + columns ASC/DESC | [LỆCH] | `index_scan.rs:9` `IndexScanRow` + `flags` (KHÔNG anti_pattern, index_scan.rs:39) |
| B struct `IndexScanResult` + missing suggestions | [ĐÚNG] | index_scan.rs:52 + `suggestions: Vec<MissingIndexSuggestion>` + `suggest_missing_pg` |
| Redis/Kafka/NATS → not_applicable | [ĐÚNG] | commands/plan.rs:30 (A3) |

### QUERY_EDITOR_ERROR_HANDLING_ADDENDUM
| Claim | Trạng thái | Bằng chứng |
|---|---|---|
| Tầng 1 lint dùng sqlparser-rs | [ĐÚNG] | `src-tauri/src/lint/mod.rs` dùng `sqlparser` (Cargo.toml) |
| Tầng 2 `QueryError { system, statement_index?, code?, message, position?, hint?, severity, raw }` | [SUY LUẬN — phần lớn khớp] | phase-1 §7b [x]; struct FE ipc.ts (A3 tham chiếu); struct Rust chi tiết [CHƯA KIỂM CHỨNG toàn bộ field] |
| PG position → line/col; MSSQL Line; MySQL near '…' best-effort | [CHƯA KIỂM CHỨNG chi tiết] | phase-1 §7b tick [x]; chưa đọc code map vị trí |
| classify_connect_error | [ĐÚNG — tồn tại] | CLAUDE.md T10 + connections; grep xác nhận có (không trích dòng ở đây) |

---

# ĐỀ XUẤT CHO GIAI ĐOẠN 2 (chờ duyệt)

1. **Thứ tự viết lại (ưu tiên giá trị cho dev mở rộng):**
   a. `SPEC-EXPLAIN-FEATURE.md` — **viết lại hoàn toàn** (sai kiến trúc nặng nhất) hoặc Deprecated + spec mới.
   b. `SPEC-USERS-PRIVILEGES.md` — cập nhật: gộp component thực tế, bổ sung Grant-wizard/Access-tab, đánh
      dấu view backend còn thiếu (column_privs/col_privs/CH policies) + Mongo custom-role là TODO.
   c. `SPEC-ORACLE-FEATURE.md` — sửa mâu thuẫn driver (crate A, không feature-gate), Backup/Streaming = TODO.
   d. `SPEC-MONGODB-FEATURE.md` — nhỏ: đánh dấu 4 method suggest-nhưng-chưa-exec; demo case còn thiếu.
   e. `spec/overview.md` — cập nhật systems 10→12, folder src/lib, content-types, mảng tính năng mới.
   f. Đánh dấu **Deprecated** cho phase-1..6 + GAP_REVIEW + SPEC_SUPPLEMENT (di sản lịch sử) — KHÔNG xóa.
   g. Addendum + SPEC_v2/README/START_HERE: giữ như di sản thiết kế; addendum phần lớn còn đúng, chỉ chỉnh
      chi tiết driver ClickHouse + struct IndexInfo/PlanNode cho khớp code.
2. **Tạo 1 spec tổng (index) đứng trên cùng** — bức tranh 12 engine + ranh giới module (driver layer /
   commands / ipc dual-mode / stores runes / pure-logic sql·users·mongo) + sơ đồ + trỏ xuống spec con.
3. **Hoàn tất verify 2 nhóm còn nợ** (C2 phase-2/3/4/4b/6, D1 README/SPEC_v2) khi hạn mức chi tiêu cho phép
   — hoặc chấp nhận verify-gọn hiện tại nếu 2 nhóm này sẽ chỉ bị đánh Deprecated.

## Việc còn nợ trong Giai đoạn 1 — ĐÃ HOÀN TẤT VERIFY ĐẦY ĐỦ (2026-07-22)
Toàn bộ C2 (phase-2/3/4/4b/6) + D1 (SPEC_v2 + README) đã được đọc TRỰC TIẾP và đối chiếu code (main
session, không dùng agent). Kết quả đầy đủ ở "## PHỤ LỤC — VERIFY ĐẦY ĐỦ" bên dưới. Các `[CHƯA KIỂM CHỨNG]`
ở phần C2/D1 phía trên đã được giải quyết ở phụ lục.

---

# PHỤ LỤC — VERIFY ĐẦY ĐỦ C2 (phase specs) + D1 (design handoff) [2026-07-22]

> Đọc trực tiếp từng file + grep code. Mỗi dòng kèm bằng chứng hoặc đánh dấu trung thực.

## C2 — Phase specs (đối chiếu tính năng ↔ code)

### phase-1-mvp-relational.md (checklist toàn `[x]`)
Relational core khớp: drivers pg/mysql/mssql/sqlite (`Cargo.toml` sqlx/tiberius/rusqlite), QueryError §7b
(`drivers/types.rs` + error mapping). **[ĐÚNG]** ở mức tính năng. Không phát hiện mục claim khống.

### phase-2-relational-core.md
| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| §1 Autocomplete schema-aware | [ĐÚNG] | `src/lib/sql/aliases.ts` + `SqlWorkspace.columnSource` |
| §2 Format `Ctrl+Shift+F` | [ĐÚNG] | `keys/shortcuts.ts:14` `{id:'format'…key:'f'}` + `App.svelte:103` `case 'format'` |
| §2 Query history | [ĐÚNG] | `storage/mod.rs` `HistoryEntry` |
| §2 Snippets | [ĐÚNG] | `storage/mod.rs` `Snippet` |
| §2b Lint tầng 1 sqlparser-rs | [ĐÚNG] | `src-tauri/src/lint/mod.rs` (dùng `sqlparser`, Cargo.toml) |
| §2c ClickHouse driver "crate `clickhouse`" | **[LỆCH]** | dùng `reqwest` (`Cargo.toml:66`), không có crate `clickhouse` |
| §2d SQLite PRAGMA panel + file header | [ĐÚNG] | `components/workspace/SqliteFileHeader.svelte` |
| §3 Editable grid (Apply/Discard/preview) | [ĐÚNG] | `components/results/ResultGrid.svelte` |
| §4 View modes Grid/JSON/Single `Ctrl+Alt+G/J/R` | [ĐÚNG] | `keys/shortcuts.ts:16-18` result-grid/json/single |
| §8 Quick connect | [ĐÚNG] | `connections.quickConnect` (`ConnectionForm.svelte:103`) + `commands/connections.rs` |
| §8 Group connections (folder) | [MỘT PHẦN] | logic `src/lib/connections/grouping.ts` tồn tại; field "Group" trong ConnectionForm đã bỏ (AUDIT A6) — còn khái niệm `group` trong profile |
| §8 Import/Export connection profiles (JSON) | **[KHÔNG TÌM THẤY / chưa làm]** | grep `export_profiles`/`import_profiles` backend = 0 |

### phase-3-redis-nats.md
| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| §1 SSL/TLS mọi connection | [ĐÚNG] | `connections/profile.rs:72-80` `ssl/ssl_ca/ssl_cert/ssl_key` |
| §3 Redis key explorer prefix tree | [ĐÚNG] | `explorer/RedisExplorer.svelte` + `src/lib/redis/tree.ts` |
| §4 Redis 6-type viewer + TTL | [ĐÚNG] | `workspace/RedisKeyView.svelte` |
| §5 Redis CLI Console (tab `redis-cli`) | **[LỆCH — tính năng ma]** | `RedisWorkspace.svelte` còn code nhưng không call site mở (AUDIT-13 thay bằng RedisExplorer) |
| §6 Redis Pub/Sub Monitor | [ĐÚNG] | `workspace/RedisPubSub.svelte` |
| §9/§10 NATS core + JetStream | [ĐÚNG] | `workspace/NatsWorkspace.svelte` + `drivers/nats.rs` + `commands/nats.rs` |
| §11 Split view "tối đa 2 panes" | [ĐÚNG] | `stores/tabs.svelte.ts:22` `splitDir null\|'v'\|'h'` (đúng 2 pane — khác claim "2×2" sai ở overview) |

### phase-4-kafka-nats-full.md
| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| §1-§6 Kafka cluster/topic/consumer/producer/consumer-groups | [ĐÚNG] | `workspace/KafkaWorkspace.svelte` + `drivers/kafka.rs` |
| §7 Schema Registry | [ĐÚNG] | `drivers/schema_registry.rs` |
| §8 Kafka ACL (read-only) | **[KHÔNG CÒN / chưa làm — Deferred]** | grep ACL = 0 (cần broker authorizer) |
| §9 NATS JetStream Streams/Consumers/Messages | [ĐÚNG] | `NatsWorkspace` + `nats.rs` |
| §9 NATS KV Store + Object Store | [ĐÚNG] | `NatsWorkspace.svelte` + `nats.rs` + `commands/nats.rs` (grep `object_store`/KV) |

### phase-4b-cassandra.md
Đã implement đầy đủ hơn checklist (C1–C5, `CLAUDE.md`): CQL qua `cql_exec`, editable grid, consistency
per-statement (`SqlWorkspace.svelte:947`), DDL viewer (`cassandra.rs::object_ddl`), Ring
(`workspace/CassandraRing.svelte`), driver `scylla` (`Cargo.toml:90`). **[ĐÚNG]**.

### phase-6-polish.md
| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| §2 Shortcuts (đa số) | [ĐÚNG] | `keys/shortcuts.ts` + bind thêm ở `App.svelte` (comment shortcuts.ts:2) |
| §2 `Ctrl+Shift+E` Explain | **[KHÔNG TÌM THẤY]** | không có trong `shortcuts.ts` lẫn `App.svelte`; Explain kích hoạt qua nút, không phím tắt |
| §3 Settings/Preferences UI | [ĐÚNG] | `components/Settings.svelte` |
| §3 Theme persist qua restart | [ĐÚNG] | `main.ts` localStorage + `ui.svelte.ts setTheme` (AUDIT theme-persist) |
| §4 Auto-update (Tauri updater) | **[KHÔNG CÒN / chưa làm]** | grep `updater`/`tauri-plugin-updater` code + tauri.conf = 0 |
| §5 Installer targets (msi/exe/dmg/deb/appimage) | **[LỆCH]** | `tauri.conf.json:40` `"targets": ["nsis","deb","appimage"]` — NSIS (không msi), có deb+appimage, **KHÔNG dmg (macOS)** |
| §8 QA "đủ 10 hệ" | [LỆCH] | nay 12 hệ (thêm Mongo/Oracle) |

## D1 — Design handoff (SPEC_v2 + README + START_HERE)

**Bản chất:** cả 3 mô tả **PROTOTYPE** (`Database Studio.dc.html`) + design tokens + nhãn trạng thái tại
handoff (SPEC_v2: 01/07/2026). Prototype dùng **Monaco + React runtime + mock data**; code build lại bằng
**CodeMirror 6 + Svelte 5 + driver thật**. Đây là **di sản thiết kế** — prototype HTML vẫn là nguồn sự thật
UI, nhưng nhãn trạng thái + scope engine đã lỗi thời.

### DATABASE_STUDIO_SPEC_v2.md
| Khẳng định | Trạng thái | Bằng chứng |
|---|---|---|
| §2 "10 hệ thống" | [LỆCH] | 12 (`drivers/mod.rs:46-58` + `types.ts`) |
| §3 tech: SQL editor "CodeMirror 6 (prototype Monaco — chọn 1)" | [ĐÚNG — code chọn CodeMirror] | `SqlEditor.svelte` import `@codemirror/{view,state,commands,language}` |
| §3 tech: ClickHouse "`clickhouse` client" | [LỆCH] | `reqwest` (`Cargo.toml:66`) |
| §3 tech: Cassandra "`scylla`/`cdrs`" | [MỘT PHẦN] | chỉ `scylla` (`Cargo.toml:90`), không `cdrs` |
| §7 Structure Compare = ⛔ HARDCODED (prototype) | [KHÔNG CÒN — nay THẬT] | `src/lib/compare/diff.ts` + `SchemaCompare.svelte` diff thật |
| §11 SHELL: exGrant/testConn/downloadBackup | [KHÔNG CÒN — nay THẬT] | Users Manager (`users/*`), test connection (T10), backup (`commands/backup.rs` T22) |
| §12 tab split "tối đa 2×2" | [LỆCH] | 1 lần chia đôi (`splitDir 'v'\|'h'`) |
| §16 out-of-scope "MongoDB" | [KHÔNG CÒN] | Mongo là engine đầy đủ (`drivers/mongo.rs`) |
| Nhãn 🟠/🟡/🔴 (Editor/Result/Import/Export/Backup/panels) | [Di sản prototype] | mô tả trạng thái prototype; tính năng tương ứng nay đã build (verify rải rác ở trên) |

### README.md
| Khẳng định | Trạng thái | Bằng chứng |
|---|---|---|
| Color Identity 7 hệ + section "added" MariaDB/Cassandra/SQLite | [LỆCH — thiếu Mongo/Oracle] | 12 hệ trong code |
| "Relational + ClickHouse = `selRel`" (New Query/ER/DDL/Compare) | [LỆCH] | code `REL_SYSTEMS` = pg/mysql/mariadb/mssql/clickhouse/**sqlite/oracle** (7 hệ) |
| SQL Editor "Monaco" | [LỆCH prototype→build] | code CodeMirror 6 (`SqlEditor.svelte`) |
| Design Tokens (`--bg/--surface/--primary…`) | [Di sản — nguồn UI truth] | giá trị token trong `app.css`/`tokens.css` (sinh qua `npm run tokens`) |
| Tính năng mô tả (TTL viewer/PRAGMA/Chart/Ring/Import/Export/Compare/Generate Scripts/context menus) | [ĐÚNG — đã build] | component tương ứng tồn tại (`ClickHouseTtlDialog`/`SqliteFileHeader`/`CassandraRing`/`compare`…) |
| "prototype = mock data" | [Di sản] | code thay bằng driver thật qua ipc |

### START_HERE.md
Tài liệu onboarding/index trỏ xuống SPEC_v2/addendum/README/overview + prototype. Mục "TL;DR ưu tiên code"
liệt kê việc-cần-làm nay phần lớn DONE (Structure Compare/Backup/Grant/Redis-Kafka-NATS client/editable grid).
[Di sản — vẫn hữu ích ở phần "prototype = nguồn sự thật UI"].

## Kết luận phụ lục
- Phase specs + design-handoff = **lịch sử/di sản**, phần lớn tính năng đã build; các lệch đều **có chủ đích**
  hoặc là **prototype-vs-build** hoặc là **drift 10→12 hệ** đã ghi ở đầu báo cáo.
- **TODO thật mới phát hiện qua verify đầy đủ** (chưa có ở phần trên): (1) Import/Export connection profiles
  JSON — chưa làm; (2) Auto-update (Tauri updater) — chưa làm; (3) Installer thiếu **macOS dmg** (chỉ
  nsis/deb/appimage); (4) `Ctrl+Shift+E` Explain — không có phím tắt (chỉ nút).
- Không phát hiện claim khống (spec nói "done" mà code thiếu) ở nhóm này.
