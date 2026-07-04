use serde::{Deserialize, Serialize};

use crate::drivers::types::SystemType;

/// SQLite open mode (SQLite as a *user database*, not the internal store).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SqliteMode {
    #[default]
    ReadWrite,
    ReadOnly,
    InMemory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Production,
    Staging,
    #[default]
    Development,
    Local,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthMethod {
    #[default]
    Password,
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SshConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuthMethod,
    /// Encrypted with the master key; empty when auth = Key.
    #[serde(default)]
    pub password_enc: String,
    /// Path only — private keys are never copied into app storage.
    #[serde(default)]
    pub key_path: String,
}

/// A stored connection profile. `password_enc` is AES-256-GCM ciphertext
/// (base64 nonce||ct); the plaintext never touches the profile store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub system: SystemType,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password_enc: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub env: Environment,
    #[serde(default)]
    pub ssh: SshConfig,
    #[serde(default)]
    pub ssl: bool,
    /// TLS material — path only (files never copied into app storage). Empty =
    /// dùng CA hệ thống / bỏ qua. Client cert+key dùng cho mutual TLS.
    #[serde(default)]
    pub ssl_ca: String,
    #[serde(default)]
    pub ssl_cert: String,
    #[serde(default)]
    pub ssl_key: String,
    /// SQLite only: file path ("" for in-memory).
    #[serde(default)]
    pub sqlite_path: String,
    #[serde(default)]
    pub sqlite_mode: SqliteMode,
    /// MSSQL only: "sql" | "windows" (Azure AD variants are out of Phase-1 scope).
    #[serde(default)]
    pub mssql_auth: String,
    /// Kafka only: Confluent Schema Registry base URL (empty = no registry).
    #[serde(default)]
    pub schema_registry_url: String,
    /// Cassandra only: local datacenter for the load-balancing policy.
    #[serde(default)]
    pub cassandra_dc: String,
    /// Cassandra only: default consistency level (LOCAL_QUORUM if empty).
    #[serde(default)]
    pub cassandra_consistency: String,
}

impl ConnectionProfile {
    pub fn default_port(system: SystemType) -> u16 {
        match system {
            SystemType::Postgres => 5432,
            SystemType::Mysql | SystemType::Mariadb => 3306,
            SystemType::Mssql => 1433,
            SystemType::Sqlite => 0,
            SystemType::Clickhouse => 8123,
            SystemType::Cassandra => 9042,
            SystemType::Redis => 6379,
            SystemType::Kafka => 9092,
            SystemType::Nats => 4222,
        }
    }
}

/// Profile as sent to the frontend: no ciphertext, just a has-password flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfilePublic {
    #[serde(flatten)]
    pub profile: ConnectionProfile,
    pub has_password: bool,
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
}

impl ProfilePublic {
    pub fn from_profile(mut profile: ConnectionProfile, connected: bool, latency_ms: Option<u64>) -> Self {
        let has_password = !profile.password_enc.is_empty();
        profile.password_enc = String::new();
        profile.ssh.password_enc = String::new();
        Self { profile, has_password, connected, latency_ms }
    }
}
