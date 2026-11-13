//! In-app MCP server (Model Context Protocol over Streamable HTTP).
//!
//! Serves a localhost-only JSON-RPC endpoint so an AI agent (Claude Code/Desktop,
//! Cursor, …) can explore schemas and run queries through the connections the user
//! shared — reusing this app's registry, credentials, approval popup and audit log.
//! Off by default; bound to 127.0.0.1; every request needs the bearer token.
//! Speaks MCP revisions 2024-11-05 … 2025-06-18 (Streamable HTTP with JSON
//! answers, batches); clients that only speak stdio use the `--mcp-stdio` bridge.

pub mod config;
pub mod dispatch;
pub mod policy;
pub mod stdio;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    body::Bytes,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
}

/// Start the server on 127.0.0.1:<config port>. Returns the bound port. Replaces
/// any running instance. No-op-safe to call again (it rebinds).
pub async fn start(app: AppHandle) -> Result<u16, String> {
    let port = {
        let state = app.state::<AppState>();
        config::load_config(&state.storage).port
    };
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Could not start the MCP server on 127.0.0.1:{port} — {e}. Pick another port in Settings → MCP."))?;
    let bound = listener.local_addr().map(|a| a.port()).unwrap_or(port);

    let ctx = Ctx { app: app.clone() };
    let router = Router::new().route("/mcp", post(mcp_endpoint)).with_state(ctx);

    let handle = tokio::task::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    app.state::<AppState>().mcp.set_server(handle.abort_handle(), bound);
    Ok(bound)
}

/// Stop the running server (if any) and clear per-session approvals.
pub fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.mcp.stop_server();
    state.mcp.clear_session();
}

async fn mcp_endpoint(State(ctx): State<Ctx>, headers: HeaderMap, body: Bytes) -> Response {
    let state = ctx.app.state::<AppState>();
    let cfg = config::load_config(&state.storage);
    let token = config::load_or_create_token(&state.storage).unwrap_or_default();
    let header = headers.get("authorization").and_then(|v| v.to_str().ok());
    if let Err((code, msg)) = authorize(cfg.enabled, &token, header) {
        return (code, msg).into_response();
    }
    // DNS-rebinding guard (MCP transport spec): a web page on another host must
    // never reach this server, even though it would also need the token.
    if !origin_allowed(headers.get("origin").and_then(|v| v.to_str().ok())) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    if let Some(v) = headers.get("mcp-protocol-version").and_then(|v| v.to_str().ok()) {
        if !dispatch::SUPPORTED_VERSIONS.contains(&v.trim()) {
            return (StatusCode::BAD_REQUEST, format!("unsupported MCP-Protocol-Version {v}")).into_response();
        }
    }
    let message: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            let err = serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } });
            return (StatusCode::BAD_REQUEST, Json(err)).into_response();
        }
    };

    match dispatch::handle(&ctx.app, message).await {
        Some(resp) => Json(resp).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// Gate one request: the server must be enabled and the bearer token must match
/// (constant-time). Pure, so it is unit-tested without a running server.
pub fn authorize(enabled: bool, token: &str, auth_header: Option<&str>) -> Result<(), (StatusCode, &'static str)> {
    if !enabled {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "MCP server is disabled"));
    }
    let presented = auth_header.and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    if token.is_empty() || !constant_time_eq(presented.as_bytes(), token.as_bytes()) {
        return Err((StatusCode::UNAUTHORIZED, "missing or invalid token"));
    }
    Ok(())
}

/// `Origin` is only sent by browsers. Allow none, non-web schemes (editor
/// webviews) and loopback web pages; refuse any other web origin.
pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(o) = origin.map(str::trim).filter(|o| !o.is_empty()) else { return true };
    let rest = match o.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") => rest,
        Some(_) => return true,
        None => return o.eq_ignore_ascii_case("null"),
    };
    let authority = rest.split('/').next().unwrap_or("");
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or("")
    } else {
        authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority)
    };
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_only_identical_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn origin_guard_blocks_foreign_web_pages_only() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("http://localhost:5173")));
        assert!(origin_allowed(Some("http://127.0.0.1")));
        assert!(origin_allowed(Some("http://[::1]:8080")));
        assert!(origin_allowed(Some("vscode-webview://abc")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("http://localhost.evil.example")));
        assert!(!origin_allowed(Some("http://127.0.0.1.evil.example:80")));
    }

    #[test]
    fn version_negotiation_echoes_supported_and_falls_back_to_newest() {
        assert_eq!(dispatch::negotiate_version(Some("2024-11-05")), "2024-11-05");
        assert_eq!(dispatch::negotiate_version(Some("2025-03-26")), "2025-03-26");
        assert_eq!(dispatch::negotiate_version(Some("2099-01-01")), "2025-06-18");
        assert_eq!(dispatch::negotiate_version(None), "2025-06-18");
    }

    #[test]
    fn authorize_gates_on_enabled_and_token() {
        // disabled → 503 regardless of token
        assert_eq!(authorize(false, "tok", Some("Bearer tok")).unwrap_err().0, StatusCode::SERVICE_UNAVAILABLE);
        // enabled but no / wrong / unprefixed header → 401
        assert_eq!(authorize(true, "tok", None).unwrap_err().0, StatusCode::UNAUTHORIZED);
        assert_eq!(authorize(true, "tok", Some("Bearer nope")).unwrap_err().0, StatusCode::UNAUTHORIZED);
        assert_eq!(authorize(true, "tok", Some("tok")).unwrap_err().0, StatusCode::UNAUTHORIZED);
        // empty configured token never authorizes
        assert_eq!(authorize(true, "", Some("Bearer ")).unwrap_err().0, StatusCode::UNAUTHORIZED);
        // correct bearer token → ok
        assert!(authorize(true, "tok", Some("Bearer tok")).is_ok());
    }
}
