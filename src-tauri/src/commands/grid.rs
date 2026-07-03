//! IPC commands cho editable grid: preview SQL (dry-run, không chạy) + apply
//! (transaction). Statement tham số hóa trong driver — không nối chuỗi param.

use tauri::State;

use crate::drivers::grid::{self, GridChange};
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
