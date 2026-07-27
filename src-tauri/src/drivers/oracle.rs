//! Oracle driver — `oracle` crate (ODPI-C/OCI). The crate is BLOCKING and its
//! `Connection` is `!Send`, so each connection owns a dedicated OS thread (an
//! "actor") that holds the real Connection; async methods send commands over an
//! mpsc channel and await a oneshot reply. That keeps `LiveConnection: Send` (the
//! registry stores it behind a tokio Mutex + spawns tasks) with no OCI handle
//! ever crossing a thread. Needs Oracle Instant Client at runtime.
//!
//! Pivoted from `oracle-rs` (pure Rust) which truncated result sets at ~100 rows.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::time::Instant;

use oracle::sql_type::ToSql;
use oracle::Connection;
use serde_json::{Map, Value as Json};
use tokio::sync::oneshot;

use crate::drivers::grid::GridChange;
use crate::drivers::index_scan::IndexScanRow;
use crate::drivers::types::*;
use crate::error::QueryError;

/// Point ODPI-C at a specific Oracle Client (Instant Client) directory so the
/// bundled client is used instead of requiring a system-wide install. This calls
/// `dpiContext_createWithParams`, which loads `oci.dll` / `libclntsh.*` from `dir`
/// immediately, so the caller MUST verify `dir` actually contains the OCI library
/// first (`instant_client_lib` below) — otherwise init fails outright even when a
/// system client is present. Must run before the first connection; a no-op if the
/// client was already initialized. Failures are logged, not fatal (the driver then
/// falls back to ODPI-C's default library search on first connect).
pub fn init_client_dir(dir: &std::path::Path) {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        if oracle::InitParams::is_initialized() {
            return;
        }
        let mut params = oracle::InitParams::new();
        match params.oracle_client_lib_dir(dir) {
            Ok(_) => match params.init() {
                Ok(_) => {}
                Err(e) => eprintln!(
                    "[oracle] init with bundled Instant Client '{}' failed: {e}",
                    dir.display()
                ),
            },
            Err(e) => eprintln!("[oracle] invalid Instant Client dir '{}': {e}", dir.display()),
        }
    });
}

/// If `dir` (or a single `instantclient*` sub-directory of it) contains the
/// platform OCI library, return the directory that holds it. Used to decide
/// whether to bind ODPI-C to the bundled client. `None` = no bundled client
/// present (leave ODPI-C on its default system search).
pub fn instant_client_lib(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    fn has_oci(d: &std::path::Path) -> bool {
        let Ok(entries) = std::fs::read_dir(d) else {
            return false;
        };
        for e in entries.flatten() {
            let name = e.file_name();
            let n = name.to_string_lossy().to_ascii_lowercase();
            // Windows: oci.dll · Linux: libclntsh.so[.x] · macOS: libclntsh.dylib
            if n == "oci.dll" || n.starts_with("libclntsh.so") || n == "libclntsh.dylib" {
                return true;
            }
        }
        false
    }
    if has_oci(dir) {
        return Some(dir.to_path_buf());
    }
    // Tolerate an un-flattened extract: resources/instantclient/instantclient_23_8/…
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.to_ascii_lowercase().starts_with("instantclient"))
                    .unwrap_or(false)
                && has_oci(&p)
            {
                return Some(p);
            }
        }
    }
    None
}

/// Connect params mapped from a `ConnectionProfile` (built in drivers/mod.rs).
#[derive(Clone)]
pub struct OracleConnParams {
    pub host: String,
    pub port: u16,
    /// Service name (default) OR SID, selected by `use_sid`.
    pub service: String,
    pub use_sid: bool,
    pub user: String,
    pub password: String,
    pub ssl: bool,
    #[allow(dead_code)]
    pub ssl_ca: String,
}

/// Commands sent to the connection's actor thread. Each carries a oneshot reply.
enum Cmd {
    Exec(String, oneshot::Sender<Result<StatementOutcome, QueryError>>),
    ExecParams(String, Vec<Json>, oneshot::Sender<Result<StatementOutcome, QueryError>>),
    Query(String, oneshot::Sender<Result<QueryResultSet, QueryError>>),
    Apply(Vec<GridChange>, oneshot::Sender<Result<u64, QueryError>>),
    Ping(oneshot::Sender<bool>),
}

pub struct OracleDriver {
    tx: mpsc::Sender<Cmd>,
    /// The connected user = default schema in Oracle (UPPERCASE).
    #[allow(dead_code)]
    default_schema: String,
}

fn map_error(e: &oracle::Error) -> QueryError {
    let raw = e.to_string();
    let code = raw
        .split_whitespace()
        .find(|t| t.starts_with("ORA-"))
        .map(|t| t.trim_end_matches([':', ',']).to_string());
    let mut qe = QueryError::new("oracle", raw.clone(), raw);
    qe.code = code;
    qe
}

fn dead() -> QueryError {
    QueryError::new("oracle", "Oracle connection thread is not available", "actor gone")
}

impl OracleDriver {
    pub async fn connect(p: &OracleConnParams) -> Result<Self, QueryError> {
        let (init_tx, init_rx) = oneshot::channel::<Result<(), QueryError>>();
        let (tx, rx) = mpsc::channel::<Cmd>();
        let params = p.clone();
        std::thread::spawn(move || actor(params, rx, init_tx));
        match init_rx.await {
            Ok(Ok(())) => Ok(Self { tx, default_schema: p.user.to_uppercase() }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(dead()),
        }
    }

    pub async fn test(p: &OracleConnParams) -> TestResult {
        let started = Instant::now();
        match Self::connect(p).await {
            Ok(d) => {
                let version = d
                    .query("SELECT banner FROM v$version WHERE ROWNUM = 1")
                    .await
                    .ok()
                    .and_then(|r| r.rows.first().and_then(|row| row.as_object().and_then(|o| o.values().next()).and_then(|v| v.as_str().map(str::to_string))));
                TestResult { ok: true, latency_ms: Some(started.elapsed().as_millis() as u64), server_version: version, error: None }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    async fn send<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T, QueryError> {
        let (rtx, rrx) = oneshot::channel::<T>();
        self.tx.send(make(rtx)).map_err(|_| dead())?;
        rrx.await.map_err(|_| dead())
    }

    pub async fn ping(&mut self) -> bool {
        self.send(Cmd::Ping).await.unwrap_or(false)
    }

    pub async fn exec(&mut self, sql: &str) -> Result<StatementOutcome, QueryError> {
        let sql = sql.to_string();
        self.send(move |r| Cmd::Exec(sql, r)).await?
    }

    pub async fn exec_params(&mut self, sql: &str, params: &[Json]) -> Result<StatementOutcome, QueryError> {
        let (sql, params) = (sql.to_string(), params.to_vec());
        self.send(move |r| Cmd::ExecParams(sql, params, r)).await?
    }

    pub async fn apply_changes(&mut self, changes: &[GridChange]) -> Result<u64, QueryError> {
        let changes = changes.to_vec();
        self.send(move |r| Cmd::Apply(changes, r)).await?
    }

    /// Run a SELECT and get the full materialized result (used by introspection).
    async fn query(&self, sql: &str) -> Result<QueryResultSet, QueryError> {
        let sql = sql.to_string();
        self.send(move |r| Cmd::Query(sql, r)).await?
    }

    // ---- introspection via ALL_* catalog views (parsed from JSON rows) --------

    pub async fn schemas(&mut self) -> Result<Vec<SchemaInfo>, QueryError> {
        let res = self
            .query(
                "SELECT username AS name, CASE WHEN username = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') THEN 1 ELSE 0 END AS is_default \
                 FROM all_users WHERE oracle_maintained = 'N' OR username = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') ORDER BY username",
            )
            .await?;
        Ok(res.rows.iter().map(|r| SchemaInfo { name: jstr(r, "NAME"), is_default: ji64(r, "IS_DEFAULT") == Some(1) }).collect())
    }

    pub async fn databases(&mut self) -> Result<Vec<DatabaseInfo>, QueryError> {
        Ok(Vec::new()) // PDB listing (V$PDBS) needs CDB privileges — schema-based tree instead.
    }

    pub async fn tables(&mut self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        let o = lit(schema);
        let res = self
            .query(&format!(
                "SELECT table_name AS name, 'table' AS kind, num_rows AS nrows FROM all_tables WHERE owner = {o} \
                 UNION ALL SELECT view_name AS name, 'view' AS kind, NULL AS nrows FROM all_views WHERE owner = {o} ORDER BY name"
            ))
            .await?;
        let sizes = self.segment_sizes(schema, "TABLE").await;
        Ok(res
            .rows
            .iter()
            .map(|r| {
                let name = jstr(r, "NAME");
                TableInfo {
                    schema: schema.to_string(),
                    kind: jstr(r, "KIND"),
                    row_estimate: ji64(r, "NROWS"),
                    locked: false,
                    engine: None,
                    data_length: sizes.get(&name).copied(),
                    name,
                }
            })
            .collect())
    }

    pub async fn columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        let (o, t) = (lit(schema), lit(table));
        let pk = self.constraint_columns(schema, table, 'P').await;
        let fk = self.constraint_columns(schema, table, 'R').await;
        let res = self
            .query(&format!(
                "SELECT column_name AS name, data_type AS dtype, data_length AS dlen, data_precision AS dprec, \
                        data_scale AS dscale, nullable AS nullable, column_id AS cid, NVL(identity_column,'NO') AS is_identity, \
                        data_default AS ddefault \
                 FROM all_tab_columns WHERE owner = {o} AND table_name = {t} ORDER BY column_id"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| {
                let name = jstr(r, "NAME");
                ColumnInfo {
                    data_type: build_col_type(&jstr(r, "DTYPE"), ji64(r, "DLEN"), ji64(r, "DPREC"), ji64(r, "DSCALE")),
                    nullable: jstr(r, "NULLABLE") == "Y",
                    default: { let d = jstr(r, "DDEFAULT").trim().to_string(); if d.is_empty() { None } else { Some(d) } },
                    is_pk: pk.contains(&name),
                    is_fk: fk.contains(&name),
                    ordinal: ji64(r, "CID").unwrap_or(0) as i32,
                    auto_increment: jstr(r, "IS_IDENTITY") == "YES",
                    name,
                }
            })
            .collect())
    }

    async fn constraint_columns(&self, schema: &str, table: &str, kind: char) -> HashSet<String> {
        let (o, t) = (lit(schema), lit(table));
        match self
            .query(&format!(
                "SELECT acc.column_name AS name FROM all_constraints ac \
                 JOIN all_cons_columns acc ON ac.owner = acc.owner AND ac.constraint_name = acc.constraint_name \
                 WHERE ac.owner = {o} AND ac.table_name = {t} AND ac.constraint_type = '{kind}'"
            ))
            .await
        {
            Ok(res) => res.rows.iter().map(|r| jstr(r, "NAME")).collect(),
            Err(_) => HashSet::new(),
        }
    }

    async fn pk_index_names(&self, schema: &str) -> HashSet<String> {
        let o = lit(schema);
        match self
            .query(&format!("SELECT index_name AS name FROM all_constraints WHERE owner = {o} AND constraint_type = 'P' AND index_name IS NOT NULL"))
            .await
        {
            Ok(res) => res.rows.iter().map(|r| jstr(r, "NAME")).collect(),
            Err(_) => HashSet::new(),
        }
    }

    async fn segment_sizes(&self, schema: &str, seg_type: &str) -> HashMap<String, i64> {
        let o = lit(schema);
        match self
            .query(&format!(
                "SELECT segment_name AS name, SUM(bytes) AS bytes FROM dba_segments WHERE owner = {o} AND segment_type = '{seg_type}' GROUP BY segment_name"
            ))
            .await
        {
            Ok(res) => res.rows.iter().filter_map(|r| ji64(r, "BYTES").map(|b| (jstr(r, "NAME"), b))).collect(),
            Err(_) => HashMap::new(),
        }
    }

    pub async fn indexes(&mut self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, QueryError> {
        let (o, t) = (lit(schema), lit(table));
        let pk = self.pk_index_names(schema).await;
        let res = self
            .query(&format!(
                "SELECT i.index_name AS iname, i.index_type AS itype, i.uniqueness AS uniq, c.column_name AS cname \
                 FROM all_indexes i JOIN all_ind_columns c ON i.owner = c.index_owner AND i.index_name = c.index_name \
                 WHERE i.table_owner = {o} AND i.table_name = {t} ORDER BY i.index_name, c.column_position"
            ))
            .await?;
        let mut out: Vec<IndexInfo> = Vec::new();
        for r in &res.rows {
            let name = jstr(r, "INAME");
            let col = jstr(r, "CNAME");
            if let Some(last) = out.last_mut() {
                if last.name == name {
                    last.columns.push(col);
                    continue;
                }
            }
            out.push(IndexInfo { method: jstr(r, "ITYPE"), unique: jstr(r, "UNIQ") == "UNIQUE", primary: pk.contains(&name), columns: vec![col], name });
        }
        Ok(out)
    }

    pub async fn constraints(&mut self, schema: &str, table: &str) -> Result<Vec<ConstraintInfo>, QueryError> {
        let (o, t) = (lit(schema), lit(table));
        let res = self
            .query(&format!(
                "SELECT constraint_name AS cname, constraint_type AS ctype, search_condition_vc AS scond \
                 FROM all_constraints WHERE owner = {o} AND table_name = {t} AND constraint_type IN ('P','R','U','C') ORDER BY constraint_name"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| {
                let def = jstr(r, "SCOND");
                ConstraintInfo {
                    name: jstr(r, "CNAME"),
                    kind: match jstr(r, "CTYPE").as_str() { "P" => "PK", "R" => "FK", "U" => "UNIQUE", _ => "CHECK" }.to_string(),
                    definition: if def.is_empty() { None } else { Some(def) },
                }
            })
            .collect())
    }

    pub async fn routines(&mut self, schema: &str) -> Result<Vec<RoutineInfo>, QueryError> {
        let o = lit(schema);
        let res = self
            .query(&format!(
                "SELECT object_name AS name, object_type AS otype FROM all_objects WHERE owner = {o} AND object_type IN ('PROCEDURE','FUNCTION') ORDER BY object_name"
            ))
            .await?;
        let mut pmap: HashMap<String, (Vec<ParamInfo>, Option<String>)> = HashMap::new();
        if let Ok(a) = self
            .query(&format!(
                "SELECT object_name AS oname, argument_name AS aname, position AS pos, data_type AS dtype, in_out AS io \
                 FROM all_arguments WHERE owner = {o} AND package_name IS NULL AND data_type IS NOT NULL ORDER BY object_name, position"
            ))
            .await
        {
            for r in &a.rows {
                let entry = pmap.entry(jstr(r, "ONAME")).or_default();
                let dtype = jstr(r, "DTYPE");
                if ji64(r, "POS") == Some(0) {
                    entry.1 = Some(dtype);
                } else {
                    let io = jstr(r, "IO");
                    entry.0.push(ParamInfo { name: jstr(r, "ANAME"), data_type: dtype, mode: if io == "IN/OUT" { "INOUT".into() } else { io.to_uppercase() }, default: None });
                }
            }
        }
        Ok(res
            .rows
            .iter()
            .map(|r| {
                let name = jstr(r, "NAME");
                let (params, return_type) = pmap.remove(&name).unwrap_or_default();
                RoutineInfo { schema: schema.to_string(), kind: if jstr(r, "OTYPE") == "FUNCTION" { "function" } else { "procedure" }.to_string(), params, return_type, name }
            })
            .collect())
    }

    pub async fn functions(&mut self, schema: &str) -> Result<Vec<FunctionInfo>, QueryError> {
        let o = lit(schema);
        let res = self
            .query(&format!("SELECT object_name AS name FROM all_objects WHERE owner = {o} AND object_type = 'FUNCTION' ORDER BY object_name"))
            .await?;
        Ok(res.rows.iter().map(|r| FunctionInfo { name: jstr(r, "NAME"), signature: None, detail: Some("user".into()) }).collect())
    }

    pub async fn triggers(&mut self, schema: &str) -> Result<Vec<TriggerInfo>, QueryError> {
        let o = lit(schema);
        let res = self
            .query(&format!(
                "SELECT trigger_name AS name, table_name AS tname, trigger_type AS ttype, triggering_event AS tevent FROM all_triggers WHERE owner = {o} ORDER BY trigger_name"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| TriggerInfo { schema: schema.to_string(), name: jstr(r, "NAME"), table: jstr(r, "TNAME"), event: format!("{} {}", jstr(r, "TTYPE"), jstr(r, "TEVENT")).trim().to_string() })
            .collect())
    }

    pub async fn sequences(&mut self, schema: &str) -> Result<Vec<SequenceInfo>, QueryError> {
        let o = lit(schema);
        let res = self.query(&format!("SELECT sequence_name AS name FROM all_sequences WHERE sequence_owner = {o} ORDER BY sequence_name")).await?;
        Ok(res.rows.iter().map(|r| SequenceInfo { schema: schema.to_string(), name: jstr(r, "NAME") }).collect())
    }

    pub async fn foreign_keys(&mut self, schema: &str) -> Result<Vec<ForeignKey>, QueryError> {
        let o = lit(schema);
        let res = self
            .query(&format!(
                "SELECT ac.constraint_name AS name, ac.table_name AS from_table, acc.column_name AS from_col, rac.table_name AS to_table, rcc.column_name AS to_col \
                 FROM all_constraints ac \
                 JOIN all_cons_columns acc ON ac.owner = acc.owner AND ac.constraint_name = acc.constraint_name \
                 JOIN all_constraints rac ON ac.r_owner = rac.owner AND ac.r_constraint_name = rac.constraint_name \
                 JOIN all_cons_columns rcc ON rac.owner = rcc.owner AND rac.constraint_name = rcc.constraint_name AND acc.position = rcc.position \
                 WHERE ac.owner = {o} AND ac.constraint_type = 'R' ORDER BY ac.constraint_name, acc.position"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| ForeignKey { name: jstr(r, "NAME"), from_table: jstr(r, "FROM_TABLE"), from_column: jstr(r, "FROM_COL"), to_table: jstr(r, "TO_TABLE"), to_column: jstr(r, "TO_COL") })
            .collect())
    }

    pub async fn partitions(&mut self, schema: &str, table: &str) -> Result<Vec<PartitionInfo>, QueryError> {
        let (o, t) = (lit(schema), lit(table));
        let meta = self
            .query(&format!(
                "SELECT pt.partitioning_type AS method, \
                        (SELECT LISTAGG(column_name, ', ') WITHIN GROUP (ORDER BY column_position) FROM all_part_key_columns k WHERE k.owner = pt.owner AND k.name = pt.table_name) AS keycols \
                 FROM all_part_tables pt WHERE pt.owner = {o} AND pt.table_name = {t}"
            ))
            .await?;
        let (method, key) = match meta.rows.first() {
            Some(r) => (jstr(r, "METHOD"), { let k = jstr(r, "KEYCOLS"); if k.is_empty() { None } else { Some(k) } }),
            None => return Ok(Vec::new()),
        };
        let res = self
            .query(&format!(
                "SELECT partition_name AS name, partition_position AS pos, num_rows AS nrows, high_value AS hval FROM all_tab_partitions WHERE table_owner = {o} AND table_name = {t} ORDER BY partition_position"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| PartitionInfo {
                name: jstr(r, "NAME"),
                method: method.clone(),
                key: key.clone(),
                expression: { let h = jstr(r, "HVAL").trim().to_string(); if h.is_empty() { None } else { Some(h) } },
                rows: ji64(r, "NROWS"),
                position: ji64(r, "POS"),
            })
            .collect())
    }

    pub async fn scan_indexes(&mut self, schema: &str) -> Result<Vec<IndexScanRow>, QueryError> {
        let o = lit(schema);
        let pk = self.pk_index_names(schema).await;
        let sizes = self.segment_sizes(schema, "INDEX").await;
        let res = self
            .query(&format!(
                "SELECT i.index_name AS iname, i.table_name AS tname, i.index_type AS itype, i.uniqueness AS uniq, i.status AS status, c.column_name AS cname \
                 FROM all_indexes i JOIN all_ind_columns c ON i.owner = c.index_owner AND i.index_name = c.index_name WHERE i.owner = {o} ORDER BY i.index_name, c.column_position"
            ))
            .await?;
        let mut out: Vec<IndexScanRow> = Vec::new();
        for r in &res.rows {
            let name = jstr(r, "INAME");
            let col = jstr(r, "CNAME");
            if let Some(last) = out.last_mut() {
                if last.name == name {
                    last.columns.push(col);
                    continue;
                }
            }
            out.push(IndexScanRow {
                table: jstr(r, "TNAME"),
                index_type: jstr(r, "ITYPE"),
                unique: jstr(r, "UNIQ") == "UNIQUE",
                primary: pk.contains(&name),
                size_bytes: sizes.get(&name).copied(),
                usage: None,
                fragmentation_pct: None,
                valid: jstr(r, "STATUS") == "VALID",
                flags: Vec::new(),
                columns: vec![col],
                name,
            });
        }
        Ok(out)
    }
}

// ---- actor thread (owns the blocking, !Send oracle::Connection) --------------

fn actor(p: OracleConnParams, rx: mpsc::Receiver<Cmd>, init_tx: oneshot::Sender<Result<(), QueryError>>) {
    let conn = match connect_blocking(&p) {
        Ok(c) => {
            let _ = init_tx.send(Ok(()));
            c
        }
        Err(e) => {
            let _ = init_tx.send(Err(e));
            return;
        }
    };
    // Consistent date/timestamp text for the grid (default NLS varies by install).
    let _ = conn.execute("ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'", &[]);
    let _ = conn.execute("ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'", &[]);
    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::Exec(sql, r) => { let _ = r.send(do_exec(&conn, &sql)); }
            Cmd::ExecParams(sql, params, r) => { let _ = r.send(do_exec_params(&conn, &sql, &params)); }
            Cmd::Query(sql, r) => { let _ = r.send(do_query(&conn, &sql)); }
            Cmd::Apply(changes, r) => { let _ = r.send(do_apply(&conn, &changes)); }
            Cmd::Ping(r) => { let _ = r.send(conn.query("SELECT 1 FROM DUAL", &[]).is_ok()); }
        }
    }
    // channel closed → driver dropped → connection drops here.
}

fn connect_blocking(p: &OracleConnParams) -> Result<Connection, QueryError> {
    // EZConnect for a service name; a TNS descriptor for a SID. TCPS when ssl.
    let proto = if p.ssl { "tcps" } else { "tcp" };
    let cs = if p.use_sid {
        format!(
            "(DESCRIPTION=(ADDRESS=(PROTOCOL={proto})(HOST={})(PORT={}))(CONNECT_DATA=(SID={})))",
            p.host, p.port, p.service
        )
    } else if p.ssl {
        format!(
            "(DESCRIPTION=(ADDRESS=(PROTOCOL=tcps)(HOST={})(PORT={}))(CONNECT_DATA=(SERVICE_NAME={})))",
            p.host, p.port, p.service
        )
    } else {
        format!("//{}:{}/{}", p.host, p.port, p.service)
    };
    Connection::connect(&p.user, &p.password, &cs).map_err(|e| map_error(&e))
}

fn do_query(conn: &Connection, sql: &str) -> Result<QueryResultSet, QueryError> {
    let rows = conn.query(sql, &[]).map_err(|e| map_error(&e))?;
    let cols: Vec<ColumnDef> = rows.column_info().iter().map(|c| (c.name().to_string(), c.oracle_type().to_string().to_lowercase())).collect();
    let ncol = cols.len();
    let mut out: Vec<Json> = Vec::new();
    for rr in rows {
        let row = rr.map_err(|e| map_error(&e))?;
        let mut obj = Map::new();
        for (i, (name, _)) in cols.iter().enumerate().take(ncol) {
            obj.insert(name.clone(), decode(&row, i));
        }
        out.push(Json::Object(obj));
    }
    let total = out.len() as u64;
    Ok(QueryResultSet { cols, rows: out, total })
}

fn do_exec(conn: &Connection, sql: &str) -> Result<StatementOutcome, QueryError> {
    let stmt = prepare_statement(sql);
    let wants_rows = crate::drivers::util::returns_rows(&stmt) && !stmt.trim_start().to_uppercase().starts_with("EXPLAIN PLAN");
    if wants_rows {
        Ok(StatementOutcome::Rows { result: do_query(conn, &stmt)? })
    } else {
        let s = conn.execute(&stmt, &[]).map_err(|e| map_error(&e))?;
        // ODPI-C defaults to autocommit OFF, so an editor INSERT/UPDATE/DELETE (or a
        // PL/SQL block doing DML) stayed in an open transaction forever: the engine
        // never got the new value and no other session could see it. Every other
        // engine in this app runs the editor in autocommit — match that. Committing
        // with nothing pending is a no-op; DDL commits itself anyway.
        conn.commit().map_err(|e| map_error(&e))?;
        if crate::drivers::util::is_dml(&stmt) {
            Ok(StatementOutcome::Affected { affected: s.row_count().unwrap_or(0) })
        } else {
            Ok(StatementOutcome::Ok)
        }
    }
}

fn do_exec_params(conn: &Connection, sql: &str, params: &[Json]) -> Result<StatementOutcome, QueryError> {
    let stmt = prepare_statement(sql);
    // Bind every param as Option<String> (None = NULL); Oracle implicit-converts to
    // the column type. Placeholders are :1, :2, … (positional).
    let owned: Vec<Option<String>> = params.iter().map(json_to_bind).collect();
    let binds: Vec<&dyn ToSql> = owned.iter().map(|o| o as &dyn ToSql).collect();
    if crate::drivers::util::returns_rows(&stmt) {
        // Re-run through a materializing query with binds.
        let rows = conn.query(&stmt, &binds).map_err(|e| map_error(&e))?;
        let cols: Vec<ColumnDef> = rows.column_info().iter().map(|c| (c.name().to_string(), c.oracle_type().to_string().to_lowercase())).collect();
        let ncol = cols.len();
        let mut out = Vec::new();
        for rr in rows {
            let row = rr.map_err(|e| map_error(&e))?;
            let mut obj = Map::new();
            for (i, (name, _)) in cols.iter().enumerate().take(ncol) {
                obj.insert(name.clone(), decode(&row, i));
            }
            out.push(Json::Object(obj));
        }
        let total = out.len() as u64;
        Ok(StatementOutcome::Rows { result: QueryResultSet { cols, rows: out, total } })
    } else {
        let s = conn.execute(&stmt, &binds).map_err(|e| map_error(&e))?;
        // Autocommit semantics — see do_exec.
        conn.commit().map_err(|e| map_error(&e))?;
        Ok(StatementOutcome::Affected { affected: s.row_count().unwrap_or(0) })
    }
}

fn do_apply(conn: &Connection, changes: &[GridChange]) -> Result<u64, QueryError> {
    let mut affected = 0u64;
    for ch in changes {
        let bs = crate::drivers::grid::build("oracle", ch);
        let owned: Vec<Option<String>> = bs.params.iter().map(json_to_bind).collect();
        let binds: Vec<&dyn ToSql> = owned.iter().map(|o| o as &dyn ToSql).collect();
        match conn.execute(&bs.sql, &binds) {
            Ok(s) => affected += s.row_count().unwrap_or(0),
            Err(e) => {
                let _ = conn.rollback();
                return Err(map_error(&e));
            }
        }
    }
    conn.commit().map_err(|e| map_error(&e))?;
    Ok(affected)
}

fn json_to_bind(v: &Json) -> Option<String> {
    match v {
        Json::Null => None,
        Json::Bool(b) => Some(if *b { "1" } else { "0" }.into()),
        Json::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn decode(row: &oracle::Row, i: usize) -> Json {
    match row.get::<usize, Option<String>>(i) {
        Ok(Some(s)) => Json::String(s),
        Ok(None) => Json::Null,
        // Binary types (RAW/BLOB) can't convert to String → hex the bytes.
        Err(_) => match row.get::<usize, Option<Vec<u8>>>(i) {
            Ok(Some(b)) => Json::String(to_hex(&b)),
            _ => Json::Null,
        },
    }
}

/// Single-quoted SQL literal for a catalog identifier (owner/table).
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn jstr(row: &Json, key: &str) -> String {
    row.get(key).and_then(|v| v.as_str()).map(str::to_string).unwrap_or_default()
}

fn ji64(row: &Json, key: &str) -> Option<i64> {
    row.get(key).and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

fn build_col_type(dtype: &str, len: Option<i64>, prec: Option<i64>, scale: Option<i64>) -> String {
    let up = dtype.to_uppercase();
    if matches!(up.as_str(), "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" | "RAW") {
        if let Some(l) = len {
            if l > 0 {
                return format!("{dtype}({l})");
            }
        }
    }
    if up == "NUMBER" {
        if let Some(p) = prec {
            return match scale {
                Some(s) if s > 0 => format!("NUMBER({p},{s})"),
                _ => format!("NUMBER({p})"),
            };
        }
    }
    dtype.to_string()
}

fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 + b.len() * 2);
    s.push_str("0x");
    for byte in b {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

/// Oracle rejects a trailing `;` on a plain SQL statement; strip it. PL/SQL blocks
/// / CREATE routine keep their internal `;` and `END;` (the frontend splitter has
/// already removed any `/` terminator line).
fn prepare_statement(sql: &str) -> String {
    let t = sql.trim();
    if is_plsql(t) {
        return t.to_string();
    }
    t.trim_end_matches(';').trim_end().to_string()
}

fn is_plsql(sql: &str) -> bool {
    let up = sql.trim_start().to_uppercase();
    if up.starts_with("BEGIN") || up.starts_with("DECLARE") {
        return true;
    }
    if up.starts_with("CREATE") {
        return ["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE"].iter().any(|kw| up.contains(kw));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plsql_detection() {
        assert!(is_plsql("BEGIN NULL; END;"));
        assert!(is_plsql("  declare v number; begin null; end;"));
        assert!(is_plsql("CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;"));
        assert!(!is_plsql("SELECT 1 FROM dual"));
        assert!(!is_plsql("CREATE TABLE t (id NUMBER)"));
    }

    #[test]
    fn prepare_strips_trailing_semicolon_only_for_plain_sql() {
        assert_eq!(prepare_statement("SELECT 1 FROM dual;"), "SELECT 1 FROM dual");
        assert_eq!(prepare_statement("BEGIN NULL; END;"), "BEGIN NULL; END;");
    }

    #[test]
    fn hex_and_type_build() {
        assert_eq!(to_hex(&[0x00, 0xff, 0x01]), "0x00ff01");
        assert_eq!(build_col_type("VARCHAR2", Some(50), None, None), "VARCHAR2(50)");
        assert_eq!(build_col_type("NUMBER", None, Some(10), Some(2)), "NUMBER(10,2)");
        assert_eq!(build_col_type("DATE", None, None, None), "DATE");
    }

    #[test]
    fn json_bind_maps_null_and_values() {
        assert_eq!(json_to_bind(&Json::Null), None);
        assert_eq!(json_to_bind(&Json::from(7)), Some("7".to_string()));
        assert_eq!(json_to_bind(&Json::String("x".into())), Some("x".to_string()));
    }
}
