//! MongoDB driver — official `mongodb` async crate, one dedicated Client per
//! profile (the Client owns an internal connection pool). MongoDB is a document
//! store: it does NOT speak SQL. The query editor runs mongosh-style strings
//! (`db.coll.find({...})`) through `exec_mongo`; the relational introspection
//! arms of `LiveConnection` return empty and the Explorer uses dedicated
//! `mongo_*` commands instead (mirrors the Cassandra pattern).
//!
//! M0 scope: connect / test / ping are real. Data methods (exec_mongo, grid,
//! introspection, scan_indexes) are stubs implemented in later milestones so we
//! can iterate them against a real `mongo:7` testcontainer instead of blind.

use std::time::{Duration, Instant};

use mongodb::bson::doc;
use mongodb::options::ClientOptions;
use mongodb::Client;

use crate::drivers::grid;
use crate::drivers::index_scan;
use crate::drivers::types::*;
use crate::error::QueryError;

/// Connection params mapped from a `ConnectionProfile` (reuses existing fields —
/// no MongoDB-specific columns per the locked decision). `host` may be a bare
/// host, a comma list of `host:port`, or a full `mongodb://` / `mongodb+srv://`
/// connection string.
pub struct MongoConnParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub ssl: bool,
    /// TLS CA path (empty = system roots). Applied via `tlsCAFile` when set.
    pub ssl_ca: String,
}

/// Outcome of one editor statement — mirrors Cassandra's `CqlOutcome`:
/// a `StatementOutcome` plus a cursor token for the next page and any
/// non-fatal server warnings.
pub struct MongoOutcome {
    pub outcome: StatementOutcome,
    pub next_cursor: Option<String>,
    pub warnings: Vec<String>,
}

pub struct MongoDriver {
    client: Client,
    /// Default database for this connection (from the profile). Empty → "test".
    /// Read by exec_mongo / introspection from M1 onward.
    #[allow(dead_code)]
    database: String,
}

/// URL-encode the userinfo component of a connection string (RFC 3986 sub-set
/// enough for usernames/passwords). Keeps `@ : / ?` from breaking the URI.
fn userinfo_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Build a `mongodb://` URI from the profile params. If `host` already looks
/// like a full connection string, it is used verbatim.
fn build_uri(p: &MongoConnParams) -> String {
    let h = p.host.trim();
    if h.starts_with("mongodb://") || h.starts_with("mongodb+srv://") {
        return h.to_string();
    }
    let mut uri = String::from("mongodb://");
    if !p.user.is_empty() {
        uri.push_str(&userinfo_encode(&p.user));
        if !p.password.is_empty() {
            uri.push(':');
            uri.push_str(&userinfo_encode(&p.password));
        }
        uri.push('@');
    }
    // Host part: keep a comma list as-is, otherwise append the port.
    if h.contains(',') || h.contains(':') {
        uri.push_str(h);
    } else {
        uri.push_str(&format!("{}:{}", h, p.port));
    }
    uri.push('/');
    // Query params.
    let mut params: Vec<String> = Vec::new();
    if p.ssl {
        params.push("tls=true".into());
        if !p.ssl_ca.is_empty() {
            params.push(format!("tlsCAFile={}", p.ssl_ca));
        }
    }
    if !p.user.is_empty() && !p.database.is_empty() {
        params.push(format!("authSource={}", p.database));
    }
    if !params.is_empty() {
        uri.push('?');
        uri.push_str(&params.join("&"));
    }
    uri
}

fn conn_err(e: impl std::fmt::Display) -> QueryError {
    QueryError::new("mongodb", format!("MongoDB connection failed: {e}"), e.to_string())
}

impl MongoDriver {
    pub async fn connect(p: &MongoConnParams) -> Result<Self, QueryError> {
        let uri = build_uri(p);
        let mut opts = ClientOptions::parse(&uri).await.map_err(conn_err)?;
        opts.app_name = Some("Database Studio".to_string());
        opts.server_selection_timeout = Some(Duration::from_secs(10));
        opts.connect_timeout = Some(Duration::from_secs(10));
        let client = Client::with_options(opts).map_err(conn_err)?;
        let database = if p.database.trim().is_empty() {
            "test".to_string()
        } else {
            p.database.trim().to_string()
        };
        let drv = Self { client, database };
        // Real handshake: a `ping` against admin confirms the server is reachable.
        if !drv.ping_now().await {
            return Err(QueryError::new(
                "mongodb",
                "MongoDB did not respond to ping",
                "ping failed after connect",
            ));
        }
        Ok(drv)
    }

    pub async fn test(p: &MongoConnParams) -> TestResult {
        let started = Instant::now();
        match Self::connect(p).await {
            Ok(drv) => {
                let version = drv
                    .client
                    .database("admin")
                    .run_command(doc! { "buildInfo": 1 })
                    .await
                    .ok()
                    .and_then(|d| d.get_str("version").ok().map(|s| s.to_string()))
                    .map(|v| format!("MongoDB {v}"));
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: version,
                    error: None,
                }
            }
            Err(e) => TestResult {
                ok: false,
                latency_ms: None,
                server_version: None,
                error: Some(e.message),
            },
        }
    }

    async fn ping_now(&self) -> bool {
        self.client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .is_ok()
    }

    pub async fn ping(&mut self) -> bool {
        self.ping_now().await
    }

    // ---- data methods (implemented in later milestones) --------------------

    /// M2: parse a mongosh-style statement and run it, returning documents as
    /// `QueryResultSet` with `cols` inferred from the union of document keys.
    pub async fn exec_mongo(
        &self,
        _query: &str,
        _batch_size: Option<i32>,
        _cursor_token: Option<&str>,
    ) -> Result<MongoOutcome, QueryError> {
        Err(QueryError::new(
            "mongodb",
            "MongoDB query editor is not implemented yet (milestone M2)",
            "exec_mongo unimplemented",
        ))
    }

    /// M1: `listDatabases`.
    pub async fn databases(&mut self) -> Result<Vec<DatabaseInfo>, QueryError> {
        Ok(Vec::new())
    }

    /// M3: editable grid — insert/update/delete documents by `_id`.
    pub async fn apply_grid(&self, _changes: &[grid::GridChange]) -> Result<u64, QueryError> {
        Err(QueryError::new(
            "mongodb",
            "MongoDB inline edit is not implemented yet (milestone M3)",
            "apply_grid unimplemented",
        ))
    }

    /// M4: Index Scanner via `$indexStats`.
    pub async fn scan_indexes(
        &self,
        _database: &str,
    ) -> Result<Vec<index_scan::IndexScanRow>, QueryError> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(host: &str, user: &str, pw: &str, db: &str, ssl: bool) -> MongoConnParams {
        MongoConnParams {
            host: host.into(),
            port: 27017,
            database: db.into(),
            user: user.into(),
            password: pw.into(),
            ssl,
            ssl_ca: String::new(),
        }
    }

    #[test]
    fn build_uri_bare_host_appends_port() {
        let u = build_uri(&params("localhost", "", "", "", false));
        assert_eq!(u, "mongodb://localhost:27017/");
    }

    #[test]
    fn build_uri_with_credentials_and_authsource() {
        let u = build_uri(&params("db.example.com", "admin", "p@ss/word", "appdb", false));
        // userinfo is percent-encoded so '@' and '/' don't break the URI.
        assert!(u.starts_with("mongodb://admin:p%40ss%2Fword@db.example.com:27017/"));
        assert!(u.contains("authSource=appdb"));
    }

    #[test]
    fn build_uri_tls_flag_and_ca() {
        let mut p = params("h", "", "", "", true);
        p.ssl_ca = "/etc/ca.pem".into();
        let u = build_uri(&p);
        assert!(u.contains("tls=true"));
        assert!(u.contains("tlsCAFile=/etc/ca.pem"));
    }

    #[test]
    fn build_uri_passthrough_full_connection_string() {
        let u = build_uri(&params("mongodb+srv://cluster0.abcd.mongodb.net", "", "", "", false));
        assert_eq!(u, "mongodb+srv://cluster0.abcd.mongodb.net");
    }
}
