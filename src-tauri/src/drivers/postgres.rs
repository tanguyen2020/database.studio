//! PostgreSQL driver — sqlx, single dedicated connection per profile.

use serde_json::{json, Map, Value};
use sqlx::postgres::{PgConnectOptions, PgConnection, PgDatabaseError, PgSslMode};
use sqlx::{Column, ConnectOptions, Connection, Executor, Row, TypeInfo};
use std::time::Instant;

use crate::drivers::types::*;
use crate::drivers::util;
use crate::error::{ErrorPosition, QueryError};

pub struct PgDriver {
    conn: PgConnection,
}

pub struct PgConnParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub ssl: bool,
    /// TLS cert paths (empty = none). ssl_ca → verify-ca root; cert+key → mTLS.
    pub ssl_ca: String,
    pub ssl_cert: String,
    pub ssl_key: String,
}

impl PgDriver {
    pub async fn connect(p: &PgConnParams) -> Result<Self, QueryError> {
        let mut opts = PgConnectOptions::new()
            .host(&p.host)
            .port(p.port)
            .database(if p.database.is_empty() { "postgres" } else { &p.database })
            .username(&p.user)
            .password(&p.password)
            // Có CA → VerifyCa (xác thực chuỗi cert); còn lại Require/Prefer.
            .ssl_mode(if !p.ssl_ca.is_empty() {
                PgSslMode::VerifyCa
            } else if p.ssl {
                PgSslMode::Require
            } else {
                PgSslMode::Prefer
            });
        if !p.ssl_ca.is_empty() {
            opts = opts.ssl_root_cert(&p.ssl_ca);
        }
        if !p.ssl_cert.is_empty() {
            opts = opts.ssl_client_cert(&p.ssl_cert);
        }
        if !p.ssl_key.is_empty() {
            opts = opts.ssl_client_key(&p.ssl_key);
        }
        let conn = opts
            .connect()
            .await
            .map_err(|e| map_error("postgres", &e))?;
        Ok(Self { conn })
    }

    pub async fn test(p: &PgConnParams) -> TestResult {
        let started = Instant::now();
        match Self::connect(p).await {
            Ok(mut drv) => {
                let version: Option<String> = sqlx::query_scalar("SELECT version()")
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
            Err(e) => TestResult {
                ok: false,
                latency_ms: None,
                server_version: None,
                error: Some(e.message),
            },
        }
    }

    pub async fn exec(&mut self, sql: &str) -> Result<StatementOutcome, QueryError> {
        if util::returns_rows(sql) {
            let rows = fetch_all(&mut self.conn, sql)
                .await
                .map_err(|e| map_exec_error("postgres", sql, &e))?;
            let mut cols: Vec<ColumnDef> = Vec::new();
            let mut out_rows: Vec<Value> = Vec::new();
            if let Some(first) = rows.first() {
                for c in first.columns() {
                    cols.push((c.name().to_string(), c.type_info().name().to_lowercase()));
                }
            } else if let Ok(desc) = describe(&mut self.conn, sql).await {
                // Zero rows: describe the statement to still get column headers.
                for c in desc.columns() {
                    cols.push((c.name().to_string(), c.type_info().name().to_lowercase()));
                }
            }
            for row in &rows {
                let mut obj = Map::new();
                for (i, c) in row.columns().iter().enumerate() {
                    obj.insert(c.name().to_string(), decode_value(row, i));
                }
                out_rows.push(Value::Object(obj));
            }
            let total = out_rows.len() as u64;
            Ok(StatementOutcome::Rows {
                result: QueryResultSet { cols, rows: out_rows, total },
            })
        } else {
            let res = execute(&mut self.conn, sql)
                .await
                .map_err(|e| map_exec_error("postgres", sql, &e))?;
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

    /// SELECT tham số hóa (filter builder / pagination) — bind giá trị filter.
    pub async fn exec_params(
        &mut self,
        sql: &str,
        params: &[Value],
    ) -> Result<StatementOutcome, QueryError> {
        let rows = pg_fetch_params(&mut self.conn, sql, params)
            .await
            .map_err(|e| map_exec_error("postgres", sql, &e))?;
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

    /// Editable grid: áp pending changes trong 1 transaction, rollback nếu lỗi.
    /// Statement tham số hóa ($1..) — value bind qua sqlx (không nối chuỗi).
    pub async fn apply_changes(
        &mut self,
        changes: &[crate::drivers::grid::GridChange],
    ) -> Result<u64, QueryError> {
        execute(&mut self.conn, "BEGIN")
            .await
            .map_err(|e| map_exec_error("postgres", "BEGIN", &e))?;
        let mut total = 0u64;
        for ch in changes {
            let stmt = crate::drivers::grid::build("postgres", ch);
            match pg_apply_one(&mut self.conn, &stmt.sql, &stmt.params).await {
                Ok(n) => total += n,
                Err(e) => {
                    let _ = execute(&mut self.conn, "ROLLBACK").await;
                    return Err(map_exec_error("postgres", &stmt.sql, &e));
                }
            }
        }
        execute(&mut self.conn, "COMMIT")
            .await
            .map_err(|e| map_exec_error("postgres", "COMMIT", &e))?;
        Ok(total)
    }

    // ---- introspection ------------------------------------------------------

    pub async fn schemas(&mut self) -> Result<Vec<SchemaInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT nspname, nspname = current_schema() AS is_default
             FROM pg_catalog.pg_namespace
             WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
             ORDER BY nspname",
        )
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error("postgres", &e))?;
        Ok(rows
            .iter()
            .map(|r| SchemaInfo {
                name: r.get::<String, _>(0),
                is_default: r.try_get::<bool, _>(1).unwrap_or(false),
            })
            .collect())
    }

    pub async fn tables(&mut self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT c.relname,
                    CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END AS kind,
                    GREATEST(c.reltuples::bigint, 0) AS row_estimate
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m')
             ORDER BY c.relname",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error("postgres", &e))?;
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
            "SELECT a.attname,
                    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                    NOT a.attnotnull AS nullable,
                    pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr,
                    COALESCE(pk.is_pk, false) AS is_pk,
                    COALESCE(fk.is_fk, false) AS is_fk,
                    a.attnum::int AS ordinal
             FROM pg_catalog.pg_attribute a
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             LEFT JOIN LATERAL (
               SELECT true AS is_pk FROM pg_catalog.pg_constraint ct
               WHERE ct.conrelid = c.oid AND ct.contype = 'p' AND a.attnum = ANY(ct.conkey)
               LIMIT 1) pk ON true
             LEFT JOIN LATERAL (
               SELECT true AS is_fk FROM pg_catalog.pg_constraint ct
               WHERE ct.conrelid = c.oid AND ct.contype = 'f' AND a.attnum = ANY(ct.conkey)
               LIMIT 1) fk ON true
             WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error("postgres", &e))?;
        Ok(rows
            .iter()
            .map(|r| ColumnInfo {
                name: r.get(0),
                data_type: r.get(1),
                nullable: r.get(2),
                default: r.try_get(3).ok(),
                is_pk: r.get(4),
                is_fk: r.get(5),
                ordinal: r.get(6),
            })
            .collect())
    }

    pub async fn indexes(&mut self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT i.relname AS index_name,
                    am.amname AS method,
                    ix.indisunique,
                    ix.indisprimary,
                    ARRAY(
                      SELECT pg_catalog.pg_get_indexdef(ix.indexrelid, k + 1, true)
                      FROM generate_subscripts(ix.indkey, 1) AS k ORDER BY k
                    ) AS cols
             FROM pg_catalog.pg_index ix
             JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
             JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_catalog.pg_am am ON am.oid = i.relam
             WHERE n.nspname = $1 AND t.relname = $2
             ORDER BY i.relname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error("postgres", &e))?;
        Ok(rows
            .iter()
            .map(|r| IndexInfo {
                name: r.get(0),
                method: r.get::<String, _>(1).to_uppercase(),
                unique: r.get(2),
                primary: r.get(3),
                columns: r.try_get::<Vec<String>, _>(4).unwrap_or_default(),
            })
            .collect())
    }

    pub async fn constraints(&mut self, schema: &str, table: &str) -> Result<Vec<ConstraintInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT ct.conname,
                    CASE ct.contype WHEN 'p' THEN 'PK' WHEN 'f' THEN 'FK'
                                    WHEN 'u' THEN 'UNIQUE' WHEN 'c' THEN 'CHECK' ELSE upper(ct.contype::text) END,
                    pg_catalog.pg_get_constraintdef(ct.oid, true)
             FROM pg_catalog.pg_constraint ct
             JOIN pg_catalog.pg_class t ON t.oid = ct.conrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = $1 AND t.relname = $2
             ORDER BY ct.conname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error("postgres", &e))?;
        Ok(rows
            .iter()
            .map(|r| ConstraintInfo {
                name: r.get(0),
                kind: r.get(1),
                definition: r.try_get(2).ok(),
            })
            .collect())
    }

    pub async fn routines(&mut self, schema: &str) -> Result<Vec<RoutineInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT p.proname,
                    CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
                    COALESCE(pg_catalog.pg_get_function_arguments(p.oid), '') AS args,
                    COALESCE(pg_catalog.pg_get_function_result(p.oid), '') AS result
             FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = $1 AND p.prokind IN ('f','p')
             ORDER BY p.proname",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error("postgres", &e))?;
        Ok(rows
            .iter()
            .map(|r| {
                let args: String = r.get(2);
                let params = parse_pg_args(&args);
                let kind: String = r.get(1);
                let ret: String = r.get(3);
                RoutineInfo {
                    schema: schema.to_string(),
                    name: r.get(0),
                    kind,
                    params,
                    return_type: if ret.is_empty() { None } else { Some(ret) },
                }
            })
            .collect())
    }

    pub async fn triggers(&mut self, schema: &str) -> Result<Vec<TriggerInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT t.tgname, c.relname,
                    CASE WHEN t.tgtype & 2 > 0 THEN 'BEFORE'
                         WHEN t.tgtype & 64 > 0 THEN 'INSTEAD OF' ELSE 'AFTER' END ||
                    ' ' ||
                    concat_ws(',',
                      CASE WHEN t.tgtype & 4  > 0 THEN 'INSERT' END,
                      CASE WHEN t.tgtype & 8  > 0 THEN 'DELETE' END,
                      CASE WHEN t.tgtype & 16 > 0 THEN 'UPDATE' END,
                      CASE WHEN t.tgtype & 32 > 0 THEN 'TRUNCATE' END) AS event
             FROM pg_catalog.pg_trigger t
             JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND NOT t.tgisinternal
             ORDER BY t.tgname",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error("postgres", &e))?;
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

    pub async fn sequences(&mut self, schema: &str) -> Result<Vec<SequenceInfo>, QueryError> {
        let rows = sqlx::query(
            "SELECT c.relname FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relkind = 'S' ORDER BY c.relname",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error("postgres", &e))?;
        Ok(rows
            .iter()
            .map(|r| SequenceInfo { schema: schema.to_string(), name: r.get(0) })
            .collect())
    }

    pub async fn scan_indexes(&mut self, schema: &str) -> Result<Vec<crate::drivers::index_scan::IndexScanRow>, QueryError> {
        let rows = sqlx::query(
            "SELECT i.relname AS name, t.relname AS tbl,
                    ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                          FROM generate_subscripts(ix.indkey, 1) k ORDER BY k) AS cols,
                    am.amname AS itype, ix.indisunique, ix.indisprimary, ix.indisvalid,
                    pg_relation_size(i.oid) AS sz,
                    COALESCE(st.idx_scan, 0) AS usage
             FROM pg_index ix
             JOIN pg_class i ON i.oid = ix.indexrelid
             JOIN pg_class t ON t.oid = ix.indrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_am am ON am.oid = i.relam
             LEFT JOIN pg_stat_user_indexes st ON st.indexrelid = ix.indexrelid
             WHERE n.nspname = $1
             ORDER BY t.relname, i.relname",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error("postgres", &e))?;
        Ok(rows
            .iter()
            .map(|r| crate::drivers::index_scan::IndexScanRow {
                name: r.get(0),
                table: r.get(1),
                columns: r.try_get::<Vec<String>, _>(2).unwrap_or_default(),
                index_type: r.get::<String, _>(3).to_uppercase(),
                unique: r.get(4),
                primary: r.get(5),
                valid: r.get(6),
                size_bytes: r.try_get::<i64, _>(7).ok(),
                usage: r.try_get::<i64, _>(8).ok(),
                fragmentation_pct: None,
                flags: Vec::new(),
            })
            .collect())
    }

    pub async fn foreign_keys(&mut self, schema: &str) -> Result<Vec<ForeignKey>, QueryError> {
        let rows = sqlx::query(
            "SELECT tc.constraint_name, kcu.table_name, kcu.column_name,
                    ccu.table_name AS ref_table, ccu.column_name AS ref_col
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
             JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
             WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
             ORDER BY kcu.table_name, tc.constraint_name",
        )
        .bind(schema)
        .fetch_all(&mut self.conn)
        .await
        .map_err(|e| map_error("postgres", &e))?;
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

// Monomorphic helpers with a *named* connection lifetime. Calling sqlx
// executor methods on `&mut self.conn` inline creates a for<'any> Executor
// obligation the trait solver cannot discharge once the future is boxed/spawned
// ("implementation of Executor is not general enough").
async fn fetch_all(
    conn: &mut PgConnection,
    sql: &str,
) -> Result<Vec<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query(sql).fetch_all(conn).await
}

async fn execute(
    conn: &mut PgConnection,
    sql: &str,
) -> Result<sqlx::postgres::PgQueryResult, sqlx::Error> {
    sqlx::query(sql).execute(conn).await
}

/// Bind JSON params rồi fetch (monomorphic — tránh HRTB).
async fn pg_fetch_params(
    conn: &mut PgConnection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<sqlx::postgres::PgRow>, sqlx::Error> {
    let mut q = sqlx::query(sql);
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
    q.fetch_all(conn).await
}

/// Bind JSON params rồi execute (monomorphic — tránh HRTB "Executor not general enough").
async fn pg_apply_one(
    conn: &mut PgConnection,
    sql: &str,
    params: &[Value],
) -> Result<u64, sqlx::Error> {
    let mut q = sqlx::query(sql);
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
    Ok(q.execute(conn).await?.rows_affected())
}

async fn describe(
    conn: &mut PgConnection,
    sql: &str,
) -> Result<sqlx::Describe<sqlx::Postgres>, sqlx::Error> {
    conn.describe(sql).await
}

/// "name type, name type DEFAULT x" → params (best-effort split).
fn parse_pg_args(args: &str) -> Vec<ParamInfo> {
    if args.trim().is_empty() {
        return Vec::new();
    }
    args.split(',')
        .map(|raw| {
            let raw = raw.trim();
            let mut mode = "IN".to_string();
            let mut rest = raw;
            for m in ["INOUT ", "OUT ", "IN ", "VARIADIC "] {
                if let Some(r) = rest.strip_prefix(m) {
                    mode = m.trim().to_string();
                    rest = r;
                    break;
                }
            }
            let (decl, default) = match rest.split_once(" DEFAULT ") {
                Some((d, def)) => (d.trim(), Some(def.trim().to_string())),
                None => (rest, None),
            };
            let (name, dtype) = match decl.split_once(' ') {
                Some((n, t)) => (n.to_string(), t.to_string()),
                None => (String::new(), decl.to_string()),
            };
            ParamInfo { name, data_type: dtype, mode, default }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

fn decode_value(row: &sqlx::postgres::PgRow, idx: usize) -> Value {
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
        "INT2" => row.try_get::<i16, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "INT4" => row.try_get::<i32, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "INT8" | "OID" => row.try_get::<i64, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "FLOAT4" => row.try_get::<f32, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "FLOAT8" => row.try_get::<f64, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "NUMERIC" => row
            .try_get::<bigdecimal::BigDecimal, _>(idx)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        "BOOL" => row.try_get::<bool, _>(idx).map(Value::Bool).unwrap_or(Value::Null),
        "UUID" => row
            .try_get::<uuid::Uuid, _>(idx)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        "JSON" | "JSONB" => row.try_get::<Value, _>(idx).unwrap_or(Value::Null),
        "TIMESTAMPTZ" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .map(|v| Value::String(v.to_rfc3339()))
            .unwrap_or(Value::Null),
        "TIMESTAMP" => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|v| Value::String(v.format("%Y-%m-%dT%H:%M:%S%.f").to_string()))
            .unwrap_or(Value::Null),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        "TIME" => row
            .try_get::<chrono::NaiveTime, _>(idx)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        "BYTEA" => row
            .try_get::<Vec<u8>, _>(idx)
            .map(|v| Value::String(format!("\\x{}", hex_encode(&v))))
            .unwrap_or(Value::Null),
        "TEXT[]" | "VARCHAR[]" | "NAME[]" => row
            .try_get::<Vec<String>, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "INT4[]" => row.try_get::<Vec<i32>, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "INT8[]" => row.try_get::<Vec<i64>, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        _ => row
            .try_get::<String, _>(idx)
            .map(Value::String)
            .unwrap_or_else(|_| Value::String(format!("<{}>", type_name.to_lowercase()))),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Error mapping — PG gives SQLSTATE + a 1-based character position
// ---------------------------------------------------------------------------

fn map_error(system: &str, e: &sqlx::Error) -> QueryError {
    match e {
        sqlx::Error::Database(db) => {
            let raw = db.to_string();
            let code = db.code().map(|c| c.to_string());
            let mut qe = QueryError::new(system, db.message().to_string(), raw);
            qe.hint = code.as_deref().and_then(hint_for_sqlstate);
            qe.code = code;
            qe
        }
        other => QueryError::new(system, other.to_string(), other.to_string()),
    }
}

fn map_exec_error(system: &str, sql: &str, e: &sqlx::Error) -> QueryError {
    let mut qe = map_error(system, e);
    if let sqlx::Error::Database(db) = e {
        if let Some(pg) = db.try_downcast_ref::<PgDatabaseError>() {
            if let Some(pos) = pg.position() {
                if let sqlx::postgres::PgErrorPosition::Original(offset) = pos {
                    let (line, col) = util::offset_to_line_col(sql, offset);
                    qe.position = Some(ErrorPosition { line, col });
                }
            }
        }
    }
    qe
}

fn hint_for_sqlstate(code: &str) -> Option<String> {
    let hint = match code {
        "42P01" => "Bảng không tồn tại. Kiểm tra schema hiện tại hoặc tên bảng.",
        "42703" => "Cột không tồn tại. Kiểm tra tên cột hoặc alias.",
        "42601" => "Lỗi cú pháp SQL.",
        "42883" => "Hàm không tồn tại hoặc sai kiểu tham số.",
        "28P01" => "Sai mật khẩu hoặc user không có quyền đăng nhập.",
        "3D000" => "Database không tồn tại.",
        "23505" => "Vi phạm ràng buộc UNIQUE.",
        "23503" => "Vi phạm ràng buộc khóa ngoại.",
        "23502" => "Cột NOT NULL không được để trống.",
        "40001" => "Xung đột serialization — thử lại transaction.",
        "57014" => "Query đã bị hủy.",
        _ => return None,
    };
    Some(hint.to_string())
}
