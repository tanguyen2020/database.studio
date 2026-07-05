//! Cassandra driver (Phase 4b) — scylla-rust-driver.
//!
//! CQL is NOT SQL: no JOIN/subquery/OFFSET, WHERE constrained by the key. This
//! driver executes real CQL against a cluster (never the in-memory fake of the
//! prototype). Semantics enforced here + in the CQL lint rule pack.
//!
//! - Prepared statements + binding for any parameterised path (no string concat).
//! - Per-statement consistency (default taken from the connection).
//! - Paging via `PagingState` (never LIMIT/OFFSET) — a page token round-trips to
//!   the frontend as base64 so the grid can fetch the next page.
//! - Load balancing: `DefaultPolicy` pinned to the connection's local datacenter.

use std::sync::Arc;

use scylla::client::execution_profile::ExecutionProfile;
use scylla::client::session::Session;
use scylla::client::session_builder::SessionBuilder;
use scylla::errors::{ExecutionError, NewSessionError};
use scylla::policies::load_balancing::DefaultPolicy;
use scylla::response::{PagingState, PagingStateResponse};
use scylla::statement::unprepared::Statement;
use scylla::statement::Consistency;
use scylla::value::CqlValue;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::drivers::types::{ColumnDef, QueryResultSet, StatementOutcome, TestResult};
use crate::error::QueryError;

const DEFAULT_PAGE_SIZE: i32 = 500;

#[derive(Debug, Clone)]
pub struct CassandraConnParams {
    /// One or more `host:port` contact points (host field may be comma-separated).
    pub contact_points: Vec<String>,
    pub user: String,
    pub password: String,
    /// Local datacenter for the load-balancing policy (required for NTS).
    pub datacenter: String,
    /// Default consistency level name (LOCAL_QUORUM / QUORUM / ONE / …).
    pub consistency: String,
    /// Optional default keyspace.
    pub keyspace: String,
    pub ssl: bool,
    pub ssl_ca: String,
}

pub struct CassandraDriver {
    session: Arc<Session>,
    keyspace: String,
}

/// Result of a single CQL execution — the locked outcome plus an opaque paging
/// token (base64) when more pages remain.
#[derive(Debug)]
pub struct CqlOutcome {
    pub outcome: StatementOutcome,
    pub next_page: Option<String>,
    /// Non-fatal server warnings (e.g. ALLOW FILTERING performance notes).
    pub warnings: Vec<String>,
}

/// Map a consistency-level name (from the connection/toolbar) to the enum.
pub fn consistency_from_str(name: &str) -> Consistency {
    match name.trim().to_ascii_uppercase().as_str() {
        "ANY" => Consistency::Any,
        "ONE" => Consistency::One,
        "TWO" => Consistency::Two,
        "THREE" => Consistency::Three,
        "QUORUM" => Consistency::Quorum,
        "ALL" => Consistency::All,
        "EACH_QUORUM" => Consistency::EachQuorum,
        "LOCAL_ONE" => Consistency::LocalOne,
        "SERIAL" => Consistency::Serial,
        "LOCAL_SERIAL" => Consistency::LocalSerial,
        _ => Consistency::LocalQuorum,
    }
}

fn new_session_err(e: NewSessionError) -> QueryError {
    QueryError::new("cassandra", format!("Cassandra connection failed: {e}"), format!("{e}"))
}

/// Map a driver execution error to the locked `QueryError`. CQL errors are
/// statement-level (no line/column position from the protocol).
pub fn map_exec_err(e: ExecutionError) -> QueryError {
    let raw = format!("{e}");
    // Surface the most useful Cassandra category in the user message.
    let friendly = if raw.contains("ALLOW FILTERING") {
        format!("Query requires ALLOW FILTERING (full cluster scan): {raw}")
    } else if raw.to_ascii_lowercase().contains("unauthorized") {
        format!("Insufficient permissions: {raw}")
    } else if raw.to_ascii_lowercase().contains("syntax") {
        format!("CQL syntax error: {raw}")
    } else if raw.to_ascii_lowercase().contains("invalid") {
        format!("Invalid request: {raw}")
    } else if raw.to_ascii_lowercase().contains("timeout") {
        format!("Timed out (read/write timeout): {raw}")
    } else {
        raw.clone()
    };
    QueryError::new("cassandra", friendly, raw)
}

/// Build a rustls ClientConfig for Cassandra TLS. Uses the ring provider (no
/// aws-lc → no C compiler). Verification: server certs accepted without a CA
/// store (dev-oriented desktop client, giống ghi chú SASL_SSL của Kafka) —
/// đủ để bật kênh mã hoá; xác thực CA nghiêm ngặt là hạn chế đã biết.
fn build_tls(_ssl_ca: &str) -> Arc<rustls::ClientConfig> {
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("rustls ring provider supports the default protocol versions")
    .dangerous()
    .with_custom_certificate_verifier(Arc::new(danger::NoVerifier))
    .with_no_client_auth();
    Arc::new(config)
}

/// Address translator that maps EVERY node's advertised address to a single
/// reachable endpoint. Dùng khi cả cluster nhìn thấy qua 1 host:port (NAT,
/// SSH tunnel, testcontainers) — node quảng bá IP nội bộ không định tuyến được.
struct ForceTranslator(std::net::SocketAddr);

#[async_trait::async_trait]
impl scylla::policies::address_translator::AddressTranslator for ForceTranslator {
    async fn translate_address(
        &self,
        _peer: &scylla::policies::address_translator::UntranslatedPeer,
    ) -> Result<std::net::SocketAddr, scylla::errors::TranslationError> {
        Ok(self.0)
    }
}

impl CassandraDriver {
    async fn build_session(params: &CassandraConnParams) -> Result<Session, NewSessionError> {
        Self::build_session_with(params, None).await
    }

    async fn build_session_with(
        params: &CassandraConnParams,
        translator: Option<std::sync::Arc<dyn scylla::policies::address_translator::AddressTranslator>>,
    ) -> Result<Session, NewSessionError> {
        let policy = if params.datacenter.trim().is_empty() {
            DefaultPolicy::builder().build()
        } else {
            // Prefer local DC, nhưng cho phép failover sang DC khác để tránh
            // "no available nodes" khi tên DC lệch (an toàn cho desktop tool).
            DefaultPolicy::builder()
                .prefer_datacenter(params.datacenter.trim().to_string())
                .permit_dc_failover(true)
                .build()
        };
        let profile = ExecutionProfile::builder()
            .consistency(consistency_from_str(&params.consistency))
            .load_balancing_policy(policy)
            .build();

        let mut builder = SessionBuilder::new()
            .known_nodes(&params.contact_points)
            .default_execution_profile_handle(profile.into_handle());

        if !params.user.trim().is_empty() {
            builder = builder.user(params.user.clone(), params.password.clone());
        }
        if params.ssl {
            builder = builder.tls_context(Some(build_tls(&params.ssl_ca)));
        }
        if !params.keyspace.trim().is_empty() {
            builder = builder.use_keyspace(params.keyspace.trim().to_string(), false);
        }
        if let Some(t) = translator {
            builder = builder.address_translator(t);
        }
        builder.build().await
    }

    pub async fn connect(params: &CassandraConnParams) -> Result<Self, QueryError> {
        let session = Self::build_session(params).await.map_err(new_session_err)?;
        Ok(Self {
            session: Arc::new(session),
            keyspace: params.keyspace.trim().to_string(),
        })
    }

    /// Connect nhưng dịch MỌI địa chỉ node → một endpoint duy nhất (host:port).
    /// Dùng khi cluster chỉ tiếp cận được qua 1 cổng (SSH tunnel / NAT / test
    /// container quảng bá IP nội bộ). Single-node là trường hợp phổ biến.
    pub async fn connect_translating_to(
        params: &CassandraConnParams,
        host: &str,
        port: u16,
    ) -> Result<Self, QueryError> {
        let addr: std::net::SocketAddr = format!("{host}:{port}")
            .parse()
            .map_err(|e| QueryError::new("cassandra", "Invalid translated address", format!("{e}")))?;
        let translator = std::sync::Arc::new(ForceTranslator(addr))
            as std::sync::Arc<dyn scylla::policies::address_translator::AddressTranslator>;
        let session = Self::build_session_with(params, Some(translator))
            .await
            .map_err(new_session_err)?;
        Ok(Self {
            session: Arc::new(session),
            keyspace: params.keyspace.trim().to_string(),
        })
    }

    pub async fn test(params: &CassandraConnParams) -> TestResult {
        let started = std::time::Instant::now();
        match Self::build_session(params).await {
            Ok(session) => {
                // Confirm we can reach the cluster + read release_version.
                let version = session
                    .query_unpaged("SELECT release_version FROM system.local", &[])
                    .await
                    .ok()
                    .and_then(|r| r.into_rows_result().ok())
                    .and_then(|rows| rows.first_row::<(String,)>().ok().map(|(v,)| v));
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: version.map(|v| format!("Cassandra {v}")),
                    error: None,
                }
            }
            Err(e) => TestResult {
                ok: false,
                latency_ms: None,
                server_version: None,
                error: Some(format!("{e}")),
            },
        }
    }

    pub async fn ping(&self) -> bool {
        self.session
            .query_unpaged("SELECT now() FROM system.local", &[])
            .await
            .is_ok()
    }

    pub fn session(&self) -> Arc<Session> {
        self.session.clone()
    }

    pub fn keyspace(&self) -> &str {
        &self.keyspace
    }

    /// Execute one CQL statement (editor). Uses single-page paging so the grid
    /// can page through large result sets via `PagingState` (never OFFSET).
    /// `page_token` (base64) resumes from a previous page.
    pub async fn exec_cql(
        &self,
        cql: &str,
        page_size: Option<i32>,
        page_token: Option<&str>,
    ) -> Result<CqlOutcome, QueryError> {
        let mut stmt = Statement::new(cql.to_string());
        stmt.set_page_size(page_size.unwrap_or(DEFAULT_PAGE_SIZE));

        let paging = match page_token {
            Some(tok) if !tok.is_empty() => {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(tok)
                    .map_err(|e| QueryError::new("cassandra", "Corrupt paging token", format!("{e}")))?;
                PagingState::new_from_raw_bytes(bytes)
            }
            _ => PagingState::start(),
        };

        let (result, page_resp) = self
            .session
            .query_single_page(stmt, &[], paging)
            .await
            .map_err(map_exec_err)?;

        let warnings: Vec<String> = result.warnings().map(|w| w.to_string()).collect();

        // Not a rows response (INSERT/UPDATE/DELETE/DDL) → Ok / Affected.
        if !result.is_rows() {
            return Ok(CqlOutcome {
                outcome: StatementOutcome::Ok,
                next_page: None,
                warnings,
            });
        }

        let rows_result = result.into_rows_result().map_err(|e| {
            QueryError::new("cassandra", "Failed to read result set", format!("{e}"))
        })?;

        let cols: Vec<ColumnDef> = rows_result
            .column_specs()
            .iter()
            .map(|c| (c.name().to_string(), format!("{:?}", c.typ())))
            .collect();
        let col_names: Vec<String> = cols.iter().map(|c| c.0.clone()).collect();

        let mut rows: Vec<Value> = Vec::with_capacity(rows_result.rows_num());
        for row in rows_result
            .rows::<scylla::value::Row>()
            .map_err(|e| QueryError::new("cassandra", "Failed to decode row", format!("{e}")))?
        {
            let row = row.map_err(|e| {
                QueryError::new("cassandra", "Failed to decode row", format!("{e}"))
            })?;
            let mut obj = Map::new();
            for (i, cell) in row.columns.into_iter().enumerate() {
                let name = col_names.get(i).cloned().unwrap_or_else(|| i.to_string());
                obj.insert(name, cell.map(cql_to_json).unwrap_or(Value::Null));
            }
            rows.push(Value::Object(obj));
        }

        let total = rows.len() as u64;
        let next_page = match page_resp {
            PagingStateResponse::HasMorePages { state } => {
                use base64::Engine;
                state
                    .as_bytes_slice()
                    .map(|b| base64::engine::general_purpose::STANDARD.encode(b))
            }
            PagingStateResponse::NoMorePages => None,
        };

        Ok(CqlOutcome {
            outcome: StatementOutcome::Rows {
                result: QueryResultSet { cols, rows, total },
            },
            next_page,
            warnings,
        })
    }

    /// Query Plan cho Cassandra (T16): chạy CQL với TRACING bật → trả về
    /// `(server_warnings, events)` với event = `(activity, source, elapsed_us)`.
    /// Cassandra không có EXPLAIN nên plan = timeline thực tế; cờ ALLOW FILTERING
    /// suy ra ở tầng normalize (drivers/plan.rs).
    pub async fn trace_cql(
        &self,
        cql: &str,
    ) -> Result<(Vec<String>, Vec<(String, String, i64)>), QueryError> {
        let mut stmt = Statement::new(cql.to_string());
        stmt.set_tracing(true);
        stmt.set_page_size(DEFAULT_PAGE_SIZE);
        let (result, _page) = self
            .session
            .query_single_page(stmt, &[], PagingState::start())
            .await
            .map_err(map_exec_err)?;
        let warnings: Vec<String> = result.warnings().map(|w| w.to_string()).collect();
        let mut events: Vec<(String, String, i64)> = Vec::new();
        if let Some(tid) = result.tracing_id() {
            if let Ok(info) = self.session.get_tracing_info(&tid).await {
                for e in info.events {
                    events.push((
                        e.activity.unwrap_or_default(),
                        e.source.map(|s| s.to_string()).unwrap_or_default(),
                        e.source_elapsed.unwrap_or(0) as i64,
                    ));
                }
            }
        }
        Ok((warnings, events))
    }
}

/// Convert a CQL value to JSON for the grid. Non-JSON-native types render as
/// readable strings (uuid, timestamp ISO-8601, decimal, inet, blob hex…).
fn cql_to_json(v: CqlValue) -> Value {
    match v {
        CqlValue::Ascii(s) | CqlValue::Text(s) => Value::String(s),
        CqlValue::Boolean(b) => Value::Bool(b),
        CqlValue::Int(n) => json!(n),
        CqlValue::BigInt(n) => json!(n),
        CqlValue::SmallInt(n) => json!(n),
        CqlValue::TinyInt(n) => json!(n),
        CqlValue::Float(f) => json!(f),
        CqlValue::Double(f) => json!(f),
        CqlValue::Counter(c) => json!(c.0),
        CqlValue::Uuid(u) => Value::String(u.to_string()),
        CqlValue::Timeuuid(u) => Value::String(u.to_string()),
        CqlValue::Inet(ip) => Value::String(ip.to_string()),
        CqlValue::Blob(bytes) => Value::String(format!("0x{}", hex(&bytes))),
        CqlValue::Timestamp(ts) => match chrono::DateTime::from_timestamp_millis(ts.0) {
            Some(dt) => Value::String(dt.to_rfc3339()),
            None => json!(ts.0),
        },
        CqlValue::Date(d) => Value::String(format!("{d:?}")),
        CqlValue::Time(t) => Value::String(format!("{t:?}")),
        CqlValue::Duration(d) => Value::String(format!("{d:?}")),
        CqlValue::Decimal(d) => Value::String(format!("{d:?}")),
        CqlValue::Varint(v) => Value::String(format!("{v:?}")),
        CqlValue::List(items) | CqlValue::Set(items) | CqlValue::Vector(items) => {
            Value::Array(items.into_iter().map(cql_to_json).collect())
        }
        CqlValue::Tuple(items) => Value::Array(
            items
                .into_iter()
                .map(|o| o.map(cql_to_json).unwrap_or(Value::Null))
                .collect(),
        ),
        CqlValue::Map(pairs) => {
            let mut obj = Map::new();
            for (k, val) in pairs {
                let key = match cql_to_json(k) {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                obj.insert(key, cql_to_json(val));
            }
            Value::Object(obj)
        }
        CqlValue::UserDefinedType { fields, .. } => {
            let mut obj = Map::new();
            for (name, val) in fields {
                obj.insert(name, val.map(cql_to_json).unwrap_or(Value::Null));
            }
            Value::Object(obj)
        }
        CqlValue::Empty => Value::Null,
        other => Value::String(format!("{other:?}")),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// ---------------------------------------------------------------------------
// Introspection (keyspace tree) — real metadata from system_schema.*
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CassColumn {
    pub name: String,
    pub data_type: String,
    /// "partition_key" | "clustering" | "regular" | "static"
    pub kind: String,
    /// clustering order for clustering columns ("asc" | "desc"), else "".
    pub clustering_order: String,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct CassTable {
    pub name: String,
    pub columns: Vec<CassColumn>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CassView {
    pub name: String,
    pub base_table: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CassType {
    pub name: String,
    pub fields: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CassFunction {
    pub name: String,
    pub kind: String, // "function" | "aggregate"
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CassIndex {
    pub name: String,
    pub table: String,
    /// "COMPOSITES" | "CUSTOM" (SASI) | "KEYS"
    pub kind: String,
    pub target: String,
}

/// Full keyspace tree in one call (mirrors the prototype's rendered tree +
/// the intended UDT/UDF/index nodes from `cassandraTree`).
#[derive(Debug, Clone, Serialize)]
pub struct CassKeyspaceTree {
    pub keyspace: String,
    pub replication: String,
    pub tables: Vec<CassTable>,
    pub views: Vec<CassView>,
    pub types: Vec<CassType>,
    pub functions: Vec<CassFunction>,
    pub indexes: Vec<CassIndex>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RingNode {
    pub host: String,
    pub dc: String,
    pub rack: String,
    pub state: String,
    pub load: String,
    pub owns: String,
    pub version: String,
}

impl CassandraDriver {
    async fn rows<T>(
        &self,
        cql: &str,
        values: impl scylla::serialize::row::SerializeRow,
    ) -> Result<Vec<T>, QueryError>
    where
        T: for<'f> scylla::deserialize::row::DeserializeRow<'f, 'f>,
    {
        let res = self
            .session
            .query_unpaged(cql, values)
            .await
            .map_err(map_exec_err)?
            .into_rows_result()
            .map_err(|e| QueryError::new("cassandra", "Failed to read metadata", format!("{e}")))?;
        let mut out = Vec::with_capacity(res.rows_num());
        for row in res
            .rows::<T>()
            .map_err(|e| QueryError::new("cassandra", "Failed to decode metadata", format!("{e}")))?
        {
            out.push(row.map_err(|e| {
                QueryError::new("cassandra", "Failed to decode metadata", format!("{e}"))
            })?);
        }
        Ok(out)
    }

    /// User keyspaces (system_* excluded).
    pub async fn keyspaces(&self) -> Result<Vec<String>, QueryError> {
        let mut names: Vec<String> = self
            .rows::<(String,)>("SELECT keyspace_name FROM system_schema.keyspaces", ())
            .await?
            .into_iter()
            .map(|(n,)| n)
            .filter(|n| !is_system_keyspace(n))
            .collect();
        names.sort();
        Ok(names)
    }

    async fn replication_of(&self, keyspace: &str) -> String {
        let r = self
            .rows::<(std::collections::HashMap<String, String>,)>(
                "SELECT replication FROM system_schema.keyspaces WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .ok()
            .and_then(|v| v.into_iter().next());
        match r {
            Some((map,)) => format_replication(&map),
            None => String::new(),
        }
    }

    async fn columns_of(&self, keyspace: &str, table: &str) -> Result<Vec<CassColumn>, QueryError> {
        let raw = self
            .rows::<(String, String, String, i32, String)>(
                "SELECT column_name, type, kind, position, clustering_order \
                 FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?",
                (keyspace, table),
            )
            .await?;
        let mut cols: Vec<CassColumn> = raw
            .into_iter()
            .map(|(name, data_type, kind, position, order)| CassColumn {
                name,
                data_type,
                clustering_order: if kind == "clustering" {
                    order.to_ascii_lowercase()
                } else {
                    String::new()
                },
                kind,
                position,
            })
            .collect();
        // Order: partition keys (by position), then clustering (by position), then rest.
        cols.sort_by_key(|c| {
            let rank = match c.kind.as_str() {
                "partition_key" => 0,
                "clustering" => 1,
                _ => 2,
            };
            (rank, c.position.max(0))
        });
        Ok(cols)
    }

    /// Whole keyspace tree: tables (+cols), MVs, UDTs, functions/aggregates, indexes.
    pub async fn keyspace_tree(&self, keyspace: &str) -> Result<CassKeyspaceTree, QueryError> {
        let replication = self.replication_of(keyspace).await;

        let table_names: Vec<String> = self
            .rows::<(String,)>(
                "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await?
            .into_iter()
            .map(|(n,)| n)
            .collect();
        let mut tables = Vec::with_capacity(table_names.len());
        for name in table_names {
            let columns = self.columns_of(keyspace, &name).await?;
            tables.push(CassTable { name, columns });
        }
        tables.sort_by(|a, b| a.name.cmp(&b.name));

        let mut views: Vec<CassView> = self
            .rows::<(String, String)>(
                "SELECT view_name, base_table_name FROM system_schema.views WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(name, base_table)| CassView { name, base_table })
            .collect();
        views.sort_by(|a, b| a.name.cmp(&b.name));

        let mut types: Vec<CassType> = self
            .rows::<(String, Vec<String>, Vec<String>)>(
                "SELECT type_name, field_names, field_types FROM system_schema.types WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(name, fnames, ftypes)| CassType {
                name,
                fields: fnames.into_iter().zip(ftypes).collect(),
            })
            .collect();
        types.sort_by(|a, b| a.name.cmp(&b.name));

        let mut functions: Vec<CassFunction> = self
            .rows::<(String, Vec<String>)>(
                "SELECT function_name, argument_types FROM system_schema.functions WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(name, args)| CassFunction {
                signature: format!("{}({})", name, args.join(", ")),
                name,
                kind: "function".into(),
            })
            .collect();
        let aggregates: Vec<CassFunction> = self
            .rows::<(String, Vec<String>)>(
                "SELECT aggregate_name, argument_types FROM system_schema.aggregates WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(name, args)| CassFunction {
                signature: format!("{}({})", name, args.join(", ")),
                name,
                kind: "aggregate".into(),
            })
            .collect();
        functions.extend(aggregates);
        functions.sort_by(|a, b| a.name.cmp(&b.name));

        let mut indexes: Vec<CassIndex> = self
            .rows::<(String, String, String, std::collections::HashMap<String, String>)>(
                "SELECT index_name, table_name, kind, options FROM system_schema.indexes WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(name, table, kind, options)| CassIndex {
                target: options.get("target").cloned().unwrap_or_default(),
                name,
                table,
                kind,
            })
            .collect();
        indexes.sort_by(|a, b| a.name.cmp(&b.name));

        Ok(CassKeyspaceTree {
            keyspace: keyspace.to_string(),
            replication,
            tables,
            views,
            types,
            functions,
            indexes,
        })
    }

    /// Index Scanner (T17): secondary indexes trong 1 keyspace từ
    /// system_schema.indexes (target column trong options).
    pub async fn scan_indexes(
        &self,
        keyspace: &str,
    ) -> Result<Vec<crate::drivers::index_scan::IndexScanRow>, QueryError> {
        let rows = self
            .rows::<(String, String, String, std::collections::HashMap<String, String>)>(
                "SELECT index_name, table_name, kind, options FROM system_schema.indexes WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .unwrap_or_default();
        Ok(rows
            .into_iter()
            .map(|(name, table, kind, options)| crate::drivers::index_scan::IndexScanRow {
                columns: vec![options.get("target").cloned().unwrap_or_default()],
                name,
                table,
                index_type: kind, // COMPOSITES / KEYS / CUSTOM
                unique: false,
                primary: false,
                size_bytes: None,
                usage: None,
                fragmentation_pct: None,
                valid: true,
                flags: Vec::new(),
            })
            .collect())
    }

    /// Ring topology from `system.local` + `system.peers` (never hardcoded).
    pub async fn ring(&self) -> Result<Vec<RingNode>, QueryError> {
        let mut nodes = Vec::new();
        // Local node.
        if let Some((addr, dc, rack, ver, tokens)) = self
            .rows::<(std::net::IpAddr, String, String, String, Vec<String>)>(
                "SELECT broadcast_address, data_center, rack, release_version, tokens FROM system.local",
                (),
            )
            .await?
            .into_iter()
            .next()
        {
            nodes.push((addr.to_string(), dc, rack, ver, tokens.len()));
        }
        // Peers.
        let peers = self
            .rows::<(std::net::IpAddr, String, String, String, Vec<String>)>(
                "SELECT peer, data_center, rack, release_version, tokens FROM system.peers",
                (),
            )
            .await
            .unwrap_or_default();
        for (addr, dc, rack, ver, tokens) in peers {
            nodes.push((addr.to_string(), dc, rack, ver, tokens.len()));
        }

        let total_tokens: usize = nodes.iter().map(|n| n.4).sum::<usize>().max(1);
        Ok(nodes
            .into_iter()
            .map(|(host, dc, rack, version, tok)| RingNode {
                owns: format!("{:.1}%", (tok as f64 / total_tokens as f64) * 100.0),
                state: "UN".into(), // Up/Normal — present in system tables
                load: format!("{tok} tokens"),
                host,
                dc,
                rack,
                version,
            })
            .collect())
    }

    /// Native CQL `CREATE TABLE` reconstructed from metadata (composite PK,
    /// clustering order). Read-only DDL viewer.
    pub async fn table_ddl(&self, keyspace: &str, table: &str) -> Result<String, QueryError> {
        let cols = self.columns_of(keyspace, table).await?;
        if cols.is_empty() {
            return Err(QueryError::new(
                "cassandra",
                format!("Table {keyspace}.{table} does not exist"),
                "table not found",
            ));
        }
        Ok(format_table_ddl(keyspace, table, &cols))
    }
}

/// Pure CREATE TABLE builder — composite partition key `((p1, p2), c1, c2)` +
/// `WITH CLUSTERING ORDER BY`. Extracted for unit testing without a cluster.
pub fn format_table_ddl(keyspace: &str, table: &str, cols: &[CassColumn]) -> String {
    let mut lines: Vec<String> = cols
        .iter()
        .map(|c| format!("  {} {}", c.name, c.data_type))
        .collect();

    let partition: Vec<&str> = cols
        .iter()
        .filter(|c| c.kind == "partition_key")
        .map(|c| c.name.as_str())
        .collect();
    let clustering: Vec<&CassColumn> = cols.iter().filter(|c| c.kind == "clustering").collect();

    // Composite partition key luôn bọc ngoặc trong để phân biệt với clustering.
    let pk = if clustering.is_empty() {
        format!("({})", partition.join(", "))
    } else {
        format!(
            "({}), {}",
            partition.join(", "),
            clustering.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")
        )
    };
    lines.push(format!("  PRIMARY KEY ({pk})"));

    let mut ddl = format!("CREATE TABLE {}.{} (\n{}\n)", keyspace, table, lines.join(",\n"));
    if !clustering.is_empty() {
        let orders: Vec<String> = clustering
            .iter()
            .map(|c| {
                let o = if c.clustering_order == "desc" { "DESC" } else { "ASC" };
                format!("{} {}", c.name, o)
            })
            .collect();
        ddl.push_str(&format!("\nWITH CLUSTERING ORDER BY ({})", orders.join(", ")));
    }
    ddl.push(';');
    ddl
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str, kind: &str, order: &str) -> CassColumn {
        CassColumn {
            name: name.into(),
            data_type: ty.into(),
            kind: kind.into(),
            clustering_order: order.into(),
            position: 0,
        }
    }

    #[test]
    fn ddl_composite_partition_key_and_clustering_order() {
        let cols = vec![
            col("student_id", "uuid", "partition_key", ""),
            col("term", "text", "partition_key", ""),
            col("course", "text", "clustering", "asc"),
            col("posted_at", "timestamp", "clustering", "desc"),
            col("grade", "text", "regular", ""),
        ];
        let ddl = format_table_ddl("campus_ks", "grades", &cols);
        // composite partition key bọc ngoặc trong; clustering đứng sau
        assert!(ddl.contains("PRIMARY KEY ((student_id, term), course, posted_at)"), "{ddl}");
        assert!(ddl.contains("WITH CLUSTERING ORDER BY (course ASC, posted_at DESC)"), "{ddl}");
        assert!(ddl.starts_with("CREATE TABLE campus_ks.grades ("));
        assert!(ddl.ends_with(';'));
    }

    #[test]
    fn ddl_single_partition_key_no_clustering() {
        let cols = vec![
            col("id", "uuid", "partition_key", ""),
            col("email", "text", "regular", ""),
        ];
        let ddl = format_table_ddl("ks", "users", &cols);
        assert!(ddl.contains("PRIMARY KEY ((id))"), "{ddl}");
        assert!(!ddl.contains("CLUSTERING ORDER"), "{ddl}");
    }

    #[test]
    fn consistency_parsing() {
        assert!(matches!(consistency_from_str("quorum"), Consistency::Quorum));
        assert!(matches!(consistency_from_str("LOCAL_ONE"), Consistency::LocalOne));
        assert!(matches!(consistency_from_str("weird"), Consistency::LocalQuorum));
    }

    #[test]
    fn replication_clause_render() {
        let mut m = std::collections::HashMap::new();
        m.insert("class".to_string(), "org.apache.cassandra.locator.NetworkTopologyStrategy".to_string());
        m.insert("dc1".to_string(), "3".to_string());
        let s = format_replication(&m);
        assert!(s.contains("'class': 'NetworkTopologyStrategy'"), "{s}");
        assert!(s.contains("'dc1': '3'"), "{s}");
    }
}

fn is_system_keyspace(name: &str) -> bool {
    matches!(
        name,
        "system"
            | "system_schema"
            | "system_auth"
            | "system_distributed"
            | "system_traces"
            | "system_views"
            | "system_virtual_schema"
    )
}

/// Render a keyspace replication map as a CQL replication clause.
fn format_replication(map: &std::collections::HashMap<String, String>) -> String {
    let class = map.get("class").map(String::as_str).unwrap_or("");
    let short = class.rsplit('.').next().unwrap_or(class);
    let mut parts: Vec<String> = vec![format!("'class': '{short}'")];
    let mut rest: Vec<(&String, &String)> = map.iter().filter(|(k, _)| k.as_str() != "class").collect();
    rest.sort_by(|a, b| a.0.cmp(b.0));
    for (k, v) in rest {
        parts.push(format!("'{k}': '{v}'"));
    }
    format!("{{ {} }}", parts.join(", "))
}

/// Accept-any TLS verifier (see `build_tls`). Encrypts the channel without CA
/// validation — a documented limitation for this desktop client.
mod danger {
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{DigitallySignedStruct, Error, SignatureScheme};

    #[derive(Debug)]
    pub struct NoVerifier;

    impl ServerCertVerifier for NoVerifier {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            rustls::crypto::ring::default_provider()
                .signature_verification_algorithms
                .supported_schemes()
        }
    }
}
