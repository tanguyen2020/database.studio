//! IPC commands cho editable grid: preview SQL (dry-run, không chạy) + apply
//! (transaction). Statement tham số hóa trong driver — không nối chuỗi param.

use tauri::State;

use serde_json::Value;

use crate::drivers::grid::{self, FilterCond, GridChange, SortSpec};
use crate::drivers::types::{ExecResponse, StatementOutcome};
use crate::error::QueryError;
use crate::drivers::LiveConnection;
use crate::error::AppError;
use crate::state::AppState;

/// Dry-run: sinh SQL literal để hiển thị trong dialog "Preview diff". Không chạy.
#[tauri::command]
pub fn preview_grid_changes(
    state: State<'_, AppState>,
    conn_id: String,
    changes: Vec<GridChange>,
) -> Result<Vec<String>, AppError> {
    let system = state
        .storage
        .get_connection(&conn_id)
        .map(|p| p.system.as_str().to_string())
        .unwrap_or_else(|_| "postgres".into());
    Ok(changes.iter().map(|c| grid::preview_sql(&system, c)).collect())
}

/// ClickHouse (SPEC_ADDENDUM §7): dịch pending changes thành mutation ASYNC
/// (`ALTER TABLE … UPDATE/DELETE`) để mở trong SQL editor review + chạy chủ động.
/// KHÔNG commit tự động — inline-edit đã tắt cho ClickHouse ở frontend.
#[tauri::command]
pub fn ch_generate_mutations(
    _state: State<'_, AppState>,
    changes: Vec<GridChange>,
) -> Result<String, AppError> {
    let header = "-- ClickHouse mutation (async — theo dõi qua system.mutations, KHÔNG commit tức thì).\n\
                  -- Review kỹ trước khi chạy; chi phí cao trên bảng lớn.\n\n";
    let body = changes.iter().map(grid::ch_mutation_sql).collect::<Vec<_>>().join("\n");
    Ok(format!("{header}{body}"))
}

/// Table Data Viewer: SELECT có filter/sort/phân trang (server-side, tham số hóa).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn exec_filtered(
    state: State<'_, AppState>,
    conn_id: String,
    schema: Option<String>,
    table: String,
    filters: Vec<FilterCond>,
    combinator_or: bool,
    sorts: Vec<SortSpec>,
    limit: u32,
    offset: u32,
) -> Result<ExecResponse, AppError> {
    // Resolve the engine from the LIVE connection first — storage has no entry for
    // attached per-database sub-connections (`{base}::{db}`) or quick-connects, and
    // defaulting to "postgres" made MSSQL emit LIMIT (→ "Incorrect syntax near '100'").
    let system = state
        .registry
        .system_of(&conn_id)
        .or_else(|| state.storage.get_connection(&conn_id).ok().map(|p| p.system.as_str().to_string()))
        .unwrap_or_else(|| "postgres".into());
    let started = std::time::Instant::now();
    // ClickHouse has no positional bind over HTTP → build a literal SELECT and run it
    // through the raw `exec` path. Every other engine keeps the parameterized path.
    let out = if system == "clickhouse" {
        let sql = grid::build_select_literal(&schema, &table, &filters, combinator_or, &sorts, limit, offset);
        state
            .registry
            .with_driver(&conn_id, move |driver| async move { driver.lock().await.exec(&sql).await })
            .await?
    } else {
        state
            .registry
            .with_driver(&conn_id, move |driver| async move {
                let mut d = driver.lock().await;
                run_filtered(&mut d, &system, &schema, &table, &filters, combinator_or, &sorts, limit, offset).await
            })
            .await?
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    Ok(match out {
        Ok(o) => ExecResponse::from_outcome(o, duration_ms),
        Err(qe) => ExecResponse::from_error(qe, duration_ms),
    })
}

/// The parameterized Table Data Viewer SELECT on one connection (every engine but
/// ClickHouse). PostgreSQL binds what a person typed as `text` and does not
/// compare text with uuid/integer/date/enum… columns on its own, so it first reads
/// the table's column types (one catalog query, only when a filter carries a
/// value) and casts each parameter to its column's type.
#[allow(clippy::too_many_arguments)]
pub async fn run_filtered(
    d: &mut LiveConnection,
    system: &str,
    schema: &Option<String>,
    table: &str,
    filters: &[FilterCond],
    combinator_or: bool,
    sorts: &[SortSpec],
    limit: u32,
    offset: u32,
) -> Result<StatementOutcome, QueryError> {
    let needs_types = system == "postgres"
        && filters.iter().any(|f| !matches!(f.op.to_uppercase().as_str(), "IS NULL" | "IS NOT NULL"));
    let types = if needs_types {
        let mut params = Vec::new();
        if let Some(s) = schema.as_ref().filter(|s| !s.is_empty()) {
            params.push(Value::String(s.clone()));
        }
        params.push(Value::String(table.to_string()));
        // A failed lookup only loses the casts — the filter still runs as before.
        match d.exec_params(grid::pg_column_types_query(schema), &params).await {
            Ok(StatementOutcome::Rows { result }) => grid::parse_pg_column_types(&result.rows),
            _ => Default::default(),
        }
    } else {
        Default::default()
    };
    let stmt = grid::build_select_typed(system, schema, table, filters, combinator_or, sorts, limit, offset, &types);
    d.exec_params(&stmt.sql, &stmt.params).await
}

/// Apply pending changes trong 1 transaction (rollback nếu lỗi). Trả tổng số dòng bị ảnh hưởng.
#[tauri::command]
pub async fn apply_grid_changes(
    state: State<'_, AppState>,
    conn_id: String,
    changes: Vec<GridChange>,
) -> Result<u64, AppError> {
    let out = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            driver.lock().await.apply_grid_changes(&changes).await
        })
        .await?;
    out.map_err(|e| AppError::Driver(e.message))
}
