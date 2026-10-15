//! RabbitMQ driver — talks to the broker through the **Management HTTP API**
//! (`rabbitmq_management` plugin, port 15672 by default) with `reqwest`.
//!
//! Why HTTP and not AMQP: AMQP 0-9-1 has no way to *list* queues, exchanges or
//! bindings — every management tool (the web UI, rabbitmqadmin, DataGrip-style
//! clients) reads the broker's topology from this API. It also covers what a
//! developer needs day to day — peek messages (with requeue), publish, purge,
//! declare/delete/bind — over a single port, so it works through the SSH tunnel
//! like every other engine.
//!
//! Not SQL: the generic exec/introspection arms in `drivers/mod.rs` return a typed
//! "not applicable" error / empty lists; features go through `commands/rabbitmq.rs`.

use std::time::{Duration, Instant};

use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::drivers::types::TestResult;
use crate::error::QueryError;

const SYSTEM: &str = "rabbitmq";

/// Name the Management API uses for the nameless default exchange (`""`).
pub const DEFAULT_EXCHANGE_API_NAME: &str = "amq.default";

#[derive(Clone, Debug)]
pub struct RabbitConnParams {
    pub host: String,
    /// Management HTTP port (15672 / 15671 with TLS) — NOT the AMQP port.
    pub port: u16,
    /// Virtual host the connection opens on (`/` when empty).
    pub vhost: String,
    pub user: String,
    pub password: String,
    pub ssl: bool,
    pub ssl_ca: String,
}

/// Cheap to clone (reqwest::Client is an Arc), so commands copy it out of the
/// registry lock and do their HTTP round trip without holding the connection.
#[derive(Clone)]
pub struct RabbitDriver {
    client: reqwest::Client,
    base: Url,
    user: String,
    password: String,
    vhost: String,
}

// ---------------------------------------------------------------------------
// Wire types (what the frontend receives)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RabbitOverview {
    pub rabbitmq_version: String,
    pub erlang_version: String,
    pub cluster_name: String,
    pub node: String,
    pub management_version: String,
    pub messages: u64,
    pub messages_ready: u64,
    pub messages_unacknowledged: u64,
    pub queues: u64,
    pub exchanges: u64,
    pub connections: u64,
    pub channels: u64,
    pub consumers: u64,
    /// vhost the connection is bound to (from the profile).
    pub vhost: String,
    /// Exchange types the broker offers (built-ins + plugin types such as
    /// x-delayed-message), as the management UI's "Type" dropdown lists them.
    #[serde(default)]
    pub exchange_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RabbitQueue {
    pub name: String,
    pub vhost: String,
    /// classic | quorum | stream
    pub queue_type: String,
    pub durable: bool,
    pub auto_delete: bool,
    pub exclusive: bool,
    pub state: String,
    /// `None` when the broker does not report it (stats disabled / just declared).
    pub messages: Option<u64>,
    pub messages_ready: Option<u64>,
    pub messages_unacknowledged: Option<u64>,
    pub consumers: Option<u64>,
    pub memory: Option<u64>,
    pub node: String,
    pub policy: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RabbitExchange {
    /// `""` is the default exchange.
    pub name: String,
    pub vhost: String,
    pub exchange_type: String,
    pub durable: bool,
    pub auto_delete: bool,
    pub internal: bool,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RabbitBinding {
    pub source: String,
    pub destination: String,
    /// queue | exchange
    pub destination_type: String,
    pub routing_key: String,
    /// Identifies the binding when deleting it (routing key + args hash).
    pub properties_key: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RabbitMessage {
    pub payload: String,
    /// "string" | "base64" (binary payloads come back base64-encoded)
    pub payload_encoding: String,
    pub payload_bytes: u64,
    pub redelivered: bool,
    pub exchange: String,
    pub routing_key: String,
    /// Messages left in the queue after this one was fetched.
    pub message_count: u64,
    pub properties: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RabbitPublishResult {
    /// false = no queue was bound to receive it (the message was dropped).
    pub routed: bool,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/// `""` → `"/"` — RabbitMQ's default vhost.
pub fn effective_vhost(v: &str) -> String {
    let t = v.trim();
    if t.is_empty() { "/".into() } else { t.to_string() }
}

/// The API addresses the default exchange as `amq.default`.
pub fn exchange_api_name(name: &str) -> &str {
    if name.is_empty() { DEFAULT_EXCHANGE_API_NAME } else { name }
}

/// Base URL of the management API for an endpoint.
pub fn base_url(host: &str, port: u16, ssl: bool) -> Result<Url, QueryError> {
    let scheme = if ssl { "https" } else { "http" };
    let host = host.trim();
    // IPv6 literals need brackets in a URL.
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    Url::parse(&format!("{scheme}://{host}:{port}/"))
        .map_err(|e| QueryError::new(SYSTEM, format!("Invalid RabbitMQ host '{host}'"), e.to_string()))
}

/// Build `{base}api/{segments…}` with every segment percent-encoded on its own,
/// so a vhost `/` becomes `%2F` and a queue named `a/b` stays ONE segment.
pub fn api_url(base: &Url, segments: &[&str]) -> Url {
    let mut url = base.clone();
    {
        let mut path = url.path_segments_mut().expect("http(s) URL has a path");
        path.clear();
        path.push("api");
        for s in segments {
            path.push(s);
        }
    }
    url
}

/// `ack_requeue_true` keeps the messages in the queue (a peek); the other modes
/// remove them. Anything unknown falls back to the safe peek.
pub fn ack_mode(mode: &str) -> &'static str {
    match mode {
        "ack" | "ack_requeue_false" => "ack_requeue_false",
        "reject" | "reject_requeue_false" => "reject_requeue_false",
        _ => "ack_requeue_true",
    }
}

/// Human text for a failed API call. 401/403/404 get a sentence a developer can
/// act on; otherwise the broker's own `reason` is shown.
pub fn describe_error(status: u16, body: &str) -> String {
    let reason = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("reason")
                .and_then(Value::as_str)
                .or_else(|| v.get("error").and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.trim().chars().take(300).collect());
    // A 401 is NOT always a bad password: the broker also answers 401 to a logged-in
    // user who lacks a tag ("Not administrator user" on /api/users) — saying
    // "Authentication failed" there sent people to re-type a correct password.
    if status == 401 {
        if let Some(tag) = missing_tag(&reason) {
            return format!(
                "Not allowed — this needs a user with the '{tag}' tag (the connection's user is logged in, but does not have it)"
            );
        }
        return "Authentication failed — check the user and password".to_string();
    }
    match status {
        403 => format!("Access refused — the user lacks the management tag or permission on this vhost ({reason})"),
        404 => format!("Not found — {reason}"),
        _ => format!("RabbitMQ {status}: {reason}"),
    }
}

/// "Not administrator user" / "Not monitor user" / "Not policymaker user" → the tag.
fn missing_tag(reason: &str) -> Option<&'static str> {
    let r = reason.to_ascii_lowercase();
    if !r.starts_with("not ") {
        return None;
    }
    if r.contains("administrator") {
        Some("administrator")
    } else if r.contains("policymaker") {
        Some("policymaker")
    } else if r.contains("monitor") {
        Some("monitoring")
    } else if r.contains("management") {
        Some("management")
    } else {
        None
    }
}

/// A 404 on a vhost-wide listing means the vhost itself is missing (or invisible to
/// this user) — say that, instead of the broker's bare "Not Found".
pub fn vhost_not_found(vhost: &str, e: QueryError) -> QueryError {
    if !e.message.starts_with("Not found") {
        return e;
    }
    let proxy = if vhost.contains('/') {
        " If it does exist, a proxy in front of the management API may be decoding %2F in the URL."
    } else {
        ""
    };
    QueryError::new(
        SYSTEM,
        format!("Virtual host '{vhost}' was not found on this broker (or this user has no access to it).{proxy}"),
        e.raw,
    )
}

fn u64_at(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}
fn str_at(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}
fn bool_at(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn obj_at(v: &Value, key: &str) -> Value {
    match v.get(key) {
        Some(o @ Value::Object(_)) => o.clone(),
        _ => json!({}),
    }
}

pub fn parse_overview(v: &Value, vhost: &str) -> RabbitOverview {
    let qt = v.get("queue_totals").cloned().unwrap_or(Value::Null);
    let ot = v.get("object_totals").cloned().unwrap_or(Value::Null);
    RabbitOverview {
        rabbitmq_version: str_at(v, "rabbitmq_version"),
        erlang_version: str_at(v, "erlang_version"),
        cluster_name: str_at(v, "cluster_name"),
        node: str_at(v, "node"),
        management_version: str_at(v, "management_version"),
        messages: u64_at(&qt, "messages").unwrap_or(0),
        messages_ready: u64_at(&qt, "messages_ready").unwrap_or(0),
        messages_unacknowledged: u64_at(&qt, "messages_unacknowledged").unwrap_or(0),
        queues: u64_at(&ot, "queues").unwrap_or(0),
        exchanges: u64_at(&ot, "exchanges").unwrap_or(0),
        connections: u64_at(&ot, "connections").unwrap_or(0),
        channels: u64_at(&ot, "channels").unwrap_or(0),
        consumers: u64_at(&ot, "consumers").unwrap_or(0),
        vhost: vhost.to_string(),
        exchange_types: {
            let mut t: Vec<String> = v
                .get("exchange_types")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter(|x| x.get("enabled").and_then(Value::as_bool).unwrap_or(true))
                        .map(|x| str_at(x, "name"))
                        .filter(|n| !n.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            if t.is_empty() {
                t = vec!["direct".into(), "fanout".into(), "headers".into(), "topic".into()];
            }
            t
        },
    }
}

pub fn parse_queue(v: &Value) -> RabbitQueue {
    RabbitQueue {
        name: str_at(v, "name"),
        vhost: str_at(v, "vhost"),
        queue_type: {
            let t = str_at(v, "type");
            if t.is_empty() { "classic".into() } else { t }
        },
        durable: bool_at(v, "durable"),
        auto_delete: bool_at(v, "auto_delete"),
        exclusive: bool_at(v, "exclusive"),
        state: str_at(v, "state"),
        messages: u64_at(v, "messages"),
        messages_ready: u64_at(v, "messages_ready"),
        messages_unacknowledged: u64_at(v, "messages_unacknowledged"),
        consumers: u64_at(v, "consumers"),
        memory: u64_at(v, "memory"),
        node: str_at(v, "node"),
        policy: str_at(v, "policy"),
        arguments: obj_at(v, "arguments"),
    }
}

pub fn parse_exchange(v: &Value) -> RabbitExchange {
    RabbitExchange {
        name: str_at(v, "name"),
        vhost: str_at(v, "vhost"),
        exchange_type: str_at(v, "type"),
        durable: bool_at(v, "durable"),
        auto_delete: bool_at(v, "auto_delete"),
        internal: bool_at(v, "internal"),
        arguments: obj_at(v, "arguments"),
    }
}

pub fn parse_binding(v: &Value) -> RabbitBinding {
    RabbitBinding {
        source: str_at(v, "source"),
        destination: str_at(v, "destination"),
        destination_type: str_at(v, "destination_type"),
        routing_key: str_at(v, "routing_key"),
        properties_key: str_at(v, "properties_key"),
        arguments: obj_at(v, "arguments"),
    }
}

pub fn parse_message(v: &Value) -> RabbitMessage {
    RabbitMessage {
        payload: str_at(v, "payload"),
        payload_encoding: {
            let e = str_at(v, "payload_encoding");
            if e.is_empty() { "string".into() } else { e }
        },
        payload_bytes: u64_at(v, "payload_bytes").unwrap_or(0),
        redelivered: bool_at(v, "redelivered"),
        exchange: str_at(v, "exchange"),
        routing_key: str_at(v, "routing_key"),
        message_count: u64_at(v, "message_count").unwrap_or(0),
        properties: obj_at(v, "properties"),
    }
}

fn sorted_by_name<T>(mut items: Vec<T>, name: impl Fn(&T) -> &str) -> Vec<T> {
    items.sort_by(|a, b| name(a).to_lowercase().cmp(&name(b).to_lowercase()));
    items
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

impl RabbitDriver {
    fn build(p: &RabbitConnParams) -> Result<Self, QueryError> {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60));
        if p.ssl && !p.ssl_ca.trim().is_empty() {
            let pem = std::fs::read(p.ssl_ca.trim()).map_err(|e| {
                QueryError::new(SYSTEM, format!("Cannot read CA certificate {}", p.ssl_ca), e.to_string())
            })?;
            let cert = reqwest::Certificate::from_pem(&pem)
                .map_err(|e| QueryError::new(SYSTEM, "Invalid CA certificate (PEM expected)", e.to_string()))?;
            builder = builder.add_root_certificate(cert);
        }
        let client = builder
            .build()
            .map_err(|e| QueryError::new(SYSTEM, e.to_string(), e.to_string()))?;
        Ok(Self {
            client,
            base: base_url(&p.host, p.port, p.ssl)?,
            user: p.user.clone(),
            password: p.password.clone(),
            vhost: effective_vhost(&p.vhost),
        })
    }

    pub async fn connect(p: &RabbitConnParams) -> Result<Self, QueryError> {
        let d = Self::build(p)?;
        // Real handshake: a wrong port / missing management plugin / bad creds
        // must fail here, not on the first click in the explorer.
        d.get_json(&["whoami"]).await?;
        let mut d = d;
        d.resolve_vhost(!p.vhost.trim().is_empty()).await?;
        Ok(d)
    }

    /// Make sure the vhost the connection opens on exists. Brokers deployed with
    /// `RABBITMQ_DEFAULT_VHOST` have no "/", so an empty Virtual host field (which
    /// means "/") used to open on a vhost that is not there: every queue / exchange
    /// call then came back as a bare 404 and the explorer showed nothing.
    /// * empty field  → open on the first vhost this user can see;
    /// * typed vhost  → refuse, naming the vhosts that do exist.
    async fn resolve_vhost(&mut self, explicit: bool) -> Result<(), QueryError> {
        match self.get_json(&["vhosts", &self.vhost]).await {
            Ok(_) => Ok(()),
            Err(e) if e.message.starts_with("Not found") => {
                let names = self.vhost_names().await.unwrap_or_default();
                if explicit {
                    let list = if names.is_empty() { "none visible to this user".to_string() } else { names.join(", ") };
                    return Err(QueryError::new(
                        SYSTEM,
                        format!(
                            "Virtual host '{}' does not exist on this broker (or this user has no access to it). Available: {list}",
                            self.vhost
                        ),
                        e.raw,
                    ));
                }
                match names.into_iter().next() {
                    Some(first) => {
                        self.vhost = first;
                        Ok(())
                    }
                    None => Err(QueryError::new(
                        SYSTEM,
                        "This user cannot see any virtual host — give it permissions in one, or set Virtual host in the connection",
                        e.raw,
                    )),
                }
            }
            // 401/403 on a single-vhost read (restricted user): keep going — the
            // vhost-scoped calls report precisely what is refused.
            Err(_) => Ok(()),
        }
    }

    async fn vhost_names(&self) -> Result<Vec<String>, QueryError> {
        let v = self.get_json(&["vhosts"]).await?;
        let mut names: Vec<String> = v
            .as_array()
            .map(|a| a.iter().map(|x| str_at(x, "name")).filter(|n| !n.is_empty()).collect())
            .unwrap_or_default();
        names.sort();
        Ok(names)
    }

    pub async fn test(p: &RabbitConnParams) -> TestResult {
        let started = Instant::now();
        let d = match Self::connect(p).await {
            Ok(d) => d,
            Err(e) => return TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        };
        let latency = started.elapsed().as_millis() as u64;
        let version = d
            .get_json(&["overview"])
            .await
            .ok()
            .map(|v| str_at(&v, "rabbitmq_version"))
            .filter(|v| !v.is_empty())
            .map(|v| format!("RabbitMQ {v}"));
        TestResult { ok: true, latency_ms: Some(latency), server_version: version, error: None }
    }

    pub async fn ping(&mut self) -> bool {
        self.get_json(&["whoami"]).await.is_ok()
    }

    /// vhost the connection was opened on.
    pub fn vhost(&self) -> &str {
        &self.vhost
    }

    async fn call(&self, method: Method, segments: &[&str], query: &[(&str, String)], body: Option<Value>) -> Result<(StatusCode, String), QueryError> {
        let url = api_url(&self.base, segments);
        let mut req = self.client.request(method, url).basic_auth(&self.user, Some(&self.password));
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.map_err(|e| {
            let hint = if e.is_connect() || e.is_timeout() {
                " — is the management plugin enabled? Use the HTTP port (15672), not the AMQP port (5672)"
            } else {
                ""
            };
            QueryError::new(SYSTEM, format!("Cannot reach the RabbitMQ management API at {}{hint}", self.base), e.to_string())
        })?;
        let status = res.status();
        let text = res
            .text()
            .await
            .map_err(|e| QueryError::new(SYSTEM, format!("Failed to read the response: {e}"), e.to_string()))?;
        if !status.is_success() {
            return Err(QueryError::new(SYSTEM, describe_error(status.as_u16(), &text), text));
        }
        Ok((status, text))
    }

    async fn get_json(&self, segments: &[&str]) -> Result<Value, QueryError> {
        self.get_json_q(segments, &[]).await
    }

    async fn get_json_q(&self, segments: &[&str], query: &[(&str, String)]) -> Result<Value, QueryError> {
        let (_, text) = self.call(Method::GET, segments, query, None).await?;
        serde_json::from_str(&text).map_err(|e| QueryError::new(SYSTEM, "Unexpected response from the management API", e.to_string()))
    }

    // ---- read ---------------------------------------------------------------

    pub async fn overview(&self) -> Result<RabbitOverview, QueryError> {
        let v = self.get_json(&["overview"]).await?;
        Ok(parse_overview(&v, &self.vhost))
    }

    pub async fn vhosts(&self) -> Result<Vec<String>, QueryError> {
        let mut names = self.vhost_names().await?;
        // Only when the broker lists nothing at all (a very restricted user) fall back
        // to the vhost the connection opened on — never offer a vhost the broker does
        // not have (that is what used to put a phantom "/" in the picker).
        if names.is_empty() {
            names.push(self.vhost.clone());
        }
        Ok(names)
    }

    pub async fn queues(&self, vhost: &str) -> Result<Vec<RabbitQueue>, QueryError> {
        let v = self.get_json(&["queues", vhost]).await.map_err(|e| vhost_not_found(vhost, e))?;
        let items = v.as_array().map(|a| a.iter().map(parse_queue).collect()).unwrap_or_default();
        Ok(sorted_by_name(items, |q: &RabbitQueue| q.name.as_str()))
    }

    pub async fn queue(&self, vhost: &str, name: &str) -> Result<RabbitQueue, QueryError> {
        let v = self.get_json(&["queues", vhost, name]).await?;
        Ok(parse_queue(&v))
    }

    pub async fn exchanges(&self, vhost: &str) -> Result<Vec<RabbitExchange>, QueryError> {
        let v = self.get_json(&["exchanges", vhost]).await.map_err(|e| vhost_not_found(vhost, e))?;
        let items = v.as_array().map(|a| a.iter().map(parse_exchange).collect()).unwrap_or_default();
        Ok(sorted_by_name(items, |e: &RabbitExchange| e.name.as_str()))
    }

    /// Bindings whose destination is this queue.
    pub async fn queue_bindings(&self, vhost: &str, queue: &str) -> Result<Vec<RabbitBinding>, QueryError> {
        let v = self.get_json(&["queues", vhost, queue, "bindings"]).await?;
        Ok(v.as_array().map(|a| a.iter().map(parse_binding).collect()).unwrap_or_default())
    }

    /// Bindings whose source is this exchange.
    pub async fn exchange_bindings(&self, vhost: &str, exchange: &str) -> Result<Vec<RabbitBinding>, QueryError> {
        if exchange.is_empty() {
            // The default exchange routes implicitly to every queue by name and has
            // no listable bindings.
            return Ok(Vec::new());
        }
        let v = self.get_json(&["exchanges", vhost, exchange, "bindings", "source"]).await?;
        Ok(v.as_array().map(|a| a.iter().map(parse_binding).collect()).unwrap_or_default())
    }

    /// Fetch up to `count` messages. `mode` = requeue (peek, default) | ack | reject.
    pub async fn get_messages(&self, vhost: &str, queue: &str, count: u32, mode: &str) -> Result<Vec<RabbitMessage>, QueryError> {
        let body = json!({
            "count": count.clamp(1, 1000),
            "ackmode": ack_mode(mode),
            "encoding": "auto",
            "truncate": 500_000,
        });
        let (_, text) = self.call(Method::POST, &["queues", vhost, queue, "get"], &[], Some(body)).await?;
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| QueryError::new(SYSTEM, "Unexpected response from the management API", e.to_string()))?;
        Ok(v.as_array().map(|a| a.iter().map(parse_message).collect()).unwrap_or_default())
    }

    // ---- write --------------------------------------------------------------

    pub async fn publish(
        &self,
        vhost: &str,
        exchange: &str,
        routing_key: &str,
        payload: &str,
        payload_encoding: &str,
        properties: Value,
    ) -> Result<RabbitPublishResult, QueryError> {
        let props = if properties.is_object() { properties } else { json!({}) };
        let body = json!({
            "properties": props,
            "routing_key": routing_key,
            "payload": payload,
            "payload_encoding": if payload_encoding == "base64" { "base64" } else { "string" },
        });
        let (_, text) = self
            .call(Method::POST, &["exchanges", vhost, exchange_api_name(exchange), "publish"], &[], Some(body))
            .await?;
        let routed = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("routed").and_then(Value::as_bool))
            .unwrap_or(false);
        Ok(RabbitPublishResult { routed })
    }

    pub async fn purge_queue(&self, vhost: &str, queue: &str) -> Result<(), QueryError> {
        self.call(Method::DELETE, &["queues", vhost, queue, "contents"], &[], None).await.map(|_| ())
    }

    pub async fn delete_queue(&self, vhost: &str, queue: &str) -> Result<(), QueryError> {
        self.call(Method::DELETE, &["queues", vhost, queue], &[], None).await.map(|_| ())
    }

    pub async fn delete_exchange(&self, vhost: &str, exchange: &str) -> Result<(), QueryError> {
        if exchange.is_empty() || exchange.starts_with("amq.") {
            return Err(QueryError::new(
                SYSTEM,
                "Built-in exchanges (the default exchange and amq.*) cannot be deleted",
                "refused: built-in exchange",
            ));
        }
        self.call(Method::DELETE, &["exchanges", vhost, exchange], &[], None).await.map(|_| ())
    }

    pub async fn declare_queue(
        &self,
        vhost: &str,
        name: &str,
        queue_type: &str,
        durable: bool,
        auto_delete: bool,
        arguments: Value,
    ) -> Result<(), QueryError> {
        let mut args = if arguments.is_object() { arguments } else { json!({}) };
        // Explicit type, like the management UI sends; "" / "default" = the vhost's
        // default queue type (RabbitMQ 3.13+ "Default for virtual host").
        if matches!(queue_type, "classic" | "quorum" | "stream") {
            args["x-queue-type"] = json!(queue_type);
        }
        let body = json!({ "durable": durable, "auto_delete": auto_delete, "arguments": args });
        self.call(Method::PUT, &["queues", vhost, name], &[], Some(body)).await.map(|_| ())
    }

    pub async fn declare_exchange(
        &self,
        vhost: &str,
        name: &str,
        exchange_type: &str,
        durable: bool,
        auto_delete: bool,
        internal: bool,
    ) -> Result<(), QueryError> {
        self.declare_exchange_with(vhost, name, exchange_type, durable, auto_delete, internal, json!({})).await
    }

    /// Declare an exchange with arguments (e.g. `alternate-exchange`).
    #[allow(clippy::too_many_arguments)]
    pub async fn declare_exchange_with(
        &self,
        vhost: &str,
        name: &str,
        exchange_type: &str,
        durable: bool,
        auto_delete: bool,
        internal: bool,
        arguments: Value,
    ) -> Result<(), QueryError> {
        let body = json!({
            "type": exchange_type,
            "durable": durable,
            "auto_delete": auto_delete,
            "internal": internal,
            "arguments": if arguments.is_object() { arguments } else { json!({}) },
        });
        self.call(Method::PUT, &["exchanges", vhost, name], &[], Some(body)).await.map(|_| ())
    }

    pub async fn bind_queue(&self, vhost: &str, exchange: &str, queue: &str, routing_key: &str, arguments: Value) -> Result<(), QueryError> {
        if exchange.is_empty() {
            return Err(QueryError::new(SYSTEM, "The default exchange binds every queue by name implicitly", "refused: default exchange"));
        }
        let args = if arguments.is_object() { arguments } else { json!({}) };
        let body = json!({ "routing_key": routing_key, "arguments": args });
        self.call(Method::POST, &["bindings", vhost, "e", exchange, "q", queue], &[], Some(body)).await.map(|_| ())
    }

    pub async fn unbind_queue(&self, vhost: &str, exchange: &str, queue: &str, properties_key: &str) -> Result<(), QueryError> {
        self.call(Method::DELETE, &["bindings", vhost, "e", exchange, "q", queue, properties_key], &[], None)
            .await
            .map(|_| ())
    }
}

// ---------------------------------------------------------------------------
// Live listening (watch = non-destructive tap queue · consume = ack and remove)
// ---------------------------------------------------------------------------

/// What a live session reads from: the queue itself (consume) or its tap (watch).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LivePlan {
    pub source: String,
    pub tap_queue: Option<String>,
    pub bindings: Vec<RabbitBinding>,
}

/// Prefix of the temporary queues a "watch" session creates. Each one carries
/// `x-expires`, so a tap left behind by a crashed app is deleted by the broker.
pub const TAP_PREFIX: &str = "dbstudio.tap.";
/// Idle lifetime of a tap queue on the broker (ms). Every poll is a basic.get, which
/// counts as use, so a running session keeps its tap alive indefinitely.
pub const TAP_EXPIRES_MS: u64 = 60_000;
/// Hard cap on what a tap may buffer if the app stops reading (oldest dropped).
pub const TAP_MAX_LENGTH: u64 = 10_000;

/// Name of the tap queue for a session (session ids are app-generated, but keep the
/// name to safe characters anyway).
pub fn tap_queue_name(session: &str) -> String {
    let clean: String = session
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect();
    format!("{TAP_PREFIX}{clean}")
}

/// Routing keys a watch on an exchange binds with.
/// topic → "#" (everything) unless patterns were given; fanout / headers → one
/// binding (the key is ignored); direct → only the keys given (a direct exchange
/// has no wildcard, so "everything" cannot be expressed with one binding).
pub fn watch_keys(exchange_type: &str, requested: &[String]) -> Result<Vec<String>, String> {
    let keys: Vec<String> = requested.iter().map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect();
    match exchange_type {
        "fanout" | "headers" => Ok(vec![String::new()]),
        "topic" => Ok(if keys.is_empty() { vec!["#".into()] } else { keys }),
        _ => {
            if keys.is_empty() {
                Err("A direct exchange has no wildcard — give the routing key(s) to watch".into())
            } else {
                Ok(keys)
            }
        }
    }
}

/// Bindings of a queue that a watch can copy onto its tap. The default exchange
/// binding cannot be copied (nothing may bind to the default exchange), so a
/// message published straight to the queue by name is invisible to a watch.
pub fn copyable_bindings(bindings: &[RabbitBinding]) -> Vec<RabbitBinding> {
    bindings
        .iter()
        .filter(|b| !b.source.is_empty() && b.destination_type != "exchange")
        .cloned()
        .collect()
}

/// Delay before the next poll when the last ones came back empty: quick at first
/// so a burst is picked up immediately, backing off to a 1s ceiling when idle.
pub fn idle_poll_delay(idle_rounds: u32) -> Duration {
    let ms = 150u64.saturating_mul(1u64 << idle_rounds.min(3));
    Duration::from_millis(ms.min(1_000))
}

impl RabbitDriver {
    /// Declare the tap queue of a watch session.
    pub async fn create_tap(&self, vhost: &str, session: &str) -> Result<String, QueryError> {
        let name = tap_queue_name(session);
        let body = json!({
            "durable": false,
            "auto_delete": false,
            "arguments": { "x-expires": TAP_EXPIRES_MS, "x-max-length": TAP_MAX_LENGTH },
        });
        self.call(Method::PUT, &["queues", vhost, &name], &[], Some(body)).await?;
        Ok(name)
    }

    /// Set up a live session. consume → reads the queue itself (ack = removed);
    /// watch → declares a tap queue and binds it so it receives a COPY of what flows
    /// (a queue watch copies the queue's own bindings; an exchange watch binds with
    /// `watch_keys`). Any failure after the tap exists deletes it again.
    pub async fn prepare_live(
        &self,
        session: &str,
        mode: &str,
        vhost: &str,
        queue: Option<&str>,
        exchange: Option<&str>,
        keys: &[String],
    ) -> Result<LivePlan, QueryError> {
        let refuse = |m: &str| QueryError::new(SYSTEM, m.to_string(), m.to_string());
        if mode == "consume" {
            let q = queue.filter(|q| !q.is_empty()).ok_or_else(|| refuse("Consume needs a queue"))?;
            self.queue(vhost, q).await?; // fail early (and readably) when it does not exist
            return Ok(LivePlan { source: q.to_string(), tap_queue: None, bindings: Vec::new() });
        }
        let binds: Vec<RabbitBinding> = if let Some(q) = queue.filter(|q| !q.is_empty()) {
            let copy = copyable_bindings(&self.queue_bindings(vhost, q).await?);
            if copy.is_empty() {
                return Err(refuse(
                    "This queue is only reached through the default exchange (published to by name), which cannot be watched — use Consume, or bind the queue to an exchange",
                ));
            }
            copy
        } else if let Some(x) = exchange {
            if x.is_empty() {
                return Err(refuse("The default exchange cannot be watched — open the queue and watch it instead"));
            }
            let ex = self
                .exchanges(vhost)
                .await?
                .into_iter()
                .find(|e| e.name == x)
                .ok_or_else(|| refuse(&format!("Not found — no exchange '{x}' in vhost '{vhost}'")))?;
            watch_keys(&ex.exchange_type, keys)
                .map_err(|m| refuse(&m))?
                .into_iter()
                .map(|k| RabbitBinding {
                    source: x.to_string(),
                    destination: String::new(),
                    destination_type: "queue".into(),
                    routing_key: k.clone(),
                    properties_key: k,
                    arguments: json!({}),
                })
                .collect()
        } else {
            return Err(refuse("Watch needs a queue or an exchange"));
        };
        let tap = self.create_tap(vhost, session).await?;
        let mut bound = Vec::new();
        for b in binds {
            if let Err(e) = self.bind_queue(vhost, &b.source, &tap, &b.routing_key, b.arguments.clone()).await {
                let _ = self.delete_queue(vhost, &tap).await;
                return Err(e);
            }
            bound.push(RabbitBinding { destination: tap.clone(), ..b });
        }
        Ok(LivePlan { source: tap.clone(), tap_queue: Some(tap), bindings: bound })
    }

    /// Bind a queue with explicit arguments (headers-exchange bindings need them).
    pub async fn bind_queue_args(&self, vhost: &str, exchange: &str, queue: &str, routing_key: &str, arguments: Value) -> Result<(), QueryError> {
        self.bind_queue(vhost, exchange, queue, routing_key, arguments).await
    }
}

// ---------------------------------------------------------------------------
// Users · permissions · topic permissions · policies · vhosts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RabbitWhoami {
    pub name: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RabbitUser {
    pub name: String,
    pub tags: Vec<String>,
    /// false = the user cannot log in with a password (cert / external auth only).
    pub has_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RabbitPermission {
    pub user: String,
    pub vhost: String,
    pub configure: String,
    pub write: String,
    pub read: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RabbitTopicPermission {
    pub user: String,
    pub vhost: String,
    pub exchange: String,
    pub write: String,
    pub read: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RabbitPolicy {
    pub name: String,
    pub vhost: String,
    pub pattern: String,
    /// queues | exchanges | all | classic_queues | quorum_queues | streams
    pub apply_to: String,
    pub priority: i64,
    pub definition: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RabbitVhost {
    pub name: String,
    pub description: String,
    pub messages: Option<u64>,
}

/// Tags come back as an array (3.9+) or a comma-separated string (older brokers).
pub fn parse_tags(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        Value::String(s) => s.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect(),
        _ => Vec::new(),
    }
}

/// Tags as the API expects them on write: one comma-separated string.
pub fn tags_csv(tags: &[String]) -> String {
    let mut out: Vec<String> = Vec::new();
    for t in tags.iter().map(|t| t.trim()).filter(|t| !t.is_empty()) {
        if !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    out.join(",")
}

pub fn parse_user(v: &Value) -> RabbitUser {
    RabbitUser {
        name: str_at(v, "name"),
        tags: parse_tags(v.get("tags").unwrap_or(&Value::Null)),
        has_password: !str_at(v, "password_hash").is_empty(),
    }
}

pub fn parse_permission(v: &Value) -> RabbitPermission {
    RabbitPermission {
        user: str_at(v, "user"),
        vhost: str_at(v, "vhost"),
        configure: str_at(v, "configure"),
        write: str_at(v, "write"),
        read: str_at(v, "read"),
    }
}

pub fn parse_topic_permission(v: &Value) -> RabbitTopicPermission {
    RabbitTopicPermission {
        user: str_at(v, "user"),
        vhost: str_at(v, "vhost"),
        exchange: str_at(v, "exchange"),
        write: str_at(v, "write"),
        read: str_at(v, "read"),
    }
}

pub fn parse_policy(v: &Value) -> RabbitPolicy {
    RabbitPolicy {
        name: str_at(v, "name"),
        vhost: str_at(v, "vhost"),
        pattern: str_at(v, "pattern"),
        apply_to: {
            let a = str_at(v, "apply-to");
            if a.is_empty() { "all".into() } else { a }
        },
        priority: v.get("priority").and_then(Value::as_i64).unwrap_or(0),
        definition: obj_at(v, "definition"),
    }
}

impl RabbitDriver {
    /// The user this connection is logged in as.
    pub fn login_user(&self) -> &str {
        &self.user
    }

    pub async fn whoami(&self) -> Result<RabbitWhoami, QueryError> {
        let v = self.get_json(&["whoami"]).await?;
        Ok(RabbitWhoami { name: str_at(&v, "name"), tags: parse_tags(v.get("tags").unwrap_or(&Value::Null)) })
    }

    pub async fn vhost_list(&self) -> Result<Vec<RabbitVhost>, QueryError> {
        let v = self.get_json(&["vhosts"]).await?;
        let mut items: Vec<RabbitVhost> = v
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|x| RabbitVhost {
                        name: str_at(x, "name"),
                        description: str_at(x, "description"),
                        messages: u64_at(x, "messages"),
                    })
                    .collect()
            })
            .unwrap_or_default();
        items.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(items)
    }

    pub async fn create_vhost(&self, name: &str, description: &str) -> Result<(), QueryError> {
        let body = json!({ "description": description });
        self.call(Method::PUT, &["vhosts", name], &[], Some(body)).await.map(|_| ())
    }

    pub async fn delete_vhost(&self, name: &str) -> Result<(), QueryError> {
        if name == self.vhost {
            return Err(QueryError::new(
                SYSTEM,
                "Cannot delete the virtual host this connection is opened on",
                "refused: connection vhost",
            ));
        }
        self.call(Method::DELETE, &["vhosts", name], &[], None).await.map(|_| ())
    }

    pub async fn users(&self) -> Result<Vec<RabbitUser>, QueryError> {
        let v = self.get_json(&["users"]).await?;
        let items = v.as_array().map(|a| a.iter().map(parse_user).collect()).unwrap_or_default();
        Ok(sorted_by_name(items, |u: &RabbitUser| u.name.as_str()))
    }

    pub async fn create_user(&self, name: &str, password: &str, tags: &[String]) -> Result<(), QueryError> {
        if name.trim().is_empty() {
            return Err(QueryError::new(SYSTEM, "User name is required", "empty user name"));
        }
        let body = json!({ "password": password, "tags": tags_csv(tags) });
        self.call(Method::PUT, &["users", name], &[], Some(body)).await.map(|_| ())
    }

    /// Change a user's password, keeping its tags (PUT replaces the whole user).
    pub async fn set_user_password(&self, name: &str, password: &str) -> Result<(), QueryError> {
        let cur = self.get_json(&["users", name]).await?;
        let tags = parse_tags(cur.get("tags").unwrap_or(&Value::Null));
        let body = json!({ "password": password, "tags": tags_csv(&tags) });
        self.call(Method::PUT, &["users", name], &[], Some(body)).await.map(|_| ())
    }

    /// Change a user's tags, keeping its password: PUT replaces the user, and a PUT
    /// without a password would leave the user unable to log in — so the existing
    /// password hash is sent back unchanged.
    pub async fn set_user_tags(&self, name: &str, tags: &[String]) -> Result<(), QueryError> {
        let cur = self.get_json(&["users", name]).await?;
        let mut body = json!({ "tags": tags_csv(tags) });
        let hash = str_at(&cur, "password_hash");
        if !hash.is_empty() {
            body["password_hash"] = json!(hash);
            let algo = str_at(&cur, "hashing_algorithm");
            if !algo.is_empty() {
                body["hashing_algorithm"] = json!(algo);
            }
        }
        self.call(Method::PUT, &["users", name], &[], Some(body)).await.map(|_| ())
    }

    pub async fn delete_user(&self, name: &str) -> Result<(), QueryError> {
        if name == self.user {
            return Err(QueryError::new(
                SYSTEM,
                "Cannot delete the user this connection is logged in as",
                "refused: connection user",
            ));
        }
        self.call(Method::DELETE, &["users", name], &[], None).await.map(|_| ())
    }

    pub async fn permissions(&self) -> Result<Vec<RabbitPermission>, QueryError> {
        let v = self.get_json(&["permissions"]).await?;
        Ok(v.as_array().map(|a| a.iter().map(parse_permission).collect()).unwrap_or_default())
    }

    pub async fn set_permission(&self, vhost: &str, user: &str, configure: &str, write: &str, read: &str) -> Result<(), QueryError> {
        let body = json!({ "configure": configure, "write": write, "read": read });
        self.call(Method::PUT, &["permissions", vhost, user], &[], Some(body)).await.map(|_| ())
    }

    pub async fn delete_permission(&self, vhost: &str, user: &str) -> Result<(), QueryError> {
        self.call(Method::DELETE, &["permissions", vhost, user], &[], None).await.map(|_| ())
    }

    pub async fn topic_permissions(&self) -> Result<Vec<RabbitTopicPermission>, QueryError> {
        let v = self.get_json(&["topic-permissions"]).await?;
        Ok(v.as_array().map(|a| a.iter().map(parse_topic_permission).collect()).unwrap_or_default())
    }

    pub async fn set_topic_permission(&self, vhost: &str, user: &str, exchange: &str, write: &str, read: &str) -> Result<(), QueryError> {
        let body = json!({ "exchange": exchange, "write": write, "read": read });
        self.call(Method::PUT, &["topic-permissions", vhost, user], &[], Some(body)).await.map(|_| ())
    }

    /// Removes every topic permission of the user in the vhost (the API has no
    /// per-exchange delete).
    pub async fn delete_topic_permissions(&self, vhost: &str, user: &str) -> Result<(), QueryError> {
        self.call(Method::DELETE, &["topic-permissions", vhost, user], &[], None).await.map(|_| ())
    }

    pub async fn policies(&self, vhost: &str) -> Result<Vec<RabbitPolicy>, QueryError> {
        let v = self.get_json(&["policies", vhost]).await?;
        let items = v.as_array().map(|a| a.iter().map(parse_policy).collect()).unwrap_or_default();
        Ok(sorted_by_name(items, |p: &RabbitPolicy| p.name.as_str()))
    }

    pub async fn set_policy(
        &self,
        vhost: &str,
        name: &str,
        pattern: &str,
        apply_to: &str,
        priority: i64,
        definition: Value,
    ) -> Result<(), QueryError> {
        if !definition.is_object() || definition.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            return Err(QueryError::new(
                SYSTEM,
                "A policy needs a definition with at least one key, e.g. {\"max-length\": 10000}",
                "empty policy definition",
            ));
        }
        let body = json!({
            "pattern": pattern,
            "apply-to": if apply_to.is_empty() { "all" } else { apply_to },
            "priority": priority,
            "definition": definition,
        });
        self.call(Method::PUT, &["policies", vhost, name], &[], Some(body)).await.map(|_| ())
    }

    pub async fn delete_policy(&self, vhost: &str, name: &str) -> Result<(), QueryError> {
        self.call(Method::DELETE, &["policies", vhost, name], &[], None).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vhost_404_names_the_vhost() {
        let raw = QueryError::new(SYSTEM, describe_error(404, r#"{"error":"Object Not Found","reason":"Not Found"}"#), "raw");
        let e = vhost_not_found("/", raw.clone());
        assert!(e.message.starts_with("Virtual host '/' was not found"), "{}", e.message);
        assert!(e.message.contains("%2F"), "a vhost with '/' gets the proxy hint");
        assert!(!vhost_not_found("app", raw).message.contains("%2F"));
        let other = QueryError::new(SYSTEM, "Authentication failed", "raw");
        assert_eq!(vhost_not_found("/", other).message, "Authentication failed", "other errors pass through");
    }

    #[test]
    fn watch_keys_per_exchange_type() {
        assert_eq!(watch_keys("topic", &[]).unwrap(), vec!["#".to_string()]);
        assert_eq!(watch_keys("topic", &["order.*".into(), " ".into()]).unwrap(), vec!["order.*".to_string()]);
        assert_eq!(watch_keys("fanout", &["ignored".into()]).unwrap(), vec![String::new()]);
        assert_eq!(watch_keys("headers", &[]).unwrap(), vec![String::new()]);
        assert!(watch_keys("direct", &[]).is_err(), "direct cannot watch everything");
        assert_eq!(watch_keys("direct", &["a".into(), "b".into()]).unwrap(), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn copyable_bindings_skip_the_default_exchange() {
        let b = |src: &str, kind: &str| RabbitBinding {
            source: src.into(),
            destination: "q".into(),
            destination_type: kind.into(),
            routing_key: "k".into(),
            properties_key: "k".into(),
            arguments: json!({}),
        };
        let got = copyable_bindings(&[b("", "queue"), b("orders", "queue"), b("events", "queue")]);
        assert_eq!(got.iter().map(|x| x.source.as_str()).collect::<Vec<_>>(), vec!["orders", "events"]);
    }

    #[test]
    fn tap_names_are_safe_and_prefixed() {
        assert_eq!(tap_queue_name("ab-12_x"), "dbstudio.tap.ab-12_x");
        assert_eq!(tap_queue_name("a/b c#d"), "dbstudio.tap.abcd");
    }

    #[test]
    fn idle_polls_back_off_to_one_second() {
        assert_eq!(idle_poll_delay(0), Duration::from_millis(150));
        assert_eq!(idle_poll_delay(1), Duration::from_millis(300));
        assert_eq!(idle_poll_delay(2), Duration::from_millis(600));
        assert_eq!(idle_poll_delay(3), Duration::from_millis(1000));
        assert_eq!(idle_poll_delay(40), Duration::from_millis(1000));
    }

    #[test]
    fn tags_and_users_parse_both_shapes() {
        assert_eq!(parse_tags(&json!(["administrator", "management"])), vec!["administrator", "management"]);
        assert_eq!(parse_tags(&json!("administrator, monitoring")), vec!["administrator", "monitoring"]);
        assert!(parse_tags(&json!("")).is_empty());
        assert_eq!(tags_csv(&["a".into(), " b ".into(), "a".into(), "".into()]), "a,b");
        let u = parse_user(&json!({"name": "svc", "tags": "monitoring", "password_hash": "abc"}));
        assert_eq!(u.tags, vec!["monitoring"]);
        assert!(u.has_password);
        assert!(!parse_user(&json!({"name": "cert", "tags": [], "password_hash": ""})).has_password);
        let p = parse_policy(&json!({"name": "ttl", "pattern": "^orders", "apply-to": "queues", "priority": 5, "definition": {"message-ttl": 60000}}));
        assert_eq!(p.apply_to, "queues");
        assert_eq!(p.priority, 5);
        assert_eq!(p.definition["message-ttl"], 60000);
    }

    #[test]
    fn vhost_and_default_exchange_names() {
        assert_eq!(effective_vhost(""), "/");
        assert_eq!(effective_vhost("  "), "/");
        assert_eq!(effective_vhost("orders"), "orders");
        assert_eq!(exchange_api_name(""), "amq.default");
        assert_eq!(exchange_api_name("amq.topic"), "amq.topic");
    }

    /// Every segment is encoded on its own: the default vhost `/` must travel as
    /// `%2F` (a raw `/` would split the path and address the wrong resource), and a
    /// queue name with `/`, spaces or `#` must stay one segment.
    #[test]
    fn api_url_percent_encodes_each_segment() {
        let base = base_url("localhost", 15672, false).unwrap();
        assert_eq!(api_url(&base, &["overview"]).as_str(), "http://localhost:15672/api/overview");
        assert_eq!(api_url(&base, &["queues", "/"]).as_str(), "http://localhost:15672/api/queues/%2F");
        assert_eq!(
            api_url(&base, &["queues", "/", "orders/eu #1", "get"]).as_str(),
            "http://localhost:15672/api/queues/%2F/orders%2Feu%20%231/get"
        );
        let tls = base_url("mq.example.com", 15671, true).unwrap();
        assert_eq!(api_url(&tls, &["whoami"]).as_str(), "https://mq.example.com:15671/api/whoami");
        let v6 = base_url("::1", 15672, false).unwrap();
        assert_eq!(api_url(&v6, &["whoami"]).as_str(), "http://[::1]:15672/api/whoami");
    }

    #[test]
    fn ack_mode_defaults_to_the_non_destructive_peek() {
        assert_eq!(ack_mode("requeue"), "ack_requeue_true");
        assert_eq!(ack_mode(""), "ack_requeue_true");
        assert_eq!(ack_mode("whatever"), "ack_requeue_true");
        assert_eq!(ack_mode("ack"), "ack_requeue_false");
        assert_eq!(ack_mode("reject"), "reject_requeue_false");
    }

    #[test]
    fn errors_are_actionable() {
        assert!(describe_error(401, "").contains("Authentication failed"));
        assert!(describe_error(401, r#"{"error":"not_authorised","reason":"Login failed"}"#).contains("Authentication failed"));
        // a logged-in user without the tag is not an authentication failure
        let m = describe_error(401, r#"{"error":"not_authorised","reason":"Not administrator user"}"#);
        assert!(m.contains("'administrator' tag") && !m.contains("Authentication failed"), "{m}");
        assert!(describe_error(401, r#"{"error":"not_authorised","reason":"Not policymaker user"}"#).contains("'policymaker' tag"));
        assert!(describe_error(404, r#"{"error":"Object Not Found","reason":"Not Found"}"#).contains("Not Found"));
        let m = describe_error(400, r#"{"error":"bad_request","reason":"inequivalent arg 'durable'"}"#);
        assert!(m.contains("inequivalent arg"), "{m}");
        assert!(describe_error(403, "{}").contains("management tag"));
    }

    #[test]
    fn parses_queue_exchange_message_and_overview() {
        let q = parse_queue(&json!({
            "name": "orders", "vhost": "/", "type": "quorum", "durable": true, "state": "running",
            "messages": 12, "messages_ready": 10, "messages_unacknowledged": 2, "consumers": 1,
            "arguments": {"x-queue-type": "quorum"}
        }));
        assert_eq!(q.queue_type, "quorum");
        assert_eq!(q.messages, Some(12));
        assert_eq!(q.messages_unacknowledged, Some(2));
        // A just-declared queue may not report stats yet — None, not a fake 0.
        let fresh = parse_queue(&json!({"name": "new", "vhost": "/"}));
        assert_eq!(fresh.messages, None);
        assert_eq!(fresh.queue_type, "classic");
        assert_eq!(fresh.arguments, json!({}));

        let e = parse_exchange(&json!({"name": "", "vhost": "/", "type": "direct", "durable": true}));
        assert_eq!(e.name, "");
        assert_eq!(e.exchange_type, "direct");

        let m = parse_message(&json!({
            "payload": "{\"id\":1}", "payload_bytes": 8, "redelivered": true, "exchange": "",
            "routing_key": "orders", "message_count": 3, "properties": {"content_type": "application/json"}
        }));
        assert_eq!(m.payload_encoding, "string");
        assert!(m.redelivered);
        assert_eq!(m.properties["content_type"], "application/json");

        let o = parse_overview(
            &json!({"rabbitmq_version": "3.13.7", "queue_totals": {"messages": 5}, "object_totals": {"queues": 2, "exchanges": 9}}),
            "/",
        );
        assert_eq!(o.rabbitmq_version, "3.13.7");
        assert_eq!(o.messages, 5);
        assert_eq!(o.queues, 2);
        assert_eq!(o.exchanges, 9);
        assert_eq!(o.consumers, 0);
    }
}
