# EXPLAIN — Independent Verification Report

Independent verification of the end-to-end EXPLAIN feature: Rust engine adapter →
raw plan capture → normalized `QueryPlan` model → Tauri IPC command → Svelte
render. **No product code was modified.** All engine tests ran synchronously with
an explicit `timeout` wrapper, explicit image tags, seed-then-query-back, and
testcontainers `Drop` cleanup (one container spun/torn down at a time). Every PASS
links to a captured artifact in `verification-artifacts/`.

Verification harness (evidence generator, not a feature): `src-tauri/tests/explain_verification.rs`.
It drives real engines, forces a physical scan→index change, and feeds the raw
engine output through the SAME normalizer the app uses (`drivers::plan::parse_*`).

---

## 1. Capability Matrix (from code)

Roster confirmed = **10 engines** (`drivers/types.rs:10-20`, `drivers/mod.rs:42-51`);
no Oracle/MongoDB adapters exist.

| Engine | Native cmd the app issues | App mode | Actual (post-exec) captured? | Raw preserved | Source |
|---|---|---|---|---|---|
| postgres | `EXPLAIN (FORMAT JSON)` / `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` | estimated/actual | **YES** (Actual Rows/Time) | YES | `commands/plan.rs:118-124`, `plan.rs:134-151,497` |
| mysql | `EXPLAIN FORMAT=JSON` (always) | estimated only | **NO** (actual flag dropped) | YES | `commands/plan.rs:127`, `plan.rs:152` |
| mariadb | `EXPLAIN FORMAT=JSON` / `ANALYZE FORMAT=JSON` | estimated/actual | **YES** (r_rows) | YES | `commands/plan.rs:126-127`, `plan.rs:200-201` |
| mssql | `SET SHOWPLAN_XML ON` → query → OFF | estimated only | **NO** (no STATISTICS XML) | YES | `commands/plan.rs:62-89`, `plan.rs:367-378` |
| sqlite | `EXPLAIN QUERY PLAN` | estimated | NO (engine has none) | YES | `commands/plan.rs:128`, `plan.rs:219-246` |
| clickhouse | `EXPLAIN indexes = 1` | estimated | NO | YES | `commands/plan.rs:129`, `plan.rs:275-350` |
| cassandra | `TRACING` (diagnostics, not a planner) | **actual** ⚠ | timings only, no cost/rows | YES | `commands/plan.rs:93-112`, `plan.rs:421-465` |
| redis / kafka / nats | — | not_applicable | n/a | n/a (empty) | `commands/plan.rs:30-32` |

---

## 2. Per-engine results (each cell → artifact)

Legend: ✅ pass · ⚠ pass-with-defect (documented) · n/a.

| Engine | Scan test | Index test | Estimated / Actual | Error path | Raw preserved | Verdict | Artifact |
|---|---|---|---|---|---|---|---|
| **sqlite** | ✅ `SCAN t`, hotspot+warning | ✅ → `IndexScan`, no hotspot | estimated only ✅ | (see PG) | ✅ | ✅ PASS (note DEF-SQLITE-LABEL Low) | `sqlite-scan-vs-index.txt` |
| **postgres** | ✅ `SeqScan` (raw "Seq Scan") | ✅ `IndexScan` | est ✅ / actual ✅ (Actual Rows=1, Exec Time captured) | ✅ typed error on missing table + syntax | ✅ | ⚠ PASS + DEF-PG-HOTSPOT (Medium) | `postgres-scan-index-actual.txt`, `postgres-error-paths.txt` |
| **mysql** | ✅ `SeqScan` (access ALL) | ✅ `IndexScan` (access ref) | estimated only; Actual toggle proven no-op (mode stays estimated, no actual_rows) | (uniform path) | ✅ | ⚠ PASS + DEF-MYSQL-ACTUAL-NOOP (Medium) | `mysql-scan-index.txt` |
| **mariadb** | ✅ `SeqScan` | ✅ `IndexScan` | est ✅ / actual ✅ (`ANALYZE FORMAT=JSON` → r_rows captured, mode actual) | (uniform path) | ✅ | ✅ PASS | `mariadb-scan-index-actual.txt` |
| **mssql** | ⚠ full **Clustered Index Scan** (reads 20k) mislabeled `IndexScan` | ✅ Index Seek → `IndexScan` | estimated only ✅ | (uniform path) | ✅ (raw+native honest) | ⚠ PASS + **DEF-MSSQL-CLUSTERED-SCAN (High)** | `mssql-scan-index.txt` |
| **clickhouse** | ⚠ full-granule read (6/6) NOT flagged | ✅ key read prunes to 1/6 (raw) | estimated ✅ | (uniform path) | ✅ | ⚠ PASS + DEF-CH-GRANULE-BLIND (Medium), DEF-CH-METADATA-NODES (Low) | `clickhouse-fullread-vs-key.txt` |
| **cassandra** | ✅ ALLOW FILTERING → hotspot+warning | ✅ partition-key → not hotspot | mode="actual"; **no fabricated cost/rows** | (n/a — tracing) | ✅ (trace lines) | ⚠ PASS + **OBS-1/DEF-CASS-ACTUAL-BADGE (High)** | `cassandra-tracing.txt` |
| **redis/kafka/nats** | n/a | n/a | not_applicable | honest "does not apply" | n/a | ✅ PASS (audit) — no engine call, no fabrication possible (`commands/plan.rs:30-32`; UI `PlanVisualizer.svelte:74-75`) | — (code path) |

Ground-truth strength: for every planner engine the plan was forced to change by a
real physical cause (create index / add key predicate) and the app's normalized
output was re-derived from the engine's own words (raw preserved side-by-side).

---

## 3. Coverage-gap table (unit claims a behavior; not integration-verified on a real engine)

| # | Unit test (claims) | Real-engine integration proof? | Risk |
|---|---|---|---|
| G1 | `not_applicable_for_messaging` (redis/kafka/nats) | No live-connection integration; branch is pre-engine `matches!` (`commands/plan.rs:30`) | Low (no engine call; fabrication impossible) |
| G2 | Error paths (syntax / missing table / non-explainable stmt) | Only **PostgreSQL** integration-proven (`postgres-error-paths.txt`); mysql/mariadb/mssql/sqlite/clickhouse/cassandra EXPLAIN error paths not exercised | Medium |
| G3 | Mid-query **disconnect** + query **timeout** error paths (prompt §4.6) | **Not tested on any engine** | Medium |
| G4 | `explain_plan` `#[tauri::command]` (system resolution + mssql/cassandra orchestration) and Svelte render tier | Verified by **code inspection only**; harness calls `plan::parse_*` directly and mirrors private `build_explain`/`parse_for_system`/`first_cell` (cited) rather than invoking them | Low–Medium |
| G5 | MySQL actual plan (`EXPLAIN ANALYZE`, MySQL 8) | App does not implement it; Actual toggle proven no-op (documented, not a gap in tests but a feature gap) | Low |
| G6 | Parameterized/prepared statement EXPLAIN (DBA lens) | Not tested (MSSQL auto-parameterized `@1` observed in raw, but no explicit prepared-EXPLAIN test) | Low |

---

## 4. Defect log

Fabricated-plan check: **none found.** No engine invents cost/row numbers; the
three non-planner engines (redis/kafka/nats) return honest `not_applicable`, and
Cassandra tracing carries real trace timings with `total_cost=None` and no
estimated/actual rows. So there is **no Critical defect**.

| ID | Layer | Severity | Evidence | Expected vs Actual |
|---|---|---|---|---|
| **DEF-MSSQL-CLUSTERED-SCAN** | normalize (`plan.rs:91`) | **High** | `mssql-scan-index.txt`: no-index query → `PhysicalOp="Clustered Index Scan"`, `EstimatedRowsRead=20000`, `TableCardinality=20000`; normalized `operation="IndexScan"`, `is_hotspot=false`. Index query → `Index Seek` → also `operation="IndexScan"`. | Expected: a full table scan (Clustered Index Scan reading all rows) normalizes to a scan/full-scan and/or is flagged; the scan→index change is visible. Actual: full scan and efficient seek **both** normalize to `IndexScan`; the physical change is invisible in the normalized op, and the full scan is not flagged. (Raw XML + `native_op` preserve the truth.) |
| **DEF-CASS-ACTUAL-BADGE (OBS-1)** | render / model (`plan.rs:453`, `PlanVisualizer.svelte:59`) | **High** | `cassandra-tracing.txt`: `mode="actual"`, root `operation="SeqScan"`, children `TraceEvent` with `actual_time_ms`, Summary "Total time". UI badge = `mode.toUpperCase()` = "ACTUAL" with no "tracing/diagnostics" label. | Expected: tracing rendered explicitly as diagnostics, not as a cost-based/actual execution plan. Actual: presented identically to a PostgreSQL EXPLAIN ANALYZE (badge "ACTUAL" + `SeqScan` root + per-node ms + Total time), risking a DBA believing Cassandra has an actual planner. Mitigation → not Critical: no fabricated cost/rows; child ops are labeled `TraceEvent`. Design smell: the `mode="actual"` enum value carries two meanings (real EXPLAIN ANALYZE vs. tracing). |
| **DEF-PG-HOTSPOT** | model heuristic (`plan.rs:510-515`) | **Medium** | `postgres-scan-index-actual.txt`: Seq Scan with `Plan Rows=1`, `Total Cost=896`, `is_hotspot=false`. Console: `PG scan hotspot flagged = false`. | Expected: a Seq Scan reading a large table to return few rows (classic missing-index signal) is flagged. Actual: `mark_hotspot` keys on estimated **output** rows (Plan Rows), so a selective full scan (reads 50k, returns 1) is not flagged. The SeqScan node itself is shown. |
| **DEF-CH-GRANULE-BLIND** | normalize (`plan.rs:289,325`) | **Medium** | `clickhouse-fullread-vs-key.txt`: full read (`WHERE v=7`) → `Condition: true`, `Granules: 6/6`, `is_hotspot=false`, `warnings=[]`; key read (`WHERE id=42`) → `Granules: 1/6`. Console: `full flagged=false vs key flagged=false`. | Expected: a read scanning all granules (no pruning) is flagged as a full read. Actual: app sets `uses_index=true` on the mere presence of a `PrimaryKey` block and ignores `Condition:true`/`Granules N/N`; full-granule read is indistinguishable from an efficient key lookup. (Raw preserves granule ratios.) |
| **DEF-MYSQL-ACTUAL-NOOP** | orchestration/UI (`commands/plan.rs:127,152`; `PlanVisualizer.svelte:62`) | **Medium** | `mysql-scan-index.txt`: "ACTUAL-toggle path (system=mysql)" section → `mode="estimated"`, no `actual_rows`. | Expected: an "Actual" toggle either captures actual metrics or is hidden/disabled for engines that cannot. Actual: for MySQL the toggle silently yields an estimated plan (no `EXPLAIN ANALYZE`); potentially misleading. Same class applies to MSSQL/SQLite/ClickHouse (toggle is a no-op). |
| **DEF-CH-METADATA-NODES** | normalize (`plan.rs:302-322`) | **Low** | `clickhouse-fullread-vs-key.txt`: nodes with `operation="Condition: true"`, `"Parts: 1/1"`, `"Granules: 6/6"`. | Index-analysis metadata lines are turned into plan-tree nodes (operations) rather than attributes of the read node — noisy/misleading tree shape. |
| **DEF-SQLITE-LABEL** | normalize (`plan.rs:83-116`) | **Low** | `sqlite-scan-vs-index.txt`: full scan `operation="SCAN t"` (native, not canonical `SeqScan`). | Cross-engine op labels are not unified for SQLite full scans (stays `SCAN t`). Full scan IS surfaced via hotspot + "Full scan" warning, so functionally correct; only label consistency differs. |

---

## 5. Phase C — three-lens review

### DBA lens (fidelity)
- **Raw preserved everywhere** (✅) — every engine keeps the engine's own words
  next to the normalized view (`raw` field; `PlanVisualizer` "View raw").
- **Estimated vs actual**: correct for PostgreSQL and MariaDB (actual rows/time
  captured, mode="actual"). **MySQL/MSSQL are estimated-only** but the UI exposes
  an "Actual" toggle that silently returns estimated (DEF-MYSQL-ACTUAL-NOOP).
- **Index usage / scan classification**: correct on PG/MySQL/MariaDB/SQLite.
  **Wrong on MSSQL** (Clustered Index Scan ≠ Index Seek but both → `IndexScan`,
  DEF-MSSQL-CLUSTERED-SCAN, High) and **blind on ClickHouse granule pruning**
  (DEF-CH-GRANULE-BLIND). Hotspot heuristic under-warns selective full scans
  (DEF-PG-HOTSPOT).
- **Cassandra**: honest on numbers (no fabricated cost/rows) but mislabeled as an
  "actual" plan in the UI (DEF-CASS-ACTUAL-BADGE, High).
- **Parameterized queries**: MSSQL auto-parameterizes (`@1` seen in raw) and the
  plan still parses; no dedicated prepared-statement test (G6).

### Architect lens (design)
- **Clean shared model** (✅): single `QueryPlan { system, mode, root, summary, raw }`
  (`plan.rs:55-65`) drives one visualizer for all engines — good heterogeneity story.
- **Capabilities are inferred at call time, not declared** (⚠): `build_explain`
  and `parse_for_system` `match system` on strings (`commands/plan.rs:115,134`);
  there is no per-engine capability descriptor (supports_actual, has_planner,
  is_tracing). This is the root of DEF-MYSQL-ACTUAL-NOOP and DEF-CASS-ACTUAL-BADGE
  (the `mode="actual"` enum is overloaded for both real ANALYZE and tracing).
- **Quirk isolation** (mostly ✅): MSSQL SHOWPLAN and Cassandra tracing are
  isolated in `commands/plan.rs` (`explain_mssql`, `explain_cassandra`); parsers
  are pure. Adding an 11th engine = add a `build_explain` arm + a `parse_*` +
  wire `parse_for_system` — bounded, but capability semantics still leak into the
  shared `mode` string.

### Tech Lead lens (quality & tests)
- **Unit vs integration**: 11 unit tests cover every parser; this pass adds
  real-engine integration for all 6 planners + Cassandra. Gaps: G2 (error paths
  only on PG), G3 (timeout/disconnect untested), G4 (IPC command + render verified
  by inspection only). See §3.
- **Error handling**: consistent typed path — `exec_statement` → `QueryError` →
  `AppError::Driver` → UI `error` string; a non-rows outcome returns an explicit
  error, never a silent empty plan (`commands/plan.rs:52-55`; proven for PG in
  `postgres-error-paths.txt`).
- **`unwrap()`/`expect()` on engine responses**: the feature path uses `?`/`ok_or`
  and `and_then` chains (`commands/plan.rs`), no unwrap on engine output. (The
  `unwrap`s are only in tests.)
- **Dead code / silent catch**: none observed in the EXPLAIN path.

---

## 6. Sign-off readiness

- **DBA:** ❌ **Will not sign off** — blocked by **DEF-MSSQL-CLUSTERED-SCAN (High)**
  and **DEF-CASS-ACTUAL-BADGE (High)**; DEF-PG-HOTSPOT / DEF-CH-GRANULE-BLIND /
  DEF-MYSQL-ACTUAL-NOOP reduce trust in the normalized view.
- **Architect:** ⚠ **Conditional** — model & isolation are sound; will sign off once
  engine capability is declared explicitly (fixes the overloaded `mode="actual"`
  and the MySQL/MSSQL Actual-toggle honesty). Blocked by DEF-CASS-ACTUAL-BADGE,
  DEF-MYSQL-ACTUAL-NOOP.
- **Tech Lead:** ⚠ **Conditional** — code quality/error-typing good; will sign off
  once coverage gaps G2/G3 (per-engine error paths, timeout/disconnect) and G4
  (command+render e2e) are closed.

**Overall: NOT ready to sign off.** No Critical (no fabricated plans), but two High
defects (MSSQL scan mislabeling; Cassandra tracing shown as an actual plan) block
DBA trust. Fixes are deferred to a separate pass per the verification mandate.

---

## 7. Artifacts index (`verification-artifacts/`)
- `sqlite-scan-vs-index.txt` · `postgres-scan-index-actual.txt` ·
  `postgres-error-paths.txt` · `mysql-scan-index.txt` ·
  `mariadb-scan-index-actual.txt` · `mssql-scan-index.txt` ·
  `clickhouse-fullread-vs-key.txt` · `cassandra-tracing.txt`

Each contains the raw engine output and the app-normalized `QueryPlan` (JSON)
side by side. Harness: `src-tauri/tests/explain_verification.rs`.
