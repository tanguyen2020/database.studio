//! MySQL + MariaDB driver — sqlx (`mysql` feature), shared by both systems.
//! MariaDB uses the same wire protocol; only the reported `system` differs so
//! error normalization and UI identity stay per-system.

use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlSslMode};
use sqlx::{Column, ConnectOptions, Connection, Executor, Row, TypeInfo};
use std::time::Instant;

use crate::drivers::types::*;
use crate::drivers::util;
use crate::error::{ErrorPosition, QueryError};

pub struct MySqlDriver {
    conn: MySqlConnection,
    /// "mysql" | "mariadb" — used for QueryError.system and hints.
    system: &'static str,
}

pub struct MySqlConnParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub ssl: bool,
    /// TLS cert paths (empty = none). ssl_ca → VerifyCa; cert+key → mTLS.
    pub ssl_ca: String,
    pub ssl_cert: String,
    pub ssl_key: String,
}

impl MySqlDriver {
    pub async fn connect(p: &MySqlConnParams, system: &'static str) -> Result<Self, QueryError> {
        let mut opts = MySqlConnectOptions::new()
            .host(&p.host)
            .port(p.port)
            .username(&p.user)
            .password(&p.password)
            .ssl_mode(if !p.ssl_ca.is_empty() {
                MySqlSslMode::VerifyCa
            } else if p.ssl {
                MySqlSslMode::Required
            } else {
                MySqlSslMode::Preferred
            });
        if !p.ssl_ca.is_empty() {
            opts = opts.ssl_ca(&p.ssl_ca);
        }
        if !p.ssl_cert.is_empty() {
            opts = opts.ssl_client_cert(&p.ssl_cert);
        }
        if !p.ssl_key.is_empty() {
            opts = opts.ssl_client_key(&p.ssl_key);
        }
        if !p.database.is_empty() {
            opts = opts.database(&p.database);
        }
        let conn = opts.connect().await.map_err(|e| map_error(system, &e))?;
        Ok(Self { conn, system })
    }

    pub async fn test(p: &MySqlConnParams, system: &'static str) -> TestResult {
        let started = Instant::now();
        match Self::connect(p, system).await {
            Ok(mut drv) => {
                let version: Option<String> = sqlx::query_scalar("SELECT VERSION()")
                    .fetch_one(&mut drv.conn)
                    .await
                    .ok();
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: version,
                    error: None,
                }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    pub async fn exec(&mut self, sql: &str) -> Result<StatementOutcome, QueryError> {
        if util::returns_rows(sql) {
            let rows = fetch_all(&mut self.conn, sql)
                .await
                .map_err(|e| map_exec_error(self.system, &e))?;
            let (mut cols, out_rows) = decode_rows(&rows);
            // Empty result set has no rows to read column types from → describe().
            if cols.is_empty() {
                if let Ok(desc) = describe(&mut self.conn, sql).await {
                    for c in desc.columns() {
                        cols.push((c.name().to_string(), c.type_info().name().to_lowercase()));
                    }
                }
            }
            let total = out_rows.len() as u64;
            Ok(StatementOutcome::Rows { result: QueryResultSet { cols, rows: out_rows, total } })
        } else {
            let res = execute(&mut self.conn, sql)
                .await
                .map_err(|e| map_exec_error(self.system, &e))?;
            if util::is_dml(sql) {
                Ok(StatementOutcome::Affected { affected: res.rows_affected() })
            } else {
                Ok(StatementOutcome::Ok)
            }
        }
    }

    pub async fn ping(&mut self) -> bool {
        self.conn.ping().await.is_ok()
    }

    /// SELECT tham số hóa (filter builder / pagination).
    pub async fn exec_params(
        &mut self,
        sql: &str,
        params: &[serde_json::Value],
    ) -> Result<StatementOutcome, QueryError> {
        let rows = mysql_fetch_params(&mut self.conn, sql, params)
            .await
            .map_err(|e| map_exec_error(self.system, &e))?;
        let (cols, out_rows) = decode_rows(&rows);
        let total = out_rows.len() as u64;
        Ok(StatementOutcome::Rows { result: QueryResultSet { cols, rows: out_rows, total } })
    }

    /// Editable grid: pending changes trong 1 transaction (rollback nếu lỗi).
    pub async fn apply_changes(
        &mut self,
        changes: &[crate::drivers::grid::GridChange],
    ) -> Result<u64, QueryError> {
        execute(&mut self.conn, "START TRANSACTION")
            .await
            .map_err(|e| map_exec_error(self.system, &e))?;
        let mut total = 0u64;
        for ch in changes {
            let stmt = crate::drivers::grid::build(self.system, ch);
            match mysql_apply_one(&mut self.conn, &stmt.sql, &stmt.params).await {
                Ok(n) => total += n,
                Err(e) => {
                    let _ = execute(&mut self.conn, "ROLLBACK").await;
                    return Err(map_exec_error(self.system, &e));
                }
            }
        }
        execute(&mut self.conn, "COMMIT")
            .await
            .map_err(|e| map_exec_error(self.system, &e))?;
        Ok(total)
    }

    // ---- introspection ------------------------------------------------------
    // MySQL "schema" == database. The explorer shows the current database as
    // the single schema node (plus others the user can access).

    pub async fn schemas(&mut self) -> Result<Vec<SchemaInfo>, QueryError> {
        let rows = sqlx::query(
            // CONVERT both operands to utf8mb4 so the `=` shares one collation and
            // doesn't hit "Illegal mix of collations" (information_schema columns may be
            // utf8mb3 or utf8mb4 depending on the server; the connection is utf8mb4).
            // CAST the comparison to SIGNED + COALESCE(NULL DATABASE() → 0) so the flag
            // decodes reliably as i64 (a bare `=` result can come back as a type
            // try_get::<i64> rejects → is_default silently false → wrong default schema).
            "SELECT SCHEMA_NAME,
                    CAST(COALESCE(CONVERT(SCHEMA_NAME USING utf8mb4) = CONVERT(DATABASE() USING utf8mb4), 0) AS SIGNED)
             FROM information_schema.SCHEMATA
             WHERE SCHEMA_NAME NOT IN ('mysql','information_schema','performance_schema','sys')
             ORDER BY SCHEMA_NAME",
        )
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| SchemaInfo {
                name: text(r, 0),
                is_default: r.try_get::<i64, _>(1).map(|v| v != 0).unwrap_or(false),
            })
            .collect())
    }

    pub async fn tables(&mut self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        let rows = sqlx::query(
            // information_schema numeric columns are BIGINT UNSIGNED — CAST to SIGNED
            // so sqlx decodes them as i64 (otherwise try_get::<i64> silently yields None,
            // which is why row_estimate used to come back empty for MySQL).
            "SELECT TABLE_NAME,
                    CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' ELSE 'table' END,
                    CAST(COALESCE(TABLE_ROWS, 0) AS SIGNED),
                    CAST(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS SIGNED)
             FROM information_schema.TABLES
             WHERE CONVERT(TABLE_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4)
             ORDER BY TABLE_NAME",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| TableInfo {
                schema: schema.to_string(),
                name: text(r, 0),
                kind: text(r, 1),
                row_estimate: r.try_get::<i64, _>(2).ok(),
                locked: false,
                engine: None,
                data_length: r.try_get::<i64, _>(3).ok(),
            })
            .collect())
    }

    pub async fn columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE = 'YES', c.COLUMN_DEFAULT,
                    c.COLUMN_KEY = 'PRI',
                    EXISTS(SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k
                           WHERE CONVERT(k.TABLE_SCHEMA USING utf8mb4) = CONVERT(c.TABLE_SCHEMA USING utf8mb4)
                             AND CONVERT(k.TABLE_NAME USING utf8mb4) = CONVERT(c.TABLE_NAME USING utf8mb4)
                             AND CONVERT(k.COLUMN_NAME USING utf8mb4) = CONVERT(c.COLUMN_NAME USING utf8mb4)
                             AND k.REFERENCED_TABLE_NAME IS NOT NULL),
                    c.ORDINAL_POSITION,
                    INSTR(c.EXTRA, 'auto_increment') > 0
             FROM information_schema.COLUMNS c
             WHERE CONVERT(c.TABLE_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4)
               AND CONVERT(c.TABLE_NAME USING utf8mb4) = CONVERT(? USING utf8mb4)
             ORDER BY c.ORDINAL_POSITION",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| ColumnInfo {
                name: text(r, 0),
                data_type: text(r, 1),
                nullable: r.try_get::<i64, _>(2).map(|v| v != 0).unwrap_or(true),
                default: text_opt(r, 3),
                is_pk: r.try_get::<i64, _>(4).map(|v| v != 0).unwrap_or(false),
                is_fk: r.try_get::<i64, _>(5).map(|v| v != 0).unwrap_or(false),
                ordinal: r.try_get::<i64, _>(6).map(|v| v as i32).unwrap_or(0),
                auto_increment: r.try_get::<i64, _>(7).map(|v| v != 0).unwrap_or(false),
            })
            .collect())
    }

    pub async fn indexes(&mut self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT INDEX_NAME, INDEX_TYPE, NON_UNIQUE, COLUMN_NAME
             FROM information_schema.STATISTICS
             WHERE CONVERT(TABLE_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4)
               AND CONVERT(TABLE_NAME USING utf8mb4) = CONVERT(? USING utf8mb4)
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        let mut map: Vec<IndexInfo> = Vec::new();
        for r in &rows {
            let name: String = text(r, 0);
            let col: String = text(r, 3);
            if let Some(existing) = map.iter_mut().find(|i| i.name == name) {
                existing.columns.push(col);
            } else {
                map.push(IndexInfo {
                    primary: name == "PRIMARY",
                    name,
                    method: text(r, 1),
                    unique: r.try_get::<i64, _>(2).map(|v| v == 0).unwrap_or(false),
                    columns: vec![col],
                });
            }
        }
        Ok(map)
    }

    pub async fn constraints(&mut self, schema: &str, table: &str) -> Result<Vec<ConstraintInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT CONSTRAINT_NAME,
                    CASE CONSTRAINT_TYPE WHEN 'PRIMARY KEY' THEN 'PK' WHEN 'FOREIGN KEY' THEN 'FK'
                                         WHEN 'UNIQUE' THEN 'UNIQUE' ELSE CONSTRAINT_TYPE END
             FROM information_schema.TABLE_CONSTRAINTS
             WHERE CONVERT(TABLE_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4)
               AND CONVERT(TABLE_NAME USING utf8mb4) = CONVERT(? USING utf8mb4)
             ORDER BY CONSTRAINT_NAME",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| ConstraintInfo { name: text(r, 0), kind: text(r, 1), definition: None })
            .collect())
    }

    /// User-defined functions in `schema`. MySQL/MariaDB built-in functions are
    /// not listed in any catalog view, so the frontend merges those in from a
    /// static set; this only surfaces user routines of type FUNCTION.
    pub async fn functions(&mut self, schema: &str) -> Result<Vec<FunctionInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT r.ROUTINE_NAME
             FROM information_schema.ROUTINES r
             WHERE CONVERT(r.ROUTINE_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4)
               AND r.ROUTINE_TYPE = 'FUNCTION'
             ORDER BY r.ROUTINE_NAME",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| FunctionInfo { name: text(r, 0), signature: None, detail: Some("user".into()) })
            .collect())
    }

    pub async fn routines(&mut self, schema: &str) -> Result<Vec<RoutineInfo>, QueryError> {
        // information_schema.ROUTINES columns can carry a different collation than the
        // connection (e.g. utf8mb4_general_ci vs utf8mb4_0900_ai_ci), so `col = ?` raises
        // "Illegal mix of collations". CONVERT both to utf8mb4 → one shared collation.
        // (CONVERT — not COLLATE — because the column may be utf8mb3, where a utf8mb4
        // collation name is rejected outright.)
        let rows = sqlx::query(
            "SELECT r.ROUTINE_NAME, LOWER(r.ROUTINE_TYPE), COALESCE(r.DTD_IDENTIFIER, '')
             FROM information_schema.ROUTINES r
             WHERE CONVERT(r.ROUTINE_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4)
             ORDER BY r.ROUTINE_NAME",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        let mut out = Vec::new();
        for r in &rows {
            let name: String = text(r, 0);
            let kind: String = text(r, 1);
            let ret: String = text(r, 2);
            let params = self.routine_params(schema, &name).await.unwrap_or_default();
            out.push(RoutineInfo {
                schema: schema.to_string(),
                name,
                kind,
                params,
                return_type: if ret.is_empty() { None } else { Some(ret) },
            });
        }
        Ok(out)
    }

    async fn routine_params(&mut self, schema: &str, routine: &str) -> Result<Vec<ParamInfo>, QueryError> {
        let rows = sqlx::query(
            // CONVERT both operands to utf8mb4 to avoid the "Illegal mix of collations"
            // error against information_schema.PARAMETERS (see routines()).
            "SELECT COALESCE(PARAMETER_NAME, ''), COALESCE(DTD_IDENTIFIER, ''), COALESCE(PARAMETER_MODE, 'IN')
             FROM information_schema.PARAMETERS
             WHERE CONVERT(SPECIFIC_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4)
               AND CONVERT(SPECIFIC_NAME USING utf8mb4) = CONVERT(? USING utf8mb4) AND ORDINAL_POSITION > 0
             ORDER BY ORDINAL_POSITION",
        )
        .bind(schema)
        .bind(routine)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| ParamInfo {
                name: text(r, 0),
                data_type: text(r, 1),
                mode: text(r, 2),
                default: None,
            })
            .collect())
    }

    pub async fn triggers(&mut self, schema: &str) -> Result<Vec<TriggerInfo>, QueryError> {
        let rows = sqlx::query(
            // CONVERT both operands to utf8mb4 to avoid the "Illegal mix of collations"
            // error against information_schema.TRIGGERS (see routines()).
            "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION)
             FROM information_schema.TRIGGERS
             WHERE CONVERT(TRIGGER_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4)
             ORDER BY TRIGGER_NAME",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| TriggerInfo {
                schema: schema.to_string(),
                name: text(r, 0),
                table: text(r, 1),
                event: text(r, 2),
            })
            .collect())
    }

    pub fn system_name(&self) -> &'static str {
        self.system
    }

    pub async fn scan_indexes(&mut self, schema: &str) -> Result<Vec<crate::drivers::index_scan::IndexScanRow>, QueryError> {
        // information_schema.STATISTICS: 1 row/cột index → gộp theo (table, index).
        let rows = sqlx::query(
            "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE, INDEX_TYPE
             FROM information_schema.STATISTICS
             WHERE CONVERT(TABLE_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4)
             ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        use crate::drivers::index_scan::IndexScanRow;
        use std::collections::BTreeMap;
        let mut map: BTreeMap<(String, String), IndexScanRow> = BTreeMap::new();
        for r in &rows {
            let table: String = text(r, 0);
            let name: String = text(r, 1);
            let col: String = text(r, 2);
            let non_unique: i64 = r.try_get(4).unwrap_or(1);
            let itype: String = if text(r, 5).is_empty() { "BTREE".into() } else { text(r, 5) };
            let entry = map.entry((table.clone(), name.clone())).or_insert_with(|| IndexScanRow {
                name: name.clone(),
                table,
                columns: Vec::new(),
                index_type: itype,
                unique: non_unique == 0,
                primary: name == "PRIMARY",
                size_bytes: None,
                usage: None,
                fragmentation_pct: None,
                valid: true,
                flags: Vec::new(),
            });
            entry.columns.push(col);
        }
        Ok(map.into_values().collect())
    }

    pub async fn foreign_keys(&mut self, schema: &str) -> Result<Vec<ForeignKey>, QueryError> {
        let rows = sqlx::query(
            "SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE CONVERT(TABLE_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4) AND REFERENCED_TABLE_NAME IS NOT NULL
             ORDER BY TABLE_NAME, CONSTRAINT_NAME",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| ForeignKey {
                name: text(r, 0),
                from_table: text(r, 1),
                from_column: text(r, 2),
                to_table: text(r, 3),
                to_column: text(r, 4),
            })
            .collect())
    }

    /// Partitions from `information_schema.PARTITIONS`. Sub-partition rows are
    /// folded into their parent partition (rows summed, one row per partition).
    pub async fn partitions(
        &mut self,
        schema: &str,
        table: &str,
    ) -> Result<Vec<PartitionInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT PARTITION_NAME, PARTITION_METHOD, PARTITION_EXPRESSION,
                    MAX(PARTITION_DESCRIPTION), SUM(TABLE_ROWS), MIN(PARTITION_ORDINAL_POSITION)
             FROM information_schema.PARTITIONS
             WHERE CONVERT(TABLE_SCHEMA USING utf8mb4) = CONVERT(? USING utf8mb4)
               AND CONVERT(TABLE_NAME USING utf8mb4) = CONVERT(? USING utf8mb4)
               AND PARTITION_NAME IS NOT NULL
             GROUP BY PARTITION_NAME, PARTITION_METHOD, PARTITION_EXPRESSION
             ORDER BY MIN(PARTITION_ORDINAL_POSITION)",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| PartitionInfo {
                name: text(r, 0),
                method: text(r, 1),
                key: text_opt(r, 2),
                expression: text_opt(r, 3),
                rows: r.try_get::<i64, _>(4).ok(),
                position: r.try_get::<i64, _>(5).ok(),
            })
            .collect())
    }
}

// Monomorphic helpers with a named connection lifetime — see postgres.rs for
// why inline executor calls fail once the future is boxed/spawned.
// NOTE: `sqlx::query(sql)` (arguments = Some(empty)) always uses MySQL's binary
// PREPARED-statement protocol, which rejects several statements the editor may
// send with error 1295 ("not supported in the prepared statement protocol yet")
// — e.g. CREATE TRIGGER, SHOW CREATE …, some DDL. Passing the bare `&str` to the
// Executor (arguments = None) sends it via the TEXT protocol (COM_QUERY), which
// has no such restriction. Parameterized paths (exec_params) still prepare.
async fn fetch_all(
    conn: &mut MySqlConnection,
    sql: &str,
) -> Result<Vec<sqlx::mysql::MySqlRow>, sqlx::Error> {
    use sqlx::Executor;
    conn.fetch_all(sql).await
}

/// Read a possibly-binary text column as `String`. MySQL 8 returns many
/// `information_schema` string columns with the *binary* charset, so sqlx types
/// them as VARBINARY and a plain `String` decode PANICS — which crashed every
/// introspection call (schemas/tables/columns/…), leaving the Explorer tree
/// empty (AUDIT-5 item 4). Fall back to raw bytes → UTF-8 (lossy).
fn text(row: &sqlx::mysql::MySqlRow, idx: usize) -> String {
    row.try_get::<String, _>(idx)
        .or_else(|_| row.try_get::<Vec<u8>, _>(idx).map(|b| String::from_utf8_lossy(&b).into_owned()))
        .unwrap_or_default()
}

/// Lowercase `0x…` hex rendering of raw bytes (genuine binary values).
fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Text interpretation of bytes from a string-carrying binary column: `Some` when
/// valid UTF-8 with no NUL byte (a `_bin`-collation VARCHAR/TEXT arrives here typed
/// as VARBINARY/BLOB); `None` for genuine binary. The NUL guard keeps binary blobs
/// that happen to be valid UTF-8 from being read as garbled text.
fn text_from_binary(bytes: &[u8]) -> Option<String> {
    match std::str::from_utf8(bytes) {
        Ok(s) if !s.contains('\0') => Some(s.to_string()),
        _ => None,
    }
}

/// Render bytes from a string-carrying binary column: the decoded text if it looks
/// like text, otherwise a `0x…` hex string (genuine binary).
fn bytes_to_value(bytes: Vec<u8>) -> Value {
    match text_from_binary(&bytes) {
        Some(s) => Value::String(s),
        None => Value::String(to_hex(&bytes)),
    }
}

/// sqlx names a `_bin`-collation VARCHAR/CHAR/TEXT column with these binary types
/// because MySQL sets the BINARY_FLAG on it (see `decode_value`).
fn is_binary_family(type_name: &str) -> bool {
    matches!(
        type_name,
        "varbinary" | "binary" | "blob" | "tinyblob" | "mediumblob" | "longblob"
    )
}

/// The text type that a binary type maps back to, for a column that actually
/// carried text (mirrors sqlx's own binary↔text naming). Used to correct the
/// reported column type in the result header so it reads `varchar`, not `varbinary`.
fn text_type_for(binary_type: &str) -> String {
    match binary_type {
        "varbinary" => "varchar",
        "binary" => "char",
        "tinyblob" => "tinytext",
        "mediumblob" => "mediumtext",
        "longblob" => "longtext",
        _ => "text", // blob
    }
    .to_string()
}

/// Decode a MySQL result set into (column defs, JSON rows). Besides decoding each
/// cell, this corrects the reported type of any string-carrying binary column
/// whose values were ALL text (a `_bin`-collation VARCHAR reads back as VARBINARY):
/// its header type is relabelled to the text equivalent so the grid shows
/// `varchar` instead of `varbinary`. A column stays binary if any value was
/// genuine binary (or it had no non-null value to judge from).
fn decode_rows(rows: &[sqlx::mysql::MySqlRow]) -> (Vec<ColumnDef>, Vec<Value>) {
    let mut cols: Vec<ColumnDef> = Vec::new();
    if let Some(first) = rows.first() {
        for c in first.columns() {
            cols.push((c.name().to_string(), c.type_info().name().to_lowercase()));
        }
    }
    let n = cols.len();
    // Pre-own the column names once — the per-cell insert then clones an owned
    // String rather than re-deriving it from the row's column metadata every row.
    let names: Vec<String> = cols.iter().map(|(nm, _)| nm.clone()).collect();
    let bin_family: Vec<bool> = cols.iter().map(|(_, t)| is_binary_family(t)).collect();
    let mut all_text = vec![true; n]; // no genuine-binary value seen yet
    let mut has_value = vec![false; n]; // at least one non-null value seen

    let mut out_rows: Vec<Value> = Vec::with_capacity(rows.len());
    for row in rows {
        let mut obj = Map::new();
        for i in 0..n {
            let v = if bin_family[i] {
                // String-carrying binary column (`_bin`-collation VARCHAR etc.):
                // decode the bytes ONCE and both classify (text vs genuine binary)
                // AND build the value from them. Previously every such cell — NULLs
                // included — was decoded twice (decode_value + a separate relabel
                // try_get), which on a wide table adds up (measured ~15% on a 35-col
                // 100k-row result). NULL cells now cost a single cheap try_get.
                match row.try_get::<Option<Vec<u8>>, _>(i) {
                    Ok(Some(bytes)) => {
                        has_value[i] = true;
                        match text_from_binary(&bytes) {
                            Some(s) => Value::String(s),
                            None => {
                                all_text[i] = false;
                                Value::String(to_hex(&bytes))
                            }
                        }
                    }
                    _ => Value::Null,
                }
            } else {
                decode_value(row, i)
            };
            obj.insert(names[i].clone(), v);
        }
        out_rows.push(Value::Object(obj));
    }

    for i in 0..n {
        if bin_family[i] && has_value[i] && all_text[i] {
            cols[i].1 = text_type_for(&cols[i].1);
        }
    }
    (cols, out_rows)
}

/// Like [`text`] but preserves SQL NULL as `None` (nullable columns, e.g. defaults).
fn text_opt(row: &sqlx::mysql::MySqlRow, idx: usize) -> Option<String> {
    row.try_get::<Option<String>, _>(idx)
        .or_else(|_| {
            row.try_get::<Option<Vec<u8>>, _>(idx)
                .map(|o| o.map(|b| String::from_utf8_lossy(&b).into_owned()))
        })
        .ok()
        .flatten()
}

fn bind_mysql<'q>(
    mut q: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    params: &'q [serde_json::Value],
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    use serde_json::Value;
    for p in params {
        q = match p {
            Value::Null => q.bind(Option::<String>::None),
            Value::Bool(b) => q.bind(*b),
            Value::Number(num) if num.is_i64() => q.bind(num.as_i64().unwrap()),
            Value::Number(num) if num.is_u64() => q.bind(num.as_u64().unwrap() as i64),
            Value::Number(num) => q.bind(num.as_f64().unwrap()),
            Value::String(s) => q.bind(s.clone()),
            other => q.bind(other.to_string()),
        };
    }
    q
}

async fn mysql_apply_one(
    conn: &mut MySqlConnection,
    sql: &str,
    params: &[serde_json::Value],
) -> Result<u64, sqlx::Error> {
    Ok(bind_mysql(sqlx::query(sql), params).execute(conn).await?.rows_affected())
}

async fn mysql_fetch_params(
    conn: &mut MySqlConnection,
    sql: &str,
    params: &[serde_json::Value],
) -> Result<Vec<sqlx::mysql::MySqlRow>, sqlx::Error> {
    bind_mysql(sqlx::query(sql), params).fetch_all(conn).await
}

async fn execute(
    conn: &mut MySqlConnection,
    sql: &str,
) -> Result<sqlx::mysql::MySqlQueryResult, sqlx::Error> {
    // Text protocol (see `fetch_all` note) so DDL like CREATE TRIGGER succeeds.
    use sqlx::Executor;
    conn.execute(sql).await
}

async fn describe(
    conn: &mut MySqlConnection,
    sql: &str,
) -> Result<sqlx::Describe<sqlx::MySql>, sqlx::Error> {
    conn.describe(sql).await
}

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

fn decode_value(row: &sqlx::mysql::MySqlRow, idx: usize) -> Value {
    use sqlx::ValueRef;
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_uppercase();
    match type_name.as_str() {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => row
            .try_get::<i64, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" => row.try_get::<u64, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "FLOAT" => row.try_get::<f32, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "DOUBLE" => row.try_get::<f64, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "DECIMAL" => row
            .try_get::<bigdecimal::BigDecimal, _>(idx)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        "BOOLEAN" | "BOOL" => row.try_get::<bool, _>(idx).map(Value::Bool).unwrap_or(Value::Null),
        "JSON" => row.try_get::<Value, _>(idx).unwrap_or(Value::Null),
        "DATETIME" => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|v| Value::String(v.format("%Y-%m-%dT%H:%M:%S%.f").to_string()))
            .unwrap_or(Value::Null),
        "TIMESTAMP" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .map(|v| Value::String(v.to_rfc3339()))
            .unwrap_or(Value::Null),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        "TIME" => row
            .try_get::<chrono::NaiveTime, _>(idx)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        // String-carrying binary family. A VARCHAR/CHAR/TEXT column with a `_bin`
        // collation (e.g. utf8_bin) makes MySQL set the protocol BINARY_FLAG, so
        // sqlx types it VARBINARY/BINARY/BLOB even though the bytes are real UTF-8
        // text. Decode as UTF-8 first (like the `text()` introspection helper) so
        // such text isn't dumped as `0x…`; genuine binary (not valid UTF-8, or
        // containing a NUL) still falls back to a hex string.
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "VARBINARY" | "BINARY" => row
            .try_get::<Vec<u8>, _>(idx)
            .map(bytes_to_value)
            .unwrap_or(Value::Null),
        // BIT is a bit-field, not mis-typed text — keep it as a hex string.
        "BIT" => row
            .try_get::<Vec<u8>, _>(idx)
            .map(|v| Value::String(to_hex(&v)))
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<String, _>(idx)
            .map(Value::String)
            .unwrap_or_else(|_| Value::String(format!("<{}>", type_name.to_lowercase()))),
    }
}

// ---------------------------------------------------------------------------
// Error mapping — MySQL has errno + "near '...' at line N" (best-effort)
// ---------------------------------------------------------------------------

fn map_error(system: &str, e: &sqlx::Error) -> QueryError {
    match e {
        sqlx::Error::Database(db) => {
            let raw = db.to_string();
            let message = db.message().to_string();
            let code = db.code().map(|c| c.to_string());
            let mut qe = QueryError::new(system, message, raw);
            qe.hint = code.as_deref().and_then(hint_for_code);
            qe.code = code;
            qe
        }
        other => QueryError::new(system, other.to_string(), other.to_string()),
    }
}

fn map_exec_error(system: &str, e: &sqlx::Error) -> QueryError {
    let mut qe = map_error(system, e);
    // "... near 'xyz' at line N" → line within the statement (no column).
    if let Some(caps) = Regex::new(r"at line (\d+)")
        .ok()
        .and_then(|re| re.captures(&qe.raw))
    {
        if let Some(line) = caps.get(1).and_then(|m| m.as_str().parse::<u32>().ok()) {
            qe.position = Some(ErrorPosition { line, col: 1 });
        }
    }
    qe
}

fn hint_for_code(code: &str) -> Option<String> {
    let hint = match code {
        // sqlx exposes SQLSTATE-style codes for MySQL where available
        "42S02" => "Table does not exist. Check the table name or the current database.",
        "42S22" => "Column does not exist. Check the column name.",
        "42000" => "Syntax error or insufficient permissions.",
        "28000" => "Wrong user or password.",
        "23000" => "Constraint violation (duplicate key / foreign key).",
        "3D000" => "No database selected. Add `USE db` or set the database in the connection.",
        _ => return None,
    };
    Some(hint.to_string())
}

#[cfg(test)]
mod tests {
    use super::{bytes_to_value, is_binary_family, text_from_binary, text_type_for, to_hex};
    use serde_json::json;

    #[test]
    fn to_hex_prefixes_and_lowercases() {
        assert_eq!(to_hex(&[]), "0x");
        assert_eq!(to_hex(&[0x00, 0xff, 0x01, 0xfe]), "0x00ff01fe");
        assert_eq!(to_hex(b"PT"), "0x5054");
    }

    #[test]
    fn bin_collation_text_decodes_as_utf8() {
        // A `_bin`-collation VARCHAR arrives typed as VARBINARY; its bytes are
        // real UTF-8 text and must be returned as text, not a `0x…` dump.
        assert_eq!(bytes_to_value(b"PT-d49534d4".to_vec()), json!("PT-d49534d4"));
        // multibyte UTF-8 (Vietnamese) round-trips as text
        assert_eq!(bytes_to_value("Nguyễn".as_bytes().to_vec()), json!("Nguyễn"));
        assert_eq!(bytes_to_value(vec![]), json!(""));
    }

    #[test]
    fn genuine_binary_stays_hex() {
        // invalid UTF-8 (0xff lead byte) → hex
        assert_eq!(bytes_to_value(vec![0x00, 0xff, 0x01, 0xfe]), json!("0x00ff01fe"));
        // valid UTF-8 but contains a NUL → treated as binary (hex), not text
        assert_eq!(bytes_to_value(vec![0x41, 0x00, 0x42]), json!("0x410042"));
    }

    #[test]
    fn text_from_binary_distinguishes_text_and_binary() {
        assert_eq!(text_from_binary(b"PT-d49534d4").as_deref(), Some("PT-d49534d4"));
        assert!(text_from_binary(&[0x00, 0xff]).is_none()); // invalid UTF-8
        assert!(text_from_binary(&[0x41, 0x00]).is_none()); // NUL present
    }

    #[test]
    fn binary_family_and_text_remap() {
        assert!(is_binary_family("varbinary"));
        assert!(is_binary_family("longblob"));
        assert!(!is_binary_family("bit")); // bit stays hex, never remapped
        assert!(!is_binary_family("varchar"));
        // header remap mirrors sqlx's binary↔text naming
        assert_eq!(text_type_for("varbinary"), "varchar");
        assert_eq!(text_type_for("binary"), "char");
        assert_eq!(text_type_for("blob"), "text");
        assert_eq!(text_type_for("tinyblob"), "tinytext");
        assert_eq!(text_type_for("mediumblob"), "mediumtext");
        assert_eq!(text_type_for("longblob"), "longtext");
    }
}
