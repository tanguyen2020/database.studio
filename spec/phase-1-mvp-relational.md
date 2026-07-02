# Phase 1 — MVP Relational

**Mục tiêu:** App chạy được, kết nối được PG / MySQL / MariaDB / MSSQL / SQLite, viết và chạy SQL, xem kết quả (kèm lỗi thực thi chuẩn hóa tầng 2).
**Thời gian ước tính:** ~~4–6 tuần~~ → **2–3 tuần** (vibe coding)

---

## Checklist

### 1. Project Setup
- [ ] Khởi tạo Tauri 2 + Svelte 5 + TypeScript
- [ ] Cấu hình Vite, shadcn-svelte, Tailwind CSS
- [ ] Cấu trúc thư mục: `src-tauri/src/{connections, drivers, commands, storage}` và `src/{components, stores, lib}`
- [ ] SQLite schema khởi tạo: bảng `connections`, `tabs`, `query_history`
- [ ] **Storage nội bộ** dùng `rusqlite` — tách vai hoàn toàn với SQLite user-DB (hệ thứ 10, cũng `rusqlite` nhưng code path riêng)
- [ ] Tauri IPC boilerplate: định nghĩa command interface Rust ↔ Svelte

### 2. Color Identity System (nền tảng UI)
- [ ] Định nghĩa CSS variables / Tailwind tokens cho **10 system colors** — token lấy từ map `SYS` trong `Database Studio.dc.html`:
  - PG `#336791` · MY `#F29111` · **MA `#C0765A`** · MS `#CC2927` · **SL `#0F80CC`** · **CH `#FFCC00`** · **CS `#1287B1`** · RE `#D82C20` · KF `#8B5CF6` · NT `#27AE60`
  - Mỗi hệ đủ 4 token: accent / bg / border / fg (text-on-bg) — grep giá trị thật từ HTML, không phỏng đoán
  - Badge Redis = **RE**, NATS = **NT** (theo HTML; SPEC_v2 ghi RD/NA là sai)
  - Bộ màu `orphan` (accent `#5b6473`, badge `⚠`) cho tab mồ côi
- [ ] Component `SystemBadge` — hiển thị badge 2 ký tự với màu tương ứng
- [ ] Component `ConnectionIndicator` — thanh dọc 3px màu accent
- [ ] Icon SVG riêng từng hệ (copy từ `dbIcon()` trong HTML): MariaDB — barrel/cylinder có seal lines; SQLite — feather/file + data cylinder

### 3. Connection Manager
- [ ] UI: danh sách connections ở sidebar trái, có thanh dọc màu theo system
- [ ] Form tạo / sửa connection: host, port, database, user, password
- [ ] Mã hoá password AES-256-GCM, key từ OS keychain (Windows Credential Manager)
- [ ] Driver PG: kết nối qua `sqlx`, test connection
- [ ] Driver MySQL: kết nối qua `sqlx`, test connection
- [ ] Driver MariaDB: dùng chung driver `sqlx` MySQL (badge `MA` `#C0765A`, system type riêng), test connection
- [ ] Driver MSSQL: kết nối qua `tiberius`, test connection
- [ ] Driver SQLite (user-DB): `rusqlite` — form connection hiện **file path + file picker** thay cho host/port; **Mode**: Read-Write / Read-Only / In-Memory; badge `SL` `#0F80CC`; ghi chú "embedded file-based database"
- [ ] SSH Tunnel: port-forward qua `russh` (password + private key file)
- [ ] Nút "Test connection" — trả về latency hoặc lỗi cụ thể
- [ ] Lưu / load connections từ SQLite
- [ ] Duplicate connection profile
- [ ] Delete connection: dialog xác nhận với **Close tabs & Delete** / **Force Delete**
- [ ] Orphaned tab: badge xám + banner "Reassign connection"

#### Edit connection khi đang connected
- [ ] Right-click connection → "Edit" mở form sửa (không cần disconnect trước)
- [ ] Khi save thay đổi, hiện dialog:
  ```
  ┌─ Apply changes to "Prod PG"? ──────────────────────────────┐
  │  Connection này đang có 3 tab mở.                          │
  │  Thay đổi sẽ có hiệu lực ở lần kết nối tiếp theo.         │
  │                                                            │
  │  [Cancel]  [Save & Reconnect]  [Save only]                 │
  └────────────────────────────────────────────────────────────┘
  ```
  | Nút | Hành động |
  |---|---|
  | **Cancel** | Huỷ, không lưu |
  | **Save & Reconnect** | Lưu profile → đóng connection hiện tại → mở lại với config mới → reload tất cả tabs đang dùng connection đó |
  | **Save only** | Lưu profile → giữ nguyên connection đang chạy → config mới áp dụng lần connect tiếp theo |
- [ ] **Save & Reconnect**: các tabs giữ nguyên nội dung editor, tự reconnect và reload schema
- [ ] Nếu reconnect thất bại (sai password mới, host đổi...): tabs chuyển "Disconnected · Reconnect", không mất nội dung
- [ ] Thay đổi chỉ tên/màu/group → lưu ngay, không hỏi (không ảnh hưởng connection)

### 4. Multi-Tab System (cơ bản)
- [ ] Tab bar component: hiển thị badge system + connection name + title
- [ ] Tab state lưu trong Svelte store: `{ id, connectionId, systemType, contentType, title, isPinned, isDirty }`
- [ ] `Ctrl+T` mở tab mới, `Ctrl+W` đóng, `Ctrl+Tab` / `Ctrl+Shift+Tab` chuyển tab
- [ ] `Ctrl+1..9` jump tab theo số
- [ ] Drag & drop reorder
- [ ] Tab active: border-bottom 2px màu accent của system
- [ ] Tab inactive: opacity 60%
- [ ] Overflow: scroll ngang + dropdown "More tabs"
- [ ] Persist tabs vào SQLite khi đóng app, restore khi mở lại
- [ ] `Ctrl+Shift+T` restore tab vừa đóng

### 5. Object Explorer
- [ ] Tree component: Connection → Database/Schema → node groups
- [ ] Node groups: Tables, Views, Stored Procedures, Functions, Triggers, Sequences
- [ ] Icon + màu phân biệt: `▦` Table, `◫` View, `⚙` Proc, `ƒ` Function, `⚡` Trigger, `#` Sequence
- [ ] Expand Table: columns (tên · type · PK/FK/nullable), Indexes, Constraints
- [ ] Expand View: columns
- [ ] Expand Stored Procedure: parameters
- [ ] Expand Function: parameters + return type
- [ ] Phân biệt per-dialect: PG (tách Proc/Function, Sequences), MySQL/**MariaDB** (ẩn Sequences), MSSQL (thêm Schemas, TVF/Scalar)
- [ ] **SQLite file tree** (`sqliteTree`): root = file path → schema `main` → Tables / Views / Triggers; `sqlite_sequence` / `sqlite_master` hiển thị khóa 🔒 (read-only); không có Procs/Functions/Sequences
- [ ] Refresh node riêng lẻ (không reload toàn bộ)
- [ ] Right-click context menu cơ bản: Open Data, New Query, Copy Name
- [ ] Double-click table → mở Table Data Viewer tab

### 6. SQL Editor
- [ ] CodeMirror 6 với syntax highlight: PostgreSQL, MySQL, MariaDB, MSSQL, SQLite dialect
- [ ] Line numbers, bracket matching, code folding
- [ ] `F5` → run tab đang focus:
  - Có selection → run selection
  - Không selection → run toàn bộ
- [ ] `Ctrl+Enter` → run statement tại cursor (tách statement bằng `;`)
- [ ] `Ctrl+F5` / `Esc` → cancel query đang chạy (cơ chế đã chốt: abort statement + reconnect)
- [ ] Split pane resizable: editor trên / result dưới
- [ ] Tab toolbar: connection dropdown (có thể đổi connection trong tab)
- [ ] Khi đổi connection → reload schema cho autocomplete (Phase 2)

### 7. Result Grid (read-only)
- [ ] Multi-statement sub-tabs: mỗi statement ra 1 sub-tab `#N`
- [ ] Sub-tab label tự động: `#N orders · X rows`, `#N ✓ X affected`, `#N ✓ OK`, `#N ✗ error`
- [ ] Tab `Messages`: log execution time + row count + error text từng statement
- [ ] Sequential execution: dừng tại statement lỗi (mặc định)
- [ ] TanStack Table virtualized grid
- [ ] Phân biệt NULL vs empty string
- [ ] Datetime hiển thị local timezone
- [ ] Export CSV (result hiện tại)
- [ ] Copy cell / row / selection (Tab-separated)

### 7b. Lỗi thực thi chuẩn hóa — TẦNG 2 (theo `QUERY_EDITOR_ERROR_HANDLING_ADDENDUM.md`)
- [ ] Struct `QueryError` chuẩn dùng chung mọi hệ: `{ system, statement_index?, code?, message, position?, hint?, severity, raw }`
- [ ] Ánh xạ vị trí lỗi theo hệ: PG `position` (offset ký tự) → line/col; MSSQL `Line L` → cộng offset statement; MySQL/MariaDB best-effort từ "near '...'"; SQLite phần lớn statement-level
- [ ] Không lấy được vị trí chính xác → gắn lỗi ở đầu statement tương ứng (KHÔNG đoán bừa)
- [ ] Highlight statement lỗi trong editor (squiggle đỏ tại `position`, hoặc cả statement)
- [ ] Messages tab: mỗi dòng lỗi hiện severity · code · message · (line:col) — **click nhảy tới đúng vị trí** trong editor; sub-tab `#N ✗ error` cũng nhảy tới statement đó
- [ ] Bảng `hint` theo mã lỗi (vd PG 42P01 → "Bảng không tồn tại...") — mở rộng dần
- [ ] Nút "View raw error": hiện nguyên văn lỗi driver
- [ ] Lint lúc gõ (tầng 1) → Phase 2

### 8. Status Bar
- [ ] Dot `●` màu accent khi connected, xám khi disconnected
- [ ] Hiển thị: connection name · badge system · schema hiện tại · latency · row count

---

## Definition of Done
- Kết nối được PG, MySQL, MariaDB, MSSQL (direct + SSH tunnel) và SQLite (file, đủ 3 mode)
- Viết SQL và chạy bằng `F5`, xem kết quả dạng grid
- Nhiều câu SQL → nhiều sub-tabs result
- Query lỗi → `QueryError` chuẩn hóa, highlight đúng vị trí (PG position, MSSQL line), Messages click-to-jump, View raw
- Mở nhiều tabs, mỗi tab nhận biết đang dùng connection nào qua badge màu
- Đóng app → mở lại tabs vẫn còn
- Delete connection đang dùng → Force Delete không crash app

### Test (bắt buộc)
- Unit test đầy đủ cho toàn bộ logic phase này (parser tách statement, map QueryError, mã hóa password, tab store...)
- Integration test đầy đủ cho **từng hệ trong phase** — PG, MySQL, MariaDB, MSSQL chạy qua **testcontainers**; SQLite test trên file/in-memory thật (không cần container)

### UI đối chiếu 1:1 với `Database Studio.dc.html` (bắt buộc)
- Token màu/spacing/font **grep trực tiếp từ HTML** (`.ds` / `.ds-light` / map `SYS`), không phỏng đoán
- Icon SVG **copy nguyên vẹn** từ `dbIcon()` trong HTML
- Lập **bảng đối chiếu số đo** (kích thước, padding, màu từng thành phần đã làm trong phase) — hoàn thành khi **không còn dòng lệch**
- Snapshot/DOM test cho các component UI của phase (SystemBadge, tab bar, connection list, result grid...)
