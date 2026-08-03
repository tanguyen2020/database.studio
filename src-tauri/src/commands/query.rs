//! IPC commands: statement execution + cancel + history logging.
//!
//! The editor splits the document into statements (it owns line offsets for
//! error mapping); each statement arrives here individually and returns the
//! locked contract shape `{ ok, result?, affected?, error?, duration_ms }`.

use serde::Serialize;
use tauri::State;

use crate::drivers::types::{ColumnDef, ExecResponse};
use crate::error::AppError;
use crate::state::AppState;

/// Rows per chunk on the streaming path. Small enough that parsing one chunk on
/// the webview's single UI thread is imperceptible, large enough that a million
/// rows don't cost a million IPC messages.
const CHUNK_ROWS: usize = 2_000;

/// Engine of a connection, resolved from the live registry first (sub-connections
/// and quick-connects aren't in storage) so error hints match the real dialect.
fn system_of(state: &AppState, conn_id: &str) -> String {
    state
        .registry
        .system_of(conn_id)
        .or_else(|| state.storage.get_connection(conn_id).ok().map(|p| p.system.as_str().to_string()))
        .unwrap_or_else(|| "unknown".into())
}

/// Query history (Phase-2 panel reads this).
fn log_history(state: &AppState, conn_id: &str, system: &str, sql: &str, r: &ExecResponse, total: Option<u64>) {
    let _ = state.storage.add_history(
        conn_id,
        system,
        sql,
        Some(r.duration_ms),
        total.or(r.affected),
        r.ok,
        r.error.as_ref().map(|e| e.message.as_str()),
    );
}

#[tauri::command]
pub async fn exec_statement(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
    statement_index: Option<usize>,
) -> Result<ExecResponse, AppError> {
    let started = std::time::Instant::now();
    let system = system_of(&state, &conn_id);

    let outcome = state.registry.exec_statement(&conn_id, sql.clone()).await?;
    let duration_ms = started.elapsed().as_millis() as u64;

    let response = match outcome {
        Ok(o) => ExecResponse::from_outcome(o, duration_ms),
        Err(mut qe) => {
            qe.statement_index = statement_index;
            ExecResponse::from_error(qe, duration_ms)
        }
    };

    let total = response.result.as_ref().map(|r| r.total);
    log_history(&state, &conn_id, &system, &sql, &response, total);

    Ok(response)
}

/// One chunk of a streamed result set.
#[derive(Serialize, Clone)]
pub struct RowChunk {
    /// Column headers — sent with the first chunk only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<Vec<ColumnDef>>,
    pub rows: Vec<serde_json::Value>,
    /// Rows delivered so far, including this chunk.
    pub received: u64,
    pub total: u64,
}

/// Same as [`exec_statement`], but a large result set is handed over in chunks on
/// `on_chunk` instead of as one giant IPC response.
///
/// A single response is what froze the app: the webview has ONE UI thread, and
/// materialising a multi-hundred-megabyte JSON payload on it blocks every tab,
/// the Explorer, and the Cancel button itself for as long as it takes — which is
/// also why Cancel appeared not to work. Chunks let the event loop breathe
/// between batches, so other tabs stay usable and Cancel is clickable; the
/// delivery loop watches the same cancel token, so pressing it stops the
/// remaining rows instead of shipping all of them anyway.
///
/// Nothing is capped or dropped: every row still arrives, just not in one go.
#[tauri::command]
pub async fn exec_statement_stream(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
    statement_index: Option<usize>,
    on_chunk: tauri::ipc::Channel<RowChunk>,
) -> Result<ExecResponse, AppError> {
    let started = std::time::Instant::now();
    let system = system_of(&state, &conn_id);
    // Armed for the whole run: the statement AND the delivery below, so Cancel
    // stops a result that is already being handed over.
    let cancel = state.registry.arm_cancel(&conn_id);

    let outcome = state.registry.exec_statement(&conn_id, sql.clone()).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    let outcome = match outcome {
        Ok(o) => o,
        Err(e) => {
            state.registry.disarm_cancel(&conn_id);
            return Err(e);
        }
    };

    let mut response = match outcome {
        Ok(o) => ExecResponse::from_outcome(o, duration_ms),
        Err(mut qe) => {
            qe.statement_index = statement_index;
            ExecResponse::from_error(qe, duration_ms)
        }
    };

    let total = response.result.as_ref().map(|r| r.total);
    let mut delivered = Ok(());
    if let Some(rs) = response.result.as_mut() {
        if rs.rows.len() > CHUNK_ROWS {
            let rows = std::mem::take(&mut rs.rows);
            let total = rows.len() as u64;
            let mut cols = Some(rs.cols.clone());
            let mut received = 0u64;
            let mut it = rows.into_iter();
            loop {
                if cancel.is_cancelled() {
                    delivered = Err(crate::drivers::cancel::cancelled_error(&system));
                    break;
                }
                let batch: Vec<serde_json::Value> = it.by_ref().take(CHUNK_ROWS).collect();
                if batch.is_empty() {
                    break;
                }
                received += batch.len() as u64;
                if on_chunk
                    .send(RowChunk { cols: cols.take(), rows: batch, received, total })
                    .is_err()
                {
                    // Webview gone (tab/window closed) — stop shipping rows.
                    break;
                }
                // Hand the runtime back so Cancel and other tabs' commands run.
                tokio::task::yield_now().await;
            }
            response.streamed = true;
        }
    }

    state.registry.disarm_cancel(&conn_id);

    // Cancelled mid-delivery: report it as the cancelled statement it is, so the
    // frontend discards the partial rows instead of showing a truncated result.
    if let Err(mut qe) = delivered {
        qe.statement_index = statement_index;
        response = ExecResponse::from_error(qe, duration_ms);
    }

    log_history(&state, &conn_id, &system, &sql, &response, total);

    Ok(response)
}

#[derive(Serialize)]
pub struct CancelResult {
    pub cancelled: bool,
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, conn_id: String) -> Result<CancelResult, AppError> {
    Ok(CancelResult { cancelled: state.registry.cancel(&conn_id) })
}
