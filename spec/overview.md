# Database Studio — Product Spec

## 1. Tổng quan

**Database Studio** là một desktop app cá nhân để quản lý và làm việc với cơ sở dữ liệu và message broker. Mục tiêu: nhẹ, nhanh, đủ tính năng cho developer/DBA cá nhân, không cần server.

### Connections hỗ trợ

| Loại | Hệ thống |
|---|---|
| **Relational DB** | PostgreSQL 12+, MySQL / MariaDB 8+, SQL Server 2014+ (v12+) |
| **Key-Value Store** | Redis 6+ / Redis Stack / Valkey |
| **Message Broker** | Apache Kafka 2.8+, NATS 2.x (bao gồm JetStream) |

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
| **Kafka** | `#231F20` (dark) / `#8B5CF6` (accent) | `#1e1a2e` | `#3d2f6b` | `#c4b5fd` | `KF` |
| **NATS** | `#27AE60` | `#0d2e1a` | `#1a5c35` | `#6ee7a0` | `NT` |

> Accent = màu đặc trưng thương hiệu. Background = nền tối dùng trong dark mode. Text on bg = màu chữ khi render trên Background.

### Áp dụng ở đâu

#### 1. Connection List (sidebar trái)
```
┌──────────────────────────────┐
│ ▐█ Prod PG          [🐘 PG] │  ← thanh dọc màu #336791, badge "PG" nền #1a3a52
│ ▐█ Dev MySQL        [MY]    │  ← thanh dọc màu #F29111
│ ▐█ Analytics MSSQL  [MS]    │  ← thanh dọc màu #CC2927
│ ▐█ Cache Redis      [RE]    │  ← thanh dọc màu #D82C20
│ ▐█ Events Kafka     [KF]    │  ← thanh dọc màu #8B5CF6
│ ▐█ Messaging NATS   [NT]    │  ← thanh dọc màu #27AE60
└──────────────────────────────┘
```
- Thanh dọc 3px bên trái mỗi connection = màu Accent
- Badge `[PG]` `[MY]` ... = text màu "Text on bg", nền màu Background, border màu Border

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
- Badge text luôn là 2 ký tự viết tắt (PG, MY, MS, RE, KF, NT) — không dùng logo/emoji vì không scale nhỏ

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
| SQL drivers | Rust: `sqlx` (PG, MySQL), `tiberius` (MSSQL) | Native, async, type-safe |
| Redis driver | Rust: `redis` (redis-rs) | Async, connection pool, Pub/Sub |
| Kafka driver | Rust: `rdkafka` (librdkafka) | Production-grade, SASL, consumer groups |
| NATS driver | Rust: `async-nats` | Official Rust client, JetStream support |
| SSH tunnel | Rust: `russh` | Thuần Rust, không cần OpenSSH |
| Storage | **SQLite** (via `rusqlite`) | Lưu connections, history, snippets |

### Luồng kết nối
```
Frontend (React)
    ↕ Tauri IPC (async commands)
Rust backend
    ↕ SSH tunnel (russh) — optional
    ├── Relational  →  PG / MySQL / MSSQL   (sqlx, tiberius)
    ├── Key-Value   →  Redis / Valkey        (redis-rs)
    ├── Kafka       →  Broker cluster        (rdkafka)
    └── NATS        →  Server / JetStream    (async-nats)
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
- Syntax highlighting đa dialect (PG / MySQL / MSSQL)
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
- Support: PG `EXPLAIN ANALYZE`, MySQL `EXPLAIN FORMAT=JSON`, MSSQL Actual Execution Plan

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
  systemType:     "postgres" | "mysql" | "mssql" | "redis" | "kafka" | "nats",
  contentType:    "sql-editor" | "table-viewer" | "redis-key" | "kafka-topic"
                  | "kafka-consumer-group" | "nats-subject" | "nats-jetstream" | ...,
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
    - `[MS]` SQL Server → `#CC2927`
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
- Connection Manager (PG + MySQL + MSSQL) + SSH Tunnel
- Object Explorer cơ bản (Tables, Views, Procs, Functions)
- SQL Editor (highlight, F5 run, multi-statement sub-tabs)
- Result Grid read-only + export CSV
- Multi-tab system + Color Identity System

### Phase 2 — Relational Core ~~3–4 tuần~~ → **1–2 tuần**
- Schema-aware autocomplete
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

### Phase 5 — Power User ~~4–5 tuần~~ → **2–3 tuần**
- Query Plan Visualizer (PG / MySQL / MSSQL)
- ER Diagram (Svelte Flow + export PNG/SVG/Mermaid)
- Table Designer GUI + Import CSV + Export đầy đủ
- Command palette

### Phase 6 — Polish ~~2 tuần~~ → **1–1.5 tuần**
- Performance tuning, Settings UI, Keyboard shortcuts
- Auto-update + Installer (Win/macOS/Linux)

**Tổng: ~~18–26 tuần~~ → ~10–15 tuần**

---

## 6. Out of scope (cá nhân dùng)

- Multi-user / team sharing
- Cloud sync
- Data migration wizard
- MongoDB support
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
│   │   ├── drivers/        # pg.rs, mysql.rs, mssql.rs, redis.rs, kafka.rs, nats.rs
│   │   ├── commands/       # Tauri IPC handlers
│   │   └── storage/        # SQLite: connections, history
│   └── Cargo.toml
├── src/                # React frontend
│   ├── components/
│   │   ├── editor/         # CodeMirror wrapper
│   │   ├── explorer/       # Object tree (SQL + Redis + Kafka + NATS)
│   │   ├── grid/           # Result table
│   │   ├── redis/          # Key browser, key editors per type
│   │   ├── kafka/          # Topic/consumer group/message viewer
│   │   ├── nats/           # Subject browser, JetStream UI
│   │   └── connections/    # Connection form/list
│   ├── stores/             # Svelte stores (built-in)
│   └── lib/
├── package.json
└── tauri.conf.json
```
