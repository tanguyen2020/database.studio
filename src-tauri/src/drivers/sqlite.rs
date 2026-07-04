//! SQLite driver — connects to a *user's* SQLite database file (or :memory:).
//! Deliberately separate from `storage::` (the app's own rusqlite store).
//! rusqlite is synchronous, so every call is wrapped in spawn_blocking.

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::connections::profile::SqliteMode;
use crate::drivers::types::*;
use crate::drivers::util::{self, quote_ident, QuoteStyle};
use crate::error::QueryError;

#[derive(Clone)]
pub struct SqliteDriver {
    conn: Arc<Mutex<Connection>>,
    pub path: String,
}

pub struct SqliteConnParams {
    pub path: String,
    pub mode: SqliteMode,
}

fn open_connection(p: &SqliteConnParams) -> Result<Connection, QueryError> {
    let conn = match p.mode {
        SqliteMode::InMemory => Connection::open_in_memory(),
        SqliteMode::ReadOnly => Connection::open_with_flags(
            &p.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ),
        SqliteMode::ReadWrite => Connection::open_with_flags(
            &p.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ),
    };
    conn.map_err(|e| map_rusqlite_error(&e))
}

impl SqliteDriver {
    pub async fn connect(p: &SqliteConnParams) -> Result<Self, QueryError> {
        let path = p.path.clone();
        let params = SqliteConnParams { path: p.path.clone(), mode: p.mode };
        let conn = tokio::task::spawn_blocking(move || open_connection(&params))
            .await
            .map_err(|e| QueryError::new("sqlite", e.to_string(), e.to_string()))??;
        Ok(Self { conn: Arc::new(Mutex::new(conn)), path })
    }

    pub async fn test(p: &SqliteConnParams) -> TestResult {
        let started = Instant::now();
        match Self::connect(p).await {
            Ok(drv) => {
                let version = drv
                    .with_conn(|c| {
                        c.query_row("SELECT sqlite_version()", [], |r| r.get::<_, String>(0))
                            .map_err(|e| map_rusqlite_error(&e))
                    })
                    .await
                    .ok();
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: version.map(|v| format!("SQLite {v}")),
                    error: None,
                }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    /// Runs a closure on the blocking thread pool with the connection locked.
    async fn with_conn<T, F>(&self, f: F) -> Result<T, QueryError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, QueryError> + Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let guard = conn
                .lock()
                .map_err(|_| QueryError::new("sqlite", "connection poisoned", "mutex poisoned"))?;
            f(&guard)
        })
        .await
        .map_err(|e| QueryError::new("sqlite", e.to_string(), e.to_string()))?
    }

    /// Editable grid: pending changes trong 1 transaction (rollback nếu lỗi).
    /// rusqlite dynamic typing → bind JSON tự nhiên; unchecked_transaction cho
    /// phép mở tx trên &Connection (đang giữ trong Arc<Mutex>).
    pub async fn apply_changes(
        &self,
        changes: Vec<crate::drivers::grid::GridChange>,
    ) -> Result<u64, QueryError> {
        self.with_conn(move |c| {
            let tx = c.unchecked_transaction().map_err(|e| map_rusqlite_error(&e))?;
            let mut total = 0u64;
            for ch in &changes {
                let stmt = crate::drivers::grid::build("sqlite", ch);
                let binds: Vec<rusqlite::types::Value> =
                    stmt.params.iter().map(json_to_sqlite).collect();
                let n = tx
                    .execute(&stmt.sql, rusqlite::params_from_iter(binds.iter()))
                    .map_err(|e| map_rusqlite_error(&e))?;
                total += n as u64;
            }
            tx.commit().map_err(|e| map_rusqlite_error(&e))?;
            Ok(total)
        })
        .await
    }

    /// SELECT tham số hóa (filter builder / pagination).
    pub async fn exec_params(
        &self,
        sql: &str,
        params: Vec<Value>,
    ) -> Result<StatementOutcome, QueryError> {
        let sql = sql.to_string();
        self.with_conn(move |c| {
            let binds: Vec<rusqlite::types::Value> = params.iter().map(json_to_sqlite).collect();
            let mut stmt = c.prepare(&sql).map_err(|e| map_rusqlite_error(&e))?;
            let cols: Vec<ColumnDef> = stmt
                .columns()
                .iter()
                .map(|c| {
                    let dtype = c.decl_type().map(|t| t.to_lowercase()).unwrap_or_else(|| "dynamic".into());
                    (c.name().to_string(), dtype)
                })
                .collect();
            let col_names: Vec<String> = cols.iter().map(|(n, _)| n.clone()).collect();
            let mut rows_out: Vec<Value> = Vec::new();
            let mut rows = stmt
                .query(rusqlite::params_from_iter(binds.iter()))
                .map_err(|e| map_rusqlite_error(&e))?;
            while let Some(row) = rows.next().map_err(|e| map_rusqlite_error(&e))? {
                let mut obj = Map::new();
                for (i, name) in col_names.iter().enumerate() {
                    let v = match row.get_ref(i).map_err(|e| map_rusqlite_error(&e))? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(f) => json!(f),
                        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
                        ValueRef::Blob(b) => {
                            Value::String(format!("x'{}'", b.iter().map(|x| format!("{x:02x}")).collect::<String>()))
                        }
                    };
                    obj.insert(name.clone(), v);
                }
                rows_out.push(Value::Object(obj));
            }
            let total = rows_out.len() as u64;
            Ok(StatementOutcome::Rows { result: QueryResultSet { cols, rows: rows_out, total } })
        })
        .await
    }

    pub async fn exec(&self, sql: &str) -> Result<StatementOutcome, QueryError> {
        let sql = sql.to_string();
        self.with_conn(move |c| {
            let mut stmt = c.prepare(&sql).map_err(|e| map_rusqlite_error(&e))?;
            if stmt.column_count() > 0 {
                let cols: Vec<ColumnDef> = stmt
                    .columns()
                    .iter()
                    .map(|c| {
                        let dtype = c
                            .decl_type()
                            .map(|t| t.to_lowercase())
                            .unwrap_or_else(|| "dynamic".to_string());
                        (c.name().to_string(), dtype)
                    })
                    .collect();
                let col_names: Vec<String> = cols.iter().map(|(n, _)| n.clone()).collect();
                let mut rows_out: Vec<Value> = Vec::new();
                let mut rows = stmt.query([]).map_err(|e| map_rusqlite_error(&e))?;
                while let Some(row) = rows.next().map_err(|e| map_rusqlite_error(&e))? {
                    let mut obj = Map::new();
                    for (i, name) in col_names.iter().enumerate() {
                        let v = match row.get_ref(i).map_err(|e| map_rusqlite_error(&e))? {
                            ValueRef::Null => Value::Null,
                            ValueRef::Integer(n) => json!(n),
                            ValueRef::Real(f) => json!(f),
                            ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
                            ValueRef::Blob(b) => Value::String(format!(
                                "x'{}'",
                                b.iter().map(|x| format!("{x:02x}")).collect::<String>()
                            )),
                        };
                        obj.insert(name.clone(), v);
                    }
                    rows_out.push(Value::Object(obj));
                }
                let total = rows_out.len() as u64;
                Ok(StatementOutcome::Rows {
                    result: QueryResultSet { cols, rows: rows_out, total },
                })
            } else {
                let affected = stmt.execute([]).map_err(|e| map_rusqlite_error(&e))?;
                if util::is_dml(&sql) {
                    Ok(StatementOutcome::Affected { affected: affected as u64 })
                } else {
                    Ok(StatementOutcome::Ok)
                }
            }
        })
        .await
    }

    pub async fn ping(&self) -> bool {
        self.with_conn(|c| {
            c.query_row("SELECT 1", [], |_| Ok(()))
                .map_err(|e| map_rusqlite_error(&e))
        })
        .await
        .is_ok()
    }

    // ---- introspection ------------------------------------------------------
    // Tree shape: file root → schema (main + attached) → tables/views/triggers.

    pub async fn schemas(&self) -> Result<Vec<SchemaInfo>, QueryError> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare("PRAGMA database_list")
                .map_err(|e| map_rusqlite_error(&e))?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(|e| map_rusqlite_error(&e))?;
            let mut out = Vec::new();
            for name in rows {
                let name = name.map_err(|e| map_rusqlite_error(&e))?;
                if name == "temp" {
                    continue;
                }
                out.push(SchemaInfo { is_default: name == "main", name });
            }
            Ok(out)
        })
        .await
    }

    pub async fn tables(&self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        let schema = schema.to_string();
        self.with_conn(move |c| {
            let master = format!("{}.sqlite_master", quote_ident(&schema, QuoteStyle::DoubleQuote));
            let sql = format!(
                "SELECT name, type FROM {master} WHERE type IN ('table','view') ORDER BY name"
            );
            let mut stmt = c.prepare(&sql).map_err(|e| map_rusqlite_error(&e))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| map_rusqlite_error(&e))?;
            let mut out = Vec::new();
            for row in rows {
                let (name, kind) = row.map_err(|e| map_rusqlite_error(&e))?;
                let locked = name.starts_with("sqlite_");
                out.push(TableInfo {
                    schema: schema.clone(),
                    name,
                    kind: if kind == "view" { "view".into() } else { "table".into() },
                    row_estimate: None,
                    locked,
                    engine: None,
                });
            }
            // sqlite_master itself is browsable (locked/read-only).
            out.push(TableInfo {
                schema: schema.clone(),
                name: "sqlite_master".into(),
                kind: "system".into(),
                row_estimate: None,
                locked: true,
                engine: None,
            });
            Ok(out)
        })
        .await
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        let schema = schema.to_string();
        let table = table.to_string();
        self.with_conn(move |c| {
            // PRAGMA cannot be parameterized — identifiers are strictly quoted.
            let sql = format!(
                "PRAGMA {}.table_info({})",
                quote_ident(&schema, QuoteStyle::DoubleQuote),
                quote_ident(&table, QuoteStyle::DoubleQuote)
            );
            let mut stmt = c.prepare(&sql).map_err(|e| map_rusqlite_error(&e))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(ColumnInfo {
                        ordinal: r.get::<_, i32>(0)? + 1,
                        name: r.get(1)?,
                        data_type: {
                            let t: String = r.get(2)?;
                            if t.is_empty() { "dynamic".into() } else { t.to_lowercase() }
                        },
                        nullable: r.get::<_, i32>(3)? == 0,
                        default: r.get::<_, Option<String>>(4)?,
                        is_pk: r.get::<_, i32>(5)? > 0,
                        is_fk: false, // filled below
                    })
                })
                .map_err(|e| map_rusqlite_error(&e))?;
            let mut cols: Vec<ColumnInfo> = Vec::new();
            for row in rows {
                cols.push(row.map_err(|e| map_rusqlite_error(&e))?);
            }
            // FK flags from foreign_key_list.
            let fk_sql = format!(
                "PRAGMA {}.foreign_key_list({})",
                quote_ident(&schema, QuoteStyle::DoubleQuote),
                quote_ident(&table, QuoteStyle::DoubleQuote)
            );
            if let Ok(mut fk_stmt) = c.prepare(&fk_sql) {
                if let Ok(fk_rows) = fk_stmt.query_map([], |r| r.get::<_, String>(3)) {
                    for fk_col in fk_rows.flatten() {
                        if let Some(col) = cols.iter_mut().find(|c| c.name == fk_col) {
                            col.is_fk = true;
                        }
                    }
                }
            }
            Ok(cols)
        })
        .await
    }

    pub async fn indexes(&self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, QueryError> {
        let schema = schema.to_string();
        let table = table.to_string();
        self.with_conn(move |c| {
            let sql = format!(
                "PRAGMA {}.index_list({})",
                quote_ident(&schema, QuoteStyle::DoubleQuote),
                quote_ident(&table, QuoteStyle::DoubleQuote)
            );
            let mut stmt = c.prepare(&sql).map_err(|e| map_rusqlite_error(&e))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(1)?,          // name
                        r.get::<_, i32>(2)? == 1,        // unique
                        r.get::<_, String>(3)?,          // origin: c|u|pk
                    ))
                })
                .map_err(|e| map_rusqlite_error(&e))?;
            let mut out = Vec::new();
            for row in rows {
                let (name, unique, origin) = row.map_err(|e| map_rusqlite_error(&e))?;
                let info_sql = format!(
                    "PRAGMA {}.index_info({})",
                    quote_ident(&schema, QuoteStyle::DoubleQuote),
                    quote_ident(&name, QuoteStyle::DoubleQuote)
                );
                let mut columns = Vec::new();
                if let Ok(mut info_stmt) = c.prepare(&info_sql) {
                    if let Ok(info_rows) = info_stmt.query_map([], |r| r.get::<_, Option<String>>(2)) {
                        for col in info_rows.flatten().flatten() {
                            columns.push(col);
                        }
                    }
                }
                out.push(IndexInfo {
                    name,
                    method: "BTREE".into(),
                    columns,
                    unique,
                    primary: origin == "pk",
                });
            }
            Ok(out)
        })
        .await
    }

    pub async fn triggers(&self, schema: &str) -> Result<Vec<TriggerInfo>, QueryError> {
        let schema = schema.to_string();
        self.with_conn(move |c| {
            let master = format!("{}.sqlite_master", quote_ident(&schema, QuoteStyle::DoubleQuote));
            let sql = format!(
                "SELECT name, tbl_name, COALESCE(sql, '') FROM {master} WHERE type = 'trigger' ORDER BY name"
            );
            let mut stmt = c.prepare(&sql).map_err(|e| map_rusqlite_error(&e))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| map_rusqlite_error(&e))?;
            let mut out = Vec::new();
            for row in rows {
                let (name, table, ddl) = row.map_err(|e| map_rusqlite_error(&e))?;
                out.push(TriggerInfo {
                    schema: schema.clone(),
                    name,
                    table,
                    event: parse_trigger_event(&ddl),
                });
            }
            Ok(out)
        })
        .await
    }
}

fn parse_trigger_event(ddl: &str) -> String {
    let upper = ddl.to_uppercase();
    let timing = if upper.contains("INSTEAD OF") {
        "INSTEAD OF"
    } else if upper.contains(" BEFORE ") {
        "BEFORE"
    } else {
        "AFTER"
    };
    let event = ["INSERT", "UPDATE", "DELETE"]
        .iter()
        .find(|e| upper.contains(&format!(" {e}")))
        .copied()
        .unwrap_or("");
    format!("{timing} {event}").trim().to_string()
}

// ---------------------------------------------------------------------------
// Error mapping — SQLite is statement-level (no reliable offset via rusqlite)
// ---------------------------------------------------------------------------

fn map_rusqlite_error(e: &rusqlite::Error) -> QueryError {
    let raw = e.to_string();
    let mut qe = QueryError::new("sqlite", clean_message(&raw), raw.clone());
    if let rusqlite::Error::SqliteFailure(code, _) = e {
        qe.code = Some(format!("{:?}", code.code));
        qe.hint = hint_for(&raw);
    } else {
        qe.hint = hint_for(&raw);
    }
    qe
}

fn clean_message(raw: &str) -> String {
    raw.trim().to_string()
}

fn hint_for(raw: &str) -> Option<String> {
    let lower = raw.to_lowercase();
    let hint = if lower.contains("no such table") {
        "Bảng không tồn tại trong file này. Kiểm tra tên bảng hoặc schema (main/attached)."
    } else if lower.contains("no such column") {
        "Cột không tồn tại. Kiểm tra tên cột."
    } else if lower.contains("syntax error") {
        "Lỗi cú pháp SQLite."
    } else if lower.contains("readonly") || lower.contains("read-only") {
        "Database đang mở ở chế độ Read-Only — đổi mode trong connection để ghi."
    } else if lower.contains("unique constraint") {
        "Vi phạm ràng buộc UNIQUE."
    } else if lower.contains("foreign key constraint") {
        "Vi phạm ràng buộc khóa ngoại."
    } else if lower.contains("database is locked") {
        "File đang bị process khác giữ khóa. Đóng ứng dụng khác đang mở file này."
    } else {
        return None;
    };
    Some(hint.to_string())
}

// ---------------------------------------------------------------------------
// PRAGMA panel (Phase 2 — README §"SQLite file header + PRAGMA panel"):
// editable journal_mode/synchronous/foreign_keys/auto_vacuum (whitelist),
// read-only cache_size/page_size/page_count + size + version + WAL.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct SqliteFileInfo {
    pub path: String,
    pub size_bytes: u64,
    pub version: String,
    pub journal_mode: String,
    pub synchronous: String,
    pub foreign_keys: String,
    pub auto_vacuum: String,
    pub cache_size: String,
    pub page_size: String,
    pub page_count: String,
}

/// PRAGMA được phép sửa từ panel — whitelist cứng, value được validate,
/// KHÔNG bao giờ nối chuỗi tự do vào câu PRAGMA.
const EDITABLE_PRAGMAS: &[(&str, &[&str])] = &[
    ("journal_mode", &["delete", "truncate", "persist", "memory", "wal", "off"]),
    ("synchronous", &["off", "normal", "full", "extra", "0", "1", "2", "3"]),
    ("foreign_keys", &["on", "off", "0", "1", "true", "false"]),
    ("auto_vacuum", &["none", "full", "incremental", "0", "1", "2"]),
];

fn synchronous_label(v: i64) -> String {
    match v {
        0 => "OFF".into(),
        1 => "NORMAL".into(),
        2 => "FULL".into(),
        3 => "EXTRA".into(),
        other => other.to_string(),
    }
}

fn auto_vacuum_label(v: i64) -> String {
    match v {
        0 => "NONE".into(),
        1 => "FULL".into(),
        2 => "INCREMENTAL".into(),
        other => other.to_string(),
    }
}

impl SqliteDriver {
    pub async fn file_info(&self) -> Result<SqliteFileInfo, QueryError> {
        let path = self.path.clone();
        self.with_conn(move |c| {
            let q = |sql: &str| -> Result<String, QueryError> {
                c.query_row(sql, [], |r| r.get::<_, rusqlite::types::Value>(0))
                    .map(|v| match v {
                        rusqlite::types::Value::Text(s) => s,
                        rusqlite::types::Value::Integer(i) => i.to_string(),
                        other => format!("{other:?}"),
                    })
                    .map_err(|e| map_rusqlite_error(&e))
            };
            let sync_raw: i64 = q("PRAGMA synchronous")?.parse().unwrap_or(-1);
            let av_raw: i64 = q("PRAGMA auto_vacuum")?.parse().unwrap_or(-1);
            let fk = if q("PRAGMA foreign_keys")? == "1" { "ON" } else { "OFF" };
            let size_bytes = if path.is_empty() {
                0
            } else {
                std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
            };
            Ok(SqliteFileInfo {
                path: path.clone(),
                size_bytes,
                version: q("SELECT sqlite_version()")?,
                journal_mode: q("PRAGMA journal_mode")?.to_uppercase(),
                synchronous: synchronous_label(sync_raw),
                foreign_keys: fk.to_string(),
                auto_vacuum: auto_vacuum_label(av_raw),
                cache_size: q("PRAGMA cache_size")?,
                page_size: q("PRAGMA page_size")?,
                page_count: q("PRAGMA page_count")?,
            })
        })
        .await
    }

    pub async fn set_pragma(&self, key: &str, value: &str) -> Result<(), QueryError> {
        let key = key.to_lowercase();
        let value = value.to_lowercase();
        let allowed = EDITABLE_PRAGMAS
            .iter()
            .find(|(k, _)| *k == key)
            .ok_or_else(|| {
                QueryError::new("sqlite", format!("PRAGMA '{key}' không được phép sửa từ panel"), "")
            })?;
        if !allowed.1.contains(&value.as_str()) {
            return Err(QueryError::new(
                "sqlite",
                format!("Giá trị '{value}' không hợp lệ cho PRAGMA {key}"),
                "",
            ));
        }
        self.with_conn(move |c| {
            // journal_mode trả về row → dùng query thay execute
            c.pragma_update(None, &key, &value).map_err(|e| map_rusqlite_error(&e))
        })
        .await
    }

    pub async fn integrity_check(&self) -> Result<Vec<String>, QueryError> {
        self.with_conn(|c| {
            let mut stmt = c.prepare("PRAGMA integrity_check").map_err(|e| map_rusqlite_error(&e))?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| map_rusqlite_error(&e))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| map_rusqlite_error(&e))
        })
        .await
    }
}

/// JSON scalar → rusqlite Value (dynamic typing khớp mọi cột).
fn json_to_sqlite(v: &serde_json::Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as SV;
    use serde_json::Value as JV;
    match v {
        JV::Null => SV::Null,
        JV::Bool(b) => SV::Integer(if *b { 1 } else { 0 }),
        JV::Number(num) if num.is_i64() => SV::Integer(num.as_i64().unwrap()),
        JV::Number(num) if num.is_u64() => SV::Integer(num.as_u64().unwrap() as i64),
        JV::Number(num) => SV::Real(num.as_f64().unwrap_or(0.0)),
        JV::String(s) => SV::Text(s.clone()),
        other => SV::Text(other.to_string()),
    }
}
