//! IPC commands for Elasticsearch (REST API). Each command clones the
//! connection's HTTP client out of the registry (`es_driver`) and makes its round
//! trip without holding the connection lock.
//!
//! `es_request` is the generic, full-surface call (Dev Tools console and every
//! management screen are built on it); the typed reads below are what the
//! explorer needs on each refresh.

use tauri::State;

use crate::drivers::elasticsearch::{EsIndex, EsOverview, EsResponse};
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn map(e: QueryError) -> AppError {
    AppError::Driver(e.message)
}

/// Any REST call on the cluster: `method` + path relative to the cluster
/// (`/_cat/indices?v`), optional JSON / NDJSON body. A non-2xx answer is returned
/// as-is (status + Elasticsearch's error document), not as an error.
#[tauri::command]
pub async fn es_request(
    state: State<'_, AppState>,
    conn_id: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<EsResponse, AppError> {
    let d = state.registry.es_driver(&conn_id).await?;
    d.request(&method, &path, body).await.map_err(map)
}

#[tauri::command]
pub async fn es_overview(state: State<'_, AppState>, conn_id: String) -> Result<EsOverview, AppError> {
    let d = state.registry.es_driver(&conn_id).await?;
    d.overview().await.map_err(map)
}

#[tauri::command]
pub async fn es_indices(state: State<'_, AppState>, conn_id: String) -> Result<Vec<EsIndex>, AppError> {
    let d = state.registry.es_driver(&conn_id).await?;
    d.indices().await.map_err(map)
}

/// `(dotted.field.path, type)` of an index (or pattern) mapping.
#[tauri::command]
pub async fn es_mapping_fields(
    state: State<'_, AppState>,
    conn_id: String,
    index: String,
) -> Result<Vec<(String, String)>, AppError> {
    let d = state.registry.es_driver(&conn_id).await?;
    d.mapping_fields(&index).await.map_err(map)
}
