//! IPC for the MCP server: status, configuration, token, audit log, and the
//! Allow/Deny answer for an approval popup.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::mcp::{self, config};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnRow {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub read: bool,
    pub write: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub url: String,
    pub token: String,
    pub row_cap: u32,
    pub approval_mode: config::ApprovalMode,
    pub connections: Vec<McpConnRow>,
    /// This app's executable — clients that only speak stdio launch it with
    /// `--mcp-stdio` (see `mcp::stdio`).
    pub bridge_path: String,
}

fn build_status(state: &AppState) -> McpStatus {
    let cfg = config::load_config(&state.storage);
    let token = config::load_or_create_token(&state.storage).unwrap_or_default();
    let running = state.mcp.running_port();
    let port = running.unwrap_or(cfg.port);
    let connections = state
        .storage
        .list_connections()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let pol = cfg.conn(&p.id);
            McpConnRow { id: p.id, name: p.name, engine: p.system.as_str().to_string(), read: pol.read, write: pol.write }
        })
        .collect();
    McpStatus {
        enabled: cfg.enabled,
        running: running.is_some(),
        port,
        url: format!("http://127.0.0.1:{port}/mcp"),
        token,
        row_cap: cfg.row_cap,
        approval_mode: cfg.approval_mode,
        connections,
        bridge_path: std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
    }
}

#[tauri::command]
pub async fn mcp_status(state: State<'_, AppState>) -> Result<McpStatus, AppError> {
    Ok(build_status(&state))
}

#[tauri::command]
pub async fn mcp_set_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: config::McpConfig,
) -> Result<McpStatus, AppError> {
    let cfg = config.sanitized();
    config::save_config(&state.storage, &cfg)?;

    // Apply: enabled → (re)start on the configured port; disabled → stop.
    if cfg.enabled {
        mcp::stop(&app); // rebind cleanly (port may have changed)
        if let Err(e) = mcp::start(app.clone()).await {
            // roll back the enabled flag so status reflects reality
            let mut off = cfg.clone();
            off.enabled = false;
            let _ = config::save_config(&state.storage, &off);
            return Err(AppError::Other(e));
        }
    } else {
        mcp::stop(&app);
    }
    Ok(build_status(&state))
}

#[tauri::command]
pub async fn mcp_rotate_token(state: State<'_, AppState>) -> Result<String, AppError> {
    Ok(config::rotate_token(&state.storage)?)
}

#[tauri::command]
pub async fn mcp_audit_list(state: State<'_, AppState>) -> Result<Vec<config::AuditEntry>, AppError> {
    let mut all = config::load_audit(&state.storage);
    all.reverse(); // newest first
    Ok(all)
}

#[tauri::command]
pub async fn mcp_clear_audit(state: State<'_, AppState>) -> Result<(), AppError> {
    config::clear_audit(&state.storage);
    Ok(())
}

/// Answer an approval popup. `session` = also allow writes on this connection for
/// the rest of the app session.
#[tauri::command]
pub async fn mcp_approve(
    state: State<'_, AppState>,
    id: String,
    allow: bool,
    connection: Option<String>,
    session: Option<bool>,
) -> Result<(), AppError> {
    if allow && session.unwrap_or(false) {
        if let Some(c) = connection {
            state.mcp.allow_session_write(c);
        }
    }
    state.mcp.resolve_approval(&id, allow);
    Ok(())
}
