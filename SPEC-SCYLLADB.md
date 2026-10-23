# SPEC-SCYLLADB — Hỗ trợ ScyllaDB (biến thể của engine Cassandra)

> Trạng thái: **đã implement S1–S6** (2026-10-23) — integration trên `scylladb/scylla:6.2` thật EXIT=0, hồi quy Cassandra xanh. Nguồn sự thật cuối cùng là code; mọi
> khẳng định về hành vi ScyllaDB dưới đây đã được **đo trên container `scylladb/scylla:6.2`
> (6.2.3-0.20250119)** — không suy diễn. Spec mẹ: `spec/phase-4b-cassandra.md`; khuôn engine:
> `SPEC-INDEX.md` §3.3.

---

## 0. Kết luận & phạm vi

**ScyllaDB KHÔNG là `SystemType` mới.** Nó dùng chung engine `cassandra` (cùng giao thức CQL, cùng
catalog `system_schema.*`, cùng driver) và được nhận diện là **biến thể (flavor) `scylla`**.

Lý do (kiểm chứng):
1. Driver của nhánh Cassandra **chính là driver của ScyllaDB**: crate `scylla` 1.x
   (`src-tauri/Cargo.toml:94`, `drivers/cassandra.rs:1`) — tự nhận ra Scylla và route theo shard.
2. Toàn bộ tính năng Cassandra đi qua CQL + `system_schema.*` + `system.local/peers` — Scylla có đủ.
3. Tách `SystemType` mới = nhân đôi ~38 file frontend + mọi match arm backend chỉ để được cùng một
   bộ tính năng → trái nguyên tắc additive / không làm hỏng engine cũ.

**Phạm vi**: (a) nhận diện + thương hiệu ScyllaDB (logo, tên, phiên bản thật), (b) sửa **6 chỗ sai
đã đo được** khi chạy app trên Scylla, (c) tận dụng tính năng riêng của Scylla mà người dùng thấy
ngay (tablets, CDC, `DESCRIBE` phía server, `system.cluster_status`, cú pháp `BYPASS CACHE` /
`USING TIMEOUT`), (d) **chứng minh parity** bằng integration test trên container Scylla thật.

**Ngoài phạm vi**: Alternator (API kiểu DynamoDB — giao thức khác), Scylla Manager (backup S3,
repair), Scylla Enterprise (audit, LDAP, workload prioritization / service levels), Scylla Cloud API.

**Ràng buộc cứng** (theo `oracle-spec-rigor`): additive-only. Mọi hành vi mới gate theo
`flavor == Scylla`; đường Cassandra giữ nguyên — integration Cassandra cũ phải xanh không đổi.

---

## 1. Bằng chứng đo được trên ScyllaDB 6.2 (probe bằng cqlsh)

| # | Quan sát | Hệ quả với app hiện tại |
|---|---|---|
| P1 | `system.local.release_version = '3.0.8'` (giá trị tương thích). Phiên bản thật ở `system.versions` (`key='local'`, cột `version = '6.2.3-0.20250119.bff9ddde1283'`). Bảng `system.versions` **không có trên Cassandra**. | Test connection hiện "Cassandra 3.0.8" (`drivers/cassandra.rs:216-225`), Ring hiện 3.0.8 — sai. |
| P2 | Keyspace hệ thống của Scylla: `system_distributed_everywhere` (+ tuỳ bản: `system_replicated_keys`, `system_auth_v2`, `system_audit`). | `is_system_keyspace` (`cassandra.rs:1392`) không biết → lọt vào cây như keyspace của người dùng. |
| P3 | Mỗi secondary index tạo một **materialized view nền** tên `<index>_index` trong `system_schema.views` (đo: `orders_name_index`, `orders_local_index` bên cạnh MV thật `orders_by_name`); view nền có cột tính toán `idx_token` (`system_schema.computed_columns`). | Folder **Materialized Views** hiện cả view nền của index; Backup sinh `CREATE MATERIALIZED VIEW` cho chúng → restore sai/lỗi. |
| P4 | Bảng bật CDC sinh bảng `<table>_scylla_cdc_log` trong `system_schema.tables` (partitioner `com.scylladb.dht.CDCPartitioner` trong `system_schema.scylla_tables`; cột `cdc$stream_id`, `cdc$time`, `cdc$operation`…). Bảng log **ghi được** bằng CQL. | Cây hiện CDC log như bảng thường; Backup dump DDL + dữ liệu của log → restore tạo bảng thường trùng tên log. |
| P5 | Scylla 6.2 bật **tablets mặc định** (`system.config enable_tablets=true`). Keyspace tablets **không hỗ trợ CDC, LWT, counters** (đo: `CREATE TABLE … WITH cdc` → *"Cannot create CDC log … keyspace uses tablets"*; `INSERT … IF NOT EXISTS` → *"LWT is not yet supported with tablets"*). Trạng thái lưu ở `system_schema.scylla_keyspaces.initial_tablets` (có dòng = tablets; không có dòng = vnodes). | Backup chỉ ghi `CREATE KEYSPACE … WITH replication` (`commands/backup.rs:2073-2078`) → keyspace vnodes restore thành tablets → bảng CDC/counter/LWT **không tạo lại được**. Cây không cho biết keyspace dùng tablets. |
| P6 | `DESCRIBE KEYSPACE/TABLE …` chạy **phía server** (trả `keyspace_name,type,name,create_statement`), in đủ options (`cdc = {...}`, `tombstone_gc`, `tablets = {'enabled': false}` / `{'initial': 8}`) và `ALTER TABLE <t>_scylla_cdc_log WITH …` đúng thứ tự. (Lưu ý: `DESCRIBE … WITH INTERNALS` của cqlsh rơi về bản client-side và **mất** mệnh đề tablets — không dùng.) | `table_ddl`/`object_ddl` dựng lại từ `system_schema.columns` (`cassandra.rs:836, 870`) nên **mất** cdc/tablets/compaction… |
| P7 | `system.cluster_status` (Scylla-only, virtual): `peer, dc, host_id, load (bytes), owns (0..1), status (NORMAL…), tokens, up`. | Ring (`cassandra.rs:793-834`) đang **giả** state `"UN"` và load = số token; Scylla cho số thật. |
| P8 | Cú pháp riêng chạy được: `SELECT … BYPASS CACHE`, `SELECT … USING TIMEOUT 5s`, `INSERT … JSON`, UDF `LANGUAGE lua` (cần flag experimental). | Editor không tô màu/gợi ý `BYPASS`, `TIMEOUT`, `tablets`, `cdc`. |

Những thứ đo được là **giống Cassandra** (không cần sửa): `system_schema.{keyspaces,tables,columns,
views,types,functions,aggregates,indexes}` cùng cột; `system.peers`; `INSERT … JSON`; `SELECT JSON`;
tracing; `ALLOW FILTERING`; warning phía server (vd cảnh báo RF/tablets) trả về qua driver.

---

## 2. Bản đồ tính năng Cassandra hiện có → việc cần làm cho Scylla (parity)

Liệt kê từ code thật. "Kiểm" = phải có assertion trong integration Scylla (§6).

| Tính năng | Nguồn | Scylla | Việc |
|---|---|---|---|
| Connect / Test / Ping | `cassandra.rs:181,211,238` | chạy (cùng CQL) | Test hiện **ScyllaDB 6.2.3** (P1) — **S1** |
| CQL editor + paging + warnings | `commands/cassandra.rs:35` `cql_exec`; `cassandra.rs:256-360` | chạy | Kiểm paging (page token) + warning — **S6** |
| Consistency per-statement | `exec_cql_c`; `SqlWorkspace.svelte:207,1086` | chạy | Kiểm `ONE/QUORUM/LOCAL_QUORUM` — **S6** |
| Keyspace list | `cassandra.rs:557` | lọt keyspace hệ thống (P2) | Bộ lọc Scylla — **S1** |
| Keyspace tree | `cassandra.rs:656` `keyspace_tree` | view nền index + CDC log (P3,P4) | Ẩn view nền, gắn CDC log dưới bảng gốc, hiện tablets — **S2** |
| View DDL (table/view/type/index/function/aggregate) | `cassandra.rs:836,870` | mất options (P6) | Scylla → `DESCRIBE` phía server, lỗi thì rơi về bản dựng lại — **S2** |
| Ring | `cassandra.rs:793`; `CassandraRing.svelte` | state/load giả (P7), version sai (P1) | Scylla → `system.cluster_status` + `system.versions` — **S2** |
| Editable grid (apply by PK) | `cassandra.rs:851`, `cql_change_sql` `:1064`; `CassandraTableView.svelte` | chạy | Kiểm INSERT/UPDATE/DELETE — **S6** |
| `cassandra_columns` / Partitions node | `commands/cassandra.rs:169`; `cassandra.rs:626`; `mod.rs:804` | chạy | Kiểm — **S6** |
| Index Scanner | `cassandra.rs:763`; `mod.rs:839` | liệt kê đúng index (không lẫn view nền) | Kiểm — **S6** |
| Explain (tracing) | `commands/plan.rs:63,210`; `cassandra.rs:360` `trace_cql` | chạy (cần xác nhận event) | Kiểm có ≥1 bước trace — **S6** |
| Create/Drop/Truncate templates | `src/lib/sql/cassandra.ts`; `ObjectExplorer.svelte:2103-2219` | chạy | Template keyspace Scylla có `tablets` — **S5** |
| Backup / Restore (CQL dump) | `commands/backup.rs:1991-2135` | sai tablets/CDC/view nền (P3-P5) | Scylla → DDL từ `DESCRIBE KEYSPACE`, bỏ dữ liệu CDC log + view nền — **S3** |
| Users & Privileges (roles/permissions) | `CassandraUserManager.svelte`, `users/cassandra.ts`, `ObjectExplorer.svelte:261` | CQL như nhau | Kiểm 6 bước §1.9 SPEC-USERS-PRIVILEGES trên Scylla auth — **S6** |
| Export / Copy query | `src/lib/export/query.ts` (nhánh cassandra) | chạy | Không đổi |
| Lint CQL rule pack | `lint/mod.rs:422` | không báo lỗi cú pháp lạ (`BYPASS CACHE` an toàn) | Không đổi |

---

## 3. Thiết kế

### 3.1. Flavor & nhận diện (backend)

- `drivers/cassandra.rs`: `pub enum CassFlavor { Cassandra, Scylla }` (serde `"cassandra" | "scylla"`)
  + `pub struct CassServerInfo { flavor, version: String, tablets_enabled: Option<bool> }`.
- Nhận diện **một lần lúc connect**: `SELECT version FROM system.versions WHERE key = 'local'` —
  thành công ⇒ Scylla + version thật; lỗi (bảng không tồn tại) ⇒ Cassandra + `release_version`.
  `tablets_enabled` (Scylla) đọc `system.config WHERE name='enable_tablets'` (lỗi/không quyền ⇒ `None`).
  Kết quả lưu trong `CassandraDriver` (field mới), **không** query lại mỗi lệnh.
- `test()` dùng cùng probe ⇒ `server_version = "ScyllaDB 6.2.3"` / `"Cassandra 5.0.x"` (giữ định dạng cũ cho Cassandra).
- Command mới `cassandra_server_info(conn_id) -> CassServerInfo` (đăng ký `lib.rs`, wrapper `ipc.ts`,
  case `demo.ts`). Khi profile lưu trong storage có `cassandra_flavor` khác flavor đo được ⇒ **ghi lại
  profile** (chỉ field này; quick-connect `quick-*` không có trong storage thì bỏ qua).
- Profile thêm field `cassandra_flavor: String` (`""` = chưa biết · `"cassandra"` · `"scylla"`),
  `#[serde(default)]` ⇒ profile cũ đọc được, hợp đồng JSON không vỡ.

### 3.2. Cây Explorer & DDL (S2)

- `is_system_keyspace` thêm `system_distributed_everywhere`, `system_replicated_keys`,
  `system_auth_v2`, `system_audit` — chỉ áp khi flavor Scylla (tên này không tồn tại trên Cassandra,
  nhưng vẫn gate để đúng ràng buộc additive).
- `keyspace_tree` (Scylla):
  - **Ẩn view nền của index**: view `V` bị ẩn khi tồn tại index `I` trên cùng bảng gốc với
    `V == I + "_index"` (dữ liệu từ chính `system_schema.indexes` + `views`, không đoán theo hậu tố đơn thuần).
  - **CDC log**: bảng `T_scylla_cdc_log` mà `T` tồn tại ⇒ `CassTable.cdc_of = Some(T)` (field mới, optional).
    Frontend không hiện nó ở cấp folder Tables mà hiện **dưới bảng gốc** thành node `CDC log` (mở
    data, SELECT, View DDL như bảng). Bảng gốc có CDC ⇒ meta `CDC`.
  - `CassKeyspaceTree.tablets: Option<String>` (field mới): `"tablets"` / `"tablets · initial 8"` /
    `"vnodes"`; Cassandra ⇒ `None`. Node `replication` hiện thêm thông tin này.
- `object_ddl`/`table_ddl` (Scylla): `DESCRIBE <KIND> ks.name` phía server → nối `create_statement`
  theo thứ tự trả về. Kind map: table→`TABLE`, view→`MATERIALIZED VIEW`, type→`TYPE`, index→`INDEX`,
  function→`FUNCTION`, aggregate→`AGGREGATE`. Lỗi ⇒ rơi về bản dựng lại hiện có (không mất tính năng).
- `ring` (Scylla): `system.cluster_status` ⇒ state `UN/DN` (+ `UJ/UL/UM` theo status
  JOINING/LEAVING/MOVING), load = bytes đã format, owns = `owns*100 %` (null ⇒ `—`); version local =
  `system.versions`, peer = `—` (Scylla không báo version của peer qua CQL). Lỗi ⇒ rơi về đường cũ.

### 3.3. Backup / Restore (S3)

- Scylla: DDL lấy từ **`DESCRIBE KEYSPACE ks`** (giữ nguyên thứ tự server: keyspace → type →
  function/aggregate → table → index → view → `ALTER TABLE …_scylla_cdc_log`), áp `cql_idempotent`
  như cũ. Dòng `CREATE KEYSPACE` vì thế mang đúng `tablets = {...}` ⇒ keyspace vnodes restore lại vẫn vnodes.
- Dữ liệu: bỏ bảng CDC log (log do Scylla tự sinh khi ghi vào bảng gốc) + ghi chú trong kết quả;
  view nền index không bao giờ được dump (không nằm trong `tables`). Counter: giữ ghi chú hiện có.
- Restore: không đổi (chạy tuần tự statement).

### 3.4. Frontend: thương hiệu & form (S4)

- Logo: **simple-icons 16.35.0 `scylladb`** (CC0, source `scylladb.com/media-kit`, hex `#6CD5E7`), path
  chép nguyên văn vào `brand-icons.ts`. Cyan trên nền trắng chỉ đạt tương phản ~1.7:1 ⇒ vẽ trên **ô tối**
  (cùng cách đã làm cho ClickHouse) để đọc được ở cả 2 theme.
- Token: thêm `scylladb` vào map `SYS` của prototype (`accent:'#6CD5E7', badge:'SC', label:'ScyllaDB'`)
  + `EXPECTED_SYSTEMS` → `npm run tokens`. `scylladb` **không** vào `SystemKey`/`SYSTEMS`.
- Pure `src/lib/scylla/brand.ts`: `brandKey(profile|{system,cassandra_flavor})` → `'scylladb' | system`;
  `brandMeta(key)` (label/accent/badge); `isScylla(p)`.
- Nơi đổi theo brand: SystemPicker (thẻ **ScyllaDB** riêng, tạo profile `system:'cassandra',
  cassandra_flavor:'scylla'`), ConnectionForm (tile + tiêu đề + ô **Server type**: Detect
  automatically / Apache Cassandra / ScyllaDB; Test thành công trả "ScyllaDB …" ⇒ tự đặt scylla),
  ConnectionList (group theo brand: band **ScyllaDB** riêng), TabBar, StatusBar, header ObjectExplorer,
  SqlWorkspace (chip connection + dropdown), WelcomeScreen, BackupDialog, ManagerHeader (Users),
  CassandraRing (tiêu đề "Ring").
- Sau connect thành công một profile Cassandra: gọi `cassandra_server_info` → cập nhật
  `profile.cassandra_flavor` trong store (backend đã persist).

### 3.5. Editor (S5)

- Dialect editor Scylla = dialect Cassandra ∪ từ khoá Scylla (`BYPASS`, `CACHE`, `TIMEOUT`, `PRUNE`,
  `TABLETS`, `CDC`, `SERVICE_LEVEL`…), language id riêng `ds-scylla` (tô màu + autocomplete);
  Cassandra không đổi. SqlEditor nhận thêm prop tuỳ chọn `flavor`.
- `createTemplate('keyspace', …, {flavor:'scylla'})` thêm dòng `AND tablets = {'enabled': true}` kèm
  comment giải thích tablets không hỗ trợ CDC/LWT/counter. Cassandra giữ nguyên chuỗi cũ (unit ghim).

---

## 4. Các bước (implement tuần tự, mỗi bước có test)

| Bước | Nội dung | Test bắt buộc |
|---|---|---|
| **S1** | Flavor + version + system keyspaces + `cassandra_server_info` + persist flavor + profile field | Rust unit (pure: version string, system keyspace theo flavor, parse ring status); integration Scylla: test/connect ⇒ flavor Scylla + version thật, keyspace hệ thống bị lọc; integration Cassandra cũ: flavor = Cassandra |
| **S2** | Tree (ẩn view nền, CDC log `cdc_of`, tablets) + DDL qua DESCRIBE + Ring qua cluster_status | Rust unit (lọc view nền, gắn cdc_of, format tablets/ring); integration Scylla: tree đúng + DDL chứa `cdc =`/`tablets` + ring state UN, load > 0 |
| **S3** | Backup DDL từ DESCRIBE, bỏ dữ liệu CDC log | integration Scylla: keyspace vnodes + bảng CDC + counter + index + MV → backup → drop → restore ⇒ keyspace vẫn vnodes (`scylla_keyspaces` không có dòng), bảng còn CDC, index/MV đủ, row đúng, không có view nền thừa |
| **S4** | Brand (logo, token, picker, form, list, tabs…) | Vitest `scylla/brand.test.ts` + `color-identity`; e2e `scylladb.spec.ts` (picker → form ScyllaDB → connect demo → band ScyllaDB + logo) |
| **S5** | Editor dialect + template keyspace | Vitest dialect/template; e2e: `BYPASS` tô màu keyword trong tab Scylla, không gợi ý trong tab Cassandra |
| **S6** | Parity trên Scylla thật | integration `scylla_integration.rs`: CQL paging + warning + consistency, grid apply, partitions, index scan, explain trace, users 6 bước (auth), Cassandra regression `cassandra_*` xanh |

Gates mỗi bước: `npm run check` 0/0, vitest xanh, `npm run tokens:check` không vi phạm mới, Rust unit,
integration của bước EXIT=0. Integration chạy theo phương pháp chuẩn của CLAUDE.md (prebuild `--no-run`,
chạy đồng bộ có `timeout`, đọc log cùng lệnh).

---

## 5. Demo (browser/e2e)

Seam opt-in `?scylla=1` thêm 1 connection demo `ScyllaDB` (`system:'cassandra', cassandra_flavor:'scylla'`);
`cassandra_server_info` demo trả `{flavor:'scylla', version:'6.2.3', tablets_enabled:true}`. Danh sách
connection của mọi spec cũ không đổi.

## 6. Integration test

File mới `src-tauri/tests/scylla_integration.rs`, image `scylladb/scylla:6.2`, args
`--smp 1 --memory 750M --overprovisioned 1 --developer-mode 1`; container auth thêm
`--authenticator PasswordAuthenticator --authorizer CassandraAuthorizer`. Kết nối qua
`connect_translating_to` (container quảng bá IP nội bộ). Seed rồi đọc lại — không hard-code kết quả.

---

## Phụ lục — Quyết định

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Biến thể của `cassandra`, không phải `SystemType` mới | §0 |
| D2 | Nhận diện tự động bằng `system.versions`; ô Server type chỉ là gợi ý ban đầu, nhận diện thắng | Một nguồn sự thật, không bắt người dùng chọn đúng |
| D3 | Persist flavor đo được vào profile | Icon/nhóm đúng ngay lần mở app sau, trước khi kết nối |
| D4 | DDL Scylla qua `DESCRIBE` phía server, fallback bản dựng lại | Giữ đủ options (cdc/tablets/compaction) — P6 |
| D5 | CDC log hiện dưới bảng gốc, không ẩn | CDC log là thứ người dùng muốn đọc |
| D6 | View nền index ẩn hoàn toàn | Không phải object người dùng tạo; DDL của index đã đại diện |
| D7 | Logo trên ô tối | Tương phản cyan/trắng ~1.7:1 |
| D8 | Ngoài phạm vi: Alternator, Scylla Manager, Enterprise | Giao thức/sản phẩm khác |
