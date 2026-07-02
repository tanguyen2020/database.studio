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

    pub async fn exec(&self, sql: &str) -> Result<StatementOutcome, QueryError> {
        let sql = sql.to_string();
        self.with_conn(move |c| {
            let mut stmt = c.prepare(&sql).map_err(|e| map_rusqlite_error(&e))?;
            if stmt.column_count() > 0 {
                let cols: Vec<ColumnDef> = stmt
                    .column_names()
                    .iter()
                    .enumerate()
                    .map(|(i, name)| {
                        let dtype = stmt
                            .column_decltype(i)
                            .map(|t| t.to_lowercase())
                            .unwrap_or_else(|| "dynamic".to_string());
                        (name.to_string(), dtype)
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
                });
            }
            // sqlite_master itself is browsable (locked/read-only).
            out.push(TableInfo {
                schema: schema.clone(),
                name: "sqlite_master".into(),
                kind: "system".into(),
                row_estimate: None,
                locked: true,
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
