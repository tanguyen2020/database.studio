//! Small file helpers (CSV export target picked via the dialog plugin).

use crate::error::AppError;

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), AppError> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| AppError::Other(format!("Failed to write file '{path}': {e}")))
}
