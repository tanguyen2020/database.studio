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
            let mut cols: Vec<ColumnDef> = Vec::new();
            if let Some(first) = rows.first() {
                for c in first.columns() {
                    cols.push((c.name().to_string(), c.type_info().name().to_lowercase()));
                }
            } else if let Ok(desc) = describe(&mut self.conn, sql).await {
                for c in desc.columns() {
                    cols.push((c.name().to_string(), c.type_info().name().to_lowercase()));
                }
            }
            let mut out_rows: Vec<Value> = Vec::new();
            for row in &rows {
                let mut obj = Map::new();
                for (i, c) in row.columns().iter().enumerate() {
                    obj.insert(c.name().to_string(), decode_value(row, i));
                }
                out_rows.push(Value::Object(obj));
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
        let mut cols: Vec<ColumnDef> = Vec::new();
        if let Some(first) = rows.first() {
            for c in first.columns() {
                cols.push((c.name().to_string(), c.type_info().name().to_lowercase()));
            }
        }
        let mut out_rows: Vec<Value> = Vec::new();
        for row in &rows {
            let mut obj = Map::new();
            for (i, c) in row.columns().iter().enumerate() {
                obj.insert(c.name().to_string(), decode_value(row, i));
            }
            out_rows.push(Value::Object(obj));
        }
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
            "SELECT SCHEMA_NAME, SCHEMA_NAME = DATABASE()
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
                name: r.get(0),
                is_default: r.try_get::<i64, _>(1).map(|v| v != 0).unwrap_or(false),
            })
            .collect())
    }

    pub async fn tables(&mut self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME,
                    CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' ELSE 'table' END,
                    COALESCE(TABLE_ROWS, 0)
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ?
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
                name: r.get(0),
                kind: r.get(1),
                row_estimate: r.try_get::<i64, _>(2).ok(),
                locked: false,
                engine: None,
            })
            .collect())
    }

    pub async fn columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE = 'YES', c.COLUMN_DEFAULT,
                    c.COLUMN_KEY = 'PRI',
                    EXISTS(SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k
                           WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
                             AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL),
                    c.ORDINAL_POSITION
             FROM information_schema.COLUMNS c
             WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
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
                name: r.get(0),
                data_type: r.get(1),
                nullable: r.try_get::<i64, _>(2).map(|v| v != 0).unwrap_or(true),
                default: r.try_get(3).ok(),
                is_pk: r.try_get::<i64, _>(4).map(|v| v != 0).unwrap_or(false),
                is_fk: r.try_get::<i64, _>(5).map(|v| v != 0).unwrap_or(false),
                ordinal: r.try_get::<i64, _>(6).map(|v| v as i32).unwrap_or(0),
            })
            .collect())
    }

    pub async fn indexes(&mut self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT INDEX_NAME, INDEX_TYPE, NON_UNIQUE, COLUMN_NAME
             FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        let mut map: Vec<IndexInfo> = Vec::new();
        for r in &rows {
            let name: String = r.get(0);
            let col: String = r.get(3);
            if let Some(existing) = map.iter_mut().find(|i| i.name == name) {
                existing.columns.push(col);
            } else {
                map.push(IndexInfo {
                    primary: name == "PRIMARY",
                    name,
                    method: r.get::<String, _>(1),
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
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
             ORDER BY CONSTRAINT_NAME",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| ConstraintInfo { name: r.get(0), kind: r.get(1), definition: None })
            .collect())
    }

    pub async fn routines(&mut self, schema: &str) -> Result<Vec<RoutineInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT r.ROUTINE_NAME, LOWER(r.ROUTINE_TYPE), COALESCE(r.DTD_IDENTIFIER, '')
             FROM information_schema.ROUTINES r
             WHERE r.ROUTINE_SCHEMA = ?
             ORDER BY r.ROUTINE_NAME",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        let mut out = Vec::new();
        for r in &rows {
            let name: String = r.get(0);
            let kind: String = r.get(1);
            let ret: String = r.get(2);
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
            "SELECT COALESCE(PARAMETER_NAME, ''), COALESCE(DTD_IDENTIFIER, ''), COALESCE(PARAMETER_MODE, 'IN')
             FROM information_schema.PARAMETERS
             WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ORDINAL_POSITION > 0
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
                name: r.get(0),
                data_type: r.get(1),
                mode: r.get(2),
                default: None,
            })
            .collect())
    }

    pub async fn triggers(&mut self, schema: &str) -> Result<Vec<TriggerInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION)
             FROM information_schema.TRIGGERS
             WHERE TRIGGER_SCHEMA = ?
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
                name: r.get(0),
                table: r.get(1),
                event: r.get(2),
            })
            .collect())
    }

    pub async fn foreign_keys(&mut self, schema: &str) -> Result<Vec<ForeignKey>, QueryError> {
        let rows = sqlx::query(
            "SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
             ORDER BY TABLE_NAME, CONSTRAINT_NAME",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error(self.system, &e))?;
        Ok(rows
            .iter()
            .map(|r| ForeignKey {
                name: r.get(0),
                from_table: r.get(1),
                from_column: r.get(2),
                to_table: r.get(3),
                to_column: r.get(4),
            })
            .collect())
    }
}

// Monomorphic helpers with a named connection lifetime — see postgres.rs for
// why inline executor calls fail once the future is boxed/spawned.
async fn fetch_all(
    conn: &mut MySqlConnection,
    sql: &str,
) -> Result<Vec<sqlx::mysql::MySqlRow>, sqlx::Error> {
    sqlx::query(sql).fetch_all(conn).await
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
    sqlx::query(sql).execute(conn).await
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
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "VARBINARY" | "BINARY" | "BIT" => row
            .try_get::<Vec<u8>, _>(idx)
            .map(|v| Value::String(format!("0x{}", v.iter().map(|b| format!("{b:02x}")).collect::<String>())))
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
        "42S02" => "Bảng không tồn tại. Kiểm tra tên bảng hoặc database hiện tại.",
        "42S22" => "Cột không tồn tại. Kiểm tra tên cột.",
        "42000" => "Lỗi cú pháp hoặc không có quyền.",
        "28000" => "Sai user hoặc mật khẩu.",
        "23000" => "Vi phạm ràng buộc (duplicate key / foreign key).",
        "3D000" => "Chưa chọn database. Thêm `USE db` hoặc đặt database trong connection.",
        _ => return None,
    };
    Some(hint.to_string())
}
