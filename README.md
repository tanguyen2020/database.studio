# Database Studio

A desktop client for working with many databases and streaming systems in one window. You can browse schemas, write and run queries, edit data, compare schemas, manage users and privileges, back up and restore, read messages from Kafka, NATS and RabbitMQ, and browse Redis keys.

Built with **Tauri 2** (Rust backend) and **Svelte 5** (frontend). Runs on Windows, Linux and macOS.

> **Status:** beta (`0.1.0-beta.x`). It is usable day to day, but expect rough edges. The macOS build is not signed.

---

## Supported systems

| Category | Engines |
|---|---|
| Relational | PostgreSQL · MySQL · MariaDB · SQL Server · Oracle · SQLite · DuckDB · ClickHouse |
| Document / wide-column | MongoDB · FerretDB · Amazon DocumentDB · Cassandra · ScyllaDB |
| Search | Elasticsearch · OpenSearch |
| Cache | Redis · Valkey |
| Streaming | Kafka · Redpanda · NATS (JetStream) · RabbitMQ |

ScyllaDB, FerretDB, DocumentDB, Valkey, OpenSearch and Redpanda reuse the driver of their parent engine (Cassandra, MongoDB, Redis, Elasticsearch and Kafka respectively). The app detects which server it is talking to when you click **Test connection**.

---

## Install

1. Open the repository's **[Releases](../../releases)** page and download the installer for your platform:
   - **Windows:** the `.exe` (NSIS) installer
   - **Ubuntu / Debian:** the `.deb` or the `.AppImage`. See also [INSTALL-UBUNTU.md](INSTALL-UBUNTU.md).
   - **macOS:** the universal `.dmg`
2. **macOS only:** the app is unsigned, so run this once before the first launch:
   ```bash
   xattr -cr "/Applications/Database Studio.app"
   ```
3. **Updates:** the app checks for a new version at startup. You can also check by hand in **Settings → Updates → Check for updates**. On Linux, only the AppImage updates itself; reinstall the `.deb` by hand.

The installer ships the client tools that Backup & Restore uses (`pg_dump`, `mariadb-dump`, `mongodump`, Oracle Data Pump and so on), so there is nothing else to install.

---

## Quick guide

### Connecting
- Click **New connection** (`Ctrl+Shift+N`), pick an engine, and fill in host, port, user and password. Then click **Test connection** and **Connect**.
- **SSH tunnels** (password or private key) and **SSL/TLS** are supported.
- You can tag a connection as **PROD / STG / DEV / LOCAL**. On PROD connections the app asks for confirmation before dangerous statements.

### Explorer
- Double-click a database or schema to expand it. Double-clicking a database name also opens the **Objects** tab, which lists its tables with row counts and sizes.
- Right-click any node for its actions: Open Data, New Query, Design Table, Generate Scripts, Import/Export, Backup & Restore, Drop/Rename, and more.
- Use the layout buttons in the title bar to switch between **Connections | Explorer** (two panels) and **One sidebar** (each connection's tree opens right under it).

### Query editor
| Key | Action |
|---|---|
| `F5` | Run the whole script |
| `Ctrl+Enter` | Run the statement at the cursor |
| `Ctrl+Shift+E` | Explain (query plan) |
| `Ctrl+Shift+F` | Format SQL |
| `Ctrl+Space` | Suggest tables, columns and functions |
| `Ctrl+S` | Save to a `.sql` file |
| `Esc` | Cancel the running query |

On macOS, use `⌘` in place of `Ctrl`.

- Each tab runs on its own connection, so a long query in one tab does not block the others.
- In a multi-statement script, only statements that return rows get a result tab. INSERT/UPDATE/DELETE and DDL are collected in the **Messages** tab.
- The result of a `SELECT` from a single table that has a primary key can be edited in place.

### Data grid (Open Data and query results)
- Double-click a cell to edit it, or select rows in the `#` column to delete them. Nothing is written until you click **Execute**; **Preview diff** shows the statements first.
- Right-click the grid to copy as CSV, JSON, SQL INSERT/UPDATE, Markdown or XML.
- **Export** to CSV (UTF-8 with BOM), JSON, SQL, XML or Excel (`.xlsx`).

### Other tools
- **Table Designer:** Fields, Indexes, Foreign Keys, Uniques, Checks, Triggers and Partitioning tabs.
- **Schema Compare:** compares two databases, shows each difference, generates a sync script and applies it to the target.
- **ER Diagram:** shows table relationships. Drag between columns to create a foreign key; export to SVG or PNG.
- **Users & Privileges:** create users and roles and grant access, following each engine's own permission model.
- **Backup & Restore:** in the right-click menu of every database, with a progress window and a Stop button.
- **Streaming** (Kafka · NATS · RabbitMQ · Redis): selecting the connection opens a dedicated workspace with an overview, the list of topics, streams, queues or keys, message viewing and publishing, consumer groups and configuration.
- **Command Palette** (`Ctrl+P`): jump to connections, tables and commands.

---

## Running from source

### Prerequisites
| Tool | Notes |
|---|---|
| **Node.js 20+** | |
| **Rust** (stable, via [rustup](https://rustup.rs)) | |
| **CMake** | Needed to build `librdkafka` (Kafka). On Windows it ships with Visual Studio 2022. |
| **Windows** | Visual Studio 2022 Build Tools with the "Desktop development with C++" workload |
| **Ubuntu** | `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libcurl4-openssl-dev build-essential file patchelf` |
| **macOS** | Xcode Command Line Tools (`xcode-select --install`) |

> **The first Rust build takes about 20–30 minutes** because it compiles DuckDB (C++) and librdkafka. Later builds take a few minutes.

### Desktop app
```bash
npm install
npm run tauri dev        # run from the repository root
```

### UI only, in a browser (no Rust needed)
```bash
npm install
npm run dev              # open http://localhost:5173
```
In a browser the app runs in **demo mode**: every backend call is answered by `src/lib/demo.ts`, which comes with sample data. This is the quickest way to work on the UI, and it is also the mode the Vitest and Playwright tests run in.

### Windows: cargo on PATH
In Git Bash, `cargo` and CMake may not be on `PATH`:
```bash
export PATH="$PATH:$HOME/.cargo/bin:/c/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin"
```

### Bundled backup tools (optional)
Installers include `pg_dump`, `mariadb-dump`, `mongodump`, the Oracle Instant Client and similar tools. To get them when running from source:
```bash
npm run tools:fetch      # downloads, verifies SHA-256 and unpacks into src-tauri/resources/
```
Without this step, Backup & Restore uses whatever client tools are installed on your machine.

---

## Checks before committing

```bash
npm run check            # svelte-check + tsc — must report 0 errors / 0 warnings
npx vitest run           # frontend unit tests
npx playwright test      # UI tests (starts Vite automatically)
npm run tokens:check     # rejects hard-coded colors and spacing in components
```

Rust tests:
```bash
cd src-tauri
cargo test --lib                                   # unit tests (no database needed)
cargo test --test drivers_integration <test_name>  # integration tests — needs Docker
```
Integration tests use **testcontainers** to run real databases in Docker. Cassandra, SQL Server and ClickHouse containers are slow to start (1–3 minutes). Oracle tests need the Oracle Instant Client.

---

## Project layout

```
src/                      Svelte 5 frontend
  lib/ipc.ts              Single entry point to the backend (real Tauri, or demo in a browser)
  lib/demo.ts             Mock backend for the browser and the tests
  lib/stores/             State (runes): connections, tabs, results, explorer, ui…
  lib/components/         UI: explorer, workspaces, dialogs, grid…
  lib/sql/                Pure logic: statement splitting, DDL generation, autocomplete…
src-tauri/                Rust backend
  src/drivers/            One module per engine, unified in the LiveConnection enum (mod.rs)
  src/commands/           #[tauri::command] handlers (must be registered in lib.rs)
  src/connections/        Connection registry, SSH tunnels, query cancellation, keepalive
  src/storage/            Internal SQLite: connection profiles (passwords AES-256-GCM encrypted), tabs, history
  tests/                  Integration tests against real databases
tests/visual/             Playwright end-to-end tests
tools/fetch-dump-tools/   Build-time fetcher for the bundled client tools
spec/                     UI design prototype (the source of truth for the UI)
```

A few conventions that matter:
- **A new backend command** must be registered in `invoke_handler!` (`src-tauri/src/lib.rs`) **and** get a matching case in `src/lib/demo.ts`, or the browser-based tests break.
- **A new engine** needs a module in `drivers/`, a `LiveConnection` variant, and an arm in every `match` in `drivers/mod.rs`.
- **UI colors and spacing** come from tokens (`src/lib/tokens.css`, `src/lib/theme.css`). Do not hard-code hex values in components.

More detail: [CLAUDE.md](CLAUDE.md) (architecture and a log of past changes, mostly in Vietnamese), the `SPEC-*.md` files (one per feature), and [SPEC-INDEX.md](SPEC-INDEX.md).

---

## Releasing

```bash
npm run beta:bump                      # bumps the beta number in package.json and tauri.conf.json
git commit -am "chore: bump v0.1.0-beta.N"
git tag v0.1.0-beta.N && git push --follow-tags
```
Pushing a `v*` tag runs [build-beta.yml](.github/workflows/build-beta.yml). It builds for Windows, Ubuntu and macOS, creates a GitHub Release, signs the update artifacts and generates the `latest.json` manifest used by auto-update. The repository needs the **`TAURI_SIGNING_PRIVATE_KEY`** secret; without it the build fails.
