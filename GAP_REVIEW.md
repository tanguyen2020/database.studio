# GAP_REVIEW — Database Studio (design ↔ code)

Audit-only. Design sources read in full: `Database Studio.dc.html` (6053 lines, exhaustive element inventory), `CLICKHOUSE_SPEC_ADDENDUM.md`, `phase-1..6`. Code base: `src/` (Svelte) + `src-tauri/` (Rust).

Status legend: **Implemented** (wired end-to-end, evidence) · **Partial** (present but missing part) · **Missing** (no code) · **Broken** (UI present, handler is a no-op/stub or backend link dead) · **Wired-but-unverified** (code path exists but runtime correctness unconfirmed / known runtime doubt).

> Evidence `file:line` uses `dc:N` for `Database Studio.dc.html`. Code paths are repo-relative.

---

## A. Connection Manager

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| New-connection type picker (10 systems) | Implemented | `SystemPicker.svelte`; dc:1580-1598 | |
| Connection form (host/port/db/user/pass, env, group) | Implemented | `ConnectionForm.svelte:244-396` | |
| Password AES-256-GCM + OS keychain | Implemented | `storage/crypto.rs`; `connections.rs:75-85` | not plaintext |
| SSH tunnel (password / private key) | Implemented | `ConnectionForm.svelte:408-541`; `connections/tunnel.rs:47-128` | |
| SSL/TLS (CA / client cert+key) | Implemented | `postgres.rs:37-53`; `ConnectionForm.svelte:517-541` | Kafka SSL non-functional (librdkafka no-SSL) |
| Cassandra fields (DC, consistency) | Implemented | `ConnectionForm.svelte:340-357` | |
| SQLite mode (RW/RO/In-Memory) | Implemented | `ConnectionForm.svelte:264-306` | |
| MSSQL auth (SQL / Windows) | Partial | `ConnectionForm.svelte:333-341` | dc:2208-2211 also lists Azure AD / Azure AD MFA → Missing |
| **Test connection button** | **Wired-but-unverified** | `ConnectionForm.svelte:141,553`; `connections.svelte.ts:171`; `commands/connections.rs:159-188` | see §H-1: no connect timeout on PG/MySQL/MSSQL → can hang with no error; only CH bounded (`clickhouse.rs:124`) |
| **Cancel button (dialog)** | **Wired-but-unverified** | `ConnectionForm.svelte:80-83,567` | closes UI only; does NOT abort in-flight backend Test (Tauri invoke uncancellable, no AbortHandle) — backend keeps connecting |
| Save / edit-while-connected dialog | Implemented | `ConnectionForm.svelte:163-195`; `EditConnectedDialog.svelte`; `connections.rs:126-133` | |
| Delete connection (+ orphan-tab handling) | Implemented | `DeleteConnectionDialog.svelte`; `connections.rs` | dc:2068-2086 |
| Duplicate connection | Implemented | `connections.rs:97-107` | |
| Import/Export connection profiles (JSON) | Implemented | `ConnectionList.svelte:146-175` | |
| Quick connect (one-off) | Implemented | `connections.rs:139-156` | |
| Connection groups (folder) | Implemented | `ConnectionList.svelte:142,327-341`; `grouping.ts` | |
| Connection row context menu | Partial | `ConnectionList.svelte` | dc:5893-5917 has Backup/Compare/Copy-conn-string/ER — several Missing (see areas below) |
| Copy connection string | Missing | grep: none | dc:5912 |

---

## B. Object Explorer

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Tree per system (relational/CH/Cassandra/SQLite/Redis/Kafka/NATS) | Implemented | `ObjectExplorer.svelte`; `explorer.svelte.ts` | |
| Expand table → columns (PK/FK meta) / indexes / constraints | Partial | `ObjectExplorer.svelte:511-579` | index columns & constraint definition fetched but not shown as children |
| Expand View → columns | Missing | `ObjectExplorer.svelte:598-617` | view is leaf |
| Proc/Func/Trigger context menus (Execute/Rename/Drop/Enable) | Missing | `ObjectExplorer.svelte:620-737` | dc:3416-3440 |
| Table context menu (Open/New Query/Copy/DDL/Truncate/Drop) | Implemented | `ObjectExplorer.svelte:419-465` | |
| Table context menu extras: Edit Data, Generate Test Data, Copy Table to…, Compare/Migrate…, Dump w/ pg_dump, Row Count & Stats | Missing | grep: none | dc:3362-3405 |
| "Set as Filter" (column menu) | **Broken** | `ObjectExplorer.svelte:528` → `later('Set as Filter')` | stub toast |
| Design Table (context) | Implemented | `ObjectExplorer.svelte` → `openTableDesigner` | |
| **Dictionaries node (ClickHouse §3)** | **Implemented** | `ObjectExplorer.svelte` dicts folder; `clickhouse.rs dictionaries()`; `ch_dictionaries` cmd | closed in commit `1324801`; menu Show Definition/Query/Reload/Copy/Drop via `chops` |
| Bottom toolbar: New table | Implemented | `ObjectExplorer.svelte` → `openTableDesigner` | |
| Bottom toolbar: Import data | Implemented | `ObjectExplorer.svelte` → `importWizard.show` | |
| Bottom toolbar: **Export / dump** | **Broken** | `ObjectExplorer.svelte:819` → `later('Export / dump')` | stub; dc:159 |
| Bottom toolbar: **Backup database** | **Broken** | `ObjectExplorer.svelte:822` → `later('Backup database')` | stub; dc:160 |
| Bottom toolbar: **Users & privileges** | **Broken** | `ObjectExplorer.svelte:825` → `later('Users & privileges')` | stub; dc:161 |
| Expand all / Collapse all | Implemented | `ObjectExplorer.svelte:634-636` | |
| Explorer tree text search (Ctrl+F) + object pinning | Missing | grep: none | dc:4693 filter exists in prototype |
| Right-side Object Properties panel (DDL/stats/indexes/sample) | Missing | grep: none | dc:1512-1524,4828-4868 |

---

## C. Query Editor

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Run (F5) / run-at-cursor (Ctrl+Enter), selection-aware | Implemented | `SqlWorkspace.svelte:102-134`; `SqlEditor.svelte:149-161` | |
| Cancel query (Ctrl+F5 / Esc) | Wired-but-unverified | `SqlEditor.svelte:163-196`; `results.svelte.ts:217`; `registry.rs:154-208` | abort=poison+reconnect; latency/real-abort unconfirmed (see §H-2) |
| Format SQL (Ctrl+Shift+F) | Implemented | `SqlWorkspace.svelte:162-167`; `sql/format.ts` | shortcut Ctrl+Shift+F not bound in editor keymap (button only) |
| Explain (Ctrl+Shift+E) → Query Plan tab | Implemented | `SqlWorkspace.svelte:170-176`; `PlanVisualizer.svelte` | exceeds prototype static plan; per-system gaps in §G |
| **Convert dialect** button | **Broken** | `SqlWorkspace.svelte:340` → `toasts.show('Convert dialect — Phase 2')` | dc:1630-1678 full converter in prototype |
| **Split editor** toolbar button | **Broken** | `SqlWorkspace.svelte:343` → toast stub | BUT split view works via tab context menu (`tabs.splitDir`) |
| Ring button (Cassandra) | Implemented | `SqlWorkspace.svelte:335-337` → `openCassandraRing` | |
| Postgres Extensions / MSSQL Agent Jobs / Query Store / AG buttons | Missing | grep: none | dc:275-282,961-1078 |
| Autocomplete (table/column/keyword) | Partial | `SqlWorkspace.svelte:61-74`; `SqlEditor.svelte:71-89` | no function signatures |
| SQL lint tier-1 + schema-aware | Implemented | `lint/mod.rs`; `sql/lint-client.ts` | |
| Query error surface (position/line, view raw) | Implemented | `postgres.rs:666-697`; `ResultPanel.svelte:57-69` | |
| SQLite PRAGMA panel | Implemented | `SqliteFileHeader.svelte`; `sqlite.rs:581-692` | |
| SQLite "Export .sql" button | **Broken** | `SqliteFileHeader.svelte:114` → toast stub | |

---

## D. Results Grid

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Multi-statement sub-tabs + Messages | Implemented | `ResultPanel.svelte:83-98`; `results.svelte.ts:90-208` | |
| View modes Grid / JSON / Single Row / Chart | Implemented | `ResultPanel.svelte:118-133` | |
| View-mode shortcuts Ctrl+Alt+G/J/R | Missing | grep: none | dc / phase-6 |
| Export result ▾ (CSV/JSON/SQL/Excel) | Implemented | `ResultPanel.svelte:35-45`; `export/rows.ts` | |
| **Group By** popover (aggregations) | Missing | grep: none | dc:352-385 |
| Copy cell/row/selection | Implemented | `ResultGrid.svelte:296-319` | Ctrl+Shift+C not bound |
| Editable grid (edit/insert/delete + Preview + Apply) | Implemented | `ResultGrid.svelte:174-187,354-388` | PG/SQLite integration-tested |
| Preview-diff dialog | Implemented | `ResultGrid.svelte:514-548`; `grid.rs:150-195` | |
| **Grid + ClickHouse → async mutation** | **Implemented** | `grid.rs ch_mutation_sql`; `commands/grid.rs ch_generate_mutations`; `ResultGrid.svelte` CH branch | closed in `1324801`; CH Apply→"Generate mutation" (ALTER TABLE UPDATE/DELETE) |
| JSON cell modal | Implemented (Differs) | `ResultGrid.svelte:450-459` | prototype expands inline (dc:453) |
| Chart view + Chart Builder | Partial | `ResultChart.svelte` | **PNG/SVG export = Broken stub** (`ResultChart.svelte:151-152`) |
| Pagination controls (result grid) | Partial | `TableViewerTab.svelte:246-259` | table viewer paginates; standalone query-result pagination not surfaced (dc:571-586) |

---

## E. Table Designer / DDL

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Table Designer (columns grid + Scripts DDL + Save) | Implemented | `TableDesigner.svelte` | |
| Index manager tab / FK manager tab | Missing | `TableDesigner.svelte:29` | dc has Table/Scripts only too, but phase-5 spec requires managers |
| Column reorder / unique / auto-increment / IDENTITY | Partial | `TableDesigner.svelte:66-71` | PK/nullable only |
| DDL Viewer (single object, client-generated CREATE) | Implemented (Differs) | `ObjectExplorer.svelte:129-140`; `sql/ddl.ts` | omits indexes/constraints; not server DDL |
| **Generate Scripts for whole schema/DB** (structure-only / data-only / both; multi-object; dependency order) | **Missing** | grep: none | dc:2138-2164 (Generate Scripts view), dc:3312-3328 |
| Generate Test Data | Missing | grep: none | dc:1808-1844 |

---

## F. Import / Export / Backup

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| **Import CSV wizard** | **Partial** | `ImportDialog.svelte`; `import.svelte.ts`; `parseCsv` (`export/rows.ts`) | 3 steps (File+preview / Mapping / Execute). Missing dc 5-step: dedicated **Options step** (on-conflict INSERT/IGNORE/REPLACE/UPDATE, batch size, encoding, skip-header) + **progress bar** (dc:1975-2039); JSON import not supported |
| **Export query result** (CSV/JSON/SQL/Excel) | **Implemented** | `ResultPanel.svelte`; `export/rows.ts` | dc Export Wizard richer (WHERE, row limit, column checkboxes) → those Missing |
| **Export table data wizard** (format/WHERE/columns/filename) | **Missing** | grep: none | dc:1763-1806 |
| Backup & Restore (view + create-backup modal + history + restore confirm) | Missing | grep: none (only `later` stub) | dc:1113-1162,1680-1761 |
| Dump with pg_dump / mysqldump | Missing | grep: none | dc:3400 |

---

## G. Advanced tools (Plan / Index / Compare / ER / CH / Cassandra)

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Query Plan Visualizer (normalized tree, hotspot, raw, est/actual) | Implemented | `drivers/plan.rs`; `PlanVisualizer.svelte` | |
| Plan — PG / MySQL / SQLite parsers | Implemented | `plan.rs:124-241`; integration PG `drivers_integration.rs:133` | |
| Plan — MariaDB actual (ANALYZE) | Partial | `plan.rs:164` | estimated only |
| Plan — MSSQL (SHOWPLAN_XML) | **Broken** | `commands/plan.rs:60,106` | sends invalid `EXPLAIN` on MSSQL → no tree |
| Plan — ClickHouse normalized | Partial | `commands/plan.rs:59,97-105` | raw-text fallback only |
| Plan — Cassandra TRACING timeline | Missing | `commands/plan.rs:27` | returned as `not_applicable` (wrong) |
| Index Scanner (per-system + health flags + export) | Implemented | `drivers/index_scan.rs`; `IndexScanner.svelte` | exceeds prototype (no dedicated tool there) |
| Index — ClickHouse / Cassandra adapters | Missing | `drivers/mod.rs:513-520` | |
| Index — anti_pattern flag + missing-index suggestions | Missing | `index_scan.rs:24-36` | |
| Schema Compare (diff + migration SQL + filter + swap) | Implemented | `compare/diff.ts`; `SchemaCompare.svelte` | |
| Compare — procedures/functions/triggers | Missing | `SchemaCompare.svelte:36-50` | tables+columns only |
| Compare — side-by-side DDL diff panel (prev/next, highlight) | Missing | `SchemaCompare.svelte:160-173` | dc:1438-1476 |
| ER Diagram (nodes/edges/dagre + PNG/SVG/Mermaid) | Implemented | `ErDiagram.svelte`; `er/mermaid.ts` | |
| ER — "+ Relationship" (create FK) + "Save to DB" (ALTER ADD FK) | Missing | grep: none | dc:1266,1270,2617 |
| ER — cardinality 1/N endpoint markers + in-tab Ctrl+F search | Partial/Missing | `ErDiagram.svelte:78-87` | |
| ClickHouse engine badge / TTL viewer / partition+mutation ops / SELECT FINAL | Implemented | `clickhouse.rs`; `ClickHouseTtlDialog.svelte`; `sql/chops.ts` | |
| ClickHouse MV / Dictionary **create** menus | Missing | `ObjectExplorer.svelte:390` | dc:3467-3470 |
| Cassandra Ring Topology (real system tables) | Implemented | `drivers/cassandra.rs:675-714`; `CassandraRing.svelte` | RF/coordinator not shown |
| Cassandra CQL editor + lint + paging | Implemented | `lint/mod.rs:315-404`; `drivers/cassandra.rs:254-336` | per-statement consistency toolbar Missing; uses unprepared stmt |
| Cassandra DDL viewer (native CQL) | Partial | `drivers/cassandra.rs:718-771` | CREATE TABLE only (no keyspace/UDT/UDF/MV/index) |

---

## H. Streaming / KV (Redis / Kafka / NATS)

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Redis explorer / 6 value editors / TTL / delete / CLI / pub-sub / FLUSHDB | Implemented | `RedisWorkspace.svelte`; `RedisPubSub.svelte`; `drivers/redis.rs` | integration: connect/scan/get/edit/command/del |
| Redis memory analysis; CLI autocomplete; String JSON auto-format; list pop/set-idx; stream range | Missing/Partial | `RedisWorkspace.svelte` | |
| NATS core pub/sub + request/reply + JetStream + KV + Object | Implemented | `drivers/nats.rs`; `NatsWorkspace.svelte` | |
| NATS JetStream **management UI** (create/edit/purge/delete stream, create/delete consumer, delete msg) | Partial | `drivers/nats.rs:305-361`; `ipc.ts:218` | backend+IPC present, **UI unwired** |
| NATS NKey / JWT auth; request timeout config; headers/reply display | Missing/Partial | `drivers/nats.rs:13-34`; `NatsWorkspace.svelte:105` | timeout hardcoded 3000ms |
| Kafka cluster / topics / consumer / producer / groups / Schema Registry | Implemented | `drivers/kafka.rs`; `KafkaWorkspace.svelte` etc. | |
| Kafka **ACL** browser | Missing | grep: none | |
| Kafka **Avro decode** in consumer | Missing | `KafkaConsumer.svelte` | |
| Kafka producer headers; consumer virtualization/headers; reset-offset preview; timestamp start; copy/export msg | Missing/Partial | `KafkaConsumer.svelte`,`KafkaProducer.svelte` | |

---

## I. Global / Views present only in prototype

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Command Palette (Ctrl+P) | Implemented | `CommandPalette.svelte` | |
| Settings / Preferences (Ctrl+,) | Implemented | `Settings.svelte`; `settings.svelte.ts` | exceeds prototype (which has no Settings dialog) |
| Error boundary (per-tab crash isolation) | Implemented | `App.svelte:162,198-207` | |
| Welcome / onboarding | Implemented | `App.svelte:211-220` | |
| Theme dark/light toggle | Implemented | `ui.svelte.ts:42-46` | |
| Query History view + search | Implemented | `HistoryTab.svelte`; `commands/query.rs:39-53` | click opens new tab (dc pastes into editor) |
| Saved Queries / snippets | Implemented | `SavedQueriesTab.svelte`; `snippets.svelte.ts` | |
| Tabs (rename/pin/close-others/drag/restore/split) | Implemented | `TabBar.svelte`; `tabs.svelte.ts` | |
| **Session Monitor** (sessions/locks + Kill) | Missing | grep: none (only `TitleBar.svelte:29` stub) | dc:1188-1255 |
| **Postgres Extension Manager** | Missing | grep: none | dc:1080-1111 |
| **MSSQL Agent Jobs** | Missing | grep: none | dc:1045-1078 |
| **MSSQL Query Store** | Missing | grep: none | dc:961-999 |
| **MSSQL Availability Groups** | Missing | grep: none | dc:1001-1043 |
| **SQL Dialect Converter** | Missing | grep: none (SqlWorkspace stub) | dc:1630-1678 |
| Keyboard: Ctrl+P/S/H/,/T/W/Shift+T/Tab/1-9, F5, Ctrl+Enter, Esc, Ctrl+Shift+E | Implemented | `App.svelte:62-92`; `SqlEditor.svelte:149-196` | |
| Keyboard: Ctrl+Shift+F, Ctrl+Alt+G/J/R, Ctrl+Shift+C, Ctrl+F | Missing | grep: none | |

---

## H-detail. Test / Cancel deep-dive (known gap #1)

1. **Test button** — path exists (`ConnectionForm.runTest → connections.test → ipc test_connection → commands/connections.rs`). Errors ARE rendered (`ConnectionForm.svelte:548-549`) **when the call returns**. BUT: only ClickHouse sets a connect timeout (`clickhouse.rs:124`, 10s); **PG/MySQL/MSSQL have none** → unreachable host hangs on OS TCP timeout → button stuck "Testing…" with no error surfaced. ⇒ **Wired-but-unverified**, effectively Broken for slow/dead PG hosts.
2. **Cancel button** — `close()` only nulls `ui.formProfile` (`ConnectionForm.svelte:80-83`). The awaited Tauri `invoke` is **not cancellable**; backend `test_connection` future keeps running (connect/SSH). ⇒ closes UI while backend hangs; **does not abort**.
3. **PG vs ClickHouse** — divergent: CH bounded ~10s + error; PG/MySQL/MSSQL unbounded. Same divergence applies to the connect path generally.

---

## Tally

| Status | Count (approx.) |
|---|---|
| Implemented | ~52 |
| Partial | ~16 |
| Missing | ~30 |
| Broken (stub/no-op) | ~9 (Set-as-Filter, Export/dump, Backup DB, Users&privileges, Convert dialect, Split-toolbar-btn, ResultChart PNG/SVG, SQLite Export .sql, MSSQL-plan) |
| Wired-but-unverified | 2 (connection Test, connection Cancel) + query-cancel |

**Highest-impact gaps:** connection Test/Cancel runtime semantics (no timeout / no abort); no Backup&Restore; no whole-schema Generate Scripts; Import wizard missing Options+progress; several Explorer bottom-toolbar & context items are dead stubs; MSSQL/Cassandra Query-Plan adapters broken/missing; no Session Monitor / Extension Manager / Agent Jobs / Query Store / AG; no SQL dialect converter; missing keyboard shortcuts.
