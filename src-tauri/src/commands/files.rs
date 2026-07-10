//! Small file helpers (CSV export target picked via the dialog plugin).

use crate::error::AppError;

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), AppError> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| AppError::Other(format!("Failed to write file '{path}': {e}")))
}

/// Write binary content (base64-encoded from the webview) to a file — used for
/// image exports (e.g. ER diagram PNG), where the WebView2 can't do a real
/// `<a download>` save.
#[tauri::command]
pub async fn write_file_base64(path: String, base64: String) -> Result<(), AppError> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| AppError::Other(format!("Invalid base64: {e}")))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| AppError::Other(format!("Failed to write file '{path}': {e}")))
}
