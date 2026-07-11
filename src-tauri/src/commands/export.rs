//! Streaming export (T24) — stream a query straight to a file, one row at a
//! time, so peak memory stays bounded regardless of result size. Progress is
//! pushed over a Tauri Channel; cancel_export flips a flag the loop checks.
//! Guarded on the frontend by the `streaming_io` setting; the old in-memory
//! Blob path stays as the fallback.

use std::io::{BufWriter, Write};

use tauri::State;

use crate::drivers::postgres::ExportFormat;
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

#[tauri::command]
pub async fn export_query_to_file(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
    path: String,
    format: String,
    table: Option<String>,
    database: Option<String>,
    export_id: String,
    on_progress: tauri::ipc::Channel<u64>,
) -> Result<u64, AppError> {
    let fmt = ExportFormat::parse(&format)
        .ok_or_else(|| AppError::Driver(format!("Unsupported export format: {format}")))?;
    let table = table.unwrap_or_else(|| "export".into());
    let cancel = state.export_cancels.register(export_id.clone());

    let result = state
        .registry
        .with_driver(&conn_id, |driver| async move {
            let file = std::fs::File::create(&path)
                .map_err(|e| QueryError::new("export", format!("cannot create file: {e}"), e.to_string()))?;
            let mut w = BufWriter::new(file);
            let mut d = driver.lock().await;
            let total = match &mut *d {
                LiveConnection::Postgres(pg) => {
                    pg.stream_export(&sql, fmt, &table, &mut w, |n| {
                        let _ = on_progress.send(n);
                    }, &cancel)
                    .await?
                }
                LiveConnection::Clickhouse(ch) => {
                    ch.stream_export(&sql, fmt, &table, &mut w, |n| {
                        let _ = on_progress.send(n);
                    }, &cancel)
                    .await?
                }
                LiveConnection::Mongo(m) => {
                    m.stream_export(database.as_deref(), &sql, fmt, &mut w, |n| {
                        let _ = on_progress.send(n);
                    }, &cancel)
                    .await?
                }
                _ => {
                    return Err(QueryError::new(
                        "export",
                        "Streaming export currently supports PostgreSQL, ClickHouse and MongoDB",
                        "unsupported",
                    ))
                }
            };
            w.flush()
                .map_err(|e| QueryError::new("export", format!("flush error: {e}"), e.to_string()))?;
            Ok(total)
        })
        .await;

    state.export_cancels.remove(&export_id);
    result?.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn cancel_export(state: State<'_, AppState>, export_id: String) -> Result<(), AppError> {
    state.export_cancels.cancel(&export_id);
    Ok(())
}
