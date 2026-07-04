//! IPC commands: Object Explorer introspection. Each command locks the live
//! driver and returns typed catalog data (queries are parameterized inside
//! each driver — identifiers only ever pass through dialect-safe quoting).

use tauri::State;

use crate::drivers::types::*;
use crate::error::AppError;
use crate::state::AppState;

macro_rules! introspect {
    ($state:expr, $conn_id:expr, $call:expr) => {{
        let out = $state.registry.with_driver(&$conn_id, $call).await?;
        out.map_err(|e| AppError::Driver(e.message))
    }};
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<SchemaInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.schemas().await
    })
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<TableInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.tables(&schema).await
    })
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
) -> Result<Vec<ColumnInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.columns(&schema, &table).await
    })
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
) -> Result<Vec<IndexInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.indexes(&schema, &table).await
    })
}

#[tauri::command]
pub async fn list_constraints(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
) -> Result<Vec<ConstraintInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.constraints(&schema, &table).await
    })
}

#[tauri::command]
pub async fn list_routines(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<RoutineInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.routines(&schema).await
    })
}

#[tauri::command]
pub async fn list_triggers(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<TriggerInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.triggers(&schema).await
    })
}

#[tauri::command]
pub async fn list_sequences(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<SequenceInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.sequences(&schema).await
    })
}

#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<ForeignKey>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.foreign_keys(&schema).await
    })
}

#[tauri::command]
pub async fn scan_indexes(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<crate::drivers::index_scan::IndexScanResult, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.scan_indexes(&schema).await
    })
}
