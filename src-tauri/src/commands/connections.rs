//! IPC commands: connection CRUD + connect/disconnect/test.

use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use crate::connections::profile::{ConnectionProfile, ProfilePublic};
use crate::connections::tunnel::open_tunnel;
use crate::drivers::{Endpoint, LiveConnection};
use crate::drivers::types::TestResult;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::storage::crypto;

/// Draft coming from the connection form. Plaintext passwords are only ever
/// in-flight over IPC; they are encrypted before touching storage.
#[derive(Debug, Deserialize)]
pub struct ProfileDraft {
    pub profile: ConnectionProfile,
    /// None = keep existing stored password.
    pub password: Option<String>,
    pub ssh_password: Option<String>,
}

fn resolve_secrets(
    state: &AppState,
    draft: &ProfileDraft,
) -> AppResult<(String, String)> {
    // Plaintext for connect/test: prefer the draft's fresh input, else decrypt stored.
    let stored = state.storage.get_connection(&draft.profile.id).ok();
    let password = match &draft.password {
        Some(p) => p.clone(),
        None => match &stored {
            Some(s) => crypto::decrypt(&s.password_enc)?,
            None => String::new(),
        },
    };
    let ssh_password = match &draft.ssh_password {
        Some(p) => p.clone(),
        None => match &stored {
            Some(s) => crypto::decrypt(&s.ssh.password_enc)?,
            None => String::new(),
        },
    };
    Ok((password, ssh_password))
}

fn to_public(state: &AppState, profile: ConnectionProfile) -> ProfilePublic {
    let connected = state.registry.is_connected(&profile.id);
    let latency = state.registry.latency(&profile.id);
    ProfilePublic::from_profile(profile, connected, latency)
}

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> Result<Vec<ProfilePublic>, AppError> {
    let profiles = state.storage.list_connections()?;
    Ok(profiles.into_iter().map(|p| to_public(&state, p)).collect())
}

#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    draft: ProfileDraft,
) -> Result<ProfilePublic, AppError> {
    let mut profile = draft.profile.clone();
    if profile.id.is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }
    if profile.port == 0 {
        profile.port = ConnectionProfile::default_port(profile.system);
    }

    // Encrypt fresh passwords, or carry over the stored ciphertext.
    let existing = state.storage.get_connection(&profile.id).ok();
    profile.password_enc = match &draft.password {
        Some(p) => crypto::encrypt(p)?,
        None => existing.as_ref().map(|e| e.password_enc.clone()).unwrap_or_default(),
    };
    profile.ssh.password_enc = match &draft.ssh_password {
        Some(p) => crypto::encrypt(p)?,
        None => existing
            .as_ref()
            .map(|e| e.ssh.password_enc.clone())
            .unwrap_or_default(),
    };

    state.storage.save_connection(&profile)?;
    Ok(to_public(&state, profile))
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.registry.disconnect(&id).await?;
    state.storage.delete_connection(&id)
}

#[tauri::command]
pub async fn duplicate_connection(
    state: State<'_, AppState>,
    id: String,
) -> Result<ProfilePublic, AppError> {
    let mut profile = state.storage.get_connection(&id)?;
    profile.id = Uuid::new_v4().to_string();
    profile.name = format!("{} (copy)", profile.name);
    state.storage.save_connection(&profile)?;
    Ok(to_public(&state, profile))
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: String) -> Result<u64, AppError> {
    let profile = state.storage.get_connection(&id)?;
    let password = crypto::decrypt(&profile.password_enc)?;
    let ssh_password = crypto::decrypt(&profile.ssh.password_enc)?;
    state.registry.connect(profile, password, ssh_password).await
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    // dừng luôn subscription pub/sub Redis + consumer Kafka (nếu có) trước khi ngắt
    state.pubsub.abort(&id);
    state.kafka_stops.stop(&id);
    // Sweep internal per-database sub-connections (attach_database, `{id}::db`) AND
    // per-tab connections (open_tab_connection, `{id}#tab-…`) opened off this base.
    state.registry.drop_derived(&id).await;
    state.registry.disconnect(&id).await
}

/// Reconnect with the *saved* profile (used by "Save & Reconnect" and by the
/// editor's "Reconnect" banner after a connection was lost).
#[tauri::command]
pub async fn reconnect(state: State<'_, AppState>, id: String) -> Result<u64, AppError> {
    // Derived connections ({id}::db, {id}#tab-…) are opened off this base and
    // are just as dead as it is — drop them so the next use opens a fresh one.
    state.registry.drop_derived(&id).await;
    state.registry.disconnect(&id).await?;
    let profile = state.storage.get_connection(&id)?;
    let password = crypto::decrypt(&profile.password_enc)?;
    let ssh_password = crypto::decrypt(&profile.ssh.password_enc)?;
    state.registry.connect(profile, password, ssh_password).await
}

/// One-off "Quick Connect": open a live connection straight from an unsaved
/// draft under an ephemeral id (`quick-*`). Never written to storage → gone on
/// restart. Query/schema/disconnect resolve it via the registry like any live
/// connection; the frontend keeps the ephemeral profile in memory only.
#[tauri::command]
pub async fn quick_connect(
    state: State<'_, AppState>,
    draft: ProfileDraft,
) -> Result<ProfilePublic, AppError> {
    let mut profile = draft.profile.clone();
    profile.id = format!("quick-{}", Uuid::new_v4());
    if profile.port == 0 {
        profile.port = ConnectionProfile::default_port(profile.system);
    }
    let password = draft.password.clone().unwrap_or_default();
    let ssh_password = draft.ssh_password.clone().unwrap_or_default();
    let latency = state
        .registry
        .connect(profile.clone(), password, ssh_password)
        .await?;
    Ok(ProfilePublic::from_profile(profile, true, Some(latency)))
}

/// Resolve host/credentials for a connection: from storage for saved profiles,
/// else from the live registry (ephemeral / already-attached). SSH password
/// isn't retained in the registry → empty there (fine for plain TCP).
fn resolve_credentials(
    state: &AppState,
    conn_id: &str,
) -> Result<(ConnectionProfile, String, String), AppError> {
    match state.storage.get_connection(conn_id) {
        Ok(p) => {
            let pw = crypto::decrypt(&p.password_enc)?;
            let sshpw = crypto::decrypt(&p.ssh.password_enc)?;
            Ok((p, pw, sshpw))
        }
        Err(_) => {
            let (p, pw) = state.registry.live_credentials(conn_id)?;
            Ok((p, pw, String::new()))
        }
    }
}

/// Open another database on the *same* server as its own ephemeral connection.
/// (Kept for direct "open as new connection" flows.) See `attach_database` for
/// the Explorer's per-database tree, which does NOT surface a sidebar entry.
#[tauri::command]
pub async fn open_database(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<ProfilePublic, AppError> {
    let (mut profile, password, ssh_password) = resolve_credentials(&state, &conn_id)?;
    use crate::drivers::types::SystemType;
    if !matches!(profile.system, SystemType::Postgres | SystemType::Mssql) {
        return Err(AppError::Driver(
            "Opening another database is only supported for PostgreSQL and SQL Server".into(),
        ));
    }
    let base_name = profile.name.split(" · ").next().unwrap_or(&profile.name).to_string();
    profile.id = format!("quick-{}", Uuid::new_v4());
    profile.database = database.clone();
    profile.name = format!("{base_name} · {database}");
    let latency = state.registry.connect(profile.clone(), password, ssh_password).await?;
    Ok(ProfilePublic::from_profile(profile, true, Some(latency)))
}

/// Attach an *internal* live connection to another database on the same server
/// and return its sub-connection id (`{conn_id}::{db}`) — NOT surfaced in the
/// sidebar. Idempotent (reuses an already-open sub-connection). For the
/// connection's own current database it returns `conn_id` unchanged (no sub-conn).
/// The Explorer introspects each database subtree by passing this id to the
/// existing `list_*` commands unchanged.
#[tauri::command]
pub async fn attach_database(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<String, AppError> {
    let (mut profile, password, ssh_password) = resolve_credentials(&state, &conn_id)?;
    // Same DB as the source connection → no sub-connection needed.
    if profile.database == database {
        return Ok(conn_id);
    }
    let sub_id = format!("{conn_id}::{database}");
    if state.registry.is_connected(&sub_id) {
        return Ok(sub_id);
    }
    profile.id = sub_id.clone();
    profile.database = database;
    state.registry.connect(profile, password, ssh_password).await?;
    Ok(sub_id)
}

/// The base profile id embedded in any derived connection id: strips a per-tab
/// suffix (`#tab-…`) and/or a per-database suffix (`::db`). A base profile id has
/// neither, so this is a no-op for it.
fn base_conn_id(id: &str) -> String {
    let no_tab = id.split('#').next().unwrap_or(id);
    no_tab.split("::").next().unwrap_or(no_tab).to_string()
}

/// Open a dedicated connection for a single Query Editor tab (item 6). Each tab
/// gets its OWN physical connection (`{base}#tab-{tab_id}`), so a long/hung query
/// in one tab never blocks other tabs or the Explorer (which use the base
/// connection). Idempotent; if the tab already has a connection on a *different*
/// database it is reconnected to `database`. `database` empty → the base's own DB.
#[tauri::command]
pub async fn open_tab_connection(
    state: State<'_, AppState>,
    conn_id: String,
    tab_id: String,
    database: String,
) -> Result<String, AppError> {
    let base = base_conn_id(&conn_id);
    let (mut profile, password, ssh_password) = resolve_credentials(&state, &base)?;
    let effective_db = if database.is_empty() { profile.database.clone() } else { database };
    let tab_conn_id = format!("{base}#tab-{tab_id}");
    if state.registry.is_connected(&tab_conn_id) {
        let current_db = state
            .registry
            .live_credentials(&tab_conn_id)
            .map(|(p, _)| p.database)
            .unwrap_or_default();
        if current_db == effective_db {
            return Ok(tab_conn_id);
        }
        // database dropdown changed → drop the old tab connection and re-open on the new DB.
        let _ = state.registry.disconnect(&tab_conn_id).await;
    }
    profile.id = tab_conn_id.clone();
    profile.database = effective_db;
    state.registry.connect(profile, password, ssh_password).await?;
    Ok(tab_conn_id)
}

/// Close (and abort any running query on) a Query Editor tab's dedicated
/// connection — called when the tab is closed (item 6). No-op if not open.
#[tauri::command]
pub async fn close_tab_connection(state: State<'_, AppState>, conn_id: String) -> Result<(), AppError> {
    state.registry.disconnect(&conn_id).await
}

/// Timeout kết nối mặc định cho Test (T10). Mọi Test phải trả kết quả rõ ràng
/// trong khoảng này thay vì treo theo OS TCP timeout.
pub const CONNECT_TIMEOUT_SECS: u64 = 10;
pub fn connect_timeout() -> std::time::Duration {
    std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS)
}

/// Map thông điệp lỗi thô của driver về câu rõ ràng cho UI (T10 §1).
pub fn classify_connect_error(raw: &str) -> String {
    let l = raw.to_ascii_lowercase();
    if l.contains("timed out") || l.contains("timeout") || l.contains("timad") {
        "Connection timed out".into()
    } else if l.contains("refused") {
        "Connection refused (host/port)".into()
    } else if l.contains("password authentication")
        || l.contains("authentication failed")
        || l.contains("access denied")
        || l.contains("login failed")
        || l.contains("auth")
    {
        "Authentication failed".into()
    } else if l.contains("certificate") || l.contains("tls") || l.contains("ssl") || l.contains("handshake") {
        "SSL handshake failed".into()
    } else if l.contains("no such host")
        || l.contains("name or service not known")
        || l.contains("failed to lookup")
        || l.contains("nodename nor servname")
        || l.contains("dns")
    {
        "Host not found".into()
    } else {
        raw.to_string()
    }
}

fn err_result(raw: String) -> TestResult {
    TestResult { ok: false, latency_ms: None, server_version: None, error: Some(classify_connect_error(&raw)) }
}

/// Test connection có RÀNG BUỘC timeout + HỦY THẬT (T10). Đua giữa: thao tác
/// test, token hủy, và timeout. SSH tunnel được sở hữu ở scope này và luôn
/// shutdown() dù kết quả ra sao (tránh rò tunnel khi hủy/timeout).
pub async fn run_test_bounded(
    profile: &ConnectionProfile,
    password: &str,
    ssh_password: &str,
    timeout: std::time::Duration,
    token: tokio_util::sync::CancellationToken,
) -> TestResult {
    if profile.ssh.enabled {
        // Mở tunnel có ràng buộc hủy/timeout.
        let tunnel = tokio::select! {
            biased;
            _ = token.cancelled() => return err_result("Cancelled".into()),
            _ = tokio::time::sleep(timeout) => return err_result("Connection timed out".into()),
            t = open_tunnel(
                &profile.ssh,
                ssh_password,
                &profile.host,
                profile.port,
                // Kafka: metadata-rewriting proxy (matches connect()), so the
                // broker's advertised address reconnects through this tunnel.
                profile.system.as_str() == "kafka",
            ) => match t {
                Ok(t) => t,
                Err(e) => return err_result(e.to_string()),
            },
        };
        let endpoint = Endpoint { host: "127.0.0.1".into(), port: tunnel.local_port };
        let mut result = tokio::select! {
            biased;
            _ = token.cancelled() => err_result("Cancelled".into()),
            _ = tokio::time::sleep(timeout) => err_result("Connection timed out".into()),
            r = LiveConnection::test(profile, &endpoint, password) => post_process(r),
        };
        tunnel.shutdown().await;
        // Kafka over SSH tunnel commonly fails because librdkafka dials the
        // broker's advertised.listeners directly (bypassing the tunnel).
        if !result.ok && profile.system.as_str() == "kafka" {
            if let Some(e) = result.error.as_mut() {
                e.push_str(
                    " — Kafka over SSH: the tunnel rewrites advertised.listeners automatically (no server change needed). \
                     Check that the SSH server itself can reach the broker (`nc -zv <host> <port>` on the SSH server), that \
                     any required SASL/SSL is set, and note the rewrite currently supports a single broker.",
                );
            }
        }
        result
    } else {
        let endpoint = Endpoint { host: profile.host.clone(), port: profile.port };
        tokio::select! {
            biased;
            _ = token.cancelled() => err_result("Cancelled".into()),
            _ = tokio::time::sleep(timeout) => err_result("Connection timed out".into()),
            r = LiveConnection::test(profile, &endpoint, password) => post_process(r),
        }
    }
}

/// Làm rõ message lỗi trên TestResult trả về từ driver.
fn post_process(mut r: TestResult) -> TestResult {
    if !r.ok {
        if let Some(e) = r.error.take() {
            r.error = Some(classify_connect_error(&e));
        }
    }
    r
}

/// Real handshake + latency; works for saved profiles and unsaved drafts.
/// `test_id` cho phép Cancel hủy THẬT lần test đang chạy (T10).
#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    draft: ProfileDraft,
    test_id: Option<String>,
) -> Result<TestResult, AppError> {
    let (password, ssh_password) = resolve_secrets(&state, &draft)?;
    let profile = &draft.profile;

    let id = test_id.unwrap_or_default();
    let token = state.test_cancels.register(id.clone());
    let result = run_test_bounded(profile, &password, &ssh_password, connect_timeout(), token).await;
    state.test_cancels.remove(&id);
    Ok(result)
}

/// Hủy một lần Test connection đang chạy (đóng dialog / nút Cancel).
#[tauri::command]
pub fn cancel_test(state: State<'_, AppState>, test_id: String) -> Result<(), AppError> {
    state.test_cancels.cancel(&test_id);
    Ok(())
}

/// Liveness probe for the status bar / disconnected banner.
#[tauri::command]
pub async fn ping_connection(state: State<'_, AppState>, id: String) -> Result<bool, AppError> {
    Ok(state.registry.ping(&id).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_default_is_10s() {
        assert_eq!(connect_timeout(), std::time::Duration::from_secs(10));
        assert_eq!(CONNECT_TIMEOUT_SECS, 10);
    }

    #[test]
    fn classify_connect_error_maps_categories() {
        assert_eq!(classify_connect_error("connection timed out"), "Connection timed out");
        assert_eq!(classify_connect_error("Connection refused (os error 111)"), "Connection refused (host/port)");
        assert_eq!(classify_connect_error("password authentication failed for user \"x\""), "Authentication failed");
        assert_eq!(classify_connect_error("Login failed for user 'sa'."), "Authentication failed");
        assert_eq!(classify_connect_error("certificate verify failed"), "SSL handshake failed");
        assert_eq!(classify_connect_error("failed to lookup address information"), "Host not found");
        // không nhận diện → giữ nguyên
        assert_eq!(classify_connect_error("weird driver blurb"), "weird driver blurb");
    }
}
