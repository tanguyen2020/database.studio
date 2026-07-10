//! IPC commands cho Cassandra (Phase 4b). CQL execute (paging + warnings),
//! keyspace tree, ring topology, DDL viewer. Metadata lấy từ system_schema /
//! system tables thật (không mock).

use tauri::State;

use crate::drivers::cassandra::{CassKeyspaceTree, RingNode};
use crate::drivers::types::QueryResultSet;
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_cassandra() -> QueryError {
    QueryError::new("cassandra", "Connection is not Cassandra", "not a cassandra connection")
}

/// Kết quả execute CQL — giống contract của SQL editor + paging token & warnings.
#[derive(serde::Serialize)]
pub struct CqlExecResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<QueryResultSet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<QueryError>,
    pub duration_ms: u64,
    /// Base64 paging token cho trang kế (None = hết trang).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_page: Option<String>,
    /// Cảnh báo từ server (vd ALLOW FILTERING).
    pub warnings: Vec<String>,
}

/// Execute một câu CQL. `page_token` (base64) để lấy trang kế qua paging state.
#[tauri::command]
pub async fn cql_exec(
    state: State<'_, AppState>,
    conn_id: String,
    cql: String,
    page_size: Option<i32>,
    page_token: Option<String>,
    consistency: Option<String>,
) -> Result<CqlExecResponse, AppError> {
    let started = std::time::Instant::now();
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Cassandra(c) => {
                    c.exec_cql_c(&cql, page_size, page_token.as_deref(), consistency.as_deref()).await
                }
                _ => Err(not_cassandra()),
            }
        })
        .await?;
    let duration_ms = started.elapsed().as_millis() as u64;

    Ok(match inner {
        Ok(o) => {
            use crate::drivers::types::StatementOutcome;
            let result = match o.outcome {
                StatementOutcome::Rows { result } => Some(result),
                _ => None,
            };
            CqlExecResponse {
                ok: true,
                result,
                error: None,
                duration_ms,
                next_page: o.next_page,
                warnings: o.warnings,
            }
        }
        Err(e) => CqlExecResponse {
            ok: false,
            result: None,
            error: Some(e),
            duration_ms,
            next_page: None,
            warnings: Vec::new(),
        },
    })
}

/// Danh sách keyspace do người dùng tạo (loại system_*).
#[tauri::command]
pub async fn cassandra_keyspaces(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<String>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Cassandra(c) => c.keyspaces().await,
                _ => Err(not_cassandra()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Cây đầy đủ của một keyspace: tables/MV/UDT/UDF/indexes + replication.
#[tauri::command]
pub async fn cassandra_tree(
    state: State<'_, AppState>,
    conn_id: String,
    keyspace: String,
) -> Result<CassKeyspaceTree, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Cassandra(c) => c.keyspace_tree(&keyspace).await,
                _ => Err(not_cassandra()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Ring topology thật từ system.local + system.peers.
#[tauri::command]
pub async fn cassandra_ring(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<RingNode>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Cassandra(c) => c.ring().await,
                _ => Err(not_cassandra()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// DDL viewer cho object bất kỳ trong keyspace (table/view/type/index/function/
/// aggregate) — dựng lại từ system_schema.* (read-only, không có SHOW trong CQL).
#[tauri::command]
pub async fn cassandra_object_ddl(
    state: State<'_, AppState>,
    conn_id: String,
    keyspace: String,
    kind: String,
    name: String,
) -> Result<String, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Cassandra(c) => c.object_ddl(&keyspace, &kind, &name).await,
                _ => Err(not_cassandra()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Cột của một bảng/MV Cassandra (partition_key/clustering/regular/static) — cho
/// editable data viewer (lấy primary key) + property panel.
#[tauri::command]
pub async fn cassandra_columns(
    state: State<'_, AppState>,
    conn_id: String,
    keyspace: String,
    table: String,
) -> Result<Vec<crate::drivers::cassandra::CassColumn>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Cassandra(c) => c.columns_public(&keyspace, &table).await,
                _ => Err(not_cassandra()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// CQL `CREATE TABLE` native sinh từ metadata (composite PK, clustering order).
#[tauri::command]
pub async fn cassandra_table_ddl(
    state: State<'_, AppState>,
    conn_id: String,
    keyspace: String,
    table: String,
) -> Result<String, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Cassandra(c) => c.table_ddl(&keyspace, &table).await,
                _ => Err(not_cassandra()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}
