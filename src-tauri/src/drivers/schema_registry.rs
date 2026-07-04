//! Confluent Schema Registry client (Phase 4 T7). Read-only browser over the
//! standard REST API (`/subjects`, `/subjects/{s}/versions`, `.../versions/{v}`,
//! `/config[/{s}]`). Stateless HTTP — built on-demand from the Kafka profile's
//! `schema_registry_url`; not part of the `LiveConnection` enum.

use serde::{Deserialize, Serialize};

use crate::error::QueryError;

/// Endpoint + optional basic auth resolved from the connection profile.
#[derive(Debug, Clone)]
pub struct SchemaRegistryParams {
    pub base_url: String,
    pub user: String,
    pub password: String,
}

/// One subject as shown in the left list: format + latest version + compat.
#[derive(Debug, Clone, Serialize)]
pub struct SrSubject {
    pub name: String,
    pub fmt: String,
    pub latest: i32,
    pub compat: String,
}

/// A single registered schema version (right pane).
#[derive(Debug, Clone, Serialize)]
pub struct SrSchema {
    pub subject: String,
    pub version: i32,
    pub id: i64,
    pub fmt: String,
    pub schema: String,
    pub compat: String,
}

#[derive(Debug, Deserialize)]
struct VersionResponse {
    #[serde(default)]
    id: i64,
    version: i32,
    schema: String,
    #[serde(rename = "schemaType", default)]
    schema_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConfigResponse {
    #[serde(rename = "compatibilityLevel", default)]
    compatibility_level: Option<String>,
    #[serde(rename = "compatibility", default)]
    compatibility: Option<String>,
}

fn err(e: impl std::fmt::Display) -> QueryError {
    QueryError::new("schema-registry", format!("Schema Registry: {e}"), format!("{e}"))
}

/// `schemaType` is absent for AVRO in the Confluent API; normalise to a label.
fn fmt_label(t: &Option<String>) -> String {
    match t.as_deref() {
        None | Some("") | Some("AVRO") => "AVRO".to_string(),
        Some(other) => other.to_string(),
    }
}

pub struct SchemaRegistryClient {
    http: reqwest::Client,
    params: SchemaRegistryParams,
}

impl SchemaRegistryClient {
    pub fn new(params: SchemaRegistryParams) -> Result<Self, QueryError> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(err)?;
        Ok(Self { http, params })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.params.base_url.trim_end_matches('/'), path.trim_start_matches('/'))
    }

    fn req(&self, url: String) -> reqwest::RequestBuilder {
        let rb = self.http.get(url).header("Accept", "application/vnd.schemaregistry.v1+json");
        if self.params.user.is_empty() {
            rb
        } else {
            rb.basic_auth(&self.params.user, Some(&self.params.password))
        }
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, QueryError> {
        let resp = self.req(self.url(path)).send().await.map_err(err)?;
        if !resp.status().is_success() {
            let code = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(err(format!("HTTP {code} — {body}")));
        }
        resp.json::<T>().await.map_err(err)
    }

    /// Compatibility level for a subject; falls back to the global config when
    /// the subject has no override (SR returns 404 in that case).
    async fn compat(&self, subject: &str) -> String {
        let path = format!("config/{}", urlencode(subject));
        let cfg: Option<ConfigResponse> = self.get_json(&path).await.ok();
        if let Some(level) = cfg.and_then(|c| c.compatibility_level.or(c.compatibility)) {
            return level;
        }
        let global: Option<ConfigResponse> = self.get_json("config").await.ok();
        global
            .and_then(|c| c.compatibility_level.or(c.compatibility))
            .unwrap_or_else(|| "BACKWARD".to_string())
    }

    /// List subjects with format + latest version + compatibility (left list).
    pub async fn subjects(&self) -> Result<Vec<SrSubject>, QueryError> {
        let names: Vec<String> = self.get_json("subjects").await?;
        let mut out = Vec::with_capacity(names.len());
        for name in names {
            let path = format!("subjects/{}/versions/latest", urlencode(&name));
            let latest: VersionResponse = match self.get_json(&path).await {
                Ok(v) => v,
                Err(_) => continue, // soft-deleted / permission — skip in list
            };
            let compat = self.compat(&name).await;
            out.push(SrSubject {
                name,
                fmt: fmt_label(&latest.schema_type),
                latest: latest.version,
                compat,
            });
        }
        Ok(out)
    }

    /// Version numbers registered for a subject (newest last).
    pub async fn versions(&self, subject: &str) -> Result<Vec<i32>, QueryError> {
        let path = format!("subjects/{}/versions", urlencode(subject));
        self.get_json(&path).await
    }

    /// A specific registered schema version.
    pub async fn schema(&self, subject: &str, version: i32) -> Result<SrSchema, QueryError> {
        let path = format!("subjects/{}/versions/{}", urlencode(subject), version);
        let v: VersionResponse = self.get_json(&path).await?;
        let compat = self.compat(subject).await;
        Ok(SrSchema {
            subject: subject.to_string(),
            version: v.version,
            id: v.id,
            fmt: fmt_label(&v.schema_type),
            schema: v.schema,
            compat,
        })
    }
}

/// Minimal percent-encoding for subject names in path segments (they may
/// contain '/', ':' etc.). Only encodes what breaks a URL path segment.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
