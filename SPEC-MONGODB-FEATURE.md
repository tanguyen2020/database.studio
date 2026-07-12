# SPEC — Thêm MongoDB làm engine mới (feature parity đầy đủ)

> Trạng thái: DRAFT để review. Branch: `feat/mongodb-engine`.
> Mục tiêu: MongoDB (document DB, NoSQL) đạt **đầy đủ** mọi tính năng mà 10 engine hiện có đang có, không sót.
> Quy tắc: chỉ ghi nhận tính năng THỰC SỰ tồn tại trong code (kèm `file:line`); không đề xuất tính năng mới ngoài phạm vi parity; chỗ chưa chắc đánh dấu **[CẦN XÁC MINH]**.

---

## 0. Tóm tắt điều hành + quyết định kiến trúc đã chốt (đề xuất)

### 0.1 Lớp trừu tượng thực tế

Codebase **KHÔNG dùng `trait DatabaseDriver`**. Lớp trừu tượng là **enum `LiveConnection`** (`src-tauri/src/drivers/mod.rs:42-52`), mỗi engine là một biến thể ôm một struct driver riêng (`PgDriver`, `CassandraDriver`, …). "Interface" mà mọi engine phải tuân theo = tập hợp **match arms** trong các method của `impl LiveConnection` (`drivers/mod.rs:212-570`). Thêm engine = thêm 1 biến thể + thêm 1 nhánh vào **từng** match arm + 1 struct driver mới + 1 `<system>_params()` builder.

Frontend: mọi lời gọi backend đi qua `src/lib/ipc.ts` (typed wrappers), `invoke()` tự chuyển sang `demoInvoke` (mock) khi ngoài Tauri (`ipc.ts:8-9`) — nên **mọi command mới bắt buộc có `case` trong `src/lib/demo.ts`** nếu không Vitest/Playwright vỡ (`demo.ts:1016-1017` default → reject).

### 0.2 Quyết định kiến trúc (theo precedent Cassandra, KHÔNG theo relational)

MongoDB là document DB, giống Cassandra ở chỗ **không phải SQL**: không JOIN kiểu SQL (dùng `$lookup`), không `ALTER TABLE`, transaction chỉ trên replica set, kiểu BSON riêng (ObjectId/Decimal128/Binary/Date), document shape không đều.

→ **MongoDB đi theo đúng khuôn Cassandra** (engine non-SQL đã hoàn thiện trong repo):

| Khía cạnh | Cassandra (precedent) | MongoDB (áp dụng) |
|---|---|---|
| Editor chạy qua command riêng, KHÔNG `exec_statement` chung | `cql_exec` (`commands/cassandra.rs:34`) trả `CqlExecResponse{ok,result,error,duration_ms,next_page,warnings}` | `mongo_exec` trả cấu trúc tương tự (thêm cursor token) |
| Explorer riêng, KHÔNG mở SQL tab khi connect | `ConnectionList.svelte:98` cassandra mở CQL editor | MongoDB: connect → chỉ nạp cây database/collection vào sidebar, click collection mới mở tab (giống Redis/Kafka `ConnectionList.svelte:92,96`) |
| Introspection quan hệ trả rỗng, dùng command chuyên biệt | `schemas/tables/columns/...` → `Ok(Vec::new())` (`mod.rs:392,417,431,...`), thay bằng `cassandra_tree` | Tương tự: dùng command `mongo_databases`/`mongo_collections`/`mongo_collection_fields` |
| Tab viewer riêng, editable qua full key | `cassandra-table` + `CassandraTableView.svelte`, edit qua full PK (`apply_grid` `cassandra.rs:851`) | `mongo-collection` + `MongoCollectionView.svelte`, edit qua `_id` |
| Query Plan qua cơ chế riêng | `trace_cql` → `parse_cassandra_trace`, mode `tracing` (`plan.rs:911`) | `.explain()` → `parse_mongodb`, mode `estimated`/`actual` (giống PG, **không** dùng `tracing`) |
| Kiểu dữ liệu phi-JSON → chuỗi | `cql_to_json` (`cassandra.rs:391`) uuid→string, blob→`0x..` | BSON → **MongoDB Extended JSON** (ObjectId→`{"$oid":...}` hoặc string, Date→ISO, Decimal128→string) |

**Điểm khác Cassandra**: result set MongoDB **hoàn toàn động** — document mỗi cái một shape, không có metadata cột như ClickHouse (`meta[]`) hay type-per-column như CQL. Do đó driver Mongo phải **tự suy `cols`** bằng cách hợp nhất (union) các key qua các document trả về (giữ thứ tự xuất hiện), type để `"object"`/`"document"`/suy theo giá trị. Đây là điểm mới duy nhất về mặt xử lý dữ liệu; đích đến vẫn là `QueryResultSet { cols, rows: Vec<Value>, total }` (`drivers/types.rs:58-62`).

### 0.3 Ngôn ngữ truy vấn của Query Editor — **[QUYẾT ĐỊNH CẦN USER CHỐT]**

Cassandra truyền chuỗi CQL thô qua `exec_cql`. MongoDB không có "một chuỗi SQL". Hai lựa chọn khả dĩ (xem §4.3 để phân tích), cần chốt trước khi code:

- **(A) mongosh-style string** — người dùng gõ `db.users.find({ age: { $gt: 18 } }).limit(50)`. Cần parser nhỏ trong Rust tách `collection` + `method` + đối số JSON/Extended-JSON. Trực quan với người quen MongoDB (giống Compass/Studio3T). Chi phí: viết parser subset.
- **(B) JSON spec có cấu trúc** — editor gửi `{ "collection": "...", "op": "find", "filter": {...}, "sort": {...}, "limit": 50 }`. Không cần parser, an toàn hơn, nhưng kém tự nhiên hơn.

Spec dưới đây viết cho **(A)** (đúng tinh thần "editor gõ truy vấn tự do" của Cassandra), với subset tối thiểu `find/aggregate/countDocuments/distinct/insertOne/insertMany/updateOne/updateMany/deleteOne/deleteMany`. Nếu user chọn (B), chỉ đổi tầng parse trong `mongo_exec`, phần còn lại giữ nguyên.

---

## BƯỚC 1 — Lớp trừu tượng (abstraction layer)

### 1.1 Backend Rust — `impl LiveConnection` (interface de-facto)

Mọi method dưới đây MongoDB phải thêm 1 nhánh. `file:line` là vị trí match arm hiện tại.

| # | Method | Signature (rút gọn) | Vị trí match | MongoDB làm gì |
|---|---|---|---|---|
| 1 | `connect` | `async fn connect(profile, endpoint, password) -> Result<Self, QueryError>` | `mod.rs:213-255` | `Self::Mongo(MongoDriver::connect(&mongo_params(...)).await?)` |
| 2 | `test` | `async fn test(profile, endpoint, password) -> TestResult` | `mod.rs:257-286` | `MongoDriver::test(...)` |
| 3 | `exec` | `fn exec<'a>(&'a mut self, sql) -> BoxFuture<Result<StatementOutcome>>` | `mod.rs:291-308` | `Box::pin(async move { d.exec_mongo(sql, None, None).await.map(|o| o.outcome) })` (giống nhánh Cassandra `:306`) |
| 4 | `ping` | `async fn ping(&mut self) -> bool` | `mod.rs:310-322` | `d.ping().await` |
| 5 | `exec_params` | `async fn exec_params(&mut self, sql, params) -> Result<StatementOutcome>` | `mod.rs:326-352` | Trả `Err(...)` "Filter builder does not support MongoDB — use the query editor" (giống Cassandra `:346`, ClickHouse `:336`) |
| 6 | `apply_grid_changes` | `async fn apply_grid_changes(&mut self, changes) -> Result<u64>` | `mod.rs:356-377` | `d.apply_grid(changes).await` (insert/update/delete document theo `_id`) — giống Cassandra `:375` |
| 7 | `schemas` | `async fn schemas(&mut self) -> Result<Vec<SchemaInfo>>` | `mod.rs:381-394` | `Ok(Vec::new())` — cây lấy qua `mongo_databases`/`mongo_tree` (giống Cassandra `:392`) **hoặc** trả databases nếu chọn hybrid (xem §4.1) |
| 8 | `databases` | `async fn databases(&mut self) -> Result<Vec<DatabaseInfo>>` | `mod.rs:399-405` | `d.databases().await` (Mongo có nhiều DB/server — nên implement, đánh dấu `current`) |
| 9 | `tables` | `async fn tables(&mut self, schema) -> Result<Vec<TableInfo>>` | `mod.rs:407-419` | `Ok(Vec::new())` (dùng `mongo_collections`) — hoặc trả collections nếu hybrid |
| 10 | `columns` | `async fn columns(&mut self, schema, table) -> Result<Vec<ColumnInfo>>` | `mod.rs:421-433` | `Ok(Vec::new())` (field suy qua sampling, dùng `mongo_collection_fields`) |
| 11 | `indexes` | `async fn indexes(&mut self, schema, table) -> Result<Vec<IndexInfo>>` | `mod.rs:435-447` | `d.indexes(db, coll).await` (Mongo `listIndexes` — CÓ index thật) |
| 12 | `constraints` | `async fn constraints(&mut self, schema, table) -> Result<Vec<ConstraintInfo>>` | `mod.rs:449-462` | `Ok(Vec::new())` (Mongo không có FK/CHECK/UNIQUE constraint kiểu SQL; unique là thuộc tính index) |
| 13 | `routines` | `async fn routines(&mut self, schema) -> Result<Vec<RoutineInfo>>` | `mod.rs:464-476` | `Ok(Vec::new())` (không có stored proc/function) |
| 14 | `triggers` | `async fn triggers(&mut self, schema) -> Result<Vec<TriggerInfo>>` | `mod.rs:478-490` | `Ok(Vec::new())` (change streams ≠ trigger; ngoài parity) |
| 15 | `sequences` | `async fn sequences(&mut self, schema) -> Result<Vec<SequenceInfo>>` | `mod.rs:492-498` | Rơi vào `_ => Ok(Vec::new())` (đã sẵn) — **không cần thêm nhánh** |
| 16 | `foreign_keys` | `async fn foreign_keys(&mut self, schema) -> Result<Vec<ForeignKey>>` | `mod.rs:501-509` | Rơi vào `_ => Ok(Vec::new())` — **không cần thêm nhánh** |
| 17 | `partitions` | `async fn partitions(&mut self, schema, table) -> Result<Vec<PartitionInfo>>` | `mod.rs:513-529` | `Self::Mongo(_) => Ok(Vec::new())` (Mongo sharding ≠ partition declarative; ngoài parity core) |
| 18 | `scan_indexes` | `async fn scan_indexes(&mut self, schema) -> Result<IndexScanResult>` | `mod.rs:532-569` | `("mongodb", d.scan_indexes(db).await?, Vec::new())` (Index Scanner — Mongo `$indexStats`) |

Ngoài ra thêm biến thể enum: `LiveConnection::Mongo(MongoDriver)` (`mod.rs:42-52`) + hàm builder `fn mongo_params(p, ep, password) -> MongoConnParams` (mẫu `cassandra_params` `mod.rs:182-210`).

Struct driver phải theo khuôn (mẫu `PgDriver` `postgres.rs:12-14`, `CassandraDriver` `cassandra.rs:50-53`): giữ client + database mặc định, các method `connect/test/ping/exec_mongo/...` trả `StatementOutcome`/`QueryResultSet` đã khóa (`types.rs:57-74`).

### 1.2 `SystemType` + profile (bắt buộc, nếu thiếu không build được)

| File | Sửa | Vị trí |
|---|---|---|
| `drivers/types.rs` | Thêm biến thể `Mongodb` vào enum `SystemType` + `as_str()` → `"mongodb"` | `types.rs:10-21`, `:24-37` |
| `drivers/types.rs` | `is_phase1_sql()` — **KHÔNG** thêm mongodb (Mongo không phải SQL) | `types.rs:40-49` |
| `connections/profile.rs` | `default_port(Mongodb) => 27017` | `profile.rs:101-113` |
| `connections/profile.rs` | (tuỳ) thêm field mới cho Mongo — xem §5.4 | `profile.rs:51-98` |

### 1.3 Frontend contract — `ipc.ts` + types

- `src/lib/ipc.ts`: thêm wrapper typed cho mọi command `mongo_*` (mẫu Cassandra `ipc.ts:468-486`, Redis `:64-142`).
- `src/lib/types.ts`: `SystemType` += `'mongodb'` (`types.ts:5-15`); `TabContentType` += `'mongo-collection'` (và tuỳ `'mongo'` cho workspace tổng) (`types.ts:205-228`).
- Hợp đồng exec khóa cứng: `{ ok, result?: { cols:[[name,type]], rows, total }, error?, duration_ms }` (`types.rs:56`, `types.ts:100-106`). MongoDB tái dùng nguyên.

### 1.4 Danh sách engine hiện có + file implement

| SystemType | Driver struct | File |
|---|---|---|
| postgres | `PgDriver` | `drivers/postgres.rs` |
| mysql / mariadb | `MySqlDriver` | `drivers/mysql.rs` |
| mssql | `MssqlDriver` | `drivers/mssql.rs` |
| sqlite | `SqliteDriver` | `drivers/sqlite.rs` |
| clickhouse | `ChDriver` | `drivers/clickhouse.rs` |
| cassandra | `CassandraDriver` | `drivers/cassandra.rs` |
| redis | `RedisDriver` | `drivers/redis.rs` |
| kafka | `KafkaDriver` | `drivers/kafka.rs` |
| nats | `NatsDriver` | `drivers/nats.rs` |
| **mongodb (mới)** | `MongoDriver` | `drivers/mongo.rs` *(tạo mới)* |

Đăng ký command: `invoke_handler![...]` trong `src-tauri/src/lib.rs:35-179` (mỗi command mới phải thêm 1 dòng — "một command là dead cho tới khi thêm vào đây").

---

## BƯỚC 2 — Ma trận tính năng (feature matrix)

Ký hiệu: **✓** = có/áp dụng được; **✗** = không có (kể cả với engine hiện tại); **N/A** = khái niệm không tồn tại ở engine đó; **≈** = có nhưng khác (ghi rõ). Cột engine hiện có gộp nhóm để gọn; ô có `file:line` là điểm gate/impl thật.

### A. Connection

| Tính năng | PG/MySQL/MSSQL/SQLite | ClickHouse | Cassandra | Redis/Kafka/NATS | **MongoDB (mới)** | Gate/impl |
|---|---|---|---|---|---|---|
| Connection string / host+port | ✓ | ✓ | ✓ (contact points, phẩy) | ✓ | ✓ (URI `mongodb://` hoặc host+port; SRV `mongodb+srv` [CẦN XÁC MINH]) | `ConnectionForm.svelte:49-64` |
| Auth user/password | ✓ | ✓ | ✓ | ✓ (kafka SASL, nats user/pass) | ✓ (SCRAM; authSource) | `profile.rs:62-63` |
| SSL/TLS (CA/cert/key) | ✓ (mTLS) | ✓ (ssl bool) | ✓ (CA, accept-any) | ✓ (redis rediss) | ✓ (rustls; `tls`/`tlsCAFile`) | `mod.rs:54-104,182-210`; `postgres.rs:37-53` |
| SSH tunnel | ✓ | ✓ | ✓ (`ForceTranslator`) | ✓ | ✓ (tự động qua registry, replica-set advertise cần cân nhắc translator) | `registry.rs:79-139`; `cassandra.rs:126-136` |
| Pooling | ≈ 1-conn/profile (Mutex) | ≈ HTTP client | ≈ scylla session | ≈ | ≈ dùng `mongodb::Client` (nội bộ pool) nhưng vẫn giữ 1 entry/profile | `registry.rs:17-32`; T21 CLAUDE.md |
| Timeout | ✓ (`connect_timeout`=10s bounded) | ✓ | ✓ | ✓ | ✓ (`connectTimeout`/`serverSelectionTimeout`) | T10 `run_test_bounded` `connections.rs:332` |
| Test connection (+cancel) | ✓ | ✓ | ✓ | ✓ | ✓ (`test` → `hello`/`ping` command, server_version từ `buildInfo`) | `mod.rs:257-286`; `connections.rs:401-422` |
| Quản lý nhiều connection | ✓ | ✓ | ✓ | ✓ | ✓ (tự động qua registry) | `registry.rs` |
| Nhiều database/server | ✓ (PG/MSSQL `databases()`) ; MySQL schema=db | ≈ | ≈ keyspaces | N/A | ✓ (`databases()` + `attach_database`) | `mod.rs:399-405`; `connections.rs:220-239` |

### B. Schema/Catalog browsing (Object Explorer)

| Tính năng | Relational | ClickHouse | Cassandra | **MongoDB** | Impl/precedent |
|---|---|---|---|---|---|
| List databases | ✓ | ≈ | ✓ (keyspaces) | ✓ (`mongo_databases`) | `mod.rs:399`; Cassandra `commands/cassandra.rs:86` |
| List schemas | ✓ | ✓ | N/A | ≈ (Mongo không có schema giữa db↔collection; db đóng vai schema) | `mod.rs:381` |
| List tables/collections | ✓ | ✓ | ✓ (`cassandra_tree`) | ✓ (`mongo_collections`) | precedent `cassandra_tree` `cassandra.rs:656` |
| Columns/Fields | ✓ (introspect) | ✓ | ✓ (`columns_public`) | ≈ (suy qua **sampling N documents**, union keys) | precedent `cassandra.columns_of` `cassandra.rs:589` |
| Views | ✓ | ✓ (MV) | ✓ (MV) | ≈ (Mongo có "view" tạo từ pipeline + collection type `view`) | `TableInfo.kind` `types.rs:161` |
| Indexes | ✓ | ≈ skip-index | ✓ (secondary) | ✓ (`listIndexes` → `IndexInfo`) | `mod.rs:435` |
| Keys/relationships | ✓ (PK/FK, ER) | ✗ | ≈ (partition key) | N/A (không FK; `_id` là PK ngầm) | `mod.rs:501` |
| Row/doc count + size | ✓ (`row_estimate`,`data_length`) | ✓ | ≈ | ✓ (`collStats`: `count`,`size`,`storageSize`) | `TableInfo` `types.rs:157-174`; Objects tab CLAUDE.md |
| Refresh (rule chung) | ✓ | ✓ | ✓ (`loadCass`) | ✓ (nhánh mới trong `refreshConnection`) | `ObjectExplorer.svelte:427-446` |
| Show Definition/DDL | ✓ (`object_definition`) | ✓ | ✓ (`object_ddl` dựng lại) | ≈ (collection: `db.createCollection` + options; index: `createIndex`; view: pipeline) | `schema.rs:303-355`; Cassandra `object_ddl` `cassandra.rs:870` |

### C. Query execution

| Tính năng | Relational | ClickHouse | Cassandra | **MongoDB** | Impl/precedent |
|---|---|---|---|---|---|
| Chạy query | ✓ (`exec_statement`) | ✓ | ✓ (`cql_exec`) | ✓ (`mongo_exec`) | `commands/query.rs:14`; `commands/cassandra.rs:34` |
| Nhiều statement | ✓ (split client-side) | ✓ | ✓ | ≈ (Mongo: 1 lệnh/lần; split theo dòng/`;` [CẦN XÁC MINH]) | `commands/query.rs:3-5` |
| Cancel query | ✓ (abort+poison+heal) | ✓ | ✓ | ≈ (abort task tự động; hủy server-side cần `killOp` — tuỳ chọn) | `registry.rs:195-249` |
| Transaction | ≈ (đã gỡ nút BEGIN/COMMIT — AUDIT-2 #6) | ✗ | ✗ | ✗ (chỉ replica set; ngoài parity vì UI đã bỏ) | CLAUDE.md AUDIT-2 |
| Prepared/parametrized | ✓ (`exec_params`) | ✗ (literal) | ≈ | ✗ (filter builder tắt; filter qua BSON trong `mongo_exec`) | `mod.rs:326-352` |
| Paging kết quả lớn | ✓ (LIMIT/OFFSET) | ✓ | ✓ (`PagingState` token) | ✓ (cursor `batchSize`/`skip`+`limit` → token, giống `CqlOutcome.next_page`) | `cassandra.rs:57-63,337-345` |
| Warnings không-fatal | ✓ (lint) | ✓ | ✓ (`warnings`) | ≈ (Mongo `writeConcernError`/deprecation) | `results.svelte.ts:236-241` |
| Consistency/Read pref | N/A | N/A | ✓ (dropdown) | ≈ (readPreference/readConcern dropdown — theo mẫu Cassandra consistency) | `SqlWorkspace.svelte:790-801` |

### D. Result handling (grid)

| Tính năng | Mọi engine (độc lập system) | **MongoDB** | Impl |
|---|---|---|---|
| Grid hiển thị cột động | ✓ | ✓ (cols = union keys documents) | `ResultGrid.svelte:382-419` |
| Pagination client-side + page size | ✓ | ✓ (tái dùng) | `grid/paging.ts`; `ResultGrid.svelte:426-440` |
| Group-by popover | ✓ | ✓ (tái dùng, client-side) | `grid/groupby.ts` |
| Sorting / filtering | ✓ | ✓ (client-side) ; server-side filter qua editor | `ResultGrid.svelte` |
| Kiểu dữ liệu / NULL | ✓ (NULL badge) | ✓ (Extended JSON string) | `ResultGrid.svelte:524-536,926-932` |
| Object/nested/JSON trong cell | ✓ (badge `{ }` + modal) | ✓ (tái dùng `highlightJson`) | `ResultGrid.svelte:933-943`; `format/json.ts:15-60` |
| BLOB/binary | ≈ (chưa xử lý riêng, `JSON.stringify`) | ≈ (BSON `Binary` → base64/`$binary` string ở backend) | `ResultGrid.svelte:524`; **gap chung** |
| Copy đa định dạng | ✓ (tsv/csv/json/sql-insert/update/markdown) | ≈ (sql-insert/update = **mongo insert/update** hoặc ẩn) | `export/clipboard.ts` |
| Chart view (PNG/SVG) | ✓ | ✓ (tái dùng) | `ResultChart` |
| No. gutter + keyboard nav + multi-select | ✓ | ✓ (tái dùng) | `ResultGrid.svelte` AUDIT-5 |

### E. CRUD trực tiếp trên dữ liệu

| Tính năng | Relational | ClickHouse | Cassandra | **MongoDB** | Impl/precedent |
|---|---|---|---|---|---|
| Insert/Update/Delete row/document | ✓ (transaction) | ≈ (sinh mutation async) | ✓ (CQL by full PK) | ✓ (by `_id`: `insertOne`/`updateOne`/`deleteOne`) | `mod.rs:356-377`; `cassandra.apply_grid` `cassandra.rs:851` |
| Edit inline (grid) | ✓ (Execute/Reset/Cancel) | ≈ (Generate mutation) | ✓ | ✓ (theo mẫu Cassandra: full-doc replace hoặc `$set`) | `ResultGrid.svelte:356-369` |
| Preview diff trước apply | ✓ (`preview_grid_changes`) | ✓ | ≈ | ≈ (preview shell command `updateOne(...)`) | `commands/grid.rs:12`; **cần nhánh mongo trong `grid::preview_sql`** `drivers/grid.rs:178` |
| Bulk operation | ✓ (batched INSERT) | ✓ | ✓ | ✓ (`insertMany`/`bulkWrite`) | Import wizard |

### F. DDL (create/alter/drop)

| Tính năng | Relational | ClickHouse | Cassandra | **MongoDB** | Impl/precedent |
|---|---|---|---|---|---|
| Create table/collection | ✓ (Table Designer) | ✓ (MV/Dict dialog) | ✓ (CQL template) | ≈ (`createCollection` + options: capped/validator) | `TableDesigner.svelte`; `ClickHouseCreateDialog.svelte`; Cassandra `sql/cassandra.ts:23` |
| Alter table | ✓ (ADD/DROP col…) | ≈ | ≈ (mở DDL sửa tay) | ✗ (Mongo không có schema cố định → không có ALTER; đổi validator qua `collMod`) | AUDIT-9 `sql/alter.ts` |
| Drop table/collection | ✓ | ✓ | ✓ (confirm) | ✓ (`drop()` + confirm in-app) | `ObjectExplorer` cassDrop `:939` |
| Create/Drop index | ✓ (Index Manager) | ≈ | ✓ | ✓ (`createIndex`/`dropIndex`) | `IndexManager.svelte`; `sql/indexes.ts` |
| Create view | ✓ | ✓ (MV) | ✓ (MV) | ≈ (`createView` từ pipeline) | `sql/create-templates.ts` |
| Đổi schema | ✓ | ✓ | ✓ | N/A (schemaless; validator là gần nhất) | — |
| Truncate | ✓ | ✓ | ✓ | ≈ (`deleteMany({})` hoặc `drop`+recreate) | TableContextMenu `:205-210` |

### G. Query Plan (EXPLAIN) — xem chi tiết ở BƯỚC 4.2

| | PG/MySQL/MariaDB/MSSQL | SQLite/ClickHouse | Cassandra | Redis/Kafka/NATS | **MongoDB** |
|---|---|---|---|---|---|
| has_planner | ✓ | ✓ | ✗ | ✗ | ✓ |
| supports_actual | ✓ (Analyze) | ✗ | ✓ (Tracing) | ✗ | ✓ (executionStats) |
| mode | estimated/actual | estimated | tracing | not_applicable | **estimated/actual** |
| Lệnh | EXPLAIN [ANALYZE] | EXPLAIN QUERY PLAN / EXPLAIN indexes=1 | TRACING | — | `.explain("queryPlanner"/"executionStats")` |
| Impl | `plan.rs:143-148` | `:148-149` | `:151` | `:153` | **thêm arm `capability("mongodb")`** |

### H. Import/Export

| Tính năng | Relational | ClickHouse | Cassandra | **MongoDB** | Impl |
|---|---|---|---|---|---|
| Import CSV/JSON (wizard) | ✓ | ✓ (forced batch) | ≈ | ✓ (CSV/JSON → `insertMany`; on-conflict = `upsert` theo `_id`) | `ImportDialog`; `import/plan.ts` |
| Export CSV/JSON/SQL/Excel (wizard) | ✓ | ✓ | ≈ | ✓ (CSV/JSON = tự nhiên; "SQL" → mongo insert script hoặc ẩn) | `ExportDialog`; `export/query.ts` |
| Streaming export (bounded RAM) | ✓ (chỉ PG) | ✓ | ✗ | ≈ (cursor stream — thêm `LiveConnection::Mongo` arm `export.rs:39-58`) | `commands/export.rs:16-68` |
| SQL dump (Generate Scripts) | ✓ | ✓ | ≈ | ≈ (mongodump-style JS / `insertMany` array) | `GenerateScriptsDialog`; `sql/scripts.ts` |
| Backup/Restore | ✓ (pg_dump/mysqldump/…) | ✓ | ✗ | ✓ (`mongodump`/`mongorestore`) | `backup.rs:6-57` **cần nhánh mongo** |
| Copy Table to… (cross-conn) | ✓ | ✓ | ≈ | ≈ (copy collection→collection; type-map [CẦN XÁC MINH]) | `CopyTableDialog`; `copy/types.ts` |
| Generate Test Data | ✓ | ✓ | ≈ | ≈ (sinh documents theo field sampled) | `GenerateTestDataDialog`; `testdata/generate.ts` |

### I. Metadata / thống kê / capability

| Tính năng | Relational | Cassandra | **MongoDB** | Impl |
|---|---|---|---|---|
| Engine version | ✓ (`SELECT version()`) | ✓ (release_version) | ✓ (`buildInfo.version`) | `test()` `postgres.rs:65` |
| Row/doc count + on-disk size | ✓ | ≈ | ✓ (`collStats`) | `TableInfo.data_length` `types.rs:170-173` |
| Capability detection (EXPLAIN) | ✓ | ✓ | ✓ | `explain_capability` `plan.rs:84` |
| Admin views (Sessions/Locks/Users) | ✓ (system views) | ≈ | ≈ (`currentOp`/`serverStatus`/`db.getUsers()` — đường riêng như Redis `admin.rs:153`) | `commands/admin.rs:34-138` |
| Kill session | ✓ | ✗ | ≈ (`db.killOp(opid)` — đường riêng) | `admin.rs:130-138` |
| Index Scanner (health) | ✓ | ≈ | ✓ (`$indexStats` unused; missing-index từ COLLSCAN) | `mod.rs:532`; `IndexScanner.svelte` |

### J. Error handling / logging / editor

| Tính năng | Mọi engine | **MongoDB** | Impl |
|---|---|---|---|
| Error chuẩn hóa (`QueryError{system,message,hint,raw,...}`) | ✓ | ✓ (map từ `mongodb::error::Error`) | `error.rs`; `types.ts:88-98` |
| Toast + View raw error | ✓ | ✓ (tái dùng) | `results.svelte.ts` |
| SQL lint (parse-only) | ✓ (sqlparser) | ≈ (Mongo không SQL → lint rỗng) | `commands/lint.rs:5-7` |
| Autocomplete | ✓ (keyword+column+reserved quoting) | ≈ (gợi ý collection/field + operator `$gt`,`$match`… — mới, [CẦN XÁC MINH] phạm vi) | `SqlEditor.svelte`; `sql/reserved.ts`,`functions.ts` |
| Shortcuts (Ctrl+Enter chạy, Ctrl+S save…) | ✓ | ✓ (tái dùng) | `keys/shortcuts.ts` |
| Query history + snippets | ✓ | ✓ (tái dùng, storage-only) | `commands/library.rs` |

---

## BƯỚC 3 — Pattern của các engine "khác biệt nhất" (để Mongo bắt chước)

### 3.1 Cassandra — khuôn chính cho MongoDB

- **Introspection quan hệ trả rỗng**, thay bằng 1 command dựng cả cây: `cassandra_tree` (`commands/cassandra.rs:105` → `keyspace_tree` `cassandra.rs:656`). Mongo: `mongo_tree(db)` trả collections+views+indexes trong 1 call, cache lazy per-db ở frontend (`ObjectExplorer.svelte:363-392` `cassKeyspaces`/`cassTrees`).
- **Editor riêng + paging token + warnings**: `CqlOutcome{outcome, next_page, warnings}` (`cassandra.rs:57-63`); command `cql_exec` (`commands/cassandra.rs:34-83`) → FE `results.run` nhánh `system==='cassandra'` gọi `ipc.cqlExec` thay `execStatement` (`results.svelte.ts:184-205`), `fetchMoreCql` cho trang kế (`:336-358`). Mongo sao chép: `MongoOutcome{outcome, next_cursor, warnings}` + `mongo_exec` + nhánh `system==='mongodb'`.
- **Editable grid không transaction**: `apply_grid` chạy tuần tự `cql_change_sql` per change (`cassandra.rs:851-865,1056-1090`), WHERE = full PK. Mongo: `apply_grid` → `updateOne({_id}, {$set})` / `insertOne` / `deleteOne({_id})`.
- **Kiểu phi-JSON → chuỗi**: `cql_to_json` (`cassandra.rs:391-445`). Mongo: `bson_to_json` (ObjectId/Date/Decimal128/Binary/Timestamp/RegExp → Extended JSON).
- **DDL viewer dựng lại từ metadata** (không `SHOW`): `object_ddl` (`cassandra.rs:870-977`). Mongo: dựng `db.createCollection(...)`, `db.coll.createIndex(...)` từ `listCollections`/`listIndexes`.
- **Query Plan qua cơ chế phi-EXPLAIN**: `trace_cql` → `parse_cassandra_trace`, mode `tracing` (`plan.rs:911`). Mongo KHÁC: dùng `.explain()` có cây `winningPlan` tĩnh → theo PG/MSSQL (xem §4.2).
- **Tab riêng**: `cassandra-table`/`cassandra-ring` + `openCassandraTable` (`tabs.svelte.ts:613`) + nhánh `App.svelte:240`. Mongo: `mongo-collection` + `openMongoCollection`.
- **ConnectionForm nhánh riêng**: `cassandra_dc`/`cassandra_consistency` (`ConnectionForm.svelte:351-368`). Mongo: authSource/replicaSet/readPreference.
- **Test builder thuần**: `cassandra.rs:1219-1382` (unit test `format_*_ddl`/`cql_change_sql` không cần cluster). Mongo: unit test cho `bson_to_json` + parser mongosh + builder change.

### 3.2 ClickHouse — result set động qua HTTP, không positional param

- Driver chỉ giữ `reqwest::Client` + params, không sqlx (`clickhouse.rs:30-33`). Mongo tương tự: `mongodb::Client`.
- **Cols suy từ kết quả động**: ClickHouse có `meta[]` (`clickhouse.rs:35-49,179-188`). Mongo **KHÔNG** có → phải tự union keys qua documents. Đây là điểm xử lý dữ liệu mới duy nhất.
- Số lớn serialize thành string JSON (`clickhouse.rs:226-229`); Mongo có `Int64`/`Decimal128`/`ObjectId` cùng vấn đề → Extended JSON.
- **exec_params tắt** với Err rõ ràng (`mod.rs:336`) — Mongo làm y hệt (`:346` mẫu Cassandra).
- **Streaming export** `stream_export<W>` (`clickhouse.rs:414-489`), route hard trong `export.rs:40-46`. Mongo thêm `LiveConnection::Mongo(m) => m.stream_export(...)` (`export.rs:39-58`).
- **Editable grid → generate thay commit** (`ResultGrid.svelte:356-369`): precedent nếu muốn Mongo "generate `updateOne` script" thay vì apply trực tiếp.

### 3.3 Redis/Kafka/NATS — explorer riêng, KHÔNG mở SQL tab khi connect

- Connect KHÔNG mở tab: `ConnectionList.svelte:86-100` (redis `:92`, kafka `:96` chỉ để sidebar hiển thị). Mongo thêm nhánh tương tự.
- Explorer nhúng theo cờ system: `isRedis` (`ObjectExplorer.svelte:454`) → `<RedisExplorer>` (`:1472-1474`). Mongo: `isMongo` → cây database→collection (hoặc `<MongoExplorer>`).
- Tab type riêng + `open*` dedup: `openRedisKey` `contentType:'redis-key'` dedup theo key (`tabs.svelte.ts:179-196`). Mongo: `openMongoCollection` dedup theo `(conn,db,collection)`.
- **Pagination server-side** (mẫu tốt cho collection lớn): `js_subject_messages` bounded + start seq (`nats.rs:414-462`) + `js_subject_stats` cho `total` footer (`:467-486`). Mongo: cursor + `countDocuments` cho total.
- **Document viewer**: `highlightJson`/`jsonTokenColor` (`format/json.ts:15-60`) tái dùng ở 3 nơi (RedisKeyView `:79-89,262-287`, NatsSubjectMessages, KafkaConsumer). Mongo document viewer import y nguyên.
- Serialize giá trị phi-bảng: tagged union `RedisValue`/`RedisEditOp` (`redis.rs:384-420`) — precedent cho `MongoEditOp` (insert/replace/set/unset/delete).

---

## BƯỚC 4 — Ánh xạ MongoDB + phân tích gap (per method)

### 4.1 Ánh xạ khái niệm cốt lõi

| Khái niệm SQL/relational | MongoDB | Ghi chú |
|---|---|---|
| database | database | Mongo có nhiều DB/server → `databases()` implement thật |
| schema | *(không có)* | DB đóng vai "schema"; cây 2 cấp database→collection |
| table | collection | `TableInfo.kind = "table"`; view Mongo → `kind="view"` |
| row | document | `Vec<Value>` |
| column | field | **không cố định** — suy qua sampling N (mặc định 100?) documents, union keys |
| PRIMARY KEY | `_id` | ngầm định, luôn có; editable grid dùng `_id` |
| INDEX | index | `createIndex`/`listIndexes`/`dropIndex` — map thẳng `IndexInfo` |
| FOREIGN KEY | *(không có)* | `$lookup` là runtime join, không phải ràng buộc → `foreign_keys()`=rỗng, ER Diagram N/A |
| CONSTRAINT (UNIQUE/CHECK) | index unique / JSON Schema validator | `constraints()`=rỗng; unique nằm trong `IndexInfo.unique` |
| VIEW | view (từ pipeline) | `db.createView(name, source, pipeline)` |
| stored proc/function | *(không có)* | `routines()`=rỗng |
| trigger | change stream | ngoài parity → `triggers()`=rỗng |
| sequence | *(không có)* | `sequences()`=rỗng |
| SQL query | `find`/`aggregate`/… | `mongo_exec` (xem §4.3) |
| WHERE | filter document `{...}` | qua BSON, không nối chuỗi (an toàn injection) |
| JOIN | `$lookup` (trong aggregate) | không phải join SQL |
| ORDER BY / LIMIT / OFFSET | `.sort()` / `.limit()` / `.skip()` | |
| transaction | multi-doc txn (chỉ replica set) | UI đã bỏ nút txn (AUDIT-2) → ngoài parity |
| EXPLAIN | `.explain(verbosity)` | §4.2 |
| partition | sharding | khác bản chất → `partitions()`=rỗng (ngoài parity core) |

**Quyết định hybrid tree (khuyến nghị):** implement `databases()` (thật) + `mongo_tree(db)` (collections+views+indexes) để cây Explorer + Objects tab đạt parity. Field-per-collection suy qua sampling (`mongo_collection_fields`) chỉ khi expand collection. Đây là đường ít rủi ro, tái dùng `TableInfo`/`IndexInfo` sẵn có.

### 4.2 EXPLAIN — MongoDB theo precedent PostgreSQL/MSSQL (KHÔNG Cassandra)

Nguồn: agent EXPLAIN + `commands/plan.rs`, `drivers/plan.rs`.

- MongoDB có planner tĩnh (`queryPlanner` không chạy query) → **`has_planner = true`** (khác Cassandra `false`).
- `queryPlanner` → mode **`estimated`**; `executionStats` (chạy thật, có `nReturned`/`totalDocsExamined`/`executionTimeMillis`) → mode **`actual`**, `actual_kind = Analyze`.
- **KHÔNG dùng mode `tracing`** (chỉ dành cho engine không planner như Cassandra).
- `cost_basis`: MongoDB không có per-stage cost số → **`RowsProxy`** (giống SQLite/ClickHouse) — an toàn, trung thực. **[CẦN XÁC MINH khi implement]**.

Việc cần làm:
1. `plan::capability("mongodb") => (has_planner:true, actual_kind:Analyze, cost_basis:RowsProxy)` (`drivers/plan.rs:142`).
2. Nhánh riêng trong `explain_plan` (như `explain_cassandra`/`explain_mssql` `commands/plan.rs:57-65`): gọi driver Mongo `.explain(verbosity theo actual)` → JSON.
3. `parse_mongodb(json, actual)` trong `drivers/plan.rs` (thuần, unit-test): map `winningPlan` stages → `PlanNode`, bổ sung `normalize_op`: `COLLSCAN→SeqScan`, `IXSCAN→IndexScan`, `FETCH`, `SORT→Sort`, `GROUP→Aggregate`, `PROJECTION`. **[CẦN XÁC MINH tên stage]**.
4. Guard write: aggregate có `$out`/`$merge` = ghi → chặn actual (mẫu `commands/plan.rs:47-54`). `is_write_statement` (`:334`) là heuristic SQL, không hợp Mongo → cần guard riêng.
5. FE `mode` union đã có `'estimated'|'actual'` (`ipc.ts:582`) → không đổi type.
6. Missing-index từ COLLSCAN+filter → `MissingIndex{ddl:"db.coll.createIndex({...})"}` (mẫu MSSQL `plan.rs:787-831`) — tuỳ chọn, không bắt buộc MVP.

### 4.3 Query Editor — `mongo_exec` (analog `cql_exec`)

Signature đề xuất:
```rust
// commands/mongo.rs (tạo mới, mẫu commands/cassandra.rs)
#[tauri::command]
pub async fn mongo_exec(
    state: State<'_, AppState>,
    conn_id: String,
    query: String,           // mongosh-style: db.coll.find({...})...  (lựa chọn A)
    database: Option<String>,// db hiện hành của tab
    batch_size: Option<i32>,
    cursor_token: Option<String>,
) -> Result<MongoExecResponse, AppError>
```
`MongoExecResponse{ ok, result?: QueryResultSet, error?, duration_ms, next_cursor?: String, warnings: Vec<String> }` (mẫu `CqlExecResponse` `commands/cassandra.rs:18-31`).

Driver `MongoDriver::exec_mongo(query, batch_size, cursor_token)`:
1. Parse `query` → `(collection, method, args)`. Subset: `find`, `aggregate`, `countDocuments`, `distinct`, `insertOne/Many`, `updateOne/Many`, `deleteOne/Many`, `createIndex`, `drop`. [CẦN XÁC MINH: chọn parser hay JSON spec — §0.3].
2. `find`/`aggregate` → cursor; lấy `batch_size` documents → `Vec<Value>` (bson_to_json), suy `cols` union keys, `next_cursor` nếu còn.
3. write op → `StatementOutcome::Affected{ affected: modified/inserted/deleted }`.
4. Lỗi → `QueryError{system:"mongodb", message, hint, raw}`.

FE: `results.svelte.ts` thêm nhánh `system==='mongodb'` gọi `ipc.mongoExec` thay `execStatement` (mẫu `:184-205`), `fetchMoreMongo` (mẫu `fetchMoreCql` `:336-358`).

### 4.4 Method KHÔNG map được → hệ quả UI/UX (disable có kiểm soát)

| Method/feature | Trạng thái Mongo | Precedent cách xử lý | Hệ quả UI |
|---|---|---|---|
| `exec_params` (filter builder) | ✗ | Cassandra/ClickHouse trả Err (`mod.rs:336,346`) | Table Data Viewer filter builder tắt cho Mongo; browse qua editor/collection viewer |
| `constraints`/`routines`/`triggers`/`sequences`/`foreign_keys` | rỗng | Cassandra `Ok(Vec::new())` | Không có node Constraints/Procedures/Triggers/Sequences trong cây Mongo |
| ER Diagram / Schema Compare (FK-based) | N/A | `REL_SYSTEMS` không gồm mongo (`ConnectionList.svelte:64`) | Nút ER/Compare tự disable (chỉ relational) |
| Table Designer (ALTER cột) | ≈ | — | Thay bằng "Create Collection" dialog (options capped/validator); không có ALTER cột |
| Transaction toolbar | ✗ | UI đã gỡ (AUDIT-2 #6) | Không có nút |
| `admin_view`/`kill_session` | ≈ | Redis có đường riêng (`admin.rs:153`) | Session Monitor Mongo = `currentOp`/`serverStatus` (đường riêng) — tuỳ chọn |
| Partition | rỗng (ngoài parity core) | SQLite/Redis `Ok(Vec::new())` (`mod.rs:524-527`) | Không có node Partitions |
| Streaming export | tuỳ chọn | chỉ PG/CH (`export.rs:52`) | Nếu không thêm arm → fallback in-memory qua editor |
| Preview grid change / exec_filtered | cần route | ClickHouse rẽ nhánh riêng (`grid.rs:65`) | Thêm nhánh mongo hoặc tắt inline-edit như ClickHouse |

---

## BƯỚC 5 — Spec triển khai đầy đủ

### 5.1 Crate/driver Rust

- **`mongodb`** (official async driver) + **`bson`** (đi kèm). Chọn feature TLS **`rustls-tls`** để đồng bộ policy rustls của repo (như scylla/redis/nats — tránh OpenSSL/nasm). Runtime tokio (mặc định).
- Cargo.toml (`src-tauri/Cargo.toml:15-99`) thêm:
  ```toml
  # MongoDB — official async driver, rustls để đồng bộ TLS toàn repo (không OpenSSL)
  mongodb = { version = "3", default-features = false, features = ["rustls-tls"] }  # [CẦN XÁC MINH version + feature name]
  bson = "2"
  ```
- **Lưu ý bắt buộc**: `[profile.release] panic = "abort"` (`Cargo.toml:116`) → driver Mongo **không được panic** (giống fix PG timestamp AUDIT-2 #5). Mọi decode BSON→JSON phải trả marker/Err, không `unwrap`.
- Integration test dùng testcontainers (đã có, `Cargo.toml:101-107`) — thêm image `mongo:7` (tự bật/tắt, seed rồi query lại để verify — theo methodology trong CLAUDE.md; **không** `docker rm`/prune theo label).

### 5.2 File TẠO MỚI

| File | Nội dung | Mẫu tham chiếu |
|---|---|---|
| `src-tauri/src/drivers/mongo.rs` | `MongoDriver` + `MongoConnParams` + `connect/test/ping/exec_mongo/databases/collections/collection_fields/indexes/apply_grid/scan_indexes/collection_ddl/stream_export` + `bson_to_json` + parser mongosh + `mongo_change_doc` + unit tests | `drivers/cassandra.rs`, `drivers/clickhouse.rs` |
| `src-tauri/src/commands/mongo.rs` | `#[tauri::command]` chuyên biệt: `mongo_exec`, `mongo_databases`, `mongo_tree`, `mongo_collections`, `mongo_collection_fields`, `mongo_indexes`, `mongo_collection_ddl`, `mongo_stats` (+ `not_mongo()` helper) | `commands/cassandra.rs`, `commands/clickhouse.rs` |
| `src/lib/components/workspace/MongoCollectionView.svelte` | Xem collection dạng grid, paging cursor, editable qua `_id`, View JSON popup | `CassandraTableView.svelte` |
| `src/lib/components/explorer/MongoExplorer.svelte` *(tuỳ chọn)* | Cây database→collection+indexes, sticky header, DB dropdown, context menu Create/Drop/Refresh | `RedisExplorer.svelte`, nhánh cassandra `ObjectExplorer.svelte:1237` |
| `src/lib/mongo/query.ts` | Builder/validate query mongosh thuần (client-side preview) + unit test | `sql/cassandra.ts` + `.test.ts` |
| `src-tauri/tests/mongo_integration.rs` *(hoặc arm trong file có sẵn)* | Container `mongo:7`: connect/tree/exec find+aggregate/insert-update-delete by _id/indexes/explain | `tests/drivers_integration.rs` |

### 5.3 File Backend cần SỬA

| File | Sửa | Vị trí |
|---|---|---|
| `src-tauri/src/drivers/mod.rs` | `pub mod mongo;` + `use mongo::{MongoConnParams, MongoDriver};` + biến thể `LiveConnection::Mongo` + `fn mongo_params(...)` + **18 match arm** (bảng §1.1) | `:1-52,182-570` |
| `src-tauri/src/drivers/types.rs` | `SystemType::Mongodb` + `as_str` | `:10-37` |
| `src-tauri/src/connections/profile.rs` | `default_port(Mongodb)=27017` (+ field mới §5.4) | `:101-113` |
| `src-tauri/src/lib.rs` | Đăng ký mọi command `mongo_*` vào `invoke_handler![...]` | `:35-179` |
| `src-tauri/src/commands/mod.rs` | `pub mod mongo;` | — |
| `src-tauri/src/commands/connections.rs` | `open_database` whitelist thêm `SystemType::Mongodb` (nếu muốn "open other DB") | `:201` |
| `src-tauri/src/commands/plan.rs` | Nhánh `explain_mongo` + `plan::capability` arm | `:57-95,188-263` |
| `src-tauri/src/drivers/plan.rs` | `capability("mongodb")` + `parse_mongodb` + `normalize_op` stage Mongo | `:142,173-219` |
| `src-tauri/src/commands/export.rs` | (tuỳ) `LiveConnection::Mongo(m) => m.stream_export(...)` | `:39-58` |
| `src-tauri/src/commands/backup.rs` + `drivers/backup.rs` | `backup_tool(Mongodb)=Some("mongodump")` + `external_backup_cmd` nhánh mongo (mongodump/mongorestore, password qua env/`--uri`) | `backup.rs:6-57` |
| `src-tauri/src/commands/grid.rs` + `drivers/grid.rs` | (tuỳ) nhánh mongo trong `preview_sql`/`build_select`, hoặc tắt inline-edit như ClickHouse | `grid.rs:65`; `drivers/grid.rs:22,38,178,295` |
| `src-tauri/src/commands/admin.rs` | (tuỳ) đường riêng Mongo cho `admin_view`/`kill_session` (`currentOp`/`killOp`) | `:34-138,153` |
| `src-tauri/src/commands/schema.rs` | (tuỳ) `definition_query`/`index_definition_query` — Mongo giữ `None` (không DDL SQL) hoặc map | `:155-264` |

**Command tự động chạy cho Mongo (không sửa, chỉ cần §1.1):** `exec_statement`, `cancel_query`, toàn bộ `list_*` + `scan_indexes` (schema.rs), `apply_grid_changes`, `ping_connection`, `attach_database`, `open_tab_connection`, `connect/disconnect/reconnect/quick_connect`, `test_connection`, `list_history/snippets`, `save/load_tabs`. (Nguồn: agent Commands surface.)

### 5.4 Field ConnectionProfile cho Mongo — [QUYẾT ĐỊNH]

Hai hướng (theo precedent repo hay tái dùng field):
- **Tối thiểu (khuyến nghị)**: dùng lại field sẵn có — `host` (cho phép URI `mongodb://` hoặc host list), `port`, `user`, `password`, `database` (default db), `ssl`+`ssl_ca`/`ssl_cert`/`ssl_key`. Tái dùng `mssql_auth` làm "auth mode" (đã có tiền lệ: Kafka SASL dùng chung field này, comment `mod.rs:160`). authSource có thể nhét vào `database` hoặc thêm 1 field.
- **Đầy đủ**: thêm field mới `mongo_auth_source`, `mongo_replica_set`, `mongo_read_pref`. Nếu thêm field mới **phải** cập nhật: `profile.rs` (struct + `ProfilePublic`), `types.ts` (`ConnectionProfile`), `connections.svelte.ts` `makeBlankProfile` (`:227-253`), `demo.ts` helper `conn(...)` default (`:11-46`), `ConnectionForm.connectionAffectingChanged` keys (`:171`).

### 5.5 File Frontend cần SỬA (checklist đầy đủ — nguồn agent Frontend wiring)

| # | File | Sửa gì | Vị trí |
|---|---|---|---|
| 1 | `spec/.../Database Studio.dc.html` | Thêm entry `mongodb` vào map `SYS` (accent/bg/border/fg/badge `MG`/label `MongoDB`) | `:3715-3727` |
| 2 | `scripts/extract-tokens.mjs` | Thêm `'mongodb'` vào `EXPECTED_SYSTEMS` | `:60-66` |
| 3 | **chạy** `npm run tokens` | Tái sinh `src/lib/systems.gen.ts` + `tokens.css` (thêm `--sys-mongodb-*`) | `systems.gen.ts:1-5` |
| 4 | `src/lib/types.ts` | `SystemType`+`'mongodb'`; `TabContentType`+`'mongo-collection'`(±`'mongo'`); (±field profile) | `:5-15,205-228,30-52` |
| 5 | `src/lib/systems.ts` | `EXTRA`+mongodb (`defaultPort:27017,quote:null,available:true`); `SYSTEM_ORDER`+mongodb; (±`SystemCategory 'DOCUMENT'`+`CATEGORY_ORDER`) | `:36-51,74-85,11-18,65-72` |
| 6 | `src/lib/components/SystemIcon.svelte` | Nhánh icon `mongodb` (SVG stroke hoặc `/assets/db-mongodb.svg`) | `:45-88` |
| 7 | `src/lib/components/connections/ConnectionForm.svelte` | `isMongo` derived + khối field riêng + hostLabel/placeholder + (±`connectionAffectingChanged`) | `:49-82,320-419,171` |
| 8 | `src/lib/stores/connections.svelte.ts` | `makeBlankProfile` default mongodb | `:227-253` |
| 9 | `src/lib/stores/tabs.svelte.ts` | Thêm `openMongoCollection(connId,db,coll)` (±`openMongoTab`) | mẫu `:613-641,152-176` |
| 10 | `src/App.svelte` | Import `MongoCollectionView` + nhánh `paneBody` `{:else if 'mongo-collection'}` (nếu không → rơi vào `<SqlWorkspace>` sai) | `:18-38,214-260` |
| 11 | `src/lib/components/explorer/ObjectExplorer.svelte` | `isMongo` derived; nhánh `refreshConnection`; nhánh cây `{:else if isMongo}` (± `<MongoExplorer>`); loader+state | `:427-446,1237-1475,363-392` |
| 12 | `src/lib/components/connections/ConnectionList.svelte` | Nhánh `openOrToggle` cho mongodb; (±`connString` case `mongodb://`) | `:86-100,131-146` |
| 13 | `src/lib/components/CommandPalette.svelte` | Nhánh `openConn` cho mongodb | `:29-40` |
| 14 | `src/lib/demo.ts` | `case` cho MỌI `mongo_*`; (±conn/tab demo; ±default opts) | `:250-1019,11-46` |
| 15 | `src/lib/ipc.ts` | Wrapper typed `mongo*` cho mọi command | mẫu `:468-486` |
| 16 | `src/lib/components/color-identity.test.ts` | `SYSTEM_ORDER` length 10→11, `SYSTEMS` 11→12; `systemMeta('mongodb')` không còn `orphan`; thêm entry `EXPECTED` | `:35-45,52-55,68,112` |
| 17 | (mới) `src/lib/components/workspace/MongoCollectionView.svelte` | Tạo (xem §5.2) | thư mục `workspace/` |

**Hai điểm dễ "vỡ âm thầm":** (a) `demo.ts` default case reject mọi command chưa mock → hỏng Playwright/dev (`:1016-1017`); (b) `color-identity.test.ts:52-55` kỳ vọng `systemMeta('mongodb')==='orphan'`. Nếu Mongo dùng `SystemCategory` mới mà quên thêm vào `CATEGORY_ORDER` → connection biến mất khỏi sidebar "Group by Type" (`ConnectionList.svelte:40-54`).

### 5.6 Hành vi mong đợi per method Mongo (tóm tắt để dev implement)

| Method Mongo (driver) | Lệnh MongoDB | Trả về |
|---|---|---|
| `connect` | `Client::with_options` + `hello`/`ping` handshake thật | `MongoDriver` |
| `test` | `ping` + `buildInfo` | `TestResult{ok, latency_ms, server_version:"MongoDB {v}"}` |
| `ping` | `ping` | `bool` |
| `databases` | `listDatabases` | `Vec<DatabaseInfo>{name,current}` |
| `collections(db)` | `listCollections` | `Vec<TableInfo>{schema:db,name,kind:table|view, data_length: collStats.storageSize, row_estimate: count}` |
| `collection_fields(db,coll)` | sample N docs, union keys | `Vec<ColumnInfo>{name, data_type: bson type, is_pk: name=="_id"}` |
| `indexes(db,coll)` | `listIndexes` | `Vec<IndexInfo>{name,method,columns,unique,primary:name=="_id_"}` |
| `exec_mongo(q,batch,cursor)` | find/aggregate/write | `MongoOutcome{outcome, next_cursor, warnings}` |
| `apply_grid(changes)` | `insertOne`/`updateOne($set)`/`deleteOne` by `_id` | `u64` số doc thay đổi |
| `scan_indexes(db)` | `$indexStats` per collection | `Vec<IndexScanRow>` (unused = accesses.ops==0) |
| `collection_ddl(db,coll,kind)` | dựng lại từ `listCollections`/`listIndexes` | `String` (`db.createCollection(...)`, `createIndex(...)`) |
| `explain(q, verbosity)` | `explain` command | JSON → `parse_mongodb` |
| `stream_export<W>` (tuỳ) | cursor stream → BufWriter | `u64` rows |

### 5.7 Thứ tự triển khai đề xuất (mỗi bước 1 commit, test xanh mới commit)

1. **M0 — Skeleton**: `SystemType::Mongodb` + `LiveConnection::Mongo` + `MongoDriver::{connect,test,ping}` + 18 match arm (đa số `Ok(Vec::new())`) + `mongo_params` + đăng ký. Build `cargo build --lib` xanh. Frontend: types + systems + tokens + icon + ConnectionForm + demo tối thiểu → connect/test chạy. Gate: `npm run check` 0/0, `color-identity.test.ts` cập nhật.
2. **M1 — Explorer**: `databases`/`collections`/`indexes`/`mongo_tree` + nhánh `isMongo` ObjectExplorer + connect không mở tab. Integration: seed → tree verify.
3. **M2 — Query editor**: `mongo_exec` + parser subset + `bson_to_json` + nhánh `results.run` + paging cursor. Integration: find/aggregate/count.
4. **M3 — Collection viewer + CRUD**: `mongo-collection` tab + `MongoCollectionView` + `apply_grid` by `_id`. Integration: insert/update/delete verify.
5. **M4 — Parity mở rộng**: Import/Export CSV/JSON, Index Manager (create/drop index), Backup (mongodump), Query Plan (`explain`+`capability`+`parse_mongodb`), Generate Test Data, collection DDL viewer. Mỗi cái 1 commit + integration.
6. **M5 — Tuỳ chọn**: streaming export, admin view (`currentOp`), copy collection, group-by/chart (tái dùng sẵn).

### 5.8 Testing (theo kỷ luật repo)

- **Unit thuần (không DB)**: `bson_to_json` (mọi BSON type), parser mongosh, `mongo_change_doc`, `mongo/query.ts` builder — mẫu `cassandra.rs:1219-1382` + `sql/cassandra.test.ts`.
- **Vitest/Playwright**: chạy trên demo → mọi `mongo_*` phải có case trong `demo.ts`; e2e explorer + collection viewer + editor (mẫu `cassandra-*.spec.ts`).
- **Integration (container thật `mongo:7`)**: prebuild `--no-run`, chạy 1 shot có `timeout`, ghi log, đọc log cùng command; seed rồi query lại verify (không hard-code kết quả). Bao phủ: connect/tree/find/aggregate/insert-update-delete by `_id`/indexes/explain.
- Gate cuối: `npm run check` 0/0, `npm run tokens:check` (0 vi phạm mới), `cargo build --lib` + `cargo test --lib`, integration `mongo_*` EXIT=0.

---

## Phụ lục — Quyết định đã CHỐT (user xác nhận)

1. **Ngôn ngữ Query Editor** (§0.3): **(A) mongosh-style string** `db.coll.find({...})`. → cần parser subset trong `mongo_exec`.
2. **Field ConnectionProfile** (§5.4): **tái dùng field sẵn có** (`host`/`port`/`user`/`password`/`database`/`ssl`+cert; `mssql_auth` làm auth mode nếu cần). KHÔNG thêm field mới → không cần đụng `profile.rs` struct, `makeBlankProfile`, `demo.ts` conn opts cho field mới.
3. **Category sidebar** (§5.5 #5): **thêm `SystemCategory 'DOCUMENT'`** mới. → phải thêm vào cả `SystemCategory` union, `CATEGORY_ORDER` (không thì connection biến mất khỏi sidebar Group-by-Type).
4. **Phạm vi tuỳ chọn**: **làm ngay** — streaming export (arm `LiveConnection::Mongo` trong `export.rs`), admin/session monitor (`currentOp`/`serverStatus`/`killOp` đường riêng như Redis), copy-collection cross-conn, missing-index từ COLLSCAN.
5. **Extended JSON**: **ObjectId → `{"$oid":"..."}`** (chuẩn MongoDB Extended JSON). Áp cho mọi BSON type: Date→`{"$date":...}`, Decimal128→`{"$numberDecimal":...}`, Binary→`{"$binary":...}` trong `bson_to_json`.

*(Mọi `file:line` trong spec lấy trực tiếp từ mã nguồn hiện tại trên branch, xác minh bởi khảo sát read-only. `parse_mongodb` stage names + version/feature crate `mongodb` đánh dấu [CẦN XÁC MINH] cần kiểm khi implement.)*

---

## M6 — Parity UX (đã triển khai) — 5 mục người dùng

Bổ sung, KHÔNG đổi backend (mọi thứ frontend-orchestrated qua `mongo_exec`; driver đã hỗ trợ `updateMany`/`count`/`createCollection`). Chỉ liên quan MongoDB, không đụng tính năng sẵn có.

1. **Design Document (sửa fields)** — context menu collection → "Design Document…". Pure `src/lib/mongo/design.ts` (`buildFieldOp`/`buildFieldOps`/`isValidOp`) sinh `updateMany`:
   - add field: `updateMany({field:{$exists:false}}, {$set:{field:value}})` (không clobber giá trị có sẵn),
   - rename: `updateMany({}, {$rename:{from:to}})`,
   - drop: `updateMany({}, {$unset:{field:""}})`.
   - Thứ tự add→rename→drop; lọc op không hợp lệ. `DesignDocumentDialog.svelte` + `designDocWizard` store: nạp fields (`list_columns`), rename/drop existing (chặn `_id`), add field (default = JSON literal), preview lệnh, Apply chạy tuần tự qua `mongoExec` rồi refresh `loadTableDetail`.
2. **Open Document pagination** — `MongoCollectionView` chuyển từ "Load next page" (append) → **page-based** đồng bộ Table Viewer quan hệ: `page`/`pageSize` (100/200/500/1000), `countDocuments(filter)` cho total → footer "docs range · Page X of Y" + « ‹ › » + page-size select. `find(filter).skip(page*size).limit(size)`.
3. **Autocomplete Query Editor** — pure `src/lib/mongo/complete.ts` (`parseMongoCollection` lấy `<coll>` từ `db.<coll>.<method>`, hỗ trợ `db.getCollection("...")`; `isCollectionPrefix`). `SqlWorkspace.mongoCompletionSource` (dùng khi `systemType==='mongodb'` thay `columnSource` SQL): sau `db.` → tên collection; trong query → field của collection tham chiếu. Nạp lazy từ `explorer.cache` (loadSchemaChildren/loadTableDetail), bound theo `currentDb`.
4. **Number-type color trong grid** — `ResultGrid` `NUM_COLOR_SYSTEMS` thêm `'mongodb'`; `MongoCollectionView` truyền `system="mongodb"` vào `ResultGrid`; `classifyType` thêm `long`→bigint (Mongo Int64) → int/long/double/decimal tô `var(--syntax-number)`.
5. **New Database (connection ctx menu)** — hiện "New Database…" cho mongodb; `NewDatabaseDialog` nhánh mongo: thêm field "First collection" (Mongo materialize db khi tạo collection đầu) → `mongoExec(cid, db.createCollection("<coll>"), <dbName>)` rồi refresh.

**Tests**: unit `mongo/design.test.ts` (9) + `mongo/complete.test.ts` (5) + `copy/types.test.ts` (+long/double/decimal). e2e `mongo-explorer.spec.ts` mở rộng: Design Document (add→preview→apply), New Database (name+first collection), autocomplete (`db.`→collection), pagination footer + number color trong document-viewer test. Integration `mongo_new_database_design_document_and_pagination` (container `mongo:7`, chạy CHÍNH XÁC lệnh builder sinh: createCollection→databases; updateMany $set/$rename/$unset→find verify; countDocuments=5 + find.skip.limit=2) EXIT=0. Gates: check 0/0, vitest 531, tokens 190 (0 mới), integration EXIT=0.

### M6.1 — Tree expand qua double-click (đồng nhất chọn/mở)

Người dùng: single-click KHÔNG expand nữa — chỉ **double-click** mới mở. `MongoExplorer`:
- **Database node**: single-click = chọn (select highlight); **double-click = expand/collapse** (hiện/ẩn collections); chevron ▸/▾ single-click vẫn toggle (tiện). Auto-expand default db lúc connect giữ nguyên (gọi `toggleDb` trực tiếp, không qua click).
- **Collection node**: single-click = chọn; **double-click = expand/collapse fields + indexes** (trước đây double-click mở document viewer). **Open Documents chuyển hẳn về context menu** (KHÔNG mất tính năng — vẫn còn item "Open Documents"). Chevron single-click toggle.
- Chỉ đổi binding click; toggleDb/toggleColl, context menu, hover/selected, mọi thứ khác giữ nguyên.
- e2e `mongo-explorer.spec.ts` +1 (`double-click expands…`): single-click db KHÔNG collapse (collections vẫn hiện) → double-click collapse → double-click expand → double-click collection hiện `first_name`, và KHÔNG mở tab document viewer. 10/10 xanh.

### M6.2 — Query Editor mongosh · double-click documents · shared grid (3 mục)

1. **Query Editor mongosh (fix + hướng dẫn)**: user gõ SQL (`select * from db.act`) → mongoExec không parse được (đúng bản chất — editor dùng **mongosh**, KHÔNG phải SQL). Backend/run path đã đúng (`results.run` route mongodb → `ipc.mongoExec` với `{database}`; F5 lẫn Ctrl+Enter đều chạy). Fix phía UX: **bỏ SQL lint cho mongodb** (`SqlWorkspace.lintDoc` early-return khi `systemType==='mongodb'`) → hết squiggle đỏ gây hiểu nhầm. Autocomplete collections/fields (M6 §3) đã có; nạp collections của `currentDb` qua effect + lazy `db.`. **Cách query**: `db.<collection>.find({filter}, {projection})` · `.skip(n).limit(m)` · `.sort({...})`; `db.<c>.aggregate([...])`; `countDocuments({...})`; `insertOne/updateOne/updateMany/deleteOne` (delete/update PHẢI có filter). Suggest: gõ `db.` → tên collection; trong query → field.
2. **Double-click collection = Open Documents (khôi phục)**: M6.1 đổi double-click collection thành expand fields → user báo mất "Open Documents". Khôi phục: **double-click collection → `openMongoCollection` (documents)**; single-click = select; **chevron ▸/▾ single-click = expand fields/indexes** (giữ từ M6.1). Double-click DATABASE vẫn = expand collections. Không mất tính năng (expand fields qua chevron).
3. **Open Documents dùng chung component**: ĐÃ dùng — `MongoCollectionView` render **`ResultGrid`** (grid dùng chung với relational: inline-edit, number color, copy, paging trong grid) + **`EditTarget` → `apply_grid`** (sửa theo `_id`) + **`exportWizard`** + footer pager kiểu Table Viewer. Shell riêng (header + JSON filter) vì query model Mongo (mongosh + JSON filter) khác SQL — hợp nhất hẳn TableViewerTab sẽ rủi ro relational, nên giữ ResultGrid làm lõi chung.

**Tests**: e2e `mongo-explorer.spec.ts` — find qua **nút Run (F5)** + double-click collection → tab documents (`app.students` + "Ann"); double-click DB expand/collapse. Integration `mongo_query_editor_find_filter_projection_limit` (mongo:7): find filter (`age>25`) / projection (`{name:1}` loại age) / limit(2) EXIT=0. Gates: check 0/0, e2e mongo 10/10, integration EXIT=0.

### M6.3 — Ctrl/Cmd+N mở đúng Mongo console + DB dropdown cho Mongo (2 mục)

1. **Ctrl/Cmd+N mở đúng Tab QueryEditor Mongo bound theo db đang chọn**: trước đây `openQueryConsole` bind db qua `explorer.selectedDatabase` — nhưng **MongoExplorer chưa set** signal này (chỉ relational tree set) → Ctrl+N cho Mongo mở tab title "Untitled query" không bind db. Fix:
   - **MongoExplorer**: `$effect` publish `explorer.selectedDatabase = { base: connId, database: <db từ selectedKey> }` (db = segment đầu của selectedKey `db:<db>`/`coll:<db> <coll>`/…; reset null khi đổi connection). **ObjectExplorer** guard `dbTarget` effect: `if (selected.system !== 'mongodb')` — không ghi đè signal của MongoExplorer (KHÔNG đụng relational).
   - **tabs.openQueryConsole**: title = `'Untitled Mongo'` khi connection là mongodb (khớp Explorer "New Query").
   - Kết quả: chọn db (vd `analytics`) → Ctrl+N → tab "Untitled Mongo" bound `database: analytics`.
2. **DB dropdown cho Mongo (nhiều database)**: `SqlWorkspace` thêm `supportsMongoDb` + `showDbPicker = supportsDbSwitch || supportsMongoDb`; dropdown DB hiện cho Mongo (list_databases), chọn → `pickDatabase` set `tab.state.database` → `currentDb` → autocomplete nạp collections của db đó + `runOpts.database` truyền vào `mongoExec` (KHÔNG attach sub-connection như relational — Mongo đã truyền db qua runOpts). resolveRunConn giữ nguyên (supportsDbSwitch loại mongo → db='' → không attach).

**Tests**: e2e `mongo-explorer.spec.ts` +2 — Ctrl+N sau khi chọn `analytics` → tab "Untitled Mongo" + DB dropdown value `analytics`; mở console rồi đổi DB dropdown → `analytics`. Relational Ctrl+N/DB dropdown regression (new-query-database/audit5-ui/query-editor-schema/editor-autocomplete 15/15) xanh. Backend db-override đã integration-covered (M6.2 `exec_mongo_in(Some(db),…)`). Gates: check 0/0, vitest 531, tokens 190 (0 mới), e2e mongo 12/12.

### M6.4 — Query Editor suggest hàm MongoDB (methods + operators)

Người dùng: editor Mongo chỉ suggest collection, thiếu **hàm MongoDB**. Bổ sung vào `mongoCompletionSource`:
- **Collection methods** (sau `db.<coll>.`): pure `mongo/functions.ts::MONGO_METHODS` (find/findOne/aggregate/countDocuments/distinct/insertOne·Many/updateOne·Many/replaceOne/deleteOne·Many/createIndex/dropIndex/drop/renameCollection) — mỗi item có signature + detail. Detect `isMethodContext` (`db.<coll>.<partial>` 2 dấu chấm).
- **Operators** (gõ `$`): `MONGO_OPERATORS` (comparison $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin · logical $and/$or/$nor/$not · element/eval $exists/$type/$regex/$expr/$mod · array $all/$elemMatch/$size · update $set/$unset/$inc/$mul/$rename/$min/$max/$currentDate/$push/$pull/$addToSet/$pop · aggregation $match/$group/$project/$sort/$limit/$skip/$unwind/$lookup/$count/$sum/$avg). Detect `isOperatorContext` (`\$\w*$`).
- Method/operator là **vocab tĩnh** → check TRƯỚC guard connection (suggest được ngay cả khi collection chưa nạp). Thứ tự: method → operator → collection (`db.`) → field.
- **Bỏ SQL function completion cho Mongo**: `SqlEditor.langExt` không add `fnSource` khi `system==='mongodb'` (tránh gợi ý COUNT/SUM… SQL). Relational giữ nguyên.

**Tests**: unit `mongo/functions.test.ts` (methods/operators đủ core, unique, $-prefixed) + `complete.test.ts` (+isMethodContext/isOperatorContext). e2e `mongo-explorer.spec.ts` +1 (`db.students.`→find/aggregate; `find({age:{$g`→$gt). Integration `mongo_suggested_methods_and_operators_execute` (mongo:7): chạy THẬT find $gt/$in/$or · updateMany $set+$inc · aggregate $match/$group/$sum · distinct · deleteMany filter · countDocuments — verify từng cái EXIT=0 (chứng minh vocab suggest thực thi được). Gates: check 0/0, vitest (mongo unit 19), tokens 190 (0 mới), e2e mongo 13/13, integration EXIT=0. Relational autocomplete regression (editor-autocomplete 6/6) xanh.
