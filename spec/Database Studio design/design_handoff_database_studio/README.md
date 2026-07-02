# Handoff: Database Studio

> Updated handoff spec reflecting the **current** state of the `Database Studio.dc.html` prototype.
> This supersedes the earlier `uploads/overview.md` product spec — that doc remains a good
> high-level product vision, but the sections below describe what the prototype actually
> implements today (including ClickHouse, the Compare / DDL-Diff tool, Generate Scripts,
> the selection-gated toolbar, save-before-close, and the enriched context menus).

---

## Overview

**Database Studio** is a personal desktop client for relational databases, an analytics
columnar store (ClickHouse), a key-value store (Redis), and message brokers (Kafka, NATS).
It is a single-window IDE-style app: a left **connection list + object explorer**, a central
**tabbed workspace** (SQL editor + result grid, or broker browsers, or an ER diagram), and a
set of modal tools (Connection Manager, Generate Scripts, Compare/Migrate, command palette).

The design goal: lightweight, fast, fully keyboard-navigable, with a **color-coded identity
per database system** so the user always knows which engine/connection a tab belongs to.

---

## About the Design Files

The files in this bundle are **design references created in HTML/CSS/JS** — a high-fidelity
prototype that demonstrates the intended look, layout, and interaction behavior. They are
**not production code to copy directly.**

The implementation task is to **recreate this design in the target codebase's environment.**
The original product spec proposes **Tauri 2 + Svelte 5 + TypeScript** (see `uploads/overview.md`,
section 3). If you start fresh, that stack is recommended; if a codebase already exists, use its
established framework, component library, and patterns instead. Either way, treat the HTML as the
visual + behavioral source of truth, not as code to lift.

The prototype itself is authored as a single "Design Component" HTML file that uses React
(via an internal runtime) for convenience — **do not** carry that runtime into production.

---

## Fidelity

**High-fidelity (hifi).** Colors, typography, spacing, layout, states, and interaction flows
are all final and intentional. Recreate the UI to match. Exact tokens are in the
**Design Tokens** section; per-system colors in **Color Identity System**.

---

## Layout — Top Level

A single full-viewport shell, class `.ds`, dark by default with a light theme variant.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ TITLE BAR:  ◴ Database Studio                              [☾ theme toggle] │
├──────────────┬────────────────────────────────────────────────────────────┤
│ SIDEBAR      │ TAB BAR: [PG] orders · SELECT ●  | [MY] users · query  | +  │
│ (resizable)  ├────────────────────────────────────────────────────────────┤
│              │ EDITOR TOOLBAR: [conn ▾] ▶ Run  Format  Explain   Grid/JSON/…│
│ Connections  ├────────────────────────────────────────────────────────────┤
│  ▐ Postgres  │ SQL EDITOR (Monaco)                       (resizable height) │
│  ▐ MySQL     ├────────────────────────────────────────────────────────────┤
│  ▐ MSSQL     │ RESULT PANEL                                                 │
│  ▐ Redis     │  [#1 orders · 3,842] [#2 users · 120] [#3 ✓1] [Messages]    │
│  ▐ Kafka     │  ┌──────────────────────────────────────────────────────┐  │
│  ▐ NATS      │  │ grid / json / single-row                             │  │
│  ▐ ClickHouse│  └──────────────────────────────────────────────────────┘  │
│ ─────────────│  pagination (only when > 50 rows)                           │
│ OBJECT       │                                                             │
│ EXPLORER     │                                                             │
│ (tree of the │                                                             │
│  selected    │                                                             │
│  connection) │                                                             │
├──────────────┴────────────────────────────────────────────────────────────┤
│ STATUS BAR:  ● Postgres [PG]  public.orders   |  42 ms  |  3,842 rows       │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Sidebar** is two stacked panels: the **connection list** (top, height-resizable via a
  drag handle) and the **object explorer** (bottom). The whole sidebar is width-resizable
  via a vertical drag handle on its right edge.
- **Editor / result split** is height-resizable via a horizontal drag handle.
- All three resize handles persist their size in component state.

---

## Color Identity System

Every database/broker type has a **consistent color set** used everywhere it appears: the
3px accent bar on each connection row, the 2-letter badge, tab underline, status-bar dot,
explorer header, and toast border. **Never** fall back to a generic gray for a known system.

| System | `accent` | `bg` (dark badge fill) | `border` | `fg` (text on bg) | badge |
|---|---|---|---|---|---|
| PostgreSQL | `#336791` | `#1a3a52` | `#2a5a7a` | `#7ec8f0` | `PG` |
| MySQL | `#F29111` | `#3d2800` | `#6b4400` | `#f5b84a` | `MY` |
| SQL Server | `#CC2927` | `#3d0a09` | `#6b1515` | `#f08080` | `MS` |
| Redis | `#D82C20` | `#3d0c08` | `#6b1a14` | `#f07070` | `RE` |
| Kafka | `#8B5CF6` | `#1e1a2e` | `#3d2f6b` | `#c4b5fd` | `KF` |
| NATS | `#27AE60` | `#0d2e1a` | `#1a5c35` | `#6ee7a0` | `NT` |
| **ClickHouse** | `#FFCC00` | `#33290a` | `#665514` | `#ffe066` | `CH` |
| Orphaned | `#5b6473` | `#2a2f3a` | `#3a4150` | `#9aa4b8` | `⚠` |

**Icons.** PostgreSQL / MySQL / SQL Server use raster logo PNGs (`assets/db-*.png`).
Redis, Kafka, NATS, ClickHouse use inline SVG marks (original, not brand logos):
- Redis — stacked layers / cube (3 stroked rhombi).
- Kafka — 3 nodes + connectors.
- NATS — concentric radiating circles.
- ClickHouse — 4 vertical columnar bars (3 tall + 1 short), filled in `#FFCC00`.

> Use the real brand design system / official logos in production where licensing allows.
> The SVG marks here are placeholders so the prototype ships without bundling logos.

---

## System Categories (drives tree + features)

| Category | Systems | Workspace |
|---|---|---|
| **Relational** | PostgreSQL, MySQL, SQL Server | SQL editor + result grid, ER diagram, designer |
| **Columnar (OLAP)** | **ClickHouse** | SQL editor + result grid (ClickHouse dialect) |
| **Key-Value** | Redis | Key browser |
| **Broker** | Kafka, NATS | Topic / subject browser |

Relational + ClickHouse are treated as "SQL connections" (`selRel === true`): they get the
New Query, ER, DDL/Generate-Scripts, and Compare toolbar actions. Redis/Kafka/NATS do not.

---

## Screens / Views

### 1. Connection List (sidebar, top)

- Connections are grouped by **system type**, in this order: Postgres, MySQL, MSSQL,
  ClickHouse, Redis, Kafka, NATS. Each group header is collapsible.
- Each connection row: a 3px left **accent bar** (system color), the **system icon**, the
  **name**, and a connected **status dot** (accent when connected, gray when not).
- **Selecting** a connection (single click) sets it as the "selected connection":
  it highlights (`--hover` background) and **enables the toolbar actions** (see below).
  The object explorer below switches to that connection's tree.
- A connection **filter/search** box filters the list by name.
- **Right-click** a connection → context menu: New Query Console, Open / Disconnect,
  Edit Connection…, Duplicate, Test Connection, Copy Connection String, Refresh, and
  Delete Connection (danger).

### 2. Object Explorer (sidebar, bottom)

Tree of the selected connection. Node types each have a distinct glyph + color:

| Node | Glyph | Color role |
|---|---|---|
| Schema/Database | `▤` | schema |
| Folder (Tables/Views/…) | `▤` | folder |
| Table | `▦` | table (blue) |
| View | `◫` | view (purple) |
| Stored Procedure | `⚙` | orange |
| Function | `ƒ` | yellow |
| Trigger | `⚡` | red |
| Sequence | `#` | slate |
| Index | `⌗` | gray |
| Dictionary (ClickHouse) | `⊞` | index/gray |
| Column | `▸` | muted |

Per-system tree shapes:
- **PostgreSQL/MySQL/MSSQL** (`relTree`): `public` schema → Tables (with expandable
  columns showing type + PK/FK/NN), Views, Procedures, Functions (with `→ returnType`),
  Triggers (with event + table), and Sequences (Postgres only).
- **ClickHouse** (`clickhouseTree`): `default` + `system` databases → Tables with **engine**
  meta (`MergeTree`, `ReplacingMergeTree`, `SummingMergeTree`), Views (incl. Materialized),
  **Dictionaries** (`flat` / `hashed`), Functions.
- **Redis** (`redisTree`): keys grouped by `:` prefix, type icons (String/Hash/List/Set/
  ZSet/Stream), TTL.
- **Kafka** (`kafkaTree`): topics + consumer groups.
- **NATS** (`natsTree`): subjects, JetStream streams, KV buckets.

Interactions: click selects + expands; **double-click** a table → Open Data; double-click a
view → View Definition. Right-click → context menu (see **Context Menus** below).

### 3. Tab Bar + Workspace

- Tabs carry full context: `{id, connId, type, title, dirty, query, sub}`. `type` ∈
  `sql | redis | kafka | nats | er`.
- Each tab shows the **system badge** (colored), the **title**, a **dirty dot** `●` when
  unsaved, and a **× close** button. Active tab has a 2px **accent underline** (system
  color); inactive tabs are dimmed (opacity ~0.6) but keep their color.
- `+` button opens a new SQL editor tab for the selected connection.
- **Right-click a tab** → Close, Close Others, Close to the Right, Close All, Close Saved
  (disabled when N/A).
- **Closing a dirty tab** (× or any Close action) opens the **Save-before-close dialog**
  listing affected tabs with **Cancel / Don't Save / Save**. Clean tabs close immediately.

### 4. SQL Editor (Monaco)

- Monaco editor, `language: sql`, custom themes `vs-studio-dark` / `vs-studio-light`
  (loaded lazily from CDN; falls back to a plain textarea if Monaco fails).
- **Toolbar:** connection dropdown (change the tab's connection), **▶ Run**, **Format**
  (align-lines icon), **Explain** (bar-chart icon), and the result **view-mode toggle**
  (Grid / JSON / Single Row).
- **Run behavior** (`F5` / ▶):
  - With a **text selection** → runs only the selected statement(s).
  - With **no selection** → runs **all** statements in the tab.
  - Statements split on `;` (comments stripped). On completion the result grid is shown,
    the Messages log is rebuilt per-statement, and a status flash reports what ran.

### 5. Result Panel

- **Multi-statement sub-tabs:** one sub-tab per statement, labeled `#N <table> · X rows`
  for selects, `#N ✓ X affected` for DML, `#N ✓ OK` for DDL, `#N ✗ error` for errors.
  Plus a trailing **Messages** sub-tab logging per-statement timing/rows/errors.
- **Three view modes:** Grid (default), JSON (whole result set, colorized), Single Row
  (vertical key/value form).
- **Grid:** zebra rows, a row-number gutter, `NULL` shown as a gray badge, double-click a
  cell to edit (pending-edit buffer with Apply/Discard, Execute generates dialect SQL).
- **Pagination:** the "Rows / page" pager appears **only when the result has more than 50
  rows**; smaller results show no pager.
- **Right-click a row/cell** → grid context menu (copy cell/row/selection, set filter,
  generate WHERE, delete row, etc.).

### 6. Connection Manager (modal)

- Opened from the toolbar **Edit** action or a connection's right-click → Edit Connection…,
  or from the **+ / New Connection** picker.
- **New-connection picker** first: a grid of system cards (Postgres, MySQL, MSSQL,
  **ClickHouse**, Redis, Kafka, NATS), each with its colored icon.
- **Edit form is type-aware** — it shows only the fields relevant to the connection's system,
  and the **left "Connections" list panel was removed** (the form fills the dialog):
  - Relational + ClickHouse: Host, Port, Database, User (+ SSH tunnel, SSL toggles).
  - Redis: Host, Port, Database index, Username (ACL).
  - Kafka: Bootstrap servers, SASL username (no Port/Database).
  - NATS: Servers, Token/Username (no Port/Database).
- **Delete a connection in use** → confirm dialog with **Cancel / Close tabs & Delete /
  Force Delete** (Force Delete leaves tabs "orphaned" — gray `⚠` badge, content kept,
  cannot run).

### 7. Generate Scripts (modal)

- Opened from a table's right-click → Generate Scripts…, the Tables folder, or the schema.
- **Two options** (segmented tabs):
  - **Structure only** → DDL (`CREATE TABLE …`).
  - **Structure and data** → DDL **plus** `INSERT` statements for the table's current data.
- **Scope:** a per-table invocation generates **only that table** (title `name (table)`);
  a schema/folder invocation generates **all tables** of that schema (title
  `name (schema · N tables)`).
- **Dialect-aware:** for a ClickHouse connection the DDL is native ClickHouse
  (`ENGINE = MergeTree() / ReplacingMergeTree(...) / SummingMergeTree(...)`,
  `PARTITION BY toYYYYMM(...)`, `ORDER BY`, `TTL`, `SETTINGS index_granularity`).

### 8. Compare / Migrate — DDL Diff (DataGrip-style)

- Opened from the toolbar **Compare** action (relational + ClickHouse).
- Source/target connection selectors (must be the **same system type**; helpful message
  otherwise).
- **Object tree** of differences with status (changed / source-only / target-only /
  identical) and a **migrate checkbox per row** — the checkbox is shown **only on rows that
  actually differ** (identical rows have none). Its checked state (`true`/`false`) controls
  whether that object is migrated when **Execute** runs.
- **Bottom DDL Diff viewer** with tabs (Script Preview / Object Properties Diff / **DDL
  Diff**), a viewer toolbar (prev/next-difference arrows; "Side-by-side viewer" / "Do not
  ignore" / "Highlight words" dropdowns; live "N difference(s)" counter), and a
  **line-numbered side-by-side** code view (Origin vs Target) with blue highlight on
  changed/added/removed lines.
- Action bar: **Cancel / Open in New Query Console / Execute**.

### 9. ER Diagram (tab type `er`)

- Auto-generated from tables + foreign keys; draggable table nodes, FK edges, auto-layout,
  empty-state prompt to drag tables from the explorer. (See `uploads/overview.md` §3.13 for
  the full intended feature set: zoom/pan, minimap, PNG/SVG/Mermaid export.)

### 10. Command Palette (⌘P)

- Fuzzy list of actions + recent tabs/objects (Run query, New tab, Open table, toggle
  theme, etc.). Opened with ⌘P. (The persistent title-bar search box was removed; the
  palette is the single entry point.)

---

## Context Menus (functional, not decorative)

Menu actions **do real work** — "Generate SQL/DDL", Rename, Truncate, Drop, etc. open a new
SQL editor tab pre-filled with the generated statement (`openSqlTab(title, sql)`); they don't
just flash a toast.

**Table** — Open Data, Edit Data, New Query Console, View as ER Diagram · Design Table, Add
Column, Rename Table…, Duplicate Table… · Generate SQL → SELECT / INSERT / UPDATE / DELETE,
Generate DDL (CREATE), Generate Scripts… · Import / Export / Dump, Copy Table to…, Compare /
Migrate… · **(ClickHouse only)** Optimize Table (FINAL), Show Partitions, Show Engine /
Settings, Detach / Drop / Freeze Partition (querying `system.parts` / `system.tables`) ·
Truncate, Drop (danger) · Copy Name / Qualified / SELECT · Row Count & Statistics, Refresh.

**Schema** — New Query Console, Create Table… · **relational:** Create View / Procedure /
Function / Sequence · **ClickHouse:** Create Materialized View / Dictionary / Function · View
/ New ER Diagram, Generate Scripts…, Compare / Migrate · Import / Export / Backup · Find in
Schema, Manage Privileges, Statistics · Set as Default Schema, Refresh, Copy Name · Drop
Schema (danger).

**Tables/Views folder** — New Table…, New Query, Select All Data, Generate DDL (all),
Generate Scripts…, ER diagram, Import / Export, Refresh, Collapse all, Copy Name.

**Dictionary (ClickHouse)** — Show Definition (`SHOW CREATE DICTIONARY`), Query Dictionary,
Reload Dictionary (`SYSTEM RELOAD DICTIONARY`), Drop, Copy Name.

**View / Procedure / Function / Trigger / Sequence / Column** — Show Definition / Open /
Execute / Generate DDL / Drop / Copy variants as appropriate to the type.

**Context-menu panel behavior:** the menu is `position:fixed`, opens at the cursor, and its
**`max-height` is computed to fit the space from its top to the viewport bottom**
(`calc(100vh - top - 16px)`), scrolling internally. Tall menus opened near the bottom are
pulled up so the panel never overflows off-screen.

---

## Interactions & Behavior (summary)

- **Toolbar gating:** New Query, ER, DDL/Generate Scripts, Compare, Edit, Synchronize are
  **disabled (greyed, `not-allowed`)** until a connection is selected in the sidebar.
- **Run:** selection-aware (selected statements vs all); rebuilds Messages; shows grid.
- **Save-before-close** dialog for dirty tabs.
- **Pagination** only above 50 rows.
- **Theme toggle** (dark/light) in the title bar; toggles the `ds-light` class on `.ds`.
- **Resizers** for sidebar width, connection-list height, editor/result split — all persisted.
- **Toasts/flashes** for transient confirmations; in production, border-left should carry the
  originating connection's accent color (see `spec/overview.md` §2.6).

---

## State Management

The prototype keeps everything in one component's `state` + a couple of instance arrays.
Map these onto your framework's store(s):

- `CONNS` — connection profiles (id, name, system, host, port, db, user, group, ssh*, ssl,
  connected, latency).
- `TABS` — open tabs (id, connId, type, title, dirty, query, sub[]).
- `activeTabId`, `activeSubTab`, `page`, `pageSize` (default 100), `viewMode`
  (`grid|json|single`).
- `selConnId` — the selected connection (drives toolbar gating + explorer).
- `connMgrId` / `cmDraft` — Connection Manager target + working draft.
- `scripts` (`{name, kind}`) + `scriptMode` (`structure|data`) — Generate Scripts modal.
- `compareSrc` / `compareTgt` / `cmpSelTable` / `cmpExpanded` / `cmpChecked` /
  `cmpRunning` — Compare tool.
- `ctx` — the active context menu descriptor (`{x,y,kind,name,…}` or `tabMenu` / `connMenu`
  / `grid`).
- `tabSave` — pending save-before-close descriptor.
- `theme`, sidebar/editor sizes, `grpCollapsed`, `collapsed`, `treeSel`.

**Data fetching (production):** every read in the prototype is mock data. Replace with real
driver calls — `sqlx`/`tiberius` for relational, a ClickHouse HTTP/native client for
ClickHouse, `redis-rs`, `rdkafka`, `async-nats` — behind the IPC layer described in
`spec/overview.md` §3.

---

## ClickHouse — specifics (new in this version)

- **System color** `#FFCC00`, badge `CH`, default port `8123`, backtick identifier quoting.
- Sample connection: **Analytics ClickHouse** (`analytics` db).
- **Schemas** with engine-aware tables:
  - `events` — `MergeTree`, `PARTITION BY toYYYYMM(event_date)`,
    `ORDER BY (event_date, event_type, user_id)`, `TTL event_date + INTERVAL 90 DAY`,
    columns incl. `Date`, `LowCardinality(String)`, `UInt64`, `UUID`, `String CODEC(ZSTD(3))`.
  - `page_views` — `MergeTree`, monthly partitions.
  - `sessions` — `ReplacingMergeTree(updated_at)`, `Nullable(DateTime)` columns.
  - `metrics_daily` — `SummingMergeTree((events, revenue))`, `Float64`.
- **Open Data** returns realistic sample rows + large totals (e.g. `events ≈ 18.4M rows`).
- **DDL** emits native ClickHouse `CREATE TABLE … ENGINE = … PARTITION BY … ORDER BY … TTL …
  SETTINGS index_granularity = 8192`.
- **Mutations:** Generate UPDATE/DELETE emit `ALTER TABLE … UPDATE/DELETE WHERE …`.
- **Table ops:** Optimize (FINAL), Show Partitions / Engine / Settings (via `system.parts`,
  `system.tables`), Detach / Drop / Freeze Partition.
- **Schema create menu:** Materialized View, Dictionary, Function (instead of Sequence/Proc).
- Reference: model the feature depth on **DBeaver's ClickHouse support**.

---

## MariaDB, Cassandra, SQLite — specifics (added)

Three systems were added alongside the original seven. Sidebar groups now also carry an
**uppercase category label** (RELATIONAL / ANALYTICAL / WIDE COLUMN / CACHE / STREAMING /
EMBEDDED) shown above the first group of each category, and every connection row shows a
color-coded **environment tag** (`PROD` red, `STG` amber, `DEV` green, `LOCAL` violet),
driven by `conn.env`.

| System | accent | bg | border | fg | badge | port | quoting | category |
|---|---|---|---|---|---|---|---|---|
| **MariaDB** | `#C0765A` | `#2e1a12` | `#5c3020` | `#e8a882` | `MA` | `3306` | backtick | Relational |
| **Cassandra** | `#1287B1` | `#0a2030` | `#134f72` | `#5cc4e8` | `CS` | `9042` | double-quote | Wide Column |
| **SQLite** | `#0F80CC` | `#0a1e35` | `#12406a` | `#60b8f5` | `SL` | — (file) | double-quote | Embedded |

- **Icons** (inline SVG in `dbIcon()`): MariaDB — barrel/cylinder with seal lines;
  Cassandra — central ring node with 6 satellite nodes + spokes; SQLite — feather/file with
  data cylinder.
- **MariaDB** reuses the relational `relTree` + SQL editor + ER/designer/compare path
  (`selRel === true`). Sample connection **MariaDB App** (`app_db`, DEV).
- **SQLite** (`sqliteTree`): single **file** root (`/data/local.db`) → `main` schema →
  Tables (with `sqlite_sequence` / `sqlite_master` shown locked 🔒), Views, Triggers. Uses
  the SQL editor. Connection form shows a **file path** instead of host/port. Sample
  connection **Local SQLite** (LOCAL env).
- **Cassandra** (`cassandraTree`): `app_ks` **keyspace** → Tables (with partition/clustering
  key meta `uuid · PK`, `timeuuid · CK` and `~N` row estimates), **Materialized Views**,
  **User Types** (UDT), **Functions** (UDF), **Secondary Indexes**. Opens a **CQL editor**
  tab (`type:'sql'`, `cql:true`, title `Untitled CQL`) reusing the SQL editor + result grid.
  Sample connection **Profiles Cassandra** (`app_ks`, PROD, SSL).
- All three are registered in: `SYS` color map, `dbIcon()`, `qid()` quoting, the connection
  **group order** + **category map**, the **new-connection picker** grid, `openConn`
  tab-type dispatch, `openConnNew` default-port map, the tree dispatch, and the type-aware
  connection form (`rel` set).

### Result Viewer — Chart mode (added)

The result view-mode toggle now has a **4th mode, `Chart`**, after Grid / JSON / Single Row
(`viewMode === 'chart'`, set via `setView('chart')`). It renders a **left builder rail**
(228px) + a responsive inline-SVG chart:

- **Chart type** — Bar / Line / Pie / Area.
- **X axis** / **Y axis** — any result column (pickers populated from `cur.cols`).
- **Aggregation** — sum / avg / count / min / max, grouped by the X column (first 12 groups).
- Bars/lines use the **active connection accent**; gridlines `var(--border)`, axis labels
  `var(--text2/muted)`; every bar/point/slice has a hover `<title>` tooltip. Pie includes a
  legend. PNG / SVG export buttons (stubbed via flash).
- Built by `buildChart(type, data, xLabel, yLabel, accent)` returning a `React.createElement`
  SVG (`viewBox 0 0 580 360`). Number axis labels abbreviate to k/M/B. New state:
  `chartType`, `chartX`, `chartY`, `chartAgg`.

### Query History + Session Monitor (added)

Two title-bar launchers (**History**, **Sessions**) open dedicated workspace tabs (tab types
`history` and `sessions`, matching the existing `er`/`compare` pattern).

**Query History** (`HISTORY` mock array of 10 entries): a searchable list — timestamp,
system badge, query preview, row/affected count, duration. The search box filters on query
text. Clicking a row opens a new SQL tab pre-filled with that query
(`openHistoryQuery`). State: `histSearch`.

**Session Monitor** (`SESSIONS` + `LOCKS` mock data, keyed by system): a **Sessions** /
**Locks** sub-tab toggle, a **connection selector** (SQL connections only), and an
**Auto-refresh** selector (Manual / 5s / 10s / 30s) + manual Refresh.
- *Sessions* table: pid · user · state (color-coded pill) · wait_event · query · duration ·
  client, each with a **Kill** action (flash confirm).
- *Locks* table: lock_type · relation · pid · granted · blocking_pid, with a **Kill blocker**
  action on rows that have a blocking pid.
- State: `sessSubTab`, `sessConnId`, `sessRefresh`.

### Cassandra Ring Topology (added)

When the active connection is **Cassandra**, the SQL/CQL editor toolbar shows a contextual
**Ring** button (`isCassandraConn`) that opens a `cassandra-ring` workspace tab. It renders an
inline-SVG **ring** (dashed circle, `buildRing`) with the cluster's nodes placed evenly around
it — each a green `UN` node circle with a hover `<title>` (host · dc/rack · load · owns), the
keyspace + `RF=3 · NTS` in the center, and a right-hand **Nodes** panel listing host, DC, rack,
load, and ownership per node. Header shows `● 3/3 nodes UP` and the DC distribution
(`dc1(2) dc2(1)`). Mock data: `RING_NODES` (3 nodes across 2 DCs).

### SQL Dialect Converter (added)

A **Convert** button in the SQL editor toolbar opens a rule-based dialect converter modal
(`dialectOpen`). Source/target pickers across PostgreSQL / MySQL / MariaDB / SQL Server /
SQLite; the input seeds from the current editor query. `convertSql(src, tgt, input)` applies
deterministic regex rules (no AI) and emits per-rule **conversion notes** (⚠ transformed /
✓ supported):
- `ILIKE` → `LIKE`; PostgreSQL `expr::TYPE` → `CAST(expr AS TYPE)` (type-mapped per target).
- `SERIAL` → `AUTO_INCREMENT` (MySQL/MariaDB) / `INTEGER PRIMARY KEY AUTOINCREMENT` (SQLite)
  / `IDENTITY(1,1)` (SQL Server).
- `GETDATE()` ↔ `NOW()`; `SELECT TOP n` ↔ `LIMIT n`; backtick ↔ double-quote identifiers.
Output panel + **Copy Output** and **Open in New Tab** (creates a SQL tab on a target-dialect
connection). State: `dialectSrc`, `dialectTgt`, `dialectInput`.

### Object Properties — right sidebar (added)

A resizable, collapsible **right sidebar** (default 264px, drag handle on its left edge,
`⇥` to hide; `rightPanelOpen`, `rightPanelW`) shows **Object Properties** for the
Explorer-selected node (`treeSel`):
- **Table** node → header (▦ name + schema), **DDL** preview (`genCreate`), **Statistics**
  (rows, columns, table size, indexes, last analyzed), and an **Indexes** list.
- **Column** node → header (▸ name, `in <parent table>` resolved by walking the tree),
  **Details** (type, nullable, key role, default), and **Sample values** with frequencies.
- Empty state prompts the user to select a node. Works across all relational/analytical
  systems (Postgres, MySQL, MariaDB, MSSQL, ClickHouse, SQLite, Cassandra).

### SQLite file header + PRAGMA panel (added)

For any SQL tab on a **SQLite** connection (`isSqliteTab`), a **file-info header** strip sits
above the editor toolbar: SL badge, file path, size (`12.4 MB`), `WAL: ON`, SQLite version,
and action buttons — **VACUUM**, **Integrity Check**, **Analyze**, **Export .sql** (each flashes
realistic output), plus a **PRAGMA ▾** toggle. The collapsible **PRAGMA panel** is a 4-column
grid: editable selects for `journal_mode`, `foreign_keys`, `synchronous`, `temp_store`,
`auto_vacuum` (changing one flashes `PRAGMA key=value`) and read-only `cache_size`,
`page_size`, `page_count`. State: `sqlitePragmaOpen`, `sqlitePragma`.

### Export Wizard (added)

The result toolbar's **Export ▾** button opens an Export Wizard modal (`exportOpen`):
source table, **format** (CSV / Excel .xlsx / JSON / SQL INSERT — switching updates the
filename extension), optional **WHERE filter**, **row limit**, **filename**, and a
**column selector** (toggle chips) seeded from the active result set (`_exportCtx`). The footer
shows a live `N cols · FORMAT` summary; **Export** flashes a realistic download confirmation.
State: `exportTable`, `exportFormat`, `exportWhere`, `exportLimit`, `exportFile`,
`exportColsSel`.

### Generate Test Data (added)

A table context-menu item **Generate Test Data…** opens a modal (`testDataOpen`): row count,
locale (en_US / vi_VN / de_DE / ja_JP), null rate, and output (INSERT / CSV). A
**column-mapping** list maps each column to a heuristic **Faker.js** provider
(`fakerFor(col, type)` — emails, names, prices, status enums, dates, ints…) tagged `auto` or
`custom`. **Generate** opens a new SQL tab with realistic `INSERT … VALUES` statements. State:
`tdTable`, `tdRows`, `tdLocale`, `tdNull`, `tdOutput`.

### Kafka Message Producer (added)

The Kafka workspace **＋ Produce** button and the topic context-menu **Produce Message…** open
a full producer modal (`kProdOpen`): partition selector (Auto / 0–3), message **key**, dynamic
**headers** (Add Header / per-row key+value + remove), JSON **payload** textarea, and a
**schema** selector (None / Avro / Protobuf / JSON Schema). **▶ Produce** appends the message to
the live topic feed with a returned offset + partition and flashes a confirmation. State:
`kProdTopic`, `kProdPartition`, `kProdKey`, `kProdPayload`, `kProdSchema`, `kProdHeaders`.

### NATS Request / Reply (added)

The NATS workspace **Request** button opens a Request/Reply modal (`nrqOpen`): subject input,
timeout (ms), and a payload textarea. **▶ Send Request** shows the **request** and **reply**
stacked, with the reply's `_INBOX.*` address and round-trip time (`received in N ms`); the
exchange is also appended to the live subject feed. State: `nrqSubject`, `nrqPayload`,
`nrqTimeout`, `nrqReply`, `nrqMs`, `nrqInbox`.

### ClickHouse TTL Policy Viewer (added)

The ClickHouse table context-menu **TTL Policy…** opens a modal (`ttlOpen`) that parses the
table's `TTL` clause (from `CH_SCHEMA`) into human-readable rules: each rule shows the raw
expression, a **DELETE**/**MOVE** action badge, and a plain-language description (e.g. "Rows
older than 90 days will be deleted", "… moved to cold storage"), plus the engine + TTL merge
threshold. **MATERIALIZE TTL** opens a SQL tab with `ALTER TABLE … MATERIALIZE TTL`. Tables with
no TTL show an empty state. State: `ttlTable`.

### Import Wizard (added)

A 5-step Import Wizard (`importOpen`), launched from the table context-menu **Import Data from
File…** and the Explorer toolbar import icon, with a numbered **stepper** (File → Preview →
Mapping → Options → Execute):
1. **File** — drag-drop / Browse dropzone, supported formats, detected file summary.
2. **Preview** — first sample rows in a grid.
3. **Mapping** — source→target column mapping with inferred types.
4. **Options** — on-conflict (INSERT/IGNORE/REPLACE/UPDATE), batch size, encoding, skip header.
5. **Execute** — progress bar + result (`1,204 rows imported · 0 errors · 2.3s`).
Back/Next navigation; the final step flashes the import confirmation. State: `impTable`,
`impStep`.

### Redis Pub/Sub Monitor (added)

The Redis workspace **Pub/Sub ▸** button opens a `redis-pubsub` workspace tab: a **pattern**
filter (`orders.*` glob → regex), a **Subscribe/Pause** toggle that streams live messages
(timestamp · channel · payload) every 1.5s, a **Clear** button, a live message count, and a
bottom **Publish** form (channel + message → appends to the feed, flashes `PUBLISH`). State:
`pubsubMsgs`, `pubsubLive`, `psPattern`, `psPubChannel`, `psPubMsg`.

### Connection form — expanded fields (added)

The connection manager form now has an **Environment** dropdown (Production / Staging /
Development / Local — drives the sidebar env pill) and a **Group** field for every system, plus
**system-specific** fields:
- **Cassandra** — Local datacenter + Consistency level (LOCAL_QUORUM / QUORUM / ONE / ALL / …).
- **SQLite** — Mode (Read-Write / Read-Only / In-Memory) + an "embedded file-based database"
  note.
New connections seed `env: 'development'`. Stored on `cmDraft` via `cmEnv`, `cmDc`,
`cmConsistency`, `cmMode`.

### Result grid — column filter bar (added)

The result toolbar's **Filters ▾** toggle reveals a per-column filter row beneath the grid
header (sticky). Typing in any column's box filters the visible rows client-side
(case-insensitive substring match, combined across columns); the row count updates live and the
toggle highlights when any filter is active. State: `gridFiltersOpen`, `gridFilters`.

### Saved Queries panel (added)

A title-bar **Saved** launcher opens a `saved` workspace tab with a **folder tree** (My Queries
/ Shared (team) / Analytics) of saved queries, each tagged with its system badge. Folders
collapse/expand; clicking a query opens it in a new SQL tab (`openSavedQuery`). **Ctrl+S** saves
the current editor's content into *My Queries* (`saveCurrentQuery` → `savedExtra`); **Ctrl+H**
opens Query History. State: `savedCollapsed`, `savedExtra`.

### PostgreSQL Extension Manager (added)

For Postgres connections the SQL editor toolbar shows an **Extensions** button
(`isPgConn`) opening an `extensions` workspace: a `pg_available_extensions` table (name,
default version, installed badge, comment) for 8 common extensions (pg_stat_statements,
uuid-ossp, pgcrypto, postgis, pg_trgm, hstore, citext, pg_cron). Each row has an
**Install**/**Drop** toggle that flips installed state and flashes
`CREATE EXTENSION`/`DROP EXTENSION`; the header shows an installed/available count. State:
`extInstalled`.

### MSSQL Agent Jobs Viewer (added)

For SQL Server connections the editor toolbar shows an **Agent Jobs** button (`isMssqlConn`)
opening an `agentjobs` workspace: an `msdb.dbo.sysjobs` table (job name, enabled, last run,
status, next run) with color-coded statuses (Succeeded green / Failed red / Running amber /
Disabled gray) and a **Start/Stop** action per job (flashes confirmation). Header shows an
enabled/total count. State: `agentJobsRunning`.

### Kafka Schema Registry (added)

The Kafka workspace **Schema Registry** button opens a `schemareg` workspace: a left
**subjects** list (format badge AVRO/PROTOBUF/JSON, latest version, compatibility) and a
detail pane with **version** chips and the selected schema's content (Avro record, Protobuf
message, or JSON Schema), plus a compatibility + registered-date footer. Mock subjects:
payments-value, orders-value, user-events-value, notifications-value. State: `srSubject`,
`srVersion`.

### NATS Object Store (added)

The NATS workspace **Object Store** button opens an `objstore` workspace: a left **buckets**
list (assets, backups — with object count + size) and an object table per bucket (name, size,
chunks, modified) with **⬇ Get** / **🗑** actions and a **＋ Put Object** upload button. State:
`osBucket`.

### JSON / JSONB cell expansion (added)

Grid cells holding JSON (column type `json`/`jsonb`/`map`, or a value that parses as a JSON
object/array) show a small clickable **`{ }`** badge. Clicking it opens a **JSON viewer** modal
(`jsonCellOpen`) with the value pretty-printed and a **Copy** button. The `users` result set
carries a `metadata jsonb` column to demonstrate it. State: `jsonCellCol`, `jsonCellRaw`.

### MSSQL connection — Authentication modes (added)

For SQL Server connections the connection form shows an **Authentication** dropdown
(`cm.isMssql`): SQL Server Authentication, Windows Authentication, Azure Active Directory, and
Azure AD — Universal w/ MFA. Conditional fields:
- **SQL** — username + password (default).
- **Windows** — hides user/password, shows an "Integrated Security=SSPI · current Windows
  session" note with the resolved `DOMAIN\\user` identity.
- **Azure AD** — relabels user to "Azure AD account", shows a browser-sign-in note; the MFA
  variant additionally hides the password field.
Stored on `cmDraft.auth` via `cmAuth`; derived flags `authWindows`/`authAzure`/`authShowUser`/
`authShowPass`.

### MSSQL Query Store + Availability Groups (added)

Two more SQL Server toolbar workspaces (MSSQL connections):
- **Query Store** (`querystore`) — top queries with a metric toggle (Avg duration / Execution
  count / CPU time), showing query_id, text, avg duration (color-graded), execs, plan count,
  and a per-query **Force plan / Unforce** toggle (flashes confirmation, header forced-plan
  count). State: `qsMetric`, `qsForced`.
- **AG Status** (`availgroups`) — Always On availability groups (`sys.dm_hadr_*`): per-group
  health badge + listener, and a replica table (role PRIMARY/SECONDARY, availability mode,
  sync state color-coded, send/redo queue). Two mock groups (Production HEALTHY, Reporting
  PARTIALLY_HEALTHY).

---

## Design Tokens

CSS custom properties on `.ds` (dark) and `.ds.ds-light` (light):

**Dark**
```
--bg:#0f1219;  --surface:#161a23;  --panel:#1b1f2a;  --raised:#222838;
--border:#272d3a;  --border2:#333b4d;  --text:#e6e9f0;  --text2:#aab2c4;
--muted:#6b7486;  --header:#13161f;  --hover:#1f2533;  --primary:#5b7cff;
--grid-zebra:#181c26;
```
**Light**
```
--bg:#eef1f7;  --surface:#ffffff;  --panel:#f4f6fb;  --raised:#ffffff;
--border:#e2e6ef;  --border2:#d2d8e4;  --text:#1f2937;  --text2:#4b5563;
--muted:#8a93a6;  --header:#f4f6fb;  --hover:#eef1f7;  --primary:#3858e9;
--grid-zebra:#f7f9fc;
```

**Semantic status colors:** added/success `#27AE60`, changed/warn `#f0a020`/`#f0c674`,
removed/error `#e06c75`, diff highlight `rgba(74,110,224,.20)`.

**Typography:** `'Inter', 'Be Vietnam Pro', -apple-system, sans-serif` for UI;
a monospace stack (`class="mono"`) for SQL, identifiers, and code/diff views.

**Radius:** cards/dialogs ~10–14px; inputs/buttons ~7–8px; small chips ~4–6px.
**Shadows:** dialogs `0 30px 70px rgba(0,0,0,.55)`; context menu `0 16px 44px rgba(0,0,0,.5)`.

---

## Assets

- `assets/db-postgres.png`, `assets/db-mysql.png`, `assets/db-mssql.png` — relational logos
  (raster). Replace with your icon system / official logos in production.
- Redis, Kafka, NATS, ClickHouse icons are **inline SVG** drawn in code (`dbIcon()`), not
  files. Recreate as components or swap for licensed logos.
- No other external image assets. Monaco editor loads from CDN at runtime.

---

## Files

- `Database Studio.dc.html` — the full prototype (single file: markup + logic). Primary
  reference for layout, behavior, and exact values.
- `../../overview.md` (`spec/overview.md`) — the consolidated product spec (broader vision,
  tech stack, roadmap, security, per-broker feature lists). Read alongside this README.
- `screenshots/` — reference captures of key views (compare, clickhouse, connection dropdown,
  toolbar icons, my-db) if included.

> A developer who wasn't in the original conversation should be able to implement the design
> from this README + `Database Studio.dc.html` alone.
