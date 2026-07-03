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

/// Real handshake + latency; works for saved profiles and unsaved drafts.
#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    draft: ProfileDraft,
) -> Result<TestResult, AppError> {
    let (password, ssh_password) = resolve_secrets(&state, &draft)?;
    let profile = &draft.profile;

    if profile.ssh.enabled {
        let tunnel = match open_tunnel(&profile.ssh, &ssh_password, &profile.host, profile.port).await
        {
            Ok(t) => t,
            Err(e) => {
                return Ok(TestResult {
                    ok: false,
                    latency_ms: None,
                    server_version: None,
                    error: Some(e.to_string()),
                })
            }
        };
        let endpoint = Endpoint { host: "127.0.0.1".into(), port: tunnel.local_port };
        let result = LiveConnection::test(profile, &endpoint, &password).await;
        tunnel.shutdown().await;
        Ok(result)
    } else {
        let endpoint = Endpoint { host: profile.host.clone(), port: profile.port };
        Ok(LiveConnection::test(profile, &endpoint, &password).await)
    }
}

/// Liveness probe for the status bar / disconnected banner.
#[tauri::command]
pub async fn ping_connection(state: State<'_, AppState>, id: String) -> Result<bool, AppError> {
    Ok(state.registry.ping(&id).await)
}
