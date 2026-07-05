# SPEC_SUPPLEMENT — Database Studio

Supplemental behavioral specs for every **Missing / Partial / Broken / Wired-but-unverified** item in `GAP_REVIEW.md`, plus standard database-tool features absent from both design and code. No code / no long pseudo-code — behavior, UI, per-dialect notes (PG vs ClickHouse where they differ), edge cases only.

Dialect shorthand: **PG** = PostgreSQL (representative of PG/MySQL/MariaDB/MSSQL/SQLite relational path), **CH** = ClickHouse (async/columnar).

---

## 1. Connection Test (Wired-but-unverified → must become Implemented)

**Expected behavior.** Pressing **Test** always resolves to a definitive UI outcome within a bounded time: `✓ Connection successful · <ms>` or `✗ <clear error>`. The button shows `Testing…` only while in flight and must never remain stuck.
**Bounded connect timeout (all dialects).** Every driver's connect/handshake used by `test_connection` must run under an explicit timeout (default 10s, from Settings→Connections). On expiry → return `ok:false, error:"Connection timed out after Ns"`.
- **PG/MySQL/MSSQL:** currently no connect timeout → add one (sqlx/tiberius connect options or an outer time-bound). Include SSH-tunnel establishment inside the same budget.
- **CH:** already 10s; align to the Settings value; distinguish connect-timeout vs HTTP error.
**Error surface.** Map to human messages: refused → "Connection refused (host/port)", auth → "Authentication failed", TLS → "SSL handshake failed", DNS → "Host not found", timeout → above. Show raw detail on hover/expand.
**UI.** Footer status line (`ConnectionForm` footer). Test works in both new and edit modes and for Quick Connect drafts.
**Edge cases.** Test while a previous Test is running (disable/replace, no overlap); Test after fields changed (uses current draft, not saved); dialog closed mid-test (result discarded, no state write to unmounted view — see §2).

## 2. Connection Cancel — real backend abort (Wired-but-unverified → must abort)

**Expected behavior.** Cancel/close during an in-flight Test **aborts the backend attempt in < 1s**, not waiting for the connect timeout. The tunnel/socket is torn down; no orphaned backend future keeps connecting.
**Mechanism (behavioral).** `test_connection` must be cancellable: the frontend signals cancel (a `cancel_test` command keyed by a test id, or an abort token) and the backend drops/aborts the connect future + closes any half-open SSH tunnel. Because a Tauri `invoke` promise can't be aborted from JS alone, the backend must own an abort handle the cancel command triggers.
**UI.** The dialog **Cancel** button and backdrop/Escape both cancel any running Test before closing. If no Test is running, Cancel just closes.
**Per-dialect.** Same contract PG and CH; CH aborts the reqwest request, PG aborts the sqlx connect + SSH tunnel.
**Edge cases.** Cancel arrives after success (ignore, keep result or discard on close); double-cancel (idempotent); cancel with SSH tunnel mid-handshake (tunnel closed, local port freed).

## 3. Cancel running query — standard, verify end-to-end

**Expected behavior.** Ctrl+F5 / Esc / a visible **Cancel** button aborts the executing statement in < 1s and returns control; partial results (if any) discarded; the connection is usable immediately after.
**Per-dialect.** PG: issue server-side cancel (cancel request/`pg_cancel_backend`) or drop+reconnect; MySQL: `KILL QUERY`; MSSQL: attention/cancel token; SQLite: interrupt handle; CH: `KILL QUERY WHERE query_id=` (async) + drop HTTP request. Current impl poisons+reconnects (`registry.rs:154-208`) — verify it actually stops server work, not just the client wait.
**UI.** Run button toggles to Cancel while running; status shows `running Ns`; long-running warning toast > threshold (Settings).
**Edge cases.** Cancel between statements of a multi-statement run (stop the chain); cancel a DDL vs SELECT; cancel when already finished.

## 4. Connection timeout + retry + pooling (standard, Missing)

**Timeout.** Connect timeout (§1) + optional statement timeout (Settings→Query). **Retry.** On transient connect failure, auto-retry N times with backoff (Settings, default 0). Reconnect-on-lost already exists for cancel; extend to idle-drop detection.
**Pooling.** Per-connection pool: min/max size, idle timeout, acquire timeout (Settings→Connections). Today each profile holds a single dedicated connection (`postgres.rs:1`); heavy for parallel tabs. **PG/MySQL/MSSQL/SQLite:** real pool. **CH:** HTTP is stateless — "pool" = bounded concurrent reqwest clients + keep-alive; document that CH has no session state. **Redis/Kafka/NATS/Cassandra:** driver-native pooling; expose size only.
**Edge cases.** Pool exhaustion → queue with acquire-timeout error; SSH-tunneled pool shares one tunnel; pool invalidation on network drop.

## 5. Import data (Partial → complete the wizard)

**Expected behavior.** 5-step wizard (design dc:1975-2039): **File** (CSV **and JSON**, drag-drop + browse, detected delimiter/encoding/row-count, parse-error state) → **Preview** (first N rows) → **Mapping** (source→target column + type, auto-map by name, skip column) → **Options** (on-conflict: INSERT / IGNORE / REPLACE / UPDATE; batch size; encoding; skip-header) → **Execute** (progress bar + result summary: X inserted / Y skipped / Z errors).
**Per-dialect.** PG: `INSERT … ON CONFLICT DO NOTHING/UPDATE`; MySQL: `INSERT IGNORE` / `REPLACE` / `ON DUPLICATE KEY UPDATE`; MSSQL/SQLite: emulate. **CH:** no per-row conflict semantics — force large-batch `INSERT`, disable conflict options, warn "ClickHouse ignores row conflicts; dedup via ReplacingMergeTree". Insert in large batches (columnar), never per-row.
**UI.** Explorer bottom "Import data" + table context "Import Data from File…". Current impl (`ImportDialog.svelte`) has File/Mapping/Execute only → add the **Options step** + **progress bar** + **JSON** parsing.
**Edge cases.** 100k+ rows without timeout (batched, cancellable); type coercion failures reported per-row; header mismatch; empty/quoted/newline CSV cells (parser already handles — keep).

## 6. Export — result & table (Partial → add table/query wizard)

**Result export (done):** CSV/JSON/SQL/Excel from the current grid — keep.
**Table/query Export Wizard (Missing, dc:1763-1806).** Dialog: source table (or current query), format (CSV / xlsx / JSON / SQL INSERT), optional WHERE, row limit, filename, **column checkboxes**, summary, Export → streamed file download. Large exports show a progress bar and are cancellable.
**Per-dialect.** SQL-INSERT export quotes per dialect; **CH** exports may use server `FORMAT CSV/JSONEachRow` for large sets instead of client serialization.
**Edge cases.** 500k rows to Excel (stream/paginate, or warn + fall back to CSV); NULL vs empty distinction preserved; column subset ordering respected.

## 7. Generate Scripts — whole schema/database (Missing) — known gap #3

**Expected behavior.** From connection/schema context "Generate Scripts…" (dc:2138-2164, 3312-3328): choose **Structure only / Data only / Structure + Data**, select multiple objects (tables/views/procs/funcs/triggers/sequences), emit a single script in **correct dependency order** (referenced/parent tables before children/FKs; FKs added after all tables; views after their base tables), per dialect. Output opens in a SQL editor tab and/or saves to `.sql`.
**Per-dialect.** PG: `CREATE TABLE` + separate `ALTER TABLE … ADD CONSTRAINT FK` after all tables; sequences before tables that default from them; server DDL (`pg_get_*`) preferred over column-reconstruction. **CH:** native `CREATE TABLE … ENGINE=… PARTITION BY … ORDER BY … TTL … SETTINGS`; MVs and Dictionaries with their `SOURCE/LAYOUT/LIFETIME`; no FK concept → order by MV/dictionary dependencies instead. Data-only: batched `INSERT` (CH large batches).
**UI.** Toolbar "DDL"/Generate Scripts button (dc:84), connection & schema context menus.
**Edge cases.** Circular FKs (emit tables then all FKs); very large data-only (stream/batch); object subset that breaks dependencies (warn); dialect that lacks an object type (skip + note).

## 8. Grid + ClickHouse async mutation (Implemented — known gap #4, regression spec)

**Status: done** in commit `1324801`. Behavioral contract to preserve/regress-test: for CH, the editable grid does **not** run OLTP `UPDATE/DELETE`; the Apply action is replaced by **Generate mutation** which produces `ALTER TABLE … UPDATE col=… WHERE …` / `ALTER TABLE … DELETE WHERE …` (and batched `INSERT`), opened in a SQL editor with an async-cost warning; nothing is auto-committed. A banner states edits are async mutations tracked via `system.mutations`. PG path unchanged (transactional Apply + Preview diff).
**Edge cases.** NULL in WHERE → `IS NULL`; multi-row edits → multiple ALTERs; identifiers backtick-quoted; lightweight `DELETE FROM … WHERE` acceptable variant.

## 9. Dictionaries node in Object Explorer (Implemented — known gap #5, regression spec)

**Status: done** in commit `1324801`. Contract: under each ClickHouse database a **Dictionaries** folder (from `system.dictionaries`), each entry with context menu **Show Definition** (`SHOW CREATE DICTIONARY`), **Query**, **Reload** (`SYSTEM RELOAD DICTIONARY`), **Copy Name**, **Drop** — all opening generated SQL in an editor. Lazy-loaded on folder expand.
**Still Missing (spec):** schema context "Create Materialized View / Dictionary / Function" items (dc:3467-3470) — a create-object flow.
**Edge cases.** DB with no dictionaries → empty folder (count 0); dictionary in `system` DB → read-only.

## 10. Broken stubs → real behavior

- **Set as Filter** (column context): apply `col = <cell/prompt>` into the active Table Viewer filter builder. (`ObjectExplorer.svelte:528`)
- **Export / dump**, **Backup database** (Explorer toolbar): route to §6 export / §12 backup. (`:819,:822`)
- **Users & privileges** (`:825`): a privileges viewer/GRANT-REVOKE screen (see §16) or hide until built.
- **Convert dialect** (`SqlWorkspace.svelte:340`): full converter (dc:1630-1678) — source/target dialect, input/output, conversion notes, Copy/Open-in-tab. At minimum wire the existing formatter + a documented transform set.
- **Split editor** toolbar button (`:343`): call the existing `tabs.splitDir` split (feature exists via tab menu) instead of a toast.
- **ResultChart PNG/SVG** (`ResultChart.svelte:151-152`): real export (reuse the ER `toSvg`→canvas approach).
- **SQLite Export .sql** (`SqliteFileHeader.svelte:114`): route to §7 Generate Scripts for the SQLite file.
Each: replace the `later()`/`toasts.show()` no-op with the real action; if genuinely deferred, remove the control rather than shipping a dead button.

## 11. Query Plan completeness (Partial/Broken/Missing)

- **MSSQL (Broken):** use `SET SHOWPLAN_XML ON` (estimated) / `SET STATISTICS XML ON` (actual) and parse the XML showplan into the normalized tree — current `EXPLAIN {sql}` is invalid on MSSQL.
- **ClickHouse (Partial):** parse `EXPLAIN PLAN` / `EXPLAIN indexes=1` into nodes (primary-key / data-skipping index usage) instead of raw text.
- **MariaDB (Partial):** support `ANALYZE FORMAT=JSON` for actual `r_rows`/`r_filtered`.
- **Cassandra (Missing):** `TRACING ON` → read session trace → render a **timeline** of coordinator→replica steps, partitions read, ALLOW FILTERING full-scan flag, per-node latency (not a tree).
- **Hotspot:** add "node dominates total time" and Cassandra ALLOW-FILTERING rules.
**Edge cases:** actual mode confirms it runs the query (side effects); Redis/Kafka/NATS stay `not_applicable` (button disabled, no error).

## 12. Backup & Restore (Missing)

**Expected behavior (dc:1113-1162,1680-1761).** Backup view per connection: Create Backup Now, history table (timestamp/scope/size/format/status) with Restore/Download/Delete. Backup modal: scope (Full / selected tables), format (`.sql` / `.dump`), gzip toggle, progress. Restore modal: warning + "cannot be undone" ack + progress.
**Per-dialect.** PG: `pg_dump`/`pg_restore` (needs binaries — detect & guide); MySQL: `mysqldump`; **CH:** `BACKUP TABLE/DATABASE … TO Disk(...)` (server-side) — different model, no client dump; note this. SQLite: file copy / `.dump`.
**Edge cases.** Missing external binaries (clear guidance); very large DB (progress + cancel); restore into non-empty DB (confirm/overwrite).

## 13. Autocomplete completeness (Partial)

**Add:** function signatures + return types; dialect keyword sets already present; column suggestions after alias (`o.` where `o` aliases a known table). **Per-dialect:** CH functions (e.g. `toYYYYMM`, agg-combinators), PG functions. Debounce from Settings. **Edge cases:** unknown table alias (no crash), large schemas (cap suggestions), CTE/derived-table columns best-effort.

## 14. Transaction control (standard, Partial)

**Expected.** Explicit BEGIN/COMMIT/ROLLBACK affordances (toolbar toggle or auto-detected from typed SQL) with clear state indicator; editable-grid Apply already wraps a transaction (PG). **Per-dialect:** **CH has no transactions** — disable/gray transaction controls, warn "ClickHouse is non-transactional". **Edge cases:** open transaction across statements in one tab; rollback on error (continue-on-error Setting); connection reused after rollback.

## 15. Error surface (mostly Implemented — keep/verify)

Message + position (line/col) with squiggle; "View raw"; per-dialect position mapping (PG offset, MSSQL line, MySQL best-effort, SQLite/CH statement-level). Verify CH HTTP errors and Cassandra CQL exceptions map to clear messages (already mapped). No silent swallow (ties to §1 timeout).

## 16. Missing prototype views (spec for parity)

- **Session Monitor** (dc:1188-1255): sessions + locks tables with Kill/Kill-blocker, auto-refresh interval, per-connection. PG `pg_stat_activity`/`pg_locks`; MySQL `processlist`; MSSQL DMVs; CH `system.processes` (+ `KILL QUERY`). Cassandra/Redis/Kafka/NATS: not applicable or system-specific.
- **Postgres Extension Manager** (dc:1080-1111): list/install/drop extensions (`pg_available_extensions`).
- **MSSQL Agent Jobs / Query Store / Availability Groups** (dc:961-1078): read from msdb/Query-Store DMVs/AG DMVs; start/stop job, force/unforce plan (read-mostly).
- **SQL Dialect Converter** (dc:1630-1678): see §10.
- **Right-side Object Properties panel** (dc:1512-1524): DDL + statistics + indexes + sample values for selected table/column.
- **Results Group By popover** (dc:352-385): client-side grouping + aggregations (none/SUM/AVG/COUNT/MIN/MAX).
Each of these is optional-advanced; prioritize per §Tasks.

## 17. Keyboard shortcuts (Partial) & secure connections (Implemented — keep)

**Add bindings:** `Ctrl+Shift+F` Format, `Ctrl+Alt+G/J/R` result Grid/JSON/SingleRow, `Ctrl+Shift+C` copy result as JSON, `Ctrl+F` sidebar/JSON search. Show shortcut in button tooltips. Verify no OS conflicts (win/mac/linux). **Secure connections:** passwords already AES-256-GCM + keychain (`storage/crypto.rs`) — keep; never log secrets; SSH keys by path only.

---

## Implementation priority — tasks (continue T-numbering)

Order: (1) fix **Broken/Wired-but-unverified** first, (2) complete **Partial**, (3) **Missing** by essentiality. Each task: scope + done-criteria (tests + commit gate). Commit only when its tests pass; integration tests seed a real container then query back (no hard-coded results), rely on testcontainers Drop cleanup, never system-prune images.

**T10 — Connection Test/Cancel correctness (Broken/Wired-but-unverified).**
Scope: bounded connect timeout for PG/MySQL/MSSQL (+ align CH to Settings); cancellable `test_connection` with real backend abort (< 1s) incl. SSH tunnel teardown; friendly error mapping; dialog Cancel/Esc aborts running Test.
Done: unit (error-mapping, timeout config); integration — start a PG container then Test against a **closed port** returns `✗ timed out` within timeout; Test against the live container returns `✓ + latency`; a cancel signal aborts a Test to an unreachable host in < 1s (assert wall-clock). Commit after green.

**T11 — Cancel running query verified (Wired-but-unverified).**
Scope: confirm/implement true server-side cancel per dialect; Run↔Cancel UI + `running Ns` + long-run warning.
Done: integration — run a deliberately slow query (e.g. PG `pg_sleep`, CH `sleep()`), cancel, assert it returns < 1s and the connection executes a follow-up query successfully. Commit after green.

**T12 — Wire dead stubs (Broken).**
Scope: Set-as-Filter, Split-editor toolbar btn, ResultChart PNG/SVG, SQLite Export .sql, Convert dialect (min: formatter+notes), and route Export/Backup/Users toolbar to their features (or remove until built).
Done: visual specs click each control and assert the real effect (tab opens / filter applied / file blob / no dead toast). Commit after green.

**T13 — Import wizard completion (Partial).**
Scope: add Options step (on-conflict/batch/encoding/skip-header) + progress bar + JSON import.
Done: unit (conflict-SQL per dialect); integration — import 100k CSV rows into a real PG table, query back count; CH path forces batched INSERT + disables conflict opts. Commit after green.

**T14 — Table/Query Export Wizard (Partial/Missing).**
Scope: export dialog (format/WHERE/columns/limit/filename) for table + current result; large-set streaming.
Done: unit (per-format serialization incl. column subset + WHERE); integration — export a seeded PG table to CSV/SQL, re-import and match row count. Commit after green.

**T15 — Generate Scripts whole schema/DB (Missing) — known gap #3.**
Scope: structure-only / data-only / both; multi-object; dependency order; per-dialect (PG ALTER-ADD-FK after tables; CH native engine DDL + MV/dict order).
Done: unit (dependency ordering — child after parent, FK last, view after base); integration — generate structure for a seeded PG schema (tables+FK+view), run the script into a fresh schema, diff introspection = identical; CH structure round-trips `SHOW CREATE`. Commit after green.

**T16 — Query Plan per-system (Broken/Partial/Missing).**
Scope: MSSQL SHOWPLAN_XML parse; CH `EXPLAIN` tree + indexes; MariaDB ANALYZE actual; Cassandra TRACING timeline; hotspot rules.
Done: integration per system — run EXPLAIN on a seeded table, assert a normalized root/child node with expected op; Cassandra ALLOW FILTERING flagged. Commit per-system as each goes green.

**T17 — Index Scanner completeness (Partial/Missing).**
Scope: ClickHouse (`system.data_skipping_indices`) + Cassandra (`system_schema.indexes`) adapters; anti_pattern flag; missing-index suggestions (PG repeated seq-scan, MSSQL DMV).
Done: integration — seed indexes on CH/Cassandra, scan returns them + correct flags. Commit after green.

**T18 — Explorer depth (Partial/Missing).**
Scope: View column expansion; Proc/Func/Trigger context menus (Show Definition/Drop); index/constraint detail children; tree Ctrl+F search; right-side Object Properties panel.
Done: visual + unit (DDL/definition generation); integration for Show Definition returning real server text. Commit after green.

**T19 — Schema Compare depth (Partial).**
Scope: include procedures/functions/triggers; side-by-side DDL diff panel with prev/next + highlight.
Done: unit (diff over routine DDL text); integration — two seeded PG schemas differing by a proc + a column, assert statuses + migration. Commit after green.

**T20 — ER create-relationship + Save-to-DB (Missing).**
Scope: "+ Relationship" (draw FK) + "Save to DB" emitting `ALTER TABLE … ADD CONSTRAINT FK`; cardinality 1/N markers; in-tab Ctrl+F.
Done: unit (ALTER-ADD-FK generation); integration — apply to a seeded PG pair, introspect FK exists. Commit after green.

**T21 — Timeout/retry/pooling + transactions + autocomplete + shortcuts (standard, Partial/Missing).**
Scope: connection pool (size/idle/acquire) + retry/backoff Settings→Connections; explicit BEGIN/COMMIT/ROLLBACK affordance (disabled for CH); autocomplete function signatures; bind missing shortcuts (Ctrl+Shift+F, Ctrl+Alt+G/J/R, Ctrl+Shift+C, Ctrl+F).
Done: unit (pool config, shortcut map); integration — concurrent tabs share a pool without exhaustion; rollback discards a seeded insert. Commit after green.

**T22 — Backup & Restore (Missing, advanced).**
Scope: backup view/modal/history + restore confirm; PG `pg_dump`/`pg_restore`, MySQL `mysqldump`, CH `BACKUP … TO Disk`, SQLite `.dump`; detect missing binaries.
Done: integration where a tool is available (SQLite `.dump` round-trip guaranteed; PG pg_dump if binary present, else skip with note). Commit after green.

**T23 — MSSQL/PG admin views (Missing, advanced, lowest priority).**
Scope: Session Monitor (sessions/locks + Kill), PG Extension Manager, MSSQL Agent Jobs / Query Store / Availability Groups, Redis memory analysis, Kafka ACL/Avro, NATS NKey-JWT + JetStream management UI wiring.
Done: per-feature integration hitting the real engine's system views; commit each independently as green.

---

## AUDIT-1 — Hậu T10–T23 (rà soát desktop). Sửa 3 mục nhỏ + plan 1 mục lớn.

**A1 — Connection persistence: ✅ đã đạt** (audit) — profiles lưu `studio.db` (bảng `connections`, AES-GCM), tự nạp `App.svelte onMount → connections.load()`; cờ runtime `connected` không persist (đúng: reconnect khi mở lại).

**A2 — Hover dòng connection (Fixed).**
Bug: `ConnectionList.svelte` set `background` INLINE → nuốt `:hover`. Fix: chuyển sang class `.conn-row` + `class:selected`, `:hover` → `var(--hover)`, `.selected` → `var(--hover)` + thanh accent `inset 2px var(--primary)`. Visual `audit-fixes.spec #3`.

**A3 — Generate Scripts 3 chế độ trên table context menu (Fixed).**
Trước: 3 mode (Structure/Data/Both) chỉ có ở SCHEMA. Bổ sung `ContextMenu.Sub "Generate Scripts"` (Structure Only / Data Only / Structure and Data) vào table menu → `genTableScript(schema, table, mode)` dùng lại engine thuần `generateScript` + `genCreate`/`genForeignKey`/`toSqlInsert` (không trùng logic dialog). Visual `audit-fixes.spec #4`.

**A4 — Save ER diagram layout (Fixed).**
Persist vị trí node vào `tab.state.positions`; `SvelteFlow onnodedragstop → saveLayout()` (debounce qua `tabs.schedulePersist`, 400ms). `layout()` ưu tiên vị trí đã lưu, fallback dagre. "Auto-layout" xoá saved rồi re-dagre. Mở lại tab giữ layout. (Persistence e2e không test được trên demo/browser vì tab-persist dùng SQLite thật; verify bằng typecheck + logic.)

**A5 — Streaming I/O (PLAN, chưa code — thay đổi kiến trúc lớn).**
Hiện trạng: export/generate/diagram-export buffer TOÀN BỘ vào RAM (sqlx `.fetch_all` → `Vec<Value>`; frontend gom rows → 1 chuỗi → `Blob`). Chỉ backup (rusqlite backup / pg_dump ghi file) là đúng stream.
Plan chuyển sang stream:
  1. Backend command `export_to_file(conn_id, select_sql, format, dest_path)`: `sqlx::query(..).fetch(&mut conn)` (Stream), serialize INCREMENTAL từng row/chunk, ghi `BufWriter<File>` + flush theo chunk → RAM bị chặn ở 1 chunk; export không đi qua IPC.
  2. Serializer incremental (Rust): CSV (header + dòng), JSON (stream `[ … , … ]`), SQL (INSERT theo N dòng).
  3. Frontend: thay browser `Blob` bằng `plugin-dialog` save → truyền `dest_path` cho command; progress qua `tauri::ipc::Channel` (số dòng đã ghi). Giữ Blob CHỈ cho export result-panel nhỏ (đã materialized).
  4. Generate Scripts / whole-schema: dùng chung command file-stream. Backup giữ nguyên (đã ổn).
  5. Test: integration export ≥100k dòng ra file → đếm dòng file == row count mà không nạp cả set vào RAM.
Ước lượng: ~1–2 task (backend stream command + serializer + test; frontend save-dialog + progress). Rủi ro: chạm đường exec/serialize hiện có — cần giữ nguyên contract cho export nhỏ.
