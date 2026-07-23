//! Backup command builder (Phase 5 · T22) — pure (không I/O) → unit-test được.
//! SQLite backup/restore chạy in-process qua rusqlite; các hệ khác shell ra công
//! cụ ngoài (pg_dump/mysqldump/clickhouse-client) — builder ở đây dựng lệnh.

/// Công cụ backup ngoài theo hệ (None = xử lý in-process hoặc chưa hỗ trợ).
pub fn backup_tool(system: &str) -> Option<&'static str> {
    match system {
        "postgres" => Some("pg_dump"),
        "mysql" | "mariadb" => Some("mysqldump"),
        "clickhouse" => Some("clickhouse-client"),
        "mongodb" => Some("mongodump"),
        "oracle" => Some("expdp"), // Data Pump export (needs Instant Client Tools)
        // sqlite = in-process (rusqlite); mssql = native BACKUP via the app connection
        // (no external tool); redis/kafka/nats/cassandra = N/A.
        _ => None,
    }
}

pub struct BackupTarget {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
}

/// Dựng (program, args) cho backup ngoài. Mật khẩu KHÔNG nằm trong args (truyền
/// qua env: PGPASSWORD / MYSQL_PWD). None nếu hệ không dùng công cụ ngoài.
pub fn external_backup_cmd(system: &str, t: &BackupTarget, dest: &str) -> Option<(String, Vec<String>)> {
    match system {
        "postgres" => Some((
            "pg_dump".into(),
            vec![
                "-h".into(), t.host.clone(),
                "-p".into(), t.port.to_string(),
                "-U".into(), t.user.clone(),
                "-d".into(), t.database.clone(),
                "-f".into(), dest.into(),
            ],
        )),
        "mysql" | "mariadb" => Some((
            "mysqldump".into(),
            vec![
                format!("-h{}", t.host),
                format!("-P{}", t.port),
                format!("-u{}", t.user),
                t.database.clone(),
                format!("--result-file={dest}"),
            ],
        )),
        "clickhouse" => Some((
            "clickhouse-client".into(),
            vec![
                "--host".into(), t.host.clone(),
                "--port".into(), t.port.to_string(),
                "--query".into(),
                format!("BACKUP DATABASE {} TO Disk('backups', '{dest}')", t.database),
            ],
        )),
        // mongodump → single-file archive. Password KHÔNG nằm trong args (mongodump
        // không có env var mật khẩu như PGPASSWORD; auth truyền ở tầng command nếu cần).
        "mongodb" => Some(("mongodump".into(), {
            let mut a = vec![
                "--host".into(), t.host.clone(),
                "--port".into(), t.port.to_string(),
            ];
            if !t.user.is_empty() {
                a.push("--username".into());
                a.push(t.user.clone());
            }
            if !t.database.is_empty() {
                a.push("--db".into());
                a.push(t.database.clone());
            }
            a.push(format!("--archive={dest}"));
            a
        })),
        _ => None,
    }
}

/// Công cụ restore ngoài theo hệ (đối xứng với backup_tool). None = in-process /
/// chưa hỗ trợ.
pub fn restore_tool(system: &str) -> Option<&'static str> {
    match system {
        "postgres" => Some("psql"),
        "mysql" | "mariadb" => Some("mysql"),
        "clickhouse" => Some("clickhouse-client"),
        "mongodb" => Some("mongorestore"),
        "oracle" => Some("impdp"), // Data Pump import
        // sqlite = in-process; mssql = native RESTORE via the app connection;
        // redis/kafka/nats/cassandra = N/A.
        _ => None,
    }
}

/// Dựng (program, args, stdin_file) để restore một file backup do backup_database
/// tạo. `stdin_file`=Some(path) nghĩa là nội dung file được nạp qua STDIN (mysql
/// đọc dump từ stdin); None nghĩa là file đã nằm trong args (psql `-f`). Mật khẩu
/// KHÔNG nằm trong args (env PGPASSWORD/MYSQL_PWD như backup).
pub fn external_restore_cmd(
    system: &str,
    t: &BackupTarget,
    src: &str,
) -> Option<(String, Vec<String>, Option<String>)> {
    match system {
        // pg_dump plain SQL → psql chạy lại vào cùng database (-f đọc file).
        "postgres" => Some((
            "psql".into(),
            vec![
                "-h".into(), t.host.clone(),
                "-p".into(), t.port.to_string(),
                "-U".into(), t.user.clone(),
                "-d".into(), t.database.clone(),
                "-v".into(), "ON_ERROR_STOP=1".into(),
                "-f".into(), src.into(),
            ],
            None,
        )),
        // mysqldump SQL → mysql client đọc dump qua STDIN.
        "mysql" | "mariadb" => Some((
            "mysql".into(),
            vec![
                format!("-h{}", t.host),
                format!("-P{}", t.port),
                format!("-u{}", t.user),
                t.database.clone(),
            ],
            Some(src.to_string()),
        )),
        // ClickHouse: RESTORE DATABASE … FROM Disk('backups', file) (đối xứng BACKUP).
        "clickhouse" => Some((
            "clickhouse-client".into(),
            vec![
                "--host".into(), t.host.clone(),
                "--port".into(), t.port.to_string(),
                "--query".into(),
                format!("RESTORE DATABASE {} FROM Disk('backups', '{src}')", t.database),
            ],
            None,
        )),
        _ => None,
    }
}

/// mongorestore command để khôi phục từ file archive do mongodump tạo.
pub fn mongo_restore_cmd(t: &BackupTarget, src: &str) -> (String, Vec<String>) {
    let mut a = vec![
        "--host".into(), t.host.clone(),
        "--port".into(), t.port.to_string(),
    ];
    if !t.user.is_empty() {
        a.push("--username".into());
        a.push(t.user.clone());
    }
    a.push(format!("--archive={src}"));
    ("mongorestore".into(), a)
}

// ---------------------------------------------------------------------------
// MSSQL — native T-SQL BACKUP/RESTORE (run through the app's own connection,
// no external tool). The .bak file lives on the SQL Server host (server-side).
// ---------------------------------------------------------------------------

/// `[...]`-quote an MSSQL identifier (double any `]`).
fn mssql_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}
/// Escape a string for an `N'...'` MSSQL literal (double any `'`).
fn mssql_str(s: &str) -> String {
    s.replace('\'', "''")
}

/// Native MSSQL full backup — `BACKUP DATABASE [db] TO DISK = N'dest'`. `dest` is
/// a path ON THE SQL SERVER host, not the client.
pub fn mssql_backup_sql(database: &str, dest: &str) -> String {
    format!(
        "BACKUP DATABASE {} TO DISK = N'{}' WITH FORMAT, INIT, NAME = N'Database Studio full backup', STATS = 10",
        mssql_ident(database),
        mssql_str(dest)
    )
}

/// Native MSSQL restore — `RESTORE DATABASE [db] FROM DISK = N'src' WITH REPLACE`.
/// Requires the DB not be in active use (may need single-user / a master
/// connection); the `.bak` path is on the server.
pub fn mssql_restore_sql(database: &str, src: &str) -> String {
    format!(
        "RESTORE DATABASE {} FROM DISK = N'{}' WITH REPLACE, STATS = 10",
        mssql_ident(database),
        mssql_str(src)
    )
}

// ---------------------------------------------------------------------------
// Oracle — Data Pump (expdp/impdp). Dumps go to an Oracle DIRECTORY object that
// maps to a path ON THE DB SERVER. Password is passed via STDIN (never argv).
// ---------------------------------------------------------------------------

/// Data Pump connect identifier (`user@//host:port/service`). Password supplied
/// on STDIN by the caller, so it never appears in the process arguments.
fn oracle_connect(t: &BackupTarget) -> String {
    format!("{}@//{}:{}/{}", t.user, t.host, t.port, t.database)
}

/// `CREATE OR REPLACE DIRECTORY` mapping a logical name → OS path on the DB server.
pub fn oracle_dir_sql(dir_name: &str, os_path: &str) -> String {
    format!(
        "CREATE OR REPLACE DIRECTORY \"{}\" AS '{}'",
        dir_name.replace('"', ""),
        os_path.replace('\'', "''")
    )
}

/// `expdp` argv for a schema-level export. `dir_name` is an Oracle DIRECTORY
/// object; `dumpfile`/`logfile` are filenames within it. NO password in argv.
pub fn oracle_expdp_cmd(t: &BackupTarget, dir_name: &str, dumpfile: &str, logfile: &str) -> (String, Vec<String>) {
    (
        "expdp".into(),
        vec![
            oracle_connect(t),
            format!("SCHEMAS={}", t.user),
            format!("DIRECTORY={dir_name}"),
            format!("DUMPFILE={dumpfile}"),
            format!("LOGFILE={logfile}"),
            "REUSE_DUMPFILES=YES".into(),
        ],
    )
}

/// `impdp` argv for a schema-level import (mirrors the export). NO password in argv.
pub fn oracle_impdp_cmd(t: &BackupTarget, dir_name: &str, dumpfile: &str, logfile: &str) -> (String, Vec<String>) {
    (
        "impdp".into(),
        vec![
            oracle_connect(t),
            format!("SCHEMAS={}", t.user),
            format!("DIRECTORY={dir_name}"),
            format!("DUMPFILE={dumpfile}"),
            format!("LOGFILE={logfile}"),
            "TABLE_EXISTS_ACTION=REPLACE".into(),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tgt() -> BackupTarget {
        BackupTarget { host: "10.0.0.1".into(), port: 5432, database: "app".into(), user: "u".into() }
    }

    #[test]
    fn tool_per_system() {
        assert_eq!(backup_tool("postgres"), Some("pg_dump"));
        assert_eq!(backup_tool("mysql"), Some("mysqldump"));
        assert_eq!(backup_tool("mariadb"), Some("mysqldump"));
        assert_eq!(backup_tool("clickhouse"), Some("clickhouse-client"));
        assert_eq!(backup_tool("mongodb"), Some("mongodump"));
        assert_eq!(backup_tool("sqlite"), None);
        assert_eq!(backup_tool("redis"), None);
        // restore tool symmetric with backup
        assert_eq!(restore_tool("postgres"), Some("psql"));
        assert_eq!(restore_tool("mysql"), Some("mysql"));
        assert_eq!(restore_tool("clickhouse"), Some("clickhouse-client"));
        assert_eq!(restore_tool("mongodb"), Some("mongorestore"));
        assert_eq!(restore_tool("sqlite"), None);
        assert_eq!(restore_tool("redis"), None);
    }

    #[test]
    fn restore_cmd_shape_per_engine() {
        let t = tgt();
        // pg: psql -f file, no password in args, ON_ERROR_STOP
        let (prog, args, stdin) = external_restore_cmd("postgres", &t, "/tmp/b.sql").unwrap();
        assert_eq!(prog, "psql");
        assert!(args.windows(2).any(|w| w == ["-d", "app"]));
        assert!(args.windows(2).any(|w| w == ["-f", "/tmp/b.sql"]));
        assert!(args.iter().any(|a| a == "ON_ERROR_STOP=1"));
        assert!(stdin.is_none(), "pg đọc file qua -f, không stdin");
        assert!(!args.iter().any(|a| a.contains("password")));
        // mysql: dump nạp qua STDIN
        let (prog, args, stdin) = external_restore_cmd("mysql", &t, "/tmp/b.sql").unwrap();
        assert_eq!(prog, "mysql");
        assert!(args.iter().any(|a| a == "app"));
        assert_eq!(stdin.as_deref(), Some("/tmp/b.sql"));
        // clickhouse: RESTORE DATABASE … FROM Disk
        let (prog, args, _) = external_restore_cmd("clickhouse", &t, "bkp").unwrap();
        assert_eq!(prog, "clickhouse-client");
        assert!(args.iter().any(|a| a.contains("RESTORE DATABASE app FROM Disk('backups', 'bkp')")));
        // sqlite / unsupported → None
        assert!(external_restore_cmd("sqlite", &t, "x").is_none());
        assert!(external_restore_cmd("redis", &t, "x").is_none());
    }

    #[test]
    fn mongodump_cmd_shape() {
        let t = BackupTarget { host: "10.0.0.1".into(), port: 27017, database: "app".into(), user: "u".into() };
        let (prog, args) = external_backup_cmd("mongodb", &t, "/tmp/a.archive").unwrap();
        assert_eq!(prog, "mongodump");
        assert!(args.windows(2).any(|w| w == ["--db", "app"]));
        assert!(args.iter().any(|a| a == "--archive=/tmp/a.archive"));
        assert!(args.windows(2).any(|w| w == ["--username", "u"]));
        assert!(!args.iter().any(|a| a.contains("password")), "mật khẩu không nằm trong args");
        // restore mirrors host/port/username + archive
        let (rprog, rargs) = mongo_restore_cmd(&t, "/tmp/a.archive");
        assert_eq!(rprog, "mongorestore");
        assert!(rargs.iter().any(|a| a == "--archive=/tmp/a.archive"));
    }

    #[test]
    fn pg_dump_cmd_has_db_and_dest_no_password() {
        let (prog, args) = external_backup_cmd("postgres", &tgt(), "/tmp/a.sql").unwrap();
        assert_eq!(prog, "pg_dump");
        assert!(args.windows(2).any(|w| w == ["-d", "app"]));
        assert!(args.windows(2).any(|w| w == ["-f", "/tmp/a.sql"]));
        assert!(!args.iter().any(|a| a.contains("password")), "mật khẩu không nằm trong args");
    }

    #[test]
    fn mysqldump_cmd_shape() {
        let (prog, args) = external_backup_cmd("mysql", &tgt(), "/tmp/a.sql").unwrap();
        assert_eq!(prog, "mysqldump");
        assert!(args.iter().any(|a| a == "app"));
        assert!(args.iter().any(|a| a == "--result-file=/tmp/a.sql"));
    }

    #[test]
    fn sqlite_has_no_external_cmd() {
        assert!(external_backup_cmd("sqlite", &tgt(), "/tmp/a.sql").is_none());
    }

    #[test]
    fn mssql_native_sql_shape() {
        // MSSQL uses in-process T-SQL, not an external tool.
        assert_eq!(backup_tool("mssql"), None);
        assert_eq!(restore_tool("mssql"), None);
        let b = mssql_backup_sql("app", "/var/opt/mssql/app.bak");
        assert!(b.starts_with("BACKUP DATABASE [app] TO DISK = N'/var/opt/mssql/app.bak'"));
        assert!(b.contains("WITH FORMAT, INIT"));
        let r = mssql_restore_sql("app", "/var/opt/mssql/app.bak");
        assert!(r.starts_with("RESTORE DATABASE [app] FROM DISK = N'/var/opt/mssql/app.bak'"));
        assert!(r.contains("WITH REPLACE"));
        // identifier ] and literal ' are escaped
        assert_eq!(mssql_ident("a]b"), "[a]]b]");
        assert!(mssql_backup_sql("d", "o'brien.bak").contains("N'o''brien.bak'"));
    }

    #[test]
    fn oracle_datapump_shape() {
        assert_eq!(backup_tool("oracle"), Some("expdp"));
        assert_eq!(restore_tool("oracle"), Some("impdp"));
        let t = BackupTarget { host: "db.host".into(), port: 1521, database: "ORCLPDB1".into(), user: "APP".into() };
        assert_eq!(oracle_dir_sql("DBSTUDIO_DUMP", "/u01/dump"), "CREATE OR REPLACE DIRECTORY \"DBSTUDIO_DUMP\" AS '/u01/dump'");
        let (prog, args) = oracle_expdp_cmd(&t, "DBSTUDIO_DUMP", "app.dmp", "app.log");
        assert_eq!(prog, "expdp");
        assert_eq!(args[0], "APP@//db.host:1521/ORCLPDB1"); // service = database; no password in argv
        assert!(args.iter().any(|a| a == "SCHEMAS=APP"));
        assert!(args.iter().any(|a| a == "DIRECTORY=DBSTUDIO_DUMP"));
        assert!(args.iter().any(|a| a == "DUMPFILE=app.dmp"));
        assert!(!args.iter().any(|a| a.to_lowercase().contains("password")), "password must not be in argv");
        let (iprog, iargs) = oracle_impdp_cmd(&t, "DBSTUDIO_DUMP", "app.dmp", "app.log");
        assert_eq!(iprog, "impdp");
        assert!(iargs.iter().any(|a| a == "TABLE_EXISTS_ACTION=REPLACE"));
    }
}
