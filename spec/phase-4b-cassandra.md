# Phase Cassandra (giữa Phase 4 và Phase 5)

> ⚠️ **Deprecated — checklist kế hoạch lịch sử.** Cassandra đã hiện thực đầy đủ hơn (CQL editor qua
> `cql_exec`, editable grid, consistency per-statement, DDL viewer đầy đủ, Ring — xem C1–C5 trong `CLAUDE.md`).
> Nguồn sự thật: **code** + addendum Cassandra + `SPEC-INDEX.md`.

**Mục tiêu:** Hỗ trợ Cassandra đúng ngữ nghĩa wide-column — CQL editor (KHÔNG phải SQL), keyspace tree, Ring Topology.
**Thời gian ước tính:** **1–1.5 tuần** (vibe coding)
**Yêu cầu:** Phase 4 hoàn thành
**Nguồn chuẩn:** `CASSANDRA_SPEC_ADDENDUM.md` — khi mâu thuẫn về Cassandra, addendum ghi đè SPEC_v2.

> ⚠️ **Cảnh báo rủi ro:** prototype giả lập CQL như SQL nên self-test cho dương tính giả
> (JOIN "chạy được" vì data nằm trong RAM). Query engine Cassandra phải **viết lại theo CQL
> thật**, xếp ngang mức rủi ro với Structure Compare — không được "chỉ nối driver".

---

## Checklist

### 1. Connection Manager — Cassandra
- [ ] Badge `CS` màu accent `#1287B1` (bg `#0a2030`, border `#134f72`, fg `#5cc4e8`), port mặc định `9042`, nhóm **Wide Column**
- [ ] Icon SVG: ring node trung tâm + 6 node vệ tinh + nan hoa (copy từ `dbIcon()` trong HTML)
- [ ] Form fields riêng: **Contact points** (nhiều host, không chỉ 1), **Local datacenter** (bắt buộc cho load balancing), **Consistency level** mặc định (LOCAL_QUORUM / QUORUM / ONE / ALL / LOCAL_ONE / ...), keyspace mặc định (tùy chọn)
- [ ] Auth: username/password (PlainTextAuthProvider), SSL/TLS
- [ ] Test connection

### 2. Driver & backend
- [ ] Rust driver: **`scylla`** (scylla-rust-driver) — ghi cứng vào Cargo.toml
- [ ] Bắt buộc **prepared statements** + binding tham số (không nối chuỗi)
- [ ] Load balancing: `DefaultPolicy` gắn với local datacenter đã cấu hình
- [ ] Consistency level truyền **per-statement** (override được từ toolbar)
- [ ] Phân trang bằng **paging state** (`PagingState`) — giữ state giữa các lần fetch, KHÔNG dùng LIMIT/OFFSET

### 3. Explorer — Keyspace tree (`cassandraTree`)
- [ ] Cấu trúc: Keyspace → Tables / Materialized Views (MV) / User Types (UDT) / Functions (UDF + UDA nếu có) / Secondary Indexes (kèm loại: bình thường / SASI)
- [ ] Node table phân biệt trực quan **partition key** vs **clustering column** vs cột thường (meta `uuid · PK`, `timeuuid · CK` + `~N` row estimates như HTML)
- [ ] Keyspace hiển thị replication strategy + replication factor ở properties
- [ ] Metadata lấy từ query hệ thống thật (`system_schema.*`), không mock

### 4. CQL Editor + Execute (ràng buộc THẬT — phần dễ làm sai nhất)
- [ ] Tab editor tái dùng SQL editor + result grid (`type:'sql'`, `cql:true`, title `Untitled CQL`)
- [ ] **Cấm / không hỗ trợ:** JOIN (không sinh gợi ý, không autocomplete JOIN), subquery, UNION, OR tự do giữa các partition, `OFFSET`
- [ ] **WHERE hợp lệ:** đủ partition key (equality; `IN` hạn chế ở partition key cuối); clustering column theo đúng thứ tự prefix, range chỉ ở cột clustering cuối được ràng buộc; cột khác → cần secondary index hoặc `ALLOW FILTERING`
- [ ] `ALLOW FILTERING`: UI **cảnh báo** (anti-pattern, quét toàn cluster), KHÔNG tự thêm — người dùng chủ động bật
- [ ] `ORDER BY` chỉ trên clustering column (đúng thứ tự định nghĩa hoặc đảo toàn bộ)
- [ ] Consistency level per-statement: dropdown trên toolbar CQL, mặc định lấy từ connection
- [ ] Counter columns, `USING TTL` / `USING TIMESTAMP` trên INSERT/UPDATE
- [ ] Lightweight transactions `IF NOT EXISTS` / `IF <condition>` (cảnh báo chi phí Paxos cao)
- [ ] BATCH logged/unlogged — chỉ đảm bảo atomicity trong 1 partition, cảnh báo KHÔNG dùng để tăng tốc
- [ ] Shape trả về giữ `{ ok, result?: { cols, rows, total }, error? }`; `total`: không hiển thị số tuyệt đối — theo trang đã fetch + có/không còn trang sau
- [ ] Lint rule pack CQL (tầng 1, theo `QUERY_EDITOR_ERROR_HANDLING_ADDENDUM.md`): "CQL không hỗ trợ JOIN/subquery" (lỗi rõ), WHERE ngoài key → cảnh báo cần index hoặc ALLOW FILTERING, không OFFSET — dùng rule pack riêng, KHÔNG ép qua parser SQL
- [ ] Lỗi thực thi (tầng 2): map loại exception CQL (SyntaxError, InvalidRequest, Unauthorized, ReadTimeout...) sang `QueryError` message rõ; thường không có vị trí → statement-level

### 5. DDL specifics
- [ ] DDL viewer là tab read-only, sinh **CQL native** (không tái dùng generator SQL quan hệ)
- [ ] `CREATE KEYSPACE ... WITH replication = { 'class': 'NetworkTopologyStrategy', 'dc1': 3 }` — render đúng phần replication
- [ ] `CREATE TABLE ... PRIMARY KEY ((partition_cols), clustering1, clustering2)` — phân biệt composite partition key (ngoặc trong) vs clustering
- [ ] `WITH CLUSTERING ORDER BY (col DESC)`, compaction strategy, `default_time_to_live`, caching
- [ ] UDT (`CREATE TYPE`), UDF/UDA (`CREATE FUNCTION`), MV (`CREATE MATERIALIZED VIEW` + cảnh báo experimental), Secondary index / SASI (`CREATE INDEX` / `CREATE CUSTOM INDEX`)
- [ ] Structure Compare: Cassandra chỉ so sánh **Cassandra ↔ Cassandra** (diff theo keyspace/table/UDT/MV), KHÔNG so chéo với hệ quan hệ

### 6. Ring Topology
- [ ] Connection active là Cassandra → toolbar CQL hiện nút **Ring** → mở workspace tab `cassandra-ring`
- [ ] Query `system.peers` / `system.local` (hoặc metadata driver) lấy node thật: datacenter, rack, token range, trạng thái up/down, version — KHÔNG hardcode 6 node
- [ ] Hiển thị: node theo DC, replication factor, coordinator, token ownership

---

## Definition of Done
- SELECT với **đủ partition key** → trả đúng row
- SELECT WHERE trên cột không-index KHÔNG có `ALLOW FILTERING` → trả lỗi từ driver (error, không phải rows)
- Cùng query + `ALLOW FILTERING` → chạy được, UI đã cảnh báo trước
- JOIN → editor/engine từ chối (lint báo "CQL không hỗ trợ JOIN")
- Phân trang: fetch trang 2 qua paging state, không OFFSET
- DDL round-trip: `CREATE TABLE` composite partition key → đọc lại metadata đúng partition/clustering
- Ring Topology hiện node thật từ system tables

### Test (bắt buộc)
- Unit test đầy đủ cho toàn bộ logic phase này (lint rule pack CQL, map exception → QueryError, parse PRIMARY KEY composite...)
- Integration test đầy đủ cho Cassandra qua **testcontainers** — phủ đủ 6 kịch bản self-test ở mục 9 của `CASSANDRA_SPEC_ADDENDUM.md`

### UI đối chiếu 1:1 với `Database Studio.dc.html` (bắt buộc)
- Token màu/spacing/font grep trực tiếp từ HTML, không phỏng đoán
- Icon SVG Cassandra copy nguyên vẹn từ `dbIcon()`
- Bảng đối chiếu số đo các thành phần của phase (keyspace tree, toolbar CQL + consistency dropdown, Ring Topology) — không còn dòng lệch
- Snapshot/DOM test cho các component UI mới của phase

## Do NOT
- KHÔNG bê semantics SQL (JOIN, subquery, OFFSET, WHERE tự do) sang CQL editor
- KHÔNG tự thêm `ALLOW FILTERING` — chỉ khi người dùng chủ động bật, kèm cảnh báo
- KHÔNG nối chuỗi tham số vào CQL — luôn prepared statement + binding
- KHÔNG so sánh schema chéo Cassandra ↔ hệ quan hệ
- KHÔNG hardcode ring topology — lấy từ metadata thật
