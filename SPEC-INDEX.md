# SPEC-INDEX — Bản đồ kiến trúc & spec (đọc đầu tiên cho dev mở rộng)

> Điểm vào cho DEV MỚI muốn thêm/sửa tính năng. Mô tả bức tranh lớn + ranh giới module + trỏ xuống các
> spec con. Kèm `file:line` ở điểm quan trọng. Nguồn sự thật cuối cùng luôn là **code**; tài liệu chỉ điều
> hướng. Cập nhật 2026-07-22.

Database Studio = **Tauri 2 desktop client** (Rust backend `src-tauri/` + Svelte 5 frontend `src/`) cho
**12 hệ**: PostgreSQL, MySQL, MariaDB, MSSQL, SQLite, ClickHouse, Cassandra, Redis, Kafka, NATS, **MongoDB**,
**Oracle**.

---

## 1. Sơ đồ module (bức tranh lớn)

```
                         Svelte 5 UI (src/)
  App.svelte ─ dispatch theo tab.contentType ─► workspace components (src/lib/components/**)
        │                                              │
        │  stores runes (src/lib/stores/*.svelte.ts)   │ pure-logic (không I/O, unit-test)
        │  connections·tabs·results·explorer·ui·…      │ src/lib/{sql,users,mongo,redis,stream,
        │                                              │   export,import,compare,copy,er,testdata,
        ▼                                              │   grid,format,keys}
  src/lib/ipc.ts  ── invoke() ──┬── IS_TAURI ──► Tauri command (thật)
    (typed wrappers)            └── !IS_TAURI ─► src/lib/demo.ts (mock) ◄── Vitest/Playwright chạy đường này
                                        │
        ══════════════════ ranh giới Tauri ══════════════════
                                        ▼
  src-tauri/src/lib.rs  invoke_handler![ … ]   ◄── command CHƯA đăng ký = command chết
        │
  src-tauri/src/commands/*.rs   (#[tauri::command] mỏng, orchestration)
        │
  src-tauri/src/connections/registry.rs  (giữ live connection/profile, SSH tunnel, cancel)
        │
  src-tauri/src/drivers/mod.rs  enum LiveConnection { Postgres(..)|MySql|Mssql|Sqlite|Clickhouse|
        │                          Redis|Nats|Kafka|Cassandra|Mongo|Oracle }  (mod.rs:46-58)
        │      + match arms per method (connect/test/exec/ping/exec_params/apply_grid/introspection…)
        ▼
  src-tauri/src/drivers/<system>.rs   (mỗi hệ 1 module driver)
        │
  src-tauri/src/storage/mod.rs   rusqlite NỘI BỘ (connection profiles AES-256-GCM, tabs, history, Snippet)
                                  — TÁCH VAI với SQLite mà user kết nối tới
```

---

## 2. Ranh giới module (ai làm gì — KHÔNG lẫn)

| Module | File | Trách nhiệm | Ghi chú |
|---|---|---|---|
| Tauri boundary + dual-mode IPC | `src/lib/ipc.ts:8-9` | `invoke()` → Tauri thật HOẶC `demo.ts` khi ngoài Tauri | **Mỗi command mới cần 1 case trong `demo.ts`** nếu không Vitest/Playwright vỡ |
| Driver layer | `src-tauri/src/drivers/mod.rs` + `<system>.rs` | Hợp nhất sau enum `LiveConnection`; match arm dispatch per variant | Hệ non-SQL trả "not applicable" từ arm SQL, expose feature qua command riêng |
| Commands | `src-tauri/src/commands/*.rs` | `#[tauri::command]` mỏng, orchestration | Đăng ký ở `lib.rs` `invoke_handler!` |
| Registry | `src-tauri/src/connections/registry.rs` | Sở hữu live connection (1/profile), SSH tunnel, cancel (abort+reconnect), per-driver param | |
| Storage | `src-tauri/src/storage/` | rusqlite nội bộ (profiles/tabs/history/app_state) | Khác SQLite người dùng kết nối |
| Result contract | `src-tauri/src/drivers/types.rs:83` | `ExecResponse { ok, result?, affected?, error?, duration_ms }` (`StatementOutcome`) | Editor tách statement client-side, gửi từng câu |
| Frontend state | `src/lib/stores/*.svelte.ts` | Runes classes: `connections·tabs·results·explorer·ui·settings·palette…` | |
| Pure-logic | `src/lib/{sql,users,mongo,…}` | DDL/autocomplete/diff/export… THUẦN, unit-test qua Vitest | Không gọi ipc trong lớp này khi tránh được |

---

## 3. Công thức mở rộng (recipe)

### 3.1. Thêm 1 workspace/tab type mới (3 edit — bắt buộc đủ)
1. Thêm giá trị vào `TabContentType` (`src/lib/types.ts:214-239`).
2. Thêm method `open…` trên store `tabs` (`src/lib/stores/tabs.svelte.ts`).
3. Thêm nhánh `{:else if}` trong `paneBody` của `App.svelte`.

### 3.2. Thêm 1 `#[tauri::command]`
`commands/<x>.rs` → thêm case `demo.ts` → wrapper `ipc.ts` → **đăng ký `lib.rs` invoke_handler** (thiếu bước
cuối = command chết).

### 3.3. Thêm 1 hệ database
Driver module `drivers/<system>.rs` + variant trong `LiveConnection` + **nhánh trong TỪNG match arm** của
`mod.rs` + `<system>_params()` builder + `SystemType` (`types.ts`) + token màu (`npm run tokens`) + nhánh
`sql/*.ts` nếu relational. Xem `SPEC-ORACLE-FEATURE.md` (khuôn relational) và `SPEC-MONGODB-FEATURE.md`
(khuôn non-SQL) làm 2 precedent đầy đủ, có `file:line`.

---

## 4. Bản đồ spec (trỏ xuống spec con)

### Spec tính năng — SÁT CODE, dùng để mở rộng (ưu tiên đọc)
| Spec | Nội dung | Trạng thái đối chiếu |
|---|---|---|
| `SPEC-EXPLAIN-FEATURE.md` | Query Plan/EXPLAIN đa-engine (parser Rust) | **Đã viết lại** theo code (bản LLM/TS cũ = Deprecated) |
| `SPEC-USERS-PRIVILEGES.md` | Users/Roles/Grant 8 engine | Đã implement; đối chiếu ở §0.0 của file |
| `SPEC-ORACLE-FEATURE.md` | Oracle engine (khuôn relational) | Đã implement; §0.0 sửa mâu thuẫn driver |
| `SPEC-MONGODB-FEATURE.md` | MongoDB engine (khuôn non-SQL) | Đã implement; §0.0 lệch nhỏ |
| `SPEC-BACKUP-RESTORE.md` | Backup & Restore per-engine (SQLite in-process; PG/MySQL/CH/Mongo shell tool) | Viết mới theo code |

### Addendum thiết kế theo hệ (phần lớn còn đúng — override spec gốc khi mâu thuẫn)
`spec/Database Studio design/design_handoff_database_studio/`:
`CASSANDRA_SPEC_ADDENDUM.md` · `CLICKHOUSE_SPEC_ADDENDUM.md` · `EXECUTE_PLAN_AND_INDEX_SCAN_ADDENDUM.md`
· `QUERY_EDITOR_ERROR_HANDLING_ADDENDUM.md`. Lưu ý code: ClickHouse dùng `reqwest` (không crate
`clickhouse`); Index Scanner dùng `IndexScanRow.flags` (KHÔNG có `anti_pattern`).

### Tài liệu tổng quan & lịch sử
| Tài liệu | Vai trò |
|---|---|
| `spec/overview.md` | Product spec tổng — có §0 đối chiếu (12 hệ, folder src/lib…) |
| `spec/phase-1..6*.md`, `spec/phase-4b-cassandra.md` | **Deprecated** — checklist kế hoạch lịch sử |
| `GAP_REVIEW.md`, `SPEC_SUPPLEMENT.md` | **Deprecated** — backlog giai đoạn T10–T31 (một số mục đã lỗi thời) |
| Design handoff (`DATABASE_STUDIO_SPEC_v2.md`, `README.md`, `START_HERE.md`) | Di sản thiết kế; prototype `Database Studio.dc.html` vẫn là **nguồn sự thật UI** |
| `CLAUDE.md` | Nhật ký tiến độ + quyết định (chi tiết nhất về các AUDIT/tính năng gần đây) |
| `SPEC-AUDIT-PHASE1.md` | Báo cáo đối chiếu spec↔code (Giai đoạn 1) — căn cứ cho các bản cập nhật này |

### Trạng thái verify (minh bạch)
- Toàn bộ nhóm spec đã verify đầy đủ đối chiếu code (kể cả `spec/phase-2/3/4/4b/6`, `README.md`,
  `DATABASE_STUDIO_SPEC_v2.md`) — xem `SPEC-AUDIT-PHASE1.md` (có "## PHỤ LỤC — VERIFY ĐẦY ĐỦ").
- TODO thật còn lại (từ verify): Import/Export connection profiles JSON, Auto-update (Tauri updater),
  Installer thiếu macOS dmg, `Ctrl+Shift+E` Explain (chưa có phím tắt) — ngoài các TODO đã ghi ở §0.0 từng spec.

---

## 5. Lệnh chạy nhanh (chi tiết trong CLAUDE.md)

```bash
npm run check                 # gate frontend: svelte-check + tsc (0 errors/0 warnings)
npx vitest run                # unit test frontend (demo path, không cần DB)
npx playwright test           # visual/e2e (demo path)
# Rust (prefix PATH cargo — xem CLAUDE.md):
cargo test --lib              # unit thuần backend (plan::/lint::/pool:: …)
cargo test --test drivers_integration <name> -- --test-threads=1   # integration container thật
```
