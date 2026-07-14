//! Oracle driver — O0 spike using the PURE-RUST `oracle-rs` crate (TNS protocol,
//! rustls TLS, NO Oracle Instant Client / OCI). Async and Send, so it plugs into
//! the same `LiveConnection` model as sqlx/tiberius with no actor thread.
//!
//! O0 scope: connect / test / ping / exec (dynamic result decode) + parametrized
//! exec. Introspection + grid apply are stubbed (TODO O1) so the enum wiring
//! compiles and the connect/query path can be verified end-to-end on a real DB.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use oracle_rs::{Config, Connection, QueryResult, Row, Value as OraValue};
use serde_json::Value as Json;

use crate::drivers::index_scan::IndexScanRow;

use crate::drivers::grid::GridChange;
use crate::drivers::types::*;
use crate::drivers::util;
use crate::error::QueryError;

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

pub struct OracleDriver {
    conn: Connection,
    /// The connected user = default schema in Oracle (UPPERCASE).
    #[allow(dead_code)]
    default_schema: String,
}

fn map_error(e: &oracle_rs::Error) -> QueryError {
    let raw = e.to_string();
    // Surface the ORA-NNNNN code as the error code when present.
    let code = raw
        .split_whitespace()
        .find(|t| t.starts_with("ORA-"))
        .map(|t| t.trim_end_matches([':', ',']).to_string());
    let mut qe = QueryError::new("oracle", raw.clone(), raw);
    qe.code = code;
    qe
}

impl OracleDriver {
    fn build_config(p: &OracleConnParams) -> Result<Config, QueryError> {
        let cfg = if p.use_sid {
            Config::with_sid(&p.host, p.port, &p.service, &p.user, &p.password)
        } else {
            Config::new(&p.host, p.port, &p.service, &p.user, &p.password)
        };
        if p.ssl {
            cfg.with_tls().map_err(|e| map_error(&e))
        } else {
            Ok(cfg)
        }
    }

    pub async fn connect(p: &OracleConnParams) -> Result<Self, QueryError> {
        let cfg = Self::build_config(p)?;
        let conn = Connection::connect_with_config(cfg)
            .await
            .map_err(|e| map_error(&e))?;
        Ok(Self { conn, default_schema: p.user.to_uppercase() })
    }

    pub async fn test(p: &OracleConnParams) -> TestResult {
        let started = Instant::now();
        match Self::connect(p).await {
            Ok(drv) => {
                let version = drv
                    .conn
                    .query("SELECT banner FROM v$version WHERE ROWNUM = 1", &[])
                    .await
                    .ok()
                    .and_then(|r| r.rows.first().and_then(|row| row.get(0).map(value_to_string)));
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

    pub async fn ping(&mut self) -> bool {
        self.conn.ping().await.is_ok()
    }

    pub async fn exec(&mut self, sql: &str) -> Result<StatementOutcome, QueryError> {
        let stmt = prepare_statement(sql);
        // `EXPLAIN PLAN [SET STATEMENT_ID …] FOR …` looks row-returning (leading verb
        // EXPLAIN) but produces NO result set — it only populates PLAN_TABLE. Route it
        // (and anything non-row-returning) through execute().
        let wants_rows = util::returns_rows(&stmt) && !stmt.trim_start().to_uppercase().starts_with("EXPLAIN PLAN");
        if wants_rows {
            let res = self.conn.query(&stmt, &[]).await.map_err(|e| map_error(&e))?;
            Ok(StatementOutcome::Rows { result: decode(&res) })
        } else {
            let res = self.conn.execute(&stmt, &[]).await.map_err(|e| map_error(&e))?;
            if util::is_dml(&stmt) {
                Ok(StatementOutcome::Affected { affected: res.rows_affected })
            } else {
                Ok(StatementOutcome::Ok)
            }
        }
    }

    pub async fn exec_params(
        &mut self,
        sql: &str,
        params: &[Json],
    ) -> Result<StatementOutcome, QueryError> {
        let binds: Vec<OraValue> = params.iter().map(json_to_value).collect();
        let stmt = prepare_statement(sql);
        if util::returns_rows(&stmt) {
            let res = self.conn.query(&stmt, &binds).await.map_err(|e| map_error(&e))?;
            Ok(StatementOutcome::Rows { result: decode(&res) })
        } else {
            let res = self.conn.execute(&stmt, &binds).await.map_err(|e| map_error(&e))?;
            Ok(StatementOutcome::Affected { affected: res.rows_affected })
        }
    }

    // ---- O1: real introspection via ALL_* catalog views ---------------------

    async fn q(&self, sql: &str) -> Result<QueryResult, QueryError> {
        self.conn.query(sql, &[]).await.map_err(|e| map_error(&e))
    }

    /// Editable-grid apply — parametrized INSERT/UPDATE/DELETE (`:1` binds) run in
    /// one transaction (Oracle has no BEGIN; COMMIT/ROLLBACK explicit).
    pub async fn apply_changes(&mut self, changes: &[GridChange]) -> Result<u64, QueryError> {
        let mut affected = 0u64;
        for ch in changes {
            let bs = crate::drivers::grid::build("oracle", ch);
            let binds: Vec<OraValue> = bs.params.iter().map(json_to_value).collect();
            match self.conn.execute(&bs.sql, &binds).await {
                Ok(res) => affected += res.rows_affected,
                Err(e) => {
                    let _ = self.conn.rollback().await;
                    return Err(map_error(&e));
                }
            }
        }
        self.conn.commit().await.map_err(|e| map_error(&e))?;
        Ok(affected)
    }

    pub async fn schemas(&mut self) -> Result<Vec<SchemaInfo>, QueryError> {
        // Non-Oracle-maintained users = real schemas; always include the current one.
        let res = self
            .q("SELECT username AS name, CASE WHEN username = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') THEN 1 ELSE 0 END AS is_default \
                FROM all_users \
                WHERE oracle_maintained = 'N' OR username = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                ORDER BY username")
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| SchemaInfo { name: cell_str(&res, r, "NAME"), is_default: cell_i64(&res, r, "IS_DEFAULT") == Some(1) })
            .collect())
    }

    pub async fn databases(&mut self) -> Result<Vec<DatabaseInfo>, QueryError> {
        // O2: PDB listing via V$PDBS/CDB_PDBS (needs CDB privileges). Empty → the
        // Explorer renders schemas directly (no multi-DB header), which is correct
        // for a single-service connection.
        Ok(Vec::new())
    }

    pub async fn tables(&mut self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        let o = lit(schema);
        let res = self
            .q(&format!(
                "SELECT table_name AS name, 'table' AS kind, num_rows AS nrows FROM all_tables WHERE owner = {o} \
                 UNION ALL \
                 SELECT view_name AS name, 'view' AS kind, NULL AS nrows FROM all_views WHERE owner = {o} \
                 ORDER BY name"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| TableInfo {
                schema: schema.to_string(),
                name: cell_str(&res, r, "NAME"),
                kind: cell_str(&res, r, "KIND"),
                row_estimate: cell_i64(&res, r, "NROWS"),
                locked: false,
                engine: None,
                data_length: None, // O2: DBA_SEGMENTS.bytes (needs privileges)
            })
            .collect())
    }

    pub async fn columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        let (o, t) = (lit(schema), lit(table));
        let pk = self.constraint_columns(schema, table, 'P').await.unwrap_or_default();
        let fk = self.constraint_columns(schema, table, 'R').await.unwrap_or_default();
        let res = self
            .q(&format!(
                "SELECT column_name AS name, data_type AS dtype, data_length AS dlen, data_precision AS dprec, \
                        data_scale AS dscale, nullable AS nullable, column_id AS cid, NVL(identity_column,'NO') AS is_identity \
                 FROM all_tab_columns WHERE owner = {o} AND table_name = {t} ORDER BY column_id"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| {
                let name = cell_str(&res, r, "NAME");
                ColumnInfo {
                    data_type: build_col_type(
                        &cell_str(&res, r, "DTYPE"),
                        cell_i64(&res, r, "DLEN"),
                        cell_i64(&res, r, "DPREC"),
                        cell_i64(&res, r, "DSCALE"),
                    ),
                    nullable: cell_str(&res, r, "NULLABLE") == "Y",
                    default: None, // O2: DATA_DEFAULT is LONG — skip to avoid LONG decode
                    is_pk: pk.contains(&name),
                    is_fk: fk.contains(&name),
                    ordinal: cell_i64(&res, r, "CID").unwrap_or(0) as i32,
                    auto_increment: cell_str(&res, r, "IS_IDENTITY") == "YES",
                    name,
                }
            })
            .collect())
    }

    async fn constraint_columns(&self, schema: &str, table: &str, kind: char) -> Result<HashSet<String>, QueryError> {
        let (o, t) = (lit(schema), lit(table));
        let res = self
            .q(&format!(
                "SELECT acc.column_name AS name FROM all_constraints ac \
                 JOIN all_cons_columns acc ON ac.owner = acc.owner AND ac.constraint_name = acc.constraint_name \
                 WHERE ac.owner = {o} AND ac.table_name = {t} AND ac.constraint_type = '{kind}'"
            ))
            .await?;
        Ok(res.rows.iter().map(|r| cell_str(&res, r, "NAME")).collect())
    }

    async fn pk_index_names(&self, schema: &str) -> HashSet<String> {
        let o = lit(schema);
        match self
            .q(&format!(
                "SELECT index_name AS name FROM all_constraints WHERE owner = {o} AND constraint_type = 'P' AND index_name IS NOT NULL"
            ))
            .await
        {
            Ok(res) => res.rows.iter().map(|r| cell_str(&res, r, "NAME")).collect(),
            Err(_) => HashSet::new(),
        }
    }

    pub async fn indexes(&mut self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, QueryError> {
        let (o, t) = (lit(schema), lit(table));
        let pk = self.pk_index_names(schema).await;
        let res = self
            .q(&format!(
                "SELECT i.index_name AS iname, i.index_type AS itype, i.uniqueness AS uniq, c.column_name AS cname \
                 FROM all_indexes i JOIN all_ind_columns c ON i.owner = c.index_owner AND i.index_name = c.index_name \
                 WHERE i.table_owner = {o} AND i.table_name = {t} ORDER BY i.index_name, c.column_position"
            ))
            .await?;
        Ok(fold_indexes(&res, &pk))
    }

    pub async fn constraints(&mut self, schema: &str, table: &str) -> Result<Vec<ConstraintInfo>, QueryError> {
        let (o, t) = (lit(schema), lit(table));
        let res = self
            .q(&format!(
                "SELECT constraint_name AS cname, constraint_type AS ctype, search_condition_vc AS scond \
                 FROM all_constraints WHERE owner = {o} AND table_name = {t} \
                 AND constraint_type IN ('P','R','U','C') ORDER BY constraint_name"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| {
                let def = cell_str(&res, r, "SCOND");
                ConstraintInfo {
                    name: cell_str(&res, r, "CNAME"),
                    kind: match cell_str(&res, r, "CTYPE").as_str() {
                        "P" => "PK",
                        "R" => "FK",
                        "U" => "UNIQUE",
                        _ => "CHECK",
                    }
                    .to_string(),
                    definition: if def.is_empty() { None } else { Some(def) },
                }
            })
            .collect())
    }

    pub async fn routines(&mut self, schema: &str) -> Result<Vec<RoutineInfo>, QueryError> {
        let o = lit(schema);
        let res = self
            .q(&format!(
                "SELECT object_name AS name, object_type AS otype FROM all_objects \
                 WHERE owner = {o} AND object_type IN ('PROCEDURE','FUNCTION') ORDER BY object_name"
            ))
            .await?;
        // Params + return type from ALL_ARGUMENTS (standalone routines: package NULL).
        // position 0 = function return value; 1..n = params. IN_OUT = IN | OUT | IN/OUT.
        let mut pmap: HashMap<String, (Vec<ParamInfo>, Option<String>)> = HashMap::new();
        if let Ok(a) = self
            .q(&format!(
                "SELECT object_name AS oname, argument_name AS aname, position AS pos, data_type AS dtype, in_out AS io \
                 FROM all_arguments WHERE owner = {o} AND package_name IS NULL AND data_type IS NOT NULL \
                 ORDER BY object_name, position"
            ))
            .await
        {
            for r in &a.rows {
                let entry = pmap.entry(cell_str(&a, r, "ONAME")).or_default();
                let dtype = cell_str(&a, r, "DTYPE");
                if cell_i64(&a, r, "POS") == Some(0) {
                    entry.1 = Some(dtype); // function return value
                } else {
                    let io = cell_str(&a, r, "IO");
                    entry.0.push(ParamInfo {
                        name: cell_str(&a, r, "ANAME"),
                        data_type: dtype,
                        mode: if io == "IN/OUT" { "INOUT".into() } else { io.to_uppercase() },
                        default: None,
                    });
                }
            }
        }
        Ok(res
            .rows
            .iter()
            .map(|r| {
                let name = cell_str(&res, r, "NAME");
                let (params, return_type) = pmap.remove(&name).unwrap_or_default();
                RoutineInfo {
                    schema: schema.to_string(),
                    kind: if cell_str(&res, r, "OTYPE") == "FUNCTION" { "function" } else { "procedure" }.to_string(),
                    params,
                    return_type,
                    name,
                }
            })
            .collect())
    }

    pub async fn functions(&mut self, schema: &str) -> Result<Vec<FunctionInfo>, QueryError> {
        let o = lit(schema);
        let res = self
            .q(&format!(
                "SELECT object_name AS name FROM all_objects WHERE owner = {o} AND object_type = 'FUNCTION' ORDER BY object_name"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| FunctionInfo { name: cell_str(&res, r, "NAME"), signature: None, detail: Some("user".into()) })
            .collect())
    }

    pub async fn triggers(&mut self, schema: &str) -> Result<Vec<TriggerInfo>, QueryError> {
        let o = lit(schema);
        let res = self
            .q(&format!(
                "SELECT trigger_name AS name, table_name AS tname, trigger_type AS ttype, triggering_event AS tevent \
                 FROM all_triggers WHERE owner = {o} ORDER BY trigger_name"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| TriggerInfo {
                schema: schema.to_string(),
                name: cell_str(&res, r, "NAME"),
                table: cell_str(&res, r, "TNAME"),
                event: format!("{} {}", cell_str(&res, r, "TTYPE"), cell_str(&res, r, "TEVENT")).trim().to_string(),
            })
            .collect())
    }

    pub async fn sequences(&mut self, schema: &str) -> Result<Vec<SequenceInfo>, QueryError> {
        let o = lit(schema);
        let res = self
            .q(&format!("SELECT sequence_name AS name FROM all_sequences WHERE sequence_owner = {o} ORDER BY sequence_name"))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| SequenceInfo { schema: schema.to_string(), name: cell_str(&res, r, "NAME") })
            .collect())
    }

    pub async fn foreign_keys(&mut self, schema: &str) -> Result<Vec<ForeignKey>, QueryError> {
        let o = lit(schema);
        let res = self
            .q(&format!(
                "SELECT ac.constraint_name AS name, ac.table_name AS from_table, acc.column_name AS from_col, \
                        rac.table_name AS to_table, rcc.column_name AS to_col \
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
            .map(|r| ForeignKey {
                name: cell_str(&res, r, "NAME"),
                from_table: cell_str(&res, r, "FROM_TABLE"),
                from_column: cell_str(&res, r, "FROM_COL"),
                to_table: cell_str(&res, r, "TO_TABLE"),
                to_column: cell_str(&res, r, "TO_COL"),
            })
            .collect())
    }

    pub async fn partitions(&mut self, schema: &str, table: &str) -> Result<Vec<PartitionInfo>, QueryError> {
        let (o, t) = (lit(schema), lit(table));
        // Parent partitioning method + key (one row).
        let meta = self
            .q(&format!(
                "SELECT pt.partitioning_type AS method, \
                        (SELECT LISTAGG(column_name, ', ') WITHIN GROUP (ORDER BY column_position) \
                         FROM all_part_key_columns k WHERE k.owner = pt.owner AND k.name = pt.table_name) AS keycols \
                 FROM all_part_tables pt WHERE pt.owner = {o} AND pt.table_name = {t}"
            ))
            .await?;
        let (method, key) = match meta.rows.first() {
            Some(r) => (cell_str(&meta, r, "METHOD"), {
                let k = cell_str(&meta, r, "KEYCOLS");
                if k.is_empty() { None } else { Some(k) }
            }),
            None => return Ok(Vec::new()), // not partitioned
        };
        let res = self
            .q(&format!(
                "SELECT partition_name AS name, partition_position AS pos, num_rows AS nrows \
                 FROM all_tab_partitions WHERE table_owner = {o} AND table_name = {t} ORDER BY partition_position"
            ))
            .await?;
        Ok(res
            .rows
            .iter()
            .map(|r| PartitionInfo {
                name: cell_str(&res, r, "NAME"),
                method: method.clone(),
                key: key.clone(),
                expression: None, // O2: HIGH_VALUE is LONG — skip to avoid LONG decode
                rows: cell_i64(&res, r, "NROWS"),
                position: cell_i64(&res, r, "POS"),
            })
            .collect())
    }

    pub async fn scan_indexes(&mut self, schema: &str) -> Result<Vec<IndexScanRow>, QueryError> {
        let o = lit(schema);
        let pk = self.pk_index_names(schema).await;
        let res = self
            .q(&format!(
                "SELECT i.index_name AS iname, i.table_name AS tname, i.index_type AS itype, i.uniqueness AS uniq, i.status AS status, \
                        c.column_name AS cname \
                 FROM all_indexes i JOIN all_ind_columns c ON i.owner = c.index_owner AND i.index_name = c.index_name \
                 WHERE i.owner = {o} ORDER BY i.index_name, c.column_position"
            ))
            .await?;
        // Fold multi-column indexes into one row each (preserving column order).
        let mut out: Vec<IndexScanRow> = Vec::new();
        for r in &res.rows {
            let name = cell_str(&res, r, "INAME");
            let col = cell_str(&res, r, "CNAME");
            if let Some(last) = out.last_mut() {
                if last.name == name {
                    last.columns.push(col);
                    continue;
                }
            }
            out.push(IndexScanRow {
                table: cell_str(&res, r, "TNAME"),
                index_type: cell_str(&res, r, "ITYPE"),
                unique: cell_str(&res, r, "UNIQ") == "UNIQUE",
                primary: pk.contains(&name),
                size_bytes: None,          // O2: DBA_SEGMENTS
                usage: None,               // O2: V$OBJECT_USAGE
                fragmentation_pct: None,
                valid: cell_str(&res, r, "STATUS") == "VALID",
                flags: Vec::new(),
                columns: vec![col],
                name,
            });
        }
        Ok(out)
    }
}

/// Single-quoted SQL literal for an Oracle catalog identifier (owner/table). These
/// come from Oracle's own catalog, but the quote is escaped for safety.
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Build a readable column type string from ALL_TAB_COLUMNS parts.
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

fn fold_indexes(res: &QueryResult, pk: &HashSet<String>) -> Vec<IndexInfo> {
    let mut out: Vec<IndexInfo> = Vec::new();
    for r in &res.rows {
        let name = cell_str(res, r, "INAME");
        let col = cell_str(res, r, "CNAME");
        if let Some(last) = out.last_mut() {
            if last.name == name {
                last.columns.push(col);
                continue;
            }
        }
        out.push(IndexInfo {
            method: cell_str(res, r, "ITYPE"),
            unique: cell_str(res, r, "UNIQ") == "UNIQUE",
            primary: pk.contains(&name),
            columns: vec![col],
            name,
        });
    }
    out
}

fn cell_str(res: &QueryResult, row: &Row, name: &str) -> String {
    res.column_index(name).and_then(|i| row.get(i)).map(value_to_string_ref).unwrap_or_default()
}

fn cell_i64(res: &QueryResult, row: &Row, name: &str) -> Option<i64> {
    let v = res.column_index(name).and_then(|i| row.get(i))?;
    match v {
        OraValue::Integer(i) => Some(*i),
        OraValue::Float(f) => Some(*f as i64),
        OraValue::Null => None,
        _ => value_to_string_ref(v).trim().parse::<i64>().ok(),
    }
}

/// Oracle rejects a trailing `;` on a plain SQL statement (it's a SQL*Plus/PLSQL
/// terminator). Strip it — UNLESS this is a PL/SQL block / CREATE routine, where the
/// internal/`END;` semicolons are part of the statement. (The frontend splitter has
/// already removed any `/` line.)
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
        return ["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE"]
            .iter()
            .any(|kw| up.contains(kw));
    }
    false
}

/// Build the locked result contract from an oracle-rs QueryResult.
fn decode(res: &QueryResult) -> QueryResultSet {
    let cols: Vec<ColumnDef> = res
        .columns
        .iter()
        .map(|c| (c.name.clone(), format!("{:?}", c.oracle_type).to_lowercase()))
        .collect();
    let names: Vec<&str> = res.columns.iter().map(|c| c.name.as_str()).collect();
    let rows: Vec<Json> = res
        .rows
        .iter()
        .map(|row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                obj.insert((*name).to_string(), value_to_json(row.get(i)));
            }
            Json::Object(obj)
        })
        .collect();
    let total = rows.len() as u64;
    QueryResultSet { cols, rows, total }
}

fn value_to_json(v: Option<&OraValue>) -> Json {
    match v {
        None | Some(OraValue::Null) => Json::Null,
        Some(OraValue::Boolean(b)) => Json::Bool(*b),
        Some(OraValue::Integer(i)) => Json::from(*i),
        Some(OraValue::Float(f)) => serde_json::Number::from_f64(*f).map(Json::Number).unwrap_or(Json::Null),
        Some(OraValue::String(s)) => Json::String(s.clone()),
        Some(OraValue::Json(j)) => j.clone(),
        Some(OraValue::Bytes(b)) => Json::String(to_hex(b)),
        // NUMBER (full precision) / Date / Timestamp / RowId / Lob / Vector / … →
        // their Display string (keeps NUMBER precision; ISO-ish dates).
        Some(other) => Json::String(value_to_string_ref(other)),
    }
}

fn value_to_string(v: &OraValue) -> String {
    value_to_string_ref(v)
}
fn value_to_string_ref(v: &OraValue) -> String {
    match v {
        OraValue::Null => String::new(),
        OraValue::String(s) => s.clone(),
        OraValue::Bytes(b) => to_hex(b),
        _ => v.to_string(),
    }
}

fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 + b.len() * 2);
    s.push_str("0x");
    for byte in b {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

fn json_to_value(v: &Json) -> OraValue {
    match v {
        Json::Null => OraValue::Null,
        Json::Bool(b) => OraValue::Boolean(*b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                OraValue::Integer(i)
            } else {
                OraValue::Float(n.as_f64().unwrap_or(0.0))
            }
        }
        Json::String(s) => OraValue::String(s.clone()),
        other => OraValue::String(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plsql_detection() {
        assert!(is_plsql("BEGIN NULL; END;"));
        assert!(is_plsql("  declare v number; begin null; end;"));
        assert!(is_plsql("CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;"));
        assert!(is_plsql("create trigger t before insert on x for each row begin null; end;"));
        assert!(!is_plsql("SELECT 1 FROM dual"));
        assert!(!is_plsql("INSERT INTO t VALUES (1)"));
        assert!(!is_plsql("CREATE TABLE t (id NUMBER)")); // plain DDL, not PL/SQL
    }

    #[test]
    fn prepare_strips_trailing_semicolon_only_for_plain_sql() {
        assert_eq!(prepare_statement("SELECT 1 FROM dual;"), "SELECT 1 FROM dual");
        assert_eq!(prepare_statement("  SELECT 1 FROM dual ; "), "SELECT 1 FROM dual");
        // PL/SQL keeps its terminating END;
        assert_eq!(prepare_statement("BEGIN NULL; END;"), "BEGIN NULL; END;");
    }

    #[test]
    fn hex_encoding() {
        assert_eq!(to_hex(&[0x00, 0xff, 0x01]), "0x00ff01");
        assert_eq!(to_hex(&[]), "0x");
    }

    #[test]
    fn value_to_json_basic_variants() {
        assert_eq!(value_to_json(None), Json::Null);
        assert_eq!(value_to_json(Some(&OraValue::Null)), Json::Null);
        assert_eq!(value_to_json(Some(&OraValue::Boolean(true))), Json::Bool(true));
        assert_eq!(value_to_json(Some(&OraValue::Integer(42))), Json::from(42));
        assert_eq!(value_to_json(Some(&OraValue::String("hi".into()))), Json::String("hi".into()));
        assert_eq!(value_to_json(Some(&OraValue::Bytes(vec![0xde, 0xad]))), Json::String("0xdead".into()));
    }

    #[test]
    fn json_to_value_binds() {
        assert!(matches!(json_to_value(&Json::Null), OraValue::Null));
        assert!(matches!(json_to_value(&Json::from(7)), OraValue::Integer(7)));
        assert!(matches!(json_to_value(&Json::String("x".into())), OraValue::String(_)));
    }
}
