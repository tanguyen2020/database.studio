//! IPC command cho MongoDB — execute một câu mongosh-style (`db.coll.find({...})`,
//! aggregate, count/distinct, insert/update/delete). Giống contract SQL editor +
//! cursor token & warnings (mirror `cql_exec` của Cassandra).

use tauri::State;

use crate::drivers::types::{QueryResultSet, StatementOutcome};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_mongo() -> QueryError {
    QueryError::new("mongodb", "Connection is not MongoDB", "not a mongodb connection")
}

#[derive(serde::Serialize)]
pub struct MongoExecResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<QueryResultSet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<QueryError>,
    pub duration_ms: u64,
    /// Cursor token cho trang kế (None trong M2 — paging vào M3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn mongo_exec(
    state: State<'_, AppState>,
    conn_id: String,
    query: String,
    batch_size: Option<i32>,
    cursor_token: Option<String>,
) -> Result<MongoExecResponse, AppError> {
    let started = std::time::Instant::now();
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Mongo(m) => {
                    m.exec_mongo(&query, batch_size, cursor_token.as_deref()).await
                }
                _ => Err(not_mongo()),
            }
        })
        .await?;
    let duration_ms = started.elapsed().as_millis() as u64;

    Ok(match inner {
        Ok(o) => {
            let (result, affected) = match o.outcome {
                StatementOutcome::Rows { result } => (Some(result), None),
                StatementOutcome::Affected { affected } => (None, Some(affected)),
                StatementOutcome::Ok => (None, None),
            };
            MongoExecResponse {
                ok: true,
                result,
                affected,
                error: None,
                duration_ms,
                next_cursor: o.next_cursor,
                warnings: o.warnings,
            }
        }
        Err(e) => MongoExecResponse {
            ok: false,
            result: None,
            affected: None,
            error: Some(e),
            duration_ms,
            next_cursor: None,
            warnings: Vec::new(),
        },
    })
}
