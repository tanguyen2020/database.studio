# SPEC — Thêm Oracle Database làm engine mới (feature parity đầy đủ)

> Trạng thái: DRAFT để review. Branch đề xuất: `feat/oracle-engine`.
> Mục tiêu: Oracle Database (RDBMS quan hệ, enterprise) đạt **đầy đủ** mọi tính năng mà các engine quan hệ hiện có (PostgreSQL/MySQL/MariaDB/MSSQL/SQLite/ClickHouse) đang có, không sót.
> **RÀNG BUỘC BẮT BUỘC: chỉ THÊM cho Oracle, TUYỆT ĐỐI không đổi hành vi/không phá tính năng của 11 engine sẵn có** — mọi thay đổi phải additive (xem section **ADDITIVE** cuối spec: 3 loại thay đổi + cách sửa code-dùng-chung không gây regression + guard test). Suite test của engine cũ phải xanh KHÔNG ĐỔI.
> Quy tắc (giống SPEC-MONGODB-FEATURE.md): chỉ ghi nhận tính năng THỰC SỰ tồn tại trong code (kèm `file:line`); không đề xuất tính năng mới ngoài phạm vi parity; chỗ chưa chắc đánh dấu **[CẦN XÁC MINH]**.
> Nguồn: khảo sát read-only toàn bộ codebase (backend driver/commands/registry, frontend systems/dialect/components) — mọi `file:line` lấy trực tiếp từ working tree branch `feat/function-suggest-and-theme`.

---

## 0. Tóm tắt điều hành + quyết định kiến trúc

### 0.1 Oracle KHÁC MongoDB: đi theo khuôn RELATIONAL (PG/MSSQL), KHÔNG theo khuôn non-SQL Cassandra

MongoDB (SPEC-MONGODB-FEATURE.md) là document DB → đi theo khuôn Cassandra (editor riêng, introspection quan hệ trả rỗng, tab viewer riêng). **Oracle thì ngược lại**: là RDBMS quan hệ chuẩn SQL, có schema/table/column/index/constraint/FK/view/sequence/procedure/function/trigger/package/partition — **map 1:1 với PostgreSQL/MSSQL**. Do đó Oracle:

- Dùng **đường exec chung** (`exec_statement` → `results.run` nhánh `else`, `results.svelte.ts:222`) — KHÔNG cần command `oracle_exec` riêng.
- Dùng **workspace chung** `SqlWorkspace` (App.svelte default branch, `App.svelte:266`) — KHÔNG cần `TabContentType` mới, KHÔNG đụng `App.svelte`.
- Dùng **cây Explorer quan hệ chung** (nhánh `{:else}` relational, `ObjectExplorer.svelte:1546`) — KHÔNG cần `OracleExplorer.svelte`.
- Dùng **store `results`/`explorer` chung** không đổi (đã system-agnostic).
- Được **toàn bộ tính năng power-user quan hệ**: Table Designer, Partitions, Index/FK Manager, Schema Compare, ER Diagram, Admin (Sessions/Locks/Users), Generate Scripts, Export/Import, Copy Table, Generate Test Data, Proc/Func Execute+Rename, autocomplete hàm, reserved-word quoting, Query Plan.

→ **Precedent chính để bắt chước = MSSQL** (`drivers/mssql.rs`): enterprise, phân trang `OFFSET…FETCH`, định tuyến DDL/PL qua raw-batch (không prepared), sequences bổ sung, admin V$/DMV. Oracle gần MSSQL nhất trong 6 engine quan hệ.

### 0.2 RỦI RO KIẾN TRÚC LỚN NHẤT — driver Rust (đọc trước khi chốt làm)

**Đây là điểm khác biệt căn bản so với mọi engine hiện có và là rủi ro chính của cả feature.** Mọi engine quan hệ hiện tại dùng driver **thuần Rust, async, rustls**: PG/MySQL/MariaDB qua `sqlx` (`Cargo.toml`), MSSQL qua `tiberius`, SQLite qua `rusqlite`. **KHÔNG driver nào trong số này hỗ trợ Oracle**. Có ĐÚNG HAI lựa chọn khả dĩ (đã research crates.io, xem §3.1 chi tiết + nguồn):

**Lựa chọn A — `oracle` crate (Kubo Takehiro), bọc ODPI-C/OCI** — chín, an toàn, nhưng nặng:
- Version **0.6.3** (phát hành **2025-01-02**), **~2.14 triệu downloads** → de-facto standard, ổn định.
- **Đồng bộ/blocking** (README xác nhận KHÔNG async; chỉ trỏ `sibyl` là bản async thay thế) → phải ghép qua **actor thread riêng + channel** (§3.2). Nặng: mọi method driver repo là `async`, registry giữ `Arc<Mutex<LiveConnection>>`, cancel qua `AbortHandle` (`registry.rs:209-249`).
- **Cần Oracle Instant Client (Basic) ở runtime** (link động OCI; yêu cầu Oracle client 11.2+). Build cần **C compiler** (đã có MSVC cho `rdkafka`/`rusqlite`). → Ảnh hưởng đóng gói desktop (Windows/macOS universal). Xem §3.3.

**Lựa chọn B — `oracle-rs` crate (stiang), THUẦN RUST, KHÔNG cần Instant Client** — hợp kiến trúc repo nhưng non-trẻ:
- Version **0.1.7** (phát hành **2026-03-24**, đang active), **~5.8k downloads**, ~20 GitHub stars, ~30 commits → **pre-1.0, chưa production-ready**.
- **Thuần Rust, async trên Tokio, KHÔNG OCI/ODPI-C/Instant Client** — implement TNS protocol trong Rust. → **Xoá bỏ CẢ HAI rủi ro lớn nhất của lựa chọn A**: (1) không cần actor thread (đã async, cắm thẳng như sqlx/tiberius); (2) không cần Instant Client (đóng gói tĩnh, đồng nhất chính sách rustls toàn repo).
- Hỗ trợ: PL/SQL (anonymous block, OUT param, REF CURSOR), bind, LOB (CLOB/BLOB streaming), DATE/TIMESTAMP[/WITH TZ]/INTERVAL, NUMBER (nhiều mapping Rust), transaction/savepoint, statement cache, JSON/VECTOR (23ai), `row.get(name|index)` (dynamic column). Cần Oracle **12c R1+**.
- **Gap đã biết**: LONG/LONG RAW, XMLType, Advanced Queuing, sharding **chưa implement**. Rủi ro: crate non-trẻ, ít download → có thể gặp bug type-decoding/edge case ở DB thật (bài học AUDIT-11: phải integration test container thật, KHÔNG tin demo).

**→ [QUYẾT ĐỊNH #1 cần user chốt]:** A (chín, nặng packaging) vs B (nhẹ, hợp kiến trúc, non-trẻ). **Khuyến nghị: thử B trước ở bước O0** (nếu B kết nối được Oracle thật + decode type đúng qua integration test, ta được engine async thuần Rust không cần Instant Client — thắng lớn); **fallback sang A** nếu B lộ bug chặn ở DB thật. Cả hai đều xài chung phần còn lại của spec (introspection/dialect/frontend không đổi theo lựa chọn driver). Toàn bộ §3 mô tả cả hai; các đoạn nói "actor thread" và "Instant Client" CHỈ áp dụng cho A.

### 0.3 Các quyết định cần user CHỐT trước khi triển khai

1. **Chọn crate driver** (§0.2, §3.1): **A = `oracle` 0.6.3** (chín, blocking, cần Instant Client) vs **B = `oracle-rs` 0.1.7** (thuần Rust async, không Instant Client, non-trẻ). **Khuyến nghị: thử B ở O0, fallback A.**
2. **Nếu chọn A**: chiến lược blocking→async (§3.2) = actor thread/connection (khuyến nghị); + đóng gói Instant Client (§3.3): yêu cầu user cài + set PATH + phát hiện runtime, ẩn nếu thiếu (giống `backup_tool_status`, `commands/backup.rs`). **Nếu chọn B**: cả hai vấn đề này BIẾN MẤT (cắm thẳng như sqlx, đóng gói tĩnh).
3. **Trường ConnectionProfile cho Oracle** (§5.4): (A) tái dùng field sẵn có — `database` = service name, `mssql_auth` = connect-kind (`service`/`sid`/`tns`) theo precedent Kafka reuse `mssql_auth` (`mod.rs:163-167`); (B) thêm field mới `oracle_service`/`oracle_sid`/`oracle_tns`/`oracle_role`. **Khuyến nghị (B)** cho rõ ràng (giống cặp `cassandra_dc`/`cassandra_consistency`).
4. **Định danh & case-folding** (§4.3): Oracle fold tên KHÔNG-quote thành UPPERCASE; introspection trả tên UPPERCASE. Chốt: introspection lưu tên đúng case Oracle (UPPERCASE cho tên thường), quoting `"X"` chỉ khi cần. Ảnh hưởng toàn bộ generator SQL (§5.6).
5. **Phạm vi partition** (§2.F): Oracle có partitioning phong phú (RANGE/LIST/HASH/INTERVAL). Chốt làm đầy đủ hay chỉ View. **Khuyến nghị làm đầy đủ** (đạt parity với PG/MySQL/MSSQL đã có).
6. **Backup** (§2.H): **BẮT BUỘC** (để không thiếu tính năng) qua Data Pump `expdp`/`impdp`. Lưu ý bản chất: Data Pump chạy **server-side** (dump vào `DIRECTORY` object trên host DB, không phải file client) — khác mô hình file-client `pg_dump`/`mysqldump`; UI phải nói rõ "dump nằm trên máy chủ Oracle" + cho chọn DIRECTORY. **[QUYẾT ĐỊNH nhỏ]**: chấp nhận ràng buộc server-side này (khuyến nghị), hay ưu tiên client-side qua `sqlplus SPOOL`/SQLcl (hạn chế hơn).

---

## BƯỚC 1 — Lớp trừu tượng (abstraction layer)

Codebase KHÔNG dùng `trait DatabaseDriver`; "interface" = tập match arms trong `impl LiveConnection` (`drivers/mod.rs:227-637`). Thêm Oracle = thêm biến thể `LiveConnection::Oracle(OracleDriver)` + 1 nhánh vào **từng** match arm + struct `OracleDriver` + `oracle_params()` builder.

### 1.1 Backend Rust — `impl LiveConnection` (19 match arm)

| # | Method | Signature (rút gọn) | Vị trí match | Oracle làm gì |
|---|---|---|---|---|
| 1 | `connect` | `async fn connect(profile, endpoint, password) -> Result<Self, QueryError>` | `mod.rs:234-266` | `Self::Oracle(OracleDriver::connect(&oracle_params(...)).await?)` |
| 2 | `test` | `async fn test(profile, endpoint, password) -> TestResult` | `mod.rs:281-300` | `OracleDriver::test(...)` (ping + `SELECT banner FROM v$version WHERE ROWNUM=1`) |
| 3 | `exec` | `fn exec<'a>(&'a mut self, sql) -> BoxFuture<Result<StatementOutcome>>` | `mod.rs:318-333` | `Box::pin(d.exec(sql))` — routing §3.4 (PL/SQL block, strip `;`, no multi-stmt) |
| 4 | `ping` | `async fn ping(&mut self) -> bool` | `mod.rs:336-348` | `d.ping().await` (`SELECT 1 FROM dual`) |
| 5 | `exec_params` | `async fn exec_params(&mut self, sql, params) -> Result<StatementOutcome>` | `mod.rs:353-384` | `d.exec_params(sql, params).await` — bind `:1,:2` (§3.4). **CÓ** implement (filter builder/pagination), KHÁC Cassandra/CH trả Err |
| 6 | `apply_grid_changes` | `async fn apply_grid_changes(&mut self, changes) -> Result<u64>` | `mod.rs:388-411` | `d.apply_changes(changes).await` (transaction, COMMIT/ROLLBACK; Oracle không `BEGIN`) |
| 7 | `schemas` | `async fn schemas(&mut self) -> Result<Vec<SchemaInfo>>` | `mod.rs:415-430` | `d.schemas().await` — `ALL_USERS`/`DBA_USERS`; default = `SYS_CONTEXT('USERENV','CURRENT_SCHEMA')`; lọc SYS/SYSTEM/XDB/… |
| 8 | `databases` | `async fn databases(&mut self) -> Result<Vec<DatabaseInfo>>` | `mod.rs:435-442` | `d.databases().await` — CDB/PDB: `V$PDBS`/`CDB_PDBS`, current qua `SYS_CONTEXT('USERENV','CON_NAME')`; non-CDB trả 1 từ `V$DATABASE` |
| 9 | `tables` | `async fn tables(&mut self, schema) -> Result<Vec<TableInfo>>` | `mod.rs:444-458` | `d.tables(schema).await` — `ALL_TABLES`+`ALL_VIEWS`; rows `NUM_ROWS`; size `DBA_SEGMENTS.bytes` (best-effort) |
| 10 | `columns` | `async fn columns(&mut self, schema, table) -> Result<Vec<ColumnInfo>>` | `mod.rs:460-473` | `d.columns(...).await` — `ALL_TAB_COLUMNS` + PK/FK từ `ALL_CONS_COLUMNS`/`ALL_CONSTRAINTS`; identity `ALL_TAB_IDENTITY_COLS` (12c+) |
| 11 | `indexes` | `async fn indexes(&mut self, schema, table) -> Result<Vec<IndexInfo>>` | `mod.rs:475-488` | `d.indexes(...).await` — `ALL_INDEXES`+`ALL_IND_COLUMNS` (fold multi-col), primary qua `ALL_CONSTRAINTS.CONSTRAINT_TYPE='P'` |
| 12 | `constraints` | `async fn constraints(&mut self, schema, table) -> Result<Vec<ConstraintInfo>>` | `mod.rs:490-504` | `d.constraints(...).await` — `ALL_CONSTRAINTS` (P/R/U/C → PK/FK/UNIQUE/CHECK; `SEARCH_CONDITION` cho CHECK) |
| 13 | `routines` | `async fn routines(&mut self, schema) -> Result<Vec<RoutineInfo>>` | `mod.rs:506-519` | `d.routines(...).await` — `ALL_PROCEDURES`/`ALL_OBJECTS` (PROCEDURE/FUNCTION/PACKAGE); params `ALL_ARGUMENTS` |
| 14 | `functions` | `async fn functions(&mut self, schema) -> Result<Vec<FunctionInfo>>` | `mod.rs:525-538` | `d.functions(...).await` — `ALL_OBJECTS type='FUNCTION'` (user funcs); built-in Oracle cấp tĩnh ở frontend (giống MSSQL) |
| 15 | `triggers` | `async fn triggers(&mut self, schema) -> Result<Vec<TriggerInfo>>` | `mod.rs:540-553` | `d.triggers(...).await` — `ALL_TRIGGERS` (`TRIGGERING_EVENT`, `TRIGGER_TYPE` BEFORE/AFTER/INSTEAD OF) |
| 16 | `sequences` | `async fn sequences(&mut self, schema) -> Result<Vec<SequenceInfo>>` | `mod.rs:555-561` | `d.sequences(...).await` — `ALL_SEQUENCES`. **IMPLEMENT** (Oracle có sequence thật; MSSQL Phase-1 skip nên rơi `_`) |
| 17 | `foreign_keys` | `async fn foreign_keys(&mut self, schema) -> Result<Vec<ForeignKey>>` | `mod.rs:564-572` | `d.foreign_keys(...).await` — `ALL_CONSTRAINTS` type `R` self-join qua `R_CONSTRAINT_NAME` + `ALL_CONS_COLUMNS` |
| 18 | `partitions` | `async fn partitions(&mut self, schema, table) -> Result<Vec<PartitionInfo>>` | `mod.rs:576-594` | `d.partitions(...).await` — `ALL_PART_TABLES`+`ALL_PART_KEY_COLUMNS`+`ALL_TAB_PARTITIONS` (method/key/HIGH_VALUE/NUM_ROWS/position) |
| 19 | `scan_indexes` | `async fn scan_indexes(&mut self, schema) -> Result<IndexScanResult>` | `mod.rs:597-636` | `("oracle", d.scan_indexes(schema).await?, Vec::new())` — usage `V$OBJECT_USAGE`; valid `ALL_INDEXES.STATUS`; `missing_indexes` = `Vec::new()` v1 |

Thêm biến thể enum `LiveConnection::Oracle(OracleDriver)` (`mod.rs:44-55`) + hàm builder `fn oracle_params(p, ep, password) -> OracleConnParams` (mẫu `mssql_params` `mod.rs:85-96`, và mẫu `cassandra_params` `mod.rs:185-213` cho việc dựng connect-string phi-tầm-thường từ `endpoint`+profile). **Lưu ý `databases()` và `sequences()`**: hiện chỉ vài engine có arm thật (PG/MSSQL/Mongo cho databases; PG cho sequences) — Oracle có cả hai nên **cả hai đều phải là arm thật, không rơi `_`**.

Struct driver theo khuôn `MssqlDriver` (`mssql.rs:31…`): giữ handle connection (qua actor/spawn_blocking §3.2) + database/schema mặc định, mọi method trả `StatementOutcome`/`QueryResultSet` khóa (`types.rs:59-64,67-76`).

### 1.2 `SystemType` + profile (bắt buộc, thiếu không build được)

| File | Sửa | Vị trí |
|---|---|---|
| `drivers/types.rs` | Thêm biến thể `Oracle` vào enum `SystemType` + `as_str()` → `"oracle"` | `types.rs:10-22`, `:24-39` |
| `drivers/types.rs` | `is_phase1_sql()` — **KHÔNG có call site nào** (đã grep toàn repo: chỉ có định nghĩa `types.rs:42`, 0 nơi gọi) → dead code, thêm Oracle hay không **không ảnh hưởng chức năng**. Thêm cho đúng ngữ nghĩa (Oracle là SQL) là vô hại | `types.rs:42-51` |
| `connections/profile.rs` | `default_port(Oracle) => 1521` | `profile.rs:101-114` |
| `connections/profile.rs` | Field mới cho Oracle (§5.4) nếu chọn hướng (B) | `profile.rs:51-98` |

### 1.3 Frontend contract — `types.ts` + `systems`

- `src/lib/types.ts`: `SystemType` += `'oracle'` (`types.ts:5-16`). **KHÔNG** thêm `TabContentType` (Oracle dùng content types quan hệ sẵn có).
- `src/lib/systems.ts`: `EXTRA.oracle = { category:'RELATIONAL', defaultPort:1521, quote:'double', available:true }` (`systems.ts:41-52`); thêm `'oracle'` vào `SYSTEM_ORDER` (`systems.ts:77-89`). `CATEGORY_ORDER` không đổi (RELATIONAL đã có).
- Tokens/visual identity: qua pipeline `npm run tokens` (§5.5 #1-3), KHÔNG hand-edit `systems.gen.ts`.
- Hợp đồng exec khóa cứng `{ ok, result?: { cols:[[name,type]], rows, total }, error?, duration_ms }` (`types.rs:59`, `types.ts:101-107`) — Oracle tái dùng nguyên.

### 1.4 Danh sách engine hiện có + file implement

| SystemType | Driver struct | File | Driver crate |
|---|---|---|---|
| postgres | `PgDriver` | `drivers/postgres.rs` | sqlx (async, rustls) |
| mysql/mariadb | `MySqlDriver` | `drivers/mysql.rs` | sqlx |
| mssql | `MssqlDriver` | `drivers/mssql.rs` | tiberius (async, rustls) |
| sqlite | `SqliteDriver` | `drivers/sqlite.rs` | rusqlite (blocking, bundled) |
| clickhouse | `ChDriver` | `drivers/clickhouse.rs` | reqwest HTTP |
| cassandra | `CassandraDriver` | `drivers/cassandra.rs` | scylla |
| redis/kafka/nats/mongodb | … | … | … |
| **oracle (mới)** | `OracleDriver` | `drivers/oracle.rs` *(tạo mới)* | **`oracle` crate (blocking, OCI/ODPI-C, cần Instant Client)** ⚠ |

Đăng ký command: mọi command mới (nếu có, xem §5.3 — Oracle hầu như KHÔNG cần command mới) thêm dòng vào `invoke_handler![...]` (`lib.rs:35-182`).

### 1.5 Bảng phủ TOÀN BỘ command (`lib.rs:37-181`) — phân loại chính xác từng cái

Đã đọc trọn `invoke_handler!`. Ký hiệu: **[G]** = generic, tự chạy cho Oracle qua dispatch `LiveConnection` (chỉ cần arm §1.1, KHÔNG sửa command); **[M]** = có `match system`/whitelist → **PHẢI thêm arm Oracle**; **[N/A]** = command của engine phi-quan-hệ, không liên quan Oracle.

| lib.rs line | Command | Loại | Oracle cần gì |
|---|---|---|---|
| 37-40 | `list_connections`/`save_connection`/`delete_connection`/`duplicate_connection` | [G] | — (storage) |
| 41-44 | `connect`/`disconnect`/`reconnect`/`quick_connect` | [G] | arm `connect`/`test` §1.1 |
| 45 | `open_database` | [M] | whitelist `postgres\|mssql` (`connections.rs:201`). Oracle: thêm nếu làm PDB-switch; v1 **để nguyên** (browse schema qua list_schemas) |
| 46-48 | `attach_database`/`open_tab_connection`/`close_tab_connection` | [G] | — (engine-agnostic) |
| 49-50 | `export_query_to_file`/`cancel_export` | [M] | `export.rs:41` chỉ PG/CH/Mongo. **Thêm arm `LiveConnection::Oracle` (streaming)** — bắt buộc để không thiếu tính năng (§5.2). Không thêm → chỉ mất streaming, export-buffered vẫn chạy |
| 51-53 | `test_connection`/`cancel_test`/`ping_connection` | [G] | arm `test`/`ping` §1.1 |
| 55-56 | `exec_statement`/`cancel_query` | [G] | arm `exec` §1.1; cancel qua registry (server-side cancel §3.4) |
| 58-70 | `redis_*` (13) | [N/A] | — |
| 72-104 | `nats_*` (33) | [N/A] | — |
| 106-120 | `kafka_*` (15) | [N/A] | — |
| 122-128 | `cassandra_*`/`cql_exec` (7) | [N/A] | — |
| 130 | `mongo_exec` | [N/A] | — |
| 132-133 | `ch_table_meta`/`ch_dictionaries` | [N/A] | — (ClickHouse-only) |
| 135 | `explain_plan` | [M] | `explain_oracle` (§4.2) |
| 136 | `explain_capability` | [M] | `capability("oracle")` (§4.2) + demo case |
| 138-150 | `list_schemas`/`list_databases`/`list_tables`/`list_columns`/`list_indexes`/`list_constraints`/`list_partitions`/`list_routines`/`list_functions`/`list_triggers`/`list_sequences`/`list_foreign_keys`/`scan_indexes` (13) | [G] | arm introspection §1.1 (qua macro `introspect!` `schema.rs:11-16`) |
| 151 | `object_definition` | [M] | `definition_query` arm Oracle (`DBMS_METADATA.GET_DDL`, `schema.rs:166-208`) |
| 152 | `index_definition` | [M] | `index_definition_query` arm Oracle (`schema.rs:214-275`) |
| 153-155 | `backup_tool_status`/`backup_database`/`restore_database` | [M] | `backup_tool`/`external_backup_cmd` arm Oracle (`expdp`/`impdp`, §2.H). Không thêm → nút Backup ẩn (như MSSQL) |
| 156 | `admin_view` | [M] | `admin_query("oracle",…)` V$SESSION/V$LOCK/DBA_USERS (§4.4) |
| 157 | `kill_session` | [M] | `kill_query("oracle",…)` `sid,serial#` (§4.4) |
| 159-160 | `write_text_file`/`write_file_base64` | [G] | — (dùng bởi Save/Export/Chart PNG-SVG; agnostic) |
| 162 | `lint_sql` | [M-nhẹ] | `dialect_of` (`lint/mod.rs:47`) rơi `_`→`GenericDialect` (sqlparser 0.53 KHÔNG có OracleDialect) — **chạy được, advisory, không crash**; danger rules chung áp dụng. Tuỳ chọn: thêm rule pack `oracle` (LIMIT→FETCH FIRST) `lint/mod.rs:238` |
| 164-166 | `sqlite_*` (3) | [N/A] | — (SQLite-only) |
| 168-171 | `list_history`/`list_snippets`/`save_snippet`/`delete_snippet` | [G] | — (storage; query history + snippets tự chạy) |
| 173 | `preview_grid_changes` | [M] | `grid::preview_sql` render literal — default DoubleQuote chạy, chú ý case §4.3 (`drivers/grid.rs:178`) |
| 174 | `apply_grid_changes` | [G] | arm `apply_grid_changes` §1.1 + `Placeholder::Colon` (`grid.rs:22`) |
| 175 | `exec_filtered` | [M] | `grid::build_select` arm Oracle (OFFSET/FETCH, `grid.rs:299-360`) |
| 176 | `ch_generate_mutations` | [N/A] | — (ClickHouse-only) |
| 178-181 | `save_tabs`/`load_tabs`/`get_app_state`/`set_app_state` | [G] | — (tabs/app state agnostic) |

**Tổng kết**: trong 108 command, **[N/A] 69** (redis/nats/kafka/cassandra/mongo/clickhouse/sqlite), **[G] ~26** (tự chạy khi có arm §1.1), **[M] 13** cần sửa arm Oracle: `open_database`(tuỳ), `export_query_to_file`, `explain_plan`, `explain_capability`, `object_definition`, `index_definition`, `backup_tool_status`/`backup_database`/`restore_database`, `admin_view`, `kill_session`, `preview_grid_changes`, `exec_filtered` (+ `lint_sql` nhẹ). **KHÔNG command mới nào cần tạo** (khác Mongo/Cassandra vốn cần `mongo_exec`/`cql_exec`).

---

## BƯỚC 2 — Ma trận tính năng (Oracle đạt parity quan hệ đầy đủ)

Ký hiệu: **✓** áp dụng được; **✗** không có; **N/A** khái niệm không tồn tại; **≈** có nhưng khác (ghi rõ). Ô có `file:line` là điểm gate/impl thật cần đụng.

### A. Connection

| Tính năng | PG/MySQL/MSSQL | **Oracle** | Gate/impl |
|---|---|---|---|
| Host + port | ✓ | ✓ (host:port + service/SID) | `ConnectionForm.svelte`; `mod.rs` params builder |
| Connect identity | database | ≈ **service name / SID / TNS** (khác: Oracle bind service, không phải database) | §4.1, §5.4 |
| Auth user/password | ✓ | ✓ (+ optional role SYSDBA/NORMAL) | `profile.rs:62-63` |
| SSL/TLS | ✓ (PG mTLS, MSSQL CA) | ≈ (TCPS/wallet qua `ssl`+`ssl_ca`) **[CẦN XÁC MINH]** OCI wallet path | `profile.rs:72-80` |
| SSH tunnel | ✓ | ✓ (qua registry `endpoint`, dựng DSN từ endpoint như Cassandra) | `registry.rs:79-139`; `mod.rs:185-213` |
| Pooling | ≈ 1-conn/profile (Mutex) | ≈ 1-conn/profile (actor thread §3.2) | `registry.rs:17-32` |
| Timeout | ✓ (`connect_timeout`=10s bounded) | ✓ (OCI connect timeout) **[CẦN XÁC MINH]** cơ chế bound blocking | `commands/connections.rs` T10 |
| Test + cancel | ✓ | ✓ (test = ping + version; cancel qua actor drop) | `mod.rs:281-300` |
| Nhiều database/server | ✓ (PG/MSSQL `databases()`) | ≈ **PDB** (CDB→list PDB); non-CDB = 1 | `mod.rs:435-442` |

### B. Schema/Catalog browsing (Object Explorer) — parity với PG/MSSQL

| Tính năng | PG/MSSQL | **Oracle** | Impl |
|---|---|---|---|
| List schemas | ✓ | ✓ (`ALL_USERS`; schema ≡ user) | `mod.rs:415`; `schema.rs` list_schemas |
| List databases/PDB | ✓ | ✓ (PDB) | `mod.rs:435` |
| List tables/views | ✓ | ✓ (`ALL_TABLES`/`ALL_VIEWS`) | `mod.rs:444` |
| Columns | ✓ | ✓ (`ALL_TAB_COLUMNS`) | `mod.rs:460` |
| Indexes | ✓ | ✓ (`ALL_INDEXES`) | `mod.rs:475` |
| Constraints (PK/FK/UNIQUE/CHECK) | ✓ | ✓ (`ALL_CONSTRAINTS`) | `mod.rs:490` |
| Procedures/Functions/Packages | ✓ | ✓ (`ALL_PROCEDURES`; packages là cấp mới) | `mod.rs:506,525` |
| Triggers | ✓ | ✓ (`ALL_TRIGGERS`) | `mod.rs:540` |
| Sequences | ✓ (PG) | ✓ (`ALL_SEQUENCES`) — **folder Sequences** | `mod.rs:555`; ObjectExplorer `isPg`-style (§5.5) |
| Foreign keys (ER) | ✓ | ✓ (`ALL_CONSTRAINTS` type R) | `mod.rs:564` |
| Partitions | ✓ | ✓ (`ALL_TAB_PARTITIONS`) | `mod.rs:576` |
| Row count + size | ✓ | ✓ (`NUM_ROWS`/`DBA_SEGMENTS`) | `TableInfo` `types.rs:159-176` |
| Show Definition/DDL | ✓ (`object_definition`) | ✓ (`DBMS_METADATA.GET_DDL`) | `commands/schema.rs:166-208,214-275` |
| Refresh (rule chung) | ✓ | ✓ (nhánh relational của `refreshConnection`) | `ObjectExplorer.svelte:466-478` |

### C. Query execution

| Tính năng | PG/MSSQL | **Oracle** | Impl |
|---|---|---|---|
| Chạy query | ✓ (`exec_statement`) | ✓ (đường chung) | `commands/query.rs`; `results.svelte.ts:222` |
| Nhiều statement | ✓ (split client-side) | ≈ split client-side + **`/` terminator PL/SQL** (§5.6 statements.ts) | `sql/statements.ts` |
| Cancel query | ✓ (abort+poison+heal) | ≈ (OCI `break`/drop actor; heal reconnect) **[CẦN XÁC MINH]** | `registry.rs:195-249` |
| Prepared/parametrized | ✓ (`exec_params`) | ✓ (bind `:1`) | `mod.rs:353`; `grid.rs` Placeholder mới |
| Paging kết quả | ✓ (LIMIT/OFFSET / MSSQL FETCH) | ✓ (`OFFSET…FETCH` 12c+ / `ROWNUM` 11g) | `grid.rs:299-360` (§5.6) |
| Transaction | ≈ (UI đã gỡ nút BEGIN/COMMIT — AUDIT-2 #6) | ≈ (giống — không có nút) | — |
| Warnings | ✓ (lint) | ✓ | `results.svelte.ts` |

### D. Result handling (grid) — độc lập system, tái dùng

| Tính năng | Mọi engine | **Oracle** | Impl |
|---|---|---|---|
| Grid cột động, paging, group-by, chart, No. gutter, keyboard, multi-select, copy đa định dạng | ✓ | ✓ (tái dùng nguyên) | `ResultGrid.svelte` |
| Number-type color + canh phải | ✓ (relational) | ✓ — **thêm `'oracle'`** | `ResultGrid.svelte:394` `NUM_COLOR_SYSTEMS` |
| NULL badge, JSON cell popup | ✓ | ✓ | `ResultGrid.svelte` |
| BLOB/binary | ≈ | ≈ (RAW/BLOB → hex `0x…` như MSSQL) | driver decode §4.4 |

### E. CRUD trực tiếp trên grid

| Tính năng | PG/MSSQL | **Oracle** | Impl |
|---|---|---|---|
| Insert/Update/Delete by PK (transaction) | ✓ | ✓ (`apply_changes`, bind `:1`) | `mod.rs:388`; `grid.rs` |
| Inline edit (Execute/Reset/Cancel) | ✓ | ✓ (tái dùng) | `ResultGrid.svelte` |
| Preview diff trước apply | ✓ (`preview_grid_changes`) | ✓ (literal render qua `preview_sql`) | `commands/grid.rs:12`; `drivers/grid.rs:178` |

### F. DDL (create/alter/drop) — Table Designer + Partitions + Index/FK Manager

| Tính năng | PG/MSSQL | **Oracle** | Impl |
|---|---|---|---|
| Create table (Table Designer, 6 tab Fields/Indexes/FK/Uniques/Checks/Triggers) | ✓ | ✓ — cần `designerTypes`/`buildTableDdl`/`alterColumn`/`buildTrigger` Oracle | `TableDesigner.svelte`; `sql/table-designer.ts` (§5.6) |
| Alter table (ADD/MODIFY/rename column) | ✓ | ✓ — Oracle `ADD (col …)`/`MODIFY (col …)`, `RENAME COLUMN` | `sql/table-designer.ts:157-218` |
| Drop table | ✓ | ✓ (`DROP TABLE` [CASCADE CONSTRAINTS]; **KHÔNG `IF EXISTS`** <23c) | `sql/ddl.ts:168` |
| Create/Drop index | ✓ (Index Manager) | ✓ (`DROP INDEX name` không `IF EXISTS`) | `IndexManager.svelte`; `sql/indexes.ts:31` |
| Add/Drop FK | ✓ | ✓ (`ADD CONSTRAINT … FOREIGN KEY`; **KHÔNG `ON UPDATE`**) | `sql/indexes.ts`; `sql/table-designer.ts:135` |
| Create view/proc/func/trigger/sequence | ✓ | ✓ (`CREATE OR REPLACE …` + `/`; sequence CÓ) | `sql/create-templates.ts` (§5.6) |
| Alter object (re-runnable) | ✓ | ✓ (`CREATE OR REPLACE`; table→comment) | `sql/alter.ts` (§5.6) |
| Partition (View + Create + Manage + Convert + Add) | ✓ | ✓ (RANGE/LIST/HASH/INTERVAL) | `sql/partitions.ts` (§5.6) |
| Truncate | ✓ | ✓ (`TRUNCATE TABLE schema.table` — default path đúng) | `sql/truncate.ts` (không cần sửa) |
| Rename table | ✓ | ✓ (`ALTER TABLE … RENAME TO new` — new unqualified) | `sql/ddl.ts:83` |
| Create/Drop/Rename database | ✓ | ≈ **schema ≡ user** → `CREATE USER`/comment (không `CREATE DATABASE`) | `sql/ddl.ts:102-162` (§5.6) |

### G. Query Plan (EXPLAIN)

| | PG/MySQL/MSSQL | SQLite/CH | Cassandra | **Oracle** |
|---|---|---|---|---|
| has_planner | ✓ | ✓ | ✗ | ✓ |
| supports_actual | ✓ (Analyze) | ✗ | ✓ (Tracing) | ✓ (`GATHER_PLAN_STATISTICS`→`DISPLAY_CURSOR ALLSTATS LAST`) |
| mode | estimated/actual | estimated | tracing | **estimated/actual** |
| Lệnh | EXPLAIN [ANALYZE] | EXPLAIN QUERY PLAN | TRACING | **`EXPLAIN PLAN FOR …`** (2 bước: plan rồi `SELECT … TABLE(DBMS_XPLAN.DISPLAY)`) |
| cost_basis | Cost | RowsProxy | — | **Cost** (Oracle CBO có cost cumulative ở dòng 0) |
| Impl | `plan.rs:235,294,771` | | `:920` | **`explain_oracle` (commands/plan.rs) + `parse_oracle` (drivers/plan.rs)** §4.2 |

### H. Import/Export/Backup

| Tính năng | PG/MSSQL | **Oracle** | Impl |
|---|---|---|---|
| Import CSV/JSON (wizard) | ✓ | ✓ (on-conflict = **MERGE** hoặc PL/SQL) | `ImportDialog`; `import/plan.ts:13-19` `conflictSupported` |
| Export CSV/JSON/SQL/Excel/XML (wizard) | ✓ | ✓ | `ExportDialog`; `export/query.ts:24-31` `supportsOffset` (Oracle OFFSET/FETCH) |
| Streaming export (bounded RAM) | ✓ (PG/CH) | ✓ **BẮT BUỘC** — `stream_export` + arm `export.rs:41` | `commands/export.rs:16-75` |
| Generate Scripts whole schema | ✓ | ✓ (topo sort; `/` terminator cho PL/SQL) | `GenerateScriptsDialog`; `sql/scripts.ts` |
| Backup/Restore | ✓ (pg_dump/mysqldump) / MSSQL không có | ✓ **BẮT BUỘC** — `expdp`/`impdp` (server-side `DIRECTORY` object; khác mô hình file-client, cần rõ trong UI) | `drivers/backup.rs` (§2.H note) |
| Copy Table cross-conn | ✓ | ✓ — thêm `'oracle'` vào `REL` | `CopyTableDialog.svelte:16` |
| Generate Test Data | ✓ | ✓ (`buildInsert`/`generateRows`; bool→`1/0`) | `GenerateTestDataDialog`; `testdata/generate.ts` |

### I. Metadata / admin / capability

| Tính năng | PG/MSSQL | **Oracle** | Impl |
|---|---|---|---|
| Engine version | ✓ | ✓ (`v$version`) | `test()` |
| Capability detection (EXPLAIN) | ✓ | ✓ (`capability("oracle")`) | `drivers/plan.rs:141`; demo `explain_capability` |
| Admin: Sessions | ✓ (`pg_stat_activity`/`sys.dm_exec_sessions`) | ✓ (`V$SESSION` join `V$SQL`) | `commands/admin.rs:34-127`; `AdminView.svelte:16-53` |
| Admin: Locks | ✓ (PG) | ✓ (`V$LOCK`/`V$LOCKED_OBJECT`/`DBA_BLOCKERS`) | `admin.rs` |
| Admin: Users | ✓ | ✓ (`DBA_USERS`) | `admin.rs` |
| Kill session | ✓ (pg_terminate/KILL) | ≈ **`ALTER SYSTEM KILL SESSION 'sid,serial#'`** (cần sid+serial#, KHÁC pid đơn) | `admin.rs:130-138,200-233` (§4.4) |
| Index Scanner (health) | ✓ | ✓ (`V$OBJECT_USAGE`; valid `STATUS`; unusable) | `mod.rs:597`; `IndexScanner.svelte` |

### J. Error handling / editor

| Tính năng | Mọi engine | **Oracle** | Impl |
|---|---|---|---|
| Error chuẩn hóa (`QueryError{system,message,hint,code,raw}`) | ✓ | ✓ (map `ORA-NNNNN`; hint cho ORA-00942/00001/02291…) | `error.rs`; driver §4.4 |
| Toast + View raw | ✓ | ✓ (tái dùng) | `results.svelte.ts` |
| SQL lint (parse-only sqlparser) | ✓ | ✓ (ĐÃ kiểm: `dialect_of` `lint/mod.rs:47-54` rơi `_`→`GenericDialect`; sqlparser 0.53 KHÔNG có OracleDialect → dùng generic, advisory, không crash; danger rules chung áp dụng) | `commands/lint.rs`, `lint/mod.rs` |
| Autocomplete (keyword+column+function+reserved quoting) | ✓ | ✓ — cần catalog hàm Oracle + reserved list | `sql/functions*.ts`, `sql/reserved.ts` (§5.6) |
| Format SQL | ✓ | ✓ — `sql-formatter` dialect `'plsql'` | `sql/format.ts:4-21` (§5.6) |
| Shortcuts / history / snippets | ✓ | ✓ (tái dùng) | `keys/shortcuts.ts`; `commands/library.rs` |

---

## BƯỚC 2bis — Checklist ĐẦY ĐỦ mọi tính năng (đối chiếu lịch sử task CLAUDE.md)

Bảng này đối chiếu **từng task đã hoàn tất** trong CLAUDE.md (T10–T31 + AUDIT-1..13 + PARTITIONS + FUNCTIONS + Objects tab) để đảm bảo **KHÔNG sót tính năng nào**. Disposition: **Auto** = frontend/generic system-agnostic, Oracle nhận tự động; **Sửa** = cần đụng file (trỏ §); **N/A** = tính năng engine-specific của hệ khác, không áp dụng Oracle.

| Task | Tính năng | Oracle disposition |
|---|---|---|
| T10 | Connection Test/Cancel (bounded timeout, classify error) | **Auto** (arm `test`/`cancel_test`; classify_connect_error thêm nhánh ORA-* tuỳ chọn) |
| T11 | Cancel running query (abort+poison+heal) | **Auto** ở tầng task; **Sửa** nếu muốn cancel server-side (OCI `break` — driver A §3.2; driver B có API cancel [CẦN XÁC MINH]) |
| T12 | Set-as-Filter, Convert, Split pane, ResultChart PNG/SVG export | **Auto** (frontend) |
| T13 | Import wizard (CSV/JSON, encoding, on-conflict batched) | **Sửa** `import/plan.ts` `conflictSupported`+conflict SQL Oracle (MERGE) — M18 |
| T14 | Export wizard (column subset, WHERE, paged stream table-mode) | **Sửa** `export/query.ts` `supportsOffset`+`buildExportSelect` Oracle (OFFSET/FETCH) — M17 |
| T15 | Generate Scripts whole schema (topo order, CREATE→FK→INSERT) | **Sửa** `sql/ddl.ts`(genCreate/genForeignKey), `sql/scripts.ts` (agnostic nhưng cần `/` terminator PL/SQL upstream) — §5.6 |
| T16 | Query Plan per-system | **Sửa** `explain_oracle`+`parse_oracle`+`capability` — §4.2 |
| T17 | Index Scanner (unused/redundant/fragmented/invalid + missing-index) | **Sửa** `scan_indexes` arm (`V$OBJECT_USAGE`/STATUS); missing_indexes v1=`[]` (như MySQL/SQLite) — §1.1 #19 |
| T18 | Explorer depth (Show Definition, Drop, column expand, tree filter, Properties panel) | **Sửa** `object_definition` (`DBMS_METADATA`); tree filter/Properties **Auto** — §5.2 |
| T19 | Schema Compare depth (routines/triggers, line-diff DDL) | **Sửa** M12 + `SchemaCompare` loadDbs; snapshot generic **Auto** |
| T20 | ER create-relationship + Save-to-DB + save layout | **Sửa** `genForeignKey('oracle')`; ER canvas/save-layout **Auto** |
| T21 | Pooling/timeout, autocomplete, shortcuts (Ctrl+Shift+F format…) | pool/shortcuts **Auto**; autocomplete **Sửa** `functions`/`reserved` §5.6 |
| T22 | Backup & Restore | **Sửa** `backup.rs` `expdp`/`impdp` (server-side directory) — §2.H, BẮT BUỘC để không thiếu |
| T23 | Admin views (Sessions/Locks/Users[/Extensions]) + Kill session | **Sửa** `admin_query`/`kill_query` + `AdminView` — §4.4, M14 |
| T24 | Streaming I/O export (bounded RAM, Channel progress, cancel) | **Sửa** `stream_export` + arm `export.rs:41` — §5.2, BẮT BUỘC |
| T25 | Copy Table to… (cross-connection, type-map, paged copy) | **Sửa** `CopyTableDialog` `REL` (M15) + **`copy/types.ts` `mapColumnType`/`classifyType` case Oracle** |
| T26 | Generate Test Data (seeded RNG, FK/UNIQUE/NOT NULL) | **Sửa** nhẹ `testdata/generate.ts` `boolLiteral` (Oracle→`1/0`, default đã đúng); còn lại **Auto** |
| T27 | Result Grid Group-By popover (subtotals, server-side SQL) | **Auto** (client-side) |
| T28 | Proc/Func Execute + Rename | **Sửa** `routines.ts` (`SELECT … FROM DUAL`, `TABLE(fn())`, PL/SQL OUT block; rename→comment) — §5.6 |
| T29 | Index/FK Manager tab | **Sửa** `indexes.ts` (`genDropIndex` bỏ IF EXISTS) — §5.6; component **Auto** (qua `!isClickhouse`) |
| T30 | ClickHouse MV/Dictionary create | **N/A** (ClickHouse-only) |
| T31 | MSSQL Azure AD (Service Principal) | **N/A** (MSSQL-only); Oracle auth (role SYSDBA/wallet) là surface riêng của Oracle, không tái dùng |
| PARTITIONS | View + Create + Manage + Convert + Add (RANGE/LIST/HASH) | **Sửa** `partitions.ts` (mọi hàm) + `partitions()` driver + Table Designer tab — §5.6, M16, BẮT BUỘC |
| RESERVED | Autocomplete reserved-word quoting theo dialect | **Sửa** `reserved.ts` `BY_SYSTEM.oracle` + rà SAFE — §5.6 |
| FUNCTIONS | Autocomplete hàm (introspect + static) + tô màu hàm editor | **Sửa** `functions.catalog.ts` static Oracle + `functions.ts` + `functions()` driver; tô màu (`SqlEditor` functionHighlighter) **Auto** khi có catalog |
| Objects tab | Tab Objects (pinned, Table Name/Data Length/Rows, context menu) | **Auto** (relational; `data_length` từ driver `tables()`) |
| AUDIT-1..13 (relational UX) | hover connection, Result Grid copy đa-định-dạng, pagination, tree per-database, inline edit Execute/Cancel/Reset, Design Table 6 tab, folder filter SSMS-style, number-color, save-before-close ghi file, Alter/Drop/Execute per type, Compare 2-DB, autocomplete alias+dup-column | Phần lớn **Auto** (frontend agnostic); các điểm gate qua membership M1–M18 (§5.5) + dialect §5.6. Design Table cần `table-designer.ts` Oracle §5.6 |
| AUDIT (engine-specific của hệ khác) | Redis key browser, NATS/Kafka streaming explorer, Cassandra C1–C5, Mongo M6, MySQL collation, ClickHouse ops | **N/A** (không phải Oracle) |
| Editor chung | multi-statement split, transaction (nút đã gỡ AUDIT-2), Ctrl+S save file, theme persist, snippets, history, split view, quick connect, connection groups/env, reserved quoting | **Auto** — trừ splitter `statements.ts` cần hiểu `/`+PL/SQL block (§5.6, rủi ro cao) |
| ResultGrid | cột động, NULL badge, JSON cell popup, No. gutter, keyboard nav, multi-select, chart, copy tsv/csv/json/sql-insert/sql-update/markdown/xml, paging, group-by | **Auto** — trừ number-color canh phải cần `NUM_COLOR_SYSTEMS`+= oracle (M13) |

**Kết luận không-mơ-hồ**: mọi tính năng quan hệ đều có disposition xác định. Các "tuỳ chọn" trong bản nháp trước (streaming export T24, backup T22, partitions) nay **chuyển thành BẮT BUỘC** để đạt "không thiếu tính năng nào" — xem §5.2/§5.6/§5.8 đã cập nhật. Chỉ N/A là tính năng riêng của engine khác (ClickHouse MV, MSSQL AAD/Query Store, MySQL collation, Redis/NATS/Kafka/Cassandra/Mongo) — không phải phạm vi Oracle.

---

## BƯỚC 2ter — Phủ NGUỒN-THỰC-TẾ: mọi menu + tab (chứng minh không sót)

**Phương pháp liệt kê (để chứng minh đầy đủ, không dựa suy diễn):** tập tính năng quan hệ = hợp của 4 nguồn ground-truth đã đọc trọn:
(1) mọi `#[tauri::command]` — §1.5 (108 command, đã phủ);
(2) mọi item context menu quan hệ — bảng dưới + §2ter.B;
(3) mọi `TabContentType` workspace — §2ter.C;
(4) mọi `sql/*.ts` dialect helper — §5.6.
Oracle phải có disposition xác định ở **cả 4**. Dưới đây là (2)+(3) (nguồn (1),(4) ở §1.5/§5.6).

### 2ter.A — Menu bảng dùng-chung (nguồn: `TableContextMenu.svelte`, đọc trọn 1-215 — "rule chung" cho Explorer tree + Objects tab)

Mỗi mục → disposition Oracle. **Không mục nào bị bỏ.**

| Menu item (dòng) | Cơ chế | Oracle disposition |
|---|---|---|
| Open Data (`:134`) | `openTableViewer` | **Auto** (tab table-viewer, generic) |
| Import Data… (`:135`) | `importWizard` | **Sửa** `import/plan.ts` `conflictSupported` (MERGE) — M18 |
| Export Data… (`:136`) | `exportWizard.showTable` | **Sửa** `export/query.ts` `supportsOffset` — M17 |
| New Query (`:137`) | `selectStarSql` | **Sửa** `dialect.ts` selectStarSql (FETCH FIRST) |
| Design Table (`:140`) | `openTableDesigner` | **Sửa** `table-designer.ts`+`datatypes.ts` — §5.6 |
| Manage Indexes & FKs… (`:144`, `!isClickhouse`) | `openIndexManager` | **Sửa** `indexes.ts` — §5.6 (component Auto) |
| Partitions ▸ Show/Add (`:146-156`, `supportsPartitioning`) | `addPartitionWizard`/`onShowPartitions` | **Sửa** `partitions.ts` — M16 |
| Generate Test Data… (`:158`) | `testDataWizard` | **Sửa** nhẹ `testdata/generate.ts` bool — §5.6 |
| Generate SQL ▸ SELECT/INSERT/UPDATE/DELETE (`:159-167`) | `genSelect/genInsert/genUpdate/genDelete` | **Sửa** `ddl.ts` genSelect (FETCH FIRST); genUpdate/Delete default đúng |
| Generate Scripts ▸ Structure/Data/Both (`:168-175`) | `generateScript`+`genCreate`+`genForeignKey`+`listForeignKeys`+`execStatement`+`toSqlInsert` | **Sửa** `ddl.ts` + `scripts` `/` terminator; `toSqlInsert`/`buildExportSelect` Auto |
| View DDL (`:176`) / Copy DDL (`:177`) | `genCreate` | **Sửa** `ddl.ts` genCreate (kiểu từ introspection Oracle) |
| ClickHouse ops (`:178-190`) | chops.* | **N/A** (chỉ ClickHouse) |
| Copy to… (`:192`) | `copyWizard` | **Sửa** `CopyTableDialog` REL + `copy/types.ts` — M15 |
| Rename… (`:193`) | `genRename` | **Sửa** `ddl.ts` genRename (`ALTER TABLE … RENAME TO` — hợp lệ Oracle) |
| Copy Name (`:194`) / Copy Qualified (`:195`) | clipboard + `quoteIdent` | **Auto** (`quoteIdent` qua `EXTRA.oracle.quote='double'`) |
| Refresh (`:197`) | `explorer.refresh` | **Auto** |
| Truncate [+variants] (`:198-211`) | `truncateWizard`+`truncateOptions` | **Auto** (`truncate.ts` default `TRUNCATE TABLE` đúng Oracle) |
| Drop (`:212`) | `genDrop` | **Sửa** `ddl.ts` genDrop (bỏ `IF EXISTS`) |

### 2ter.B — Các cấp menu khác (Explorer) + connection toolbar

- **Schema node menu** (`ObjectExplorer schemaMenu :1590`): View ER / New ER / Scan Indexes / New Table / Generate Scripts / Create View·Proc·Func·Trigger·Sequence / Compare / Refresh → **Sửa** `create-templates.ts` (Create <type>), `genForeignKey`/introspection cho ER; nút gate qua M1/M4/M6. Create Sequence: Oracle CÓ (nới guard `:27`).
- **Database (current-DB header) menu** (`:1547` `pgMssqlMultiDb`): New Query / New Database / Generate Scripts / Backup / Compare Schemas / Compare Databases / Rename / Drop Database → **Sửa** M4 (pgMssqlMultiDb+oracle); `ddl.ts` genCreate/Drop/RenameDatabase (schema≡user → CREATE USER/comment); Backup (§2.H).
- **Folder menu** (Tables/Views/Procedures/Functions/Triggers/Sequences): New Table / Create <type> / Import / Filter… / Refresh → **Sửa** `create-templates.ts`; folder Sequences hiện qua M6.
- **Column node menu**: Copy Name / Copy as table.column / Set as Filter → **Auto** (clipboard + quoteIdent).
- **View/Proc/Func/Trigger/Sequence node menu**: Show Definition / Alter… / Execute (proc/func) / Drop → **Sửa** `object_definition` (DBMS_METADATA), `alter.ts` (CREATE OR REPLACE), `routines.ts` (Execute), `genDrop`.
- **Connection toolbar** (`ObjectExplorer :150` `RELATIONAL_TOOLS`): Query console / Import / Backup / Session Monitor / Users & privileges → gate M2; Session/Users qua admin (§4.4).
- **Connection context menu** (`ConnectionList`): New Query / Compare Schemas / New Database / Edit / Duplicate / Delete / Disconnect → gate M1 (`REL_SYSTEMS`).

### 2ter.C — Mọi workspace/tab (`App.svelte` `paneBody`, contentType→component) áp dụng Oracle

Oracle dùng **default branch `SqlWorkspace`** + các content-type quan hệ dùng chung — **KHÔNG cần TabContentType mới, KHÔNG sửa App.svelte** (App.svelte không có nhánh `systemType`):

| contentType | Component | Oracle |
|---|---|---|
| `sql-editor` (default) | `SqlWorkspace` | **Auto** (+ gate M7-M11 + dialect §5.6) |
| `table-viewer` | `TableViewerTab` | **Auto** (edit qua apply_grid_changes + Placeholder::Colon) |
| `table-designer` | `TableDesigner` | **Sửa** §5.6 |
| `query-plan` | `PlanVisualizer` | **Sửa** §4.2 |
| `er-diagram` | `ErDiagram` | **Sửa** genForeignKey |
| `schema-compare` | `SchemaCompare` | **Sửa** M12 |
| `index-scanner` | `IndexScanner` | **Auto** (scan_indexes arm) |
| `index-manager` | `IndexManager` | **Sửa** `indexes.ts` |
| `admin` | `AdminView` | **Sửa** M14 + admin_query |
| `objects` | `ObjectsView` | **Auto** (data_length từ `tables()`) |
| `history` / `saved` | `HistoryTab`/`SavedQueriesTab` | **Auto** (storage) |
| redis/nats/kafka/cassandra/mongo/* | (workspace riêng) | **N/A** |

**Kết luận đầy đủ:** mọi menu item (2ter.A/B), mọi tab (2ter.C), mọi command (§1.5), mọi dialect helper (§5.6) đều có disposition Oracle xác định. Không có mục nào "chưa biết". Tính năng duy nhất KHÔNG có cho Oracle = tính năng **engine-specific của hệ khác** (ClickHouse MV/Dictionary/TTL, MSSQL AAD/Query Store/Agent, MySQL collation, Redis/NATS/Kafka/Cassandra/Mongo) — đúng bản chất, không phải thiếu sót.

---

## BƯỚC 3 — Driver Oracle (phần nặng nhất — deep-dive)

### 3.1 Crate — hai lựa chọn đã research (số liệu crates.io tại thời điểm viết)

| | **A — `oracle` (kubo/rust-oracle)** | **B — `oracle-rs` (stiang)** |
|---|---|---|
| Version / ngày | **0.6.3** (crates.io, 2025-01-02); **0.7.0-dev** trên GitHub master, CHƯA publish (releases trống) | **0.1.7** / 2026-03-24 |
| Downloads / stars | ~2.14M / trưởng thành | ~5.8k / ~20★, ~30 commit (pre-1.0) |
| Nền tảng | ODPI-C/OCI (C) | **Thuần Rust, TNS protocol** |
| Async | **KHÔNG** (blocking; sibyl là bản async khác) | **CÓ (Tokio)** |
| Instant Client | **CẦN (runtime, Oracle client 11.2+)** | **KHÔNG cần** |
| Build | cần **C compiler** | thuần Rust (như sqlx) |
| Oracle tối thiểu | 11.2+ | **12c R1+** |
| Gap | (đầy đủ) | LONG/LONG RAW, XMLType, AQ, sharding chưa có |
| Hợp kiến trúc repo | Kém (cần actor thread + packaging) | **Tốt (cắm thẳng, đóng gói tĩnh)** |

Cargo.toml (`src-tauri/Cargo.toml`) — đề xuất theo lựa chọn:
```toml
# Lựa chọn A — OCI/ODPI-C, BLOCKING, cần Instant Client runtime:
oracle = { version = "0.6", features = ["chrono"] }   # crates.io publish mới nhất = 0.6.3
# (Master GitHub đang ở 0.7.0-dev, CHƯA publish lên crates.io. Muốn 0.7 phải pin git rev:
#  oracle = { git = "https://github.com/kubo/rust-oracle", rev = "<sha>", features=["chrono"] }
#  → rủi ro build reproducibility; khuyến nghị dùng 0.6.3 publish trừ khi cần feature 0.7.)

# Lựa chọn B — thuần Rust async, KHÔNG Instant Client (đồng nhất rustls toàn repo):
oracle-rs = "0.1"                                      # [CẦN XÁC MINH tên crate/feature TLS]
```
- **Feature-gate**: để Oracle sau cargo feature `oracle` (mặc định off) → build CI/macOS không bắt buộc phụ thuộc Oracle; bật khi đóng gói bản có Oracle. Bắt buộc nếu chọn A (Instant Client); tuỳ chọn nếu chọn B.
- **`[profile.release] panic = "abort"`** (`Cargo.toml`): driver **không được panic** (giống fix PG timestamp AUDIT-2 #5). Mọi decode →JSON/`NaiveDateTime` phải trả marker/Err, không `unwrap` (áp dụng cả A lẫn B).
- **KHÔNG có driver Oracle async thuần-Rust nào KHÁC trưởng thành** — B là ứng viên thuần-Rust duy nhất, và nó non-trẻ; đây là lý do khuyến nghị thử B nhưng có sẵn A làm fallback.

### 3.2 Ghép blocking driver vào mô hình async — **CHỈ áp dụng nếu chọn A** (`oracle` crate)

> Nếu chọn B (`oracle-rs` async thuần Rust): BỎ QUA §3.2 — driver cắm thẳng như sqlx/tiberius, `impl LiveConnection` gọi `d.method().await` bình thường, không cần actor thread.

`oracle::Connection` (lựa chọn A) là blocking và **`!Sync`** (không chia sẻ qua nhiều thread cùng lúc). Registry giữ `Arc<tokio::sync::Mutex<LiveConnection>>` (`registry.rs:19`), mọi method `async`. Hai hướng:

- **(A) Actor thread riêng/connection (KHUYẾN NGHỊ)**: khi `connect`, spawn 1 OS thread sở hữu `oracle::Connection`; `OracleDriver` giữ `mpsc::Sender<OracleCmd>`; mỗi method async gửi `OracleCmd{sql/params, oneshot::Sender<Result<..>>}` rồi `.await` oneshot. Ưu điểm: connection không bao giờ vượt biên thread (thoả `!Sync`), cancel = drop channel/gọi OCI `break()` từ thread khác, heal = respawn thread. Nhược: nhiều boilerplate; phải map lỗi kênh.
- **(B) `spawn_blocking` + `Arc<Mutex>`**: mỗi method `tokio::task::spawn_blocking(move || conn.query(...))`. Vướng: `oracle::Connection` `!Sync` + không `'static`-friendly khi mượn qua `Arc<Mutex>`; giữ `MutexGuard` qua `spawn_blocking` không hợp lệ. Khó hơn thực tế, và cancel/heal kém sạch.

→ **Chốt (A)**. Điều này KHÔNG rò rỉ ra ngoài `OracleDriver` — `impl LiveConnection` chỉ thấy các method `async fn` bình thường (bảng §1.1). Cancel (`registry.rs:240-249` abort task) vẫn hoạt động ở tầng task tokio; để hủy **server-side** cần thêm OCI `break()` gọi từ ngoài thread (tuỳ chọn nâng cao, v1 chấp nhận abort task + heal-reconnect như hiện tại).

### 3.3 Đóng gói Instant Client (Windows/macOS/Linux) — **CHỈ áp dụng nếu chọn A**

> Nếu chọn B (`oracle-rs`): BỎ QUA §3.3 — không có Instant Client, đóng gói tĩnh như các engine khác. Đây là lợi thế đóng gói lớn nhất của B.

- **Windows (máy dev + user)**: cần `oci.dll` + phụ thuộc từ Instant Client Basic trên `PATH` (hoặc cạnh exe). Beta: yêu cầu user cài + thêm PATH.
- **macOS (universal dmg CI hiện có, commit `fe9b175`)**: Instant Client cho macOS (Intel + Apple Silicon **[CẦN XÁC MINH]** tình trạng arm64) → universal build phức tạp. Khả năng cao **không bundle** cho macOS beta.
- **Linux (INSTALL-UBUNTU.md có sẵn)**: Instant Client `.so` + `LD_LIBRARY_PATH`.
- **Phát hiện runtime**: thêm kiểm tra "OCI khả dụng?" (giống `backup_tool_status` phát hiện binary, `commands/backup.rs`) → nếu thiếu, `connect`/`test` trả `QueryError` hướng dẫn cài Instant Client (KHÔNG panic). Cân nhắc ẩn Oracle khỏi picker nếu OCI thiếu, hoặc hiện nhưng báo lỗi rõ khi connect.
- **License**: Instant Client theo OTN license — cho phép redistribute có điều kiện; **rà trước khi bundle**. Beta khuyến nghị KHÔNG bundle (hướng dẫn cài).

### 3.4 Định tuyến exec (mẫu MSSQL 3 nhánh `mssql.rs:104-154`, chặt hơn)

Oracle nghiêm ngặt hơn MSSQL — cần lớp `util`-style phân loại (mẫu `util.rs:34-52`):
1. **Strip trailing `;`** cho statement SQL đơn (Oracle từ chối `;` cuối câu SQL thuần — `;` là terminator của SQL*Plus/PLSQL, không thuộc câu gửi qua OCI).
2. **KHÔNG multi-statement**: OCI 1 statement/execute. Splitter client-side (`sql/statements.ts`) đã tách; nhưng cần thêm hiểu **`/` terminator + block `DECLARE`/`BEGIN`/`PACKAGE`** (§5.6 statements.ts) để không cắt nhầm body PL/SQL.
3. **`is_plsql_block`** (mới, mẫu `is_raw_batch` `mssql.rs:740`): leading `BEGIN`/`DECLARE`, hoặc `CREATE [OR REPLACE] (PROCEDURE|FUNCTION|PACKAGE|PACKAGE BODY|TRIGGER|TYPE|TYPE BODY)` → chạy như anonymous block/DDL, KHÔNG prepared DML. Gửi nguyên khối (đã bỏ `/` cuối).
4. **`returns_rows`** (`util.rs:34`): Oracle `EXPLAIN` KHÔNG trả rows (khác giả định hiện tại map `EXPLAIN`→rows) → plan đi đường riêng (§4.2), không qua `exec` chung. `CALL`/`SELECT`/`WITH` trả rows; `SELECT … FROM DUAL` cho scalar.
5. **DBMS_OUTPUT**: output `DBMS_OUTPUT.PUT_LINE` KHÔNG phải result set. v1: bỏ qua (hoặc `DBMS_OUTPUT.ENABLE` + poll `GET_LINES` sau block rồi gộp vào messages/warnings). **[QUYẾT ĐỊNH]** — `StatementOutcome` (`types.rs:67-76`) hiện không có kênh output; v1 khuyến nghị bỏ qua, ghi backlog.
6. **Bind placeholder** (`drivers/grid.rs:22-28` `Placeholder`): thêm biến thể **`Colon` → `:1,:2`** (hiện `_ => ?` SAI cho Oracle). Dùng bởi `grid::build` (Apply) + `grid::build_select` (filter/paging).
7. **Affected rows**: OCI trả row-count DML bình thường → `StatementOutcome::Affected`.

### 3.5 Giải mã kiểu → hợp đồng [name,type] + JSON (mẫu `mssql.rs:755-892`, `postgres.rs:843-895`)

- `NUMBER`/`NUMBER(p,s)` → **String** (arbitrary precision — theo precedent PG `NUMERIC`→String `postgres.rs:859`, MSSQL decimal→String `mssql.rs:839`; KHÔNG ép f64).
- `BINARY_FLOAT`/`BINARY_DOUBLE` → JSON number.
- `VARCHAR2`/`NVARCHAR2`/`CHAR`/`NCHAR`/`CLOB`/`NCLOB`/`LONG` → String (CLOB đọc qua LOB locator).
- `DATE` (Oracle DATE **có phần time**) → ISO datetime string.
- `TIMESTAMP`/`TIMESTAMP WITH [LOCAL] TIME ZONE` → ISO string kèm offset.
- `INTERVAL YEAR TO MONTH`/`DAY TO SECOND` → String.
- `RAW`/`LONG RAW`/`BLOB` → hex string (`0x…` như MSSQL `mssql.rs:879`, hoặc `\x…` như PG).
- `ROWID`/`UROWID` → String.
- `BOOLEAN` (23c+) → bool; `JSON` (21c+) → parse JSON.
- NULL → `Value::Null`. **Phòng panic**: mọi convert dùng `checked_*`/trả marker (chuẩn `postgres.rs:911` `decode_pg_timestamp`).
- Cột `type` trong `cols` = tên type Oracle lowercase (parity PG/MSSQL).

---

## BƯỚC 4 — Ánh xạ Oracle + phân tích per method

### 4.1 Ánh xạ khái niệm

| Khái niệm | Oracle | Ghi chú |
|---|---|---|
| database | instance / **service (SID/PDB)** | connect bind service, không phải "database" switch được như PG. CDB→list PDB (`databases()`); non-CDB=1 |
| schema | **user** | `schemas()` = `ALL_USERS`; default = CURRENT_SCHEMA. Đối xử như PG/MSSQL (schema lồng dưới DB header) |
| table/view | table/view | `ALL_TABLES`/`ALL_VIEWS` |
| column | column | `ALL_TAB_COLUMNS`; kiểu VARCHAR2/NUMBER/DATE/CLOB/… |
| PK/FK/UNIQUE/CHECK | constraint | `ALL_CONSTRAINTS` P/R/U/C |
| index | index | `ALL_INDEXES` (+ BITMAP, function-based) |
| sequence | sequence | `ALL_SEQUENCES` — **CÓ** (không như MSSQL Phase-1) |
| procedure/function | standalone + trong **package** | `ALL_PROCEDURES`; package là cấp gộp (parity: hiện dưới folder Procedures/Functions) |
| trigger | trigger | `ALL_TRIGGERS`; dùng `:NEW`/`:OLD` |
| partition | partition (RANGE/LIST/HASH/INTERVAL) | `ALL_TAB_PARTITIONS` |
| auto-increment | **IDENTITY (12c+)** hoặc **sequence+trigger** | không có `AUTO_INCREMENT` |
| LIMIT/TOP | **`FETCH FIRST n ROWS ONLY`** (12c+) / `ROWNM<=n` (11g) | KHÔNG `LIMIT`/`TOP` |
| boolean | **KHÔNG có SQL boolean <23c** | dùng `NUMBER(1)`/`CHAR(1)`; testdata bool→`1/0` |
| DDL text | `DBMS_METADATA.GET_DDL` | trả CLOB |
| `IF EXISTS` | **KHÔNG có <23c** | drop phải bắt lỗi hoặc bỏ `IF EXISTS` |
| string concat | `\|\|` | |
| scalar SELECT | `SELECT expr FROM DUAL` | **cần `FROM DUAL`** <23c |
| PL/SQL block terminator | `/` trên dòng riêng | splitter phải hiểu |

### 4.2 EXPLAIN — Oracle theo precedent PG/MSSQL (KHÔNG Cassandra)

- Oracle có CBO tĩnh → **`has_planner=true`**; actual qua hint `GATHER_PLAN_STATISTICS` + `DBMS_XPLAN.DISPLAY_CURSOR(FORMAT=>'ALLSTATS LAST')` (A-Rows/A-Time) → mode **`actual`** (`ActualKind::Analyze`). Không `tracing`.
- `cost_basis = Cost` (CBO có cost cumulative ở dòng 0).
- Việc cần làm:
  1. `plan::capability("oracle") => EngineCapability{ has_planner:true, supports_actual:true, actual_kind:Analyze, cost_basis:Cost }` (`drivers/plan.rs:141-164`).
  2. **`explain_oracle`** trong `commands/plan.rs` (mẫu `explain_mssql` `plan.rs:108-141`): 2 bước — `EXPLAIN PLAN FOR <sql>` (không result) rồi `SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY(NULL,NULL,'ALL'))` (estimated) hoặc chạy có hint + `DISPLAY_CURSOR` (actual). **KHÔNG dùng `build_explain` fallback** (`plan.rs:217-236` trả `EXPLAIN {sql}` — SAI cho Oracle; test placeholder `plan.rs:438` chỉ là stub). Guard write (aggregate ghi / DML actual) mẫu `plan.rs:47-54`.
  3. **`parse_oracle(rows, actual)`** trong `drivers/plan.rs`: đọc `PLAN_TABLE` (id, parent_id, operation, options, object_name, cardinality, cost, bytes) dựng cây theo parent_id (mẫu `parse_sqlite` `plan.rs:559`), HOẶC parse text `DBMS_XPLAN`. Cost cumulative ở đỉnh → `assign_cost_pct(root, true)` (`plan.rs:1124`).
  4. `normalize_op` (`plan.rs:176-228`): thêm map `"table access full"→SeqScan`, `"index range scan"→IndexScan`, `"index unique scan"→IndexSeek`, `"hash join"/"nested loops"/"merge join"/"sort"/"hash group by"`.
  5. FE `mode` union đã có `'estimated'|'actual'` — không đổi type.
  6. Missing-index: Oracle không có DMV như MSSQL; v1 bỏ (`missing_index=None`).
- Demo `explain_capability` (`demo.ts:993-1014`): thêm `case 'oracle'` (`has_planner:true, supports_actual:true, actual_kind:'analyze', cost_basis:'cost'`) — nếu không toggle EXPLAIN bị disable trên demo.

### 4.3 Định danh & case-folding (bẫy toàn cục)

Oracle fold tên KHÔNG-quote → UPPERCASE; `ALL_*` trả tên UPPERCASE cho tên thường. Quoting `"x"` làm tên **case-sensitive** → chỉ khớp khi tên lưu đúng case đó. Hệ quả:
- Introspection trả tên đúng case Oracle (thường UPPERCASE). Cây Explorer/grid hiển thị UPPERCASE — chấp nhận (giống thực tế Oracle).
- Generator SQL (`quoteIdent` `"X"`): với tên UPPERCASE-thuần, quote hay không đều khớp; với tên có chữ thường lưu case-sensitive, PHẢI quote. `reserved.ts` (§5.6) đảm nhiệm quyết định quote khi trùng keyword.
- **[QUYẾT ĐỊNH]** (§0.3 #4): mặc định — quote luôn (an toàn, giữ case), chấp nhận UI hiện `"NAME"`; hoặc quote-nếu-cần. Khuyến nghị: theo precedent hiện có (quote qua `quoteIdent`), không phát minh thêm.

### 4.4 Admin & Kill session (khác biệt quan trọng)

- `admin_query("oracle", view)` (`commands/admin.rs:34-127`): thêm arms:
  - `sessions` → `V$SESSION` join `V$SQL` (sid AS pid, username, status AS state, sql text) WHERE `type='USER'`.
  - `locks` → `V$LOCK`/`V$LOCKED_OBJECT` join `DBA_OBJECTS`/`V$SESSION`.
  - `users` → `DBA_USERS` (username AS role, account_status).
  - **Lưu ý**: V$ views cần quyền `SELECT` trên `V_$SESSION`… — tài khoản non-DBA có thể thiếu → xử lý lỗi mềm như MSSQL query_store.
- `kill_query("oracle", pid)` (`admin.rs:130-138,200-233`): **MISMATCH** — Oracle cần `sid,serial#` (+ optional inst_id RAC), nhưng signature chỉ truyền `pid: i64`. Hướng: (A) encode `sid,serial#` vào `pid` phía frontend (AdminView truyền chuỗi), hoặc (B) nới command nhận thêm serial#. Lệnh: `ALTER SYSTEM KILL SESSION 'sid,serial#'` (hoặc `DISCONNECT SESSION … IMMEDIATE`). **[QUYẾT ĐỊNH]**.
- `AdminView.svelte`: thêm `case 'oracle'` vào `VIEWS` (`:16-53`, hiện rơi `default` chỉ Session Monitor) + thêm `'oracle'` vào `canKill` (`:57`).

---

## BƯỚC 5 — Spec triển khai đầy đủ

### 5.1 File TẠO MỚI

| File | Nội dung | Mẫu tham chiếu |
|---|---|---|
| `src-tauri/src/drivers/oracle.rs` | `OracleDriver` + `OracleConnParams` + actor thread (§3.2) + `connect/test/ping/exec/exec_params/apply_changes` + 12 method introspection (§1.1) + `scan_indexes` + decode OCI→JSON (§3.5) + `is_plsql_block`/strip-`;` (§3.4) + unit tests thuần | `drivers/mssql.rs` (gần nhất), `drivers/postgres.rs` |
| `public/assets/db-oracle.svg` | **Logo Oracle CHÍNH THỨC = wordmark "ORACLE" màu đỏ** (Oracle KHÔNG có glyph 1 chữ — logo là chữ "ORACLE"). SVG tự chứa (CSP chặn asset ngoài). **KHÔNG vẽ tay mark giả** — lấy path wordmark thật (nguồn open-source `simple-icons` glyph `oracle` = đúng wordmark, monochrome fill → dùng `currentColor`/đổ màu accent, CSP-safe khi inline). Aspect ratio wordmark rộng (~7:1) → trong ô SystemIcon vuông sẽ hiển thị nhỏ giữa ô (đúng bản chất wordmark, giống cách các tool khác hiển thị Oracle). Verify render 16/24/48/128px (như precedent postgres SVG trong CLAUDE.md) | `db-mariadb.svg` (SVG brand), `db-mysql.png`/`db-mssql.png` (raster brand) |
| `src-tauri/tests/oracle_integration.rs` *(hoặc arm trong file có sẵn)* | Container Oracle thật qua `testcontainers-modules` feature `oracle` (image mặc định `gvenzl/oracle-free:23-slim-faststart`, creds `test`/`test`, **chỉ x86_64 Linux — không ARM**, §5.9): connect/tree/exec/insert-update-delete by PK/indexes/explain/DDL round-trip. Seed→query verify | `tests/drivers_integration.rs`, `tests/partitions_integration.rs` |

**LƯU Ý integration**: image Oracle nặng + chậm khởi động (1–3 phút, giống Cassandra/MSSQL) → timeout rộng. Methodology bắt buộc (CLAUDE.md): prebuild `--no-run`, chạy 1-shot có `timeout`, ghi log + đọc cùng command; KHÔNG `docker rm`/prune theo label. Container Oracle cần Instant Client trên máy chạy test.

### 5.2 File Backend cần SỬA

| File | Sửa | Vị trí |
|---|---|---|
| `src-tauri/Cargo.toml` | thêm `oracle` crate (feature-gate `oracle`) | `[dependencies]` |
| `drivers/mod.rs` | `pub mod oracle;` + `use oracle::{OracleConnParams, OracleDriver};` + biến thể `LiveConnection::Oracle` + `fn oracle_params(...)` + **19 match arm** (bảng §1.1) | `:1-55,57-225,227-637` |
| `drivers/types.rs` | `SystemType::Oracle` + `as_str` + (cân nhắc) `is_phase1_sql` | `:10-51` |
| `connections/profile.rs` | `default_port(Oracle)=1521` (+ field mới §5.4 nếu chọn B) | `:101-114,51-98` |
| `drivers/grid.rs` | `Placeholder::Colon` (`:1`) + `quote_style` giữ DoubleQuote (fallback ok, chú ý case §4.3) + **`build_select` arm Oracle** (`OFFSET…FETCH`/`ROWNUM`, không `LIMIT`) | `:22-28,38-44,299-360` |
| `commands/plan.rs` | `explain_oracle` (2-step EXPLAIN PLAN + DBMS_XPLAN) + nhánh trong `explain_plan` | `:14-86,108-141` |
| `drivers/plan.rs` | `capability("oracle")` + `parse_oracle` + `normalize_op` op Oracle | `:141-164,176-228,235…` |
| `commands/schema.rs` | `definition_query`/`index_definition_query` arm Oracle (`DBMS_METADATA.GET_DDL`) | `:166-208,214-275` |
| `commands/admin.rs` | `admin_query` arms Oracle (V$SESSION/V$LOCK/DBA_USERS) + `kill_query` (sid,serial#) | `:34-138,200-233` |
| `commands/grid.rs` | (chỉ nếu cần) default system fallback vẫn `"postgres"` — không đụng; exec_filtered dùng `build_select` đã sửa | `:41-85` |
| `commands/export.rs` | **`LiveConnection::Oracle(o) => o.stream_export(...)`** (BẮT BUỘC) + method `stream_export` trên driver (cursor → BufWriter, paging OFFSET/FETCH) | `:16-75` |
| `commands/backup.rs` + `drivers/backup.rs` | **arms `expdp`/`impdp`** (BẮT BUỘC): `backup_tool(Oracle)=Some("expdp")`, `restore_tool=Some("impdp")`, `external_backup_cmd`/`external_restore_cmd` dựng lệnh Data Pump (connect `user/pass@service`, `DIRECTORY`+`DUMPFILE`; password KHÔNG để trên argv — dùng file `parfile` như trick mongo `--config` `backup.rs:24-32`) | `backup.rs:6-137` |
| `src-tauri/src/drivers/oracle.rs` | thêm method `stream_export<W>` (mẫu `postgres.rs:687`, `clickhouse.rs:414-489`) | file mới |
| `src-tauri/src/lib.rs` | (chỉ nếu tạo command mới — Oracle hầu như KHÔNG cần) | `:35-182` |

**Command TỰ ĐỘNG chạy cho Oracle (không sửa, chỉ cần §1.1 arms):** `exec_statement`, `cancel_query`, toàn bộ `list_*` + `scan_indexes` (schema.rs, qua macro `introspect!` `schema.rs:11-16`), `apply_grid_changes`, `preview_grid_changes`/`exec_filtered` (sau khi sửa grid.rs), `ping_connection`, `open_tab_connection`/`close_tab_connection`, `connect`/`disconnect`/`reconnect`/`quick_connect`, `test_connection`/`cancel_test`, `list_history`/snippets, `save/load_tabs`, `object_definition`/`index_definition` (sau khi thêm definition_query arm). **KHÔNG** cho Oracle vào `open_database`/`attach_database` whitelist multi-DB kiểu PG/MSSQL trừ khi làm PDB switching (`connections.rs:201`) — v1 Oracle browse schema qua `list_schemas`/`list_tables(schema)`, không sub-connection per-database.

### 5.3 Command mới cần thiết?

**Gần như KHÔNG.** Oracle là quan hệ chuẩn → dùng toàn bộ command generic (`exec_statement`, `list_*`, `apply_grid_changes`, `explain_plan`, `admin_view`, `object_definition`, `backup_*`). Không cần `oracle_exec`/`oracle_tree` (khác Mongo/Cassandra). Chỉ SỬA các command có `match system` (bảng §5.2).

### 5.4 Field ConnectionProfile cho Oracle — [QUYẾT ĐỊNH §0.3 #3]

- **(A) Tối thiểu**: `host`/`port`/`user`/`password`, `database` = service name; reuse `mssql_auth` làm connect-kind (`service`/`sid`/`tns`) — precedent Kafka reuse `mssql_auth` (`mod.rs:163-167`). TLS reuse `ssl`+`ssl_ca` (wallet). KHÔNG đụng struct `profile.rs`.
- **(B) Đầy đủ (KHUYẾN NGHỊ)**: thêm field `#[serde(default)]` — `oracle_service: String`, `oracle_sid: String`, `oracle_tns: String`, `oracle_connect_kind: String` (service|sid|tns), `oracle_role: String` (NORMAL|SYSDBA). Thêm field mới PHẢI cập nhật: `profile.rs` (struct — `ProfilePublic::from_profile` `:128-135` không cần đổi, chỉ scrub password), `types.ts` `ConnectionProfile` (`:31-53`), `connections.svelte.ts` `makeBlankProfile` (`:227-253`), `demo.ts` factory `conn(...)` default (`:11-46`), `ConnectionForm.connectionAffectingChanged` keys (`:169-175`).

### 5.5 File Frontend cần SỬA (checklist đầy đủ)

| # | File | Sửa gì | Vị trí |
|---|---|---|---|
| 1 | `spec/.../Database Studio.dc.html` | Thêm entry `oracle` vào map `SYS`: **accent = Oracle Red chính thức `#C74634`** (Redwood — màu brand hiện hành trên oracle.com; hoặc `#F80000` là đỏ logo cổ điển mà `simple-icons` dùng — chọn 1, khuyến nghị `#C74634`); bg/border/fg tông đỏ hài hoà; **badge `OR`** (2 ký tự, không có glyph); **label `Oracle`** | map `SYS` |
| 2 | `scripts/extract-tokens.mjs` | Thêm `'oracle'` vào `EXPECTED_SYSTEMS` | `:60-66` |
| 3 | **chạy** `npm run tokens` | Tái sinh `systems.gen.ts` + `tokens.css` (`--sys-oracle-*`) — KHÔNG hand-edit | `systems.gen.ts:1-5` |
| 4 | `src/lib/types.ts` | `SystemType` += `'oracle'` (+ field profile §5.4 nếu B) | `:5-16,31-53` |
| 5 | `src/lib/systems.ts` | `EXTRA.oracle` (`RELATIONAL,1521,'double',true`); `SYSTEM_ORDER` += oracle | `:41-52,77-89` |
| 6 | `src/lib/components/SystemIcon.svelte` | nhánh `{:else if key==='oracle'}` → render `db-oracle.svg` (wordmark thật). Vì là **brand asset** (không phải stroke path đơn giản) → theo precedent `mysql`/`mssql` (`<img src="/assets/…">`, `:22,24`) hoặc `mariadb`/`postgres` (`<img>` SVG, `:20,27`); nếu inline SVG monochrome thì đổ `fill={color}` (color = `meta.accent` từ SYS_GEN). KHÔNG rơi vào fallback vòng tròn orphan `:90` | `:14-91` |
| 7 | `src/lib/components/connections/ConnectionForm.svelte` | `isOracle` derived + khối field service/SID/TNS/role + hostLabel + (+`connectionAffectingChanged` nếu field mới) | `:49-82,169-175,320-419` |
| 8 | `src/lib/stores/connections.svelte.ts` | `makeBlankProfile` default oracle (nếu field mới) | `:227-253` |
| 9 | `src/lib/demo.ts` | Thêm 1 `DEMO_PROFILES` oracle (`conn('c13','Oracle','oracle','10.0.7.1',1521,'ORCLPDB1','system',...)`) + `explain_capability` case oracle. KHÔNG cần command case mới (dùng mock relational chung) | `:49-104,993-1014` |
| 10 | `src/lib/components/connections/ConnectionList.svelte` | `REL_SYSTEMS` += `'oracle'` (isRelational → toolbar/ER/Compare) | `:64` |
| 11 | `src/App.svelte` | (cosmetic) cập nhật câu Welcome nhắc Oracle | `:287` |

**Membership sets/branches PHẢI thêm `'oracle'` (parity — nếu thiếu → tính năng biến mất/SQL sai):**

| # | File:line | Literal / branch | Nếu thiếu |
|---|---|---|---|
| M1 | `ConnectionList.svelte:64` | `REL_SYSTEMS` | không nhận là relational (toolbar/ER/Compare tắt) |
| M2 | `ObjectExplorer.svelte:150` | `RELATIONAL_TOOLS` | toolbar dưới (Query/Import/Backup/Sessions/Users) tắt |
| M3 | `ObjectExplorer.svelte:1191` | inline relational filter-box list | mất ô "Filter databases…" |
| M4 | `ObjectExplorer.svelte:82-84` | `pgMssqlMultiDb` (thêm oracle vào test `postgres\|\|mssql`) | mất current-DB header + foreign-DB subtree + `base=1` |
| M5 | `ObjectExplorer.svelte:342,477` | `loadDatabases` guard (`postgres\|\|mssql`) | không list PDB/DB khác khi connect/refresh |
| M6 | `ObjectExplorer.svelte:2207,2302` | Sequences folder (main + foreign subtree; thêm oracle cạnh `isPg`) | mất folder Sequences |
| M7 | `SqlWorkspace.svelte:66` | `supportsDbSwitch` | mất DB dropdown |
| M8 | `SqlWorkspace.svelte:81` | `supportsSchemaSwitch` (Oracle schema-based → YES) | mất Schema dropdown |
| M9 | `SqlWorkspace.svelte:90-98` | `loadDbList` (thêm nhánh oracle → schemas/PDB) | dropdown rỗng |
| M10 | `SqlWorkspace.svelte:177` | `RELATIONAL` (danger confirm) | không cảnh báo DELETE/TRUNCATE |
| M11 | `SqlWorkspace.svelte:330` | `RELATIONAL` (dynFns autocomplete) | không có function autocomplete server |
| M12 | `SchemaCompare.svelte:36,92` | `RELATIONAL` + `loadDbs` | không chọn được để Compare |
| M13 | `ResultGrid.svelte:394` | `NUM_COLOR_SYSTEMS` | số không tô màu/không canh phải |
| M14 | `AdminView.svelte:16-53,57` | `VIEWS` case oracle + `canKill` | chỉ có Session Monitor rỗng |
| M15 | `CopyTableDialog.svelte:16` | `REL` | không copy được (source/dest) |
| M16 | `partitions.ts:292,297` | `supportsPartitioning`/`canConvertToPartitioned` (nếu làm partition) | không có UI partition |
| M17 | `export/query.ts:24-31` | `supportsOffset` (Oracle OFFSET/FETCH) | export paging sai |
| M18 | `import/plan.ts:13-19` | `conflictSupported` (Oracle MERGE) | on-conflict tắt |

**KHÔNG thêm `'oracle'` vào** (Oracle schema-based, 1 DB/connection, giống PG — không phải "schema=database"):
- `schemaIsDatabase`/`schemaNodeIsDatabase` (`ObjectExplorer.svelte:70,75-77`), `dbDefaultSchema` schema-as-DB list (`SqlWorkspace.svelte:301`), `StatusBar.svelte:24`, `TableViewerTab.svelte:30`, `ObjectsView.svelte:34-35`, `CollationDialog` (MySQL-only).

### 5.6 Per-dialect module SQL (`src/lib/sql/*.ts`) — Oracle branch (thiếu → SQL SAI, không crash)

**PHẢI thêm arm Oracle:**
- `dialect.ts` `selectStarSql` (`:24-33`): Oracle → `FETCH FIRST n ROWS ONLY` (12c+), KHÔNG `LIMIT`.
- `datatypes.ts` (`:13-49`): `ORACLE_TYPES` (NUMBER/VARCHAR2/NVARCHAR2/CHAR/CLOB/BLOB/RAW/DATE/TIMESTAMP[/WITH TIME ZONE]/INTERVAL…/BINARY_FLOAT/BINARY_DOUBLE/ROWID/JSON(21c)/BOOLEAN(23c)) + `defaultColumnType('oracle')='NUMBER'`. Thiếu → dropdown Table Designer rỗng.
- `ddl.ts`: `genSelect` (`FETCH FIRST`), `genAlterTable` (`ADD (col …)`/`MODIFY (col …)`, colType `NUMBER`), `genDrop` (bỏ `IF EXISTS`), `genCreateDatabase`/`genDropDatabase`/`genRenameDatabase` (schema≡user → `CREATE USER`/comment), `defaultSchema` (= current user UPPERCASE).
- `table-designer.ts`: `alterColumn` (`ALTER TABLE t MODIFY (col type …)` — hiện rơi default "unsupported" → edit cột im lặng không chạy), `buildTrigger` (`CREATE OR REPLACE TRIGGER … FOR EACH ROW BEGIN … END; /`, dùng `:NEW`/`:OLD`), add-column keyword vào nhóm `ADD (…)` (`:362`), **bỏ `ON UPDATE`** khỏi `fkClause` (`:135-143` — Oracle FK không hỗ trợ ON UPDATE), `defaultSchema`.
- `indexes.ts` `genDropIndex` (`:31-44`): `DROP INDEX name` KHÔNG `IF EXISTS`. (`genDropForeignKey` default `DROP CONSTRAINT` ĐÃ đúng.)
- `alter.ts` `toAlterStatement` (`:25-72`): view/proc/func/trigger/package → `CREATE OR REPLACE` (swap leading CREATE), giữ `/`; table → comment (không `CREATE OR REPLACE TABLE` <23c).
- `create-templates.ts`: procedure/function(`RETURN` không `RETURNS`)/trigger templates PL/SQL + `/`; **sequence**: nới guard `system!=='postgres'` (`:27`) để Oracle có `CREATE SEQUENCE`.
- `routines.ts`: `genRenameRoutine` → comment (Oracle không rename routine in-place); `buildRoutineExec`/`buildCall` → function `SELECT fn(...) FROM DUAL`, table func `SELECT * FROM TABLE(fn(...))`, OUT/INOUT → PL/SQL block `DECLARE … BEGIN … END; /`.
- `statements.ts` (**rủi ro cao nhất**): thêm hiểu **`/` terminator** (dòng riêng kết thúc block, `/` không gửi cho driver) + nhận block bắt đầu bằng `DECLARE`/`BEGIN` + thêm `PACKAGE`/`TYPE` vào regex routine (`:58-70`) để không cắt nhầm `;` trong body.
- `functions.ts` `BY_SYSTEM` + `functions.catalog.ts`: thêm catalog tĩnh Oracle (NVL/NVL2/DECODE/TO_CHAR/TO_DATE/TO_NUMBER/SYSDATE/SYSTIMESTAMP/LISTAGG/SUBSTR/INSTR/TRUNC/ROWNUM/NEXTVAL…) — built-in Oracle không introspect được, phải tĩnh như MySQL/MSSQL.
- `reserved.ts` `BY_SYSTEM`: thêm mảng reserved Oracle (access/audit/cluster/comment/compress/date/file/level/long/minus/mode/number/pctfree/raw/resource/rowid/rownum/session/share/size/start/synonym/sysdate/uid/validate/varchar2/whenever…). **Không có** lang-sql Oracle backstop → list phải đầy đủ; **rà tương tác với `SAFE`** (`:118-125` chứa comment/date/number/size — vài cái này là reserved thật ở Oracle → cần loại khỏi SAFE cho Oracle hoặc xử lý riêng).
- `format.ts` `langOf` (`:4-21`): `case 'oracle': return 'plsql'` (sql-formatter có dialect plsql).
- `partitions.ts` (**BẮT BUỘC** — parity với PG/MySQL/MSSQL): tất cả hàm (`partitionOps`/`buildPartitionCreate`/`buildConvertToPartitioned`/`buildAddPartition`/`addPartitionTemplate`) + arrays `supportsPartitioning`/`canConvertToPartitioned` (`:292,297`). Oracle: `PARTITION BY RANGE\|LIST\|HASH (col)(PARTITION p VALUES LESS THAN(v)/VALUES(v)/…)`, `ADD PARTITION`, INTERVAL partitioning; `partitionOps` = `TRUNCATE/DROP/SPLIT/MERGE PARTITION`.
- `copy/types.ts` (**Copy Table cross-engine** T25): `classifyType` nhận kiểu Oracle (VARCHAR2/NUMBER/CLOB/DATE/TIMESTAMP/RAW…) → family; `mapColumnType`/`mapColumns` case đích `oracle` (map family→VARCHAR2/NUMBER/DATE/CLOB/BLOB); `buildCopyDdl` reuse `genCreate`. Thiếu → copy sang/từ Oracle sinh kiểu sai.
- `testdata/generate.ts` (Generate Test Data T26): `boolLiteral` (`:41-42`) — Oracle không có SQL boolean <23c → `1/0` (default `else 1/0` đã đúng, chỉ cần KHÔNG rơi vào nhánh `postgres` true/false). Còn lại agnostic.

**Chạy được như-là, KHÔNG cần Oracle branch:**
- `scripts.ts` (dialect-agnostic; chỉ cần upstream nhúng `/`), `errors.ts` (chỉ map position — Oracle error normalize là backend), `completion-schema.ts` (no-op, tên schema Oracle không có dấu chấm), `collation.ts` (MySQL-only, Oracle loại đúng), `truncate.ts` (default `TRUNCATE TABLE schema.table` đúng Oracle), `danger.ts` (agnostic), `format/sql.ts` (`highlightSql` cosmetic — tuỳ chọn thêm token VARCHAR2/NUMBER/CLOB/NVL/DUAL/PACKAGE/SEQUENCE).
- `dialect.ts` `quoteIdent`/`qualified` (chỉ cần `EXTRA.oracle.quote='double'`).
- `SqlEditor.svelte` `baseDialect` (`:104-118`): default StandardSQL chạy được; tuỳ chọn nhánh PL/SQL cho highlight tốt hơn.

### 5.7 Hành vi mong đợi per method OracleDriver (tóm tắt dev)

| Method | Lệnh Oracle | Trả về |
|---|---|---|
| `connect` | OCI connect `user/pass@host:port/service` (+role) qua actor thread | `OracleDriver` |
| `test` | connect + `SELECT banner FROM v$version WHERE ROWNUM=1` | `TestResult{ok,latency_ms,server_version}` |
| `ping` | `SELECT 1 FROM dual` | `bool` |
| `schemas` | `ALL_USERS` (lọc SYS/SYSTEM/XDB…) | `Vec<SchemaInfo>` (default=CURRENT_SCHEMA) |
| `databases` | `V$PDBS`/`CDB_PDBS` (CDB) / `V$DATABASE` (non-CDB) | `Vec<DatabaseInfo>{name,current}` |
| `tables` | `ALL_TABLES`+`ALL_VIEWS` (+`DBA_SEGMENTS` size, `NUM_ROWS`) | `Vec<TableInfo>` |
| `columns` | `ALL_TAB_COLUMNS` + PK/FK/identity | `Vec<ColumnInfo>` |
| `indexes` | `ALL_INDEXES`+`ALL_IND_COLUMNS` (fold) | `Vec<IndexInfo>` |
| `constraints` | `ALL_CONSTRAINTS` (P/R/U/C) | `Vec<ConstraintInfo>` |
| `routines`/`functions`/`triggers`/`sequences`/`foreign_keys`/`partitions` | `ALL_PROCEDURES`/`ALL_OBJECTS`/`ALL_TRIGGERS`/`ALL_SEQUENCES`/`ALL_CONSTRAINTS(R)`/`ALL_TAB_PARTITIONS` | các struct tương ứng |
| `exec` | route §3.4 (strip `;`, PL/SQL block, no multi) | `StatementOutcome` |
| `exec_params` | bind `:1` | `StatementOutcome` |
| `apply_changes` | INSERT/UPDATE/DELETE by PK, bind `:1`, COMMIT/ROLLBACK | `u64` |
| `scan_indexes` | `ALL_INDEXES`+usage `V$OBJECT_USAGE`, valid `STATUS` | `Vec<IndexScanRow>` |

### 5.8 Thứ tự triển khai (mỗi bước 1 commit, test xanh mới commit)

1. **O0 — Spike driver + connect/test** ⚠ (rủi ro cao nhất, làm trước để lộ vấn đề sớm — đây là bước quyết định A vs B): thử **B (`oracle-rs`)** trước — `OracleDriver::{connect,test,ping}` async cắm thẳng + `SystemType::Oracle` + `LiveConnection::Oracle` + `oracle_params` + 19 match arm (sequences/databases là arm thật). Chạy **connect/test + 1 SELECT decode vài kiểu (NUMBER/VARCHAR2/DATE/CLOB) trên `gvenzl/oracle-free:23-slim` container thật** → nếu B decode đúng + không bug chặn: chốt B (thắng lớn: async thuần Rust, không Instant Client). Nếu B lỗi type/kết nối → **fallback A** (`oracle` + actor thread §3.2 + Instant Client §3.3). `cargo build --lib` (+feature `oracle`) xanh. Frontend: types + systems + tokens + icon + ConnectionForm + demo tối thiểu. Gate: `npm run check` 0/0, `color-identity.test.ts` cập nhật (SYSTEM_ORDER length, systemMeta('oracle') hết orphan). **Nếu CẢ A lẫn B không khả thi (packaging/bug) → dừng, báo user trước khi tiếp.**
2. **O1 — Explorer + introspection**: 12 method introspection (ALL_* views) + membership sets M1-M6 + folder Sequences/Packages. Integration: seed schema → tree verify (tables/columns/indexes/constraints/sequences/triggers).
3. **O2 — Query editor + exec routing**: routing §3.4 (strip `;`, PL/SQL block, `/` splitter `statements.ts`), decode type §3.5, `NUM_COLOR_SYSTEMS`, dialect selectStarSql/format plsql. Integration: SELECT/DML/DDL/PL block/anonymous block.
4. **O3 — Grid CRUD + filter/paging**: `Placeholder::Colon`, `build_select` OFFSET/FETCH, `exec_params`, `apply_changes`. Integration: insert/update/delete by PK verify; filter+paging.
5. **O4 — Table Designer + Index/FK Manager**: `datatypes`/`table-designer`/`indexes`/`alter`/`create-templates`/`routines` Oracle branches. Integration: CREATE table + ALTER + CREATE INDEX + FK + trigger round-trip (chạy chính xác DDL builder sinh, verify catalog — mẫu AUDIT-7).
6. **O5 — Query Plan + Admin + Autocomplete**: `explain_oracle`+`parse_oracle`+`capability`; `admin_query`/`kill_query` + AdminView; `functions.catalog`/`reserved` Oracle. Integration: EXPLAIN PLAN parse; V$SESSION query.
7. **O6 — Schema Compare + ER + Generate Scripts + Copy + Test Data + Export/Import**: membership M12/M15/M17/M18 + `object_definition`/`index_definition` DBMS_METADATA. Integration: compare→migrate; generate scripts round-trip.
8. **O7 — Partitions** (BẮT BUỘC): `partitions.ts` (mọi hàm) + `partitions()` driver + Table Designer partition tab + `partitionOps` context menu. Integration (mẫu `partitions_integration.rs`): introspect + add + convert.
9. **O8 — Streaming export + Backup + Copy Table + Test Data** (BẮT BUỘC): `stream_export` + arm `export.rs`; `expdp`/`impdp` (`backup.rs`); `copy/types.ts` Oracle; `testdata` bool. Integration: stream 1M rows bounded; backup→restore round-trip (nếu `expdp` khả dụng, else SKIP+note như `pg_pg_dump_if_binary_present`); copy cross-engine type-map (mẫu `sqlite_accepts_copy_mapped_types`).
10. **O9 — Tuỳ chọn (ngoài parity)**: DBMS_OUTPUT capture; cancel server-side (OCI break); PDB switching qua `open_database`; classify_connect_error ORA-* hints; lint rule pack Oracle.

### 5.9 Testing (kỷ luật repo)

- **Unit thuần (không DB)**: decode OCI→JSON (mọi type §3.5), `is_plsql_block`/strip-`;`, `parse_oracle` (PLAN_TABLE→tree), + toàn bộ `sql/*.ts` Oracle branches (dialect/datatypes/ddl/table-designer/indexes/alter/create-templates/routines/statements(`/`)/functions/reserved/partitions) — mẫu `sql/cassandra.test.ts`, `table-designer.test.ts`, `partitions.test.ts`.
- **Vitest/Playwright**: chạy trên demo → thêm DEMO_PROFILES oracle + explain_capability case; Oracle tái dùng mock relational chung (không cần command case mới). e2e: explorer relational + table-designer + editor autocomplete (mẫu spec quan hệ sẵn có).
- **Integration (container Oracle thật)**: dùng **`testcontainers-modules` feature `oracle`** — image mặc định **`gvenzl/oracle-free:23-slim-faststart`** (creds schema `test`/`test`, port 1521). **RÀNG BUỘC QUAN TRỌNG: module này chỉ chạy trên `x86_64 Linux`, KHÔNG chạy trên ARM** (máy dev Windows x86_64 OK; CI Linux x86_64 OK; macOS ARM KHÔNG chạy được integration Oracle). Startup chậm → `with_startup_timeout()` rộng (mặc định 60s không đủ). Có thể override image `gvenzl/oracle-xe:21-slim-faststart` nếu cần XE. Methodology: prebuild `--no-run`, 1-shot `timeout` rộng, ghi log + đọc cùng command, seed→query verify. Bao phủ: connect/tree/introspection/exec/DML by PK/DDL round-trip/explain/admin. **Nếu chọn driver A: máy CI/test cũng cần Instant Client** (thêm rào cản); **nếu chọn B: chỉ cần container** (nhẹ hơn).
- Gate cuối: `npm run check` 0/0, `npm run tokens:check` (0 vi phạm mới), `cargo build --lib` (+feature oracle) + `cargo test --lib`, integration `oracle_*` EXIT=0.

---

## ADDITIVE — Không đụng tính năng/engine sẵn có (BẮT BUỘC)

Nguyên tắc: **chỉ THÊM cho Oracle, KHÔNG đổi hành vi của bất kỳ engine hiện có**. Mọi thay đổi phải rơi vào 1 trong 3 loại; loại 3 là bẫy regression thật, có cách làm additive-safe cụ thể bên dưới.

### Loại 1 — Thêm thuần (an toàn tuyệt đối, engine khác không thấy khác biệt)
- Enum variant mới: `SystemType::Oracle`, `LiveConnection::Oracle`, `Placeholder::Colon`.
- Match arm mới trong `impl LiveConnection` (19 arm §1.1) — thêm nhánh, KHÔNG sửa nhánh engine khác.
- File mới: `drivers/oracle.rs`, `commands`… (không cần), `public/assets/db-oracle.svg`, `tests/oracle_integration.rs`.
- Entry mới trong Record/array: `EXTRA.oracle`, `SYSTEM_ORDER`+oracle, `BY_SYSTEM.oracle` (reserved/functions), `ORACLE_TYPES` + `dataTypes` case, `CATALOGS.oracle`, `DEMO_PROFILES` oracle. **Thêm phần tử KHÔNG xoá/sửa phần tử cũ** → engine khác đọc giá trị y hệt.

### Loại 2 — Thêm nhánh có điều kiện (an toàn NẾU gate đúng)
Chèn `case 'oracle':` / `if (system === 'oracle')` / `SystemType::Oracle =>` **TRƯỚC `default`/`_`, KHÔNG chạm nhánh hoặc `default` hiện có**. Áp cho: `dialect.ts` selectStarSql; `ddl.ts`; `table-designer.ts` (alterColumn/buildTrigger); `indexes.ts` genDropIndex; `alter.ts`; `create-templates.ts`; `routines.ts`; `format.ts` langOf; `partitions.ts`; `datatypes.ts`; `drivers/grid.rs` build_select/Placeholder::of/quote_style; `commands/admin.rs` admin_query/kill_query; `commands/schema.rs` definition_query/index_definition_query; `commands/plan.rs` explain_plan/build_explain/parse_for_system; `drivers/plan.rs` capability/normalize_op; `drivers/backup.rs`. Kiểm: engine khác vẫn khớp nhánh cũ (mảng chỉ dài thêm, `default` không đổi).

### Loại 3 — Sửa CODE DÙNG CHUNG — bẫy regression, làm additive-safe theo đúng cách sau

1. **`reserved.ts` — `SAFE` là Set TOÀN CỤC** (`reserved.ts:118-125`), bị trừ cho **mọi** system trong `reservedSet` (`:132`). Vài từ Oracle reserved thật (`date`,`number`,`comment`,`size`,`level`,`mode`,`role`,`action`…) nằm trong `SAFE`. **TUYỆT ĐỐI KHÔNG xoá chúng khỏi `SAFE`** — sẽ khiến PG/MySQL/MSSQL/… bắt đầu quote các tên này (đổi output autocomplete của mọi engine = regression). **Cách additive-safe**: thêm map riêng `SAFE_OVERRIDE_BY_SYSTEM: Record<string,string[]>` (chỉ có key `oracle`) và trong `reservedSet` sau vòng `for (const w of SAFE) set.delete(w)` (`:132`), thêm: `for (const w of (SAFE_OVERRIDE_BY_SYSTEM[system] ?? [])) set.add(w)`. Chỉ ảnh hưởng `system==='oracle'`; `CACHE` theo từng system (`:127-135`) nên hệ khác không đổi. (Cần thêm `oracle` vào `BY_SYSTEM` để các từ này có mặt trước khi re-add — hoặc re-add trực tiếp.)
2. **`statements.ts` — `splitStatements(doc)` KHÔNG có tham số system** (`statements.ts:18`), dùng chung 3 call site (SqlWorkspace `:549-550,825`, SchemaCompare `:336`). Oracle cần hiểu terminator `/` + block `DECLARE`/`BEGIN`/`PACKAGE`. **Cách additive-safe**: đổi chữ ký thành `splitStatements(doc, system?)` với `system` optional; toàn bộ logic `/`+PL/SQL block **gate trong `if (system === 'oracle')`**; khi `system` undefined/khác → **đi đúng nhánh code cũ, byte-for-byte**. Cập nhật 3 call site truyền `tab.systemType`/target system (additive — trước không truyền gì, giờ truyền; engine khác vào nhánh cũ). Test cũ `errors.test.ts`/`statements.test.ts` gọi `splitStatements(doc)` không tham số → vẫn chạy y hệt (default). **KHÔNG sửa logic dollar-quote/beginDepth/BLOCK_END_KW hiện có** — chỉ thêm nhánh oracle song song.
3. **`drivers/grid.rs` `Placeholder::of(system)`** (`:22-28`, `_ => ?`): thêm `"oracle" => Placeholder::Colon` TRƯỚC `_`. Engine khác vẫn `$n`/`@Pn`/`?`. Thêm variant `Colon` vào enum là additive (arm mới ở mọi `match Placeholder`).
4. **`systems.gen.ts` + `tokens.css` sinh qua `npm run tokens`** (ghi đè NGUYÊN file): sau khi thêm entry `oracle` vào map `SYS` trong `.dc.html` + `EXPECTED_SYSTEMS`, chạy `npm run tokens` rồi **`git diff` PHẢI chỉ thêm block `oracle`/`--sys-oracle-*`, KHÔNG đổi 1 dòng nào của 11 hệ cũ**. Nếu diff chạm hệ khác → đã sửa nhầm prototype HTML, revert. `npm run tokens:check` phải **0 vi phạm mới**.
5. **Rust exhaustive `match system`**: thêm `SystemType::Oracle` làm MỌI match KHÔNG có `_` **không compile** cho tới khi thêm arm → an toàn compile-time (không thể quên). Ngược lại match CÓ `_ =>` sẽ **im lặng nuốt** Oracle vào default của engine khác → phải rà từng match trong bảng §1.1/§1.5/§5.2 để Oracle không dùng nhầm SQL của hệ khác (vd `build_explain` `_ => EXPLAIN {sql}` sai cho Oracle — §4.2).
6. **`color-identity.test.ts` + `EXPECTED_SYSTEMS`**: cập nhật số đếm (SYSTEM_ORDER/SYSTEMS length +1, `systemMeta('oracle')` hết `orphan`). Đây là **fixture test**, không phải feature; assertion của hệ khác giữ nguyên.

### Guard regression (kỷ luật test CLAUDE.md — "không nới assertion")
- **Mọi suite HIỆN CÓ phải xanh KHÔNG ĐỔI**: `npm run check` 0/0; vitest giữ nguyên số cũ + THÊM test Oracle (không giảm/sửa assertion cũ); playwright giữ nguyên spec cũ + thêm spec Oracle; `cargo test --lib` giữ số cũ + thêm; **integration của engine cũ (PG/MySQL/MSSQL/SQLite/CH/Cassandra/…) vẫn EXIT=0**.
- Bất kỳ test cũ nào đổi kết quả = **regression → điều tra, không nới assertion để cho qua** (nguyên tắc CLAUDE.md).
- Membership set (M1–M18): chỉ **append `'oracle'`**, KHÔNG xoá phần tử → điều kiện của engine khác không đổi.
- **KHÔNG** thêm oracle vào bất kỳ nhánh riêng của redis/nats/kafka/cassandra/mongo/clickhouse, và **KHÔNG** vào `schemaIsDatabase`/`schemaNodeIsDatabase`/`dbDefaultSchema`(schema-as-DB) (§5.5 "KHÔNG thêm").

---

## BƯỚC 6 — Rủi ro & điểm dễ "vỡ âm thầm"

1. **Driver Oracle (§3)** — rủi ro #1: blocking + Instant Client + đóng gói. Có thể chặn cả feature nếu packaging bất khả thi trên macOS universal. **Làm O0 trước, dừng nếu kẹt.**
2. **`demo.ts` default case reject** (`:1053`) mọi command chưa mock → Oracle tái dùng mock relational nên OK, NHƯNG `explain_capability` cần case oracle (nếu không toggle EXPLAIN disable). Thêm DEMO_PROFILES oracle.
3. **`color-identity.test.ts`** kỳ vọng `systemMeta('oracle')==='orphan'` + đếm SYSTEM_ORDER/SYSTEMS length → phải cập nhật (giống MongoDB spec §5.5 #16).
4. **Case-folding** (§4.3): nếu introspection trả UPPERCASE mà generator quote lowercase → SQL không khớp bảng. Nhất quán 1 hướng.
5. **Splitter `/`** (`statements.ts`): thiếu → mọi CREATE PROCEDURE/PACKAGE/TRIGGER/anonymous block bị cắt sai `;` → PL/SQL lỗi khắp nơi. Đây là gap frontend nguy hiểm nhất.
6. **`ON UPDATE` FK** + **`IF EXISTS`** + **`LIMIT`**: 3 cú pháp phổ biến KHÔNG hợp lệ Oracle — rơi default là SQL sai (không crash, nhưng chạy lỗi ở DB thật). Playwright chạy demo KHÔNG bắt được → **phải integration test container thật** (bài học AUDIT-11).
7. **Kill session sid,serial#** — signature `pid` đơn không đủ; cần quyết định threading.
8. **panic=abort**: driver không được panic; decode phòng thủ.

---

## Phụ lục — Quyết định cần user CHỐT (tóm tắt)

| # | Quyết định | Khuyến nghị |
|---|---|---|
| 1 | **Crate driver** (§3.1) | ✅ **CHỐT B = `oracle-rs` 0.1.7** — O0 spike đã verify trên Oracle 23 Free container thật: `cargo build --lib` EXIT=0 (pure Rust, KHÔNG Instant Client, KHÔNG actor thread — Connection async cắm thẳng vào LiveConnection); connect + CREATE + INSERT(affected=1) + decode động (NUMBER full-precision→string, VARCHAR2, DATE→ISO) + FETCH FIRST đều chạy. Test: `src-tauri/tests/oracle_o0.rs` (`#[ignore]`, chạy với container). |
| 2 | (Chỉ nếu A) blocking→async (§3.2) + đóng gói Instant Client (§3.3) | Actor thread/connection; yêu cầu cài + phát hiện runtime; feature-gate `oracle`. (Chọn B → cả hai không cần) |
| 3 | Field ConnectionProfile (§5.4) | (B) thêm field oracle_service/sid/tns/connect_kind/role |
| 4 | Case-folding identifier (§4.3) | Quote qua `quoteIdent` sẵn có, hiển thị UPPERCASE |
| 5 | Phạm vi Partition (§2.F, O7) | **BẮT BUỘC làm đầy đủ** (parity PG/MySQL/MSSQL) |
| 6 | Backup server-side vs client (§2.H) | **BẮT BUỘC** `expdp`/`impdp` (server-side DIRECTORY); UI nói rõ dump ở máy chủ |
| 7 | DBMS_OUTPUT (§3.4 #5) | Bỏ qua v1, ghi backlog |
| 8 | Kill session key (§4.4) | Encode `sid,serial#` vào pid phía frontend |

*(Mọi `file:line` lấy từ mã nguồn hiện tại. Đây là spec, KHÔNG có code — theo yêu cầu.)*

### Nguồn đã research (chốt version/đóng gói)

- **`oracle` crate** — publish crates.io mới nhất **0.6.3** (2025-01-02, ~2.14M downloads); GitHub master ở **`0.7.0-dev`** nhưng **chưa publish** (trang Releases trống → muốn 0.7 phải pin git rev). Blocking, cần Oracle client 11.2+ (Instant Client) runtime + C compiler build: [crates.io](https://crates.io/crates/oracle) · [docs.rs README 0.6.3](https://docs.rs/crate/oracle/latest/source/README.md) · [github kubo/rust-oracle](https://github.com/kubo/rust-oracle)
- **`oracle-rs` crate 0.1.7** (2026-03-24, ~5.8k downloads, ~20★, pre-1.0), thuần Rust + Tokio async, KHÔNG cần OCI/Instant Client, Oracle 12c+: [github stiang/oracle-rs](https://github.com/stiang/oracle-rs)
- **Integration container**: `testcontainers-modules` feature `oracle`, image mặc định `gvenzl/oracle-free:23-slim-faststart`, **chỉ x86_64 Linux (không ARM)**: [docs.rs testcontainers-modules oracle](https://docs.rs/testcontainers-modules/latest/testcontainers_modules/oracle/free/struct.Oracle.html) · [gvenzl/oracle-xe Docker Hub](https://hub.docker.com/r/gvenzl/oracle-xe)
- **Icon/brand Oracle**: logo chính thức = **wordmark "ORACLE"** (không có glyph 1 chữ); màu **Oracle Red** — `#C74634` (Redwood, brand hiện hành) hoặc `#F80000` (đỏ logo cổ điển, `simple-icons` dùng). Nguồn SVG open-source CSP-safe: [simple-icons `oracle`](https://github.com/simple-icons/simple-icons) (glyph = wordmark, monochrome path) · màu: [usbrandcolors — Oracle](https://usbrandcolors.com/oracle-colors/) · [chromacreator — Oracle #C74634/#FF0000](https://chromacreator.com/brands/oracle) · [Oracle Brand Guidelines PDF](https://www.oracle.com/a/ocom/docs/oracle-brand-guidelines.pdf).
- **Còn [CẦN XÁC MINH] khi implement**: tên feature TLS/chrono chính xác của crate đã chọn; dialect Oracle trong `sqlparser` 0.53 (lint); trạng thái Instant Client arm64/macOS (chỉ nếu chọn A).
