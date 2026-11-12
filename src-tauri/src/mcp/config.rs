//! MCP configuration, bearer token and audit log — persisted in the internal
//! `app_state` key/value store (no schema migration). The token is encrypted with
//! the same master key as connection passwords and never leaves the backend.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::error::AppResult;
use crate::storage::{crypto, Storage};

const CONFIG_KEY: &str = "mcp_config";
const TOKEN_KEY: &str = "mcp_token";
const AUDIT_KEY: &str = "mcp_audit";
const AUDIT_CAP: usize = 500;

pub const DEFAULT_PORT: u16 = 4319;
pub const DEFAULT_ROW_CAP: u32 = 1000;
pub const MAX_ROW_CAP: u32 = 100_000;

/// What an agent may do with one connection. Both default off — nothing is exposed
/// until the user ticks it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnPolicy {
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub write: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    /// Reads run automatically; writes run automatically (still need write opt-in).
    Auto,
    /// Reads auto; every write waits for an in-app Allow/Deny. (default)
    AskOnWrite,
    /// Every tool call waits for Allow/Deny.
    AskOnEverything,
}

impl Default for ApprovalMode {
    fn default() -> Self {
        ApprovalMode::AskOnWrite
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_cap")]
    pub row_cap: u32,
    #[serde(default)]
    pub approval_mode: ApprovalMode,
    /// Per connection id → what the agent may do. Missing id = no access.
    #[serde(default)]
    pub connections: BTreeMap<String, ConnPolicy>,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}
fn default_cap() -> u32 {
    DEFAULT_ROW_CAP
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            row_cap: DEFAULT_ROW_CAP,
            approval_mode: ApprovalMode::default(),
            connections: BTreeMap::new(),
        }
    }
}

impl McpConfig {
    /// Clamp user-supplied values to safe ranges.
    pub fn sanitized(mut self) -> Self {
        if self.port < 1024 {
            self.port = DEFAULT_PORT;
        }
        self.row_cap = self.row_cap.clamp(1, MAX_ROW_CAP);
        self
    }

    pub fn conn(&self, id: &str) -> ConnPolicy {
        self.connections.get(id).cloned().unwrap_or_default()
    }
}

pub fn load_config(storage: &Storage) -> McpConfig {
    storage
        .get_state(CONFIG_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<McpConfig>(&s).ok())
        .unwrap_or_default()
        .sanitized()
}

pub fn save_config(storage: &Storage, cfg: &McpConfig) -> AppResult<()> {
    let json = serde_json::to_string(cfg).map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    storage.set_state(CONFIG_KEY, &json)
}

/// The current bearer token, decrypted. Creates and stores one on first use.
pub fn load_or_create_token(storage: &Storage) -> AppResult<String> {
    if let Some(enc) = storage.get_state(TOKEN_KEY)? {
        if let Ok(tok) = crypto::decrypt(&enc) {
            if !tok.is_empty() {
                return Ok(tok);
            }
        }
    }
    rotate_token(storage)
}

pub fn rotate_token(storage: &Storage) -> AppResult<String> {
    let tok = random_token();
    storage.set_state(TOKEN_KEY, &crypto::encrypt(&tok)?)?;
    Ok(tok)
}

fn random_token() -> String {
    use rand::Rng;
    const HEX: &[u8] = b"0123456789abcdef";
    let mut rng = rand::thread_rng();
    (0..48).map(|_| HEX[rng.gen_range(0..16)] as char).collect()
}

// ---- audit log -------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    /// "ok" | "blocked" | "denied" | "error"
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub fn load_audit(storage: &Storage) -> Vec<AuditEntry> {
    storage
        .get_state(AUDIT_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Vec<AuditEntry>>(&s).ok())
        .unwrap_or_default()
}

pub fn append_audit(storage: &Storage, entry: AuditEntry) {
    let mut all = load_audit(storage);
    all.push(entry);
    let len = all.len();
    if len > AUDIT_CAP {
        all.drain(0..len - AUDIT_CAP);
    }
    if let Ok(json) = serde_json::to_string(&all) {
        let _ = storage.set_state(AUDIT_KEY, &json);
    }
}

pub fn clear_audit(storage: &Storage) {
    let _ = storage.set_state(AUDIT_KEY, "[]");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_off_and_safe() {
        let c = McpConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.port, DEFAULT_PORT);
        assert_eq!(c.row_cap, DEFAULT_ROW_CAP);
        assert_eq!(c.approval_mode, ApprovalMode::AskOnWrite);
        assert!(c.connections.is_empty());
        assert_eq!(c.conn("anything"), ConnPolicy { read: false, write: false });
    }

    #[test]
    fn sanitized_clamps() {
        let c = McpConfig { port: 80, row_cap: 9_999_999, ..Default::default() }.sanitized();
        assert_eq!(c.port, DEFAULT_PORT);
        assert_eq!(c.row_cap, MAX_ROW_CAP);
        let c2 = McpConfig { row_cap: 0, ..Default::default() }.sanitized();
        assert_eq!(c2.row_cap, 1);
    }

    #[test]
    fn config_json_roundtrip() {
        let mut c = McpConfig::default();
        c.enabled = true;
        c.connections.insert("c1".into(), ConnPolicy { read: true, write: false });
        let s = serde_json::to_string(&c).unwrap();
        let back: McpConfig = serde_json::from_str(&s).unwrap();
        assert!(back.enabled);
        assert_eq!(back.conn("c1"), ConnPolicy { read: true, write: false });
    }

    #[test]
    fn random_token_is_long_and_hex() {
        let t = random_token();
        assert_eq!(t.len(), 48);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, random_token());
    }
}
