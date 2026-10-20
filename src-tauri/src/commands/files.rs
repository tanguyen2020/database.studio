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

/// Show a file in the system file manager (Explorer / Finder / the folder on
/// Linux). Used by "Show in folder" after a backup.
#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), AppError> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(AppError::Other(format!("Not found: {path}")));
    }
    let spawned = if cfg!(windows) {
        std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(p).spawn()
    } else {
        let dir = if p.is_dir() { p.to_path_buf() } else { p.parent().map(|d| d.to_path_buf()).unwrap_or_default() };
        std::process::Command::new("xdg-open").arg(dir).spawn()
    };
    spawned.map(|_| ()).map_err(|e| AppError::Other(format!("Could not open the folder: {e}")))
}
