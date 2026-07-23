//! Backup & Restore commands (Phase 5 · T22). SQLite chạy in-process (rusqlite
//! backup API — round-trip đảm bảo). Các hệ khác shell ra pg_dump/mysqldump/
//! clickhouse-client; phát hiện thiếu binary → báo lỗi rõ ràng.

use serde::Serialize;
use tauri::State;

use crate::storage::crypto;
use crate::drivers::backup::{
    backup_tool, external_backup_cmd, external_restore_cmd, mongo_restore_cmd,
    mssql_backup_sql, mssql_restore_sql, oracle_dir_sql, oracle_expdp_cmd, oracle_impdp_cmd,
    restore_tool, BackupTarget,
};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_sqlite() -> QueryError {
    QueryError::new("sqlite", "Connection is not SQLite", "not sqlite")
}

/// Write the MongoDB password to a temp `--config` YAML so it stays OFF the
/// process argv (mongodump/mongorestore have no password env var). The caller
/// removes the file right after the tool exits.
fn mongo_pw_config(password: &str) -> Result<std::path::PathBuf, AppError> {
    use std::io::Write;
    let mut path = std::env::temp_dir();
    path.push(format!("ds-mongo-{}.yaml", std::process::id()));
    let mut f = std::fs::File::create(&path)
        .map_err(|e| AppError::Driver(format!("temp config: {e}")))?;
    writeln!(f, "password: {password}").map_err(|e| AppError::Driver(format!("temp config: {e}")))?;
    Ok(path)
}

/// Kiểm tra binary backup có trên PATH không (chạy `<tool> --version`).
fn tool_available(tool: &str) -> bool {
    std::process::Command::new(tool)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run an Oracle Data Pump tool (expdp/impdp) feeding the password on STDIN so it
/// never appears in the process arguments (Data Pump has no password env var).
async fn run_datapump(prog: &str, args: &[String], password: &str) -> Result<(), AppError> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    if !tool_available(prog) {
        return Err(AppError::Driver(format!(
            "`{prog}` not found on PATH — install the Oracle Instant Client Tools (Data Pump) and try again."
        )));
    }
    let mut child = tokio::process::Command::new(prog)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Driver(format!("Failed to run {prog}: {e}")))?;
    if let Some(mut sin) = child.stdin.take() {
        let _ = sin.write_all(format!("{password}\n").as_bytes()).await;
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Driver(format!("{prog} failed: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Driver(format!("{prog} error: {}", String::from_utf8_lossy(&out.stderr))));
    }
    Ok(())
}

/// Split a dump path into (server os-dir, dumpfile, logfile) for a Data Pump
/// DIRECTORY object + DUMPFILE. Note: the dir must be reachable on the DB SERVER.
fn datapump_paths(p: &str) -> (String, String, String) {
    let path = std::path::Path::new(p);
    let os_dir = path
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| ".".into());
    let dumpfile = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "dbstudio.dmp".into());
    let logfile = format!("{dumpfile}.log");
    (os_dir, dumpfile, logfile)
}

#[derive(Serialize)]
pub struct BackupToolStatus {
    /// Tên công cụ (hoặc "(in-process)" cho SQLite); None nếu hệ không hỗ trợ.
    pub tool: Option<String>,
    pub available: bool,
}

#[tauri::command]
pub async fn backup_tool_status(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<BackupToolStatus, AppError> {
    let system = state
        .storage
        .get_connection(&conn_id)
        .map(|p| p.system.as_str().to_string())
        .unwrap_or_default();
    if system == "sqlite" {
        return Ok(BackupToolStatus { tool: Some("(in-process)".into()), available: true });
    }
    // MSSQL runs native BACKUP/RESTORE through the app's own connection — no binary.
    if system == "mssql" {
        return Ok(BackupToolStatus { tool: Some("(via connection)".into()), available: true });
    }
    let tool = backup_tool(&system);
    Ok(BackupToolStatus {
        tool: tool.map(String::from),
        available: tool.map(tool_available).unwrap_or(false),
    })
}

#[tauri::command]
pub async fn backup_database(
    state: State<'_, AppState>,
    conn_id: String,
    dest: String,
) -> Result<String, AppError> {
    let profile = state
        .storage
        .get_connection(&conn_id)
        .map_err(|e| AppError::Driver(format!("connection: {e}")))?;
    let system = profile.system.as_str().to_string();

    if system == "sqlite" {
        let dest2 = dest.clone();
        state
            .registry
            .with_driver(&conn_id, move |d| async move {
                let g = d.lock().await;
                match &*g {
                    LiveConnection::Sqlite(s) => s.backup_to(dest2).await,
                    _ => Err(not_sqlite()),
                }
            })
            .await?
            .map_err(|e| AppError::Driver(e.message))?;
        return Ok(format!("✓ SQLite backup → {dest}"));
    }

    // MSSQL: native T-SQL BACKUP DATABASE run through the app's own connection (no
    // external tool). The .bak file lands on the SQL Server host (server-side path).
    if system == "mssql" {
        let sql = mssql_backup_sql(&profile.database, &dest);
        state
            .registry
            .exec_statement(&conn_id, sql)
            .await?
            .map_err(|e| AppError::Driver(e.message))?;
        return Ok(format!("✓ MSSQL backup → {dest} (on the SQL Server host)"));
    }

    // Oracle: Data Pump export — create a DIRECTORY object mapping to the dump's
    // dir (must be reachable on the DB server), then run expdp (password on STDIN).
    if system == "oracle" {
        let (os_dir, dumpfile, logfile) = datapump_paths(&dest);
        let dir_name = "DBSTUDIO_DUMP";
        state
            .registry
            .exec_statement(&conn_id, oracle_dir_sql(dir_name, &os_dir))
            .await?
            .map_err(|e| AppError::Driver(e.message))?;
        let target = BackupTarget {
            host: profile.host.clone(),
            port: profile.port,
            database: profile.database.clone(),
            user: profile.user.clone(),
        };
        let (prog, args) = oracle_expdp_cmd(&target, dir_name, &dumpfile, &logfile);
        let password = crypto::decrypt(&profile.password_enc).unwrap_or_default();
        run_datapump(&prog, &args, &password).await?;
        return Ok(format!("✓ Oracle Data Pump export → {dumpfile} in {os_dir} (on the DB server)"));
    }

    let tool = backup_tool(&system)
        .ok_or_else(|| AppError::Driver(format!("Backup is not supported for {system}")))?;
    if !tool_available(tool) {
        return Err(AppError::Driver(format!(
            "`{tool}` not found on PATH — install the tool and try again."
        )));
    }
    let (prog, mut args) = external_backup_cmd(
        &system,
        &BackupTarget {
            host: profile.host.clone(),
            port: profile.port,
            database: profile.database.clone(),
            user: profile.user.clone(),
        },
        &dest,
    )
    .ok_or_else(|| AppError::Driver(format!("Backup is not supported for {system}")))?;
    let password = crypto::decrypt(&profile.password_enc).unwrap_or_default();
    // mongodump has no password env var → write it to a temp --config file so it
    // stays off the process argv; removed right after the tool exits.
    let mongo_cfg = if system == "mongodb" && !password.is_empty() {
        let p = mongo_pw_config(&password)?;
        args.push(format!("--config={}", p.display()));
        Some(p)
    } else {
        None
    };
    let out = tokio::process::Command::new(&prog)
        .args(&args)
        .env("PGPASSWORD", &password)
        .env("MYSQL_PWD", &password)
        .output()
        .await;
    if let Some(p) = mongo_cfg {
        let _ = std::fs::remove_file(p);
    }
    let out = out.map_err(|e| AppError::Driver(format!("Failed to run {prog}: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Driver(format!(
            "{prog} error: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    Ok(format!("✓ {system} backup ({prog}) → {dest}"))
}

#[tauri::command]
pub async fn restore_database(
    state: State<'_, AppState>,
    conn_id: String,
    src: String,
) -> Result<String, AppError> {
    let system = state
        .storage
        .get_connection(&conn_id)
        .map(|p| p.system.as_str().to_string())
        .unwrap_or_default();
    if system == "sqlite" {
        let src2 = src.clone();
        state
            .registry
            .with_driver(&conn_id, move |d| async move {
                let g = d.lock().await;
                match &*g {
                    LiveConnection::Sqlite(s) => s.restore_from(src2).await,
                    _ => Err(not_sqlite()),
                }
            })
            .await?
            .map_err(|e| AppError::Driver(e.message))?;
        return Ok(format!("✓ SQLite restored ← {src}"));
    }
    // MSSQL: native RESTORE DATABASE via the app's own connection. Requires the DB
    // not be in active use (may need single-user / a master connection); .bak is server-side.
    if system == "mssql" {
        let profile = state
            .storage
            .get_connection(&conn_id)
            .map_err(|e| AppError::Driver(format!("connection: {e}")))?;
        let sql = mssql_restore_sql(&profile.database, &src);
        state
            .registry
            .exec_statement(&conn_id, sql)
            .await?
            .map_err(|e| AppError::Driver(e.message))?;
        return Ok(format!("✓ MSSQL restored ← {src} (from the SQL Server host)"));
    }
    // Oracle: Data Pump import (impdp) — mirror of the export path.
    if system == "oracle" {
        let profile = state
            .storage
            .get_connection(&conn_id)
            .map_err(|e| AppError::Driver(format!("connection: {e}")))?;
        let (os_dir, dumpfile, logfile) = datapump_paths(&src);
        let dir_name = "DBSTUDIO_DUMP";
        state
            .registry
            .exec_statement(&conn_id, oracle_dir_sql(dir_name, &os_dir))
            .await?
            .map_err(|e| AppError::Driver(e.message))?;
        let target = BackupTarget {
            host: profile.host.clone(),
            port: profile.port,
            database: profile.database.clone(),
            user: profile.user.clone(),
        };
        let (prog, args) = oracle_impdp_cmd(&target, dir_name, &dumpfile, &logfile);
        let password = crypto::decrypt(&profile.password_enc).unwrap_or_default();
        run_datapump(&prog, &args, &password).await?;
        return Ok(format!("✓ Oracle Data Pump import ← {dumpfile} in {os_dir}"));
    }
    // MongoDB: mongorestore từ file archive do mongodump tạo.
    if system == "mongodb" {
        if !tool_available("mongorestore") {
            return Err(AppError::Driver(
                "`mongorestore` not found on PATH — install the MongoDB Database Tools and try again.".into(),
            ));
        }
        let profile = state
            .storage
            .get_connection(&conn_id)
            .map_err(|e| AppError::Driver(format!("connection: {e}")))?;
        let (prog, mut args) = mongo_restore_cmd(
            &BackupTarget {
                host: profile.host.clone(),
                port: profile.port,
                database: profile.database.clone(),
                user: profile.user.clone(),
            },
            &src,
        );
        let password = crypto::decrypt(&profile.password_enc).unwrap_or_default();
        let mongo_cfg = if !password.is_empty() {
            let p = mongo_pw_config(&password)?;
            args.push(format!("--config={}", p.display()));
            Some(p)
        } else {
            None
        };
        let out = tokio::process::Command::new(&prog).args(&args).output().await;
        if let Some(p) = mongo_cfg {
            let _ = std::fs::remove_file(p);
        }
        let out = out.map_err(|e| AppError::Driver(format!("Failed to run {prog}: {e}")))?;
        if !out.status.success() {
            return Err(AppError::Driver(format!(
                "{prog} error: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        return Ok(format!("✓ MongoDB restored ({prog}) ← {src}"));
    }
    // pg/mysql/mariadb/clickhouse: restore via the external client tool (symmetric
    // with backup). psql reads -f <file>; mysql reads the dump from STDIN.
    if let Some(tool) = restore_tool(&system) {
        if !tool_available(tool) {
            return Err(AppError::Driver(format!(
                "`{tool}` not found on PATH — install the client tool and try again."
            )));
        }
        let profile = state
            .storage
            .get_connection(&conn_id)
            .map_err(|e| AppError::Driver(format!("connection: {e}")))?;
        let (prog, args, stdin_file) = external_restore_cmd(
            &system,
            &BackupTarget {
                host: profile.host.clone(),
                port: profile.port,
                database: profile.database.clone(),
                user: profile.user.clone(),
            },
            &src,
        )
        .ok_or_else(|| AppError::Driver(format!("Restore is not supported for {system}")))?;
        let password = crypto::decrypt(&profile.password_enc).unwrap_or_default();
        let mut cmd = tokio::process::Command::new(&prog);
        cmd.args(&args).env("PGPASSWORD", &password).env("MYSQL_PWD", &password);
        if let Some(f) = stdin_file {
            let file = std::fs::File::open(&f)
                .map_err(|e| AppError::Driver(format!("cannot open {f}: {e}")))?;
            cmd.stdin(std::process::Stdio::from(file));
        }
        let out = cmd
            .output()
            .await
            .map_err(|e| AppError::Driver(format!("Failed to run {prog}: {e}")))?;
        if !out.status.success() {
            return Err(AppError::Driver(format!(
                "{prog} error: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        return Ok(format!("✓ {system} restored ({prog}) ← {src}"));
    }
    Err(AppError::Driver(format!(
        "Automatic restore is not supported for {system} — open the .sql file in the SQL editor to run it."
    )))
}
