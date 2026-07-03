//! IPC commands: tab persistence (save on close, restore on launch).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

/// The frontend owns the tab shape; storage treats it as an opaque payload.
#[derive(Debug, Serialize, Deserialize)]
pub struct PersistedTab {
    pub id: String,
    pub is_pinned: bool,
    /// Full JSON tab state (connectionId, systemType, contentType, title, query...)
    pub payload: serde_json::Value,
}

#[tauri::command]
pub async fn save_tabs(state: State<'_, AppState>, tabs: Vec<PersistedTab>) -> Result<(), AppError> {
    let rows: Vec<(String, String, i64, bool)> = tabs
        .iter()
        .enumerate()
        .map(|(i, t)| {
            (
                t.id.clone(),
                t.payload.to_string(),
                i as i64,
                t.is_pinned,
            )
        })
        .collect();
    state.storage.replace_tabs(&rows)
}

#[tauri::command]
pub async fn load_tabs(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, AppError> {
    let payloads = state.storage.list_tabs()?;
    Ok(payloads
        .iter()
        .filter_map(|p| serde_json::from_str(p).ok())
        .collect())
}

#[tauri::command]
pub async fn get_app_state(state: State<'_, AppState>, key: String) -> Result<Option<String>, AppError> {
    state.storage.get_state(&key)
}

#[tauri::command]
pub async fn set_app_state(state: State<'_, AppState>, key: String, value: String) -> Result<(), AppError> {
    state.storage.set_state(&key, &value)
}
