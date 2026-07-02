# Phase 1 — MVP Relational

**Mục tiêu:** App chạy được, kết nối được PG / MySQL / MSSQL, viết và chạy SQL, xem kết quả.
**Thời gian ước tính:** ~~4–6 tuần~~ → **2–3 tuần** (vibe coding)

---

## Checklist

### 1. Project Setup
- [ ] Khởi tạo Tauri 2 + Svelte 5 + TypeScript
- [ ] Cấu hình Vite, shadcn-svelte, Tailwind CSS
- [ ] Cấu trúc thư mục: `src-tauri/src/{connections, drivers, commands, storage}` và `src/{components, stores, lib}`
- [ ] SQLite schema khởi tạo: bảng `connections`, `tabs`, `query_history`
- [ ] Tauri IPC boilerplate: định nghĩa command interface Rust ↔ Svelte

### 2. Color Identity System (nền tảng UI)
- [ ] Định nghĩa CSS variables / Tailwind tokens cho 6 system colors (PG, MY, MS, RE, KF, NT)
- [ ] Component `SystemBadge` — hiển thị badge 2 ký tự với màu tương ứng
- [ ] Component `ConnectionIndicator` — thanh dọc 3px màu accent

### 3. Connection Manager
- [ ] UI: danh sách connections ở sidebar trái, có thanh dọc màu theo system
- [ ] Form tạo / sửa connection: host, port, database, user, password
- [ ] Mã hoá password AES-256-GCM, key từ OS keychain (Windows Credential Manager)
- [ ] Driver PG: kết nối qua `sqlx`, test connection
- [ ] Driver MySQL: kết nối qua `sqlx`, test connection
- [ ] Driver MSSQL: kết nối qua `tiberius`, test connection
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
- [ ] Phân biệt per-dialect: PG (tách Proc/Function, Sequences), MySQL (ẩn Sequences), MSSQL (thêm Schemas, TVF/Scalar)
- [ ] Refresh node riêng lẻ (không reload toàn bộ)
- [ ] Right-click context menu cơ bản: Open Data, New Query, Copy Name
- [ ] Double-click table → mở Table Data Viewer tab

### 6. SQL Editor
- [ ] CodeMirror 6 với syntax highlight: PostgreSQL, MySQL, MSSQL dialect
- [ ] Line numbers, bracket matching, code folding
- [ ] `F5` → run tab đang focus:
  - Có selection → run selection
  - Không selection → run toàn bộ
- [ ] `Ctrl+Enter` → run statement tại cursor (tách statement bằng `;`)
- [ ] `Ctrl+F5` / `Esc` → cancel query đang chạy
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

### 8. Status Bar
- [ ] Dot `●` màu accent khi connected, xám khi disconnected
- [ ] Hiển thị: connection name · badge system · schema hiện tại · latency · row count

---

## Definition of Done
- Kết nối được PG, MySQL, MSSQL (direct + SSH tunnel)
- Viết SQL và chạy bằng `F5`, xem kết quả dạng grid
- Nhiều câu SQL → nhiều sub-tabs result
- Mở nhiều tabs, mỗi tab nhận biết đang dùng connection nào qua badge màu
- Đóng app → mở lại tabs vẫn còn
- Delete connection đang dùng → Force Delete không crash app
