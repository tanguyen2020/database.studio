//! Backup command builder (Phase 5 · T22) — pure (không I/O) → unit-test được.
//! SQLite backup/restore chạy in-process qua rusqlite; các hệ khác shell ra công
//! cụ ngoài (pg_dump/mysqldump/clickhouse-client) — builder ở đây dựng lệnh.

/// Công cụ backup ngoài theo hệ (None = xử lý in-process hoặc chưa hỗ trợ).
pub fn backup_tool(system: &str) -> Option<&'static str> {
    match system {
        "postgres" => Some("pg_dump"),
        "mysql" | "mariadb" => Some("mysqldump"),
        "clickhouse" => Some("clickhouse-client"),
        _ => None, // sqlite = in-process; redis/kafka/nats/cassandra = N/A
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
        _ => None,
    }
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
        assert_eq!(backup_tool("sqlite"), None);
        assert_eq!(backup_tool("redis"), None);
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
}
