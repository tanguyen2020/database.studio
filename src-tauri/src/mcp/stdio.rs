//! stdio bridge for MCP clients that cannot speak HTTP (or cannot send an
//! `Authorization` header): the client launches this app's own executable with
//! `--mcp-stdio`; this process reads JSON-RPC messages from stdin, forwards each
//! to the running app's local MCP server, and writes the answers to stdout.
//!
//! It does NOT start the desktop app and holds no database connection itself —
//! everything (shared connections, row cap, approval popup, audit log) is still
//! enforced by the running app. The token and port are read from the app's own
//! settings for the same OS user, so the client config needs no secret; both can
//! be overridden with `DS_MCP_TOKEN` / `DS_MCP_URL` (or `--token` / `--url`).
//!
//! stdout carries ONLY JSON-RPC (one message per line); diagnostics go to stderr.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

/// Command-line flag that switches the executable into bridge mode.
pub const FLAG: &str = "--mcp-stdio";

/// Tauri app identifier → the per-user data folder (`app_data_dir()` in Tauri).
const APP_ID: &str = "studio.database.app";

/// Longer than the in-app approval timeout (120 s) so a pending Allow/Deny is
/// answered by the app, not cut off here.
const REQUEST_TIMEOUT_SECS: u64 = 180;

/// True when the process was started as the stdio bridge.
pub fn requested() -> bool {
    std::env::args().skip(1).any(|a| a == FLAG)
}

/// Run the bridge until stdin closes. Returns the process exit code.
pub fn run() -> i32 {
    let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("database-studio --mcp-stdio: cannot start runtime: {e}");
            return 1;
        }
    };
    rt.block_on(bridge());
    0
}

/// Overrides from the command line (`--url X`, `--token X`).
fn arg_value(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_ID))
}

/// Read one `app_state` value from the app's settings DB, read-only (the app may
/// be running and holding it open; WAL lets us read alongside it).
fn read_state(key: &str) -> Option<String> {
    use rusqlite::{Connection, OpenFlags};
    let path = data_dir()?.join("studio.db");
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(2));
    conn.query_row("SELECT value FROM app_state WHERE key = ?1", [key], |r| r.get::<_, String>(0)).ok()
}

/// The endpoint URL for a configured port.
pub fn endpoint_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

fn resolve_url() -> String {
    if let Some(u) = env_nonempty("DS_MCP_URL").or_else(|| arg_value("--url")) {
        return u;
    }
    let port = read_state("mcp_config")
        .and_then(|s| serde_json::from_str::<super::config::McpConfig>(&s).ok())
        .map(|c| c.sanitized().port)
        .unwrap_or_else(|| super::config::McpConfig::default().port);
    endpoint_url(port)
}

/// Token: explicit override first, else the app's own (decrypted with this
/// user's master key, exactly as the app does).
fn resolve_token() -> (Option<String>, bool) {
    if let Some(t) = env_nonempty("DS_MCP_TOKEN").or_else(|| arg_value("--token")) {
        return (Some(t), true);
    }
    let Some(dir) = data_dir() else { return (None, false) };
    crate::storage::crypto::set_key_dir(dir);
    let tok = read_state("mcp_token").and_then(|enc| crate::storage::crypto::decrypt(&enc).ok()).filter(|t| !t.is_empty());
    (tok, false)
}

/// JSON-RPC error answer for one request id.
pub fn bridge_error(id: &Value, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } })
}

/// Ids of the requests in a message (single or batch). Notifications have none
/// and never get an answer.
pub fn request_ids(msg: &Value) -> Vec<Value> {
    match msg {
        Value::Array(items) => items.iter().filter_map(|m| m.get("id").cloned()).filter(|v| !v.is_null()).collect(),
        Value::Object(_) => msg.get("id").cloned().filter(|v| !v.is_null()).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// Error answers (one per request) for a message the app could not handle.
pub fn error_replies(msg: &Value, message: &str) -> Option<Value> {
    let ids = request_ids(msg);
    match (msg, ids.len()) {
        (_, 0) => None,
        (Value::Array(_), _) => Some(Value::Array(ids.iter().map(|id| bridge_error(id, message)).collect())),
        _ => Some(bridge_error(&ids[0], message)),
    }
}

/// What to tell the agent for an HTTP status the app answered with.
pub fn status_message(status: u16) -> String {
    match status {
        401 => "Database Studio rejected the MCP token. If you set DS_MCP_TOKEN, update it to the token shown in Settings → MCP (or remove it so the bridge reads the app's token itself).".into(),
        503 => "The MCP server is turned off in Database Studio. Turn it on in Settings → MCP.".into(),
        403 => "Database Studio refused the request (origin not allowed).".into(),
        s => format!("Database Studio answered HTTP {s}."),
    }
}

const NOT_RUNNING: &str = "Database Studio is not running, or its MCP server is off. Open the app and turn on Settings → MCP.";

struct Endpoint {
    url: String,
    token: Option<String>,
    token_pinned: bool,
}

async fn bridge() {
    let (token, pinned) = resolve_token();
    let ep = Arc::new(Mutex::new(Endpoint { url: resolve_url(), token, token_pinned: pinned }));
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS)).build() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("database-studio --mcp-stdio: {e}");
            return;
        }
    };
    let out = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut inflight = tokio::task::JoinSet::new();

    loop {
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            Ok(None) | Err(_) => break, // client closed stdin → done
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                write_line(&out, &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })).await;
                continue;
            }
        };
        // Requests run concurrently: a write waiting on the in-app approval must
        // not hold up a `ping` or another read.
        let (client, ep, out) = (client.clone(), ep.clone(), out.clone());
        inflight.spawn(async move {
            if let Some(reply) = forward(&client, &ep, &msg).await {
                write_line(&out, &reply).await;
            }
        });
        while inflight.try_join_next().is_some() {}
    }
    while inflight.join_next().await.is_some() {}
}

async fn write_line(out: &Arc<Mutex<tokio::io::Stdout>>, v: &Value) {
    let mut s = serde_json::to_string(v).unwrap_or_default();
    s.push('\n');
    let mut o = out.lock().await;
    let _ = o.write_all(s.as_bytes()).await;
    let _ = o.flush().await;
}

/// POST one message; on a stale token / port, re-read the app's settings once and
/// retry (the user may have regenerated the token or changed the port).
async fn forward(client: &reqwest::Client, ep: &Arc<Mutex<Endpoint>>, msg: &Value) -> Option<Value> {
    for attempt in 0..2 {
        let (url, token) = {
            let e = ep.lock().await;
            (e.url.clone(), e.token.clone())
        };
        let mut req = client
            .post(&url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .json(msg);
        if let Some(t) = &token {
            req = req.bearer_auth(t);
        }
        match req.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if status == 401 && attempt == 0 && refresh_token(ep).await {
                    continue;
                }
                if status == 202 || status == 204 {
                    return None;
                }
                if !(200..300).contains(&status) {
                    return error_replies(msg, &status_message(status));
                }
                let text = resp.text().await.unwrap_or_default();
                if text.trim().is_empty() {
                    return None;
                }
                return match serde_json::from_str::<Value>(&text) {
                    Ok(v) => Some(v),
                    Err(_) => error_replies(msg, "Database Studio sent an answer the bridge could not read."),
                };
            }
            Err(e) => {
                if attempt == 0 && e.is_connect() && refresh_url(ep).await {
                    continue;
                }
                eprintln!("database-studio --mcp-stdio: {e}");
                return error_replies(msg, NOT_RUNNING);
            }
        }
    }
    error_replies(msg, NOT_RUNNING)
}

async fn refresh_token(ep: &Arc<Mutex<Endpoint>>) -> bool {
    let mut e = ep.lock().await;
    if e.token_pinned {
        return false;
    }
    let (tok, _) = resolve_token();
    let changed = tok.is_some() && tok != e.token;
    e.token = tok;
    changed
}

async fn refresh_url(ep: &Arc<Mutex<Endpoint>>) -> bool {
    let mut e = ep.lock().await;
    let url = resolve_url();
    let changed = url != e.url;
    e.url = url;
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_skip_notifications() {
        assert_eq!(request_ids(&json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" })), vec![json!(7)]);
        assert!(request_ids(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_empty());
        assert_eq!(
            request_ids(&json!([{ "id": "a", "method": "x" }, { "method": "n" }, { "id": 2, "method": "y" }])),
            vec![json!("a"), json!(2)]
        );
    }

    #[test]
    fn error_replies_match_the_message_shape() {
        // single request → single error object with the same id
        let r = error_replies(&json!({ "id": 3, "method": "tools/list" }), "down").unwrap();
        assert_eq!(r["id"], 3);
        assert_eq!(r["error"]["message"], "down");
        // notification → nothing (a reply would be a protocol error)
        assert!(error_replies(&json!({ "method": "notifications/initialized" }), "down").is_none());
        // batch → array of errors, one per request
        let r = error_replies(&json!([{ "id": 1, "method": "a" }, { "method": "n" }, { "id": 2, "method": "b" }]), "down").unwrap();
        assert_eq!(r.as_array().unwrap().len(), 2);
    }

    #[test]
    fn status_messages_are_actionable() {
        assert!(status_message(401).contains("token"));
        assert!(status_message(503).contains("Settings → MCP"));
        assert_eq!(endpoint_url(4319), "http://127.0.0.1:4319/mcp");
    }
}
