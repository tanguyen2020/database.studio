//! IPC commands: statement execution + cancel + history logging.
//!
//! The editor splits the document into statements (it owns line offsets for
//! error mapping); each statement arrives here individually and returns the
//! locked contract shape `{ ok, result?, affected?, error?, duration_ms }`.

use serde::Serialize;
use tauri::State;

use crate::drivers::types::ExecResponse;
use crate::error::AppError;
use crate::state::AppState;

#[tauri::command]
pub async fn exec_statement(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
    statement_index: Option<usize>,
) -> Result<ExecResponse, AppError> {
    let started = std::time::Instant::now();
    let system = state
        .storage
        .get_connection(&conn_id)
        .map(|p| p.system.as_str().to_string())
        .unwrap_or_else(|_| "unknown".into());

    let outcome = state.registry.exec_statement(&conn_id, sql.clone()).await?;
    let duration_ms = started.elapsed().as_millis() as u64;

    let response = match outcome {
        Ok(o) => ExecResponse::from_outcome(o, duration_ms),
        Err(mut qe) => {
            qe.statement_index = statement_index;
            ExecResponse::from_error(qe, duration_ms)
        }
    };

    // Query history (Phase-2 panel reads this; logging starts now).
    let row_count = response
        .result
        .as_ref()
        .map(|r| r.total)
        .or(response.affected);
    let _ = state.storage.add_history(
        &conn_id,
        &system,
        &sql,
        Some(duration_ms),
        row_count,
        response.ok,
        response.error.as_ref().map(|e| e.message.as_str()),
    );

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
