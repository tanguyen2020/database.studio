# Cassandra — Spec Addendum (bổ sung & sửa lỗi cho SPEC_v2)

> Bổ sung cho `DATABASE_STUDIO_SPEC_v2.md` mục 2, 4, 9 và `README.md` mục
> "MariaDB, Cassandra, SQLite — specifics". Khi có mâu thuẫn về **Cassandra**,
> file này ghi đè SPEC_v2. Lý do tồn tại: prototype giả lập CQL như SQL nên
> self-test cho kết quả dương tính giả — phần dưới nói rõ cái gì thật, cái gì phải viết lại.

---

## 0. SỬA NHÃN TRẠNG THÁI (đọc trước tiên)

SPEC_v2 mục 4.2 đánh Query Engine là ✅ REAL và ghi "SELECT+JOIN trả result đúng,
JOIN ghép cột đúng" cho Cassandra. **Với Cassandra, nhãn này SAI.**

- Prototype chạy engine in-memory, xử lý CQL như thể là SQL quan hệ → JOIN/WHERE
  tự do "chạy được" chỉ vì dữ liệu nằm trong RAM.
- CQL thật KHÔNG phải SQL. Không có JOIN, không subquery, WHERE bị giới hạn nặng.

**Nhãn đúng cho Cassandra Query Engine: ⛔ HARDCODED/giả — viết lại theo CQL thật.**
Xếp ngang mức rủi ro với Structure Compare, không được "chỉ nối driver".

---

## 1. Identity (lấy từ README, đối chiếu lại token trong `.dc.html`)

| Thuộc tính | Giá trị |
|---|---|
| Accent | `#1287B1` |
| Background | `#0a2030` |
| Border | `#134f72` |
| Text on bg | `#5cc4e8` |
| Badge | `CS` |
| Icon | ring node trung tâm + 6 node vệ tinh + nan hoa (inline SVG trong `dbIcon()`) |
| Port mặc định | `9042` |
| Quoting định danh | double-quote `"..."` |
| Nhóm | Wide Column |
| Connection mẫu | **Profiles Cassandra** (`app_ks`, PROD, SSL) |

---

## 2. Connection fields

Ngoài host/port/user/password/SSL chung, Cassandra cần thêm:

- **Contact points**: cho phép nhiều host (danh sách), không chỉ 1.
- **Local datacenter** (bắt buộc với `NetworkTopologyStrategy` / load balancing policy).
- **Consistency level** mặc định: `LOCAL_QUORUM` / `QUORUM` / `ONE` / `ALL` / `LOCAL_ONE` / …
  — đây là thuộc tính **per-query**, cho phép override ở từng statement.
- Keyspace mặc định (tùy chọn).
- Auth: username/password (PlainTextAuthProvider). SSL/TLS.

---

## 3. Explorer tree (`cassandraTree`)

Cấu trúc cây theo mô hình wide-column, KHÔNG dùng khái niệm "schema" kiểu quan hệ:

```
Keyspace (app_ks)
├── Tables            → mỗi table hiện Partition Key + Clustering Key rõ ràng
├── Materialized Views (MV)
├── User Types (UDT)
├── Functions (UDF)   + Aggregates (UDA nếu có)
└── Secondary Indexes (kèm loại: bình thường / SASI)
```

- Node table phải phân biệt trực quan **partition key** vs **clustering column** vs cột thường
  (đây là thông tin quan trọng nhất để người dùng viết WHERE hợp lệ).
- Mỗi keyspace hiển thị replication strategy + replication factor ở properties.

---

## 4. CQL Editor + Execute — ràng buộc THẬT (phần dễ làm sai nhất)

Tab editor tái dùng SQL editor + result grid (`type:'sql'`, `cql:true`, title `Untitled CQL`) — OK về UI.
Nhưng **semantics execute phải theo CQL, không theo SQL:**

**Cấm / không hỗ trợ:**
- **JOIN** — không tồn tại trong CQL. Không sinh gợi ý JOIN, không autocomplete JOIN.
- Subquery, UNION, arbitrary OR across partitions.
- `OFFSET` — không có. Phân trang bằng **paging state** của driver, không phải LIMIT/OFFSET.

**WHERE hợp lệ chỉ khi:**
- Chỉ định **đầy đủ partition key** (equality; `IN` cho phép ở partition key cuối, hạn chế).
- Filter clustering column theo đúng thứ tự định nghĩa (prefix), toán tử range chỉ ở cột clustering cuối cùng được ràng buộc.
- Cột khác → phải có secondary index, hoặc thêm `ALLOW FILTERING`.

**`ALLOW FILTERING`:** khi query cần nó, UI nên **cảnh báo** (anti-pattern, quét toàn cluster) chứ
không âm thầm thêm. Cho người dùng chủ động bật.

**Khác cần đúng:**
- `ORDER BY` chỉ trên clustering column, theo thứ tự đã định nghĩa hoặc đảo ngược toàn bộ.
- `LIMIT` có, nhưng lấy trang tiếp theo qua paging state (`PagingState`), không phải OFFSET.
- Consistency level: cho phép set per-statement (dropdown trên toolbar CQL, mặc định lấy từ connection).
- Counter columns, TTL trên INSERT/UPDATE (`USING TTL`), `USING TIMESTAMP`.
- Lightweight transactions: `IF NOT EXISTS` / `IF <condition>` (Paxos — cảnh báo chi phí cao).
- BATCH: logged/unlogged — chỉ để đảm bảo atomicity trong 1 partition, KHÔNG dùng để tăng tốc.

**Shape trả về:** giữ nguyên contract mà grid đang dùng
`{ ok, result?: { cols, rows, total }, error? }`. Riêng `total`: Cassandra không cho count tổng
rẻ như SQL — cân nhắc không hiển thị "3,842 rows" tuyệt đối, mà theo trang đã fetch + có/không còn trang sau.

---

## 5. DDL specifics

- `CREATE KEYSPACE ... WITH replication = { 'class': 'NetworkTopologyStrategy', 'dc1': 3 }`
  (hoặc `SimpleStrategy` + `replication_factor` cho dev). DDL viewer phải render đúng phần replication.
- `CREATE TABLE ... PRIMARY KEY ((partition_key_cols), clustering_col1, clustering_col2)`
  — phân biệt rõ composite partition key (ngoặc trong) vs clustering.
- `WITH CLUSTERING ORDER BY (col DESC)`, compaction strategy, `default_time_to_live`, caching.
- UDT: `CREATE TYPE`. UDF/UDA: `CREATE FUNCTION` (cần server bật `enable_user_defined_functions`).
- Materialized View: `CREATE MATERIALIZED VIEW ... AS SELECT ... PRIMARY KEY ...` (kèm cảnh báo experimental).
- Secondary index / SASI: `CREATE INDEX` / `CREATE CUSTOM INDEX`.
- DDL viewer là tab read-only, sinh CQL native theo đúng dialect Cassandra (không tái dùng generator SQL quan hệ).

**Structure Compare / Migrate:** Cassandra KHÔNG tham gia so sánh chéo với hệ quan hệ.
Nếu có compare, chỉ Cassandra ↔ Cassandra, và diff theo keyspace/table/UDT/MV, không theo `information_schema`.

---

## 6. Ring Topology

- Khi connection đang active là Cassandra (`isCassandraConn`), toolbar CQL hiện nút **Ring**
  → mở workspace tab `cassandra-ring`.
- Prototype render ring SVG tĩnh. Bản thật: query `system.peers` / `system.local` (hoặc metadata
  của driver) để lấy node thật, datacenter, rack, token range, trạng thái up/down, version.
- Hiển thị: node theo DC, replication factor, coordinator, token ownership. Không hardcode 6 node.

---

## 7. Driver & tầng backend

- Rust driver: **`scylla`** (scylla-rust-driver) — khuyến nghị hơn `cdrs`/`cdrs-tokio`: async gốc,
  bảo trì tốt, prepared statement + paging + load balancing policy đầy đủ. Chọn 1, ghi cứng vào Cargo.toml.
- Bắt buộc: **prepared statements** (chống injection + hiệu năng), truyền tham số qua binding
  chứ không nối chuỗi (prototype nối chuỗi — không bê lên production).
- Paging: giữ `PagingState` giữa các lần fetch để cuộn grid, không query lại từ đầu.
- Consistency level truyền theo từng statement.
- Load balancing: `DefaultPolicy` gắn với local datacenter đã cấu hình ở connection.

---

## 8. Prototype fake gì / phải build gì

| Hạng mục | Prototype | Bản thật |
|---|---|---|
| execSql (CQL) | in-memory, giả lập như SQL, JOIN "chạy" | driver `scylla` thật, chặn JOIN, WHERE theo key, ALLOW FILTERING có cảnh báo |
| Explorer tree | mock keyspace `app_ks` | query metadata thật (keyspaces/tables/UDT/UDF/MV/index) |
| Ring Topology | SVG tĩnh 6 node | topology thật từ system tables/metadata |
| Consistency level | field UI | áp vào từng statement thật |
| total rows | số cứng | bỏ hoặc thay bằng trạng thái paging |
| DDL viewer | có thể tái dùng SQL | sinh CQL native |

---

## 9. Self-test cần thay (sau khi có backend)

Bỏ assertion "SELECT+JOIN trả result đúng" cho Cassandra. Thay bằng integration test trên cluster thật (hoặc container):

1. SELECT với **đủ partition key** → PASS, trả đúng row.
2. SELECT với WHERE trên cột không-index, KHÔNG có `ALLOW FILTERING` → **phải trả lỗi từ driver** (kỳ vọng: error, không phải rows).
3. Cùng query + `ALLOW FILTERING` → chạy, UI đã cảnh báo trước đó.
4. JOIN → editor/engine từ chối (không có khái niệm JOIN).
5. Phân trang: fetch trang 2 qua paging state, không dùng OFFSET.
6. DDL round-trip: `CREATE TABLE` với composite partition key → đọc lại metadata thấy đúng partition/clustering.

---

## 10. Do NOT (Cassandra)

- KHÔNG bê semantics SQL (JOIN, subquery, OFFSET, WHERE tự do) sang CQL editor.
- KHÔNG tự thêm `ALLOW FILTERING` giúp người dùng — chỉ khi họ chủ động bật, kèm cảnh báo.
- KHÔNG nối chuỗi tham số vào câu CQL — luôn prepared statement + binding.
- KHÔNG so sánh schema chéo Cassandra ↔ hệ quan hệ.
- KHÔNG tin nhãn ✅ REAL của Query Engine cho Cassandra trong SPEC_v2 — đã sửa ở mục 0.
- KHÔNG hardcode ring topology — lấy từ metadata thật.
