# SPEC — Backup & Restore (per-engine)

> Tài liệu cho DEV MỞ RỘNG, bám **code thật** (kèm `file:line`). Backup/Restore trước đây chỉ được mô tả
> rải rác (SPEC_v2 §6.3 = trạng thái prototype; T22 trong `CLAUDE.md`). Đây là spec chính thức. Cập nhật 2026-07-22.

## 1. Mục đích & phạm vi

Sao lưu một database ra file và khôi phục lại. **Hai đường hoàn toàn khác nhau:**
- **SQLite** → **in-process** qua rusqlite backup API (không cần công cụ ngoài, round-trip đảm bảo).
- **Postgres / MySQL / MariaDB / ClickHouse / MongoDB** → **shell ra công cụ ngoài** (`pg_dump`, `mysqldump`,
  `clickhouse-client`, `mongodump` + client tương ứng khi restore). Cần binary trên `PATH`.
- **MSSQL** → **native T-SQL** `BACKUP DATABASE … TO DISK` / `RESTORE … FROM DISK` chạy qua **chính connection
  app** (tiberius, không cần binary). File `.bak` nằm trên **server**.
- **Oracle** → **Data Pump** `expdp`/`impdp` (external tools) + `CREATE OR REPLACE DIRECTORY`; dump nằm trong
  DIRECTORY object **server-side**. Password truyền qua **STDIN** (không argv).
- **Redis / Kafka / NATS / Cassandra** → **CHƯA hỗ trợ**.

Backup **toàn database** (không chọn subset table). Không nén/gzip. Không progress streaming (chạy tới xong).

## 2. Kiến trúc & ranh giới module

| Tầng | File | Trách nhiệm |
|---|---|---|
| **Builder thuần** | `src-tauri/src/drivers/backup.rs` | Map `system` → tên tool + dựng `(program, args[, stdin])`. **Không I/O**, unit-test. |
| **Orchestration** | `src-tauri/src/commands/backup.rs` | Lấy profile, giải mã password, chạy tool (hoặc rusqlite cho SQLite), kiểm tra binary, trả kết quả/lỗi. |
| **SQLite in-process** | `src-tauri/src/drivers/sqlite.rs` | `backup_to`/`restore_from` qua rusqlite backup API. |
| **Frontend** | `src/lib/components/BackupDialog.svelte` + `src/lib/stores/backup.svelte.ts` | Dialog: tình trạng tool, tên file, Run Backup + history in-memory, Restore (confirm). |
| **IPC** | `src/lib/ipc.ts:580-585` | `backupToolStatus`, `backupDatabase`, `restoreDatabase`. |

3 command đăng ký ở `src-tauri/src/lib.rs:175-177`.

## 3. Luồng xử lý (theo code)

### 3.1 `backup_database(conn_id, dest)` — `commands/backup.rs:70`
1. Lấy `profile` từ storage → `system`.
2. **SQLite** (`:82`): `with_driver` → `SqliteDriver::backup_to(dest)` (`sqlite.rs:95`, `c.backup(Main, dest)`).
3. **Khác**: `backup_tool(system)` (`backup.rs:6`) → nếu `None` → lỗi "Backup is not supported for {system}".
4. `tool_available(tool)` (`:35`, chạy `<tool> --version`) → nếu thiếu → lỗi "`{tool}` not found on PATH…".
5. `external_backup_cmd(system, target, dest)` (`backup.rs:25`) → `(prog, args)`.
6. Password: `crypto::decrypt(profile.password_enc)`; truyền qua **env** `PGPASSWORD`/`MYSQL_PWD` (`:128-129`).
   MongoDB: ghi password vào temp `--config` YAML (`mongo_pw_config:24`) rồi **xóa ngay sau khi tool chạy xong**
   (mongodump không có env password).
7. `tokio::process::Command` chạy; `status.success()==false` → lỗi kèm `stderr`.

### 3.2 `restore_database(conn_id, src)` — `commands/backup.rs:145`
- **SQLite** (`:156`): `SqliteDriver::restore_from(src)` (`sqlite.rs:104`, rusqlite `restore(Main, src)`).
- **MongoDB** (`:172`): `mongorestore --archive=src` (`mongo_restore_cmd:140`), password qua temp config.
- **PG/MySQL/MariaDB/ClickHouse** (`:214`): `external_restore_cmd` (`backup.rs:94`) → `(prog, args, stdin_file?)`.
  `psql -f src` (PG, `stdin_file=None`); `mysql < src` (MySQL đọc dump qua **STDIN**, `stdin_file=Some(src)`);
  `clickhouse-client --query "RESTORE DATABASE … FROM Disk('backups', src)"`.
- **Khác** → lỗi "Automatic restore is not supported for {system} — open the .sql file in the SQL editor to run it."

### 3.3 `backup_tool_status(conn_id)` — `commands/backup.rs:50`
Trả `{ tool: Option<String>, available: bool }`. SQLite → `("(in-process)", true)`. Khác → `backup_tool` +
`tool_available`. Frontend dùng để cảnh báo "thiếu binary" trước khi chạy.

## 4. Hợp đồng dữ liệu (bảng công cụ per-engine)

| system | backup tool | backup cmd | restore tool | restore cmd | password |
|---|---|---|---|---|---|
| postgres | `pg_dump` | `-f dest` (plain SQL) | `psql` | `-f src` + `ON_ERROR_STOP=1` | env `PGPASSWORD` |
| mysql/mariadb | `mysqldump` | `--result-file=dest` | `mysql` | dump qua **STDIN** | env `MYSQL_PWD` |
| clickhouse | `clickhouse-client` | `BACKUP DATABASE … TO Disk('backups', dest)` | `clickhouse-client` | `RESTORE … FROM Disk('backups', src)` | (chưa truyền) |
| mongodb | `mongodump` | `--archive=dest` | `mongorestore` | `--archive=src` | temp `--config` YAML (xóa sau) |
| sqlite | in-process | rusqlite `backup_to` | in-process | rusqlite `restore_from` | — |
| **mssql** | in-process (qua connection) | `BACKUP DATABASE [db] TO DISK = N'dest'` (`mssql_backup_sql`) | in-process | `RESTORE DATABASE [db] FROM DISK = N'src' WITH REPLACE` (`mssql_restore_sql`) | qua connection (không argv) |
| **oracle** | `expdp` (Data Pump) | `oracle_expdp_cmd` + `CREATE OR REPLACE DIRECTORY` | `impdp` | `oracle_impdp_cmd` (`TABLE_EXISTS_ACTION=REPLACE`) | STDIN |
| redis/kafka/nats/cassandra | — | **không hỗ trợ** | — | **không hỗ trợ** | — |

`BackupTarget { host, port, database, user }` (`backup.rs:16`).

## 5. Bất biến & giả định

- **Password KHÔNG BAO GIỜ nằm trong argv** — env (PG/MySQL) hoặc temp config file bị xóa ngay (Mongo). Unit
  test khẳng định điều này (`backup.rs:212,225` `assert!(!args...contains("password"))`).
- **SQLite luôn round-trip an toàn** (in-process, không phụ thuộc binary ngoài).
- **`dest`/`src` là đường dẫn file trên máy chạy BACKEND** — ⚠️ **NGOẠI LỆ ClickHouse**: `BACKUP … TO
  Disk('backups', …)` chạy trên **ClickHouse SERVER**, `dest` là tên file trong disk `backups` cấu hình
  server-side, KHÔNG phải file cục bộ. Đây là điểm bất đối xứng dễ hiểu nhầm.
- Backup **toàn database** — command chỉ nhận `(conn_id, dest)`, không có tham số chọn table/scope.

## 6. Quy ước phải theo

- Builder ở `backup.rs` phải **thuần** (không I/O) → unit-test. Orchestration (chạy process, đọc profile,
  giải mã password) ở `commands/backup.rs`.
- Kiểm `tool_available` TRƯỚC khi chạy; thiếu binary → lỗi rõ ("install the tool and try again").
- Thêm engine → thêm cả unit test (shape command, no-password-in-args) + integration test round-trip.

## 7. Cạm bẫy đã biết (gotchas)

- **ClickHouse dest = server-side disk**, không phải file cục bộ (xem §5). Restore đối xứng cũng đọc từ disk server.
- **MySQL restore đọc dump qua STDIN** (không phải `-f`); code mở file và set `cmd.stdin(File)` (`:238-241`).
- **MongoDB password**: không có env var → temp `--config` YAML (`mongo_pw_config`), xóa ngay sau chạy
  (`commands/backup.rs:132-134, 200-202`). Đừng đưa password vào argv.
- **Backup history KHÔNG persist** — `backupWizard.record` chỉ giữ in-memory trong store frontend
  (`stores/backup.svelte.ts`), mất khi đóng app.
- **MSSQL RESTORE cần DB không bận**: `RESTORE DATABASE [db]` chạy qua connection app; nếu connection đang ở
  chính DB đích sẽ lỗi "database in use". Cách đúng: connect tới `master` (profile database rỗng) rồi restore
  DB đích (integration test làm vậy). `.bak` là đường dẫn **trên server**.
- **Oracle Data Pump**: cần quyền `CREATE ANY DIRECTORY` + OS path tồn tại/ghi được **trên DB server** + binary
  `expdp`/`impdp` (Instant Client **Tools**, TÁCH khỏi ODPI-C runtime — có thể thiếu dù driver chạy). Password qua STDIN.

## 8. Giới hạn hiện tại & TODO

- **Đã hỗ trợ**: SQLite (in-process), PG/MySQL/MariaDB/ClickHouse/MongoDB (tool ngoài), **MSSQL** (native
  T-SQL qua connection), **Oracle** (Data Pump expdp/impdp).
- **Chưa hỗ trợ**: Redis (`--rdb`/`BGSAVE`), Cassandra (`nodetool snapshot`), Kafka/NATS (N/A).
- Không có: chọn subset table, nén gzip, progress bar/streaming (chạy blocking tới xong), lịch sử persist,
  lịch backup định kỳ (scheduler).
- ClickHouse/Mongo cần binary + (CH) cấu hình disk `backups` server-side. Oracle cần Instant Client **Tools**
  (expdp/impdp) — có thể thiếu dù ODPI-C runtime có (integration Oracle `#[ignore]`).

## 9. Cách chạy & test cục bộ

**Unit (thuần, không cần DB/binary)** — builder command:
```
cargo test --lib backup::            # hoặc: cargo test --lib drivers::backup::tests
```
Phủ: `tool_per_system`, `restore_cmd_shape_per_engine`, `mongodump_cmd_shape`, `pg_dump_cmd_has_db_and_dest_no_password`,
`mysqldump_cmd_shape`, `sqlite_has_no_external_cmd`, **`mssql_native_sql_shape`**, **`oracle_datapump_shape`**
(`drivers/backup.rs` tests). Ngoài ra `drivers::mssql::tests::raw_batch_covers_ddl_and_permissions` bao BACKUP/RESTORE.

**Integration container thật** (`tests/drivers_integration.rs` + `tests/oracle_o0.rs`):
- `sqlite_backup_restore_roundtrip` — round-trip in-process đảm bảo.
- `pg_pg_dump_if_binary_present` — chạy `pg_dump` nếu binary có trên host, else SKIP + note.
- `mssql_native_backup_restore_roundtrip` — connect master, CREATE DATABASE bkptest, BACKUP → mutate →
  RESTORE WITH REPLACE → verify count. **Compile OK; chưa RUN** (cần Docker).
- `o_datapump_backup_restore_roundtrip` (`oracle_o0.rs`, **`#[ignore]`**) — CREATE DIRECTORY + expdp → impdp
  REPLACE → verify. **Compile OK; chưa RUN** (cần Oracle + Instant Client Tools).

**Frontend (demo):** `BackupDialog.svelte` + `backupWizard` store; mở từ nút "Backup" trong Explorer toolbar.
`backup_*` command có case trong `demo.ts` để Vitest/Playwright chạy đường UI.

## 10. Điểm mở rộng — 2 khuôn precedent + ví dụ thêm engine mới

**Có 3 khuôn** trong code, chọn theo cơ chế native của engine:
- **In-process** (SQLite): method trên driver (`backup_to`/`restore_from`), nhánh riêng trong command.
- **SQL qua chính connection app** (MSSQL): builder trả **chuỗi SQL** (`mssql_backup_sql`/`mssql_restore_sql`),
  nhánh command chạy qua `registry.exec_statement`. Nếu là MSSQL: nhớ thêm keyword vào `is_raw_batch`
  (`drivers/mssql.rs`) để câu chạy qua raw batch. `backup_tool` trả `None` (không binary); `backup_tool_status`
  special-case trả available=true.
- **External tool** (PG/MySQL/CH/Mongo/Oracle): `backup_tool`/`restore_tool` trả tên binary; builder trả
  `(prog, args)` (+ stdin nếu cần). Password KHÔNG vào argv — env (PG/MySQL) / temp config (Mongo) / STDIN (Oracle).

**Ví dụ thêm Redis** (`--rdb`/`BGSAVE`): `backup_tool("redis") => Some("redis-cli")`; `external_backup_cmd`
nhánh redis dựng `redis-cli -h host -p port --rdb dest`; restore = nạp file RDB (thường thay file + restart —
document giới hạn). Thêm unit test shape + no-password-in-args + integration container. Frontend không cần đổi
(dialog + ipc + `backup_tool_status` dùng chung).

Tham chiếu code thật để bắt chước: **MSSQL** = khuôn "SQL qua connection" (`commands/backup.rs` nhánh
`system == "mssql"`); **Oracle** = khuôn "external tool + STDIN password + CREATE DIRECTORY"
(`commands/backup.rs` nhánh `system == "oracle"` + `run_datapump`).
