# ClickHouse — Spec Addendum (bổ sung & làm rõ cho SPEC_v2)

> Bổ sung cho `DATABASE_STUDIO_SPEC_v2.md` mục 4, 9 và `README.md` mục
> "ClickHouse — specifics" + "TTL Policy Viewer". Khi có mâu thuẫn về **ClickHouse**,
> file này ghi đè SPEC_v2. Mục đích: ClickHouse nằm trên đường `selRel === true`
> (dùng chung SQL editor + editable grid + ER/designer/compare với hệ quan hệ), nên
> Claude Code dễ đối xử với nó như Postgres. Nó KHÔNG phải Postgres — đây là cột (OLAP),
> UPDATE/DELETE là mutation bất đồng bộ, không có transaction, key không unique.

---

## 0. LÀM RÕ TRẠNG THÁI (đọc trước tiên)

- **execSql (SELECT/WHERE/JOIN):** ClickHouse là SQL thật (có JOIN), nên logic gần đúng hơn
  Cassandra. Nhưng data source vẫn là store in-memory giả → phải nối client thật. Giữ shape trả về.
- **Panel engine badges + TTL Viewer:** 🟠 MOCK-UI → nối `system.*` thật.
- **BẪY chính:** editable grid + "pending changes → Execute" của đường relational
  KHÔNG áp dụng nguyên si cho ClickHouse. UPDATE/DELETE ở ClickHouse là **mutation async
  qua `ALTER TABLE`**, không phải cập nhật row tức thời trong transaction. Nếu bê nguyên
  cơ chế commit của Postgres sang → sai về mặt ngữ nghĩa (xem mục 7).

---

## 1. Identity (lấy từ README, đối chiếu token trong `.dc.html`)

| Thuộc tính | Giá trị |
|---|---|
| Accent | `#FFCC00` |
| Background | `#33290a` |
| Border | `#665514` |
| Text on bg | `#ffe066` |
| Badge | `CH` |
| Icon | 4 thanh cột dọc (3 cao + 1 thấp), tô `#FFCC00` (inline SVG) |
| Port mặc định | `8123` (HTTP) / `9000` (native TCP) |
| Quoting định danh | backtick `` `...` `` |
| Nhóm | Analytical / Columnar (OLAP) — nhưng vẫn là "SQL connection" (`selRel`) |
| Connection mẫu | **Analytics ClickHouse** (`analytics` db) |

---

## 2. Connection fields

- Host, port (8123 HTTP hoặc 9000 native — chọn protocol), database, user, password, SSL.
- Chọn giao thức: HTTP (8123) hay native (9000) — ảnh hưởng driver.
- (Tùy chọn, có thể để phase sau) cluster name cho `ON CLUSTER`.

---

## 3. Explorer tree (`clickhouseTree`)

```
Databases (default, system, analytics, …)
├── Tables        → kèm engine meta: MergeTree / ReplacingMergeTree / SummingMergeTree / …
├── Views         → gồm cả Materialized View
├── Dictionaries  → loại: flat / hashed / …
└── Functions
```

- Node table hiển thị **engine** ngay trên tên (badge engine) — thông tin quan trọng nhất
  vì hành vi table phụ thuộc engine.
- Database `system` là read-only, dùng để introspection.

**Schema mẫu (từ prototype, giữ khi seed demo):**
- `events` — `MergeTree`, `PARTITION BY toYYYYMM(event_date)`,
  `ORDER BY (event_date, event_type, user_id)`, `TTL event_date + INTERVAL 90 DAY`;
  cột gồm `Date`, `LowCardinality(String)`, `UInt64`, `UUID`, `String CODEC(ZSTD(3))`.
- `page_views` — `MergeTree`, partition theo tháng.
- `sessions` — `ReplacingMergeTree(updated_at)`, cột `Nullable(DateTime)`.
- `metrics_daily` — `SummingMergeTree((events, revenue))`, `Float64`.
- Open Data trả tổng lớn thực tế (ví dụ `events ≈ 18.4M rows`) — grid phải xử lý số hàng lớn.

---

## 4. SQL editor + Execute — ngữ nghĩa ClickHouse (khác Postgres)

**Có JOIN** (khác Cassandra), nhưng cần lưu ý:
- JOIN mặc định load bảng bên phải vào RAM — cảnh báo với bảng lớn; hỗ trợ `GLOBAL JOIN` cho distributed.
- Toán tử đặc thù: `FINAL` (đọc đã merge), `SAMPLE`, `PREWHERE`, `ARRAY JOIN`, `LIMIT n BY`.
- `SETTINGS ...` gắn theo từng query (ví dụ `SETTINGS max_threads = 4`).
- Không có transaction (BEGIN/COMMIT) — không bọc query trong transaction.
- Key trong `ORDER BY`/`PRIMARY KEY` **không đảm bảo unique**. `ReplacingMergeTree`/`SummingMergeTree`
  chỉ gộp khi merge (nền, không tức thì) → SELECT thường có thể thấy bản trùng cho tới khi merge
  hoặc dùng `FINAL`. UI nên có toggle "SELECT ... FINAL" khi xem bảng dạng Replacing/Summing/Aggregating.
- Kiểu dữ liệu phải render đúng: `LowCardinality(...)`, `Nullable(...)`, `UInt8/16/32/64`,
  `Int*`, `Float64`, `Decimal`, `UUID`, `Date`/`DateTime`/`DateTime64`, `Enum`, `FixedString`,
  `Array(...)`, `Map(...)`, `Tuple(...)`, `Nested`, `CODEC(...)`.
- Shape trả về giữ `{ ok, result:{cols, rows, total}, error }`. `total`: dùng số ước lượng của
  ClickHouse (`system.tables.total_rows`) hoặc count riêng — không đếm client-side trên 18M row.

---

## 5. DDL specifics (native ClickHouse)

DDL viewer/generator phải sinh CQL... (SQL) **native ClickHouse**, không tái dùng generator Postgres:

```sql
CREATE TABLE db.events
(
    event_date  Date,
    event_type  LowCardinality(String),
    user_id     UInt64,
    payload     String CODEC(ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, event_type, user_id)
TTL event_date + INTERVAL 90 DAY
SETTINGS index_granularity = 8192
```

- Bắt buộc render đúng: `ENGINE = ...`, `PARTITION BY`, `ORDER BY` (sorting key), `PRIMARY KEY`
  (nếu khác ORDER BY), `TTL`, `SETTINGS`, `CODEC`.
- Engine họ MergeTree: `MergeTree`, `ReplacingMergeTree(ver)`, `SummingMergeTree(cols)`,
  `AggregatingMergeTree`, `CollapsingMergeTree`, `VersionedCollapsingMergeTree`; và `Log`, `Memory`,
  `Distributed`, `MaterializedView`, `Dictionary`.
- **Materialized View** ở ClickHouse là **insert-triggered** (ghi khi có INSERT vào bảng nguồn),
  KHÔNG phải MV refresh như Postgres. Đừng sinh `REFRESH MATERIALIZED VIEW`.
- Menu tạo trong schema: **Materialized View / Dictionary / Function** (thay cho Sequence/Procedure
  của hệ quan hệ).

---

## 6. TTL Policy Viewer (modal `ttlOpen`, state `ttlTable`)

- Mở từ context-menu table → **TTL Policy…**. Parse mệnh đề `TTL` của bảng thành rule dễ đọc.
- Mỗi rule hiển thị: biểu thức thô + badge hành động **DELETE** / **MOVE** + mô tả ngôn ngữ tự nhiên
  ("Rows older than 90 days will be deleted", "… moved to cold storage") + engine + ngưỡng TTL merge.
- Nút **MATERIALIZE TTL** → mở SQL tab với `ALTER TABLE … MATERIALIZE TTL`.
- Bảng không có TTL → empty state.
- Bản thật: đọc TTL từ `system.tables` / `SHOW CREATE TABLE` chứ không từ mảng `CH_SCHEMA` cứng.

---

## 7. Mutations & editable grid (điểm dễ sai nhất)

ClickHouse KHÔNG cập nhật row kiểu OLTP. Xử lý đúng:

- **UPDATE/DELETE** = mutation async: `ALTER TABLE … UPDATE col = … WHERE …` /
  `ALTER TABLE … DELETE WHERE …` (hoặc lightweight `DELETE FROM … WHERE …` — vẫn async).
  Chạy nền, theo dõi qua `system.mutations` (không xong tức thì).
- Editable grid của đường relational: với ClickHouse **không** commit như INSERT/UPDATE tức thời.
  Lựa chọn: (a) tắt inline-edit cho bảng ClickHouse và route sang "Generate mutation", kèm cảnh báo
  chi phí; hoặc (b) dịch pending changes thành các `ALTER TABLE … UPDATE/DELETE` và báo là job async.
  KHÔNG giả vờ cập nhật xong ngay.
- **INSERT** nên theo lô lớn (columnar), không insert từng row. Import Wizard commit theo batch lớn.
- Không transaction/rollback theo kiểu quan hệ — thông báo rõ khi người dùng kỳ vọng atomic.

---

## 8. Table / Partition ops + Dictionary (context menu — ClickHouse only)

**Table ops** (query `system.parts` / `system.tables`):
- **Optimize Table (FINAL)** → `OPTIMIZE TABLE … FINAL`.
- **Show Partitions / Show Engine / Settings**.
- **Detach / Drop / Freeze Partition** → `ALTER TABLE … DETACH/DROP/FREEZE PARTITION …`.
- Mutations: Generate UPDATE/DELETE → `ALTER TABLE … UPDATE/DELETE WHERE …`.

**Dictionary** (context menu riêng):
- Show Definition → `SHOW CREATE DICTIONARY`.
- Query Dictionary; Reload → `SYSTEM RELOAD DICTIONARY`; Drop; Copy Name.

**Structure Compare:** ClickHouse được phép so sánh (README: relational + ClickHouse), nhưng diff/DDL
phải theo dialect ClickHouse (engine/partition/order-by/TTL), không theo `information_schema` chuẩn.

---

## 9. Driver & backend

- Rust: **`clickhouse`** crate (HTTP, typed, dễ dùng) hoặc **`clickhouse-rs`** (native TCP 9000).
  Chọn 1 theo protocol ở connection. Khuyến nghị `clickhouse` (HTTP 8123) cho đơn giản, đủ cho bản cá nhân.
- Prepared/parameterized: dùng tham số hóa của driver, không nối chuỗi.
- Introspection qua `system.tables`, `system.columns`, `system.parts`, `system.mutations`,
  `system.dictionaries`, `SHOW CREATE TABLE/DICTIONARY`.
- Đọc dataset lớn: dùng streaming + LIMIT/paging phía server, không kéo hết 18M row về client.

---

## 10. Prototype fake gì / phải build gì

| Hạng mục | Prototype | Bản thật |
|---|---|---|
| execSql | in-memory | client `clickhouse` thật, giữ shape trả về |
| engine badge / schema | từ `CH_SCHEMA` cứng | đọc `system.tables` / `SHOW CREATE TABLE` |
| TTL Viewer | parse mảng cứng | parse TTL thật từ system tables |
| Table/partition ops | flash SQL | chạy `OPTIMIZE`/`ALTER … PARTITION` thật + theo dõi |
| Mutations/editable grid | commit kiểu quan hệ | route sang `ALTER … UPDATE/DELETE` async (mục 7) |
| total rows | số cứng (18.4M) | `system.tables.total_rows` (ước lượng) |
| Dictionary ops | flash | `SHOW CREATE` / `SYSTEM RELOAD DICTIONARY` thật |

---

## 11. Self-test cần thay (sau khi có backend)

1. SELECT trên `MergeTree` thật → trả đúng cột/kiểu (LowCardinality, Nullable, UUID render đúng).
2. Bảng `ReplacingMergeTree`: chèn 2 row cùng key → SELECT thường thấy 2, `SELECT … FINAL` thấy 1.
3. `ALTER TABLE … UPDATE … WHERE …` → job xuất hiện trong `system.mutations`, không "xong ngay".
4. DDL round-trip: tạo bảng có `ENGINE/PARTITION BY/ORDER BY/TTL` → `SHOW CREATE TABLE` khớp.
5. TTL Viewer: bảng có TTL → parse ra rule DELETE/MOVE đúng; bảng không TTL → empty state.
6. Optimize FINAL / Show Partitions đọc `system.parts` thật.

---

## 12. Do NOT (ClickHouse)

- KHÔNG đối xử ClickHouse như Postgres dù nó ở đường `selRel`. Không transaction, không UPDATE/DELETE
  row tức thời, key không unique.
- KHÔNG commit editable grid kiểu OLTP — dịch sang mutation async, có cảnh báo (mục 7).
- KHÔNG sinh `REFRESH MATERIALIZED VIEW` (MV ở ClickHouse là insert-triggered).
- KHÔNG dùng generator DDL của hệ quan hệ — phải native ClickHouse (engine/partition/TTL/codec).
- KHÔNG đếm/kéo toàn bộ row lớn về client — dùng ước lượng + streaming.
- KHÔNG đọc schema/TTL từ mảng cứng — đọc `system.*` thật.
