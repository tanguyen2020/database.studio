//! IPC commands cho editable grid: preview SQL (dry-run, không chạy) + apply
//! (transaction). Statement tham số hóa trong driver — không nối chuỗi param.

use tauri::State;

use crate::drivers::grid::{self, FilterCond, GridChange, SortSpec};
use crate::drivers::types::ExecResponse;
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
    let system = state
        .storage
        .get_connection(&conn_id)
        .map(|p| p.system.as_str().to_string())
        .unwrap_or_else(|_| "postgres".into());
    let stmt = grid::build_select(&system, &schema, &table, &filters, combinator_or, &sorts, limit, offset);
    let started = std::time::Instant::now();
    let out = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            driver.lock().await.exec_params(&stmt.sql, &stmt.params).await
        })
        .await?;
    let duration_ms = started.elapsed().as_millis() as u64;
    Ok(match out {
        Ok(o) => ExecResponse::from_outcome(o, duration_ms),
        Err(qe) => ExecResponse::from_error(qe, duration_ms),
    })
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
