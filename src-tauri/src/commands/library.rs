//! IPC commands: Query History (Ctrl+H) + Saved Queries/Snippets (Ctrl+S).
//! Đọc/ghi storage nội bộ — không chạm driver.

use tauri::State;

use crate::error::AppError;
use crate::state::AppState;
use crate::storage::{HistoryEntry, Snippet};

#[tauri::command]
pub fn list_history(
    state: State<'_, AppState>,
    conn_id: Option<String>,
    search: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<HistoryEntry>, AppError> {
    let search = search.filter(|s| !s.trim().is_empty());
    state
        .storage
        .list_history(conn_id.as_deref(), search.as_deref(), limit.unwrap_or(500))
        
}

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>, AppError> {
    state.storage.list_snippets()
}

#[tauri::command]
pub fn save_snippet(state: State<'_, AppState>, snippet: Snippet) -> Result<(), AppError> {
    state.storage.save_snippet(&snippet)
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.storage.delete_snippet(&id)
}
