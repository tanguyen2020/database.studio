//! Backup & Restore — pure helpers (no I/O except the explicit directory scan in
//! `search_dirs`), shared by `commands/backup.rs`. Everything here is unit-tested.
//!
//! What lives here:
//! * `BackupOptions` — the options the dialog sends (all optional, so an older
//!   caller that sends nothing gets the previous behaviour).
//! * argv builders for every external client tool (pg_dump / pg_restore / psql,
//!   mysqldump / mariadb-dump / mysql, mongodump / mongorestore). Passwords never
//!   go into argv: PGPASSWORD / MYSQL_PWD env, or a temp `--config` file (Mongo).
//! * tool discovery — PATH plus the folders the vendors' installers actually use
//!   (a pg_dump that came with PostgreSQL or pgAdmin is almost never on PATH on
//!   Windows; that was the #1 reason Backup "did not work").
//! * version parsing (pg_dump refuses to dump a newer server).
//! * human explanations for the tools' raw stderr.
//! * the native statements for MSSQL / ClickHouse.
//! * the built-in dump formats for Cassandra (CQL script) and Redis (DUMP/RESTORE
//!   lines), which need no client tool at all.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::drivers::backup::BackupTarget;

/// Options the Backup & Restore dialog sends. Every field is optional.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupOptions {
    /// Database to back up / restore into (overrides the profile's database).
    pub database: Option<String>,
    /// PostgreSQL: `plain` (SQL script) | `custom` (pg_restore archive).
    /// MongoDB: `archive` | `gzip`.
    pub format: Option<String>,
    /// `all` | `schema` | `data` (PostgreSQL, MySQL, MariaDB).
    pub content: Option<String>,
    /// Backup: emit DROP before CREATE. Restore: drop existing objects first.
    pub clean: Option<bool>,
    /// PostgreSQL: keep ownership + privileges (default true).
    pub owner: Option<bool>,
    /// SQL Server: COPY_ONLY (does not break the log-backup chain). Default true.
    pub copy_only: Option<bool>,
    /// SQL Server: WITH COMPRESSION (not available on Express).
    pub compression: Option<bool>,
    /// ClickHouse: backup disk name (`backups.allowed_disk`).
    pub disk: Option<String>,
    /// Folder that holds the client tools, picked by the user ("Locate…").
    pub tool_dir: Option<String>,
    /// Id used to cancel a running job.
    pub job_id: Option<String>,
    /// Restore in a single transaction (psql -1 / pg_restore -1).
    pub single_transaction: Option<bool>,
    /// ClickHouse: restore under another database name.
    pub as_database: Option<String>,
}

impl BackupOptions {
    pub fn content(&self) -> &str {
        match self.content.as_deref() {
            Some("schema") => "schema",
            Some("data") => "data",
            _ => "all",
        }
    }
    pub fn pg_custom(&self) -> bool {
        matches!(self.format.as_deref(), Some("custom"))
    }
    pub fn mongo_gzip(&self) -> bool {
        matches!(self.format.as_deref(), Some("gzip"))
    }
}

// ---------------------------------------------------------------------------
// argv builders
// ---------------------------------------------------------------------------

/// `pg_dump` — `-w` never prompts (a missing password must fail, not hang the
/// hidden child process forever).
pub fn pg_dump_args(t: &BackupTarget, dest: &str, o: &BackupOptions) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-h".into(), t.host.clone(),
        "-p".into(), t.port.to_string(),
        "-U".into(), t.user.clone(),
        "-d".into(), t.database.clone(),
        "-w".into(),
        "--encoding=UTF8".into(),
        "-F".into(), if o.pg_custom() { "c".into() } else { "p".into() },
    ];
    match o.content() {
        "schema" => a.push("-s".into()),
        "data" => a.push("-a".into()),
        _ => {}
    }
    if o.clean.unwrap_or(false) && o.content() != "data" {
        a.push("--clean".into());
        a.push("--if-exists".into());
    }
    if o.owner == Some(false) {
        a.push("-O".into());
        a.push("-x".into());
    }
    a.push("-f".into());
    a.push(dest.into());
    a
}

/// `psql` restoring a plain SQL dump: quiet, no psqlrc, stop at the first error.
pub fn psql_restore_args(t: &BackupTarget, src: &str, o: &BackupOptions) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-h".into(), t.host.clone(),
        "-p".into(), t.port.to_string(),
        "-U".into(), t.user.clone(),
        "-d".into(), t.database.clone(),
        "-w".into(), "-X".into(), "-q".into(),
        "-v".into(), "ON_ERROR_STOP=1".into(),
    ];
    if o.single_transaction.unwrap_or(false) {
        a.push("-1".into());
    }
    a.push("-f".into());
    a.push(src.into());
    a
}

/// `pg_restore` for a custom-format archive (`PGDMP` magic).
pub fn pg_restore_args(t: &BackupTarget, src: &str, o: &BackupOptions) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-h".into(), t.host.clone(),
        "-p".into(), t.port.to_string(),
        "-U".into(), t.user.clone(),
        "-d".into(), t.database.clone(),
        "-w".into(),
    ];
    if o.clean.unwrap_or(false) {
        a.push("--clean".into());
        a.push("--if-exists".into());
    }
    if o.single_transaction.unwrap_or(false) {
        a.push("-1".into());
    }
    if o.owner == Some(false) {
        a.push("-O".into());
        a.push("-x".into());
    }
    a.push(src.into());
    a
}

/// `pg_restore` turning a custom archive into an SQL script (no server involved),
/// with the same clean / ownership choices. Used when a 17+ pg_restore targets an
/// older server: the script's header is then fixed and psql applies it.
pub fn pg_restore_to_script_args(src: &str, script: &str, o: &BackupOptions) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if o.clean.unwrap_or(false) {
        a.push("--clean".into());
        a.push("--if-exists".into());
    }
    if o.owner == Some(false) {
        a.push("-O".into());
        a.push("-x".into());
    }
    a.push("-f".into());
    a.push(script.into());
    a.push(src.into());
    a
}

/// The client tool flavour, read from its `--version` line. MySQL's and
/// MariaDB's dump tools accept different flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MyFlavor {
    Mysql,
    Mariadb,
    Unknown,
}

pub fn my_flavor(version_line: &str) -> MyFlavor {
    let l = version_line.to_ascii_lowercase();
    if l.contains("mariadb") {
        MyFlavor::Mariadb
    } else if l.contains("mysql") || l.contains(" ver ") || l.starts_with("mysqldump") {
        MyFlavor::Mysql
    } else {
        MyFlavor::Unknown
    }
}

/// `mysqldump` / `mariadb-dump`. `--protocol=TCP` so "localhost" does not try a
/// named pipe / socket; `--single-transaction` for a consistent InnoDB snapshot
/// without locking; routines + triggers so the dump is complete.
pub fn mysqldump_args(
    system: &str,
    t: &BackupTarget,
    dest: &str,
    o: &BackupOptions,
    tool: MyFlavor,
) -> Vec<String> {
    let mut a: Vec<String> = vec![
        format!("--host={}", t.host),
        format!("--port={}", t.port),
        format!("--user={}", t.user),
        "--protocol=TCP".into(),
        "--default-character-set=utf8mb4".into(),
        "--single-transaction".into(),
        "--routines".into(),
        "--triggers".into(),
        "--hex-blob".into(),
    ];
    match o.content() {
        "schema" => a.push("--no-data".into()),
        "data" => {
            a.push("--no-create-info".into());
            a.push("--skip-triggers".into());
            // `--routines` would still dump CREATE PROCEDURE — data only means data.
            a.retain(|x| x != "--routines" && x != "--triggers");
        }
        _ => {}
    }
    if o.clean == Some(false) {
        a.push("--skip-add-drop-table".into());
    }
    if tool == MyFlavor::Mysql {
        // GTID_PURGED lines make the dump fail on any other server.
        a.push("--set-gtid-purged=OFF".into());
        // MySQL 8's mysqldump queries COLUMN_STATISTICS, which MariaDB lacks.
        if system == "mariadb" {
            a.push("--column-statistics=0".into());
        }
    }
    a.push(format!("--result-file={dest}"));
    a.push(t.database.clone());
    a
}

/// `mysql` / `mariadb` client restoring a dump read from STDIN.
pub fn mysql_restore_args(t: &BackupTarget) -> Vec<String> {
    vec![
        format!("--host={}", t.host),
        format!("--port={}", t.port),
        format!("--user={}", t.user),
        "--protocol=TCP".into(),
        "--default-character-set=utf8mb4".into(),
        t.database.clone(),
    ]
}

/// `mongodump` — connection (URI incl. credentials) comes from a temp `--config`
/// file, so nothing secret is on argv.
pub fn mongodump_args(config: &str, database: &str, dest: &str, o: &BackupOptions) -> Vec<String> {
    let mut a = vec![format!("--config={config}")];
    if !database.is_empty() {
        a.push(format!("--db={database}"));
    }
    a.push(format!("--archive={dest}"));
    if o.mongo_gzip() {
        a.push("--gzip".into());
    }
    a
}

pub fn mongorestore_args(config: &str, database: &str, src: &str, o: &BackupOptions) -> Vec<String> {
    let mut a = vec![format!("--config={config}"), format!("--archive={src}")];
    if src.ends_with(".gz") || o.mongo_gzip() {
        a.push("--gzip".into());
    }
    if o.clean.unwrap_or(false) {
        a.push("--drop".into());
    }
    if !database.is_empty() {
        a.push(format!("--nsInclude={database}.*"));
    }
    a
}

/// The YAML body of mongodump/mongorestore's `--config` file.
pub fn mongo_config_yaml(uri: &str) -> String {
    // YAML double-quoted scalar: escape backslash and quote.
    let esc = uri.replace('\\', "\\\\").replace('"', "\\\"");
    format!("uri: \"{esc}\"\n")
}

// ---------------------------------------------------------------------------
// native statements (SQL Server, ClickHouse)
// ---------------------------------------------------------------------------

fn mssql_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}
fn mssql_str(s: &str) -> String {
    s.replace('\'', "''")
}

pub fn mssql_backup_sql_opts(database: &str, dest: &str, copy_only: bool, compression: bool) -> String {
    let mut with = vec!["FORMAT", "INIT", "STATS = 10"];
    if copy_only {
        with.insert(0, "COPY_ONLY");
    }
    if compression {
        with.push("COMPRESSION");
    }
    format!(
        "BACKUP DATABASE {} TO DISK = N'{}' WITH {}, NAME = N'Database Studio backup of {}'",
        mssql_ident(database),
        mssql_str(dest),
        with.join(", "),
        mssql_str(database)
    )
}

/// RESTORE run from `master`. Sessions in the target database (the app's own
/// included) would make RESTORE fail with "exclusive access could not be
/// obtained", so the database goes SINGLE_USER first — and back to MULTI_USER
/// whatever happens, so a failed restore never leaves it locked. Starts with
/// `SET` so the driver sends it as one raw batch.
pub fn mssql_restore_batch(database: &str, src: &str) -> String {
    let id = mssql_ident(database);
    let lit = mssql_str(database);
    format!(
        "SET NOCOUNT ON;\n\
         IF DB_ID(N'{lit}') IS NOT NULL ALTER DATABASE {id} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n\
         BEGIN TRY\n\
           RESTORE DATABASE {id} FROM DISK = N'{src}' WITH REPLACE, STATS = 10;\n\
         END TRY\n\
         BEGIN CATCH\n\
           IF DB_ID(N'{lit}') IS NOT NULL ALTER DATABASE {id} SET MULTI_USER;\n\
           THROW;\n\
         END CATCH;\n\
         IF DB_ID(N'{lit}') IS NOT NULL ALTER DATABASE {id} SET MULTI_USER;",
        src = mssql_str(src),
    )
}

// ---- progress, read from the tools' own output -------------------------------------

fn after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    line.find(marker).map(|i| &line[i + marker.len()..])
}

fn unquote(s: &str) -> String {
    s.trim().trim_end_matches("...").trim_end_matches('.').trim().replace('"', "").replace('`', "")
}

/// `pg_dump: dumping contents of table "public.orders"` (pg_dump -v)
pub fn pg_dump_progress(line: &str) -> Option<String> {
    after(line, "dumping contents of table ").map(unquote).filter(|s| !s.is_empty())
}

/// `pg_restore: processing data for table "public.orders"` (pg_restore -v)
pub fn pg_restore_progress(line: &str) -> Option<String> {
    after(line, "processing data for table ").map(unquote).filter(|s| !s.is_empty())
}

/// `pg_restore: finished item 3418 TABLE DATA orders` (pg_restore -v -j N): with
/// parallel jobs a table counts once its data item is finished.
pub fn pg_restore_parallel_progress(line: &str) -> Option<String> {
    let rest = after(line, "finished item ")?;
    let rest = rest.split_once(' ')?.1; // drop the item number
    rest.strip_prefix("TABLE DATA ").map(|t| t.trim().to_string()).filter(|s| !s.is_empty())
}

/// Parallel jobs for pg_restore: half the cores, at most 4 (each job is a server
/// connection and a busy backend). One with "single transaction" — PostgreSQL
/// cannot combine `-1` with `-j`.
pub fn pg_restore_jobs(single_transaction: bool, cores: usize) -> usize {
    if single_transaction {
        1
    } else {
        (cores / 2).clamp(1, 4)
    }
}

/// pg_restore 17+ sends `SET transaction_timeout = 0` on every connection, and a
/// PostgreSQL 16 or older server rejects that one setting (nothing else is
/// affected — the run continues). True only when EVERY error line of the run is
/// that rejection, so any real error still fails the restore.
/// An Oracle error line: `ORA-31684: Object type USER:"APP" already exists`.
pub fn is_ora_error(line: &str) -> bool {
    line.match_indices("ORA-").any(|(i, _)| {
        let d = &line.as_bytes()[i + 4..];
        d.len() >= 5 && d[..5].iter().all(u8::is_ascii_digit)
    })
}

/// impdp exits 5 ("completed with errors") when a schema import into the schema
/// that already exists cannot re-create its USER (ORA-31684). That is the normal
/// case of restoring into your own schema — harmless when it is the only error.
pub fn datapump_only_already_exists(error_lines: &[String]) -> bool {
    let ora: Vec<&String> = error_lines.iter().filter(|l| is_ora_error(l)).collect();
    !ora.is_empty() && ora.iter().all(|l| l.contains("ORA-31684"))
}

pub fn pg_only_transaction_timeout_errors(error_lines: &[String]) -> bool {
    !error_lines.is_empty() && error_lines.iter().all(|l| l.contains("transaction_timeout"))
}

/// `-- Retrieving table structure for table orders...` (mysqldump / mariadb-dump --verbose)
pub fn mysqldump_progress(line: &str) -> Option<String> {
    after(line, "Retrieving table structure for table ").map(unquote).filter(|s| !s.is_empty())
}

/// `…\tdone dumping app.orders (500 documents)` (mongodump)
pub fn mongodump_progress(line: &str) -> Option<String> {
    let rest = after(line, "done dumping ")?;
    Some(rest.split(" (").next().unwrap_or(rest).trim().to_string()).filter(|s| !s.is_empty())
}

/// `…\tfinished restoring ‵app.orders‵ (500 documents, 0 failures)` (mongorestore;
/// the name is in backticks)
pub fn mongorestore_progress(line: &str) -> Option<String> {
    let rest = after(line, "finished restoring ")?;
    Some(unquote(rest.split(" (").next().unwrap_or(rest))).filter(|s| !s.is_empty())
}

/// `…\treading metadata for ‵app.orders‵ from ‵archive on stdin‵`: mongorestore
/// lists every collection of the archive up front, before restoring any — the
/// total a restore goes through.
pub fn mongorestore_announces(line: &str) -> bool {
    line.contains("reading metadata for ")
}

/// `Processing Table '[dbo].[orders]'.` (SqlPackage export / import)
pub fn sqlpackage_progress(line: &str) -> Option<String> {
    let rest = after(line, "Processing Table '")?;
    Some(rest.split('\'').next().unwrap_or(rest).replace(['[', ']'], "")).filter(|s| !s.is_empty())
}

/// `. . exported "APP"."ORDERS"   5.5 KB   2 rows` / `. . imported …` (Data Pump)
pub fn datapump_progress(line: &str) -> Option<String> {
    let rest = after(line, ". . exported ").or_else(|| after(line, ". . imported "))?;
    let name = rest.split_whitespace().next()?;
    Some(name.replace('"', "")).filter(|s| !s.is_empty())
}

/// User tables of the database (the total a dump will go through).
/// What a pg_dump run can be counted by (measured with pg_dump 18 -v):
/// - with data (both formats): one `dumping contents of table` per table that HAS
///   rows of its own — a partitioned parent has none, so only relkind 'r' counts;
/// - structure only, plain SQL: one `creating TABLE "s.t"` per table, parents
///   included (relkind 'r' + 'p'), plus `creating TABLE ATTACH` lines to skip;
/// - structure only, custom archive: no per-table line at all — not measurable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PgDumpCount {
    Data,
    Schema,
    Unmeasured,
}

pub fn pg_dump_count(format: Option<&str>, content: Option<&str>) -> PgDumpCount {
    if content != Some("schema") {
        PgDumpCount::Data
    } else if format == Some("custom") {
        PgDumpCount::Unmeasured
    } else {
        PgDumpCount::Schema
    }
}

/// The total a pg_dump run counts to, matching [`pg_dump_count`].
pub fn pg_table_count_sql(count: PgDumpCount) -> Option<String> {
    let kinds = match count {
        PgDumpCount::Data => "'r'",
        PgDumpCount::Schema => "'r', 'p'",
        PgDumpCount::Unmeasured => return None,
    };
    Some(format!(
        "SELECT count(*) AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace \
         WHERE c.relkind IN ({kinds}) AND s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname NOT LIKE 'pg_toast%' \
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')"
    ))
}

/// Steps pg_dump 18 -v prints for a structure-only custom archive ("reading
/// user-defined tables", "saving encoding" …): 50, whatever the number of tables.
/// They are the only marks such a run gives, so they are what it is counted by;
/// another pg_dump version prints a few more or less — the total settles at the
/// count actually seen when the run ends.
pub const PG_DUMP_CATALOG_STEPS: u64 = 50;

/// One of those steps: `pg_dump: reading user-defined tables` → "reading user-defined tables".
pub fn pg_dump_step(line: &str) -> Option<String> {
    let rest = line.trim().strip_prefix("pg_dump: ")?;
    if rest.starts_with("error:") || rest.starts_with("warning:") || rest.starts_with("detail:") {
        return None;
    }
    Some(rest.trim().to_string()).filter(|s| !s.is_empty())
}

/// `pg_dump: creating TABLE "public.orders"` (pg_dump -v, structure only, plain SQL)
pub fn pg_dump_schema_progress(line: &str) -> Option<String> {
    let rest = after(line, "creating TABLE ")?;
    if rest.starts_with("ATTACH") {
        return None; // `creating TABLE ATTACH "s.part"` — the partition was already counted
    }
    Some(unquote(rest)).filter(|s| !s.is_empty())
}

pub fn table_count_sql(system: &str, database: &str) -> Option<String> {
    let lit = database.replace('\'', "''");
    Some(match system {
        "postgres" => "SELECT count(*) AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace \
                       WHERE c.relkind IN ('r', 'p') AND s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname NOT LIKE 'pg_toast%'"
            .into(),
        "mysql" | "mariadb" => format!("SELECT count(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = '{lit}'"),
        "mssql" => "SELECT count(*) AS n FROM sys.tables WHERE is_ms_shipped = 0".into(),
        "oracle" => "SELECT count(*) AS n FROM user_tables".into(),
        _ => return None,
    })
}

/// SQL Server reports how far a BACKUP / RESTORE is (`percent_complete`).
pub const MSSQL_PROGRESS_SQL: &str = "SELECT TOP 1 CAST(percent_complete AS int) AS p FROM sys.dm_exec_requests \
     WHERE command IN ('BACKUP DATABASE', 'RESTORE DATABASE', 'RESTORE HEADERONLY') ORDER BY percent_complete DESC";

/// SQL Server backup to / restore from THIS computer: a `.bacpac` (schema + data)
/// written / read by SqlPackage. Chosen by the format, or by the file's extension.
pub fn mssql_is_bacpac(format: Option<&str>, path: &str) -> bool {
    format == Some("bacpac") || path.trim().to_ascii_lowercase().ends_with(".bacpac")
}

/// One quoted SqlPackage argument per line for an `@response` file (SqlPackage
/// tokenises it like a command line, so spaces and `;` stay inside the value).
fn rsp_line(arg: &str) -> Result<String, String> {
    if arg.contains('"') || arg.contains('\n') || arg.contains('\r') {
        return Err("A value contains a double quote or a line break, which SqlPackage cannot receive.".into());
    }
    Ok(format!("\"{arg}\"\n"))
}

/// Login part for one side (`Source` / `Target`): SQL login or Windows (integrated).
fn sqlpackage_login(side: &str, t: &BackupTarget, password: &str, auth: &str) -> Result<Vec<String>, String> {
    let mut a = vec![format!("/{side}ServerName:{},{}", t.host, t.port), format!("/{side}TrustServerCertificate:True")];
    match auth {
        "windows" => {} // no user / password: integrated security
        x if x.starts_with("aad") => return Err("SqlPackage export from Database Studio supports SQL Server and Windows logins; for Azure AD use the server-side backup.".into()),
        _ => {
            a.push(format!("/{side}User:{}", t.user));
            a.push(format!("/{side}Password:{password}"));
        }
    }
    Ok(a)
}

/// `@response` file for `sqlpackage /Action:Export` (database → `.bacpac` here).
pub fn sqlpackage_export_rsp(t: &BackupTarget, password: &str, auth: &str, dest: &str) -> Result<String, String> {
    let mut args = vec!["/Action:Export".to_string()];
    args.extend(sqlpackage_login("Source", t, password, auth)?);
    args.push(format!("/SourceDatabaseName:{}", t.database));
    args.push(format!("/TargetFile:{dest}"));
    args.push("/OverwriteFiles:True".into());
    args.iter().map(|a| rsp_line(a)).collect()
}

/// `@response` file for `sqlpackage /Action:Import` (`.bacpac` → a database that
/// does not exist yet, or is empty).
pub fn sqlpackage_import_rsp(t: &BackupTarget, password: &str, auth: &str, src: &str, target_db: &str) -> Result<String, String> {
    let mut args = vec!["/Action:Import".to_string(), format!("/SourceFile:{src}")];
    args.extend(sqlpackage_login("Target", t, password, auth)?);
    args.push(format!("/TargetDatabaseName:{target_db}"));
    args.iter().map(|a| rsp_line(a)).collect()
}

/// Drop a database before importing a `.bacpac` over it (run from master).
pub fn mssql_drop_database_batch(database: &str) -> String {
    let id = mssql_ident(database);
    let lit = mssql_str(database);
    format!(
        "SET NOCOUNT ON;\n\
         IF DB_ID(N'{lit}') IS NOT NULL\n\
         BEGIN\n\
           ALTER DATABASE {id} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n\
           DROP DATABASE {id};\n\
         END"
    )
}

/// Default backup folder of the instance (SQL Server 2019+; NULL before).
pub const MSSQL_DEFAULT_PATH_SQL: &str =
    "SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000)) AS p";

/// Most recent backups of one database recorded in msdb (file path is on the server).
pub fn mssql_recent_backups_sql(database: &str) -> String {
    format!(
        "SELECT TOP 15 m.physical_device_name AS path, \
         CONVERT(varchar(19), b.backup_finish_date, 120) AS finished, \
         CAST(b.backup_size AS bigint) AS size, b.type AS kind \
         FROM msdb.dbo.backupset b JOIN msdb.dbo.backupmediafamily m ON m.media_set_id = b.media_set_id \
         WHERE b.database_name = N'{}' AND m.device_type IN (2, 102) \
         ORDER BY b.backup_finish_date DESC",
        mssql_str(database)
    )
}

fn ch_ident(name: &str) -> String {
    format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`"))
}
fn ch_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

pub fn clickhouse_backup_sql(database: &str, disk: &str, file: &str) -> String {
    format!(
        "BACKUP DATABASE {} TO Disk('{}', '{}')",
        ch_ident(database),
        ch_str(disk),
        ch_str(file)
    )
}

pub fn clickhouse_restore_sql(database: &str, as_database: Option<&str>, disk: &str, file: &str) -> String {
    let as_part = match as_database.filter(|a| !a.is_empty() && *a != database) {
        Some(a) => format!(" AS {}", ch_ident(a)),
        None => String::new(),
    };
    format!(
        "RESTORE DATABASE {}{} FROM Disk('{}', '{}')",
        ch_ident(database),
        as_part,
        ch_str(disk),
        ch_str(file)
    )
}

pub fn clickhouse_drop_sql(database: &str) -> String {
    format!("DROP DATABASE IF EXISTS {} SYNC", ch_ident(database))
}

/// File name a ClickHouse backup disk accepts: the server stores it under the
/// disk's own path, so a client-side folder makes no sense here.
pub fn clickhouse_file_name(input: &str) -> String {
    let base = input.rsplit(['/', '\\']).next().unwrap_or(input).trim();
    if base.is_empty() {
        "backup.zip".into()
    } else {
        base.to_string()
    }
}

// ---------------------------------------------------------------------------
// tool discovery
// ---------------------------------------------------------------------------

pub fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Folder patterns vendors install client tools into. `*` = any child folder.
/// Version folders are tried newest first.
pub fn install_patterns() -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    if cfg!(windows) {
        let mut roots: Vec<String> = Vec::new();
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Ok(p) = std::env::var(var) {
                if !roots.contains(&p) {
                    roots.push(p);
                }
            }
        }
        if roots.is_empty() {
            roots.push("C:\\Program Files".into());
        }
        for r in &roots {
            for p in [
                "PostgreSQL\\*\\bin",
                "pgAdmin 4\\runtime",
                "pgAdmin 4\\*\\runtime",
                "MySQL\\MySQL Server *\\bin",
                "MySQL\\MySQL Workbench *",
                "MariaDB *\\bin",
                "MongoDB\\Tools\\*\\bin",
                "MongoDB\\Server\\*\\bin",
            ] {
                v.push(format!("{r}\\{p}"));
            }
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            v.push(format!("{local}\\Programs\\pgAdmin 4\\runtime"));
            v.push(format!("{local}\\Programs\\pgAdmin 4\\*\\runtime"));
        }
        for p in [
            "C:\\xampp\\mysql\\bin",
            "C:\\laragon\\bin\\mysql\\*\\bin",
            "C:\\wamp64\\bin\\mysql\\*\\bin",
            "C:\\oracle\\instantclient_*",
            "C:\\tools\\postgresql\\*\\bin",
        ] {
            v.push(p.into());
        }
    } else if cfg!(target_os = "macos") {
        for p in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/homebrew/opt/libpq/bin",
            "/usr/local/opt/libpq/bin",
            "/opt/homebrew/opt/postgresql@*/bin",
            "/usr/local/opt/postgresql@*/bin",
            "/opt/homebrew/opt/mysql-client/bin",
            "/usr/local/opt/mysql-client/bin",
            "/opt/homebrew/opt/mysql-client@*/bin",
            "/Applications/Postgres.app/Contents/Versions/*/bin",
            "/Applications/pgAdmin 4.app/Contents/SharedSupport",
            "/usr/local/mysql/bin",
        ] {
            v.push(p.into());
        }
    } else {
        for p in ["/usr/bin", "/usr/local/bin", "/usr/lib/postgresql/*/bin", "/usr/pgsql-*/bin", "/opt/mssql-tools*/bin"] {
            v.push(p.into());
        }
    }
    v
}

/// Numeric key for "newest first" ordering of version folders (`16`, `9.6`,
/// `MySQL Server 8.0`, `postgresql@15`, `100`, `instantclient_23_0`).
pub fn version_key(name: &str) -> Vec<u64> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in name.chars() {
        if ch.is_ascii_digit() {
            cur.push(ch);
        } else if !cur.is_empty() {
            out.push(cur.parse().unwrap_or(0));
            cur.clear();
        }
    }
    if !cur.is_empty() {
        out.push(cur.parse().unwrap_or(0));
    }
    out
}

/// Expand one pattern into existing folders. Each `*` segment matches child
/// folders whose name matches the segment (`*`, `MySQL Server *`, `postgresql@*`).
pub fn expand_pattern(pattern: &str) -> Vec<PathBuf> {
    let sep = if cfg!(windows) { '\\' } else { '/' };
    let parts: Vec<&str> = pattern.split(sep).collect();
    let mut acc: Vec<PathBuf> = vec![if pattern.starts_with(sep) { PathBuf::from(sep.to_string()) } else { PathBuf::new() }];
    for part in parts {
        if part.is_empty() {
            continue;
        }
        let mut next: Vec<PathBuf> = Vec::new();
        for base in &acc {
            if part.contains('*') {
                let (pre, post) = part.split_once('*').unwrap_or((part, ""));
                let Ok(rd) = std::fs::read_dir(if base.as_os_str().is_empty() { Path::new(".") } else { base }) else {
                    continue;
                };
                let mut names: Vec<String> = rd
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|n| {
                        n.to_ascii_lowercase().starts_with(&pre.to_ascii_lowercase())
                            && n.to_ascii_lowercase().ends_with(&post.to_ascii_lowercase())
                            && n.len() >= pre.len() + post.len()
                    })
                    .collect();
                names.sort_by(|a, b| version_key(b).cmp(&version_key(a)).then(a.cmp(b)));
                for n in names {
                    next.push(base.join(n));
                }
            } else if base.as_os_str().is_empty() {
                // `C:` alone is drive-RELATIVE on Windows; the root needs its separator.
                if part.ends_with(':') {
                    next.push(PathBuf::from(format!("{part}{sep}")));
                } else {
                    next.push(PathBuf::from(part));
                }
            } else {
                next.push(base.join(part));
            }
        }
        acc = next;
    }
    acc.into_iter().filter(|p| p.is_dir()).collect()
}

/// Every existing copy of one of `names`: the user's folder first, then PATH,
/// then the vendor install folders. De-duplicated, order kept.
pub fn find_tool_candidates(names: &[&str], tool_dir: Option<&str>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = tool_dir.map(str::trim).filter(|d| !d.is_empty()) {
        let p = PathBuf::from(d);
        // The user may have picked the executable itself.
        if p.is_file() {
            if let Some(parent) = p.parent() {
                dirs.push(parent.to_path_buf());
            }
        } else {
            dirs.push(p);
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    for pat in install_patterns() {
        dirs.extend(expand_pattern(&pat));
    }
    // last: the copies shipped inside the installer (an installed client the
    // user chose keeps priority; pg_dump still picks the newest major of all)
    dirs.extend(crate::drivers::bundled_tools::bundled_bin_dirs());
    let mut out: Vec<PathBuf> = Vec::new();
    for d in dirs {
        for n in names {
            let f = d.join(exe_name(n));
            if f.is_file() && !out.iter().any(|o| o == &f) {
                out.push(f);
            }
        }
    }
    out
}

/// Major/minor from a tool's `--version` output:
/// `pg_dump (PostgreSQL) 16.4`, `mysqldump  Ver 8.0.36 for Win64`,
/// `mariadb-dump from 11.4.2-MariaDB`, `mongodump version: 100.9.4`,
/// `Export: Release 23.0.0.0.0`.
pub fn parse_version(out: &str) -> Option<(u64, u64)> {
    let line = out.lines().find(|l| l.chars().any(|c| c.is_ascii_digit()))?;
    // Prefer the number after a known marker; fall back to the first x.y.
    let lower = line.to_ascii_lowercase();
    let start = ["(postgresql) ", " ver ", " from ", "version: ", "version ", "release "]
        .iter()
        .filter_map(|m| lower.find(m).map(|i| i + m.len()))
        .min()
        .unwrap_or(0);
    let tail = &line[start..];
    let mut nums = tail
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .find(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit()))?
        .split('.');
    let major: u64 = nums.next()?.parse().ok()?;
    let minor: u64 = nums.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// pg_dump 17+ writes `SET transaction_timeout = 0;` into the header of a plain
/// SQL dump; servers before 17 reject it ("unrecognized configuration parameter")
/// and psql stops the restore there. For such a server the line is turned into a
/// comment of the SAME length, so the file can be patched in place.
/// Returns (offset, replacement) when `head` (the first KBs) needs it.
pub fn pg_plain_header_fix(head: &[u8], server_major: u64) -> Option<(usize, Vec<u8>)> {
    const LINE: &[u8] = b"SET transaction_timeout = 0;";
    if server_major >= 17 {
        return None;
    }
    let at = head.windows(LINE.len()).position(|w| w == LINE)?;
    // only in the header (SETs before the first object), and at a line start
    if at > 0 && head[at - 1] != b'\n' {
        return None;
    }
    // same byte length as LINE (28), so the rest of the file does not move
    const REP: &[u8] = b"-- transaction_timeout=0 17+";
    debug_assert_eq!(REP.len(), LINE.len());
    Some((at, REP.to_vec()))
}

/// `server_version_num` (e.g. 160004) / `server_version` ("16.4 (Debian…)") → major.
pub fn pg_server_major(v: &str) -> Option<u64> {
    let t = v.trim();
    if let Ok(n) = t.parse::<u64>() {
        // server_version_num: 160004 = 16.4, 90624 = 9.6.24 → major = n / 10000.
        return Some(if n >= 10_000 { n / 10_000 } else { n });
    }
    parse_version(&format!("version {t}")).map(|(m, _)| m)
}

/// Is `path` a PostgreSQL custom-format archive (pg_restore) rather than SQL?
pub fn is_pg_archive(head: &[u8]) -> bool {
    head.starts_with(b"PGDMP")
}

/// Plain-language reason for the raw stderr of a client tool.
pub fn explain_tool_error(system: &str, stderr: &str) -> Option<String> {
    let s = stderr.to_ascii_lowercase();
    let hint = if s.contains("server version mismatch") || s.contains("aborting because of server version") {
        "This pg_dump is older than the server. pg_dump must be the same major version as the server or newer — install a newer PostgreSQL client and pick its folder with \"Locate…\"."
    } else if s.contains("password authentication failed")
        || s.contains("no password supplied")
        || s.contains("access denied for user")
        || s.contains("authentication failed")
    {
        "The server rejected the saved user name or password. Edit the connection, check the credentials, then try again."
    } else if s.contains("column_statistics") {
        "This mysqldump is from MySQL 8 and the server is MariaDB. Install the MariaDB client (mariadb-dump) or pick its folder with \"Locate…\"."
    } else if s.contains("could not connect")
        || s.contains("can't connect")
        || s.contains("connection refused")
        || s.contains("timeout expired")
        || s.contains("server selection error")
    {
        "The tool could not reach the server. It connects directly from this computer (through the SSH tunnel when the connection uses one) — make sure the connection is open."
    } else if s.contains("permission denied") || s.contains("access denied;") || s.contains("insufficient privileges") || s.contains("not authorized") {
        "The user lacks a privilege the tool needs (for example SELECT on every table, or SHOW VIEW / TRIGGER / routine privileges). Use a user with backup privileges."
    } else if s.contains("does not exist") && system == "postgres" {
        "The database or a role referenced by the backup does not exist on this server. Create it first, or back up with \"Include ownership & privileges\" turned off."
    } else if s.contains("unknown database") {
        "That database does not exist on this server. Create it (empty) first, then restore into it."
    } else if s.contains("no space left") || s.contains("disk full") {
        "The destination disk is full."
    } else {
        return None;
    };
    Some(hint.to_string())
}

/// Last `max` bytes of a tool's output, on a line boundary — enough to show the
/// error without dumping megabytes of progress lines into the UI.
pub fn tail(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.len() <= max {
        return t.to_string();
    }
    let mut cut = t.len() - max;
    while !t.is_char_boundary(cut) {
        cut += 1;
    }
    let rest = &t[cut..];
    match rest.find('\n') {
        Some(i) => format!("…\n{}", &rest[i + 1..]),
        None => format!("…{rest}"),
    }
}

// ---------------------------------------------------------------------------
// Cassandra built-in CQL dump
// ---------------------------------------------------------------------------

pub const CQL_DUMP_HEADER: &str = "-- Database Studio · Cassandra keyspace backup";

/// Make a CREATE statement re-runnable on a keyspace that already has it.
pub fn cql_idempotent(ddl: &str) -> String {
    let t = ddl.trim_start();
    let upper = t.to_ascii_uppercase();
    for kw in [
        "CREATE MATERIALIZED VIEW ",
        "CREATE CUSTOM INDEX ",
        "CREATE INDEX ",
        "CREATE TABLE ",
        "CREATE TYPE ",
        "CREATE KEYSPACE ",
    ] {
        if upper.starts_with(kw) {
            if upper[kw.len()..].starts_with("IF NOT EXISTS") {
                return t.to_string();
            }
            return format!("{}IF NOT EXISTS {}", &t[..kw.len()], &t[kw.len()..]);
        }
    }
    for kw in ["CREATE FUNCTION ", "CREATE AGGREGATE "] {
        if upper.starts_with(kw) {
            return format!("CREATE OR REPLACE {}", &t[7..]);
        }
    }
    t.to_string()
}

pub fn cql_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn cql_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// One data row of the dump: `INSERT INTO "ks"."t" JSON '…';` on ONE line —
/// JSON escapes newlines, so the restore reader can rely on line boundaries.
pub fn cql_insert_json(keyspace: &str, table: &str, json: &str) -> String {
    format!("INSERT INTO {}.{} JSON {};", cql_ident(keyspace), cql_ident(table), cql_str(json))
}

/// Order UDTs so a type is created after the types it uses (`frozen<addr>`).
/// Cycles cannot exist in Cassandra; unknown references are ignored.
pub fn order_types(types: &[(String, Vec<(String, String)>)]) -> Vec<usize> {
    let names: Vec<String> = types.iter().map(|t| t.0.to_ascii_lowercase()).collect();
    let deps: Vec<Vec<usize>> = types
        .iter()
        .enumerate()
        .map(|(i, (_, fields))| {
            let text = fields.iter().map(|f| f.1.to_ascii_lowercase()).collect::<Vec<_>>().join(" ");
            let words: Vec<&str> = text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).collect();
            names
                .iter()
                .enumerate()
                .filter(|(j, n)| *j != i && words.contains(&n.as_str()))
                .map(|(j, _)| j)
                .collect()
        })
        .collect();
    let mut done = vec![false; types.len()];
    let mut out = Vec::new();
    fn visit(i: usize, deps: &[Vec<usize>], done: &mut [bool], out: &mut Vec<usize>, depth: usize) {
        if done[i] || depth > deps.len() {
            return;
        }
        for &d in &deps[i] {
            visit(d, deps, done, out, depth + 1);
        }
        if !done[i] {
            done[i] = true;
            out.push(i);
        }
    }
    for i in 0..types.len() {
        visit(i, &deps, &mut done, &mut out, 0);
    }
    out
}

/// Split a CQL script into statements. A statement ends at a line whose last
/// non-space character is `;` (outside a `$$` body). `--` / `//` comment lines
/// are dropped. This is the format `cql_dump` writes; it also reads a hand
/// written script that keeps one statement terminator per line.
pub fn split_cql_script(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_body = false;
    for raw in text.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if cur.is_empty() && !in_body && (trimmed.is_empty() || trimmed.starts_with("--") || trimmed.starts_with("//")) {
            continue;
        }
        if line.matches("$$").count() % 2 == 1 {
            in_body = !in_body;
        }
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(line);
        if !in_body && line.ends_with(';') {
            let stmt = cur.trim().trim_end_matches(';').trim().to_string();
            if !stmt.is_empty() {
                out.push(stmt);
            }
            cur.clear();
        }
    }
    let rest = cur.trim().trim_end_matches(';').trim();
    if !rest.is_empty() {
        out.push(rest.to_string());
    }
    out
}

/// Keyspace named in a dump's `-- keyspace: <name>` header line.
pub fn cql_dump_keyspace(text: &str) -> Option<String> {
    text.lines()
        .take(10)
        .find_map(|l| l.strip_prefix("-- keyspace: "))
        .map(|s| s.trim().to_string())
}

// ---------------------------------------------------------------------------
// Redis built-in dump (DUMP / RESTORE)
// ---------------------------------------------------------------------------

pub const REDIS_DUMP_FORMAT: &str = "database-studio/redis-dump";

pub fn redis_header_line(db: i64, created: &str) -> String {
    serde_json::json!({ "format": REDIS_DUMP_FORMAT, "version": 1, "db": db, "created": created }).to_string()
}

/// One key: base64 key bytes, remaining TTL in ms (0 = no expiry), base64 DUMP payload.
pub fn redis_key_line(key: &[u8], pttl: i64, payload: &[u8]) -> String {
    use base64::Engine;
    let b = base64::engine::general_purpose::STANDARD;
    serde_json::json!({ "k": b.encode(key), "t": pttl.max(0), "v": b.encode(payload) }).to_string()
}

pub struct RedisDumpEntry {
    pub key: Vec<u8>,
    pub ttl_ms: i64,
    pub payload: Vec<u8>,
}

/// Parse one dump line. `Ok(None)` = the header line.
pub fn parse_redis_line(line: &str) -> Result<Option<RedisDumpEntry>, String> {
    use base64::Engine;
    let v: serde_json::Value = serde_json::from_str(line).map_err(|e| format!("not a Database Studio Redis backup line: {e}"))?;
    if v.get("format").is_some() {
        if v["format"] != REDIS_DUMP_FORMAT {
            return Err("this file is not a Database Studio Redis backup".into());
        }
        return Ok(None);
    }
    let b = base64::engine::general_purpose::STANDARD;
    let key = b.decode(v["k"].as_str().ok_or("missing key")?).map_err(|e| e.to_string())?;
    let payload = b.decode(v["v"].as_str().ok_or("missing value")?).map_err(|e| e.to_string())?;
    Ok(Some(RedisDumpEntry { key, ttl_ms: v["t"].as_i64().unwrap_or(0).max(0), payload }))
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn t() -> BackupTarget {
        BackupTarget { host: "127.0.0.1".into(), port: 5432, database: "app".into(), user: "u".into() }
    }

    #[test]
    fn pg_dump_never_prompts_and_follows_options() {
        let a = pg_dump_args(&t(), "/b/app.sql", &BackupOptions::default());
        assert!(a.contains(&"-w".to_string()), "must never prompt for a password");
        assert!(a.windows(2).any(|w| w == ["-F", "p"]));
        assert!(a.windows(2).any(|w| w == ["-f", "/b/app.sql"]));
        assert!(!a.iter().any(|x| x.to_lowercase().contains("password")));
        let o = BackupOptions {
            format: Some("custom".into()),
            content: Some("schema".into()),
            clean: Some(true),
            owner: Some(false),
            ..Default::default()
        };
        let a = pg_dump_args(&t(), "/b/app.dump", &o);
        assert!(a.windows(2).any(|w| w == ["-F", "c"]));
        assert!(a.contains(&"-s".into()) && a.contains(&"--clean".into()) && a.contains(&"--if-exists".into()));
        assert!(a.contains(&"-O".into()) && a.contains(&"-x".into()));
        // data-only never drops objects
        let o = BackupOptions { content: Some("data".into()), clean: Some(true), ..Default::default() };
        let a = pg_dump_args(&t(), "x", &o);
        assert!(a.contains(&"-a".into()) && !a.contains(&"--clean".into()));
    }

    #[test]
    fn pg_restore_and_psql_shapes() {
        let o = BackupOptions { clean: Some(true), single_transaction: Some(true), ..Default::default() };
        let a = pg_restore_args(&t(), "/b/app.dump", &o);
        assert!(a.contains(&"-w".into()) && a.contains(&"--clean".into()) && a.contains(&"-1".into()));
        assert_eq!(a.last().unwrap(), "/b/app.dump");
        let a = psql_restore_args(&t(), "/b/app.sql", &o);
        assert!(a.contains(&"ON_ERROR_STOP=1".into()) && a.contains(&"-X".into()) && a.contains(&"-1".into()));
        assert!(a.windows(2).any(|w| w == ["-f", "/b/app.sql"]));
    }

    #[test]
    fn mysqldump_flags_per_flavour() {
        let o = BackupOptions::default();
        let a = mysqldump_args("mysql", &t(), "/b/x.sql", &o, MyFlavor::Mysql);
        assert!(a.contains(&"--protocol=TCP".into()) && a.contains(&"--single-transaction".into()));
        assert!(a.contains(&"--set-gtid-purged=OFF".into()));
        assert!(!a.contains(&"--column-statistics=0".into()));
        assert_eq!(a.last().unwrap(), "app");
        assert!(a.contains(&"--result-file=/b/x.sql".into()));
        // MySQL 8 tool against MariaDB needs --column-statistics=0
        let a = mysqldump_args("mariadb", &t(), "x", &o, MyFlavor::Mysql);
        assert!(a.contains(&"--column-statistics=0".into()));
        // mariadb-dump knows neither flag
        let a = mysqldump_args("mariadb", &t(), "x", &o, MyFlavor::Mariadb);
        assert!(!a.iter().any(|x| x.starts_with("--set-gtid") || x.starts_with("--column-stat")));
        // data only: no routines/triggers/DDL
        let o = BackupOptions { content: Some("data".into()), ..Default::default() };
        let a = mysqldump_args("mysql", &t(), "x", &o, MyFlavor::Mysql);
        assert!(a.contains(&"--no-create-info".into()) && !a.contains(&"--routines".into()));
        assert!(!a.iter().any(|x| x.contains("PWD") || x.contains("password")));
    }

    #[test]
    fn flavor_from_version_line() {
        assert_eq!(my_flavor("mysqldump  Ver 8.0.36 for Win64 on x86_64 (MySQL Community Server - GPL)"), MyFlavor::Mysql);
        assert_eq!(my_flavor("mariadb-dump from 11.4.2-MariaDB, client 10.19 for Win64 (AMD64)"), MyFlavor::Mariadb);
        assert_eq!(my_flavor("mysqldump  Ver 10.19 Distrib 10.6.16-MariaDB, for Linux"), MyFlavor::Mariadb);
    }

    #[test]
    fn versions_parse() {
        assert_eq!(parse_version("pg_dump (PostgreSQL) 16.4"), Some((16, 4)));
        assert_eq!(parse_version("pg_dump (PostgreSQL) 9.6.24"), Some((9, 6)));
        assert_eq!(parse_version("mysqldump  Ver 8.0.36 for Win64 on x86_64"), Some((8, 0)));
        assert_eq!(parse_version("mariadb-dump from 11.4.2-MariaDB, client 10.19"), Some((11, 4)));
        assert_eq!(parse_version("mongodump version: 100.9.4\ngit version: abc"), Some((100, 9)));
        assert_eq!(parse_version("Export: Release 23.0.0.0.0 - Production"), Some((23, 0)));
        assert_eq!(pg_server_major("160004"), Some(16));
        assert_eq!(pg_server_major("90624"), Some(9));
        assert_eq!(pg_server_major("16.4 (Debian 16.4-1.pgdg120+1)"), Some(16));
    }

    #[test]
    fn version_folders_sort_newest_first() {
        let mut v = vec!["9.6", "16", "13", "MySQL Server 8.0", "MySQL Server 5.7"];
        v.sort_by(|a, b| version_key(b).cmp(&version_key(a)));
        assert_eq!(v[0], "16");
        assert_eq!(version_key("instantclient_23_0"), vec![23, 0]);
        assert_eq!(version_key("postgresql@15"), vec![15]);
    }

    #[test]
    fn discovery_finds_a_tool_in_a_versioned_install_folder() {
        let root = std::env::temp_dir().join(format!("ds-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for v in ["13", "16"] {
            let bin = root.join("PostgreSQL").join(v).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join(exe_name("pg_dump")), b"").unwrap();
        }
        let sep = if cfg!(windows) { "\\" } else { "/" };
        let pat = format!("{}{sep}PostgreSQL{sep}*{sep}bin", root.display());
        let found = expand_pattern(&pat);
        assert_eq!(found.len(), 2);
        assert!(found[0].to_string_lossy().contains("16"), "newest version folder first: {found:?}");
        // a user-picked folder (or the exe itself) wins
        let exe = root.join("PostgreSQL").join("13").join("bin").join(exe_name("pg_dump"));
        let c = find_tool_candidates(&["pg_dump"], Some(exe.to_str().unwrap()));
        assert_eq!(c.first(), Some(&exe));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tool_errors_are_explained() {
        assert!(explain_tool_error("postgres", "pg_dump: error: aborting because of server version mismatch").unwrap().contains("older than the server"));
        assert!(explain_tool_error("postgres", "FATAL:  password authentication failed for user \"u\"").unwrap().contains("password"));
        assert!(explain_tool_error("mariadb", "Unknown table 'COLUMN_STATISTICS' in information_schema").unwrap().contains("MariaDB"));
        assert!(explain_tool_error("mysql", "Got error: 2003: Can't connect to MySQL server").unwrap().contains("reach the server"));
        assert!(explain_tool_error("mysql", "something odd").is_none());
    }

    #[test]
    fn mssql_statements() {
        let b = mssql_backup_sql_opts("app]x", "C:\\b\\o'k.bak", true, false);
        assert!(b.starts_with("BACKUP DATABASE [app]]x] TO DISK = N'C:\\b\\o''k.bak' WITH COPY_ONLY, FORMAT, INIT"));
        assert!(!b.contains("COMPRESSION"));
        assert!(mssql_backup_sql_opts("a", "x", false, true).contains("COMPRESSION"));
        let r = mssql_restore_batch("app", "/var/opt/mssql/data/app.bak");
        assert!(r.starts_with("SET NOCOUNT ON;"), "raw batch so RESTORE is not wrapped in sp_executesql");
        assert!(r.contains("SET SINGLE_USER WITH ROLLBACK IMMEDIATE"));
        // MULTI_USER is restored on both the success and the failure path
        assert_eq!(r.matches("SET MULTI_USER").count(), 2);
        assert!(r.contains("THROW"));
    }

    #[test]
    fn clickhouse_statements() {
        assert_eq!(clickhouse_backup_sql("app", "backups", "app.zip"), "BACKUP DATABASE `app` TO Disk('backups', 'app.zip')");
        assert_eq!(
            clickhouse_restore_sql("app", Some("app_copy"), "backups", "app.zip"),
            "RESTORE DATABASE `app` AS `app_copy` FROM Disk('backups', 'app.zip')"
        );
        assert_eq!(clickhouse_restore_sql("app", Some("app"), "b", "f"), "RESTORE DATABASE `app` FROM Disk('b', 'f')");
        assert_eq!(clickhouse_file_name("C:\\Users\\me\\app.zip"), "app.zip");
        assert_eq!(clickhouse_file_name("o'k.zip"), "o'k.zip");
        assert!(clickhouse_backup_sql("a", "d", "o'k.zip").contains("'o\\'k.zip'"));
    }

    #[test]
    fn mongo_args_keep_secrets_off_argv() {
        let a = mongodump_args("/tmp/c.yaml", "app", "/b/app.archive", &BackupOptions { format: Some("gzip".into()), ..Default::default() });
        assert!(a.contains(&"--config=/tmp/c.yaml".into()) && a.contains(&"--db=app".into()) && a.contains(&"--gzip".into()));
        assert!(!a.iter().any(|x| x.contains("mongodb://")));
        let r = mongorestore_args("/tmp/c.yaml", "app", "/b/app.archive.gz", &BackupOptions { clean: Some(true), ..Default::default() });
        assert!(r.contains(&"--gzip".into()) && r.contains(&"--drop".into()) && r.contains(&"--nsInclude=app.*".into()));
        assert_eq!(mongo_config_yaml("mongodb://u:p\"w@h:1/"), "uri: \"mongodb://u:p\\\"w@h:1/\"\n");
    }

    #[test]
    fn cql_dump_helpers() {
        assert_eq!(cql_idempotent("CREATE TABLE ks.t (a int PRIMARY KEY);"), "CREATE TABLE IF NOT EXISTS ks.t (a int PRIMARY KEY);");
        assert_eq!(cql_idempotent("CREATE TYPE IF NOT EXISTS ks.a (x int);"), "CREATE TYPE IF NOT EXISTS ks.a (x int);");
        assert_eq!(cql_idempotent("CREATE CUSTOM INDEX i ON ks.t (v)"), "CREATE CUSTOM INDEX IF NOT EXISTS i ON ks.t (v)");
        assert_eq!(cql_idempotent("CREATE FUNCTION ks.f(a int)"), "CREATE OR REPLACE FUNCTION ks.f(a int)");
        assert_eq!(cql_insert_json("ks", "t", "{\"a\":\"it's\"}"), "INSERT INTO \"ks\".\"t\" JSON '{\"a\":\"it''s\"}';");
        let script = format!(
            "{CQL_DUMP_HEADER}\n-- keyspace: shop\n\nCREATE TABLE IF NOT EXISTS shop.t (\n  a int PRIMARY KEY\n);\nCREATE FUNCTION shop.f(a int) RETURNS int LANGUAGE java AS $$\n  return a; ;\n$$;\nINSERT INTO \"shop\".\"t\" JSON '{{\"a\":1}}';\n"
        );
        let s = split_cql_script(&script);
        assert_eq!(s.len(), 3, "{s:?}");
        assert!(s[0].starts_with("CREATE TABLE") && s[0].ends_with(')'));
        assert!(s[1].contains("return a; ;"), "a $$ body keeps its own semicolons");
        assert_eq!(cql_dump_keyspace(&script).as_deref(), Some("shop"));
    }

    #[test]
    fn udts_are_created_after_the_types_they_use() {
        let types = vec![
            ("person".to_string(), vec![("home".to_string(), "frozen<address>".to_string())]),
            ("address".to_string(), vec![("geo".to_string(), "frozen<point>".to_string())]),
            ("point".to_string(), vec![("x".to_string(), "double".to_string())]),
        ];
        let order: Vec<&str> = order_types(&types).into_iter().map(|i| types[i].0.as_str()).collect();
        assert_eq!(order, vec!["point", "address", "person"]);
    }

    #[test]
    fn redis_lines_round_trip() {
        let h = redis_header_line(3, "2026-10-19T10:00:00Z");
        assert!(parse_redis_line(&h).unwrap().is_none());
        let key = b"user:\x00\xff:1";
        let line = redis_key_line(key, 1500, b"\x00\x01payload");
        let e = parse_redis_line(&line).unwrap().unwrap();
        assert_eq!(e.key, key.to_vec());
        assert_eq!(e.ttl_ms, 1500);
        assert_eq!(e.payload, b"\x00\x01payload".to_vec());
        // a persistent key (PTTL -1) stores 0 = no expiry
        let e = parse_redis_line(&redis_key_line(b"k", -1, b"v")).unwrap().unwrap();
        assert_eq!(e.ttl_ms, 0);
        assert!(parse_redis_line("{\"format\":\"other\"}").is_err());
        assert!(parse_redis_line("garbage").is_err());
    }

    #[test]
    fn tail_keeps_the_end_on_a_line_boundary() {
        let text = (0..200).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let t = tail(&text, 50);
        assert!(t.starts_with("…\n") && t.ends_with("line 199"));
        assert_eq!(tail("short", 50), "short");
    }

    #[test]
    fn plain_dumps_of_old_servers_drop_the_v17_only_setting() {
        let head = b"--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\nSET lock_timeout = 0;\nSET idle_in_transaction_session_timeout = 0;\nSET transaction_timeout = 0;\nSET client_encoding = 'UTF8';\n";
        let (at, rep) = pg_plain_header_fix(head, 16).expect("needs a fix for PostgreSQL 16");
        assert_eq!(rep.len(), "SET transaction_timeout = 0;".len(), "same length: patched in place");
        let mut fixed = head.to_vec();
        fixed[at..at + rep.len()].copy_from_slice(&rep);
        let text = String::from_utf8(fixed).unwrap();
        assert!(!text.contains("SET transaction_timeout"));
        assert!(text.contains("\n-- transaction_timeout=0 17+\nSET client_encoding"), "{text}");
        assert!(text.contains("SET idle_in_transaction_session_timeout = 0;"), "other settings stay");
        // a 17+ server understands it; a file without it needs nothing
        assert!(pg_plain_header_fix(head, 17).is_none());
        assert!(pg_plain_header_fix(b"SET lock_timeout = 0;\n", 12).is_none());
        // only a statement at the start of a line, never text inside data
        assert!(pg_plain_header_fix(b"INSERT INTO t VALUES ('x SET transaction_timeout = 0;');\n", 16).is_none());
    }

    #[test]
    fn pg_dump_is_counted_by_the_line_it_really_prints() {
        // structure only + plain SQL: "creating TABLE", parents included, ATTACH skipped
        assert_eq!(pg_dump_count(Some("plain"), Some("schema")), PgDumpCount::Schema);
        assert_eq!(pg_dump_count(None, Some("schema")), PgDumpCount::Schema);
        assert_eq!(pg_dump_schema_progress(r#"pg_dump: creating TABLE "public.t_1""#).as_deref(), Some("public.t_1"));
        assert_eq!(pg_dump_schema_progress(r#"pg_dump: creating TABLE ATTACH "public.p1""#), None);
        assert_eq!(pg_dump_schema_progress(r#"pg_dump: creating CONSTRAINT "public.t_1 t_1_pkey""#), None);
        // a structure-only custom archive names no table at all
        assert_eq!(pg_dump_count(Some("custom"), Some("schema")), PgDumpCount::Unmeasured);
        assert_eq!(pg_table_count_sql(PgDumpCount::Unmeasured), None);
        // with data: one "dumping contents" per table with rows of its own (no parents)
        for c in [None, Some("all"), Some("data")] {
            assert_eq!(pg_dump_count(Some("custom"), c), PgDumpCount::Data);
            assert_eq!(pg_dump_count(Some("plain"), c), PgDumpCount::Data);
        }
        let data = pg_table_count_sql(PgDumpCount::Data).unwrap();
        assert!(data.contains("relkind IN ('r')") && data.contains("deptype = 'e'"));
        assert!(pg_table_count_sql(PgDumpCount::Schema).unwrap().contains("relkind IN ('r', 'p')"));
    }

    #[test]
    fn impdp_into_its_own_schema_is_not_a_failure() {
        let user = r#"ORA-31684: Object type USER:"PERF" already exists"#.to_string();
        assert!(is_ora_error(&user));
        assert!(!is_ora_error("ORACLE_HOME=/opt; ORA-xx is not a code"));
        assert!(datapump_only_already_exists(&[user.clone()]));
        // any other Oracle error is still a failure
        let quota = "ORA-01950: no privileges on tablespace 'USERS'".to_string();
        assert!(!datapump_only_already_exists(&[user, quota]));
        // and an exit with no Oracle error at all is not explained by this
        assert!(!datapump_only_already_exists(&[]));
        assert!(!datapump_only_already_exists(&["pg_restore: error: x".to_string()]));
    }

    #[test]
    fn pg_restore_runs_in_parallel_and_tolerates_only_the_v17_setting() {
        assert_eq!(pg_restore_jobs(false, 8), 4);
        assert_eq!(pg_restore_jobs(false, 16), 4, "capped: every job is a server connection");
        assert_eq!(pg_restore_jobs(false, 2), 1);
        assert_eq!(pg_restore_jobs(false, 1), 1);
        assert_eq!(pg_restore_jobs(true, 16), 1, "-1 and -j cannot be combined");
        let tt = "pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter \"transaction_timeout\"".to_string();
        assert!(pg_only_transaction_timeout_errors(&[tt.clone(), tt.clone()]));
        let real = "pg_restore: error: could not execute query: ERROR:  relation \"t1\" already exists".to_string();
        assert!(!pg_only_transaction_timeout_errors(&[tt, real]), "any other error still fails the restore");
        assert!(!pg_only_transaction_timeout_errors(&[]), "a failure with no error line is not tolerated");
    }

    #[test]
    fn progress_is_read_from_each_tools_output() {
        assert_eq!(pg_dump_progress("pg_dump: dumping contents of table \"public.t_0042\"").as_deref(), Some("public.t_0042"));
        assert_eq!(pg_dump_progress("pg_dump: reading extensions"), None);
        assert_eq!(pg_restore_progress("pg_restore: processing data for table \"public.orders\"").as_deref(), Some("public.orders"));
        assert_eq!(pg_restore_parallel_progress("pg_restore: finished item 3418 TABLE DATA orders").as_deref(), Some("orders"));
        assert_eq!(pg_restore_parallel_progress("pg_restore: launching item 3418 TABLE DATA orders"), None);
        assert_eq!(pg_restore_parallel_progress("pg_restore: finished item 17 INDEX orders_pkey"), None);
        assert_eq!(mysqldump_progress("-- Retrieving table structure for table t_17...").as_deref(), Some("t_17"));
        assert_eq!(mysqldump_progress("-- Sending SELECT query..."), None);
        assert_eq!(mongodump_progress("2026-10-20T10:00:00.000+0700\tdone dumping app.c_9 (12 documents)").as_deref(), Some("app.c_9"));
        assert_eq!(mongodump_progress("2026-10-20T10:00:00.000+0700\twriting app.c_9 to archive"), None);
        assert_eq!(mongorestore_progress("2026-10-20T10:00:01.000+0700\tfinished restoring app.c_9 (12 documents, 0 failures)").as_deref(), Some("app.c_9"));
        // real mongorestore output: names in backticks, and one "reading metadata"
        // line per collection before any is restored
        assert_eq!(mongorestore_progress("2026-10-20T17:41:19.128+0700\tfinished restoring `perf.c11` (2 documents, 0 failures)").as_deref(), Some("perf.c11"));
        assert!(mongorestore_announces("2026-10-20T17:41:19.101+0700\treading metadata for `perf.c5` from `archive on stdin`"));
        assert!(!mongorestore_announces("2026-10-20T17:41:19.118+0700\trestoring `perf.c11` from `archive on stdin`"));
        assert_eq!(mongorestore_progress("2026-10-20T17:41:19.118+0700\trestoring `perf.c11` from `archive on stdin`"), None);
        assert_eq!(mongorestore_progress("2026-10-20T17:41:19.990+0700\tno indexes to restore for collection `perf.c9`"), None);
        assert_eq!(sqlpackage_progress("Processing Table '[dbo].[t_5]'.").as_deref(), Some("dbo.t_5"));
        assert_eq!(datapump_progress(". . exported \"APP\".\"T_5\"                5.523 KB       2 rows").as_deref(), Some("APP.T_5"));
        assert_eq!(datapump_progress(". . imported \"APP\".\"T_5\"   5.5 KB   2 rows").as_deref(), Some("APP.T_5"));
        assert!(table_count_sql("mysql", "o'db").unwrap().contains("'o''db'"));
        assert!(table_count_sql("redis", "0").is_none());
    }

    #[test]
    fn sql_server_bacpac_through_sqlpackage() {
        let t = BackupTarget { host: "127.0.0.1".into(), port: 14330, database: "app db".into(), user: "sa".into() };
        assert!(mssql_is_bacpac(Some("bacpac"), "C:\\b\\x.bak"));
        assert!(mssql_is_bacpac(None, "C:\\b\\App.BACPAC"));
        assert!(!mssql_is_bacpac(Some("bak"), "/var/opt/mssql/data/app.bak"));
        let rsp = sqlpackage_export_rsp(&t, "p w;x!", "sql", "C:\\My Backups\\app.bacpac").unwrap();
        let lines: Vec<&str> = rsp.lines().collect();
        assert_eq!(lines[0], "\"/Action:Export\"");
        assert!(lines.contains(&"\"/SourceServerName:127.0.0.1,14330\""));
        assert!(lines.contains(&"\"/SourceDatabaseName:app db\""));
        assert!(lines.contains(&"\"/SourcePassword:p w;x!\""), "password stays one value inside quotes");
        assert!(lines.contains(&"\"/TargetFile:C:\\My Backups\\app.bacpac\""));
        // Windows login: no user / password at all
        let w = sqlpackage_export_rsp(&t, "secret", "windows", "x.bacpac").unwrap();
        assert!(!w.contains("Password") && !w.contains("/SourceUser"));
        // values SqlPackage cannot take safely are refused, not mangled
        assert!(sqlpackage_export_rsp(&t, "a\"b", "sql", "x.bacpac").is_err());
        assert!(sqlpackage_export_rsp(&t, "x", "aad-sp", "x.bacpac").is_err());
        let imp = sqlpackage_import_rsp(&t, "pw", "sql", "C:\\b\\app.bacpac", "app_copy").unwrap();
        assert!(imp.starts_with("\"/Action:Import\"\n\"/SourceFile:C:\\b\\app.bacpac\"\n"));
        assert!(imp.contains("\"/TargetDatabaseName:app_copy\"") && imp.contains("\"/TargetUser:sa\""));
        let d = mssql_drop_database_batch("o]dd");
        assert!(d.starts_with("SET NOCOUNT ON;") && d.contains("DROP DATABASE [o]]dd]") && d.contains("DB_ID(N'o]dd')"));
    }

    #[test]
    fn archive_to_script_keeps_the_choices_but_needs_no_server() {
        let o = BackupOptions { clean: Some(true), owner: Some(false), single_transaction: Some(true), ..Default::default() };
        let a = pg_restore_to_script_args("/b/app.dump", "/t/app.sql", &o);
        assert_eq!(a, vec!["--clean", "--if-exists", "-O", "-x", "-f", "/t/app.sql", "/b/app.dump"]);
        assert!(!a.iter().any(|x| x == "-d" || x == "-1" || x == "-h"), "no connection, psql applies it");
    }
}
