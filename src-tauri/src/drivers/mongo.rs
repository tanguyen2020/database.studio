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

use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::Engine as _;
use mongodb::bson::{self, doc, Bson, Document};
use mongodb::options::ClientOptions;
use mongodb::Client;
use serde_json::{json, Map, Value};

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

fn exec_err(e: impl std::fmt::Display) -> QueryError {
    QueryError::new("mongodb", format!("MongoDB error: {e}"), e.to_string())
}

/// MongoDB (BSON) type name for the Explorer field type badge.
fn bson_type_name(b: &Bson) -> &'static str {
    match b {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Document(_) => "object",
        Bson::Array(_) => "array",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Decimal128(_) => "decimal",
        Bson::Binary(_) => "binData",
        Bson::RegularExpression(_) => "regex",
        Bson::Timestamp(_) => "timestamp",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        _ => "mixed",
    }
}

fn perr(msg: impl Into<String>) -> QueryError {
    let m = msg.into();
    QueryError::new("mongodb", m.clone(), m)
}

/// One parsed mongosh-style call: `db.<collection>.<method>(<args>)` with the
/// optional `.sort()/.skip()/.limit()` cursor modifiers (find only).
struct MongoCall {
    collection: String,
    method: String, // lowercased
    args: Vec<Value>,
    sort: Option<Value>,
    skip: Option<i64>,
    limit: Option<i64>,
}

/// Read a balanced `(...)` group. `s` must start with `(`. Returns the inner
/// text and the remainder after the matching `)`. Brackets `(){}[]` are counted
/// together (fine for balanced input); quotes are respected.
fn read_group(s: &str) -> Result<(&str, &str), QueryError> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'(') {
        return Err(perr("expected '('"));
    }
    let mut depth = 0i32;
    let mut in_str: Option<u8> = None;
    let mut esc = false;
    for (i, &b) in bytes.iter().enumerate() {
        if let Some(q) = in_str {
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == q {
                in_str = None;
            }
            continue;
        }
        match b {
            b'"' | b'\'' => in_str = Some(b),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Ok((&s[1..i], &s[i + 1..]));
                }
            }
            _ => {}
        }
    }
    Err(perr("unbalanced parentheses in query"))
}

/// Split a call's argument text at top-level commas and parse each as JSON.
/// MongoDB filters/documents must be valid JSON (double-quoted keys/strings);
/// Extended JSON like `{"$oid":"..."}` is accepted as-is.
fn split_args(inner: &str) -> Result<Vec<Value>, QueryError> {
    let t = inner.trim();
    if t.is_empty() {
        return Ok(Vec::new());
    }
    let bytes = t.as_bytes();
    let mut parts: Vec<&str> = Vec::new();
    let mut depth = 0i32;
    let mut in_str: Option<u8> = None;
    let mut esc = false;
    let mut start = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        if let Some(q) = in_str {
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == q {
                in_str = None;
            }
            continue;
        }
        match b {
            b'"' | b'\'' => in_str = Some(b),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&t[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&t[start..]);
    let mut out = Vec::with_capacity(parts.len());
    for p in parts {
        let p = p.trim();
        let v: Value = serde_json::from_str(p).map_err(|e| {
            perr(format!("invalid JSON argument `{p}`: {e} (keys/strings must be double-quoted)"))
        })?;
        out.push(v);
    }
    Ok(out)
}

fn parse_mongo_query(q: &str) -> Result<MongoCall, QueryError> {
    let s = q.trim().trim_end_matches(';').trim();
    let rest = s
        .strip_prefix("db.")
        .ok_or_else(|| perr("query must start with db.<collection>.<method>(...)"))?;
    let paren = rest.find('(').ok_or_else(|| perr("expected '(' after the method name"))?;
    let head = &rest[..paren];
    let dot = head
        .rfind('.')
        .ok_or_else(|| perr("expected db.<collection>.<method>(...)"))?;
    let collection = head[..dot].trim().to_string();
    let method = head[dot + 1..].trim().to_lowercase();
    if collection.is_empty() || method.is_empty() {
        return Err(perr("empty collection or method name"));
    }
    let (inner, mut after) = read_group(&rest[paren..])?;
    let args = split_args(inner)?;

    let (mut sort, mut skip, mut limit) = (None, None, None);
    after = after.trim();
    while let Some(chain) = after.strip_prefix('.') {
        let p = chain.find('(').ok_or_else(|| perr("expected '(' in chained call"))?;
        let name = chain[..p].trim().to_lowercase();
        let (cinner, crest) = read_group(&chain[p..])?;
        match name.as_str() {
            "sort" => sort = Some(serde_json::from_str(cinner.trim()).unwrap_or(Value::Null)),
            "skip" => skip = cinner.trim().parse::<i64>().ok(),
            "limit" => limit = cinner.trim().parse::<i64>().ok(),
            other => return Err(perr(format!("unsupported chained method .{other}()"))),
        }
        after = crest.trim();
    }
    Ok(MongoCall { collection, method, args, sort, skip, limit })
}

/// A JSON value → BSON document (for filters/updates/keys). None if not an object.
fn value_to_doc(v: &Value) -> Option<Document> {
    bson::to_bson(v).ok()?.as_document().cloned()
}

/// BSON → JSON in MongoDB Extended JSON (relaxed-ish): ObjectId → `{"$oid":…}`,
/// Date → `{"$date":…}`, Decimal128 → `{"$numberDecimal":…}`, Binary → `{"$binary":…}`.
fn bson_to_json(b: &Bson) -> Value {
    match b {
        Bson::Double(f) => json!(f),
        Bson::String(s) => json!(s),
        Bson::Boolean(v) => json!(v),
        Bson::Null | Bson::Undefined => Value::Null,
        Bson::Int32(i) => json!(i),
        Bson::Int64(i) => json!(i),
        Bson::ObjectId(o) => json!({ "$oid": o.to_hex() }),
        Bson::DateTime(d) => json!({
            "$date": d.try_to_rfc3339_string().unwrap_or_else(|_| d.timestamp_millis().to_string())
        }),
        Bson::Decimal128(d) => json!({ "$numberDecimal": d.to_string() }),
        Bson::Binary(bin) => json!({
            "$binary": {
                "base64": base64::engine::general_purpose::STANDARD.encode(&bin.bytes),
                "subType": format!("{:02x}", u8::from(bin.subtype)),
            }
        }),
        Bson::RegularExpression(r) => json!({
            "$regularExpression": { "pattern": r.pattern, "options": r.options }
        }),
        Bson::Timestamp(t) => json!({ "$timestamp": { "t": t.time, "i": t.increment } }),
        Bson::JavaScriptCode(c) => json!({ "$code": c }),
        Bson::Symbol(s) => json!(s),
        Bson::MaxKey => json!({ "$maxKey": 1 }),
        Bson::MinKey => json!({ "$minKey": 1 }),
        Bson::Array(a) => Value::Array(a.iter().map(bson_to_json).collect()),
        Bson::Document(d) => {
            let mut m = Map::new();
            for (k, v) in d.iter() {
                m.insert(k.clone(), bson_to_json(v));
            }
            Value::Object(m)
        }
        // DbPointer / JavaScriptCodeWithScope — rare; stringify to avoid panics.
        other => json!(format!("{other:?}")),
    }
}

/// Build a `QueryResultSet` from a batch of documents: `cols` = union of top-level
/// keys in first-seen order, typed by the first non-null value seen; `rows` =
/// documents as Extended JSON.
fn docs_to_result(docs: &[Bson]) -> QueryResultSet {
    let mut order: Vec<String> = Vec::new();
    let mut types: HashMap<String, String> = HashMap::new();
    let mut rows: Vec<Value> = Vec::with_capacity(docs.len());
    for b in docs {
        if let Bson::Document(d) = b {
            for (k, v) in d.iter() {
                let tn = bson_type_name(v).to_string();
                match types.get(k) {
                    None => {
                        order.push(k.clone());
                        types.insert(k.clone(), tn);
                    }
                    Some(prev) if prev == "null" && tn != "null" => {
                        types.insert(k.clone(), tn);
                    }
                    _ => {}
                }
            }
        }
        rows.push(bson_to_json(b));
    }
    let cols: Vec<ColumnDef> = order
        .into_iter()
        .map(|c| {
            let t = types.remove(&c).unwrap_or_default();
            (c, t)
        })
        .collect();
    let total = rows.len() as u64;
    QueryResultSet { cols, rows, total }
}

/// Surface a write-command's first `writeErrors` entry as a QueryError.
fn check_write_errors(res: &Document) -> Result<(), QueryError> {
    if let Ok(errs) = res.get_array("writeErrors") {
        if let Some(Bson::Document(e)) = errs.first() {
            let msg = e.get_str("errmsg").unwrap_or("write error").to_string();
            return Err(perr(msg));
        }
    }
    Ok(())
}

/// JSON → BSON, recognising Extended JSON wrappers so a grid `_id` value that was
/// serialised as `{"$oid":…}` (or `$date`/`$numberDecimal`) round-trips back to the
/// real ObjectId/DateTime/Decimal128 — otherwise the update/delete filter wouldn't
/// match. Plain integers become Int64 (Mongo compares numeric types cross-width).
fn json_to_bson(v: &Value) -> Bson {
    match v {
        Value::Null => Bson::Null,
        Value::Bool(b) => Bson::Boolean(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Bson::Int64(i)
            } else if let Some(f) = n.as_f64() {
                Bson::Double(f)
            } else {
                Bson::Null
            }
        }
        Value::String(s) => Bson::String(s.clone()),
        Value::Array(a) => Bson::Array(a.iter().map(json_to_bson).collect()),
        Value::Object(m) => {
            if m.len() == 1 {
                if let Some(Value::String(hex)) = m.get("$oid") {
                    if let Ok(oid) = mongodb::bson::oid::ObjectId::parse_str(hex) {
                        return Bson::ObjectId(oid);
                    }
                }
                if let Some(Value::String(d)) = m.get("$date") {
                    if let Ok(dt) = mongodb::bson::DateTime::parse_rfc3339_str(d) {
                        return Bson::DateTime(dt);
                    }
                }
                if let Some(Value::String(nd)) = m.get("$numberDecimal") {
                    if let Ok(dec) = nd.parse::<mongodb::bson::Decimal128>() {
                        return Bson::Decimal128(dec);
                    }
                }
            }
            let mut doc = Document::new();
            for (k, val) in m {
                doc.insert(k.clone(), json_to_bson(val));
            }
            Bson::Document(doc)
        }
    }
}

/// Human-readable mongosh preview of a pending grid change (dialog only — Apply
/// runs the same op through `apply_grid`). Mirrors Cassandra's `cql_change_sql`.
pub fn mongo_change_preview(change: &grid::GridChange) -> String {
    let obj = |cols: &[grid::Col]| -> String {
        let mut m = Map::new();
        for c in cols {
            m.insert(c.name.clone(), c.value.clone());
        }
        serde_json::to_string(&Value::Object(m)).unwrap_or_else(|_| "{}".into())
    };
    match change {
        grid::GridChange::Insert { table, values, .. } => {
            format!("db.{table}.insertOne({})", obj(values))
        }
        grid::GridChange::Update { table, pk, set, .. } => {
            let mut s = Map::new();
            for c in set {
                s.insert(c.name.clone(), c.value.clone());
            }
            let set_json = serde_json::to_string(&json!({ "$set": Value::Object(s) }))
                .unwrap_or_else(|_| "{}".into());
            format!("db.{table}.updateOne({}, {set_json})", obj(pk))
        }
        grid::GridChange::Delete { table, pk, .. } => {
            format!("db.{table}.deleteOne({})", obj(pk))
        }
    }
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

    /// Run a mongosh-style statement (`db.coll.find({...}).limit(n)`, aggregate,
    /// count/distinct, and insert/update/delete). Reads return a `QueryResultSet`
    /// (cols = union of document keys, rows = Extended JSON); writes return the
    /// affected count. Bounded to a single batch — cursor paging arrives in M3.
    pub async fn exec_mongo(
        &self,
        query: &str,
        batch_size: Option<i32>,
        cursor_token: Option<&str>,
    ) -> Result<MongoOutcome, QueryError> {
        self.exec_mongo_in(None, query, batch_size, cursor_token).await
    }

    /// Like `exec_mongo` but against an explicit database (the collection viewer
    /// targets any database, not just the connection's default).
    pub async fn exec_mongo_in(
        &self,
        database: Option<&str>,
        query: &str,
        batch_size: Option<i32>,
        _cursor_token: Option<&str>,
    ) -> Result<MongoOutcome, QueryError> {
        const DEFAULT_LIMIT: i64 = 500;
        let call = parse_mongo_query(query)?;
        let db = self.client.database(database.unwrap_or(&self.database));
        let coll = call.collection.clone();
        let rows_outcome = |batch: &[Bson]| MongoOutcome {
            outcome: StatementOutcome::Rows { result: docs_to_result(batch) },
            next_cursor: None,
            warnings: Vec::new(),
        };
        let affected_outcome = |n: u64| MongoOutcome {
            outcome: StatementOutcome::Affected { affected: n },
            next_cursor: None,
            warnings: Vec::new(),
        };

        match call.method.as_str() {
            "find" => {
                let lim = call
                    .limit
                    .or(batch_size.map(|b| b as i64))
                    .filter(|n| *n > 0)
                    .unwrap_or(DEFAULT_LIMIT);
                let mut cmd = doc! { "find": &coll, "limit": lim, "batchSize": lim };
                if let Some(f) = call.args.first().and_then(value_to_doc) {
                    cmd.insert("filter", f);
                }
                if let Some(p) = call.args.get(1).and_then(value_to_doc) {
                    cmd.insert("projection", p);
                }
                if let Some(s) = call.sort.as_ref().and_then(value_to_doc) {
                    cmd.insert("sort", s);
                }
                if let Some(sk) = call.skip {
                    cmd.insert("skip", sk);
                }
                let res = db.run_command(cmd).await.map_err(exec_err)?;
                let batch = res
                    .get_document("cursor")
                    .and_then(|c| c.get_array("firstBatch"))
                    .map_err(exec_err)?;
                Ok(rows_outcome(batch))
            }
            "aggregate" => {
                let pipeline = call.args.first().cloned().unwrap_or(Value::Array(vec![]));
                let arr = bson::to_bson(&pipeline)
                    .map_err(exec_err)?
                    .as_array()
                    .cloned()
                    .ok_or_else(|| perr("aggregate([...]) requires a pipeline array"))?;
                let bs = batch_size.unwrap_or(500);
                let cmd = doc! { "aggregate": &coll, "pipeline": arr, "cursor": doc! { "batchSize": bs } };
                let res = db.run_command(cmd).await.map_err(exec_err)?;
                let batch = res
                    .get_document("cursor")
                    .and_then(|c| c.get_array("firstBatch"))
                    .map_err(exec_err)?;
                Ok(rows_outcome(batch))
            }
            "countdocuments" | "count" => {
                let filter = call.args.first().and_then(value_to_doc).unwrap_or_default();
                let cmd = doc! { "count": &coll, "query": filter };
                let res = db.run_command(cmd).await.map_err(exec_err)?;
                let n = res
                    .get_i32("n")
                    .map(|v| v as i64)
                    .or_else(|_| res.get_i64("n"))
                    .unwrap_or(0);
                Ok(MongoOutcome {
                    outcome: StatementOutcome::Rows {
                        result: QueryResultSet {
                            cols: vec![("count".into(), "long".into())],
                            rows: vec![json!({ "count": n })],
                            total: 1,
                        },
                    },
                    next_cursor: None,
                    warnings: Vec::new(),
                })
            }
            "distinct" => {
                let key = call
                    .args
                    .first()
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| perr("distinct(\"key\") requires a string key"))?
                    .to_string();
                let filter = call.args.get(1).and_then(value_to_doc).unwrap_or_default();
                let cmd = doc! { "distinct": &coll, "key": &key, "query": filter };
                let res = db.run_command(cmd).await.map_err(exec_err)?;
                let vals = res.get_array("values").cloned().unwrap_or_default();
                let rows: Vec<Value> = vals
                    .iter()
                    .map(|b| {
                        let mut m = Map::new();
                        m.insert(key.clone(), bson_to_json(b));
                        Value::Object(m)
                    })
                    .collect();
                let total = rows.len() as u64;
                Ok(MongoOutcome {
                    outcome: StatementOutcome::Rows {
                        result: QueryResultSet { cols: vec![(key, String::new())], rows, total },
                    },
                    next_cursor: None,
                    warnings: Vec::new(),
                })
            }
            "insertone" | "insertmany" => {
                let docs: Vec<Bson> = if call.method == "insertone" {
                    let v = call
                        .args
                        .first()
                        .ok_or_else(|| perr("insertOne(doc) requires a document"))?;
                    vec![bson::to_bson(v).map_err(exec_err)?]
                } else {
                    match call.args.first() {
                        Some(Value::Array(a)) => a
                            .iter()
                            .map(|v| bson::to_bson(v).map_err(exec_err))
                            .collect::<Result<_, _>>()?,
                        _ => return Err(perr("insertMany([...]) requires an array of documents")),
                    }
                };
                let res = db
                    .run_command(doc! { "insert": &coll, "documents": docs })
                    .await
                    .map_err(exec_err)?;
                check_write_errors(&res)?;
                Ok(affected_outcome(res.get_i32("n").unwrap_or(0) as u64))
            }
            "updateone" | "updatemany" => {
                let filter = call.args.first().and_then(value_to_doc).unwrap_or_default();
                let update = call
                    .args
                    .get(1)
                    .and_then(value_to_doc)
                    .ok_or_else(|| perr("updateOne/Many(filter, update) requires two documents"))?;
                let multi = call.method == "updatemany";
                let res = db
                    .run_command(doc! {
                        "update": &coll,
                        "updates": [ doc! { "q": filter, "u": update, "multi": multi } ],
                    })
                    .await
                    .map_err(exec_err)?;
                check_write_errors(&res)?;
                Ok(affected_outcome(res.get_i32("nModified").unwrap_or(0) as u64))
            }
            "deleteone" | "deletemany" => {
                let filter = call.args.first().and_then(value_to_doc).unwrap_or_default();
                let limit = if call.method == "deleteone" { 1 } else { 0 };
                let res = db
                    .run_command(doc! {
                        "delete": &coll,
                        "deletes": [ doc! { "q": filter, "limit": limit } ],
                    })
                    .await
                    .map_err(exec_err)?;
                check_write_errors(&res)?;
                Ok(affected_outcome(res.get_i32("n").unwrap_or(0) as u64))
            }
            "drop" => {
                db.run_command(doc! { "drop": &coll }).await.map_err(exec_err)?;
                Ok(MongoOutcome { outcome: StatementOutcome::Ok, next_cursor: None, warnings: Vec::new() })
            }
            "createindex" => {
                let keys = call
                    .args
                    .first()
                    .and_then(value_to_doc)
                    .ok_or_else(|| perr("createIndex(keys) requires a keys document"))?;
                let mut idx = doc! { "key": keys.clone() };
                if let Some(opts) = call.args.get(1).and_then(value_to_doc) {
                    for (k, v) in opts {
                        idx.insert(k, v);
                    }
                }
                if !idx.contains_key("name") {
                    let name = keys
                        .iter()
                        .map(|(k, v)| format!("{k}_{}", v.as_i32().unwrap_or(1)))
                        .collect::<Vec<_>>()
                        .join("_");
                    idx.insert("name", if name.is_empty() { "idx".to_string() } else { name });
                }
                db.run_command(doc! { "createIndexes": &coll, "indexes": [idx] })
                    .await
                    .map_err(exec_err)?;
                Ok(MongoOutcome { outcome: StatementOutcome::Ok, next_cursor: None, warnings: Vec::new() })
            }
            other => Err(perr(format!(
                "unsupported MongoDB method `{other}` — try find / aggregate / countDocuments / distinct / insertOne / insertMany / updateOne / updateMany / deleteOne / deleteMany / createIndex / drop"
            ))),
        }
    }

    /// Databases on the server (`listDatabases`). `current` marks the connection's
    /// default database.
    pub async fn databases(&self) -> Result<Vec<DatabaseInfo>, QueryError> {
        let d = self
            .client
            .database("admin")
            .run_command(doc! { "listDatabases": 1 })
            .await
            .map_err(exec_err)?;
        let mut out = Vec::new();
        if let Ok(arr) = d.get_array("databases") {
            for b in arr {
                if let Bson::Document(doc) = b {
                    let name = doc.get_str("name").unwrap_or_default().to_string();
                    if name.is_empty() {
                        continue;
                    }
                    out.push(DatabaseInfo { current: name == self.database, name });
                }
            }
        }
        Ok(out)
    }

    /// Collections in a database (`listCollections`). `schema` is the database
    /// name; a MongoDB view is reported as `kind = "view"`.
    pub async fn collections(&self, database: &str) -> Result<Vec<TableInfo>, QueryError> {
        let d = self
            .client
            .database(database)
            .run_command(doc! { "listCollections": 1 })
            .await
            .map_err(exec_err)?;
        let mut out = Vec::new();
        if let Ok(batch) = d
            .get_document("cursor")
            .and_then(|c| c.get_array("firstBatch"))
        {
            for b in batch {
                if let Bson::Document(c) = b {
                    let name = c.get_str("name").unwrap_or_default().to_string();
                    if name.is_empty() {
                        continue;
                    }
                    let kind = if c.get_str("type").unwrap_or("collection") == "view" {
                        "view"
                    } else {
                        "table"
                    };
                    out.push(TableInfo {
                        schema: database.to_string(),
                        name,
                        kind: kind.to_string(),
                        row_estimate: None,
                        locked: false,
                        engine: None,
                        data_length: None,
                    });
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// Indexes on a collection (`listIndexes`). `_id_` is the implicit primary key.
    pub async fn indexes(
        &self,
        database: &str,
        collection: &str,
    ) -> Result<Vec<IndexInfo>, QueryError> {
        let d = self
            .client
            .database(database)
            .run_command(doc! { "listIndexes": collection })
            .await
            .map_err(exec_err)?;
        let mut out = Vec::new();
        if let Ok(batch) = d
            .get_document("cursor")
            .and_then(|c| c.get_array("firstBatch"))
        {
            for b in batch {
                if let Bson::Document(idx) = b {
                    let name = idx.get_str("name").unwrap_or_default().to_string();
                    let unique = idx.get_bool("unique").unwrap_or(false);
                    let mut columns = Vec::new();
                    // Default access method is a B-tree; a special index encodes its
                    // type as the key value ("text" / "2dsphere" / "hashed").
                    let mut method = "btree".to_string();
                    if let Ok(key) = idx.get_document("key") {
                        for (k, v) in key.iter() {
                            columns.push(k.clone());
                            if let Bson::String(s) = v {
                                method = s.clone();
                            }
                        }
                    }
                    let primary = name == "_id_";
                    out.push(IndexInfo { name, method, columns, unique, primary });
                }
            }
        }
        Ok(out)
    }

    /// Fields of a collection, inferred by sampling documents (union of top-level
    /// keys in first-seen order). MongoDB is schemaless, so this is best-effort.
    pub async fn collection_fields(
        &self,
        database: &str,
        collection: &str,
    ) -> Result<Vec<ColumnInfo>, QueryError> {
        const SAMPLE: i64 = 50;
        let d = self
            .client
            .database(database)
            .run_command(doc! { "find": collection, "limit": SAMPLE })
            .await
            .map_err(exec_err)?;
        let mut names: Vec<String> = Vec::new();
        let mut types: HashMap<String, String> = HashMap::new();
        if let Ok(batch) = d
            .get_document("cursor")
            .and_then(|c| c.get_array("firstBatch"))
        {
            for b in batch {
                if let Bson::Document(doc) = b {
                    for (k, v) in doc.iter() {
                        let tn = bson_type_name(v).to_string();
                        match types.get(k) {
                            None => {
                                names.push(k.clone());
                                types.insert(k.clone(), tn);
                            }
                            // Refine a previously-null field once a real value appears.
                            Some(prev) if prev == "null" && tn != "null" => {
                                types.insert(k.clone(), tn);
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        let mut out: Vec<ColumnInfo> = names
            .into_iter()
            .enumerate()
            .map(|(i, name)| {
                let is_pk = name == "_id";
                let data_type = types.remove(&name).unwrap_or_else(|| "mixed".into());
                ColumnInfo {
                    name,
                    data_type,
                    nullable: !is_pk,
                    default: None,
                    is_pk,
                    is_fk: false,
                    ordinal: i as i32,
                    auto_increment: false,
                }
            })
            .collect();
        // `_id` first, then first-seen order.
        out.sort_by_key(|c| if c.is_pk { 0 } else { 1 });
        Ok(out)
    }

    /// `.explain()` a read statement (find/aggregate/count/distinct) →
    /// raw explain JSON (parsed by `plan::parse_mongodb`). `actual` picks
    /// `executionStats` (runs the query) vs `queryPlanner` (plan only).
    pub async fn explain_mongo(&self, query: &str, actual: bool) -> Result<Value, QueryError> {
        let call = parse_mongo_query(query)?;
        let inner = match call.method.as_str() {
            "find" => {
                let mut c = doc! { "find": &call.collection };
                if let Some(f) = call.args.first().and_then(value_to_doc) {
                    c.insert("filter", f);
                }
                if let Some(s) = call.sort.as_ref().and_then(value_to_doc) {
                    c.insert("sort", s);
                }
                if let Some(l) = call.limit {
                    c.insert("limit", l);
                }
                if let Some(sk) = call.skip {
                    c.insert("skip", sk);
                }
                c
            }
            "aggregate" => {
                let arr = bson::to_bson(&call.args.first().cloned().unwrap_or(Value::Array(vec![])))
                    .ok()
                    .and_then(|b| b.as_array().cloned())
                    .unwrap_or_default();
                doc! { "aggregate": &call.collection, "pipeline": arr, "cursor": doc! {} }
            }
            "countdocuments" | "count" => {
                let f = call.args.first().and_then(value_to_doc).unwrap_or_default();
                doc! { "count": &call.collection, "query": f }
            }
            "distinct" => {
                let key = call.args.first().and_then(|v| v.as_str()).unwrap_or_default();
                let f = call.args.get(1).and_then(value_to_doc).unwrap_or_default();
                doc! { "distinct": &call.collection, "key": key, "query": f }
            }
            other => {
                return Err(perr(format!(
                    "explain supports read operations (find/aggregate/countDocuments/distinct), not {other}"
                )))
            }
        };
        let verbosity = if actual { "executionStats" } else { "queryPlanner" };
        let res = self
            .client
            .database(&self.database)
            .run_command(doc! { "explain": inner, "verbosity": verbosity })
            .await
            .map_err(exec_err)?;
        Ok(bson_to_json(&Bson::Document(res)))
    }

    /// Editable grid: insert/update/delete documents by `_id` (the change's `pk`).
    /// `schema` on each change selects the database. No OLTP transaction — changes
    /// are applied one command at a time (mirrors Cassandra's `apply_grid`).
    pub async fn apply_grid(&self, changes: &[grid::GridChange]) -> Result<u64, QueryError> {
        let mut applied = 0u64;
        for ch in changes {
            let dbname = |schema: &Option<String>| -> String {
                schema.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| self.database.clone())
            };
            match ch {
                grid::GridChange::Insert { schema, table, values } => {
                    let mut doc = Document::new();
                    for c in values {
                        doc.insert(c.name.clone(), json_to_bson(&c.value));
                    }
                    let res = self
                        .client
                        .database(&dbname(schema))
                        .run_command(doc! { "insert": table, "documents": [doc] })
                        .await
                        .map_err(exec_err)?;
                    check_write_errors(&res)?;
                    applied += res.get_i32("n").unwrap_or(0).max(0) as u64;
                }
                grid::GridChange::Update { schema, table, pk, set } => {
                    let mut filter = Document::new();
                    for c in pk {
                        filter.insert(c.name.clone(), json_to_bson(&c.value));
                    }
                    let mut set_doc = Document::new();
                    for c in set {
                        set_doc.insert(c.name.clone(), json_to_bson(&c.value));
                    }
                    let res = self
                        .client
                        .database(&dbname(schema))
                        .run_command(doc! {
                            "update": table,
                            "updates": [ doc! { "q": filter, "u": doc! { "$set": set_doc }, "multi": false } ],
                        })
                        .await
                        .map_err(exec_err)?;
                    check_write_errors(&res)?;
                    applied += res.get_i32("nModified").unwrap_or(0).max(0) as u64;
                }
                grid::GridChange::Delete { schema, table, pk } => {
                    let mut filter = Document::new();
                    for c in pk {
                        filter.insert(c.name.clone(), json_to_bson(&c.value));
                    }
                    let res = self
                        .client
                        .database(&dbname(schema))
                        .run_command(doc! {
                            "delete": table,
                            "deletes": [ doc! { "q": filter, "limit": 1 } ],
                        })
                        .await
                        .map_err(exec_err)?;
                    check_write_errors(&res)?;
                    applied += res.get_i32("n").unwrap_or(0).max(0) as u64;
                }
            }
        }
        Ok(applied)
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

    #[test]
    fn parse_find_with_filter_and_chain() {
        let c = parse_mongo_query("db.users.find({\"age\":{\"$gt\":18}}).sort({\"age\":-1}).skip(5).limit(10);")
            .unwrap();
        assert_eq!(c.collection, "users");
        assert_eq!(c.method, "find");
        assert_eq!(c.args.len(), 1);
        assert_eq!(c.args[0]["age"]["$gt"], 18);
        assert_eq!(c.skip, Some(5));
        assert_eq!(c.limit, Some(10));
        assert!(c.sort.is_some());
    }

    #[test]
    fn parse_find_no_args() {
        let c = parse_mongo_query("db.orders.find()").unwrap();
        assert_eq!(c.collection, "orders");
        assert_eq!(c.method, "find");
        assert!(c.args.is_empty());
    }

    #[test]
    fn parse_insert_and_update() {
        let ins = parse_mongo_query("db.c.insertOne({\"x\":1})").unwrap();
        assert_eq!(ins.method, "insertone");
        let upd = parse_mongo_query("db.c.updateMany({\"a\":1},{\"$set\":{\"b\":2}})").unwrap();
        assert_eq!(upd.method, "updatemany");
        assert_eq!(upd.args.len(), 2);
    }

    #[test]
    fn parse_rejects_non_db_prefix() {
        assert!(parse_mongo_query("users.find({})").is_err());
    }

    #[test]
    fn bson_to_json_extended_json() {
        use mongodb::bson::oid::ObjectId;
        let oid = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
        assert_eq!(
            bson_to_json(&Bson::ObjectId(oid)),
            json!({ "$oid": "507f1f77bcf86cd799439011" })
        );
        assert_eq!(bson_to_json(&Bson::Int32(7)), json!(7));
        assert_eq!(bson_to_json(&Bson::Null), Value::Null);
    }

    #[test]
    fn json_to_bson_recognises_extended_json_oid() {
        let v = json!({ "$oid": "507f1f77bcf86cd799439011" });
        match json_to_bson(&v) {
            Bson::ObjectId(o) => assert_eq!(o.to_hex(), "507f1f77bcf86cd799439011"),
            other => panic!("expected ObjectId, got {other:?}"),
        }
        // plain integer → Int64 (Mongo compares numeric types cross-width)
        assert!(matches!(json_to_bson(&json!(100)), Bson::Int64(100)));
    }

    #[test]
    fn mongo_change_preview_renders_mongosh() {
        use crate::drivers::grid::{Col, GridChange};
        let col = |n: &str, v: Value| Col { name: n.into(), value: v, col_type: None };
        let upd = GridChange::Update {
            schema: Some("appdb".into()),
            table: "users".into(),
            pk: vec![col("_id", json!(5))],
            set: vec![col("name", json!("Al"))],
        };
        assert_eq!(
            mongo_change_preview(&upd),
            "db.users.updateOne({\"_id\":5}, {\"$set\":{\"name\":\"Al\"}})"
        );
        let del = GridChange::Delete {
            schema: None,
            table: "users".into(),
            pk: vec![col("_id", json!(5))],
        };
        assert_eq!(mongo_change_preview(&del), "db.users.deleteOne({\"_id\":5})");
    }

    #[test]
    fn docs_to_result_unions_keys_and_types() {
        let docs = vec![
            Bson::Document(doc! { "_id": 1, "name": "Ann", "age": 30 }),
            Bson::Document(doc! { "_id": 2, "name": "Bob", "email": "b@x.com" }),
        ];
        let rs = docs_to_result(&docs);
        let names: Vec<&str> = rs.cols.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["_id", "name", "age", "email"]);
        assert_eq!(rs.total, 2);
        // _id typed as int from the first document.
        assert_eq!(rs.cols[0].1, "int");
    }
}
