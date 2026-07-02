use serde::{Deserialize, Serialize};

/// Normalized execution error per QUERY_EDITOR_ERROR_HANDLING_ADDENDUM §2.1.
/// Every driver maps its native error into this struct; the raw driver text is
/// always preserved for the "View raw" button.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryError {
    pub system: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statement_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
    /// Position within the *statement* (1-based). The frontend adds the
    /// statement's offset in the document; never guessed when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<ErrorPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    pub severity: String, // "error" | "warning"
    pub raw: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ErrorPosition {
    pub line: u32,
    pub col: u32,
}

impl QueryError {
    pub fn new(system: &str, message: impl Into<String>, raw: impl Into<String>) -> Self {
        Self {
            system: system.to_string(),
            statement_index: None,
            code: None,
            message: message.into(),
            position: None,
            hint: None,
            severity: "error".into(),
            raw: raw.into(),
        }
    }
}

/// Internal app error (storage, crypto, config, tunnel...). Converted to a
/// plain string for IPC responses that are not query executions.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("storage error: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("connection not found: {0}")]
    ConnectionNotFound(String),
    #[error("not connected: {0}")]
    NotConnected(String),
    #[error("ssh tunnel error: {0}")]
    Tunnel(String),
    #[error("driver error: {0}")]
    Driver(String),
    #[error("unsupported system: {0}")]
    UnsupportedSystem(String),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
