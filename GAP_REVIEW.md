# GAP_REVIEW — Database Studio (design ↔ code)

Audit-only. Design sources read in full: `Database Studio.dc.html` (6053 lines, exhaustive element inventory), `CLICKHOUSE_SPEC_ADDENDUM.md`, `phase-1..6`. Code base: `src/` (Svelte) + `src-tauri/` (Rust).

Status legend: **Implemented** (wired end-to-end, evidence) · **Partial** (present but missing part) · **Missing** (no code) · **Broken** (UI present, handler is a no-op/stub or backend link dead) · **Wired-but-unverified** (code path exists but runtime correctness unconfirmed / known runtime doubt).

> Evidence `file:line` uses `dc:N` for `Database Studio.dc.html`. Code paths are repo-relative.
>
> **Refreshed 2026-07-05** after T10–T23 + AUDIT-1/2/3. The original audit was a pre-T10 snapshot; the tasks/audits closed most of its gaps. Each row below now carries its current status with the closing task noted (e.g. `[T14]`, `[A3]` = AUDIT-1 item 3, `[A2-3]` = AUDIT-2 item 3, `[A3-5]` = AUDIT-3 item 5). See CLAUDE.md "Tiến độ task" + AUDIT-1/2/3 sections for detail.

---

## A. Connection Manager

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| New-connection type picker (10 systems) | Implemented | `SystemPicker.svelte`; dc:1580-1598 | |
| Connection form (host/port/db/user/pass, env) | Implemented | `ConnectionForm.svelte` | Group field removed [A2] |
| Password AES-256-GCM + OS keychain | Implemented | `storage/crypto.rs`; `connections.rs` | not plaintext |
| SSH tunnel (password / private key) | Implemented | `ConnectionForm.svelte`; `connections/tunnel.rs` | |
| SSL/TLS (CA / client cert+key) | Implemented | `postgres.rs`; `ConnectionForm.svelte` | Kafka SSL non-functional (librdkafka no-SSL) |
| Cassandra fields (DC, consistency) | Implemented | `ConnectionForm.svelte` | |
| SQLite mode (RW/RO/In-Memory) | Implemented | `ConnectionForm.svelte` | |
| MSSQL auth (SQL / Windows / Azure AD) | Implemented [T31] | `connections/aad.rs`; `mssql.rs`; `ConnectionForm.svelte` | SQL + Windows + **Azure AD Service Principal** (client-credentials token via reqwest → tiberius `aad_token`; user = clientId@tenant, secret never logged). Interactive/device-code + Password (ROPC) still follow-up |
| **Test connection button** | **Implemented** [T10] | `connections/registry.rs run_test_bounded`; `commands/connections.rs cancel_test` | bounded `connect_timeout()`=10s all systems + cancellable; button relabeled "Test connection" [A2] |
| **Cancel button (dialog)** | **Implemented** [T10] | `ConnectionForm.svelte` uuid testId + cancel-on-close; `cancel_test` | really aborts the in-flight backend Test |
| Save / edit-while-connected dialog | Implemented | `EditConnectedDialog.svelte`; `connections.rs` | Save button relabeled "Connect" [A2] |
| Delete connection (+ orphan-tab handling) | Implemented | `DeleteConnectionDialog.svelte` | |
| Duplicate / Quick connect / Import-Export JSON / groups | Implemented | `connections.rs`; `ConnectionList.svelte`; `grouping.ts` | |
| Connection row context menu | Implemented | `ConnectionList.svelte` | + Compare Schemas… [A2-1], Copy Connection String |
| Copy connection string | Implemented | `ConnectionList.svelte copyConnString` | password never embedded |
| Row hover / selected styling | Implemented [A1] | `ConnectionList.svelte .conn-row/.selected` | inline-bg trap removed |

---

## B. Object Explorer

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Tree per system | Implemented | `ObjectExplorer.svelte`; `explorer.svelte.ts` | |
| Expand table → columns (PK/FK) / indexes / constraints | Implemented [T7b] | `ObjectExplorer.svelte` | indexes/constraints shown as children |
| Expand View → columns | Implemented [T18] | `ObjectExplorer.svelte` | |
| Proc/Func/Trigger context menus | Implemented [T18,T28] | `ObjectExplorer.svelte`; `sql/routines.ts`; `ExecuteRoutineDialog.svelte` | Show Definition + Drop [T18]; **Execute** (param dialog → CALL/SELECT in SQL tab) + **Rename** (PG ALTER…RENAME / MSSQL sp_rename) [T28]. Trigger Enable/Disable still Missing |
| Table context menu (Open/New Query/Copy/DDL/Truncate/Drop) | Implemented | `ObjectExplorer.svelte` | + Generate Scripts 3-mode submenu [A3] |
| Table context extras: Edit Data, **Generate Test Data**, **Copy Table to…**, Compare/Migrate, Dump, Row Count & Stats | Partial | `CopyTableDialog.svelte`; `GenerateTestDataDialog.svelte` | **Copy to… ✅ [T25]**, **Generate Test Data ✅ [T26]**; Edit Data = table viewer; Dump = backup; Compare/Migrate via menu; **Row Count & Stats still Missing** |
| "Set as Filter" (column menu) | Implemented [T12] | `ObjectExplorer.svelte` → Table Viewer seeded filter | |
| Design Table (context) | Implemented | `openTableDesigner` | |
| Dictionaries node (ClickHouse §3) | Implemented | `clickhouse.rs dictionaries()`; `ch_dictionaries` | |
| **All databases in tree** (relational, per-database objects) | Implemented [A4-2] | `ObjectExplorer.svelte`; `attach_database`; `PgDriver/MssqlDriver::databases()` | PG/MSSQL: current DB = header (schemas nest under it) + other DBs as expandable nodes browsed via internal sub-connection `{connId}::{db}` (NO duplicate sidebar connection); MySQL/MariaDB = SCHEMATA. Removed the old flat "Databases" section + open-as-connection |
| ER drag source (draggable table rows) | Implemented [A3-1] | `ObjectExplorer.svelte draggable` | dataTransfer `application/x-ds-er-table` |
| Bottom toolbar: New table / Import data | Implemented | `openTableDesigner`; `importWizard.show` | |
| Bottom toolbar: Export / dump | Implemented [T15] | `ObjectExplorer.svelte` → Generate Scripts / dump | |
| Bottom toolbar: Backup database | Implemented [T22] | `BackupDialog.svelte`; `commands/backup.rs` | |
| Bottom toolbar: Users & privileges / Session Monitor | Implemented [T23] | `AdminView.svelte`; `commands/admin.rs` | |
| Expand all / Collapse all | Implemented | `ObjectExplorer.svelte` | |
| Explorer tree text search (Ctrl+F) | Implemented [T18] | `ObjectExplorer.svelte` filter + Ctrl+F | object **pinning** still Missing |
| Right-side Object Properties panel | Implemented | `PropertiesPanel.svelte` | shell + empty state; hidden on startup + edge-handle toggle [A3-4]; rich DDL/stats content still Partial |

---

## C. Query Editor

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Run (F5) / run-at-cursor / selection-aware | Implemented | `SqlWorkspace.svelte`; `SqlEditor.svelte` | |
| Cancel query (Ctrl+F5 / Esc) | Implemented [T11] | `results.svelte.ts`; `registry.rs` | integration: pg_sleep→cancel + connection recovers |
| Format SQL (Ctrl+Shift+F) | Implemented [T21] | `SqlWorkspace.svelte`; `sql/format.ts` | shortcut bound via `keys/shortcuts.ts` |
| Explain (Ctrl+Shift+E) → Query Plan tab | Implemented | `PlanVisualizer.svelte` | |
| Convert dialect button | Implemented [T12] | `SqlWorkspace.svelte` | format + note (not full cross-dialect translation) |
| Split editor toolbar button | Implemented [T12] | `SqlWorkspace.svelte moveToSplit` | |
| Ring button (Cassandra) | Implemented | `openCassandraRing` | |
| PG Extensions / MSSQL Agent/Query Store/AG | Implemented [T23,T23+] | `AdminView.svelte` | opened via Admin view tab, not editor toolbar |
| Autocomplete (table/column/keyword/function) | Implemented [T21] | `sql/functions.ts`; `SqlEditor.svelte` | function signatures merged |
| SQL lint tier-1 + schema-aware | Implemented | `lint/mod.rs`; `sql/lint-client.ts` | English messages [A2-7] |
| Query error surface (position/line, raw) | Implemented | `postgres.rs`; `ResultPanel.svelte` | English hints [A2-7] |
| SQLite PRAGMA panel + "Export .sql" | Implemented [T15] | `SqliteFileHeader.svelte`; `sqlite.rs` | |
| Transaction buttons (BEGIN/COMMIT/ROLLBACK) | Removed [A2-6] | `SqlWorkspace.svelte` | removed per user request |
| Syntax palette (light/dark contrast) | Implemented [A3-2] | `SqlEditor.svelte HighlightStyle`; `app.css --syntax-*` | theme-aware |
| Timestamp `NaiveDateTime + Duration` panic | Fixed [A2-5] | `postgres.rs decode_pg_timestamp/date` | ±infinity / out-of-range → sentinel string, no panic |

---

## D. Results Grid

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Multi-statement sub-tabs + Messages | Implemented | `ResultPanel.svelte`; `results.svelte.ts` | |
| View modes Grid / JSON / Single Row / Chart | Implemented | `ResultPanel.svelte` | |
| View-mode shortcuts Ctrl+Alt+G/J/R | Implemented [T21] | `keys/shortcuts.ts` | |
| Export result ▾ (CSV/JSON/SQL/Excel) + Custom wizard | Implemented [T14] | `ResultPanel.svelte`; `ExportDialog.svelte` | WHERE / limit / column subset |
| **Group By popover (aggregations)** | Implemented [T27] | `grid/groupby.ts`; `ResultGrid.svelte` | pager "Σ Group by" → 1+ columns + count/sum/avg/min/max → collapsible group tree with subtotals + grand total (client-side); `buildGroupSql` ready for server-side over truncated results |
| Copy cell/row/column/selection | Implemented [A2-2] | `ResultGrid.svelte` | Ctrl+Shift+C bound [T21] |
| **Copy as ▸ (TSV/CSV/JSON/SQL INSERT/SQL UPDATE/Markdown)** | Implemented [A3-5] | `export/clipboard.ts`; `ResultGrid.svelte` | multi-record; unit-tested (12) + e2e |
| Editable grid (edit/insert/delete) + Execute/Cancel/Reset | Implemented [A3-3] | `ResultGrid.svelte` | Execute=apply, Reset=revert, Cancel=abort running (registry cancel) |
| Preview-diff dialog | Implemented | `ResultGrid.svelte`; `grid.rs` | |
| Grid + ClickHouse → async mutation | Implemented | `grid.rs ch_mutation_sql`; `ch_generate_mutations` | Apply → "Generate mutation" |
| JSON cell modal | Implemented (Differs) | `ResultGrid.svelte` | prototype expands inline |
| Chart view + Builder + PNG/SVG export | Implemented [T12] | `ResultChart.svelte` | real PNG/SVG (serialize SVG + resolve CSS vars) |
| Pagination controls | Implemented | `TableViewerTab.svelte` (server-side); `ResultGrid.svelte` + `grid/paging.ts` (client-side query-result pager) | pager: row range + page-size + prev/next; indices stay absolute so edits/selection work |

---

## E. Table Designer / DDL

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Table Designer (columns grid + Scripts DDL + Save) | Implemented | `TableDesigner.svelte` | |
| Index manager tab / FK manager tab | Implemented [T29] | `IndexManager.svelte`; `sql/indexes.ts` | per-table tab: list indexes+FKs, create/drop index + add/drop FK via form with live DDL preview, missing-index (T17) suggestions, engine-aware; refreshes tree node |
| Column reorder / unique / auto-increment / IDENTITY | Partial | `TableDesigner.svelte` | PK/nullable/default/type only |
| DDL Viewer (single object) | Implemented (Differs) | `sql/ddl.ts` | client-generated CREATE |
| **Generate Scripts whole schema/DB** (structure/data/both, dependency order) | Implemented [T15] | `sql/scripts.ts`; `GenerateScriptsDialog.svelte` | topo order, FK ALTERs last; 3-mode on table ctx menu [A3-audit] |
| **Generate Test Data** | Implemented [T26] | `testdata/generate.ts`; `GenerateTestDataDialog.svelte` | seeded per-column generators (name/email/phone/date/number/enum/uuid/bool/text/fk); honors NOT NULL + UNIQUE + FK (values from parent pool); preview + batched INSERT |

---

## F. Import / Export / Backup

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Import wizard (CSV + JSON, Options, progress) | Implemented [T13] | `ImportDialog.svelte`; `import/plan.ts` | 5-step: format/encoding/header/Options(on-conflict+batch)/progress; per-dialect conflict SQL |
| Export query result (CSV/JSON/SQL/Excel) | Implemented [T14] | `ExportDialog.svelte`; `export/query.ts` | |
| Export table data wizard (format/WHERE/columns/filename) | Implemented [T14] | `ExportDialog.svelte` | paged streaming via LIMIT/OFFSET |
| Backup & Restore (tool status + history + restore confirm) | Implemented [T22] | `BackupDialog.svelte`; `commands/backup.rs` | SQLite in-process; else pg_dump/mysqldump/clickhouse-client |
| Dump with pg_dump / mysqldump | Implemented [T22] | `drivers/backup.rs external_backup_cmd` | password via env |
| **Streaming large export to file** | Implemented [T24] | `postgres.rs stream_export`; `commands/export.rs`; `ExportDialog.svelte` | PG cursor stream → BufWriter, one row at a time (bounded memory, 1M-row integration-tested), Channel progress + cancel; behind `streaming_io` setting, old in-memory path is the fallback. Generate Scripts still buffers (follow-up) |

---

## G. Advanced tools (Plan / Index / Compare / ER / CH / Cassandra)

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Query Plan Visualizer (normalized tree, hotspot, raw, est/actual) | Implemented | `drivers/plan.rs`; `PlanVisualizer.svelte` | |
| Plan — PG / MySQL / SQLite | Implemented | `plan.rs`; integration | |
| Plan — MariaDB actual (ANALYZE) | Implemented [T16] | `commands/plan.rs` | `ANALYZE FORMAT=JSON` → r_rows/r_total_time_ms |
| Plan — MSSQL (SHOWPLAN_XML) | Implemented [T16] | `plan.rs parse_mssql_xml`; `mssql.rs` SET via simple_query | RelOp tree |
| Plan — ClickHouse normalized | Implemented [T16] | `plan.rs parse_clickhouse` | `EXPLAIN indexes=1` tree |
| Plan — Cassandra TRACING timeline | Implemented [T16] | `commands/plan.rs explain_cassandra` | statement tracing → timeline |
| Index Scanner (per-system + health flags + export) | Implemented [T17] | `drivers/index_scan.rs`; `IndexScanner.svelte` | |
| Index — ClickHouse / Cassandra adapters | Implemented [T17] | `mod.rs scan_indexes` | data_skipping_indices / system_schema.indexes |
| Index — missing-index suggestions | Implemented [T17] | `suggest_missing_pg`; `MssqlDriver.missing_indexes` | standard flags, no `anti_pattern` field (by design) |
| Schema Compare (diff + migration SQL + filter + swap) | Implemented [T9] | `compare/diff.ts`; `SchemaCompare.svelte` | |
| Compare — procedures/functions/triggers | Implemented [T19] | `compare/diff.ts` | normalized DDL text |
| Compare — side-by-side DDL diff panel (prev/next, highlight) | Implemented [T19] | `SchemaCompare.svelte`; `lineDiff` | |
| ER Diagram (nodes/edges/dagre + PNG/SVG/Mermaid) | Implemented [T8] | `ErDiagram.svelte`; `er/mermaid.ts` | |
| ER — "+ Relationship" + "Save to DB" (ALTER ADD FK) | Implemented [T20] | `ErDiagram.svelte`; `genForeignKey` | integration pg_er_add_relationship |
| ER — cardinality markers + in-tab Ctrl+F + save layout | Implemented [T20, A4] | `ErDiagram.svelte` | N:1 label; positions persist in tab.state |
| ER — drag tables from Explorer + New (blank) diagram | Implemented [A3-1] | `er/diagram.ts`; `ErDiagram.svelte onDrop` | included-set model; viewport-mapped drop |
| ClickHouse engine badge / TTL / partition+mutation / SELECT FINAL | Implemented | `clickhouse.rs`; `ClickHouseTtlDialog.svelte`; `sql/chops.ts` | |
| ClickHouse MV / Dictionary **create** menus | Implemented [T30] | `sql/clickhouse_ddl.ts`; `ClickHouseCreateDialog.svelte` | schema ctx menu (CH only): Create Materialized View… (TO/ENGINE/POPULATE) + Create Dictionary… (columns/PK/SOURCE/LAYOUT/LIFETIME); guided form + validated live DDL preview; runs + refreshes tree |
| Cassandra Ring Topology | Implemented | `cassandra.rs`; `CassandraRing.svelte` | |
| Cassandra CQL editor + lint + paging | Implemented | `lint/mod.rs`; `cassandra.rs` | per-statement consistency toolbar still Missing |
| Cassandra DDL viewer (native CQL) | Partial | `cassandra.rs` | CREATE TABLE only |

---

## H. Streaming / KV (Redis / Kafka / NATS)

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Redis explorer / 6 value editors / TTL / delete / CLI / pub-sub / FLUSHDB | Implemented | `RedisWorkspace.svelte`; `drivers/redis.rs` | |
| Redis memory analysis | Implemented [T23+] | `parse_redis_info`; `AdminView.svelte` | INFO memory (53 metrics) |
| Redis CLI autocomplete; list pop/set-idx; stream range | Partial | `RedisWorkspace.svelte` | |
| NATS core pub/sub + request/reply + JetStream + KV + Object | Implemented | `drivers/nats.rs`; `NatsWorkspace.svelte` | |
| NATS JetStream management UI | Implemented | `NatsWorkspace.svelte` | create/edit/purge/delete stream, consumers |
| **NATS NKey / JWT auth** | **Missing (deferred)** | `drivers/nats.rs` | needs JWT operator/nsc outside container |
| Kafka cluster / topics / consumer / producer / groups / Schema Registry | Implemented | `drivers/kafka.rs`; `KafkaWorkspace.svelte` | |
| Kafka Avro decode (Schema Registry) | Implemented | `SchemaRegistryWorkspace.svelte` | |
| **Kafka ACL browser** | **Missing (deferred)** | grep: none | needs broker authorizer |
| Kafka producer/consumer headers; reset-offset preview; copy/export msg | Partial | `KafkaConsumer.svelte`,`KafkaProducer.svelte` | |

---

## I. Global / Views

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Command Palette (Ctrl+P) | Implemented | `CommandPalette.svelte` | |
| Settings / Preferences (Ctrl+,) incl. pooling/retry | Implemented [T21] | `Settings.svelte`; `connections/pool.rs` | |
| Error boundary / Welcome / theme toggle | Implemented | `App.svelte`; `ui.svelte.ts` | |
| Query History view + search | Implemented | `HistoryTab.svelte` | |
| Saved Queries / snippets | Implemented | `SavedQueriesTab.svelte` | |
| Tabs (rename/pin/close-others/drag/restore/split) | Implemented | `TabBar.svelte`; `tabs.svelte.ts` | |
| Session Monitor (sessions/locks + Kill) | Implemented [T23] | `AdminView.svelte`; `commands/admin.rs` | pg_stat_activity/pg_locks + kill_session |
| PG Extension Manager / MSSQL Agent Jobs / Query Store / AG | Implemented [T23,T23+] | `AdminView.svelte` | system-aware view list |
| SQL Dialect Converter | Partial [T12] | `SqlWorkspace.svelte` | format + note, not full cross-dialect translation (dc:1630-1678) |
| Keyboard: Ctrl+P/S/H/,/T/W/Tab/1-9, F5, Ctrl+Enter, Esc, Ctrl+Shift+E | Implemented | `App.svelte`; `SqlEditor.svelte` | |
| Keyboard: Ctrl+Shift+F, Ctrl+Alt+G/J/R, Ctrl+Shift+C, Ctrl+F | Implemented [T21] | `keys/shortcuts.ts`; `App.svelte` | |
| i18n — all user-facing text English | Implemented [A2-7,A3] | frontend + Rust backend | comments/tests left as-is |

---

## Tally (post T10–T23 + AUDIT-1/2/3)

| Status | Count (approx.) |
|---|---|
| Implemented | ~104 |
| Partial | ~4 |
| Missing | ~4 |
| Broken (stub/no-op) | 0 |
| Deferred | 2 (Kafka ACL; NATS NKey-JWT — need external broker/JWT setup) |

**Remaining after the T24–T31 batch (all follow-up, lower-impact):**
1. **Streaming I/O**: export done [T24, PG]; streaming for MySQL/MSSQL/SQLite/CH + Generate Scripts still buffer RAM.
2. ~~Generate Test Data~~ — done [T26]. (Follow-up: multi-table topological insert.)
3. ~~Copy Table to…~~ — done [T25].
4. ~~Result Grid Group By popover~~ — done [T27].
5. ~~Proc/Func Execute + Rename~~ — done [T28].
6. MSSQL Azure AD — **Service Principal done [T31]**; Interactive/device-code + Password (ROPC) remain follow-up.
7. ~~Index/FK manager dedicated tabs~~ — done [T29].
8. ~~ClickHouse MV / Dictionary create menus~~ — done [T30].
9. Small: Row Count & Stats, Trigger Enable/Disable, MSSQL CREATE-DDL via simple_query.
10. Deferred: Kafka ACL, NATS NKey/JWT (config surface only — need external setup).
9. **Kafka ACL** + **NATS NKey/JWT** — deferred (need broker authorizer / JWT operator outside the default containers).
