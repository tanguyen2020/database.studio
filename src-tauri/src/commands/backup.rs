//! Backup & Restore commands (Phase 5 · T22). SQLite chạy in-process (rusqlite
//! backup API — round-trip đảm bảo). Các hệ khác shell ra pg_dump/mysqldump/
//! clickhouse-client; phát hiện thiếu binary → báo lỗi rõ ràng.

use serde::Serialize;
use tauri::State;

use crate::storage::crypto;
use crate::drivers::backup::{backup_tool, external_backup_cmd, BackupTarget};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_sqlite() -> QueryError {
    QueryError::new("sqlite", "Connection is not SQLite", "not sqlite")
}

/// Kiểm tra binary backup có trên PATH không (chạy `<tool> --version`).
fn tool_available(tool: &str) -> bool {
    std::process::Command::new(tool)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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

    let tool = backup_tool(&system)
        .ok_or_else(|| AppError::Driver(format!("Backup is not supported for {system}")))?;
    if !tool_available(tool) {
        return Err(AppError::Driver(format!(
            "`{tool}` not found on PATH — install the tool and try again."
        )));
    }
    let (prog, args) = external_backup_cmd(
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
    let out = tokio::process::Command::new(&prog)
        .args(&args)
        .env("PGPASSWORD", &password)
        .env("MYSQL_PWD", &password)
        .output()
        .await
        .map_err(|e| AppError::Driver(format!("Failed to run {prog}: {e}")))?;
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
    Err(AppError::Driver(format!(
        "Automatic restore is not supported for {system} — open the .sql file in the SQL editor to run it."
    )))
}
