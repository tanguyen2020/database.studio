//! Redpanda Admin API (SPEC-REDPANDA.md) — the HTTP API Redpanda serves beside the
//! Kafka protocol (port 9644): cluster health, brokers (disk, version, maintenance),
//! cluster configuration with its schema, partition balancer, license, SASL users,
//! roles and data transforms. Redpanda is a flavor of the Kafka engine: topics,
//! messages and consumer groups still go through the Kafka driver.
//!
//! `request` is the generic call every Redpanda screen is built on (like the
//! Elasticsearch REST call): a non-2xx answer is returned as-is, not as an error.

use std::time::{Duration, Instant};

use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::QueryError;

const SYSTEM: &str = "kafka";
/// Admin API port when the profile leaves the URL empty.
pub const ADMIN_PORT: u16 = 9644;
/// Built-in Schema Registry port.
pub const SCHEMA_REGISTRY_PORT: u16 = 8081;

#[derive(Debug, Clone)]
pub struct RpAdminParams {
    pub base_url: String,
    /// SASL user / password — Redpanda's Admin API authenticates with the same SCRAM users
    /// when `admin_api_require_auth` is on; empty = no Authorization header.
    pub user: String,
    pub password: String,
    /// CA certificate (PEM) for an HTTPS Admin API with a private CA.
    pub ssl_ca: String,
}

/// One Admin API answer, as the console / screens show it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpResponse {
    pub status: u16,
    pub ok: bool,
    pub json: Option<Value>,
    pub text: Option<String>,
    pub took_ms: u64,
}

/// What the app learns about the server on connect (SPEC-REDPANDA.md R1).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RpServerInfo {
    /// "redpanda" when the Admin API answered, else "kafka"
    pub flavor: String,
    /// "v26.2.6" — the git hash Redpanda appends is dropped
    pub version: String,
    /// "Redpanda v26.2.6" / "Apache Kafka"
    pub label: String,
    pub brokers: usize,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/// First host of a Kafka host field: `broker1:9092,broker2:9092` → `broker1`,
/// `[::1]:9092` → `[::1]`, `kafka.example.com` → `kafka.example.com`.
pub fn first_host(host_field: &str) -> String {
    let first = host_field.split(',').next().unwrap_or("").trim();
    let no_scheme = first.split("://").last().unwrap_or(first);
    if let Some(rest) = no_scheme.strip_prefix('[') {
        // IPv6 literal
        return rest.split(']').next().map(|h| format!("[{h}]")).unwrap_or_default();
    }
    no_scheme.split(':').next().unwrap_or("").to_string()
}

/// A Redpanda service URL on the first broker host: the Admin API (9644) or the
/// built-in Schema Registry (8081) when the profile leaves the URL empty.
pub fn service_url(explicit: &str, host_field: &str, ssl: bool, port: u16) -> String {
    let explicit = explicit.trim().trim_end_matches('/');
    if !explicit.is_empty() {
        return if explicit.contains("://") { explicit.to_string() } else { format!("http://{explicit}") };
    }
    let host = first_host(host_field);
    let host = if host.is_empty() { "localhost".to_string() } else { host };
    format!("{}://{host}:{port}", if ssl { "https" } else { "http" })
}

/// `v26.2.6 - 06e1aca30b…` → `v26.2.6`.
pub fn clean_version(v: &str) -> String {
    v.split(" - ").next().unwrap_or(v).trim().to_string()
}

/// Readable text for a failed Admin API call. Redpanda answers
/// `{"message": "...", "code": 400}`, and the config dry run `{"key": "expected type integer"}`.
pub fn describe_admin_error(status: u16, body: &str) -> String {
    let v = serde_json::from_str::<Value>(body).ok();
    if status == 401 {
        return "Authentication failed — check the SASL user and password (the Admin API requires them)".into();
    }
    if status == 403 {
        let m = v.as_ref().and_then(|v| v.get("message")).and_then(Value::as_str).unwrap_or("the user is not a superuser");
        return format!("Not allowed — {m}");
    }
    if let Some(m) = v.as_ref().and_then(|v| v.get("message")).and_then(Value::as_str) {
        return admin_message(m);
    }
    if let Some(o) = v.as_ref().and_then(Value::as_object) {
        // per-property validation errors of a config change
        let parts: Vec<String> = o.iter().filter_map(|(k, v)| v.as_str().map(|s| format!("{k}: {s}"))).collect();
        if !parts.is_empty() {
            return parts.join(" · ");
        }
    }
    let t = body.trim();
    if t.is_empty() { format!("Redpanda Admin API {status}") } else { format!("Redpanda Admin API {status}: {}", t.chars().take(300).collect::<String>()) }
}

/// Redpanda's `message`, readable: some answers nest the real JSON error inside the
/// message string (`{"message": "{\"message\":\"Role already exists\",…}"}`, measured on
/// v26.2.6) and some prefix it with "Unexpected cluster error: ".
fn admin_message(m: &str) -> String {
    let inner = serde_json::from_str::<Value>(m)
        .ok()
        .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| m.to_string());
    inner.trim_start_matches("Unexpected cluster error: ").to_string()
}

/// Only paths on the Admin API (no absolute URLs smuggled in by a typed path).
pub fn admin_request_url(base: &Url, path: &str) -> Result<Url, QueryError> {
    let p = path.trim();
    if p.contains("://") || p.starts_with("//") {
        return Err(QueryError::new(SYSTEM, "Only paths on the Admin API are allowed", p));
    }
    let p = p.trim_start_matches('/');
    let mut base = base.clone();
    if !base.path().ends_with('/') {
        let bp = format!("{}/", base.path());
        base.set_path(&bp);
    }
    base.join(p).map_err(|e| QueryError::new(SYSTEM, format!("Bad Admin API path: {e}"), p))
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct RpAdmin {
    client: reqwest::Client,
    base: Url,
    user: String,
    password: String,
}

impl RpAdmin {
    pub fn new(p: &RpAdminParams) -> Result<Self, QueryError> {
        let base = Url::parse(&p.base_url).map_err(|e| QueryError::new(SYSTEM, format!("Bad Admin API URL {}: {e}", p.base_url), e.to_string()))?;
        let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(60));
        if base.scheme() == "https" && !p.ssl_ca.trim().is_empty() {
            let pem = std::fs::read(p.ssl_ca.trim()).map_err(|e| QueryError::new(SYSTEM, format!("Cannot read CA certificate {}", p.ssl_ca), e.to_string()))?;
            let cert = reqwest::Certificate::from_pem(&pem).map_err(|e| QueryError::new(SYSTEM, "Invalid CA certificate (PEM expected)", e.to_string()))?;
            b = b.add_root_certificate(cert);
        }
        let client = b.build().map_err(|e| QueryError::new(SYSTEM, e.to_string(), e.to_string()))?;
        Ok(Self { client, base, user: p.user.clone(), password: p.password.clone() })
    }

    /// Any Admin API call; a non-2xx answer comes back as-is (status + Redpanda's message).
    pub async fn request(&self, method: &str, path: &str, body: Option<String>) -> Result<RpResponse, QueryError> {
        let m = Method::from_bytes(method.trim().to_ascii_uppercase().as_bytes()).map_err(|_| QueryError::new(SYSTEM, format!("Unknown method {method}"), method))?;
        let url = admin_request_url(&self.base, path)?;
        let mut rb = self.client.request(m, url.clone());
        if !self.user.is_empty() {
            rb = rb.basic_auth(&self.user, Some(&self.password));
        }
        if let Some(b) = body.filter(|b| !b.trim().is_empty()) {
            rb = rb.header("Content-Type", "application/json").body(b);
        }
        let started = Instant::now();
        let r = rb.send().await.map_err(|e| {
            QueryError::new(
                SYSTEM,
                format!("Cannot reach the Redpanda Admin API at {} — check the Admin API URL (port 9644)", self.base.as_str().trim_end_matches('/')),
                e.to_string(),
            )
        })?;
        let status = r.status().as_u16();
        let text = r.text().await.unwrap_or_default();
        let json = serde_json::from_str::<Value>(&text).ok();
        Ok(RpResponse {
            status,
            ok: (200..300).contains(&status),
            text: if json.is_some() || text.is_empty() { None } else { Some(text) },
            json,
            took_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Detect Redpanda: `GET /v1/brokers` answers only on a Redpanda Admin API.
    pub async fn server_info(&self) -> Result<RpServerInfo, QueryError> {
        let r = self.request("GET", "/v1/brokers", None).await?;
        if !r.ok {
            let raw = r.json.as_ref().map(|j| j.to_string()).or(r.text.clone()).unwrap_or_default();
            return Err(QueryError::new(SYSTEM, describe_admin_error(r.status, &raw), raw));
        }
        let brokers = r.json.as_ref().and_then(Value::as_array).cloned().unwrap_or_default();
        let version = brokers
            .iter()
            .filter_map(|b| b.get("version").and_then(Value::as_str))
            .map(clean_version)
            .find(|v| !v.is_empty())
            .unwrap_or_default();
        Ok(RpServerInfo {
            flavor: "redpanda".into(),
            label: if version.is_empty() { "Redpanda".into() } else { format!("Redpanda {version}") },
            version,
            brokers: brokers.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_urls_follow_the_first_broker() {
        assert_eq!(first_host("broker1:9092,broker2:9092"), "broker1");
        assert_eq!(first_host(" kafka.example.com "), "kafka.example.com");
        assert_eq!(first_host("[::1]:9092"), "[::1]");
        assert_eq!(first_host("SASL_SSL://b1:9093"), "b1");
        assert_eq!(service_url("", "b1:9092,b2:9092", false, ADMIN_PORT), "http://b1:9644");
        assert_eq!(service_url("", "b1", true, SCHEMA_REGISTRY_PORT), "https://b1:8081");
        assert_eq!(service_url("", "", false, ADMIN_PORT), "http://localhost:9644");
        // an explicit URL wins; a bare host:port gets http://
        assert_eq!(service_url("https://admin.corp:443/", "b1", false, ADMIN_PORT), "https://admin.corp:443");
        assert_eq!(service_url("admin.corp:9644", "b1", false, ADMIN_PORT), "http://admin.corp:9644");
    }

    #[test]
    fn versions_and_errors_read_like_redpanda_writes_them() {
        assert_eq!(clean_version("v26.2.6 - 06e1aca30b726c8de9dc9db5c2b83b4da8edf6d0"), "v26.2.6");
        assert_eq!(clean_version("v24.1.1"), "v24.1.1");
        // measured on v26.2.6
        assert_eq!(
            describe_admin_error(400, r#"{"message": "Maintenance mode may not be used on a single node cluster", "code": 400}"#),
            "Maintenance mode may not be used on a single node cluster"
        );
        assert_eq!(describe_admin_error(400, r#"{"log_retention_ms":"expected type integer"}"#), "log_retention_ms: expected type integer");
        assert!(describe_admin_error(401, "").starts_with("Authentication failed"));
        assert!(describe_admin_error(403, r#"{"message":"Forbidden"}"#).starts_with("Not allowed — Forbidden"));
        assert_eq!(describe_admin_error(502, ""), "Redpanda Admin API 502");
        assert_eq!(
            describe_admin_error(409, r#"{"message": "{\"message\":\"Role already exists\",\"code\":40901}", "code": 409}"#),
            "Role already exists"
        );
        assert_eq!(describe_admin_error(500, r#"{"message": "Unexpected cluster error: User already exists", "code": 500}"#), "User already exists");
    }

    #[test]
    fn requests_stay_on_the_admin_api() {
        let base = Url::parse("http://b1:9644").unwrap();
        assert_eq!(admin_request_url(&base, "/v1/brokers").unwrap().as_str(), "http://b1:9644/v1/brokers");
        assert_eq!(admin_request_url(&base, "v1/cluster_config?include_defaults=true").unwrap().as_str(), "http://b1:9644/v1/cluster_config?include_defaults=true");
        let prefixed = Url::parse("https://gw.corp/redpanda").unwrap();
        assert_eq!(admin_request_url(&prefixed, "/v1/brokers").unwrap().as_str(), "https://gw.corp/redpanda/v1/brokers");
        assert!(admin_request_url(&base, "http://evil/v1").is_err());
        assert!(admin_request_url(&base, "//evil/v1").is_err());
    }
}
