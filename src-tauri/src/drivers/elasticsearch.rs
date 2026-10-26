//! Elasticsearch driver — talks to the cluster through its **REST API** (port 9200)
//! with `reqwest`, the same way Kibana does.
//!
//! The REST API *is* the product surface: every feature (search, mappings, index
//! management, templates, ingest pipelines, ILM, snapshots, security, SQL, ES|QL…)
//! is an HTTP endpoint. So the driver exposes one generic, fully-featured
//! [`EsDriver::request`] (what the Dev Tools console sends) plus a few typed reads
//! the explorer needs on every refresh. Non-2xx answers of `request` are *not*
//! errors — the console shows Elasticsearch's own error document, exactly like
//! Kibana. The typed helpers turn them into a readable [`QueryError`].
//!
//! SQL: the generic `exec` arm of `LiveConnection` runs Elasticsearch SQL
//! (`POST /_sql?format=json`, following the cursor), so a Query Editor tab on an
//! Elasticsearch connection works with the regular result grid.
//!
//! Also accepts OpenSearch clusters (same REST surface for the core APIs).

use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::drivers::types::{ColumnInfo, QueryResultSet, StatementOutcome, TableInfo, TestResult};
use crate::error::QueryError;

const SYSTEM: &str = "elasticsearch";

/// Upper bound for the rows the SQL `exec` path collects by following cursors.
pub const SQL_MAX_ROWS: usize = 10_000;
/// Rows per SQL page (`fetch_size`).
pub const SQL_FETCH_SIZE: usize = 1_000;

#[derive(Clone, Debug)]
pub struct EsConnParams {
    /// Host name, or a full URL (`https://my-deployment.es.io`) — then the scheme,
    /// port and path prefix of the URL are used.
    pub host: String,
    pub port: u16,
    /// "basic" (default) | "apikey" | "bearer" | "none"
    pub auth: String,
    pub user: String,
    /// Password (basic), API key (apikey — encoded key or `id:api_key`) or token (bearer).
    pub password: String,
    pub ssl: bool,
    pub ssl_ca: String,
    pub ssl_cert: String,
    pub ssl_key: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum EsAuth {
    None,
    Basic(String, String),
    ApiKey(String),
    Bearer(String),
}

/// Cheap to clone (reqwest::Client is an Arc): commands copy it out of the
/// registry lock and make their HTTP round trip without holding the connection.
#[derive(Clone)]
pub struct EsDriver {
    client: reqwest::Client,
    base: Url,
    auth: EsAuth,
    info: EsInfo,
}

// ---------------------------------------------------------------------------
// Wire types (what the frontend receives)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct EsInfo {
    /// Node that answered `GET /`.
    pub name: String,
    pub cluster_name: String,
    pub cluster_uuid: String,
    pub version: String,
    /// "elasticsearch" | "opensearch"
    pub distribution: String,
    pub lucene_version: String,
    pub build_flavor: String,
    pub tagline: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EsOverview {
    pub info: EsInfo,
    /// green | yellow | red (empty when the health API is refused)
    pub status: String,
    pub number_of_nodes: u64,
    pub number_of_data_nodes: u64,
    pub active_primary_shards: u64,
    pub active_shards: u64,
    pub relocating_shards: u64,
    pub initializing_shards: u64,
    pub unassigned_shards: u64,
    pub number_of_pending_tasks: u64,
    pub active_shards_percent: f64,
    /// `None` when `_cluster/stats` is refused (restricted user).
    pub indices: Option<u64>,
    pub docs: Option<u64>,
    pub store_bytes: Option<u64>,
    /// Message of a refused part, so the UI can say what it could not read.
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct EsIndex {
    pub name: String,
    /// green | yellow | red | "" (closed)
    pub health: String,
    /// open | close
    pub status: String,
    pub uuid: String,
    pub primaries: Option<u64>,
    pub replicas: Option<u64>,
    /// `None` for a closed index (Elasticsearch cannot count it).
    pub docs_count: Option<u64>,
    pub docs_deleted: Option<u64>,
    pub store_bytes: Option<u64>,
    pub pri_store_bytes: Option<u64>,
    pub created: String,
    /// System/hidden index (name starts with '.').
    pub hidden: bool,
    /// Backing index of a data stream (`.ds-<stream>-…`).
    pub data_stream: Option<String>,
}

/// Raw answer of [`EsDriver::request`]: always returned, whatever the status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EsResponse {
    pub status: u16,
    pub ok: bool,
    /// Parsed body when it is JSON.
    pub json: Option<Value>,
    /// Body as text when it is not JSON (e.g. `_cat` APIs without `format=json`).
    pub text: Option<String>,
    pub took_ms: u64,
    pub content_type: String,
    /// `Warning` headers (deprecations…), as Kibana's console shows them.
    pub warnings: Vec<String>,
    /// Body size in bytes.
    pub bytes: u64,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/// Which credentials to send. An empty auth method means "basic", and basic with
/// neither user nor password means no `Authorization` header at all.
pub fn resolve_auth(method: &str, user: &str, password: &str) -> EsAuth {
    match method.trim().to_ascii_lowercase().as_str() {
        "none" => EsAuth::None,
        "apikey" | "api-key" | "api_key" => {
            let k = password.trim();
            // `id:api_key` (what POST _security/api_key returns as two fields) → the
            // base64 "encoded" form the header expects. An already-encoded key passes.
            if k.contains(':') {
                EsAuth::ApiKey(base64::engine::general_purpose::STANDARD.encode(k))
            } else {
                EsAuth::ApiKey(k.to_string())
            }
        }
        "bearer" | "token" => EsAuth::Bearer(password.trim().to_string()),
        _ => {
            if user.trim().is_empty() && password.is_empty() {
                EsAuth::None
            } else {
                EsAuth::Basic(user.trim().to_string(), password.to_string())
            }
        }
    }
}

/// Base URL of the cluster. `host` may be a plain host name (then `ssl` + `port`
/// decide) or a full URL (Elastic Cloud, a reverse proxy with a path prefix): the
/// URL's scheme / port / path are kept; when it has no explicit port the scheme's
/// default (443/80) applies — the form's port field is ignored.
pub fn base_url(host: &str, port: u16, ssl: bool) -> Result<Url, QueryError> {
    let h = host.trim();
    if h.is_empty() {
        return Err(QueryError::new(SYSTEM, "Host is empty", "empty host"));
    }
    let lower = h.to_ascii_lowercase();
    let mut url = if lower.starts_with("http://") || lower.starts_with("https://") {
        Url::parse(h).map_err(|e| QueryError::new(SYSTEM, format!("Invalid Elasticsearch URL '{h}'"), e.to_string()))?
    } else {
        let scheme = if ssl { "https" } else { "http" };
        let hh = if h.contains(':') && !h.starts_with('[') { format!("[{h}]") } else { h.to_string() };
        let port = if port == 0 { 9200 } else { port };
        Url::parse(&format!("{scheme}://{hh}:{port}/"))
            .map_err(|e| QueryError::new(SYSTEM, format!("Invalid Elasticsearch host '{h}'"), e.to_string()))?
    };
    url.set_query(None);
    url.set_fragment(None);
    if !url.path().ends_with('/') {
        let p = format!("{}/", url.path());
        url.set_path(&p);
    }
    Ok(url)
}

/// Join a console path (`GET /logs-*/_search?size=5`) onto the base URL. Only a
/// path relative to the cluster is accepted — never another host.
pub fn request_url(base: &Url, path: &str) -> Result<Url, QueryError> {
    let p = path.trim();
    let lower = p.to_ascii_lowercase();
    if lower.contains("://") || p.starts_with("//") {
        return Err(QueryError::new(SYSTEM, "Only paths on this cluster are allowed (e.g. /_cat/indices)", "absolute url"));
    }
    let rel = p.trim_start_matches('/');
    base.join(rel)
        .map_err(|e| QueryError::new(SYSTEM, format!("Invalid request path '{p}'"), e.to_string()))
}

/// The bulk-style APIs take newline-delimited JSON (and need a trailing newline).
pub fn is_ndjson_path(path: &str) -> bool {
    let p = path.split('?').next().unwrap_or("");
    p.split('/').any(|s| matches!(s, "_bulk" | "_msearch" | "_mtermvectors_ndjson"))
        || p.contains("_msearch/template")
        || p.ends_with("/_find_structure")
        || p.contains("_text_structure/find_structure")
}

/// Normalise an HTTP method typed in the console.
pub fn parse_method(m: &str) -> Result<Method, QueryError> {
    match m.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "DELETE" => Ok(Method::DELETE),
        "HEAD" => Ok(Method::HEAD),
        "PATCH" => Ok(Method::PATCH),
        other => Err(QueryError::new(SYSTEM, format!("Unsupported HTTP method '{other}'"), "method")),
    }
}

/// Human text for a failed call: the `type: reason` Elasticsearch puts in its
/// error document, with a sentence a developer can act on for the common cases.
pub fn describe_error(status: u16, body: &str) -> String {
    let v = serde_json::from_str::<Value>(body).ok();
    let err = v.as_ref().and_then(|v| v.get("error"));
    let (etype, reason) = match err {
        Some(Value::Object(o)) => {
            let reason = o.get("reason").and_then(Value::as_str).unwrap_or("").to_string();
            // OpenSearch SQL / PPL put the useful part in `details` and keep `reason`
            // generic ("Invalid SQL query") — SPEC-OPENSEARCH.md O6.
            let reason = match o.get("details").and_then(Value::as_str).map(str::trim).filter(|d| !d.is_empty()) {
                Some(d) if !reason.is_empty() && d != reason => format!("{reason} — {d}"),
                Some(d) => d.to_string(),
                None => reason,
            };
            (o.get("type").and_then(Value::as_str).unwrap_or("").to_string(), reason)
        }
        Some(Value::String(s)) => (String::new(), s.clone()),
        // OpenSearch security REST API: {"status":"error","reason":"…"} / {"status":…,"message":"…"}
        _ if v.as_ref().and_then(|v| v.get("reason").or_else(|| v.get("message"))).and_then(Value::as_str).is_some() => (
            String::new(),
            v.as_ref().and_then(|v| v.get("reason").or_else(|| v.get("message"))).and_then(Value::as_str).unwrap_or("").to_string(),
        ),
        _ => (String::new(), body.trim().chars().take(300).collect()),
    };
    match status {
        401 => "Authentication failed — check the user and password (or the API key)".to_string(),
        403 => {
            let r = if reason.is_empty() { "the user lacks the privilege for this action".to_string() } else { reason };
            format!("Not allowed — {r}")
        }
        404 if etype == "index_not_found_exception" => {
            let idx = err
                .and_then(|e| e.get("index"))
                .and_then(Value::as_str)
                .map(|s| format!(" '{s}'"))
                .unwrap_or_default();
            format!("Index{idx} not found")
        }
        _ => {
            if etype.is_empty() && reason.is_empty() {
                format!("Elasticsearch {status}")
            } else if etype.is_empty() {
                format!("Elasticsearch {status}: {reason}")
            } else {
                format!("{etype}: {reason}")
            }
        }
    }
}

fn str_at(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// `_cat` APIs return numbers as strings (or null for a closed index).
fn num_at(v: &Value, key: &str) -> Option<u64> {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

pub fn parse_info(v: &Value) -> EsInfo {
    let ver = v.get("version").cloned().unwrap_or(Value::Null);
    let dist = str_at(&ver, "distribution");
    EsInfo {
        name: str_at(v, "name"),
        cluster_name: str_at(v, "cluster_name"),
        cluster_uuid: str_at(v, "cluster_uuid"),
        version: str_at(&ver, "number"),
        distribution: if dist.is_empty() { "elasticsearch".into() } else { dist },
        lucene_version: str_at(&ver, "lucene_version"),
        build_flavor: str_at(&ver, "build_flavor"),
        tagline: str_at(v, "tagline"),
    }
}

/// Is this `GET /` answer an Elasticsearch / OpenSearch cluster?
pub fn looks_like_cluster(v: &Value) -> bool {
    v.get("version").and_then(|x| x.get("number")).is_some() && v.get("cluster_name").is_some()
}

/// Name of the data stream a backing index belongs to (`.ds-logs-app-2026.10.15-000001` → `logs-app`).
pub fn data_stream_of(index: &str) -> Option<String> {
    let rest = index.strip_prefix(".ds-")?;
    // strip "-YYYY.MM.DD-NNNNNN" (8.x) or "-NNNNNN" (7.x)
    let parts: Vec<&str> = rest.rsplitn(3, '-').collect();
    match parts.as_slice() {
        [gen, date, name] if gen.chars().all(|c| c.is_ascii_digit()) && date.contains('.') => Some((*name).to_string()),
        [gen, rest2 @ ..] if gen.chars().all(|c| c.is_ascii_digit()) => {
            // 7.x: .ds-<name>-000001 (name may contain '-')
            let joined: Vec<&str> = rest2.iter().rev().copied().collect();
            Some(joined.join("-"))
        }
        _ => None,
    }
}

pub fn parse_index(v: &Value) -> EsIndex {
    let name = str_at(v, "index");
    EsIndex {
        health: str_at(v, "health"),
        status: str_at(v, "status"),
        uuid: str_at(v, "uuid"),
        primaries: num_at(v, "pri"),
        replicas: num_at(v, "rep"),
        docs_count: num_at(v, "docs.count"),
        docs_deleted: num_at(v, "docs.deleted"),
        store_bytes: num_at(v, "store.size"),
        pri_store_bytes: num_at(v, "pri.store.size"),
        created: str_at(v, "creation.date.string"),
        hidden: name.starts_with('.'),
        data_stream: data_stream_of(&name),
        name,
    }
}

/// Flatten a mapping's `properties` into `(dotted.path, type)` — objects recurse,
/// multi-fields (`fields`) come out as `name.keyword`.
pub fn flatten_mapping(props: &Value) -> Vec<(String, String)> {
    fn walk(prefix: &str, props: &Map<String, Value>, out: &mut Vec<(String, String)>) {
        for (k, v) in props {
            let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
            let ty = v.get("type").and_then(Value::as_str);
            match (ty, v.get("properties").and_then(Value::as_object)) {
                (None, Some(sub)) | (Some("object"), Some(sub)) => walk(&path, sub, out),
                (Some("nested"), Some(sub)) => {
                    out.push((path.clone(), "nested".into()));
                    walk(&path, sub, out)
                }
                _ => {
                    out.push((path.clone(), ty.unwrap_or("object").to_string()));
                    if let Some(f) = v.get("fields").and_then(Value::as_object) {
                        for (fk, fv) in f {
                            let ft = fv.get("type").and_then(Value::as_str).unwrap_or("keyword");
                            out.push((format!("{path}.{fk}"), ft.to_string()));
                        }
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    if let Some(o) = props.as_object() {
        walk("", o, &mut out);
    }
    out
}

/// `_sql?format=json` / `_query` (ES|QL) answer → the app's result set
/// (rows as objects keyed by column name, like every other engine).
pub fn sql_result(v: &Value) -> (Vec<(String, String)>, Vec<Value>) {
    let cols: Vec<(String, String)> = v
        .get("columns")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|c| (str_at(c, "name"), str_at(c, "type"))).collect())
        .unwrap_or_default();
    let raw = v.get("rows").or_else(|| v.get("values")).and_then(Value::as_array);
    let rows = raw
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    let mut o = Map::new();
                    if let Some(cells) = r.as_array() {
                        for (i, (name, _)) in cols.iter().enumerate() {
                            o.insert(name.clone(), cells.get(i).cloned().unwrap_or(Value::Null));
                        }
                    }
                    Value::Object(o)
                })
                .collect()
        })
        .unwrap_or_default();
    (cols, rows)
}

/// OpenSearch SQL / PPL answer (`format=jdbc`): `{schema:[{name,type}], datarows:[[…]],
/// cursor}` → the app's result set (SPEC-OPENSEARCH.md O3). Continuation pages carry
/// the schema again; an empty schema keeps the caller's columns.
pub fn os_sql_result(v: &Value) -> (Vec<(String, String)>, Vec<Value>) {
    let cols: Vec<(String, String)> = v
        .get("schema")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|c| (str_at(c, "name"), str_at(c, "type"))).collect())
        .unwrap_or_default();
    let rows = v
        .get("datarows")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    let mut o = Map::new();
                    if let Some(cells) = r.as_array() {
                        for (i, (name, _)) in cols.iter().enumerate() {
                            o.insert(name.clone(), cells.get(i).cloned().unwrap_or(Value::Null));
                        }
                    }
                    Value::Object(o)
                })
                .collect()
        })
        .unwrap_or_default();
    (cols, rows)
}

fn warnings_of(headers: &reqwest::header::HeaderMap) -> Vec<String> {
    headers
        .get_all("warning")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|s| {
            // 299 Elasticsearch-8.15.3-… "message" → message
            match (s.find('"'), s.rfind('"')) {
                (Some(a), Some(b)) if b > a => s[a + 1..b].to_string(),
                _ => s.to_string(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

impl EsDriver {
    fn build(p: &EsConnParams) -> Result<(reqwest::Client, Url, EsAuth), QueryError> {
        let base = base_url(&p.host, p.port, p.ssl)?;
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300));
        let https = base.scheme() == "https";
        if https && !p.ssl_ca.trim().is_empty() {
            let pem = std::fs::read(p.ssl_ca.trim())
                .map_err(|e| QueryError::new(SYSTEM, format!("Cannot read CA certificate {}", p.ssl_ca), e.to_string()))?;
            let cert = reqwest::Certificate::from_pem(&pem)
                .map_err(|e| QueryError::new(SYSTEM, "Invalid CA certificate (PEM expected)", e.to_string()))?;
            builder = builder.add_root_certificate(cert);
        }
        if https && !p.ssl_cert.trim().is_empty() && !p.ssl_key.trim().is_empty() {
            let mut pem = std::fs::read(p.ssl_cert.trim())
                .map_err(|e| QueryError::new(SYSTEM, format!("Cannot read client certificate {}", p.ssl_cert), e.to_string()))?;
            let key = std::fs::read(p.ssl_key.trim())
                .map_err(|e| QueryError::new(SYSTEM, format!("Cannot read client key {}", p.ssl_key), e.to_string()))?;
            pem.push(b'\n');
            pem.extend_from_slice(&key);
            let id = reqwest::Identity::from_pem(&pem)
                .map_err(|e| QueryError::new(SYSTEM, "Invalid client certificate / key (PEM expected)", e.to_string()))?;
            builder = builder.identity(id);
        }
        let client = builder.build().map_err(|e| QueryError::new(SYSTEM, e.to_string(), e.to_string()))?;
        Ok((client, base, resolve_auth(&p.auth, &p.user, &p.password)))
    }

    pub async fn connect(p: &EsConnParams) -> Result<Self, QueryError> {
        let (client, base, auth) = Self::build(p)?;
        let mut d = Self { client, base, auth, info: EsInfo::default() };
        // Real handshake: wrong port (Kibana 5601, transport 9300) / bad creds must
        // fail here, not on the first click in the explorer.
        let r = d.send(Method::GET, "", None).await?;
        if r.status == 403 {
            // Least-privilege users / API keys (only index privileges, no cluster
            // `monitor`) are refused `GET /` (cluster:monitor/main) — yet they are
            // perfectly valid connections. `_security/_authenticate` is allowed for
            // every authenticated principal: use it to prove the credentials.
            let me = d.send(Method::GET, "_security/_authenticate", None).await?;
            if me.ok {
                let user = me.json.as_ref().map(|j| str_at(j, "username")).unwrap_or_default();
                d.info = EsInfo {
                    distribution: "elasticsearch".into(),
                    tagline: format!("Connected as {user} — no cluster monitor privilege (version and health are hidden)"),
                    ..Default::default()
                };
                return Ok(d);
            }
            // OpenSearch has no `_security/_authenticate` (400, no handler); its
            // security plugin answers `authinfo` for every authenticated user
            // (SPEC-OPENSEARCH.md O2).
            let os = d.send(Method::GET, "_plugins/_security/authinfo", None).await?;
            if os.ok {
                let user = os.json.as_ref().map(|j| str_at(j, "user_name")).unwrap_or_default();
                d.info = EsInfo {
                    distribution: "opensearch".into(),
                    tagline: format!("Connected as {user} — no cluster monitor privilege (version and health are hidden)"),
                    ..Default::default()
                };
                return Ok(d);
            }
        }
        if !r.ok {
            let raw = r.text.clone().or_else(|| r.json.as_ref().map(|j| j.to_string())).unwrap_or_default();
            return Err(QueryError::new(SYSTEM, describe_error(r.status, &raw), raw));
        }
        let Some(v) = r.json.filter(looks_like_cluster) else {
            return Err(QueryError::new(
                SYSTEM,
                format!(
                    "{} does not answer like Elasticsearch — use the REST port (9200), not Kibana (5601) or the transport port (9300)",
                    d.base
                ),
                r.text.unwrap_or_default(),
            ));
        };
        d.info = parse_info(&v);
        if v.get("tagline").and_then(Value::as_str).is_some_and(|t| t.to_ascii_lowercase().contains("opensearch")) {
            d.info.distribution = "opensearch".into();
        }
        Ok(d)
    }

    pub async fn test(p: &EsConnParams) -> TestResult {
        let started = Instant::now();
        match Self::connect(p).await {
            Ok(d) => {
                let label = if d.info.distribution == "opensearch" { "OpenSearch" } else { "Elasticsearch" };
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: Some(if d.info.version.is_empty() {
                        format!("{label} · {}", d.info.tagline)
                    } else {
                        format!("{label} {} · {}", d.info.version, d.info.cluster_name)
                    }),
                    error: None,
                }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    /// Reachable and authenticated. A 403 on `HEAD /` still proves both (the
    /// principal simply lacks cluster `monitor`); only 401 / no answer is a failure.
    pub async fn ping(&mut self) -> bool {
        matches!(self.send(Method::HEAD, "", None).await, Ok(r) if r.ok || r.status == 403)
    }

    pub fn info(&self) -> &EsInfo {
        &self.info
    }

    /// One HTTP round trip. Never fails on an HTTP error status — only when the
    /// cluster cannot be reached or the response cannot be read.
    async fn send(&self, method: Method, path: &str, body: Option<String>) -> Result<EsResponse, QueryError> {
        let url = request_url(&self.base, path)?;
        let mut req = self.client.request(method.clone(), url);
        req = match &self.auth {
            EsAuth::None => req,
            EsAuth::Basic(u, p) => req.basic_auth(u, Some(p)),
            EsAuth::ApiKey(k) => req.header("Authorization", format!("ApiKey {k}")),
            EsAuth::Bearer(t) => req.header("Authorization", format!("Bearer {t}")),
        };
        if let Some(b) = body.filter(|b| !b.trim().is_empty()) {
            if is_ndjson_path(path) {
                let mut b = b;
                if !b.ends_with('\n') {
                    b.push('\n');
                }
                req = req.header("Content-Type", "application/x-ndjson").body(b);
            } else {
                req = req.header("Content-Type", "application/json").body(b);
            }
        }
        let started = Instant::now();
        let res = req.send().await.map_err(|e| {
            let hint = if e.is_connect() {
                " — is the host/port right? Elasticsearch's REST API listens on 9200 (HTTPS by default on 8.x: enable SSL)"
            } else if e.is_timeout() {
                " — the request timed out"
            } else if e.to_string().to_ascii_lowercase().contains("certificate") {
                " — TLS certificate not trusted: set the CA certificate of the cluster in SSL settings"
            } else {
                ""
            };
            QueryError::new(SYSTEM, format!("Cannot reach Elasticsearch at {}{hint}", self.base), e.to_string())
        })?;
        let status = res.status().as_u16();
        let content_type = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let warnings = warnings_of(res.headers());
        let bytes = res
            .bytes()
            .await
            .map_err(|e| QueryError::new(SYSTEM, format!("Failed to read the response: {e}"), e.to_string()))?;
        let took_ms = started.elapsed().as_millis() as u64;
        let text = String::from_utf8_lossy(&bytes).to_string();
        let trimmed = text.trim_start();
        let json = if method == Method::HEAD || trimmed.is_empty() {
            None
        } else if content_type.contains("json") || trimmed.starts_with('{') || trimmed.starts_with('[') {
            serde_json::from_str::<Value>(&text).ok()
        } else {
            None
        };
        Ok(EsResponse {
            status,
            ok: (200..300).contains(&status),
            text: if json.is_none() && !text.is_empty() { Some(text) } else { None },
            json,
            took_ms,
            content_type,
            warnings,
            bytes: bytes.len() as u64,
        })
    }

    /// Console request: any method, any cluster path, optional (nd)JSON body.
    pub async fn request(&self, method: &str, path: &str, body: Option<String>) -> Result<EsResponse, QueryError> {
        self.send(parse_method(method)?, path, body).await
    }

    /// Typed call: 2xx → parsed JSON, else a readable error.
    async fn call_json(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, QueryError> {
        let r = self.send(method, path, body.map(|b| b.to_string())).await?;
        if !r.ok {
            let raw = r.json.as_ref().map(|j| j.to_string()).or(r.text.clone()).unwrap_or_default();
            return Err(QueryError::new(SYSTEM, describe_error(r.status, &raw), raw));
        }
        Ok(r.json.unwrap_or(Value::Null))
    }

    // ---- typed reads ----------------------------------------------------------

    pub async fn overview(&self) -> Result<EsOverview, QueryError> {
        let mut o = EsOverview { info: self.info.clone(), ..Default::default() };
        let mut warn: Vec<String> = Vec::new();
        match self.call_json(Method::GET, "_cluster/health", None).await {
            Ok(h) => {
                let n = |k: &str| h.get(k).and_then(Value::as_u64).unwrap_or(0);
                o.status = str_at(&h, "status");
                o.number_of_nodes = n("number_of_nodes");
                o.number_of_data_nodes = n("number_of_data_nodes");
                o.active_primary_shards = n("active_primary_shards");
                o.active_shards = n("active_shards");
                o.relocating_shards = n("relocating_shards");
                o.initializing_shards = n("initializing_shards");
                o.unassigned_shards = n("unassigned_shards");
                o.number_of_pending_tasks = n("number_of_pending_tasks");
                o.active_shards_percent = h.get("active_shards_percent_as_number").and_then(Value::as_f64).unwrap_or(0.0);
                if o.cluster_name_missing() {
                    o.info.cluster_name = str_at(&h, "cluster_name");
                }
            }
            Err(e) => warn.push(format!("cluster health: {}", e.message)),
        }
        match self
            .call_json(Method::GET, "_cluster/stats?filter_path=indices.count,indices.docs.count,indices.store.size_in_bytes", None)
            .await
        {
            Ok(s) => {
                let ix = s.get("indices").cloned().unwrap_or(Value::Null);
                o.indices = ix.get("count").and_then(Value::as_u64);
                o.docs = ix.get("docs").and_then(|d| d.get("count")).and_then(Value::as_u64);
                o.store_bytes = ix.get("store").and_then(|d| d.get("size_in_bytes")).and_then(Value::as_u64);
            }
            Err(e) => warn.push(format!("cluster stats: {}", e.message)),
        }
        if !warn.is_empty() {
            o.warning = Some(warn.join(" · "));
        }
        Ok(o)
    }

    pub async fn indices(&self) -> Result<Vec<EsIndex>, QueryError> {
        let v = self
            .call_json(
                Method::GET,
                "_cat/indices?format=json&bytes=b&expand_wildcards=all&h=health,status,index,uuid,pri,rep,docs.count,docs.deleted,store.size,pri.store.size,creation.date.string",
                None,
            )
            .await?;
        let mut out: Vec<EsIndex> = v.as_array().map(|a| a.iter().map(parse_index).collect()).unwrap_or_default();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// Fields of an index mapping (merged over every index a pattern matches).
    pub async fn mapping_fields(&self, index: &str) -> Result<Vec<(String, String)>, QueryError> {
        let path = format!("{}/_mapping", urlencode_segment(index));
        let v = self.call_json(Method::GET, &path, None).await?;
        let mut seen = std::collections::BTreeMap::new();
        if let Some(o) = v.as_object() {
            for (_, m) in o {
                let props = m.get("mappings").and_then(|x| x.get("properties")).cloned().unwrap_or(Value::Null);
                for (k, t) in flatten_mapping(&props) {
                    seen.entry(k).or_insert(t);
                }
            }
        }
        Ok(seen.into_iter().collect())
    }

    // ---- SQL (the generic `exec` arm) -----------------------------------------

    /// Run Elasticsearch SQL and collect up to [`SQL_MAX_ROWS`] rows, following the
    /// cursor; an unfinished cursor is closed so the cluster frees its context.
    pub async fn exec_sql(&self, sql: &str) -> Result<StatementOutcome, QueryError> {
        let query = sql.trim().trim_end_matches(';').trim().to_string();
        if query.is_empty() {
            return Ok(StatementOutcome::Ok);
        }
        if self.is_opensearch() {
            return self.exec_os_sql(&query).await;
        }
        let first = self
            .sql_call(json!({ "query": query, "fetch_size": SQL_FETCH_SIZE }))
            .await?;
        let (cols, mut rows) = sql_result(&first);
        let mut cursor = first.get("cursor").and_then(Value::as_str).map(str::to_string);
        while let Some(c) = cursor.clone() {
            if rows.len() >= SQL_MAX_ROWS {
                let _ = self.call_json(Method::POST, "_sql/close", Some(json!({ "cursor": c }))).await;
                break;
            }
            let next = self.sql_call(json!({ "cursor": c })).await?;
            let (_, more) = sql_result(&next);
            if more.is_empty() {
                break;
            }
            rows.extend(more);
            cursor = next.get("cursor").and_then(Value::as_str).map(str::to_string);
        }
        rows.truncate(SQL_MAX_ROWS);
        let total = rows.len() as u64;
        Ok(StatementOutcome::Rows { result: QueryResultSet { cols, rows, total } })
    }

    /// The server is OpenSearch (`GET /` distribution, or its security plugin
    /// answered the least-privilege login).
    pub fn is_opensearch(&self) -> bool {
        self.info.distribution == "opensearch"
    }

    /// OpenSearch SQL plugin (SPEC-OPENSEARCH.md O3): `_plugins/_sql?format=jdbc`,
    /// following `cursor` up to [`SQL_MAX_ROWS`]; an unfinished cursor is closed.
    async fn exec_os_sql(&self, query: &str) -> Result<StatementOutcome, QueryError> {
        let first = self.os_sql_call(json!({ "query": query, "fetch_size": SQL_FETCH_SIZE })).await?;
        let (cols, mut rows) = os_sql_result(&first);
        let mut cursor = first.get("cursor").and_then(Value::as_str).map(str::to_string);
        while let Some(c) = cursor.clone() {
            if rows.len() >= SQL_MAX_ROWS {
                let _ = self.call_json(Method::POST, "_plugins/_sql/close", Some(json!({ "cursor": c }))).await;
                break;
            }
            let next = self.os_sql_call(json!({ "cursor": c })).await?;
            let (_, more) = os_sql_result(&next);
            if more.is_empty() {
                break;
            }
            rows.extend(more);
            cursor = next.get("cursor").and_then(Value::as_str).map(str::to_string);
        }
        rows.truncate(SQL_MAX_ROWS);
        let total = rows.len() as u64;
        Ok(StatementOutcome::Rows { result: QueryResultSet { cols, rows, total } })
    }

    async fn os_sql_call(&self, body: Value) -> Result<Value, QueryError> {
        let r = self.send(Method::POST, "_plugins/_sql?format=jdbc", Some(body.to_string())).await?;
        if !r.ok {
            let raw = r.json.as_ref().map(|j| j.to_string()).or(r.text.clone()).unwrap_or_default();
            let mut e = QueryError::new(SYSTEM, describe_error(r.status, &raw), raw.clone());
            e.position = sql_error_position(&e.message);
            return Err(e);
        }
        Ok(r.json.unwrap_or(Value::Null))
    }

    async fn sql_call(&self, body: Value) -> Result<Value, QueryError> {
        let r = self.send(Method::POST, "_sql?format=json", Some(body.to_string())).await?;
        if !r.ok {
            let raw = r.json.as_ref().map(|j| j.to_string()).or(r.text.clone()).unwrap_or_default();
            let mut e = QueryError::new(SYSTEM, describe_error(r.status, &raw), raw.clone());
            e.position = sql_error_position(&e.message);
            return Err(e);
        }
        Ok(r.json.unwrap_or(Value::Null))
    }

    // ---- introspection (Query Editor autocomplete) ----------------------------

    pub async fn tables(&self) -> Result<Vec<TableInfo>, QueryError> {
        let idx = self.indices().await?;
        Ok(idx
            .into_iter()
            .filter(|i| !i.hidden)
            .map(|i| TableInfo {
                schema: String::new(),
                name: i.name,
                kind: "table".into(),
                row_estimate: i.docs_count.map(|n| n as i64),
                locked: false,
                engine: None,
                data_length: i.store_bytes.map(|n| n as i64),
                partition_of: None,
                is_partitioned: None,
            })
            .collect())
    }

    pub async fn columns(&self, index: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        let f = self.mapping_fields(index).await?;
        Ok(f.into_iter()
            .enumerate()
            .map(|(i, (name, ty))| ColumnInfo {
                name,
                data_type: ty,
                nullable: true,
                default: None,
                is_pk: false,
                is_fk: false,
                ordinal: i as i32 + 1,
                auto_increment: false,
            })
            .collect())
    }
}

impl EsOverview {
    fn cluster_name_missing(&self) -> bool {
        self.info.cluster_name.is_empty()
    }
}

/// Percent-encode one path segment (index names may hold `*`, `,` — kept — but
/// never `/`, `?`, `#` or spaces).
pub fn urlencode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'*' | b',' | b':' | b'+' | b'@' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// ES SQL parse errors say `line 1:15: …` — surface it as the editor position.
pub fn sql_error_position(msg: &str) -> Option<crate::error::ErrorPosition> {
    let i = msg.find("line ")?;
    let rest = &msg[i + 5..];
    let colon = rest.find(':')?;
    let line: u32 = rest[..colon].trim().parse().ok()?;
    let rest2 = &rest[colon + 1..];
    let end = rest2.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest2.len());
    let col: u32 = rest2[..end].parse().ok()?;
    Some(crate::error::ErrorPosition { line, col: col + 1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_methods() {
        assert_eq!(resolve_auth("", "", ""), EsAuth::None);
        assert_eq!(resolve_auth("basic", "elastic", "pw"), EsAuth::Basic("elastic".into(), "pw".into()));
        assert_eq!(resolve_auth("", "elastic", "pw"), EsAuth::Basic("elastic".into(), "pw".into()));
        assert_eq!(resolve_auth("none", "elastic", "pw"), EsAuth::None);
        assert_eq!(resolve_auth("apikey", "", "abc=="), EsAuth::ApiKey("abc==".into()));
        // id:key → base64 encoded form
        assert_eq!(resolve_auth("apikey", "", "id1:key1"), EsAuth::ApiKey("aWQxOmtleTE=".into()));
        assert_eq!(resolve_auth("bearer", "", " tok "), EsAuth::Bearer("tok".into()));
    }

    #[test]
    fn base_urls() {
        assert_eq!(base_url("localhost", 9200, false).unwrap().as_str(), "http://localhost:9200/");
        assert_eq!(base_url("es.local", 9243, true).unwrap().as_str(), "https://es.local:9243/");
        assert_eq!(base_url("https://x.es.io", 9200, false).unwrap().as_str(), "https://x.es.io/");
        assert_eq!(base_url("https://proxy/es", 9200, false).unwrap().as_str(), "https://proxy/es/");
        assert_eq!(base_url("http://h:9201/a/?x=1#f", 0, false).unwrap().as_str(), "http://h:9201/a/");
        assert_eq!(base_url("::1", 9200, false).unwrap().as_str(), "http://[::1]:9200/");
        assert!(base_url("  ", 9200, false).is_err());
    }

    #[test]
    fn request_urls_stay_on_the_cluster() {
        let b = base_url("https://proxy/es", 0, false).unwrap();
        assert_eq!(request_url(&b, "/_cat/indices?v").unwrap().as_str(), "https://proxy/es/_cat/indices?v");
        assert_eq!(request_url(&b, "logs-*/_search").unwrap().as_str(), "https://proxy/es/logs-*/_search");
        assert_eq!(request_url(&b, "").unwrap().as_str(), "https://proxy/es/");
        assert!(request_url(&b, "http://evil/_search").is_err());
        assert!(request_url(&b, "//evil/_search").is_err());
    }

    #[test]
    fn ndjson_paths() {
        assert!(is_ndjson_path("_bulk"));
        assert!(is_ndjson_path("/my-index/_bulk?refresh=true"));
        assert!(is_ndjson_path("/_msearch"));
        assert!(is_ndjson_path("/idx/_msearch/template"));
        assert!(!is_ndjson_path("/_search"));
        assert!(!is_ndjson_path("/bulk_orders/_doc"));
    }

    #[test]
    fn errors_are_readable() {
        assert!(describe_error(401, "{}").starts_with("Authentication failed"));
        let nf = r#"{"error":{"type":"index_not_found_exception","reason":"no such index [x]","index":"x"},"status":404}"#;
        assert_eq!(describe_error(404, nf), "Index 'x' not found");
        let f = r#"{"error":{"type":"security_exception","reason":"action [indices:admin/create] is unauthorized"},"status":403}"#;
        assert_eq!(describe_error(403, f), "Not allowed — action [indices:admin/create] is unauthorized");
        let p = r#"{"error":{"type":"parsing_exception","reason":"unknown query [mach]"},"status":400}"#;
        assert_eq!(describe_error(400, p), "parsing_exception: unknown query [mach]");
        assert_eq!(describe_error(502, "Bad gateway"), "Elasticsearch 502: Bad gateway");
        // OpenSearch SQL / PPL: the useful text is in `details` (measured on 3.9)
        let os = r#"{"error":{"reason":"Invalid SQL query","details":"Query must start with SELECT, DELETE, SHOW or DESCRIBE: SELEC x FROM books","type":"SQLFeatureNotSupportedException"},"status":400}"#;
        assert_eq!(
            describe_error(400, os),
            "SQLFeatureNotSupportedException: Invalid SQL query — Query must start with SELECT, DELETE, SHOW or DESCRIBE: SELEC x FROM books"
        );
        let same = r#"{"error":{"reason":"no such index [nope]","details":"no such index [nope]","type":"IndexNotFoundException"},"status":404}"#;
        assert_eq!(describe_error(400, same), "IndexNotFoundException: no such index [nope]");
    }

    #[test]
    fn opensearch_jdbc_answers_become_rows() {
        // `_plugins/_sql?format=jdbc` page as measured on OpenSearch 3.9
        let page = json!({"schema":[{"name":"title","type":"text"},{"name":"year","type":"integer"}],
            "datarows":[["Emma",1815],["Dune",null]],"total":2,"size":2,"status":200,"cursor":"n:abc"});
        let (cols, rows) = os_sql_result(&page);
        assert_eq!(cols, vec![("title".into(), "text".into()), ("year".into(), "integer".into())]);
        assert_eq!(rows, vec![json!({"title":"Emma","year":1815}), json!({"title":"Dune","year":null})]);
        // a short row is padded with null, never shifted
        let (_, short) = os_sql_result(&json!({"schema":[{"name":"a","type":"long"},{"name":"b","type":"long"}],"datarows":[[1]]}));
        assert_eq!(short, vec![json!({"a":1,"b":null})]);
        assert_eq!(os_sql_result(&json!({})), (vec![], vec![]));
    }

    #[test]
    fn cat_indices_rows() {
        let v = json!({"health":"yellow","status":"open","index":"logs","uuid":"u","pri":"1","rep":"1",
            "docs.count":"42","docs.deleted":"0","store.size":"1024","pri.store.size":"1024","creation.date.string":"2026-10-15T00:00:00.000Z"});
        let i = parse_index(&v);
        assert_eq!(i.docs_count, Some(42));
        assert_eq!(i.store_bytes, Some(1024));
        assert!(!i.hidden);
        // closed index: null counts stay unknown, not 0
        let c = parse_index(&json!({"health":null,"status":"close","index":"old","docs.count":null}));
        assert_eq!(c.docs_count, None);
        assert_eq!(c.status, "close");
    }

    #[test]
    fn data_stream_names() {
        assert_eq!(data_stream_of(".ds-logs-app-2026.10.15-000001").as_deref(), Some("logs-app"));
        assert_eq!(data_stream_of(".ds-metrics-000002").as_deref(), Some("metrics"));
        assert_eq!(data_stream_of("logs"), None);
        assert!(parse_index(&json!({"index":".ds-logs-app-2026.10.15-000001"})).hidden);
    }

    #[test]
    fn mappings_flatten() {
        let props = json!({
            "title": {"type":"text","fields":{"keyword":{"type":"keyword"}}},
            "user": {"properties": {"name":{"type":"keyword"}, "age":{"type":"integer"}}},
            "tags": {"type":"nested","properties":{"k":{"type":"keyword"}}},
            "@timestamp": {"type":"date"}
        });
        let f = flatten_mapping(&props);
        assert!(f.contains(&("title".into(), "text".into())));
        assert!(f.contains(&("title.keyword".into(), "keyword".into())));
        assert!(f.contains(&("user.name".into(), "keyword".into())));
        assert!(f.contains(&("user.age".into(), "integer".into())));
        assert!(f.contains(&("tags".into(), "nested".into())));
        assert!(f.contains(&("tags.k".into(), "keyword".into())));
        assert!(f.contains(&("@timestamp".into(), "date".into())));
    }

    #[test]
    fn sql_answers_become_rows() {
        let v = json!({"columns":[{"name":"a","type":"long"},{"name":"b","type":"text"}],"rows":[[1,"x"],[2,null]]});
        let (cols, rows) = sql_result(&v);
        assert_eq!(cols, vec![("a".into(), "long".into()), ("b".into(), "text".into())]);
        assert_eq!(rows[0], json!({"a":1,"b":"x"}));
        assert_eq!(rows[1], json!({"a":2,"b":null}));
        // ES|QL answers carry `values`
        let q = json!({"columns":[{"name":"n","type":"long"}],"values":[[7]]});
        assert_eq!(sql_result(&q).1, vec![json!({"n":7})]);
    }

    #[test]
    fn sql_positions_and_segments() {
        let p = sql_error_position("line 1:15: mismatched input").unwrap();
        assert_eq!((p.line, p.col), (1, 16));
        assert!(sql_error_position("no position").is_none());
        assert_eq!(urlencode_segment("logs-*"), "logs-*");
        assert_eq!(urlencode_segment("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn methods_and_cluster_detection() {
        assert_eq!(parse_method("get").unwrap(), Method::GET);
        assert!(parse_method("TRACE").is_err());
        assert!(looks_like_cluster(&json!({"cluster_name":"c","version":{"number":"8.15.3"}})));
        assert!(!looks_like_cluster(&json!({"statusCode":404})));
        let i = parse_info(&json!({"name":"n1","cluster_name":"c","version":{"number":"2.17.0","distribution":"opensearch"}}));
        assert_eq!(i.distribution, "opensearch");
    }
}
