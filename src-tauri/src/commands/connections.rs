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
    state.registry.disconnect(&id).await
}

/// Reconnect with the *saved* profile (used by "Save & Reconnect").
#[tauri::command]
pub async fn reconnect(state: State<'_, AppState>, id: String) -> Result<u64, AppError> {
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
            t = open_tunnel(&profile.ssh, ssh_password, &profile.host, profile.port) => match t {
                Ok(t) => t,
                Err(e) => return err_result(e.to_string()),
            },
        };
        let endpoint = Endpoint { host: "127.0.0.1".into(), port: tunnel.local_port };
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => err_result("Cancelled".into()),
            _ = tokio::time::sleep(timeout) => err_result("Connection timed out".into()),
            r = LiveConnection::test(profile, &endpoint, password) => post_process(r),
        };
        tunnel.shutdown().await;
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
