//! IPC commands cho SQLite file header + PRAGMA panel (Phase 2).

use tauri::State;

use crate::drivers::sqlite::SqliteFileInfo;
use crate::drivers::LiveConnection;
use crate::error::AppError;
use crate::state::AppState;

macro_rules! with_sqlite {
    ($state:expr, $conn_id:expr, $drv:ident, $body:expr) => {{
        let out = $state
            .registry
            .with_driver(&$conn_id, |driver| async move {
                let mut guard = driver.lock().await;
                match &mut *guard {
                    LiveConnection::Sqlite($drv) => $body,
                    _ => Err(crate::error::QueryError::new(
                        "sqlite",
                        "Connection này không phải SQLite",
                        "",
                    )),
                }
            })
            .await?;
        out.map_err(|e| AppError::Driver(e.message))
    }};
}

#[tauri::command]
pub async fn sqlite_file_info(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<SqliteFileInfo, AppError> {
    with_sqlite!(state, conn_id, drv, drv.file_info().await)
}

#[tauri::command]
pub async fn sqlite_set_pragma(
    state: State<'_, AppState>,
    conn_id: String,
    key: String,
    value: String,
) -> Result<SqliteFileInfo, AppError> {
    with_sqlite!(state, conn_id, drv, {
        drv.set_pragma(&key, &value).await?;
        drv.file_info().await
    })
}

#[tauri::command]
pub async fn sqlite_integrity_check(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<String>, AppError> {
    with_sqlite!(state, conn_id, drv, drv.integrity_check().await)
}
