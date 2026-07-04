# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Database Studio is a Tauri 2 desktop DB/streaming client (Rust backend `src-tauri/` + Svelte 5 frontend `src/`) supporting 10 systems: PostgreSQL, MySQL, MariaDB, MSSQL, SQLite, ClickHouse, Cassandra, Redis, Kafka, NATS.

## Commands

```bash
# Frontend gate — must be 0 errors / 0 warnings before commit
npm run check                      # svelte-check + tsc

# Unit tests (Vitest — frontend, jsdom, no DB)
npx vitest run                     # all
npx vitest run src/lib/sql/chops.test.ts   # single file
npx vitest run -t "toMermaid"      # by test name

# Visual/e2e (Playwright — pixel-diff + DOM vs the prototype; auto-starts vite)
npx playwright test                # all
npx playwright test cassandra-workspace    # single spec

# Design tokens (see "1:1 UI" below) — regenerate + guard
npm run tokens                     # extract colors/spacing from the prototype HTML
npm run tokens:check               # fail build on hardcoded styles

# Desktop app (dev/build run from repo ROOT; tauri.conf beforeDev runs `npm run dev`)
npm run tauri dev
```

### Rust build & tests (Windows toolchain gotchas)
`rustc`/`cargo` are rustup user-level and **not on Git Bash PATH by default**. `rdkafka` (Kafka) builds `librdkafka` via CMake, also not on PATH. Prefix cargo commands:
```bash
export PATH="$PATH:$HOME/.cargo/bin:/c/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin"
cargo build --lib        # compiles the driver layer (does NOT compile #[cfg(test)])
cargo test --lib lint::  # Rust unit tests (pure, no DB) by module path
```

### Integration tests (`src-tauri/tests/drivers_integration.rs`) — real engines via testcontainers
**Mandatory run methodology** (avoids self-inflicted flakiness): prebuild first so the timeout only covers execution, then run **synchronously in one shot** with a hard `timeout`, write to a log, print the exit code, and read the log in the *same* command. Never background, never spawn a "monitor", never `docker rm`/prune by `label=org.testcontainers` (kills the Ryuk reaper → lingering containers) — testcontainers owns cleanup via `Drop`.
```bash
cargo test --test drivers_integration --no-run
timeout 400 cargo test --test drivers_integration clickhouse_roundtrip -- --nocapture --test-threads=1 > out.log 2>&1; echo "EXIT=$?"; tail -40 out.log
```
Cassandra/MSSQL/ClickHouse containers are slow (~1–3 min) — use generous timeouts. Integration tests **seed the container then query back to verify** (no hard-coded expected results).

## Architecture

### The Tauri boundary + dual-mode IPC (critical)
Every backend call goes through `src/lib/ipc.ts`, whose `invoke()` dispatches to the real Tauri command **or** to `src/lib/demo.ts` mocks when `IS_TAURI` is false (`ipc.ts:9`). This is why the app runs in a plain browser — **Vitest and Playwright exercise the demo path**. Consequence: any new `#[tauri::command]` needs a matching case in `demo.ts`, or browser/visual tests break.

### Backend driver layer (`src-tauri/src/drivers/`)
All connections are unified behind the `LiveConnection` enum in `drivers/mod.rs`. Each system is a variant with its own `<system>.rs` module; `mod.rs` holds the `connect`/`test`/`exec`/`ping`/`exec_params`/`apply_grid_changes`/introspection **match arms that dispatch per variant** plus `<system>_params()` builders that map a `ConnectionProfile` → driver params. Adding a system = new module + variant + arms in every match. Non-SQL systems (Redis/Kafka/NATS/Cassandra) return typed "not applicable" errors from the SQL arms and expose their features through dedicated commands instead.

`connections/registry.rs` owns live connections (one per profile), the optional SSH tunnel, in-flight statement cancellation (abort + reconnect), and per-driver param accessors. `commands/*.rs` are thin `#[tauri::command]` wrappers registered in the `invoke_handler!` list in `src-tauri/src/lib.rs` — **a command is dead until added there**. `storage/` is an internal rusqlite DB (connection profiles with AES-256-GCM passwords, tabs, query history, app_state) — distinct from user-connected SQLite.

### Result/exec contract
The locked shape is `{ ok, result?: { cols:[name,type][], rows, total }, error?, duration_ms }` (`drivers/types.rs` `StatementOutcome`/`ExecResponse`). The multi-statement SQL editor splits statements client-side and sends each individually. ClickHouse is HTTP/reqwest (dynamic result sets); Cassandra CQL runs via a dedicated `cql_exec` command with paging-state tokens (never LIMIT/OFFSET).

### Frontend state (Svelte 5 runes)
Stores are runes classes in `src/lib/stores/*.svelte.ts` (`connections`, `tabs`, `results`, `explorer`, `ui`, `settings`, `palette`…). `App.svelte` dispatches the active tab's `contentType` to a workspace component. **Adding a workspace/tab type requires three edits**: `TabContentType` in `src/lib/types.ts`, an `open…` method on the `tabs` store, and an `{:else if}` branch in `App.svelte`'s `paneBody` snippet. Watch the `effect_update_depth_exceeded` trap: a `$effect` that calls a store method which synchronously reads+writes the same `$state` must wrap the call in `untrack(() => …)` and track only primitive deps.

### 1:1 UI with the prototype (enforced)
`spec/Database Studio design/design_handoff_database_studio/Database Studio.dc.html` is the source of truth for UI. Colors/spacing come **only** from generated tokens (`src/lib/systems.gen.ts`, `src/lib/tokens.css` via `npm run tokens`); `npm run tokens:check` forbids hardcoded style values in components. SVG icons are copied verbatim from the prototype's `dbIcon()`. Playwright specs in `tests/visual/` pixel-diff app regions against the prototype. When the prototype and a phase spec conflict on layout, the prototype wins; specs add functional/data requirements.

### Specs & process
`spec/phase-1..6*.md` + `spec/Database Studio design/design_handoff_database_studio/*ADDENDUM.md` define scope; addendums override the base spec for their system (e.g. `CLICKHOUSE_SPEC_ADDENDUM` §7 = editable grid must generate async `ALTER TABLE … UPDATE/DELETE`, not OLTP). `GAP_REVIEW.md` / `SPEC_SUPPLEMENT.md` track outstanding design-vs-code gaps and the remaining `T10+` task backlog. Work proceeds phase-by-phase, committing per task with tests green.

## Tiến độ task (T10–T23, theo SPEC_SUPPLEMENT.md)

Cập nhật sau MỖI commit. Rule: 1 task/lần, unit+integration xanh mới commit `T<n>: …`, không nới assertion; kẹt >3 lần sửa → ghi tình trạng vào đây + hỏi.

- **T10 — Connection Test/Cancel correctness — ✅ DONE** (commit `T10:`). Bounded timeout (`connect_timeout()`=10s) + cancellable `run_test_bounded` (token vs timeout vs test, SSH tunnel always `shutdown()`), `classify_connect_error`, `cancel_test` cmd, ConnectionForm uuid testId + cancel-on-close. Tests: unit (timeout/error-map) + integration `connection_test_bounded_and_cancellable` (live ok / closed-port bounded / cancel <1s) EXIT=0.
- **T11 — Cancel running query — ✅ DONE** (commit `T11:`). Verified registry cancel (abort task → CANCELLED + poison → heal on next stmt); UI: `TabExecution.startedAt` + "running Ns" timer on Cancel button + long-run warning toast (`settings.longRunningWarnMs`). Integration `query_cancel_aborts_and_connection_recovers` (pg_sleep→cancel ~1.16ms, follow-up SELECT 1 ok) EXIT=0.
- **T12 — Wire dead stubs — ✅ DONE** (commit `T12:`). Set-as-Filter → Table Viewer w/ seeded filter; Convert → "Converted" formatted tab; Split → moveToSplit; ResultChart real PNG/SVG export (serialize SVG + resolve CSS vars → blob); removed stub buttons SQLite Export.sql / Explorer Export-dump / Backup / Users (deferred to T14/T15/T22/T23). **Bonus fix found while verifying chart e2e:** `results.run` mutated the RAW `exec` object after assigning it into the `$state` byTab record → subResults.push/activeSub/running bypassed the proxy → live query results never rendered. Fixed by re-acquiring the proxied ref post-assignment. Tests: `tests/visual/wire-stubs.spec.ts` 4 e2e (Convert/Split/Set-as-Filter/Chart SVG export) + gates check 0/0, vitest 135, playwright 23.
- **T13 — Import wizard (Options step + progress + JSON) — ⏳ NEXT** (see SPEC_SUPPLEMENT.md).
- T14..T23 — pending (see SPEC_SUPPLEMENT.md "Implementation priority").
