# Database Studio — Product Spec

> ## 0. ĐỐI CHIẾU CODE (cập nhật 2026-07-22 — đọc trước tiên)
>
> `overview.md` là spec sản phẩm **lịch sử**; nhiều phần đã bị vượt qua bởi code hiện tại. Khi mâu thuẫn,
> **code + các spec tính năng riêng đúng**, không phải file này. Các drift hệ thống:
>
> - **12 hệ, KHÔNG phải 10.** Enum `LiveConnection` (`src-tauri/src/drivers/mod.rs:46-58`) có 11 variant
>   (MariaDB dùng chung `MySql`); `SystemType` (`src/lib/types.ts:5-17`) có 12 giá trị — thêm **MongoDB** và
>   **Oracle**. → Mục 6 "Out of scope: MongoDB support" **KHÔNG còn đúng** (xem note tại §6). Oracle không
>   được overview.md nhắc; xem `SPEC-ORACLE-FEATURE.md`. MongoDB: `SPEC-MONGODB-FEATURE.md`.
> - **Cấu trúc thư mục frontend đã dời** hết về `src/lib/` (mục 7 vẽ `src/components/`, `src/stores/` ở
>   top-level là sai). Thực tế `src/lib/` chứa ~19 thư mục con: `sql/ users/ mongo/ redis/ stream/ grid/
>   export/ import/ compare/ copy/ er/ testdata/ keys/ format/ actions/ explorer/ connections/ components/ stores/`.
> - **Tab content-type mới sau spec**: `index-manager`, `admin`, `objects`, `user-manager`, `mongo-collection`,
>   `cassandra-table`, `redis-key`, `nats-subject` (`src/lib/types.ts:214-239`).
> - **Mảng tính năng lớn không có trong overview**: Users & Privileges 8 engine (`SPEC-USERS-PRIVILEGES.md`),
>   Generate Test Data, Copy Table to…, Partitioning, và toàn bộ pure-logic `src/lib/sql/*.ts`.
> - **ClickHouse driver = `reqwest` HTTP tự viết**, KHÔNG phải crate `clickhouse` (mục "tech stack" dòng ~138
>   sai; `Cargo.toml:66` reqwest, không có crate clickhouse).
> - **Split view chỉ 1 lần chia đôi** (trái/phải hoặc trên/dưới), KHÔNG phải lưới "2×2 panes"
>   (`stores/tabs.svelte.ts:22` `splitDir: null|'v'|'h'`).
> - **Redis CLI console = tính năng ma**: `RedisWorkspace.svelte` còn trong code nhưng không còn đường UI mở
>   (AUDIT-13 thay bằng RedisExplorer key-browser trong cây). Mục 3.9 mô tả CLI console là lỗi thời.
> - **Result contract** có thêm field `affected` ngoài `{ok, result, error, duration_ms}` (`drivers/types.rs:83`).
>
> Các mô tả kiến trúc lõi CÒN đúng: dual-mode IPC (`ipc.ts:8-9`), driver-per-module, storage rusqlite
> (connections/tabs/history/Snippet), SSH tunnel `russh`, dependency sqlx/tiberius/rusqlite/scylla/redis/
> rdkafka/async-nats (khớp `Cargo.toml`).

## 1. Tổng quan

**Database Studio** là một desktop app cá nhân để quản lý và làm việc với cơ sở dữ liệu và message broker. Mục tiêu: nhẹ, nhanh, đủ tính năng cho developer/DBA cá nhân, không cần server.

### Connections hỗ trợ — ~~10~~ **12 hệ thống** (xem §0)

> Danh sách chuẩn theo `DATABASE_STUDIO_SPEC_v2.md` mục 2 (spec gốc chỉ nêu 6 hệ; đã mở rộng
> thành 10: thêm **MariaDB, SQLite, ClickHouse, Cassandra**).
> **Cập nhật (2026-07-22):** nay là **12 hệ** — bảng dưới thiếu **MongoDB** và **Oracle** (đã có driver đầy
> đủ trong code, xem §0 + `SPEC-MONGODB-FEATURE.md` / `SPEC-ORACLE-FEATURE.md`).

| Hệ thống | Nhóm | Port | Quoting định danh | Workspace |
|---|---|---|---|---|
| PostgreSQL 12+ | Relational | 5432 | `"..."` | SQL editor + grid |
| MySQL 8+ | Relational | 3306 | `` `...` `` | SQL editor + grid |
| MariaDB | Relational | 3306 | `` `...` `` | SQL editor + grid |
| SQL Server 2014+ (MSSQL) | Relational | 1433 | `[...]` | SQL editor + grid |
| SQLite | Embedded | (file) | `"..."` | SQL editor + file tree |
| ClickHouse | Analytical | 8123 (HTTP) / 9000 (native) | `` `...` `` | SQL editor + grid |
| Cassandra | Wide Column | 9042 | `"..."` | CQL editor + grid |
| Redis 6+ / Redis Stack / Valkey | Cache | 6379 | — | Key browser |
| Apache Kafka 2.8+ | Streaming | 9092 | — | Topic browser |
| NATS 2.x (bao gồm JetStream) | Streaming | 4222 | — | Subject browser |

### Phương thức kết nối
- Direct TCP/IP
- SSH Tunnel (password + private key)
- SSL/TLS
- SASL/SCRAM (Kafka)
- NKey / JWT (NATS)

---

## 2. Color Identity System

Mỗi loại database/broker có **bộ màu riêng nhất quán** xuất hiện ở mọi nơi trong UI: sidebar, tab bar, connection list, status bar, badge. Không dùng icon chữ/emoji làm định danh chính — màu là tín hiệu nhận biết đầu tiên.

### Bảng màu

| System | Accent | Background | Border | Text on bg | Icon |
|---|---|---|---|---|---|
| **PostgreSQL** | `#336791` | `#1a3a52` | `#2a5a7a` | `#7ec8f0` | `PG` |
| **MySQL** | `#F29111` | `#3d2800` | `#6b4400` | `#f5b84a` | `MY` |
| **SQL Server** | `#CC2927` | `#3d0a09` | `#6b1515` | `#f08080` | `MS` |
| **Redis** | `#D82C20` | `#3d0c08` | `#6b1a14` | `#f07070` | `RE` |
| **MariaDB** | `#C0765A` | `#2e1a12` | `#5c3020` | `#e8a882` | `MA` |
| **SQLite** | `#0F80CC` | `#0a1e35` | `#12406a` | `#60b8f5` | `SL` |
| **ClickHouse** | `#FFCC00` | `#33290a` | `#665514` | `#ffe066` | `CH` |
| **Cassandra** | `#1287B1` | `#0a2030` | `#134f72` | `#5cc4e8` | `CS` |
| **Kafka** | `#231F20` (dark) / `#8B5CF6` (accent) | `#1e1a2e` | `#3d2f6b` | `#c4b5fd` | `KF` |
| **NATS** | `#27AE60` | `#0d2e1a` | `#1a5c35` | `#6ee7a0` | `NT` |

> Accent = màu đặc trưng thương hiệu. Background = nền tối dùng trong dark mode. Text on bg = màu chữ khi render trên Background.
> Token lấy từ map `SYS` trong `Database Studio.dc.html` (source of truth) — đối chiếu lại code trước khi hard-code.
> Ngoài ra có bộ màu `orphan` (accent `#5b6473`, badge `⚠`) cho tab mồ côi khi connection bị xóa.

### Áp dụng ở đâu

#### 1. Connection List (sidebar trái)
```
┌──────────────────────────────┐
│ ▐█ Prod PG          [🐘 PG] │  ← thanh dọc màu #336791, badge "PG" nền #1a3a52
│ ▐█ Dev MySQL        [MY]    │  ← thanh dọc màu #F29111
│ ▐█ MariaDB App      [MA]    │  ← thanh dọc màu #C0765A
│ ▐█ Analytics MSSQL  [MS]    │  ← thanh dọc màu #CC2927
│ ▐█ Local SQLite     [SL]    │  ← thanh dọc màu #0F80CC
│ ▐█ Analytics CH     [CH]    │  ← thanh dọc màu #FFCC00
│ ▐█ Profiles CS      [CS]    │  ← thanh dọc màu #1287B1
│ ▐█ Cache Redis      [RE]    │  ← thanh dọc màu #D82C20
│ ▐█ Events Kafka     [KF]    │  ← thanh dọc màu #8B5CF6
│ ▐█ Messaging NATS   [NT]    │  ← thanh dọc màu #27AE60
└──────────────────────────────┘
```
- Thanh dọc 3px bên trái mỗi connection = màu Accent
- Badge `[PG]` `[MY]` ... = text màu "Text on bg", nền màu Background, border màu Border
- Connection list nhóm theo **category label viết hoa** (RELATIONAL / ANALYTICAL / WIDE COLUMN / CACHE / STREAMING / EMBEDDED) + **tag môi trường** màu: PROD (đỏ), STG (hổ phách), DEV (xanh lá), LOCAL (tím)

#### 2. Tab bar
```
┌──────────────────────────────────────────────────────────────┐
│ [PG] Prod PG · orders ×  │ [MY] Dev MySQL · users ×  │ [KF] │
│  #336791 border-bottom       #F29111 border-bottom           │
└──────────────────────────────────────────────────────────────┘
```
- Tab active: border-bottom 2px = màu Accent của system đó
- Tab badge `[PG]`: nền Background, text Text-on-bg
- Tab inactive: giảm opacity 60%, màu vẫn giữ nguyên (không dùng màu xám chung)

#### 3. Object Explorer header
```
┌─────────────────────────────────┐
│ ▐ Prod PG          [PG]        │  ← header nền màu Background (subtle)
│   public                        │
│   ├── ▦ Tables                  │
```
- Header connection = nền tông Background, left-border = Accent

#### 4. Status bar (bottom)
```
[ ● Prod PG ]  [ PG ]  public.orders  |  42ms  |  100 rows
  ^Accent dot   ^badge
```
- Dot `●` màu Accent khi connected, xám khi disconnected
- Badge system type ngay cạnh tên connection

#### 5. Query result header
```
┌──────────────────────────────────────────────────┐
│ ▐ Prod PG — orders  [Grid] [JSON] [Single Row]   │
│   ← #336791 left-border                          │
```

#### 6. Notification / Toast
- Border-left của toast = màu Accent của connection phát sinh event
- Phân biệt ngay "query nào chạy xong trên connection nào" khi nhiều tab chạy song song

### Quy tắc thiết kế
- **Không dùng màu xám / màu mặc định** cho bất kỳ connection nào — luôn dùng màu system
- **Consistency**: cùng một system thì cùng màu ở mọi nơi, không đổi theo theme
- **Dark mode**: dùng cột Background + Text-on-bg. **Light mode**: dùng Accent làm border/icon, nền trắng
- Badge text luôn là 2 ký tự viết tắt (PG, MY, MA, MS, SL, CH, CS, RE, KF, NT) — không dùng logo/emoji vì không scale nhỏ. Lưu ý: badge Redis là **RE**, NATS là **NT** (theo HTML prototype — bảng 2 ký tự trong SPEC_v2 ghi RD/NA là sai)

---

## 3. Kiến trúc kỹ thuật

### Tech stack đề xuất

| Layer | Lựa chọn | Lý do |
|---|---|---|
| Desktop shell | **Tauri 2** (Rust) | Nhẹ hơn Electron 10x, binary nhỏ, bảo mật tốt hơn |
| Frontend | **Svelte 5 + TypeScript** | Compile ra vanilla JS, không VDOM, bundle nhỏ — phù hợp desktop |
| UI framework | **shadcn-svelte + Tailwind** | Port chính thức của shadcn cho Svelte |
| SQL editor | **CodeMirror 6** | Framework-agnostic, autocomplete, highlight, extensible |
| Data grid | **TanStack Table** (Svelte adapter) | Virtualization, headless, performance |
| State | **Svelte stores (built-in)** | Reactive stores native, không cần lib thêm |
| SQL drivers | Rust: `sqlx` (PG, MySQL, MariaDB — MariaDB dùng chung driver MySQL), `tiberius` (MSSQL), `rusqlite` (SQLite user-DB) | Native, async, type-safe |
| ClickHouse driver | Rust: `clickhouse` crate (HTTP 8123) | Typed, đơn giản, đủ cho bản cá nhân |
| Cassandra driver | Rust: `scylla` (scylla-rust-driver) | Async gốc, prepared statement + paging + load balancing |
| Redis driver | Rust: `redis` (redis-rs) | Async, connection pool, Pub/Sub |
| Kafka driver | Rust: `rdkafka` (librdkafka) | Production-grade, SASL, consumer groups |
| NATS driver | Rust: `async-nats` | Official Rust client, JetStream support |
| SSH tunnel | Rust: `russh` | Thuần Rust, không cần OpenSSH |
| Storage | **SQLite** (via `rusqlite`) | Lưu connections, history, snippets |

> **SQLite có 2 vai tách bạch:** (1) **storage nội bộ** của app (connections/history/snippets/tabs
> — không hiện trong UI như một connection); (2) **SQLite user-DB** — hệ thứ 10 mà người dùng
> mở qua file picker. Cùng dùng `rusqlite` nhưng code path và lifecycle riêng, không trộn lẫn.

### Luồng kết nối
```
Frontend (Svelte 5)
    ↕ Tauri IPC (async commands)
Rust backend
    ↕ SSH tunnel (russh) — optional
    ├── Relational  →  PG / MySQL / MariaDB / MSSQL   (sqlx, tiberius)
    ├── Embedded    →  SQLite (file)          (rusqlite)
    ├── Analytical  →  ClickHouse             (clickhouse HTTP)
    ├── Wide Column →  Cassandra              (scylla)
    ├── Key-Value   →  Redis / Valkey         (redis-rs)
    ├── Kafka       →  Broker cluster         (rdkafka)
    └── NATS        →  Server / JetStream     (async-nats)
```

---

## 3. Tính năng chi tiết

### 3.1 Connection Manager
- [ ] Lưu multiple connections với tên / group / icon màu
- [ ] Fields: host, port, database, user, password (encrypted AES-256)
- [ ] SSH tunnel: host, port, user, auth (password hoặc private key file)
- [ ] SSL: CA cert, client cert/key
- [ ] Test connection button
- [ ] Duplicate / export / import connection profiles (JSON)
- [ ] Quick connect (không lưu)

#### Delete connection khi đang có tabs sử dụng

Khi xóa một connection đang được dùng bởi 1 hoặc nhiều tab, **không báo lỗi và chặn** — thay vào đó hiện dialog xác nhận với 2 lựa chọn:

```
┌─ Delete connection "Prod PG"? ──────────────────────────────┐
│                                                              │
│  ⚠️  Connection này đang được dùng bởi 3 tab:               │
│      · orders · SELECT  (tab #2)                            │
│      · users · query    (tab #5)                            │
│      · schema explorer  (tab #7)                            │
│                                                              │
│  [Cancel]   [Close tabs & Delete]   [Force Delete]          │
└──────────────────────────────────────────────────────────────┘
```

| Nút | Hành động |
|---|---|
| **Cancel** | Huỷ, không làm gì |
| **Close tabs & Delete** | Đóng tất cả tabs liên quan → xóa connection profile |
| **Force Delete** | Xóa connection profile ngay, các tabs chuyển sang trạng thái "orphaned" (vẫn còn trong tab bar, nội dung giữ nguyên nhưng không thể chạy query) |

**Force Delete** hữu ích khi:
- Tab đang chạy query dài, không muốn mất nội dung editor đã soạn
- Muốn xóa connection profile nhưng vẫn giữ tab để copy SQL ra

**Orphaned tab** hiển thị:
- Badge connection chuyển sang xám với icon `⚠`
- Banner trên result panel: `Connection đã bị xóa · [Reassign connection]`
- Nút **Reassign**: chọn connection khác để tab tiếp tục hoạt động

### 3.2 Object Explorer (sidebar)

#### Cây phân cấp — phân biệt rõ từng loại object

Mỗi loại object có **icon riêng + màu riêng** để nhận biết ngay không cần đọc tên nhóm:

| Loại | Icon | Màu |
|---|---|---|
| Table | `▦` | xanh dương |
| View | `◫` | tím |
| Stored Procedure | `⚙` | cam |
| Function | `ƒ` | vàng |
| Trigger | `⚡` | đỏ |
| Sequence | `#` | xám xanh |
| Index | `⌗` | xám |
| Column | `▸` | trắng xám |

```
Connection  [🐘 Prod PG · postgres]
└── public  (schema)
    │
    ├── 📋 Tables  (12)
    │   ├── ▦ orders
    │   │   ├── ▸ id          int4  PK  NOT NULL
    │   │   ├── ▸ user_id     int4  FK  NOT NULL
    │   │   ├── ▸ status      varchar(20)
    │   │   ├── ▸ created_at  timestamptz
    │   │   ├── ⌗ Indexes  (3)
    │   │   │   ├── idx_orders_user_id
    │   │   │   └── idx_orders_status
    │   │   └── 🔗 Constraints  (2)
    │   │       ├── fk_orders_users
    │   │       └── chk_status
    │   └── ▦ users  ...
    │
    ├── ◫ Views  (4)
    │   ├── ◫ vw_active_orders
    │   └── ◫ vw_user_summary
    │
    ├── ⚙ Stored Procedures  (6)
    │   ├── ⚙ sp_process_order(order_id int)
    │   └── ⚙ sp_archive_old_records(days int)
    │
    ├── ƒ Functions  (8)
    │   ├── ƒ fn_calculate_total(order_id int) → numeric
    │   ├── ƒ fn_get_user_tier(user_id int) → text
    │   └── ƒ fn_audit_trigger() → trigger
    │
    ├── ⚡ Triggers  (3)
    │   ├── ⚡ trg_orders_updated_at  [BEFORE UPDATE ON orders]
    │   └── ⚡ trg_audit_users        [AFTER INSERT,UPDATE ON users]
    │
    └── # Sequences  (2)  [PG only]
        └── # orders_id_seq
```

#### Phân biệt theo từng hệ thống

**PostgreSQL**
- Tách riêng **Functions** và **Procedures** (PG 11+ có cả hai)
- Function hiển thị return type ngay trên tree: `ƒ fn_name(args) → type`
- Sequences riêng một node
- Trigger hiển thị event + table đính kèm

**MySQL / MariaDB**
- Không có Sequences → ẩn node đó
- Stored Procedures và Functions tách 2 node riêng
- Trigger hiển thị BEFORE/AFTER + event (INSERT/UPDATE/DELETE)

**SQL Server**
- Thêm node **Schemas** ở cấp trên (dbo, sys, ...)
- Stored Procedures hiển thị rõ schema prefix: `dbo.sp_name`
- Tách thêm node **Table-Valued Functions** và **Scalar Functions**
- Thêm node **Synonyms**, **User-Defined Types**

**SQLite** (`sqliteTree`)
- Root là **file** (`/data/local.db`) → schema `main` → Tables / Views / Triggers
- Bảng hệ thống `sqlite_sequence` / `sqlite_master` hiển thị khóa 🔒 (read-only)
- Không có Procedures/Functions/Sequences

**ClickHouse** (`clickhouseTree`)
- Databases (default, system, ...) → Tables (kèm **engine badge**: MergeTree / ReplacingMergeTree / ...) / Views (gồm Materialized View) / Dictionaries / Functions
- Database `system` là read-only, dùng để introspection

**Cassandra** (`cassandraTree`)
- Keyspace → Tables (hiện rõ **partition key** vs **clustering key**) / Materialized Views / User Types (UDT) / Functions (UDF) / Secondary Indexes
- Keyspace hiển thị replication strategy + factor ở properties
- Không dùng khái niệm "schema" kiểu quan hệ

#### Khi expand object

**Table** — expand ra:
- Columns: tên · type · nullable · default · PK/FK badge
- Indexes: tên · loại (BTREE/HASH/GIN...) · columns · unique flag
- Constraints: tên · loại (PK/FK/UNIQUE/CHECK) · definition

**View** — expand ra:
- Columns (tên + type)
- Double-click → mở tab xem data (như table)
- Right-click → "View Definition" mở DDL trong SQL Editor

**Stored Procedure** — expand ra:
- Parameters: tên · type · IN/OUT/INOUT · default
- Right-click → "Open" mở body trong SQL Editor với syntax highlight
- Right-click → "Execute" mở dialog nhập params + chạy

**Function** — expand ra:
- Parameters + return type
- Right-click → "Open" mở body trong SQL Editor
- Right-click → "Execute" (scalar) hoặc "Preview result" (table-valued)

**Trigger** — expand ra:
- Event (BEFORE/AFTER · INSERT/UPDATE/DELETE)
- Table gắn với
- Right-click → "Open" mở body trong SQL Editor

#### Hành động trên sidebar
- **Refresh** node riêng lẻ (không reload toàn bộ tree)
- **Search / filter** real-time theo tên object (Ctrl+F trong sidebar)
- **Pin** objects thường dùng lên đầu tree
- **Right-click context menu** — khác nhau theo loại:

| Object | Menu items |
|---|---|
| Table | Open Data, New Query, Design Table, Rename, Truncate, Drop, Copy Name, Copy SELECT |
| View | Open Data, View Definition, Rename, Drop, Copy Name |
| Stored Procedure | Open, Execute, Rename, Drop, Copy Name |
| Function | Open, Execute / Preview, Rename, Drop, Copy Name |
| Trigger | Open, Enable/Disable, Drop |
| Column | Copy Name, Copy as `table.column`, Set as Filter |

### 3.3 SQL Editor
- Syntax highlighting đa dialect (PG / MySQL / MariaDB / MSSQL / SQLite / ClickHouse; **CQL** cho Cassandra)
- Auto-complete:
  - Keywords
  - Table names, column names từ schema đang kết nối
  - Function signatures + docs
- Multiple tabs (có thể pin)
- `F5` → run **tab đang focus** (không ảnh hưởng các tab khác):
  - Có selection → run đoạn được bôi đen
  - Không có selection → run toàn bộ nội dung tab hiện tại
- `Ctrl+Enter` → run statement tại vị trí cursor (tab đang focus)
- `Ctrl+F5` / `Esc` → cancel query của tab đang focus
- Format SQL (Ctrl+Shift+F)
- Explain / Explain Analyze với visual plan
- Query history (persistent, có search)
- Snippets: lưu SQL fragments có tên + shortcut
- Split pane: editor trên / kết quả dưới (resizable)
- Line numbers, code folding, bracket matching

### 3.4 Result Grid

#### Multi-statement results — sub-tabs

Khi run nhiều câu SQL cùng lúc, mỗi statement sinh ra **1 sub-tab riêng** trong result panel. Không gộp chung, không mất result của statement trước.

```
┌─ Editor ──────────────────────────────────┐
│ SELECT * FROM orders WHERE status='done'; │
│ SELECT * FROM users;                      │
│ UPDATE orders SET status='archived'...;   │
│ SELECT name FROM products;                │
└───────────────────────────────────────────┘
┌─ Results ─────────────────────────────────────────────────────┐
│ [#1 orders · 3,842 rows] [#2 users · 120] [#3 ✓ 1 affected] [#4 products · 56] │
│                                                               │
│  id  │ user_id │ status    │ created_at                       │
│   1  │      42 │ completed │ 2026-06-01 ...                   │
│  ...                                                          │
└───────────────────────────────────────────────────────────────┘
```

**Sub-tab label:**
- `SELECT` → `#N  <tên table chính> · X rows`
- `INSERT` / `UPDATE` / `DELETE` → `#N  ✓ X rows affected`
- `CREATE` / `DROP` / `ALTER` → `#N  ✓ OK`
- Error → `#N  ✗ error` (badge đỏ), click để xem message lỗi

**Behavior khi có lỗi:**
- Mặc định: **dừng lại tại statement lỗi**, các statement sau không chạy
- Có thể bật "Continue on error" trong Settings → chạy hết, sub-tab lỗi đánh dấu đỏ

**Tab Messages:**
- Luôn có thêm sub-tab `Messages` ở cuối: log toàn bộ execution — thời gian từng statement, row count, error text
- Hữu ích khi chạy script dài hoặc stored procedure có PRINT output

**Thứ tự chạy:**
- Sequential, không parallel — statement sau chạy khi statement trước hoàn thành
- Sub-tab xuất hiện lần lượt khi từng statement xong (không đợi hết mới hiện)

---

#### View modes — chuyển đổi tự do, dữ liệu không reload

Toolbar result panel có 3 nút toggle:

| Mode | Phím tắt | Mô tả |
|---|---|---|
| **Grid** (default) | `Ctrl+Alt+G` | Bảng dạng cột, nhiều rows |
| **JSON** | `Ctrl+Alt+J` | Toàn bộ result set dạng JSON array |
| **Single Row** | `Ctrl+Alt+R` | 1 row dạng form dọc (key: value) |

---

#### Grid mode
- Virtualized table cho dataset lớn (10M+ rows không lag)
- Pagination server-side (configurable page size: 100 / 500 / 1000)
- Sort đa cột, filter inline
- Freeze columns
- Null vs empty string phân biệt rõ (`NULL` badge xám vs chuỗi rỗng)
- Datetime hiển thị local timezone (toggle UTC)
- JSON/JSONB cell: click → mở inline JSON viewer ngay trong cell (không popup)
- Editable:
  - Double-click cell để edit
  - Insert row / Delete row(s)
  - Pending changes buffer → Apply / Discard
  - Preview diff trước khi Apply

---

#### JSON mode
Hiển thị toàn bộ result set dưới dạng JSON array, phù hợp để inspect payload, copy vào Postman, debug response shape.

```
[View: Grid] [View: JSON] [View: Single Row]        [Copy] [Format] [Wrap]
[
  {
    "id": 1,
    "user_id": 42,
    "status": "completed",
    "metadata": {
      "source": "web",
      "tags": ["vip", "promo"]
    },
    "created_at": "2026-06-24T08:00:00Z"
  },
  { ... }
]
Showing 1-100 of 3,842 rows                         [< Prev] [Next >]
```

**Tính năng JSON mode:**
- Syntax highlight + collapsible nodes (fold/unfold object, array)
- Format toggle: Pretty (indent 2) / Compact (minified)
- Word wrap toggle
- Copy toàn bộ JSON (Ctrl+C khi không có selection = copy all)
- Copy chỉ row đang hover (icon copy hiện khi hover từng object `{}`)
- Search trong JSON (Ctrl+F): highlight match, nhảy next/prev
- Pagination giữ nguyên — mỗi page render JSON của page đó
- Nested JSON/JSONB column tự động expand inline (không bị double-stringify)

---

#### Single Row mode
- Chọn row trong Grid → tự động hiển thị row đó dạng form dọc
- Mũi tên `←` `→` để next/prev row không cần quay về Grid
- Mỗi field hiển thị: tên cột · type · giá trị (full, không truncate)
- JSON/JSONB field render thành collapsible JSON tree
- Copy field value riêng lẻ

---

#### Export
- Copy cell / row / selection: Tab-separated, CSV, JSON
- Export result: CSV, JSON, Excel (.xlsx), SQL INSERT

### 3.5 Table Data Viewer
- Mở bảng từ Explorer (double-click)
- Filter builder (UI không cần viết WHERE)
- Sort đa cột
- Xem 1 row dạng form (vertical view)

### 3.6 Schema Designer / DDL Tools
- View DDL của object bất kỳ (CREATE statement)
- Table designer GUI:
  - Thêm/sửa/xóa columns
  - Data types với dropdown theo dialect
  - Default value, nullable, PK, unique
  - Preview DDL thay đổi trước khi apply
- Index manager
- Foreign key manager

### 3.7 Import / Export
- Import: CSV → table (mapping columns, skip/error on conflict)
- Export table/query: CSV, JSON, Excel, SQL dump
- Database dump (schema only / data only / both)

### 3.8 Query Plan Visualizer
- Parse EXPLAIN output → visual node tree
- Highlight slow nodes (cost threshold)
- **Đủ 10 hệ** qua cơ chế adapter chuẩn hóa (xem mục 3.16 và `EXECUTE_PLAN_AND_INDEX_SCAN_ADDENDUM.md`):
  PG `EXPLAIN (FORMAT JSON)`, MySQL `EXPLAIN FORMAT=JSON` / `EXPLAIN ANALYZE`, MariaDB `ANALYZE FORMAT=JSON`,
  MSSQL `SHOWPLAN_XML` / `STATISTICS XML`, SQLite `EXPLAIN QUERY PLAN`, ClickHouse `EXPLAIN PLAN/PIPELINE/ESTIMATE/indexes=1`,
  Cassandra `TRACING ON` (timeline); Redis/Kafka/NATS → `not_applicable`

### 3.9 Redis Browser
- Key Explorer:
  - Tree view phân cấp theo prefix (separator `:`)
  - Hiển thị type icon: String, Hash, List, Set, ZSet, Stream
  - TTL badge (còn bao nhiêu giây / không expire)
  - Search keys theo pattern (`SCAN` cursor-based, không block)
- Key Viewer / Editor:
  - String: plain text + JSON auto-detect với formatter
  - Hash: table view, thêm/sửa/xóa field
  - List: ordered list, push / pop / set index
  - Set: member list, add / remove
  - ZSet: member + score table, sort by score
  - Stream: message list, add entry, read by ID/range
- TTL editor: set / remove / view remaining
- CLI console: gõ raw Redis commands, highlight output
- Pub/Sub monitor: subscribe channel, xem messages real-time
- DB selector: switch giữa database 0–15
- Memory usage per key (MEMORY USAGE)
- Flush DB với xác nhận

### 3.10 Kafka Explorer
- Cluster overview: broker list, controller, version
- Topic browser:
  - List topics + partition count + replication factor
  - Partition detail: leader, replicas, ISR, offsets (earliest/latest)
- Message viewer:
  - Consume từ offset / timestamp / latest
  - Decode: raw bytes, UTF-8, JSON (auto-pretty), Avro (nếu có Schema Registry URL)
  - Hiển thị headers, key, value, partition, offset, timestamp
  - Filter message by key pattern hoặc value content
- Producer: publish message với key, value, headers, chọn partition
- Consumer Groups:
  - List groups + state (Stable / Rebalancing / Dead)
  - Lag per partition (current offset vs latest offset)
  - Reset offset (earliest / latest / specific offset / timestamp)
- Schema Registry (optional): list schemas, view Avro/JSON Schema definition
- ACL viewer (read-only)

### 3.11 NATS Explorer
- Connection info: server version, cluster name, uptime, connections
- Subject browser:
  - Live subscribe bất kỳ subject / wildcard (`>`, `*`)
  - Hiển thị messages real-time dạng stream
  - Decode payload: raw, UTF-8, JSON formatter
- Publish: subject, reply-to, headers, payload
- Request/Reply: gửi request, hiển thị reply (timeout configurable)
- JetStream:
  - Streams: list, config (subjects, retention, storage, limits), purge
  - Consumers: list, config (deliver policy, filter subject, ack policy)
  - Messages: peek message by sequence, get by subject + sequence
  - Key-Value Store: list buckets, get/put/delete/watch keys, history
  - Object Store: list buckets, upload / download / delete objects
- Account info: limits, usage, connections
- Auth: Username/Password, NKey file, JWT + NKey

### 3.12 Multi-Tab System

Đây là tính năng trung tâm của layout — mọi nội dung đều mở trong tab, không có "active connection" global.

#### Tab identity — mỗi tab mang đủ context
Mỗi tab lưu:
```
{
  id:             uuid,
  connectionId:   "uuid của connection profile",
  connectionName: "Prod PG",           // tên đã đặt trong Connection Manager
  systemType:     "postgres" | "mysql" | "mariadb" | "mssql" | "sqlite" | "clickhouse"
                  | "cassandra" | "redis" | "kafka" | "nats",
  contentType:    "sql-editor" | "table-viewer" | "redis-key" | "kafka-topic"
                  | "kafka-consumer-group" | "nats-subject" | "nats-jetstream"
                  | "cassandra-ring" | "query-plan" | "index-scanner" | ...,
  title:          "orders — query",    // auto-generated hoặc user rename
  isPinned:       false,
  isDirty:        false,               // có unsaved changes không
  state:          { ... }              // nội dung tab (query text, scroll pos, ...)
}
```

#### Tab bar UI
- Mỗi tab hiển thị:
  - **System badge**: 2 ký tự viết tắt + màu theo Color Identity System (xem section 2)
    - `[PG]` PostgreSQL → `#336791`
    - `[MY]` MySQL → `#F29111`
    - `[MA]` MariaDB → `#C0765A`
    - `[MS]` SQL Server → `#CC2927`
    - `[SL]` SQLite → `#0F80CC`
    - `[CH]` ClickHouse → `#FFCC00`
    - `[CS]` Cassandra → `#1287B1`
    - `[RE]` Redis → `#D82C20`
    - `[KF]` Kafka → `#8B5CF6`
    - `[NT]` NATS → `#27AE60`
  - **Connection name** (nhỏ, phụ): `Prod PG`
  - **Tab title** (chính): `orders · SELECT`, `redis:user:*`, `topic:payments`
  - **Dirty indicator** `●` khi có unsaved changes
  - **Pin icon** khi tab được pin (không đóng bằng Ctrl+W)
- Overflow: khi nhiều tab hơn chiều rộng → scroll ngang + dropdown "More tabs"
- Double-click tab title để rename
- Right-click context menu: Pin / Duplicate / Close / Close Others / Close to the Right / Move to new window

#### Tab operations
| Shortcut | Action |
|---|---|
| `Ctrl+T` | New SQL Editor tab (kế thừa connection của tab hiện tại) |
| `Ctrl+W` | Đóng tab hiện tại |
| `Ctrl+Shift+T` | Restore tab vừa đóng |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+1..9` | Jump tới tab theo số thứ tự |
| Drag & drop | Reorder tabs |

#### Connection-aware behavior
- Khi mở SQL Editor mới → mặc định dùng connection của tab đang active
- Có thể **đổi connection ngay trong tab** (dropdown ở toolbar) — tab tự reload schema autocomplete
- Nếu connection bị mất kết nối → tab show banner "Disconnected · Reconnect" không chặn nội dung
- Khi connection bị xóa khỏi Connection Manager → tabs dùng connection đó chuyển sang trạng thái "orphaned", hiển thị cảnh báo

#### Tab groups (Phase 3+)
- Kéo tab ra để tách thành split view (2 cột hoặc top/bottom)
- Mỗi pane có tab bar riêng, cùng dùng chung sidebar Object Explorer
- Tối đa 2×2 panes

#### Persistence
- Toàn bộ tabs + state lưu vào SQLite khi đóng app
- Restore lại đúng thứ tự khi mở lại (pinned tabs restore trước)
- Có thể tắt tính năng restore trong Settings

### 3.13 ER Diagram

Tự động sinh diagram từ schema (tables + foreign keys), hỗ trợ xem trực quan và export ra nhiều định dạng.

#### Tech stack
- **@xyflow/svelte** (Svelte Flow — cùng team React Flow) — render interactive node-based diagram (zoom, pan, drag)
- **Export**: PNG / SVG qua canvas, Mermaid text để share/paste vào docs

#### Tính năng

**Tạo diagram:**
- Mở từ right-click schema/database → "View ER Diagram" → tab `er-diagram`
- Tự động fetch tất cả tables + columns + foreign keys của schema
- Có thể chọn subset tables (checkbox picker trước khi render)
- Re-generate khi schema thay đổi (nút Refresh)

**Layout:**
```
┌──────────────┐         ┌──────────────────┐
│ orders       │         │ users            │
│──────────────│         │──────────────────│
│ PK id        │────┐    │ PK id            │
│ FK user_id   │    └───▶│    name          │
│    status    │         │    email         │
│    created_at│         └──────────────────┘
└──────────────┘
        │
        ▼
┌──────────────────┐
│ order_items      │
│──────────────────│
│ PK id            │
│ FK order_id      │
│ FK product_id    │
│    quantity      │
└──────────────────┘
```
- Auto-layout: **Dagre** (hierarchical) — tự sắp xếp theo FK relationships
- Drag table nodes để reposition thủ công
- Zoom in/out (scroll), Pan (drag background), Fit to screen
- Mini-map ở góc dưới khi diagram lớn

**Nodes (table box):**
- Header: tên table + màu accent của system (PG xanh, MySQL cam...)
- Column rows: icon PK `🔑` / FK `🔗` / index `⌗`, tên, type
- Toggle hiện/ẩn columns (chỉ hiện PK+FK hoặc tất cả)
- Highlight table khi hover — làm nổi các FK connections liên quan

**Edges (relationships):**
- Line nối FK column → PK column của table referenced
- Ký hiệu cardinality: `1` và `N` (one-to-many), `1` và `1` (one-to-one)
- Label: tên FK constraint
- Màu edge theo loại: solid = FK, dashed = inferred (chưa có FK constraint thật)

**Export:**
| Format | Nội dung |
|---|---|
| **PNG** | Ảnh toàn bộ diagram, transparent background tuỳ chọn, độ phân giải 2x |
| **SVG** | Vector, scale không vỡ, embed được vào docs/wiki |
| **Mermaid** | Text `erDiagram` syntax — paste vào GitHub/Notion/Confluence |
| **SQL DDL** | Không export từ diagram, dùng DDL viewer có sẵn |

**Mermaid output mẫu:**
```
erDiagram
  orders {
    int id PK
    int user_id FK
    varchar status
    timestamptz created_at
  }
  users {
    int id PK
    varchar name
    varchar email
  }
  orders }o--|| users : "user_id"
```

**Search trong diagram:**
- `Ctrl+F` trong tab diagram → highlight + pan tới table theo tên

### 3.14 Schema Compare

So sánh schema giữa 2 database **cùng loại** (PG↔PG, MySQL↔MySQL, MSSQL↔MSSQL). Không compare data.

#### Mở
- Từ menu: Connection → "Compare Schema..." → chọn Source + Target
- Source và Target là 2 connection profiles bất kỳ cùng system type
- Chọn schema/database cụ thể cho mỗi bên

#### Kết quả diff

```
┌─ Schema Compare ──────────────────────────────────────────┐
│ Source: [Prod PG · public ▼]   Target: [Dev PG · public ▼]│
│                                          [Re-compare]      │
├────────────────────────────────────────────────────────────┤
│ Filter: [All ▼]  Search: __________                        │
├──────┬───────────────────────┬────────────┬───────────────┤
│ Type │ Object                │ Status     │               │
├──────┼───────────────────────┼────────────┼───────────────┤
│  ▦   │ orders                │ ✎ Different│ [View diff]   │
│  ▦   │ users                 │ ● Identical│               │
│  ▦   │ audit_log             │ ✚ Src only │ [View diff]   │
│  ▦   │ temp_sessions         │ ✖ Tgt only │               │
│  ◫   │ vw_active_orders      │ ✎ Different│ [View diff]   │
│  ⚙   │ sp_process_order      │ ● Identical│               │
│  ƒ   │ fn_calculate_total    │ ✚ Src only │ [View diff]   │
└──────┴───────────────────────┴────────────┴───────────────┘
```

**Status icons:**
| Icon | Nghĩa |
|---|---|
| `●` Identical | Giống nhau hoàn toàn |
| `✎` Different | Khác nhau (column, type, index...) |
| `✚` Src only | Chỉ có ở Source — cần tạo thêm ở Target |
| `✖` Tgt only | Chỉ có ở Target — có thể là object thừa |

**Filter:** All / Different only / Src only / Tgt only / Identical

#### View diff của object
Click "View diff" → split pane DDL:
```
┌─ orders — DDL Diff ─────────────────────────────────────┐
│ Source (Prod PG)              │ Target (Dev PG)          │
│ ─────────────────────────────│──────────────────────────│
│ CREATE TABLE orders (         │ CREATE TABLE orders (    │
│   id SERIAL PRIMARY KEY,      │   id SERIAL PRIMARY KEY, │
│ + last_modified timestamptz,  │                          │
│   user_id INT NOT NULL,       │   user_id INT NOT NULL,  │
│   status VARCHAR(20),         │   status VARCHAR(50),    │ ← khác
│   created_at timestamptz      │   created_at timestamptz │
│ );                            │ );                       │
└───────────────────────────────┴──────────────────────────┘
```
- Highlight: xanh lá = chỉ có ở Source, đỏ = chỉ có ở Target, vàng = khác

#### Generate Migration SQL
- Nút "Generate Migration SQL" → sinh ALTER TABLE / CREATE TABLE / DROP... để đưa Target về giống Source
- Mở trong tab SQL Editor mới, có thể review trước khi chạy
- Checkbox chọn object nào muốn include vào migration
- Export migration SQL ra file

#### Giới hạn
- Chỉ so sánh **cùng system type** — không cross-type (PG vs MySQL)
- Không compare data (row-level)
- Không compare permissions / roles / users

### 3.15 UX / General
- Dark mode / Light mode / System auto
- Keyboard-first navigation
- Global command palette (Ctrl+P): fuzzy search tất cả actions + recent tabs
- Notifications: query done, error, long-running query warning
- Connection status indicator (latency ping) trên tab bar
- Session variables / settings per connection

### 3.16 Tính năng xuyên hệ (áp dụng nhất quán cho cả 10 hệ)

Ba tính năng dưới đây được thiết kế theo cơ chế **adapter chuẩn hóa**: mỗi hệ có 1 adapter
ở driver layer chạy cơ chế native của hệ đó rồi map về struct chuẩn; frontend chỉ làm việc
với struct chuẩn, dùng chung 1 component cho mọi hệ. Luôn giữ kèm raw output gốc (nút
"View raw"). Hệ không hỗ trợ → trả `not_applicable`, UI hiện empty state, không ném lỗi.

#### a) Execute Plan (chi tiết: `EXECUTE_PLAN_AND_INDEX_SCAN_ADDENDUM.md` phần A)
- Mỗi hệ lấy plan theo cơ chế riêng (PG `EXPLAIN FORMAT JSON`, MySQL/MariaDB `EXPLAIN FORMAT=JSON`,
  MSSQL `SHOWPLAN_XML`, SQLite `EXPLAIN QUERY PLAN`, ClickHouse `EXPLAIN PLAN/PIPELINE/ESTIMATE`,
  Cassandra `TRACING ON`) nhưng đều map về **CÙNG một output chuẩn `QueryPlan { root: PlanNode }`**.
- `PlanNode`: operation chuẩn hóa (SeqScan/IndexScan/HashJoin/Sort/...), cost/rows estimated + actual,
  `is_hotspot` (seq scan bảng lớn, actual lệch estimated >10x, ALLOW FILTERING...), tên gốc trong `extra.native_op`.
- UI: 1 component visualizer duy nhất — cây node + mũi tên tỉ lệ row count, hotspot tô cam/đỏ,
  toggle Estimated/Actual, tooltip, View raw. Cassandra render dạng timeline thay vì cây.

#### b) Index Scan (chi tiết: `EXECUTE_PLAN_AND_INDEX_SCAN_ADDENDUM.md` phần B)
- Quét toàn bộ index của connection/schema từ catalog từng hệ (`pg_index`, `information_schema.STATISTICS`,
  `sys.indexes`, `PRAGMA index_list`, `system.data_skipping_indices`, `system_schema.indexes`...)
  → map về **`IndexScanResult { indexes: IndexInfo[] }`** chuẩn.
- `IndexInfo`: tên, bảng, cột (thứ tự + ASC/DESC + included), loại, unique/primary/partial, size,
  cardinality, usage, và **cờ sức khỏe** `health`: unused / redundant / fragmented / invalid / anti_pattern.
- Kèm gợi ý missing index nếu hệ hỗ trợ (PG, MSSQL). UI: bảng + filter theo health + panel DDL + export CSV/JSON.

#### c) Query Editor Error Handling — lint 2 tầng theo dialect (chi tiết: `QUERY_EDITOR_ERROR_HANDLING_ADDENDUM.md`)
- **Tầng 1 — Lint lúc gõ (advisory):** sqlparser-rs đúng dialect + rule pack đặc thù từng hệ
  (CQL không JOIN, MSSQL dùng TOP thay LIMIT, ClickHouse mutation async...), cảnh báo schema-aware,
  cảnh báo thao tác nguy hiểm (UPDATE/DELETE thiếu WHERE). Chỉ vẽ squiggle, **không bao giờ chặn Run**.
- **Tầng 2 — Lỗi thực thi (authoritative):** lỗi thật từ DB chuẩn hóa về struct `QueryError`
  (code, message, position, hint, raw), ánh xạ vị trí về toàn document (PG position → line/col,
  MSSQL line + offset statement), Messages tab click-to-jump, nút View raw error.
- Nếu lint và DB mâu thuẫn → DB thắng.

---

## 4. Bảo mật

| Vấn đề | Giải pháp |
|---|---|
| Lưu mật khẩu | AES-256-GCM, key từ OS keychain (Windows Credential Manager / macOS Keychain) |
| Private SSH key | Không copy vào app storage, chỉ lưu path, đọc khi dùng |
| SQL injection trong app | Parameterized queries cho mọi query internal |
| Tauri CSP | Strict Content-Security-Policy, no remote code loading |

---

## 5. Roadmap theo giai đoạn

> **Stack:** Tauri 2 + Svelte 5 + TypeScript (desktop only, không web)
> **Vibe coding** — ước tính rút ngắn ~40–50% so với manual coding

### Phase 1 — MVP Relational ~~4–6 tuần~~ → **2–3 tuần**
- Connection Manager (PG + MySQL + **MariaDB** + MSSQL + **SQLite**) + SSH Tunnel
- SQLite: file picker + mode (Read-Write / Read-Only / In-Memory); tách vai với storage nội bộ
- Object Explorer cơ bản (Tables, Views, Procs, Functions; SQLite file tree)
- SQL Editor (highlight, F5 run, multi-statement sub-tabs)
- Lỗi thực thi chuẩn hóa (tầng 2): `QueryError` + Messages click-to-jump
- Result Grid read-only + export CSV
- Multi-tab system + Color Identity System (đủ 10 badge/màu)

### Phase 2 — Relational Core ~~3–4 tuần~~ → **1–2 tuần**
- Schema-aware autocomplete
- **ClickHouse basics**: connect + query (driver `clickhouse`, badge CH)
- **Lint lúc gõ (tầng 1)** theo dialect: sqlparser-rs + rule pack + cảnh báo nguy hiểm
- SQLite: file-info header + PRAGMA panel
- Editable grid + pending changes + JSON/Single Row view modes
- Query history + snippets + filter builder
- DDL viewer + Object Explorer đầy đủ

### Phase 3 — Redis + NATS ~~3–4 tuần~~ → **1.5–2 tuần**
- Redis: Key Explorer (all types), TTL, CLI console, Pub/Sub
- NATS: Subscribe, Publish, Request/Reply, JetStream cơ bản
- SSL cho tất cả connections + Tab split view

### Phase 4 — Kafka + NATS full ~~3–4 tuần~~ → **2–3 tuần**
- Kafka: Topic browser, Consumer, Producer, Consumer Groups
- Schema Registry + Avro decode
- NATS JetStream đầy đủ (KV Store, Object Store)

### Phase Cassandra (giữa Phase 4 và Phase 5) — **1–1.5 tuần**
- Driver `scylla`: contact points, local DC, consistency level per-statement
- CQL editor (không JOIN/subquery/OFFSET; WHERE theo partition/clustering key; cảnh báo ALLOW FILTERING)
- Keyspace tree (Tables + partition/clustering key, MV, UDT, UDF, Secondary Indexes)
- Phân trang bằng paging state (không LIMIT/OFFSET)
- Ring Topology từ `system.peers` / `system.local`
- Chi tiết: `CASSANDRA_SPEC_ADDENDUM.md`

### Phase 5 — Power User ~~4–5 tuần~~ → **2–3 tuần**
- Query Plan Visualizer — **đủ 10 hệ** qua adapter chuẩn hóa `QueryPlan/PlanNode` (mục 3.16a)
- **Index Scanner / Analyzer** — `IndexInfo` + cờ sức khỏe (mục 3.16b)
- **ClickHouse nâng cao**: engine badge, TTL Viewer, partition ops, mutations async, MV/Dictionary
- ER Diagram (Svelte Flow + export PNG/SVG/Mermaid)
- Table Designer GUI + Import CSV + Export đầy đủ
- Schema Compare + Command palette

### Phase 6 — Polish ~~2 tuần~~ → **1–1.5 tuần**
- Performance tuning, Settings UI, Keyboard shortcuts
- Auto-update + Installer (Win/macOS/Linux)
- Final QA trên **đủ 10 hệ**

**Tổng: ~~18–26 tuần~~ → ~11–16 tuần**

---

## 6. Out of scope (cá nhân dùng)

- Multi-user / team sharing
- Cloud sync
- Data migration wizard
- ~~MongoDB support~~ → **KHÔNG còn out-of-scope: MongoDB đã được thêm làm engine đầy đủ** (xem §0).
- Query scheduler
- Kafka MirrorMaker / replication tools
- NATS clustering management

---

## 7. Cấu trúc project

```
database-studio/
├── src-tauri/          # Rust backend
│   ├── src/
│   │   ├── connections/    # connection pool, SSH tunnel
│   │   ├── drivers/        # pg.rs, mysql.rs (MySQL + MariaDB), mssql.rs, sqlite.rs,
│   │   │                   # clickhouse.rs, cassandra.rs, redis.rs, kafka.rs, nats.rs
│   │   ├── commands/       # Tauri IPC handlers
│   │   └── storage/        # SQLite nội bộ: connections, history, tabs (tách vai với sqlite.rs user-DB)
│   └── Cargo.toml
├── src/                # Svelte 5 frontend
│   ├── components/
│   │   ├── editor/         # CodeMirror wrapper (SQL + CQL)
│   │   ├── explorer/       # Object tree (SQL + SQLite file tree + ClickHouse + Cassandra keyspace + Redis + Kafka + NATS)
│   │   ├── grid/           # Result table
│   │   ├── redis/          # Key browser, key editors per type
│   │   ├── kafka/          # Topic/consumer group/message viewer
│   │   ├── nats/           # Subject browser, JetStream UI
│   │   ├── clickhouse/     # TTL Viewer, partition ops, engine badges
│   │   ├── cassandra/      # Ring Topology
│   │   └── connections/    # Connection form/list
│   ├── stores/             # Svelte stores (built-in)
│   └── lib/
├── package.json
└── tauri.conf.json
```
