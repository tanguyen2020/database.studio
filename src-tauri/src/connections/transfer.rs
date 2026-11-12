//! Export / import of saved connections as a file (moving to a new machine,
//! handing a teammate the team's connections).
//!
//! Two kinds of file:
//!
//! * **Without passwords** — the profiles in clear JSON. Safe to mail around:
//!   hosts, ports and user names only.
//! * **With passwords** — the profiles AND their passwords sealed with a
//!   password the user picks when exporting (the "file password"): Argon2id turns
//!   it into a 256-bit key, AES-256-GCM encrypts the whole payload. The file
//!   says nothing readable — not even the host names — until it is unlocked, and
//!   GCM rejects a file that was altered or a wrong password.
//!
//! The ciphertext stored in a profile (`password_enc`) is encrypted with *this
//! machine's* master key and means nothing on another machine, so it is never
//! written to a file and never trusted when read from one: secrets travel as
//! plaintext inside the sealed payload only and are re-encrypted with the
//! importing machine's key when they are saved.
//!
//! Older files (the v1 export, a bare array of profiles) still import.

use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload as AeadPayload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::connections::profile::ConnectionProfile;

pub const FORMAT: &str = "database-studio-connections";
pub const VERSION: u32 = 2;
/// Shortest file password accepted when exporting with passwords.
pub const MIN_PASSPHRASE_CHARS: usize = 8;

/// Argon2id cost used for new files (OWASP-recommended range). Stored in the
/// file so a later version can raise it and still open old files.
const KDF_M_KIB: u32 = 64 * 1024;
const KDF_T: u32 = 3;
const KDF_P: u32 = 1;
/// Upper bounds accepted from a file — a crafted file must not make the app
/// allocate gigabytes or spin for minutes.
const KDF_MAX_M_KIB: u32 = 1024 * 1024;
const KDF_MAX_T: u32 = 10;
const KDF_MAX_P: u32 = 16;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
/// Bound into the GCM tag: a payload sealed for something else never opens here.
const AAD: &[u8] = b"database-studio-connections/v2";

/// Plaintext secrets of one connection. Empty string = none saved.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Secret {
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub ssh_password: String,
}

impl Secret {
    pub fn is_empty(&self) -> bool {
        self.password.is_empty() && self.ssh_password.is_empty()
    }
}

/// One connection read from (or going into) a file.
#[derive(Debug, Clone)]
pub struct Entry {
    pub profile: ConnectionProfile,
    /// `None` = the file carries no passwords at all (a clear export).
    pub secret: Option<Secret>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Sealed {
    kdf: String,
    m_kib: u32,
    t: u32,
    p: u32,
    salt: String,
    nonce: String,
    data: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SealedPayload {
    profiles: Vec<ConnectionProfile>,
    secrets: Vec<Secret>,
}

#[derive(Debug, Serialize)]
struct Envelope<'a> {
    format: &'a str,
    version: u32,
    exported_at: String,
    count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    profiles: Option<Vec<ConnectionProfile>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted: Option<Sealed>,
}

/// Why a file could not be read. The UI reacts differently to each.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportError {
    /// The file is sealed — ask for its password.
    NeedsPassphrase,
    /// The password does not open it (or the file was altered).
    WrongPassphrase,
    /// Not a connections file / damaged.
    Invalid(String),
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::NeedsPassphrase => write!(f, "This file is protected with a password."),
            ImportError::WrongPassphrase => {
                write!(f, "Wrong password — or the file was changed after it was exported.")
            }
            ImportError::Invalid(m) => write!(f, "{m}"),
        }
    }
}

/// A profile as it may leave this machine: no id (it is a new profile wherever
/// it lands) and none of this machine's ciphertext.
fn portable(p: &ConnectionProfile) -> ConnectionProfile {
    let mut p = p.clone();
    p.id = String::new();
    p.password_enc = String::new();
    p.ssh.password_enc = String::new();
    p
}

fn derive_key(passphrase: &str, salt: &[u8], m_kib: u32, t: u32, p: u32) -> Result<[u8; 32], String> {
    let params = Params::new(m_kib, t, p, Some(32)).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

fn seal(payload: &SealedPayload, passphrase: &str, cost: (u32, u32, u32)) -> Result<Sealed, String> {
    let (m_kib, t, p) = cost;
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let key = derive_key(passphrase, &salt, m_kib, t, p)?;
    let plain = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let ct = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
        .encrypt(Nonce::from_slice(&nonce), AeadPayload { msg: &plain, aad: AAD })
        .map_err(|e| e.to_string())?;
    Ok(Sealed {
        kdf: "argon2id".into(),
        m_kib,
        t,
        p,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        data: B64.encode(ct),
    })
}

fn open(sealed: &Sealed, passphrase: &str) -> Result<SealedPayload, ImportError> {
    let bad = |m: &str| ImportError::Invalid(format!("The protected part of this file is damaged ({m})."));
    if sealed.kdf != "argon2id" {
        return Err(ImportError::Invalid(format!(
            "This file uses '{}', which this version of Database Studio cannot open.",
            sealed.kdf
        )));
    }
    if sealed.m_kib == 0 || sealed.m_kib > KDF_MAX_M_KIB || sealed.t == 0 || sealed.t > KDF_MAX_T || sealed.p == 0 || sealed.p > KDF_MAX_P {
        return Err(bad("key settings out of range"));
    }
    let salt = B64.decode(&sealed.salt).map_err(|_| bad("salt"))?;
    let nonce = B64.decode(&sealed.nonce).map_err(|_| bad("nonce"))?;
    let data = B64.decode(&sealed.data).map_err(|_| bad("data"))?;
    if nonce.len() != NONCE_LEN || salt.len() < 8 {
        return Err(bad("header"));
    }
    let key = derive_key(passphrase, &salt, sealed.m_kib, sealed.t, sealed.p).map_err(|e| bad(&e))?;
    let plain = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
        .decrypt(Nonce::from_slice(&nonce), AeadPayload { msg: &data, aad: AAD })
        .map_err(|_| ImportError::WrongPassphrase)?;
    let payload: SealedPayload =
        serde_json::from_slice(&plain).map_err(|e| bad(&format!("content: {e}")))?;
    if payload.secrets.len() != payload.profiles.len() {
        return Err(bad("passwords do not match the connections"));
    }
    Ok(payload)
}

/// Build an export file. `passphrase: Some` seals the profiles *and* their
/// secrets; `None` writes the profiles in clear and drops every secret.
pub fn export_document(
    items: &[(ConnectionProfile, Secret)],
    passphrase: Option<&str>,
    exported_at: &str,
) -> Result<String, String> {
    export_with_cost(items, passphrase, exported_at, (KDF_M_KIB, KDF_T, KDF_P))
}

fn export_with_cost(
    items: &[(ConnectionProfile, Secret)],
    passphrase: Option<&str>,
    exported_at: &str,
    cost: (u32, u32, u32),
) -> Result<String, String> {
    if items.is_empty() {
        return Err("Pick at least one connection to export.".into());
    }
    let profiles: Vec<ConnectionProfile> = items.iter().map(|(p, _)| portable(p)).collect();
    let (clear, encrypted) = match passphrase {
        Some(pw) => {
            if pw.chars().count() < MIN_PASSPHRASE_CHARS {
                return Err(format!(
                    "The file password must be at least {MIN_PASSPHRASE_CHARS} characters."
                ));
            }
            let payload = SealedPayload {
                profiles,
                secrets: items.iter().map(|(_, s)| s.clone()).collect(),
            };
            (None, Some(seal(&payload, pw, cost)?))
        }
        None => (Some(profiles), None),
    };
    let env = Envelope {
        format: FORMAT,
        version: VERSION,
        exported_at: exported_at.to_string(),
        count: items.len(),
        profiles: clear,
        encrypted,
    };
    serde_json::to_string_pretty(&env).map_err(|e| e.to_string())
}

/// Whether a file is sealed (needs its password before anything can be shown).
pub fn is_sealed(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("encrypted").cloned())
        .is_some_and(|e| !e.is_null())
}

fn profile_from(v: Value, index: usize) -> Result<ConnectionProfile, ImportError> {
    let name = v.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let mut v = v;
    // Older exports carry runtime fields and an empty id — fill what a profile needs.
    if let Some(o) = v.as_object_mut() {
        o.entry("id").or_insert(Value::String(String::new()));
    }
    let p: ConnectionProfile = serde_json::from_value(v).map_err(|e| {
        let what = if name.is_empty() { format!("#{}", index + 1) } else { format!("'{name}'") };
        ImportError::Invalid(format!("Connection {what} in this file could not be read: {e}"))
    })?;
    Ok(portable(&p))
}

/// Read any connections file this app has written (v2 sealed or clear, the v1
/// export, a bare array). Secrets come back only from a sealed file.
pub fn parse_document(text: &str, passphrase: Option<&str>) -> Result<Vec<Entry>, ImportError> {
    let root: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| {
        ImportError::Invalid("This is not a Database Studio connections file (it is not valid JSON).".into())
    })?;

    if let Some(enc) = root.get("encrypted").filter(|e| !e.is_null()) {
        let sealed: Sealed = serde_json::from_value(enc.clone())
            .map_err(|_| ImportError::Invalid("The protected part of this file is damaged.".into()))?;
        let pw = passphrase.filter(|p| !p.is_empty()).ok_or(ImportError::NeedsPassphrase)?;
        let payload = open(&sealed, pw)?;
        return Ok(payload
            .profiles
            .into_iter()
            .zip(payload.secrets)
            .map(|(p, s)| Entry { profile: portable(&p), secret: Some(s) })
            .collect());
    }

    let list = match &root {
        Value::Array(a) => a.clone(),
        Value::Object(o) => match o.get("profiles") {
            Some(Value::Array(a)) => a.clone(),
            _ => {
                return Err(ImportError::Invalid(
                    "This is not a Database Studio connections file (no connections in it).".into(),
                ))
            }
        },
        _ => return Err(ImportError::Invalid("This is not a Database Studio connections file.".into())),
    };
    if let Some(f) = root.get("format").and_then(Value::as_str) {
        if f != FORMAT {
            return Err(ImportError::Invalid(format!("This is a '{f}' file, not a connections file.")));
        }
    }
    list.into_iter()
        .enumerate()
        .map(|(i, v)| Ok(Entry { profile: profile_from(v, i)?, secret: None }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::profile::SshAuthMethod;
    use crate::drivers::types::SystemType;

    /// Cheap Argon2 cost so the tests stay fast (the real cost is only slower).
    const TEST_COST: (u32, u32, u32) = (64, 1, 1);

    fn prof(name: &str, host: &str) -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({
            "id": format!("id-{name}"), "name": name, "system": "postgres",
            "host": host, "port": 5432, "database": "app", "user": "u_".to_string() + name,
            "password_enc": "MACHINE-CIPHERTEXT",
            "ssh": { "enabled": true, "host": "bastion", "port": 22, "user": "ops",
                     "auth": "password", "password_enc": "MACHINE-SSH", "key_path": "" }
        }))
        .unwrap()
    }

    fn secret(pw: &str, ssh: &str) -> Secret {
        Secret { password: pw.into(), ssh_password: ssh.into() }
    }

    #[test]
    fn sealed_round_trip_keeps_every_password() {
        let items = vec![
            (prof("staging", "10.0.0.1"), secret("p@ss Ä 🔑", "ssh-1")),
            (prof("prod", "10.0.0.2"), secret("other", "")),
        ];
        let doc = export_with_cost(&items, Some("correct horse"), "2026-11-07T00:00:00Z", TEST_COST).unwrap();
        assert!(is_sealed(&doc));
        // nothing readable leaks: no host, no user, no password, no machine ciphertext
        for leak in ["10.0.0.1", "u_staging", "p@ss", "MACHINE-CIPHERTEXT", "bastion"] {
            assert!(!doc.contains(leak), "sealed file must not contain {leak}");
        }
        let back = parse_document(&doc, Some("correct horse")).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].profile.name, "staging");
        assert_eq!(back[0].profile.host, "10.0.0.1");
        assert_eq!(back[0].profile.ssh.host, "bastion");
        assert_eq!(back[0].secret, Some(secret("p@ss Ä 🔑", "ssh-1")));
        assert_eq!(back[1].secret, Some(secret("other", "")));
        // a profile never keeps the exporting machine's id or ciphertext
        assert_eq!(back[0].profile.id, "");
        assert_eq!(back[0].profile.password_enc, "");
        assert_eq!(back[0].profile.ssh.password_enc, "");
    }

    #[test]
    fn sealed_file_needs_the_right_password() {
        let items = vec![(prof("a", "h"), secret("x", ""))];
        let doc = export_with_cost(&items, Some("correct horse"), "t", TEST_COST).unwrap();
        assert_eq!(parse_document(&doc, None).unwrap_err(), ImportError::NeedsPassphrase);
        assert_eq!(parse_document(&doc, Some("")).unwrap_err(), ImportError::NeedsPassphrase);
        assert_eq!(parse_document(&doc, Some("wrong horse")).unwrap_err(), ImportError::WrongPassphrase);
    }

    #[test]
    fn a_changed_file_is_rejected() {
        let items = vec![(prof("a", "h"), secret("x", ""))];
        let doc = export_with_cost(&items, Some("correct horse"), "t", TEST_COST).unwrap();
        let mut v: Value = serde_json::from_str(&doc).unwrap();
        let data = v["encrypted"]["data"].as_str().unwrap().to_string();
        let mut bytes = B64.decode(data).unwrap();
        bytes[3] ^= 0x01;
        v["encrypted"]["data"] = Value::String(B64.encode(bytes));
        let altered = serde_json::to_string(&v).unwrap();
        assert_eq!(parse_document(&altered, Some("correct horse")).unwrap_err(), ImportError::WrongPassphrase);
    }

    #[test]
    fn hostile_key_settings_are_refused_before_any_work() {
        let items = vec![(prof("a", "h"), secret("x", ""))];
        let doc = export_with_cost(&items, Some("correct horse"), "t", TEST_COST).unwrap();
        let mut v: Value = serde_json::from_str(&doc).unwrap();
        v["encrypted"]["m_kib"] = Value::from(64u64 * 1024 * 1024);
        let err = parse_document(&serde_json::to_string(&v).unwrap(), Some("correct horse")).unwrap_err();
        assert!(matches!(err, ImportError::Invalid(m) if m.contains("out of range")));
    }

    #[test]
    fn clear_export_drops_every_secret() {
        let items = vec![(prof("a", "10.1.1.1"), secret("topsecret", "sshsecret"))];
        let doc = export_document(&items, None, "t").unwrap();
        assert!(!is_sealed(&doc));
        assert!(!doc.contains("topsecret") && !doc.contains("sshsecret"));
        assert!(!doc.contains("MACHINE-CIPHERTEXT") && !doc.contains("MACHINE-SSH"));
        let back = parse_document(&doc, None).unwrap();
        assert_eq!(back[0].profile.host, "10.1.1.1");
        assert!(back[0].secret.is_none());
    }

    #[test]
    fn short_or_missing_selection_is_refused() {
        let items = vec![(prof("a", "h"), Secret::default())];
        assert!(export_document(&items, Some("short"), "t").unwrap_err().contains("at least 8"));
        assert!(export_document(&[], None, "t").is_err());
    }

    #[test]
    fn older_files_still_import() {
        // v1 export: {version:1, profiles:[ProfilePublic minus runtime keys]} — and the bare array
        let v1 = r#"{"version":1,"profiles":[{"id":"","name":"Old","system":"mysql","host":"db","port":3306,
            "database":"x","user":"root","has_password":true,"connected":false,"env":"production",
            "ssh":{"enabled":false,"host":"","port":22,"user":"","auth":"key","key_path":"C:/k.pem"}}]}"#;
        let back = parse_document(v1, None).unwrap();
        assert_eq!(back[0].profile.name, "Old");
        assert_eq!(back[0].profile.system, SystemType::Mysql);
        assert_eq!(back[0].profile.ssh.auth, SshAuthMethod::Key);
        assert_eq!(back[0].profile.ssh.key_path, "C:/k.pem");
        let bare = r#"[{"name":"Bare","system":"redis","host":"cache","port":6379}]"#;
        assert_eq!(parse_document(bare, None).unwrap()[0].profile.name, "Bare");
        // with a UTF-8 BOM (files saved by Notepad)
        assert_eq!(parse_document(&format!("\u{feff}{bare}"), None).unwrap().len(), 1);
    }

    #[test]
    fn garbage_is_explained() {
        assert!(matches!(parse_document("not json", None), Err(ImportError::Invalid(m)) if m.contains("not valid JSON")));
        assert!(matches!(parse_document("{\"a\":1}", None), Err(ImportError::Invalid(_))));
        let other = r#"{"format":"something-else","profiles":[]}"#;
        assert!(matches!(parse_document(other, None), Err(ImportError::Invalid(m)) if m.contains("something-else")));
        let bad_system = r#"[{"name":"X","system":"nope"}]"#;
        assert!(matches!(parse_document(bad_system, None), Err(ImportError::Invalid(m)) if m.contains("'X'")));
    }
}
