# SPEC — Table Partitioning (per-engine)

> Trạng thái: **ĐÃ IMPLEMENT một phần** — 6/12 engine có đủ 4 năng lực (View · Manage · Create · Convert),
> Cassandra chỉ View (đúng bản chất), 5 engine còn lại N/A. Chi tiết ở **§2 Ma trận**; khoảng thiếu thật ở **§11**.
> Tài liệu này viết **SAU** code, mọi câu lệnh/catalog/hành vi đều **trích từ code thật** kèm `file:line`.
> Chỗ code đã có nhưng **chưa được test trên container** đánh dấu **[CẦN XÁC MINH]** kèm cách xác minh.
> Nguồn sự thật cuối cùng là **code**; khi tài liệu mâu thuẫn code → code đúng, sửa tài liệu.
> Quy tắc khi mở rộng: **additive-only** (§12) — thêm engine/năng lực KHÔNG được đổi hành vi engine đang chạy.
> Cập nhật 2026-09-17 (Oracle đã được verify trên container thật — xem §11).

---

## 0. Đối chiếu code — kiến trúc thực tế (đọc trước tiên)

Partition đi theo **đúng khuôn introspection sẵn có**, không có tầng riêng:

```
ObjectExplorer (node "Partitions" + ctx menu)      TableDesigner (tab "Partitioning")
AddPartitionDialog (wizard) · TableContextMenu (submenu Partitions)
        │  dùng pure builders
        ▼
src/lib/sql/partitions.ts        ← THUẦN, không I/O, unit-test (37 test)
        │  đọc dữ liệu qua
        ▼
explorer.loadTableDetail() → ipc.listPartitions() ──► command list_partitions
        ══════════════ ranh giới Tauri ══════════════
src-tauri/src/commands/schema.rs::list_partitions  (macro introspect!)
        ▼
drivers/mod.rs::LiveConnection::partitions()  ← match arm per variant
        ▼
drivers/<system>.rs::partitions()  → Vec<PartitionInfo>
```

| Thành phần | Vị trí | Ghi chú |
|---|---|---|
| Kiểu dữ liệu | `src-tauri/src/drivers/types.rs:282` `PartitionInfo` | 6 field, 4 optional (§3) |
| Dispatch | `src-tauri/src/drivers/mod.rs:616` | engine không hỗ trợ → `Ok(Vec::new())`, **không lỗi** |
| Command | `src-tauri/src/commands/schema.rs:86` `list_partitions` | đăng ký `lib.rs:196` |
| IPC | `src/lib/ipc.ts:872` `listPartitions(connId, schema, table)` | demo mock `demo.ts:788` |
| Cache FE | `stores/explorer.svelte.ts:22` `TableDetail.partitions` | nạp trong `loadTableDetail` (`:245`, `Promise.allSettled`) |
| Pure builders | `src/lib/sql/partitions.ts` (431 dòng, 9 export) | §5–§8 |
| Explorer node | `ObjectExplorer.svelte:1146-1186`, render `:2528` / `:3160` | node "Partitions" + ctx menu từng partition |
| Context menu bảng | `TableContextMenu.svelte:146-155` | submenu Partitions (ẩn cho ClickHouse — có nhóm ops riêng `:181-189`) |
| Designer | `TableDesigner.svelte:174` (tab) + `sql/table-designer.ts:302` / `:424` | weave clause vào `buildTableDdl` |
| Dialog | `AddPartitionDialog.svelte` + `stores/addpartition.svelte.ts` | wizard Add Partition |

**Test hiện có** (đã tồn tại trong repo, không phải kế hoạch):

- Unit: `src/lib/sql/partitions.test.ts` — **37 test** (8 trong đó là khối `Oracle partitioning`);
  `sql/table-designer.test.ts:82-148` — partition weave **4 dialect** (pg/mysql/clickhouse/mssql).
- Integration container thật: `src-tauri/tests/partitions_integration.rs` — **9 test** (target riêng):
  `pg_/mysql_/clickhouse_/mssql_partitions_introspected`, `pg_/mysql_add_partition_to_existing_table`,
  `pg_/mysql_/mssql_convert_existing_table_to_partitioned`. Mỗi test chạy **CHÍNH XÁC DDL mà builder sinh**
  rồi verify lại qua catalog. **Oracle nằm ở target riêng** `src-tauri/tests/oracle_o0.rs::oracle_partitions_end_to_end`
  (`#[ignore]` — ODPI-C cần Oracle Instant Client trên host; chạy bằng
  `cargo test --test oracle_o0 oracle_partitions_end_to_end -- --ignored --nocapture`).
- e2e: `tests/visual/partitions.spec.ts` (3 — trong đó 1 cho Oracle) + `tests/visual/table-designer.spec.ts:236` / `:265` (2).

---

## 1. Mô hình khái niệm — "partition" KHÔNG cùng nghĩa giữa các hệ

Đây là nguồn nhầm lẫn lớn nhất; spec này chỉ nói về **declarative table partitioning** (chia một bảng
thành nhiều phần lưu trữ theo khoá, trong suốt với câu SELECT):

| Khái niệm | Hệ | Có thuộc spec này không |
|---|---|---|
| Declarative table partitioning (RANGE/LIST/HASH) | PG · MySQL · MariaDB · MSSQL · Oracle | **Có** |
| Partition theo biểu thức của MergeTree | ClickHouse | **Có** (không có RANGE/LIST/HASH — chỉ expression) |
| Partition key của primary key (phân tán theo node) | Cassandra | **Chỉ View** — không có ADD/DROP partition; đây là *cách phân tán dữ liệu*, không phải đơn vị lưu trữ quản lý được |
| Partition của **topic** (đơn vị song song/offset) | Kafka | **Không** — khác hẳn; đã có ở Explorer streaming (`kafkaTopicRows` "N part") |
| Sharding / time-series collection | MongoDB | **Không** — `drivers/mod.rs:630` ghi rõ "Mongo sharding ≠ declarative partitioning" |
| Không có khái niệm | SQLite · Redis · NATS | **Không** |

---

## 2. Ma trận năng lực (verified trong code — 2026-09-17)

Ký hiệu: ✅ chạy được · ⚠ có nhưng hạn chế (nêu rõ) · — không áp dụng · ❌ thiếu (gap thật, xem §11)

| Engine | View | Manage ops | Create (designer) | Convert existing | Add partition | Unit | Integration | e2e |
|---|---|---|---|---|---|---|---|---|
| PostgreSQL | ✅ | ✅ detach/truncate/drop | ✅ RANGE/LIST/HASH | ✅ recreate | ✅ chạy trong dialog | ✅ | ✅ 3 | ✅ |
| MySQL | ✅ | ✅ truncate/rebuild/analyze/optimize/drop | ✅ (+COLUMNS) | ✅ in-place ALTER | ✅ chạy trong dialog | ✅ | ✅ 3 | — |
| MariaDB | ✅ | ✅ (dùng chung MySQL) | ✅ | ✅ | ✅ | ✅ | ❌ 0 | — |
| MSSQL | ✅ | ⚠ chỉ truncate | ✅ function+scheme | ✅ clustered index on scheme | ⚠ chỉ cảnh báo (cần SPLIT RANGE) | ✅ | ✅ 2 | — |
| ClickHouse | ✅ | ✅ detach/attach/freeze/drop | ✅ PARTITION BY expr | ✅ recreate | ⚠ không áp dụng (tự tạo khi INSERT) | ✅ | ✅ 1 | — |
| Oracle | ✅ | ✅ truncate/rebuild-index/drop | ✅ RANGE/LIST/HASH | ✅ MODIFY…ONLINE (verified) | ✅ chạy trong dialog | ✅ 8 | ✅ 1 (6 bước) | ✅ 1 |
| Cassandra | ✅ 1 dòng info (partition key) | — (đúng bản chất) | — | — | — | ✅ (trả `[]`) | ❌ 0 | — |
| SQLite | — trả rỗng | — | — | — | — | ✅ | — | — |
| MongoDB | — trả rỗng | — | — | — | — | ❌ chưa ghim | — | — |
| Redis / Kafka / NATS | — trả rỗng | — | — | — | — | ❌ chưa ghim | — | — |

Gate UI: `supportsPartitioning()` (`partitions.ts:332`) = `postgres · mysql · mariadb · mssql · clickhouse · oracle`;
`canConvertToPartitioned()` (`:327`) = **cùng danh sách**.

---

## 3. Hợp đồng dữ liệu — `PartitionInfo` (`drivers/types.rs:282`)

```rust
pub struct PartitionInfo {
    pub name: String,               // PG: tên bảng con · MySQL/Oracle: tên partition
                                    // MSSQL: "Partition N" · ClickHouse: partition id
                                    // Cassandra: "Partition key: (a, b)"
    pub method: String,             // RANGE | LIST | HASH | KEY | EXPRESSION | PARTITION KEY | ""
    pub key: Option<String>,        // khoá/biểu thức của BẢNG CHA (giống nhau mọi dòng)
    pub expression: Option<String>, // bound/giá trị của CHÍNH partition này
    pub rows: Option<i64>,          // ước lượng hoặc thật, tuỳ engine
    pub position: Option<i64>,      // số thứ tự 1-based (MySQL, MSSQL, Oracle)
}
```

Hai quy ước quan trọng:

1. **Bảng không partition → danh sách rỗng**, không phải lỗi. Explorer chỉ render node "Partitions" khi
   `detail.partitions.length > 0` (`ObjectExplorer.svelte:2528`); "Show Partitions" trên bảng thường →
   toast `"<table>" is not partitioned` (`:1163`).
2. `key` lặp lại ở mọi dòng (thuộc bảng cha) — Explorer dùng `partitions[0].key` làm meta của node
   (`:2535`). Mọi thứ per-partition nằm ở `name` / `expression` / `rows` / `position`.

---

## 4. Introspection per engine (nguyên văn theo code)

### 4.1 Partition không hiện trong CÂY Tables, nhưng vẫn nằm trong dữ liệu (chỉ PostgreSQL)

Partition của PG **là một bảng thật trong `pg_class`** (`relkind = 'r'`, `relispartition = true`), nên nếu
liệt kê catalog nguyên văn thì một bảng chia N partition sẽ hiện **N+1 dòng** và bảng cha chìm giữa các con.
Các hệ còn lại không có vấn đề này: MySQL/MariaDB (`information_schema.TABLES`), MSSQL (`sys.objects`),
Oracle (`all_tables`), ClickHouse (`system.tables`) đều chỉ có **một dòng cho bảng cha**.

**Quy tắc: lọc ở tầng HIỂN THỊ, KHÔNG ở nguồn.** `list_tables` là nguồn chung của autocomplete Query Editor,
Generate Scripts, Schema Compare, ER Diagram, Import/Export, Copy Table to…, Index Manager, Table Designer
(Ref. table), Command Palette và grant object-level — cắt partition ngay trong `tables()` sẽ **âm thầm làm hỏng
tất cả những thứ đó** (bản đầu của tính năng này mắc đúng lỗi ấy).

`PgDriver::tables()` do đó:
- **vẫn trả ĐỦ mọi relation**, chỉ gắn thêm `partition_of` = tên bảng cha qua
  `pg_inherits JOIN pg_class p … AND p.relkind = 'p'` — chỉ khớp cha là *partitioned table*, nên **bảng kế thừa
  kiểu cũ (`CREATE TABLE … INHERITS`) KHÔNG bị gắn cờ**, và PG 9.x (chưa có `relkind='p'`) không bị ảnh hưởng.
  Ẩn chỉ xảy ra ở **Explorer Tables folder** (cây chính + subtree foreign-db) và **Objects tab**
  (`filter(t => !t.partition_of)`);
- **cộng dồn `rows` + `data_length` của các partition vào bảng cha**, vì relation của bảng cha **không chứa dữ liệu**
  (`pg_total_relation_size` trên nó = 0 → Objects tab sẽ báo một bảng 3 MB là rỗng).
  `SUM()` trên `bigint` trả **numeric** ⇒ phải `::bigint` lại, nếu không `try_get::<i64>` trả `None` và cột hiện trống
  (cùng lớp lỗi với `CAST … AS SIGNED` của MySQL — integration đã bắt đúng lỗi này).

Partition vẫn mở được: node **Partitions** của bảng cha liệt kê chúng, và menu chuột phải có **Open Data / New Query**.

| Engine | Nguồn catalog | File | Ghi chú quan trọng |
|---|---|---|---|
| PostgreSQL | `pg_partitioned_table` + `pg_inherits` + `pg_get_partkeydef()` + `pg_get_expr(relpartbound)`; `rows` = `child.reltuples` | `postgres.rs:595` | Chỉ **con TRỰC TIẾP** (`inhparent = parent.oid`) → sub-partition lồng không hiện nested (§11.7). `reltuples` là **ước lượng** của ANALYZE |
| MySQL / MariaDB | `information_schema.PARTITIONS`, `GROUP BY PARTITION_NAME` | `mysql.rs:486` | **Sub-partition được gộp** vào partition cha (`SUM(TABLE_ROWS)`, `MAX(PARTITION_DESCRIPTION)`). `TABLE_ROWS` là ước lượng InnoDB. Dùng `CONVERT(… USING utf8mb4)` + helper `text()/text_opt()` vì cột I_S trả charset *binary* (bẫy đã ghi ở AUDIT-5) |
| MSSQL | `sys.partitions` + `sys.partition_schemes` + `sys.partition_functions` + `sys.partition_range_values` | `mssql.rs:705` | Bảng nằm trên **filegroup thường (không phải scheme) → 0 dòng** = coi như không partition. Boundary map qua `p.partition_number - CASE WHEN boundary_value_on_right = 1 THEN 1 ELSE 0 END` (đã verify bằng integration) |
| ClickHouse | `system.tables.partition_key` (nếu rỗng → trả `[]`) rồi `system.parts … AND active GROUP BY partition` | `clickhouse.rs:295` | `method` luôn là `"EXPRESSION"`. Chỉ đếm part **active**. `rows` do CH trả **dạng chuỗi** (UInt64) → parse chuỗi trước rồi mới `as_i64` |
| Oracle | `all_part_tables` + `all_part_key_columns` (LISTAGG) + `all_tab_partitions` | `oracle.rs:442` | `high_value` là LONG → lấy qua `jstr`. Bảng không partition → `all_part_tables` rỗng → trả `[]` |
| Cassandra | `columns_of()` lọc `kind == "partition_key"` | `cassandra.rs:626` | Trả **đúng 1 dòng** tổng hợp: `name = "Partition key: (a, b)"`, `method = "PARTITION KEY"` |
| SQLite · Redis · Kafka · NATS · MongoDB | — | `mod.rs:625-631` | Trả `Ok(Vec::new())` |

---

## 5. Manage — thao tác trên MỘT partition (`partitionOps`, `partitions.ts:30`)

Mọi op trả **SQL re-runnable**, mở trong SQL tab để người dùng xem trước khi chạy (không tự chạy).
`danger: true` → UI đánh dấu (thêm `…` vào nhãn, `ObjectExplorer.svelte:1181`).

| Engine | Các op sinh ra |
|---|---|
| PostgreSQL | `ALTER TABLE <t> DETACH PARTITION <child>;` · `TRUNCATE TABLE <child>;` ⚠ · `DROP TABLE <child>;` ⚠ — vì **partition PG chính là một bảng**, thao tác nhắm vào bảng con |
| MySQL / MariaDB | `ALTER TABLE <t> TRUNCATE/REBUILD/ANALYZE/OPTIMIZE PARTITION <p>;` + `DROP PARTITION` **chỉ khi** `method` khớp `^(RANGE\|LIST)` (HASH/KEY phải dùng `COALESCE PARTITION`) |
| MSSQL | `TRUNCATE TABLE <t> WITH (PARTITIONS (<n>));` (dùng `position`, mặc định 1) |
| ClickHouse | `ALTER TABLE <t> DETACH/ATTACH/FREEZE/DROP PARTITION <val>;` với `val = expression ?? name` |
| Oracle | `ALTER TABLE <t> TRUNCATE PARTITION <p>;` · `ALTER TABLE <t> MODIFY PARTITION <p> REBUILD UNUSABLE LOCAL INDEXES;` + `DROP PARTITION` chỉ RANGE/LIST |
| Cassandra · SQLite · khác | `[]` (không có op) |

**Rủi ro đã biết (ClickHouse)**: giá trị `partition` đọc từ `system.parts` được chèn **thô** vào câu lệnh.
Với partition key kiểu số (`toYYYYMM(d)` → `202401`) là hợp lệ; với key kiểu String, CH trả giá trị không
kèm nháy nên câu `DROP PARTITION abc` có thể sai cú pháp. **[CẦN XÁC MINH]** — cách xác minh: tạo bảng
`ENGINE = MergeTree PARTITION BY country ORDER BY x` trên container CH, chạy op sinh ra, xem `DROP PARTITION`
có cần `'...'` không; nếu có → quote khi giá trị không phải số (sửa **chỉ** nhánh `clickhouse` của `partitionOps`).

---

## 6. Create — bảng MỚI có partition (`buildPartitionCreate`, `partitions.ts:139`)

Trả về `{ clause, pre[], post[], warnings[] }`; `buildTableDdl` (`sql/table-designer.ts:302`) ghép:
`pre` chạy TRƯỚC `CREATE TABLE`, `clause` chèn vào trong câu CREATE, `post` chạy SAU.

| Engine | clause | pre | post | Ghi chú |
|---|---|---|---|---|
| PostgreSQL | `PARTITION BY <STRATEGY> (cols)` | — | `CREATE TABLE <child> PARTITION OF <t> FOR VALUES …` cho từng partition; HASH sinh `WITH (MODULUS n, REMAINDER i)` | Designer cảnh báo: khoá partition **phải nằm trong PRIMARY KEY** (`table-designer.ts:313`) |
| MySQL / MariaDB | `PARTITION BY [RANGE\|LIST][ COLUMNS] (expr) ( PARTITION … VALUES LESS THAN/IN (…) )`; HASH → `PARTITION BY HASH (expr) PARTITIONS n` | — | — | `columnsMode` bật → thêm `COLUMNS` |
| ClickHouse | `PARTITION BY <expr>` | — | — | Strategy bị bỏ qua + **warning** nếu ≠ RANGE |
| Oracle | `PARTITION BY <STRATEGY> (cols) ( PARTITION … )`; LIST dùng `VALUES (…)` (**không có `IN`**) | — | — | HASH → `PARTITIONS n` |
| MSSQL | `ON <ps_table> (cols)` | `CREATE PARTITION FUNCTION pf_<t> (<keyType>) AS RANGE RIGHT FOR VALUES (…);` + `CREATE PARTITION SCHEME ps_<t> AS PARTITION pf_<t> ALL TO ([PRIMARY]);` | — | LIST/HASH → **warning** "emitted a RANGE function instead". `keyType` lấy từ kiểu cột khoá (`table-designer.ts:307`) |
| khác | — | — | — | warning `Partitioning is not supported for <system>` |

---

## 7. Convert — bảng ĐANG CÓ → partitioned (`buildConvertToPartitioned`, `partitions.ts:246`)

Mỗi engine một chiến lược khác nhau vì phần lớn **không ALTER thẳng được**:

| Engine | Cách làm | Cảnh báo phát ra cho người dùng |
|---|---|---|
| MySQL / MariaDB | **Tại chỗ**: `ALTER TABLE <t> PARTITION BY …;` | (chỉ warning của builder create) |
| PostgreSQL | **Recreate**: `RENAME TO <t>_old` → `CREATE TABLE <t> (LIKE <t>_old INCLUDING DEFAULTS) PARTITION BY …` → tạo children → `INSERT … SELECT` → `DROP TABLE <t>_old` | Nói rõ: chỉ copy **cột + default**; **phải tự thêm lại index/constraint/FK**; bảng gốc bị DROP ở cuối |
| MSSQL | Tạo function + scheme (`pre`) rồi `CREATE CLUSTERED INDEX CIX_<t>_partition ON <t> (cols) ON ps_<t> (cols);` | Nếu bảng đã có clustered index → phải `WITH (DROP_EXISTING = ON)` |
| Oracle | `ALTER TABLE <t> MODIFY PARTITION BY … ONLINE;` | Yêu cầu **12cR2+**, local index được rebuild. **Đã verify** trên Oracle Free 23: bảng đang có dữ liệu chuyển thành partitioned tại chỗ, **không rename/copy/drop**, dữ liệu giữ nguyên |
| ClickHouse | **Recreate**: `RENAME TABLE` → `CREATE TABLE <t> AS <t>_old ENGINE = MergeTree PARTITION BY expr ORDER BY (expr)` → `INSERT … SELECT` → `DROP TABLE` | Phải chỉnh `ENGINE` / `ORDER BY` cho khớp bảng gốc (xem `SHOW CREATE TABLE`) trước khi chạy |

---

## 8. Add partition — bảng đã partition (`buildAddPartition`, `partitions.ts:341`)

| Engine | Sinh ra |
|---|---|
| PostgreSQL | `CREATE TABLE <schema>.<name> PARTITION OF <t> FOR VALUES …` (LIST → `FOR VALUES IN (…)`) |
| MySQL / MariaDB | `ALTER TABLE <t> ADD PARTITION (PARTITION <p> VALUES LESS THAN/IN (…));` |
| Oracle | `ALTER TABLE <t> ADD PARTITION <p> VALUES LESS THAN (…)` / `VALUES (…)` |
| MSSQL | ❌ không sinh SQL — trả `warning` (cần `ALTER PARTITION SCHEME … NEXT USED` + `ALTER PARTITION FUNCTION … SPLIT RANGE`, template có ở `addPartitionTemplate`) |
| ClickHouse | ❌ không sinh SQL — partition được tạo **tự động khi INSERT** |

`AddPartitionDialog` chỉ cho **Run trực tiếp** khi `system ∈ {postgres, mysql, mariadb, oracle}` — đúng bằng tập
hệ mà `buildAddPartition` sinh ra SQL chạy được; MSSQL/ClickHouse chỉ "Open in SQL tab".
`addPartitionTemplate` (`partitions.ts:396`) cung cấp mẫu sửa tay cho **cả 6 hệ**.
Dialog gửi chuỗi builder **nguyên văn (kèm `;`)** qua `exec_statement`; với Oracle điều đó chỉ an toàn vì driver
tự bỏ dấu chấm phẩy (`drivers/oracle.rs` `prepare_statement`) — integration ghim chính hành vi này.

---

## 9. Bề mặt UI (đang có)

0. **Badge "P" trên bảng partitioned** — icon bảng kèm huy hiệu tròn chữ "P" ở **góc TRÊN-phải**
   (`PARTITIONED_TABLE_SVG`, dùng qua `RowProps.svg` ở cả cây chính lẫn subtree database khác).
   Nguồn: `TableInfo.is_partitioned` do **driver** trả trong `list_tables` — phải biết TRƯỚC khi
   expand nên không thể suy từ `detail.partitions`. Per engine: PG `relkind='p'` · MySQL/MariaDB
   `EXISTS(information_schema.PARTITIONS … PARTITION_NAME IS NOT NULL)` · MSSQL `sys.partition_schemes`
   qua `sys.indexes (index_id IN (0,1))` · Oracle `all_tables.partitioned='YES'` · ClickHouse
   `system.tables.partition_key <> ''` · SQLite/Mongo `None`.
   Icon = **chính nét bảng của bộ icon Explorer** (`PATHS.table` trong `src/lib/explorer/icons.ts`)
   thu nhỏ về góc dưới-trái, cộng badge ở góc trên-phải — bảng partitioned vẫn phải đọc ra là một
   BẢNG, chỉ khác là có huy hiệu. Dựng bằng `partitionedTableIcon()` nên không bao giờ lệch tông
   với icon bảng thường. Vẽ cho ô 15px: **chữ P là `<path>` chứ không phải `<text>`**
   (ở ~7px font phụ thuộc hinting → ra vệt mờ); tỉ lệ bảng/badge chọn bằng cách render 4 phương án
   ở đúng 15px rồi so bằng mắt (badge quá to thì nuốt mất nét bảng).
   Badge có `data-badge="partitioned"` + `aria-label="Partitioned table"` để test assert được.
   Nền badge = token **`--badge-part`** (`#b45309`, app.css, token-exempt) — **cố ý không theme-aware**:
   chữ luôn là `--hex-fff`, mà bản dark của `--sacc-amber` (`#f0c674`) quá nhạt cho chữ trắng.
   **Bẫy MySQL**: correlated EXISTS phải alias bảng ngoài (`information_schema.TABLES t`) —
   PARTITIONS có cùng tên cột TABLE_SCHEMA/TABLE_NAME, không alias thì tương quan thành `p.x = p.x`
   và MỌI bảng bị badge (có integration đối chứng).
1. **Explorer → node "Partitions"** dưới mỗi bảng (cả cây chính lẫn subtree database khác):
   hiện khi `partitions.length > 0`; meta = `partitions[0].key`; mỗi leaf hiện
   `expression · N rows` (`partMeta`, `:1147`). Chuột phải leaf → **Open Data · New Query** (chỉ PostgreSQL —
   partition PG là bảng thật) / Copy name / Copy bound / các op §5 / Refresh.
   **Danh sách Tables KHÔNG liệt kê partition** — xem §4.1.
   **PostgreSQL: mỗi partition mở ra NHƯ MỘT BẢNG** — expandable, nạp qua chính
   `explorer.loadTableDetail(cid, schema, <tên partition>)` và render columns · Indexes ·
   Constraints (+ sub-partition lồng). Chỉ PG, vì chỉ PG mới có relation thật để introspect
   (`partitionIsTable`); các engine khác partition là đơn vị lưu trữ của bảng cha nên vẫn là leaf.
   Cả hai cây dùng CHUNG snippet `partitionsNode` nên hành vi không lệch nhau.
   Cột của bảng VÀ của partition đều nằm trong folder **"Columns"** (ngang hàng Indexes /
   Constraints / Partitions, đóng mặc định) — cả 3 nơi: cây chính, foreign-db subtree, partition.
2. **Context menu bảng → submenu "Partitions"** (`TableContextMenu.svelte:146`): *Show Partitions* (mở node,
   toast nếu bảng không partition) + *Add Partition…*. ClickHouse dùng nhóm ops riêng ở menu CH (`:181-189`).
3. **Table Designer → tab "Partitioning"** (chỉ khi `supportsPartitioning`): bảng mới = tạo; bảng đã partition =
   hiện cấu hình **read-only** (`partLocked`, `:81`) + thêm partition mới; bảng chưa partition = bật để
   **convert** (`partConvert`, `:112`). Có preview script ngay trong tab.
4. **AddPartitionDialog**: form có cấu trúc (PG RANGE = From/To), live script, Run hoặc Open in SQL tab.

---

## 10. Đường thực thi + bẫy per engine (bắt buộc đọc khi sửa)

- **MySQL/MariaDB**: DDL đi qua `exec_statement` (**TEXT protocol**) — `sqlx::query().execute()` dùng prepared
  protocol và bị lỗi **1295** với một số DDL (ghi chú trong `drivers/mysql.rs`). Introspection `information_schema`
  phải dùng `text()/text_opt()` vì cột trả charset binary.
- **MSSQL**: `CREATE/ALTER/DROP` (gồm PARTITION FUNCTION/SCHEME) phải đi **raw batch** qua `simple_query`
  (`is_raw_batch`, `mssql.rs:744`) — `sp_executesql` không giữ được ngữ cảnh batch.
- **PostgreSQL**: `INCLUDING DEFAULTS` của convert **không** mang index/constraint/FK — cảnh báo đã có trong
  script, đừng bỏ.
- **ClickHouse**: chạy qua HTTP/reqwest; không có ALTER PARTITION BY tại chỗ.
- **Oracle**: câu lệnh gửi driver không kèm `;` (splitter `splitStatements(sql, 'oracle')` tách trước);
  ODPI-C cần **Oracle Instant Client** trên host mới chạy được integration.
- **Cassandra**: không có op nào — mọi "partition" chỉ để hiển thị.

---

## 11. Khoảng THIẾU thật (gap) — xếp theo mức rủi ro

| # | Gap | Bằng chứng | Đề xuất |
|---|---|---|---|
| ~~1~~ | ~~Oracle không có test nào~~ — **ĐÃ XONG 2026-09-17** | 8 unit (`describe('Oracle partitioning')`) + `oracle_partitions_end_to_end` chạy **EXIT=0** trên `gvenzl/oracle-free:23-slim-faststart` + 1 e2e | — |
| ~~2~~ | ~~Oracle không Run được Add Partition~~ — **ĐÃ XONG 2026-09-17** | `canRun` nay gồm `oracle`; ADD PARTITION verified trên DB thật (bước 2 của integration) | — |
| ~~3~~ | ~~Designer mô tả SAI khi convert cho Oracle/ClickHouse~~ — **ĐÃ XONG 2026-09-17** | `TableDesigner.svelte` có nhánh riêng cho `oracle` + `clickhouse`; nhánh `{:else}` cuối (không canConvert) đổi sang câu generic, không nhắc ClickHouse nữa | — |
| 4 | **MariaDB không có integration partition** (MySQL có) | `partitions_integration.rs` | Nhân bản test MySQL cho container MariaDB (MariaDB có khác biệt riêng về `SUBPARTITION` / `KEY`) |
| 5 | **Không ghim hành vi "trả rỗng"** của SQLite/Mongo/Redis/Kafka/NATS ở tầng dispatch | `mod.rs:625-631` không có test | 1 unit Rust nhỏ hoặc 1 test frontend: `listPartitions` trên các hệ đó → `[]`, không throw |
| 6 | **MSSQL Add Partition chỉ cảnh báo** | `partitions.ts:369` | Cần introspect tên function/scheme thật từ `sys.partition_schemes` (chưa có) rồi sinh `NEXT USED` + `SPLIT RANGE` |
| 7 | **Sub-partition không hiện** | PG: chỉ con trực tiếp (`pg_inherits`); MySQL: gộp `SUBPARTITION` vào cha; Oracle: chưa dùng `all_tab_subpartitions` | Thêm cấp lồng trong node Partitions (mở rộng `PartitionInfo` bằng field **optional** để không phá hợp đồng) |
| 8 | **e2e/demo chỉ có fixture kiểu PostgreSQL** (`enrollments`, RANGE) | `demo.ts:788` | Thêm fixture theo `system` (MySQL description, MSSQL "Partition N", CH id) để e2e phủ UI các hệ còn lại |
| 9 | ClickHouse partition value **không quote** khi là chuỗi | §5 | **[CẦN XÁC MINH]** trên container trước khi sửa |

Không gap nào ở trên làm hỏng chức năng đang chạy — tất cả là **thiếu phủ test** hoặc **hạn chế đã biết**.

**Phát hiện khi verify Oracle (2026-09-17)** — hai điều đáng ghi, không phải gap:
- Driver Oracle **tự bỏ dấu `;` cuối** (`drivers/oracle.rs` `prepare_statement`, PL/SQL block thì giữ), nên
  dialog gửi chuỗi builder nguyên văn vẫn chạy. Giả thuyết ban đầu "Oracle từ chối `;` nên phải split" là **SAI**
  — đã thử trên DB thật (`Ok`), nên bản sửa **không** thêm `splitStatements` vào dialog.
- Builder quote khoá partition (`"CREATED_AT"`). Oracle fold tên không-quote thành CHỮ HOA, nên khoá lấy từ
  introspection (luôn HOA) khớp đúng; nhưng nếu người dùng **tự gõ** tên cột chữ thường trong Table Designer thì
  `"created_at"` sẽ KHÔNG khớp cột `CREATED_AT` → lỗi "invalid identifier". Chưa xử lý (Oracle-only quirk).

---

## 12. Definition of Done (khi thêm/sửa partition cho một engine)

1. **Additive-only**: chỉ thêm nhánh `case '<system>'` trong `partitions.ts` / match arm trong `mod.rs` /
   nhánh UI mới. Không đổi chữ ký hàm đang dùng, không đổi hành vi engine khác (`PartitionInfo` chỉ được
   mở rộng bằng field **optional**).
2. **Introspection**: `<system>.rs::partitions()` trả `[]` cho bảng không partition (không lỗi), và
   arm trong `mod.rs::partitions` được nối.
3. **Pure builder + unit test**: mọi SQL sinh ra phải đi qua `partitions.ts` và có unit test (Vitest).
4. **Integration container thật**: tạo bảng partition bằng **chính DDL builder sinh ra**, rồi verify lại
   bằng `partitions()` / catalog — theo đúng khuôn 9 test hiện có. Engine cần binary ngoài (Oracle) được
   phép `#[ignore]` kèm ghi rõ lý do.
5. **Demo + e2e**: `demo.ts` có case cho `list_partitions` của hệ đó (nếu không, browser/Playwright vỡ) và
   ít nhất 1 e2e cho bề mặt UI mới.
6. **Gate UI**: cập nhật `supportsPartitioning` / `canConvertToPartitioned` **và** chuỗi mô tả trong
   `TableDesigner` (bài học gap #3: thêm hệ vào danh sách mà quên chuỗi mô tả = nói sai với người dùng).
7. **Gates**: `npm run check` 0/0 · `npx vitest run` · `npm run tokens:check` không phát sinh vi phạm mới.

---

## 13. Điểm mở rộng — thêm một engine vào Partitions

1. `src-tauri/src/drivers/<system>.rs` → `pub async fn partitions(&mut self, schema, table) -> Result<Vec<PartitionInfo>, QueryError>`.
2. `src-tauri/src/drivers/mod.rs:616` → thêm match arm (mặc định `Ok(Vec::new())` nếu không áp dụng).
3. `src/lib/sql/partitions.ts` → thêm nhánh vào `partitionOps` / `buildPartitionCreate` /
   `buildConvertToPartitioned` / `buildAddPartition` / `addPartitionTemplate`, cập nhật 2 hàm gate.
4. `src/lib/demo.ts` → fixture `list_partitions`.
5. UI: không cần sửa nếu engine dùng chung khuôn (Explorer/ContextMenu/Designer đã gate bằng
   `supportsPartitioning`); chỉ sửa chuỗi mô tả convert trong `TableDesigner`.
6. Test theo §12.4–12.5.

---

## 14. Engine KHÔNG áp dụng — lý do (để không ai "bổ sung" nhầm)

- **SQLite**: không có declarative partitioning. Cách chia dữ liệu duy nhất là `ATTACH` nhiều file + view
  `UNION ALL` — mô hình khác hẳn; nếu muốn làm thì viết spec riêng, **không** nhét vào node Partitions.
- **MongoDB**: tương đương gần nhất là **sharding** (cụm) và **time-series collection**; driver hiện chưa
  introspect cả hai (`grep shard|timeseries drivers/mongo.rs` = rỗng). Nếu làm → tính năng riêng, không
  dùng `PartitionInfo`.
- **Redis**: phân mảnh ở tầng cluster (hash slot), không thuộc bảng/collection.
- **Kafka**: "partition" là của **topic** — đã hiển thị ở Explorer streaming; không liên quan tới bảng.
- **NATS**: stream/subject, không có partition.
- **Cassandra**: đã hiển thị partition key (1 dòng info); **không** thêm ADD/DROP partition vì Cassandra
  không có thao tác đó.
