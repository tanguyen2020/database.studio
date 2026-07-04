//! IPC commands cho ClickHouse nâng cao (Phase 5 · T7c): engine + TTL viewer.

use tauri::State;

use crate::drivers::clickhouse::ChTableMeta;
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_ch() -> QueryError {
    QueryError::new("clickhouse", "Connection không phải ClickHouse", "not clickhouse")
}

/// Dictionaries của một database (Explorer tree §3 — clickhouseTree).
#[tauri::command]
pub async fn ch_dictionaries(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<String>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Clickhouse(c) => c.dictionaries(&schema).await,
                _ => Err(not_ch()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Engine + TTL rules + create SQL của một bảng ClickHouse (cho TTL viewer + badge).
#[tauri::command]
pub async fn ch_table_meta(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
) -> Result<ChTableMeta, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Clickhouse(c) => c.table_meta(&schema, &table).await,
                _ => Err(not_ch()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}
