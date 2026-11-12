//! IPC commands: Export / Import Connections (file format in
//! `connections/transfer.rs`).
//!
//! Plaintext passwords exist only inside these commands: decrypted from this
//! machine's store to be sealed into a file, or unsealed from a file to be
//! re-encrypted with this machine's key. They never reach the webview.

use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::connections::profile::{ConnectionProfile, ProfilePublic, SshAuthMethod};
use crate::connections::transfer::{self, Entry, ImportError, Secret};
use crate::drivers::types::SystemType;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::storage::crypto;
use crate::storage::Storage;

/// Saved connections in the order given, with their plaintext secrets when
/// `with_secrets` (otherwise empty secrets — nothing is decrypted).
pub fn collect_items(
    storage: &Storage,
    ids: &[String],
    with_secrets: bool,
    decrypt: impl Fn(&str) -> AppResult<String>,
) -> AppResult<Vec<(ConnectionProfile, Secret)>> {
    let mut items = Vec::with_capacity(ids.len());
    for id in ids {
        let p = storage.get_connection(id)?;
        let secret = if with_secrets {
            let read = |enc: &str, what: &str| {
                decrypt(enc).map_err(|e| {
                    AppError::Other(format!(
                        "Could not read the saved {what} of '{}' on this computer ({e}). \
                         Open the connection, type the password again, then export.",
                        p.name
                    ))
                })
            };
            Secret {
                password: read(&p.password_enc, "password")?,
                ssh_password: read(&p.ssh.password_enc, "SSH password")?,
            }
        } else {
            Secret::default()
        };
        items.push((p, secret));
    }
    Ok(items)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Build an export file from saved connections, in the order given.
/// `passphrase: Some` = include passwords, sealed with that file password.
pub fn build_export(
    storage: &Storage,
    ids: &[String],
    passphrase: Option<&str>,
    decrypt: impl Fn(&str) -> AppResult<String>,
) -> AppResult<String> {
    let items = collect_items(storage, ids, passphrase.is_some(), decrypt)?;
    transfer::export_document(&items, passphrase, &now_iso()).map_err(AppError::Other)
}

#[tauri::command]
pub async fn export_connections(
    state: State<'_, AppState>,
    ids: Vec<String>,
    passphrase: Option<String>,
) -> Result<String, AppError> {
    let items = collect_items(&state.storage, &ids, passphrase.is_some(), crypto::decrypt)?;
    // Argon2 is CPU-heavy by design — keep it off the async runtime.
    tokio::task::spawn_blocking(move || {
        transfer::export_document(&items, passphrase.as_deref(), &now_iso()).map_err(AppError::Other)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// One connection found in a file, as shown before importing. No secrets.
#[derive(Debug, Serialize)]
pub struct ImportItem {
    pub profile: ConnectionProfile,
    pub has_password: bool,
    pub has_ssh_password: bool,
    /// Files the connection points at (SSH key, TLS certificates, database file)
    /// that do not exist on this computer.
    pub missing_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ImportInspect {
    NeedsPassphrase,
    WrongPassphrase,
    Ok { sealed: bool, items: Vec<ImportItem> },
}

/// Paths a profile depends on that are not present on this machine.
pub fn missing_files(p: &ConnectionProfile) -> Vec<String> {
    let mut paths: Vec<&str> = Vec::new();
    if p.ssh.enabled && p.ssh.auth == SshAuthMethod::Key {
        paths.push(&p.ssh.key_path);
    }
    if p.ssl {
        paths.extend([p.ssl_ca.as_str(), p.ssl_cert.as_str(), p.ssl_key.as_str()]);
    }
    if matches!(p.system, SystemType::Sqlite | SystemType::Duckdb)
        && p.sqlite_mode != crate::connections::profile::SqliteMode::InMemory
    {
        paths.push(&p.sqlite_path);
    }
    paths
        .into_iter()
        .filter(|s| !s.trim().is_empty() && !std::path::Path::new(s).exists())
        .map(str::to_string)
        .collect()
}

pub fn inspect(content: &str, passphrase: Option<&str>) -> AppResult<ImportInspect> {
    match transfer::parse_document(content, passphrase) {
        Ok(entries) => {
            let sealed = transfer::is_sealed(content);
            let items = entries
                .into_iter()
                .map(|e| ImportItem {
                    missing_files: missing_files(&e.profile),
                    has_password: e.secret.as_ref().is_some_and(|s| !s.password.is_empty()),
                    has_ssh_password: e.secret.as_ref().is_some_and(|s| !s.ssh_password.is_empty()),
                    profile: e.profile,
                })
                .collect();
            Ok(ImportInspect::Ok { sealed, items })
        }
        Err(ImportError::NeedsPassphrase) => Ok(ImportInspect::NeedsPassphrase),
        Err(ImportError::WrongPassphrase) => Ok(ImportInspect::WrongPassphrase),
        Err(ImportError::Invalid(m)) => Err(AppError::Other(m)),
    }
}

#[tauri::command]
pub async fn inspect_connections_file(
    content: String,
    passphrase: Option<String>,
) -> Result<ImportInspect, AppError> {
    tokio::task::spawn_blocking(move || inspect(&content, passphrase.as_deref()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// What to do with one connection of the file.
#[derive(Debug, Clone, Deserialize)]
pub struct ImportChoice {
    /// Position in the file.
    pub index: usize,
    /// `"add"` = a new connection; `"replace"` = overwrite `target_id`.
    pub action: String,
    #[serde(default)]
    pub target_id: Option<String>,
    /// Name to save it under (the UI renames to avoid a clash). None = as in the file.
    #[serde(default)]
    pub name: Option<String>,
}

/// Turn file entries + the user's choices into the profiles to save, with this
/// machine's ciphertext. `existing` looks up a saved profile by id.
pub fn apply_choices(
    entries: &[Entry],
    choices: &[ImportChoice],
    existing: impl Fn(&str) -> Option<ConnectionProfile>,
    encrypt: impl Fn(&str) -> AppResult<String>,
) -> AppResult<Vec<ConnectionProfile>> {
    let mut out = Vec::with_capacity(choices.len());
    for c in choices {
        let e = entries
            .get(c.index)
            .ok_or_else(|| AppError::Other(format!("The file has no connection #{}", c.index + 1)))?;
        let mut p = e.profile.clone();
        if let Some(n) = c.name.as_ref().map(|n| n.trim()).filter(|n| !n.is_empty()) {
            p.name = n.to_string();
        }
        let secret = e.secret.clone().unwrap_or_default();
        let prev = match c.action.as_str() {
            "add" => {
                p.id = Uuid::new_v4().to_string();
                None
            }
            "replace" => {
                let id = c.target_id.clone().ok_or_else(|| AppError::Other("Replace needs a target".into()))?;
                let prev = existing(&id)
                    .ok_or_else(|| AppError::Other(format!("The connection to replace ('{id}') no longer exists")))?;
                p.id = id;
                Some(prev)
            }
            other => return Err(AppError::Other(format!("Unknown import action '{other}'"))),
        };
        // A password in the file wins; otherwise a replaced connection keeps the
        // one already saved here (the file just did not carry it).
        p.password_enc = match (secret.password.is_empty(), &prev) {
            (false, _) => encrypt(&secret.password)?,
            (true, Some(old)) => old.password_enc.clone(),
            (true, None) => String::new(),
        };
        p.ssh.password_enc = match (secret.ssh_password.is_empty(), &prev) {
            (false, _) => encrypt(&secret.ssh_password)?,
            (true, Some(old)) => old.ssh.password_enc.clone(),
            (true, None) => String::new(),
        };
        if p.port == 0 {
            p.port = ConnectionProfile::default_port(p.system);
        }
        out.push(p);
    }
    Ok(out)
}

#[tauri::command]
pub async fn import_connections(
    state: State<'_, AppState>,
    content: String,
    passphrase: Option<String>,
    choices: Vec<ImportChoice>,
) -> Result<Vec<ProfilePublic>, AppError> {
    let entries = tokio::task::spawn_blocking(move || transfer::parse_document(&content, passphrase.as_deref()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(|e| AppError::Other(e.to_string()))?;
    let profiles = apply_choices(
        &entries,
        &choices,
        |id| state.storage.get_connection(id).ok(),
        crypto::encrypt,
    )?;
    let mut saved = Vec::with_capacity(profiles.len());
    for p in profiles {
        state.storage.save_connection(&p)?;
        let connected = state.registry.is_connected(&p.id);
        let latency = state.registry.latency(&p.id);
        saved.push(ProfilePublic::from_profile(p, connected, latency));
    }
    Ok(saved)
}

/// Candidate `data-sources.json` paths under a DBeaver workspace root: both the
/// root's own `.dbeaver/data-sources.json` and `*/General/.dbeaver/…` for each
/// named workspace (workspace6, workspace, …). Pure so it can be unit-tested.
pub fn dbeaver_candidate_paths(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let direct = root.join(".dbeaver").join("data-sources.json");
    if direct.is_file() {
        out.push(direct);
    }
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let p = e.path().join("General").join(".dbeaver").join("data-sources.json");
                if p.is_file() {
                    out.push(p);
                }
            }
        }
    }
    out
}

fn dbeaver_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push(std::path::PathBuf::from(appdata).join("DBeaverData"));
    }
    if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
        roots.push(home.join("Library").join("DBeaverData")); // macOS
        roots.push(home.join(".local").join("share").join("DBeaverData")); // Linux
        roots.push(home.join("DBeaverData"));
    }
    roots
}

/// Paths of DBeaver `data-sources.json` files found in the default workspace
/// locations for this OS. Empty when DBeaver is not installed here.
#[tauri::command]
pub fn find_dbeaver_sources() -> Vec<String> {
    let mut found = Vec::new();
    for root in dbeaver_roots() {
        for p in dbeaver_candidate_paths(&root) {
            found.push(p.to_string_lossy().into_owned());
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, pw: Option<(&str, &str)>) -> Entry {
        let profile: ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "", "name": name, "system": "postgres", "host": "h", "port": 0
        }))
        .unwrap();
        Entry {
            profile,
            secret: pw.map(|(a, b)| Secret { password: a.into(), ssh_password: b.into() }),
        }
    }

    fn enc(s: &str) -> AppResult<String> {
        Ok(format!("ENC({s})"))
    }

    #[test]
    fn add_gets_a_new_id_name_and_this_machines_ciphertext() {
        let entries = vec![entry("Staging", Some(("pw", "sshpw")))];
        let choice = ImportChoice { index: 0, action: "add".into(), target_id: None, name: Some("Staging (2)".into()) };
        let out = apply_choices(&entries, &[choice], |_| None, enc).unwrap();
        assert_eq!(out[0].name, "Staging (2)");
        assert!(!out[0].id.is_empty());
        assert_eq!(out[0].password_enc, "ENC(pw)");
        assert_eq!(out[0].ssh.password_enc, "ENC(sshpw)");
        assert_eq!(out[0].port, 5432, "a missing port gets the engine default");
    }

    #[test]
    fn replace_keeps_the_saved_password_when_the_file_has_none() {
        let mut old = entry("Prod", None).profile;
        old.id = "keep-me".into();
        old.password_enc = "OLD".into();
        old.ssh.password_enc = "OLD-SSH".into();
        let entries = vec![entry("Prod", None), entry("Prod", Some(("new", "")))];
        let find = |id: &str| (id == "keep-me").then(|| old.clone());
        let r = |i| ImportChoice { index: i, action: "replace".into(), target_id: Some("keep-me".into()), name: None };
        let out = apply_choices(&entries, &[r(0)], find, enc).unwrap();
        assert_eq!(out[0].id, "keep-me");
        assert_eq!(out[0].password_enc, "OLD");
        assert_eq!(out[0].ssh.password_enc, "OLD-SSH");
        let out = apply_choices(&entries, &[r(1)], find, enc).unwrap();
        assert_eq!(out[0].password_enc, "ENC(new)", "the file's password wins");
        assert_eq!(out[0].ssh.password_enc, "OLD-SSH", "an absent SSH password keeps the saved one");
    }

    #[test]
    fn bad_choices_are_errors() {
        let entries = vec![entry("A", None)];
        let bad = |action: &str, idx, target: Option<&str>| ImportChoice {
            index: idx,
            action: action.into(),
            target_id: target.map(str::to_string),
            name: None,
        };
        assert!(apply_choices(&entries, &[bad("add", 5, None)], |_| None, enc).is_err());
        assert!(apply_choices(&entries, &[bad("replace", 0, None)], |_| None, enc).is_err());
        assert!(apply_choices(&entries, &[bad("replace", 0, Some("gone"))], |_| None, enc).is_err());
        assert!(apply_choices(&entries, &[bad("merge", 0, None)], |_| None, enc).is_err());
    }

    #[test]
    fn export_and_import_through_storage_carry_every_password() {
        // Machine A: two saved connections (ciphertext under A's "key").
        let a = Storage::open_in_memory().unwrap();
        let mut p1 = entry("Staging", None).profile;
        p1.id = "s".into();
        p1.password_enc = "A:stg-pass".into();
        p1.ssh.password_enc = "A:ssh-pass".into();
        let mut p2 = entry("Reporting", None).profile;
        p2.id = "r".into();
        p2.password_enc = "A:rep-pass".into();
        a.save_connection(&p1).unwrap();
        a.save_connection(&p2).unwrap();
        let dec_a = |s: &str| Ok(s.strip_prefix("A:").unwrap_or("").to_string());
        let doc = build_export(&a, &["s".into(), "r".into()], Some("team file pw"), dec_a).unwrap();

        // Machine B: inspect, then add both.
        let ImportInspect::Ok { sealed, items } = inspect(&doc, Some("team file pw")).unwrap() else {
            panic!("expected the file to open")
        };
        assert!(sealed);
        assert_eq!(items.len(), 2);
        assert!(items[0].has_password && items[0].has_ssh_password && items[1].has_password);
        assert!(matches!(inspect(&doc, None).unwrap(), ImportInspect::NeedsPassphrase));
        assert!(matches!(inspect(&doc, Some("nope nope")).unwrap(), ImportInspect::WrongPassphrase));

        let entries = transfer::parse_document(&doc, Some("team file pw")).unwrap();
        let add = |i| ImportChoice { index: i, action: "add".into(), target_id: None, name: None };
        let enc_b = |s: &str| Ok(format!("B:{s}"));
        let out = apply_choices(&entries, &[add(0), add(1)], |_| None, enc_b).unwrap();
        assert_eq!(out[0].password_enc, "B:stg-pass");
        assert_eq!(out[0].ssh.password_enc, "B:ssh-pass");
        assert_eq!(out[1].password_enc, "B:rep-pass");

        // A password that cannot be read here aborts the export and says which one.
        let broken = |_: &str| -> AppResult<String> { Err(AppError::Crypto("decrypt failed".into())) };
        let err = build_export(&a, &["s".into()], Some("team file pw"), broken).unwrap_err().to_string();
        assert!(err.contains("Staging"), "{err}");
        // Without a file password no secret is read at all.
        assert!(build_export(&a, &["s".into()], None, broken).is_ok());
    }

    #[test]
    fn missing_files_lists_only_absent_paths_in_use() {
        let mut p = entry("X", None).profile;
        p.ssh.enabled = true;
        p.ssh.auth = SshAuthMethod::Key;
        p.ssh.key_path = "Z:/definitely/not/here.pem".into();
        p.ssl = false;
        p.ssl_ca = "Z:/also/missing.pem".into(); // ignored: SSL is off
        assert_eq!(missing_files(&p), vec!["Z:/definitely/not/here.pem".to_string()]);
        p.ssh.key_path = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        assert!(missing_files(&p).is_empty());
    }
    #[test]
    fn dbeaver_candidate_paths_finds_direct_and_workspace_layouts() {
        let dir = std::env::temp_dir().join(format!("ds-dbeaver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ws = dir.join("workspace6").join("General").join(".dbeaver");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("data-sources.json"), "{}").unwrap();
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        let paths = dbeaver_candidate_paths(&dir);
        assert_eq!(paths.len(), 1, "{paths:?}");
        assert!(paths[0].to_string_lossy().contains("workspace6"));
        assert!(dbeaver_candidate_paths(&dir.join("nope")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

}
