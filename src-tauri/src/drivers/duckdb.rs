//! DuckDB driver — an embedded analytical database (a `.duckdb` file or
//! `:memory:`), modelled on the SQLite driver: duckdb-rs is synchronous, so every
//! call runs on the blocking pool with the connection locked.
//!
//! Two DuckDB-specific rules shape this module:
//!
//! * **One database instance per file per process.** DuckDB takes an exclusive
//!   lock on a file opened read-write, and opening the same file a second time in
//!   the same process fails. The app opens several connections to one profile (the
//!   Explorer's, one per Query Editor tab, attached databases, Test connection), so
//!   every connection to the same file is a `try_clone()` of ONE shared instance
//!   (see [`INSTANCES`]). In-memory databases are shared the same way per profile,
//!   so a Query Editor tab sees the tables the Explorer created.
//! * **Catalogs.** A DuckDB instance holds several databases (the opened file plus
//!   anything `ATTACH`ed), each with real schemas. Introspection is scoped to
//!   `current_database()`; another attached database is reached through its own
//!   connection that ran `USE "db"` (the Explorer's per-database sub-connection).

use duckdb::core::{LogicalTypeHandle, LogicalTypeId};
use duckdb::types::Value as DV;
use duckdb::{AccessMode, Config, Connection, InterruptHandle};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Instant;

use crate::connections::profile::SqliteMode;
use crate::drivers::types::*;
use crate::drivers::util::{self, quote_ident, QuoteStyle};
use crate::error::{ErrorPosition, QueryError};

const SYS: &str = "duckdb";

#[derive(Clone)]
pub struct DuckDriver {
    conn: Arc<Mutex<Connection>>,
    /// Interrupts the statement running on `conn` from another thread — the only
    /// way to stop a DuckDB query (the blocking thread cannot be aborted).
    interrupt: Arc<InterruptHandle>,
    /// Keeps the shared database instance alive while this connection exists.
    _instance: Arc<Mutex<Connection>>,
    pub path: String,
}

pub struct DuckConnParams {
    /// File path; empty = in-memory.
    pub path: String,
    pub mode: SqliteMode,
    /// Database to `USE` after opening (an attached catalog). Empty = the default.
    pub database: String,
    /// Profile id the connection belongs to (base id, without `::db` / `#tab-`).
    /// Scopes the shared in-memory instance: one profile = one in-memory database.
    pub owner: String,
}

/// Live database instances, keyed by [`instance_key`]. Weak: the instance closes
/// (and releases the file lock) once its last connection is dropped.
static INSTANCES: OnceLock<Mutex<HashMap<String, Weak<Mutex<Connection>>>>> = OnceLock::new();

/// Strips the per-database (`{id}::db`) and per-tab (`{id}#tab-N`) suffixes the
/// registry appends, so every connection of one profile shares an instance.
pub fn base_owner(id: &str) -> String {
    let id = id.split("#tab-").next().unwrap_or(id);
    id.split("::").next().unwrap_or(id).to_string()
}

/// Key of the database instance a connection must share. File databases are keyed
/// by mode + canonical path (two profiles on one file must share it, or the second
/// one hits the file lock); in-memory databases by the owning profile.
pub fn instance_key(p: &DuckConnParams) -> String {
    match effective_mode(p) {
        SqliteMode::InMemory => format!("mem:{}", base_owner(&p.owner)),
        mode => {
            let path = canonical_file_path(&p.path);
            let tag = if mode == SqliteMode::ReadOnly { "ro" } else { "rw" };
            // Windows paths are case-insensitive.
            let path = if cfg!(windows) { path.to_lowercase() } else { path };
            format!("{tag}:{path}")
        }
    }
}

/// Stable identity of a database file, the same before and after the file exists.
/// Canonicalising the FILE would not be: a new database file only appears on the
/// first open, so the first connection would key the raw path and the next one the
/// canonical `\\?\C:\…` form — two keys, a second open, and DuckDB's "file is
/// already open" lock error. The parent directory exists either way.
fn canonical_file_path(path: &str) -> String {
    let p = std::path::Path::new(path);
    let (Some(parent), Some(name)) = (p.parent(), p.file_name()) else {
        return path.to_string();
    };
    let parent = if parent.as_os_str().is_empty() { std::path::Path::new(".") } else { parent };
    match std::fs::canonicalize(parent) {
        Ok(dir) => dir.join(name).to_string_lossy().to_string(),
        Err(_) => path.to_string(),
    }
}

fn effective_mode(p: &DuckConnParams) -> SqliteMode {
    if p.path.trim().is_empty() {
        SqliteMode::InMemory
    } else {
        p.mode
    }
}

fn open_instance(p: &DuckConnParams) -> Result<Connection, duckdb::Error> {
    match effective_mode(p) {
        SqliteMode::InMemory => Connection::open_in_memory(),
        SqliteMode::ReadOnly => {
            Connection::open_with_flags(&p.path, Config::default().access_mode(AccessMode::ReadOnly)?)
        }
        SqliteMode::ReadWrite => Connection::open(&p.path),
    }
}

/// Opens a connection on the shared instance (creating the instance if needed),
/// then switches to `p.database` when one is requested.
fn open_connection(p: &DuckConnParams) -> Result<(Connection, Arc<Mutex<Connection>>), QueryError> {
    let key = instance_key(p);
    let map = INSTANCES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = map
        .lock()
        .map_err(|_| QueryError::new(SYS, "instance registry poisoned", "mutex poisoned"))?;
    map.retain(|_, w| w.strong_count() > 0);
    let instance = match map.get(&key).and_then(Weak::upgrade) {
        Some(i) => i,
        None => {
            let root = open_instance(p).map_err(|e| map_error(&e))?;
            let root = Arc::new(Mutex::new(root));
            map.insert(key, Arc::downgrade(&root));
            root
        }
    };
    drop(map);
    let conn = instance
        .lock()
        .map_err(|_| QueryError::new(SYS, "connection poisoned", "mutex poisoned"))?
        .try_clone()
        .map_err(|e| map_error(&e))?;
    let db = p.database.trim();
    if !db.is_empty() {
        let current: String = conn
            .query_row("SELECT current_database()", [], |r| r.get(0))
            .map_err(|e| map_error(&e))?;
        if current != db {
            conn.execute_batch(&format!("USE {}", quote_ident(db, QuoteStyle::DoubleQuote)))
                .map_err(|e| map_error(&e))?;
        }
    }
    Ok((conn, instance))
}

impl DuckDriver {
    pub async fn connect(p: &DuckConnParams) -> Result<Self, QueryError> {
        let params = DuckConnParams {
            path: p.path.clone(),
            mode: p.mode,
            database: p.database.clone(),
            owner: p.owner.clone(),
        };
        let path = p.path.clone();
        let (conn, instance) = tokio::task::spawn_blocking(move || open_connection(&params))
            .await
            .map_err(|e| QueryError::new(SYS, e.to_string(), e.to_string()))??;
        let interrupt = conn.interrupt_handle();
        Ok(Self { conn: Arc::new(Mutex::new(conn)), interrupt, _instance: instance, path })
    }

    pub async fn test(p: &DuckConnParams) -> TestResult {
        let started = Instant::now();
        match Self::connect(p).await {
            Ok(drv) => {
                let version = drv
                    .with_conn(|c| {
                        c.query_row("SELECT version()", [], |r| r.get::<_, String>(0))
                            .map_err(|e| map_error(&e))
                    })
                    .await
                    .ok();
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: version.map(|v| format!("DuckDB {v}")),
                    error: None,
                }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    /// Handle that stops the statement currently running on this connection.
    pub fn interrupt_handle(&self) -> Arc<InterruptHandle> {
        Arc::clone(&self.interrupt)
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
                .map_err(|_| QueryError::new(SYS, "connection poisoned", "mutex poisoned"))?;
            f(&guard)
        })
        .await
        .map_err(|e| QueryError::new(SYS, e.to_string(), e.to_string()))?
    }

    pub async fn ping(&self) -> bool {
        self.with_conn(|c| c.query_row("SELECT 1", [], |_| Ok(())).map_err(|e| map_error(&e)))
            .await
            .is_ok()
    }

    pub async fn exec(&self, sql: &str) -> Result<StatementOutcome, QueryError> {
        let sql = sql.to_string();
        self.with_conn(move |c| run_statement(c, &sql, &[])).await
    }

    /// Parameterised statement (filter builder / pagination). `?` placeholders.
    pub async fn exec_params(&self, sql: &str, params: Vec<Value>) -> Result<StatementOutcome, QueryError> {
        let sql = sql.to_string();
        self.with_conn(move |c| run_statement(c, &sql, &params)).await
    }

    /// Editable grid Apply — every pending change in one transaction.
    pub async fn apply_changes(&self, changes: Vec<crate::drivers::grid::GridChange>) -> Result<u64, QueryError> {
        self.with_conn(move |c| {
            c.execute_batch("BEGIN TRANSACTION").map_err(|e| map_error(&e))?;
            let mut total = 0u64;
            for ch in &changes {
                let stmt = crate::drivers::grid::build(SYS, ch);
                let binds: Vec<DV> = stmt.params.iter().map(json_to_duck).collect();
                let res = c
                    .prepare(&stmt.sql)
                    .and_then(|mut s| s.execute(duckdb::params_from_iter(binds.iter())));
                match res {
                    Ok(n) => total += n as u64,
                    Err(e) => {
                        let _ = c.execute_batch("ROLLBACK");
                        return Err(map_error(&e));
                    }
                }
            }
            c.execute_batch("COMMIT").map_err(|e| map_error(&e))?;
            Ok(total)
        })
        .await
    }

    // ---- introspection ------------------------------------------------------
    // Everything is scoped to current_database(): a connection that ran
    // `USE "other"` introspects that attached database instead.

    /// Databases of this instance (the opened file + anything ATTACHed).
    pub async fn databases(&self) -> Result<Vec<DatabaseInfo>, QueryError> {
        self.with_conn(|c| {
            query_rows(
                c,
                "SELECT database_name, database_name = current_database() \
                 FROM duckdb_databases() WHERE NOT internal ORDER BY database_name",
                &[],
                |r| Ok(DatabaseInfo { name: r.get(0)?, current: r.get(1)? }),
            )
        })
        .await
    }

    pub async fn schemas(&self) -> Result<Vec<SchemaInfo>, QueryError> {
        self.with_conn(|c| {
            query_rows(
                c,
                "SELECT schema_name, schema_name = current_schema() FROM duckdb_schemas() \
                 WHERE database_name = current_database() \
                   AND schema_name NOT IN ('information_schema', 'pg_catalog') \
                 ORDER BY schema_name = 'main' DESC, schema_name",
                &[],
                |r| Ok(SchemaInfo { name: r.get(0)?, is_default: r.get(1)? }),
            )
        })
        .await
    }

    pub async fn tables(&self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        let schema = schema.to_string();
        self.with_conn(move |c| {
            let s = schema.clone();
            query_rows(
                c,
                "SELECT table_name, 'table' AS kind, estimated_size FROM duckdb_tables() \
                 WHERE database_name = current_database() AND schema_name = ? AND NOT internal \
                 UNION ALL \
                 SELECT view_name, 'view', NULL FROM duckdb_views() \
                 WHERE database_name = current_database() AND schema_name = ? AND NOT internal \
                 ORDER BY 1",
                &[json!(schema), json!(schema)],
                move |r| {
                    Ok(TableInfo {
                        schema: s.clone(),
                        name: r.get(0)?,
                        kind: r.get(1)?,
                        row_estimate: r.get::<_, Option<i64>>(2)?,
                        locked: false,
                        engine: None,
                        data_length: None,
                        partition_of: None,
                        is_partitioned: None,
                    })
                },
            )
        })
        .await
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        let (schema, table) = (schema.to_string(), table.to_string());
        self.with_conn(move |c| {
            let key_cols = |kind: &str| -> Result<Vec<String>, QueryError> {
                query_rows(
                    c,
                    "SELECT unnest(constraint_column_names) FROM duckdb_constraints() \
                     WHERE database_name = current_database() AND schema_name = ? AND table_name = ? \
                       AND constraint_type = ?",
                    &[json!(schema), json!(table), json!(kind)],
                    |r| r.get::<_, String>(0),
                )
            };
            let pk = key_cols("PRIMARY KEY")?;
            let fk = key_cols("FOREIGN KEY")?;
            query_rows(
                c,
                "SELECT column_name, data_type, is_nullable, column_default, column_index \
                 FROM duckdb_columns() \
                 WHERE database_name = current_database() AND schema_name = ? AND table_name = ? \
                 ORDER BY column_index",
                &[json!(schema), json!(table)],
                |r| {
                    let name: String = r.get(0)?;
                    let default: Option<String> = r.get(3)?;
                    Ok(ColumnInfo {
                        is_pk: pk.contains(&name),
                        is_fk: fk.contains(&name),
                        auto_increment: default
                            .as_deref()
                            .map(|d| d.trim_start().to_ascii_lowercase().starts_with("nextval("))
                            .unwrap_or(false),
                        data_type: r.get(1)?,
                        nullable: r.get(2)?,
                        default,
                        ordinal: r.get::<_, i64>(4)? as i32,
                        name,
                    })
                },
            )
        })
        .await
    }

    pub async fn indexes(&self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, QueryError> {
        let (schema, table) = (schema.to_string(), table.to_string());
        self.with_conn(move |c| {
            // PRIMARY KEY / UNIQUE are backed by indexes DuckDB does not list in
            // duckdb_indexes(), so they come from the constraints.
            let mut out = query_rows(
                c,
                "SELECT constraint_name, constraint_type, \
                        array_to_string(constraint_column_names, chr(31)) \
                 FROM duckdb_constraints() \
                 WHERE database_name = current_database() AND schema_name = ? AND table_name = ? \
                   AND constraint_type IN ('PRIMARY KEY', 'UNIQUE') \
                 ORDER BY constraint_type = 'PRIMARY KEY' DESC, constraint_name",
                &[json!(schema), json!(table)],
                |r| {
                    let kind: String = r.get(1)?;
                    Ok(IndexInfo {
                        name: r.get(0)?,
                        method: "ART".into(),
                        columns: split_list(&r.get::<_, String>(2)?),
                        unique: true,
                        primary: kind == "PRIMARY KEY",
                    })
                },
            )?;
            out.extend(query_rows(
                c,
                "SELECT index_name, is_unique, sql, expressions FROM duckdb_indexes() \
                 WHERE database_name = current_database() AND schema_name = ? AND table_name = ? \
                 ORDER BY index_name",
                &[json!(schema), json!(table)],
                |r| {
                    let sql: Option<String> = r.get(2)?;
                    let exprs: Option<String> = r.get(3)?;
                    Ok(IndexInfo {
                        name: r.get(0)?,
                        method: "ART".into(),
                        columns: index_columns(sql.as_deref(), exprs.as_deref()),
                        unique: r.get(1)?,
                        primary: false,
                    })
                },
            )?);
            Ok(out)
        })
        .await
    }

    pub async fn constraints(&self, schema: &str, table: &str) -> Result<Vec<ConstraintInfo>, QueryError> {
        let (schema, table) = (schema.to_string(), table.to_string());
        self.with_conn(move |c| {
            query_rows(
                c,
                "SELECT constraint_name, constraint_type, constraint_text FROM duckdb_constraints() \
                 WHERE database_name = current_database() AND schema_name = ? AND table_name = ? \
                   AND constraint_type <> 'NOT NULL' \
                 ORDER BY constraint_index",
                &[json!(schema), json!(table)],
                |r| {
                    let kind: String = r.get(1)?;
                    Ok(ConstraintInfo {
                        name: r.get(0)?,
                        kind: match kind.as_str() {
                            "PRIMARY KEY" => "PK".into(),
                            "FOREIGN KEY" => "FK".into(),
                            other => other.to_string(),
                        },
                        definition: r.get(2)?,
                    })
                },
            )
        })
        .await
    }

    /// User-defined macros (DuckDB's stored "functions"); table macros are
    /// reported as table functions.
    pub async fn routines(&self, schema: &str) -> Result<Vec<RoutineInfo>, QueryError> {
        let schema = schema.to_string();
        self.with_conn(move |c| {
            let s = schema.clone();
            query_rows(
                c,
                "SELECT function_name, function_type, array_to_string(parameters, chr(31)) \
                 FROM duckdb_functions() \
                 WHERE database_name = current_database() AND schema_name = ? AND NOT internal \
                   AND function_type IN ('macro', 'table_macro') \
                 ORDER BY function_name",
                &[json!(schema)],
                move |r| {
                    let kind: String = r.get(1)?;
                    Ok(RoutineInfo {
                        schema: s.clone(),
                        name: r.get(0)?,
                        kind: if kind == "table_macro" { "table_function".into() } else { "function".into() },
                        params: split_list(&r.get::<_, Option<String>>(2)?.unwrap_or_default())
                            .into_iter()
                            .map(|name| ParamInfo { name, data_type: String::new(), mode: "IN".into(), default: None })
                            .collect(),
                        return_type: None,
                    })
                },
            )
        })
        .await
    }

    /// Every callable function (built-ins, extensions, macros) for Query Editor
    /// autocomplete, with the parameter list of one overload as the signature.
    pub async fn functions(&self) -> Result<Vec<FunctionInfo>, QueryError> {
        self.with_conn(|c| {
            query_rows(
                c,
                "SELECT function_name, any_value(function_type), \
                        any_value(array_to_string(parameters, ', ')) \
                 FROM duckdb_functions() \
                 WHERE function_type IN ('scalar', 'aggregate', 'macro', 'table', 'table_macro') \
                   AND regexp_matches(function_name, '^[A-Za-z_][A-Za-z0-9_]*$') \
                 GROUP BY function_name ORDER BY function_name",
                &[],
                |r| {
                    let name: String = r.get(0)?;
                    let kind: Option<String> = r.get(1)?;
                    let params: Option<String> = r.get(2)?;
                    Ok(FunctionInfo {
                        signature: params.map(|p| format!("{name}({p})")),
                        detail: kind,
                        name,
                    })
                },
            )
        })
        .await
    }

    pub async fn sequences(&self, schema: &str) -> Result<Vec<SequenceInfo>, QueryError> {
        let schema = schema.to_string();
        self.with_conn(move |c| {
            let s = schema.clone();
            query_rows(
                c,
                "SELECT sequence_name FROM duckdb_sequences() \
                 WHERE database_name = current_database() AND schema_name = ? AND NOT temporary \
                 ORDER BY sequence_name",
                &[json!(schema)],
                move |r| Ok(SequenceInfo { schema: s.clone(), name: r.get(0)? }),
            )
        })
        .await
    }

    pub async fn foreign_keys(&self, schema: &str) -> Result<Vec<ForeignKey>, QueryError> {
        let schema = schema.to_string();
        self.with_conn(move |c| {
            // The two unnests run in lockstep: column i maps to referenced column i.
            query_rows(
                c,
                "SELECT constraint_name, table_name, unnest(constraint_column_names), \
                        referenced_table, unnest(referenced_column_names) \
                 FROM duckdb_constraints() \
                 WHERE database_name = current_database() AND schema_name = ? \
                   AND constraint_type = 'FOREIGN KEY' \
                 ORDER BY table_name, constraint_name",
                &[json!(schema)],
                |r| {
                    Ok(ForeignKey {
                        name: r.get(0)?,
                        from_table: r.get(1)?,
                        from_column: r.get(2)?,
                        to_table: r.get(3)?,
                        to_column: r.get(4)?,
                    })
                },
            )
        })
        .await
    }

    /// Index Scanner: every index of the schema (constraint-backed + CREATE INDEX).
    pub async fn scan_indexes(&self, schema: &str) -> Result<Vec<crate::drivers::index_scan::IndexScanRow>, QueryError> {
        use crate::drivers::index_scan::IndexScanRow;
        let schema = schema.to_string();
        self.with_conn(move |c| {
            let row = |name: String, table: String, columns: Vec<String>, unique: bool, primary: bool| IndexScanRow {
                name,
                table,
                columns,
                index_type: "ART".into(),
                unique,
                primary,
                size_bytes: None,
                usage: None, // DuckDB keeps no index usage statistics
                fragmentation_pct: None,
                valid: true,
                flags: Vec::new(),
            };
            let mut out = query_rows(
                c,
                "SELECT constraint_name, table_name, array_to_string(constraint_column_names, chr(31)), \
                        constraint_type = 'PRIMARY KEY' \
                 FROM duckdb_constraints() \
                 WHERE database_name = current_database() AND schema_name = ? \
                   AND constraint_type IN ('PRIMARY KEY', 'UNIQUE') \
                 ORDER BY table_name, constraint_name",
                &[json!(schema)],
                |r| Ok(row(r.get(0)?, r.get(1)?, split_list(&r.get::<_, String>(2)?), true, r.get(3)?)),
            )?;
            out.extend(query_rows(
                c,
                "SELECT index_name, table_name, sql, expressions, is_unique FROM duckdb_indexes() \
                 WHERE database_name = current_database() AND schema_name = ? \
                 ORDER BY table_name, index_name",
                &[json!(schema)],
                |r| {
                    let sql: Option<String> = r.get(2)?;
                    let exprs: Option<String> = r.get(3)?;
                    Ok(row(r.get(0)?, r.get(1)?, index_columns(sql.as_deref(), exprs.as_deref()), r.get(4)?, false))
                },
            )?);
            Ok(out)
        })
        .await
    }

    /// Writes a full, consistent copy of the current database into a new DuckDB
    /// file (`ATTACH` + `COPY FROM DATABASE`) — no external tool needed.
    pub async fn backup_to(&self, dest: String) -> Result<(), QueryError> {
        self.with_conn(move |c| {
            let _ = std::fs::remove_file(&dest);
            let current: String =
                c.query_row("SELECT current_database()", [], |r| r.get(0)).map_err(|e| map_error(&e))?;
            let alias = "__dbstudio_backup";
            c.execute_batch(&format!("ATTACH {} AS {alias}", quote_literal(&dest)))
                .map_err(|e| map_error(&e))?;
            let res = c.execute_batch(&format!(
                "COPY FROM DATABASE {} TO {alias}",
                quote_ident(&current, QuoteStyle::DoubleQuote)
            ));
            let detach = c.execute_batch(&format!("DETACH {alias}"));
            res.map_err(|e| map_error(&e))?;
            detach.map_err(|e| map_error(&e))
        })
        .await
    }

    /// Replaces the current database's contents with a backup file: every user
    /// object is dropped, then the backup is copied in (`COPY FROM DATABASE`).
    pub async fn restore_from(&self, src: String) -> Result<(), QueryError> {
        self.with_conn(move |c| {
            if !std::path::Path::new(&src).is_file() {
                return Err(QueryError::new(SYS, format!("Backup file not found: {src}"), ""));
            }
            let current: String =
                c.query_row("SELECT current_database()", [], |r| r.get(0)).map_err(|e| map_error(&e))?;
            let alias = "__dbstudio_restore";
            c.execute_batch(&format!("ATTACH {} AS {alias} (READ_ONLY)", quote_literal(&src)))
                .map_err(|e| map_error(&e))?;
            let res = (|| {
                for stmt in drop_user_objects_sql(c)? {
                    c.execute_batch(&stmt).map_err(|e| map_error(&e))?;
                }
                c.execute_batch(&format!(
                    "COPY FROM DATABASE {alias} TO {}",
                    quote_ident(&current, QuoteStyle::DoubleQuote)
                ))
                .map_err(|e| map_error(&e))
            })();
            let _ = c.execute_batch(&format!("DETACH {alias}"));
            res
        })
        .await
    }
}

/// DROP statements that empty the current database (views → macros → tables →
/// sequences → non-main schemas), in dependency-safe order.
fn drop_user_objects_sql(c: &Connection) -> Result<Vec<String>, QueryError> {
    let q = |s: &str| quote_ident(s, QuoteStyle::DoubleQuote);
    let mut out = Vec::new();
    let list = |sql: &str| -> Result<Vec<(String, String)>, QueryError> {
        query_rows(c, sql, &[], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
    };
    let scope = "database_name = current_database() AND NOT internal";
    for (s, n) in list(&format!("SELECT schema_name, view_name FROM duckdb_views() WHERE {scope}"))? {
        out.push(format!("DROP VIEW IF EXISTS {}.{} CASCADE", q(&s), q(&n)));
    }
    for (s, n) in list(&format!(
        "SELECT DISTINCT schema_name, function_name FROM duckdb_functions() \
         WHERE {scope} AND function_type IN ('macro', 'table_macro')"
    ))? {
        out.push(format!("DROP MACRO IF EXISTS {}.{}", q(&s), q(&n)));
        out.push(format!("DROP MACRO TABLE IF EXISTS {}.{}", q(&s), q(&n)));
    }
    for (s, n) in list(&format!("SELECT schema_name, table_name FROM duckdb_tables() WHERE {scope}"))? {
        out.push(format!("DROP TABLE IF EXISTS {}.{} CASCADE", q(&s), q(&n)));
    }
    for (s, n) in list(&format!(
        "SELECT schema_name, sequence_name FROM duckdb_sequences() \
         WHERE database_name = current_database() AND NOT temporary"
    ))? {
        out.push(format!("DROP SEQUENCE IF EXISTS {}.{} CASCADE", q(&s), q(&n)));
    }
    for (s, _) in list(
        "SELECT schema_name, '' FROM duckdb_schemas() WHERE database_name = current_database() \
         AND NOT internal AND schema_name <> 'main'",
    )? {
        out.push(format!("DROP SCHEMA IF EXISTS {} CASCADE", q(&s)));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Statement execution
// ---------------------------------------------------------------------------

/// Prepares and runs one statement. DML without RETURNING reports the affected
/// row count; everything else is read as a result set (DuckDB's FROM-first
/// queries, SUMMARIZE, PIVOT, DESCRIBE … all return rows) — a result with no
/// columns is a plain "OK".
fn run_statement(c: &Connection, sql: &str, params: &[Value]) -> Result<StatementOutcome, QueryError> {
    let binds: Vec<DV> = params.iter().map(json_to_duck).collect();
    let mut stmt = match c.prepare(sql) {
        Ok(s) => s,
        // A script pasted as one statement: run it as a batch (no result set).
        Err(e) if params.is_empty() && is_multi_statement_error(&e) => {
            c.execute_batch(sql).map_err(|e| map_error(&e))?;
            return Ok(StatementOutcome::Ok);
        }
        Err(e) => return Err(map_error(&e)),
    };
    if util::is_dml(sql) && !util::returns_rows(sql) {
        let n = stmt.execute(duckdb::params_from_iter(binds.iter())).map_err(|e| map_error(&e))?;
        return Ok(StatementOutcome::Affected { affected: n as u64 });
    }
    let mut rows = stmt.query(duckdb::params_from_iter(binds.iter())).map_err(|e| map_error(&e))?;
    let cols: Vec<ColumnDef> = match rows.as_ref() {
        Some(st) => (0..st.column_count())
            .map(|i| {
                let name = st.column_name(i).map(|s| s.to_string()).unwrap_or_else(|_| format!("col{i}"));
                (name, type_name(&st.column_logical_type(i), 0))
            })
            .collect(),
        None => Vec::new(),
    };
    if cols.is_empty() {
        return Ok(StatementOutcome::Ok);
    }
    let tz: Vec<bool> = cols.iter().map(|(_, t)| t.ends_with("WITH TIME ZONE")).collect();
    let mut out: Vec<Value> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| map_error(&e))? {
        let mut obj = Map::new();
        for (i, (name, _)) in cols.iter().enumerate() {
            let v = match row.get::<_, DV>(i) {
                Ok(v) => to_json(v, tz[i]),
                // A type the wrapper cannot decode (e.g. VARIANT) — say so in the
                // cell instead of failing the whole result.
                Err(e) => Value::String(format!("<unreadable: {e}>")),
            };
            obj.insert(name.clone(), v);
        }
        out.push(Value::Object(obj));
    }
    if let Some(status) = status_outcome(&util::leading_verb(sql), &cols, &out) {
        return Ok(status);
    }
    let total = out.len() as u64;
    Ok(StatementOutcome::Rows { result: QueryResultSet { cols, rows: out, total } })
}

/// DuckDB answers DDL / session statements with a placeholder result — a single
/// `Count BIGINT` column (empty for CREATE/DROP, one row for CREATE TABLE AS /
/// COPY) or `Success BOOLEAN` (SET, ATTACH…). Those are shown as "OK" / "N rows
/// affected" like every other engine, not as a one-column grid. Only for these
/// verbs, so a SELECT whose own column is named `Count` stays a result set.
pub fn status_outcome(verb: &str, cols: &[ColumnDef], rows: &[Value]) -> Option<StatementOutcome> {
    const STATUS_VERBS: &[&str] = &[
        "CREATE", "DROP", "ALTER", "ATTACH", "DETACH", "SET", "RESET", "USE", "INSTALL", "LOAD", "COPY",
        "EXPORT", "IMPORT", "CHECKPOINT", "FORCE", "VACUUM", "BEGIN", "START", "COMMIT", "END", "ROLLBACK",
        "ABORT", "COMMENT", "PREPARE", "DEALLOCATE", "GRANT", "REVOKE", "ANALYZE",
    ];
    if !STATUS_VERBS.contains(&verb) || cols.len() != 1 {
        return None;
    }
    match (cols[0].0.as_str(), cols[0].1.as_str()) {
        ("Count", "BIGINT") => match rows.first().and_then(|r| r.get("Count")).and_then(Value::as_u64) {
            Some(n) => Some(StatementOutcome::Affected { affected: n }),
            None => Some(StatementOutcome::Ok),
        },
        ("Success", "BOOLEAN") => Some(StatementOutcome::Ok),
        _ => None,
    }
}

fn is_multi_statement_error(e: &duckdb::Error) -> bool {
    e.to_string().to_lowercase().contains("multiple statements")
}

/// Runs a catalog query (parameterised with `?`) and maps every row.
fn query_rows<T, F>(c: &Connection, sql: &str, params: &[Value], mut f: F) -> Result<Vec<T>, QueryError>
where
    F: FnMut(&duckdb::Row<'_>) -> duckdb::Result<T>,
{
    let binds: Vec<DV> = params.iter().map(json_to_duck).collect();
    let mut stmt = c.prepare(sql).map_err(|e| map_error(&e))?;
    let mut rows = stmt.query(duckdb::params_from_iter(binds.iter())).map_err(|e| map_error(&e))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| map_error(&e))? {
        out.push(f(row).map_err(|e| map_error(&e))?);
    }
    Ok(out)
}

/// Splits a list flattened with `array_to_string(…, chr(31))`.
fn split_list(s: &str) -> Vec<String> {
    s.split('\u{1f}').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

fn quote_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Indexed columns of a `CREATE INDEX` statement (`… ON t (a, "b c")`), falling
/// back to duckdb_indexes().expressions (`[a, b]`) when the SQL is unavailable.
pub fn index_columns(sql: Option<&str>, expressions: Option<&str>) -> Vec<String> {
    let from_sql = sql.and_then(|s| {
        let open = s.find('(')?;
        let close = s.rfind(')')?;
        (close > open).then(|| s[open + 1..close].to_string())
    });
    let list = from_sql.or_else(|| {
        expressions.map(|e| e.trim().trim_start_matches('[').trim_end_matches(']').to_string())
    });
    let Some(list) = list else { return Vec::new() };
    split_top_level(&list)
        .into_iter()
        .map(|p| {
            let p = p.trim().trim_matches('\'');
            if p.len() >= 2 && p.starts_with('"') && p.ends_with('"') {
                p[1..p.len() - 1].replace("\"\"", "\"")
            } else {
                p.to_string()
            }
        })
        .filter(|p| !p.is_empty())
        .collect()
}

/// Splits on commas that are not inside parentheses or double quotes.
fn split_top_level(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut depth, mut quoted) = (Vec::new(), String::new(), 0i32, false);
    for ch in s.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                cur.push(ch);
            }
            '(' if !quoted => {
                depth += 1;
                cur.push(ch);
            }
            ')' if !quoted => {
                depth -= 1;
                cur.push(ch);
            }
            ',' if !quoted && depth == 0 => out.push(std::mem::take(&mut cur)),
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

// ---------------------------------------------------------------------------
// Types and values
// ---------------------------------------------------------------------------

/// SQL type name of a result column, as DuckDB spells it (`INTEGER`,
/// `DECIMAL(10,2)`, `VARCHAR[]`, `STRUCT(a INTEGER, b VARCHAR)`, `JSON` …).
/// Only recurses into the container types whose children DuckDB exposes.
pub fn type_name(t: &LogicalTypeHandle, depth: usize) -> String {
    if let Some(alias) = t.get_alias() {
        return alias.to_uppercase();
    }
    use LogicalTypeId as L;
    let id = t.id();
    let deep = depth < 4;
    match id {
        L::Boolean => "BOOLEAN".into(),
        L::Tinyint => "TINYINT".into(),
        L::Smallint => "SMALLINT".into(),
        L::Integer => "INTEGER".into(),
        L::Bigint => "BIGINT".into(),
        L::Hugeint => "HUGEINT".into(),
        L::UTinyint => "UTINYINT".into(),
        L::USmallint => "USMALLINT".into(),
        L::UInteger => "UINTEGER".into(),
        L::UBigint => "UBIGINT".into(),
        L::UHugeint => "UHUGEINT".into(),
        L::Float => "FLOAT".into(),
        L::Double => "DOUBLE".into(),
        L::Decimal => format!("DECIMAL({},{})", t.decimal_width(), t.decimal_scale()),
        L::Varchar => "VARCHAR".into(),
        L::Blob => "BLOB".into(),
        L::Date => "DATE".into(),
        L::Time | L::TimeNs => "TIME".into(),
        L::TimeTZ => "TIME WITH TIME ZONE".into(),
        L::Timestamp => "TIMESTAMP".into(),
        L::TimestampS => "TIMESTAMP_S".into(),
        L::TimestampMs => "TIMESTAMP_MS".into(),
        L::TimestampNs => "TIMESTAMP_NS".into(),
        L::TimestampTZ => "TIMESTAMP WITH TIME ZONE".into(),
        L::Interval => "INTERVAL".into(),
        L::Uuid => "UUID".into(),
        L::Enum => "ENUM".into(),
        L::Bit => "BIT".into(),
        L::Bignum => "BIGNUM".into(),
        L::Geometry => "GEOMETRY".into(),
        L::Variant => "VARIANT".into(),
        L::List if deep => format!("{}[]", type_name(&t.child(0), depth + 1)),
        L::Array if deep => format!("{}[]", type_name(&t.child(0), depth + 1)),
        L::Map if deep => {
            format!("MAP({}, {})", type_name(&t.child(0), depth + 1), type_name(&t.child(1), depth + 1))
        }
        L::Struct | L::Union if deep => {
            let fields: Vec<String> = (0..t.num_children())
                .map(|i| format!("{} {}", t.child_name(i), type_name(&t.child(i), depth + 1)))
                .collect();
            format!("{}({})", if id == L::Struct { "STRUCT" } else { "UNION" }, fields.join(", "))
        }
        L::List | L::Array => "LIST".into(),
        L::Map => "MAP".into(),
        L::Struct => "STRUCT".into(),
        L::Union => "UNION".into(),
        _ => "UNKNOWN".into(),
    }
}

/// DuckDB value → JSON cell. Integers stay numbers while they fit an i64 (the
/// grid's contract); wider integers and DECIMALs are strings so no digit is lost.
/// Containers become JSON (the grid shows them with its JSON viewer).
pub fn to_json(v: DV, tz: bool) -> Value {
    match v {
        DV::Null => Value::Null,
        DV::Boolean(b) => Value::Bool(b),
        DV::TinyInt(n) => json!(n),
        DV::SmallInt(n) => json!(n),
        DV::Int(n) => json!(n),
        DV::BigInt(n) => json!(n),
        DV::UTinyInt(n) => json!(n),
        DV::USmallInt(n) => json!(n),
        DV::UInt(n) => json!(n),
        DV::UBigInt(n) => i64::try_from(n).map(|i| json!(i)).unwrap_or_else(|_| Value::String(n.to_string())),
        DV::HugeInt(n) => i64::try_from(n).map(|i| json!(i)).unwrap_or_else(|_| Value::String(n.to_string())),
        DV::UHugeInt(n) => i64::try_from(n).map(|i| json!(i)).unwrap_or_else(|_| Value::String(n.to_string())),
        DV::Float(f) => float(f as f64),
        DV::Double(f) => float(f),
        DV::Decimal(d) => Value::String(d.to_string()),
        DV::Text(s) => Value::String(s),
        DV::Enum(s) => Value::String(s),
        DV::Blob(b) | DV::Geometry(b) => Value::String(blob_text(&b)),
        DV::Date32(days) => Value::String(fmt_date(days)),
        DV::Time64(unit, v) => Value::String(fmt_time(unit.to_micros(v))),
        DV::Timestamp(unit, v) => Value::String(fmt_timestamp(unit.to_micros(v), tz)),
        DV::Interval { months, days, nanos } => Value::String(fmt_interval(months, days, nanos)),
        DV::List(items) | DV::Array(items) => Value::Array(items.into_iter().map(|i| to_json(i, tz)).collect()),
        DV::Struct(fields) => Value::Object(
            fields.iter().map(|(k, v)| (k.clone(), to_json(v.clone(), tz))).collect(),
        ),
        DV::Map(entries) => {
            let all_text = entries.iter().all(|(k, _)| matches!(k, DV::Text(_)));
            if all_text {
                Value::Object(
                    entries
                        .iter()
                        .map(|(k, v)| (if let DV::Text(s) = k { s.clone() } else { String::new() }, to_json(v.clone(), tz)))
                        .collect(),
                )
            } else {
                Value::Array(
                    entries
                        .iter()
                        .map(|(k, v)| json!({ "key": to_json(k.clone(), tz), "value": to_json(v.clone(), tz) }))
                        .collect(),
                )
            }
        }
        DV::Union(inner) => to_json(*inner, tz),
        other => Value::String(format!("{other:?}")),
    }
}

fn float(f: f64) -> Value {
    if f.is_finite() {
        json!(f)
    } else {
        // JSON has no NaN/Infinity; keep DuckDB's spelling.
        Value::String(if f.is_nan() { "nan".into() } else if f > 0.0 { "inf".into() } else { "-inf".into() })
    }
}

/// BLOB as DuckDB's literal escape (`\xAB\xCD`), which casts back to the same
/// bytes when the grid writes it.
pub fn blob_text(b: &[u8]) -> String {
    b.iter().map(|x| format!("\\x{x:02X}")).collect()
}

pub fn fmt_date(days: i32) -> String {
    chrono::NaiveDate::from_ymd_opt(1970, 1, 1)
        .and_then(|epoch| epoch.checked_add_signed(chrono::Duration::days(days as i64)))
        .map(|d| d.format("%Y-%m-%d").to_string())
        // ±infinity dates and anything outside chrono's range: say so, don't panic.
        .unwrap_or_else(|| match days {
            i32::MAX => "infinity".into(),
            i32::MIN => "-infinity".into(),
            other => format!("{other} days"),
        })
}

pub fn fmt_time(micros: i64) -> String {
    let secs = micros.div_euclid(1_000_000);
    let frac = micros.rem_euclid(1_000_000);
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if frac == 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{h:02}:{m:02}:{s:02}.{}", trim_frac(frac))
    }
}

pub fn fmt_timestamp(micros: i64, tz: bool) -> String {
    match chrono::DateTime::from_timestamp_micros(micros) {
        Some(dt) => {
            let frac = micros.rem_euclid(1_000_000);
            let base = dt.format("%Y-%m-%d %H:%M:%S").to_string();
            let base = if frac == 0 { base } else { format!("{base}.{}", trim_frac(frac)) };
            if tz { format!("{base}+00") } else { base }
        }
        None => match micros {
            i64::MAX => "infinity".into(),
            i64::MIN => "-infinity".into(),
            other => other.to_string(),
        },
    }
}

/// Microsecond fraction without trailing zeros (`.5`, `.123456`).
fn trim_frac(frac: i64) -> String {
    format!("{frac:06}").trim_end_matches('0').to_string()
}

/// INTERVAL as DuckDB prints it: `1 year 2 months 3 days 04:05:06.5`.
pub fn fmt_interval(months: i32, days: i32, nanos: i64) -> String {
    let unit = |n: i64, one: &str| format!("{n} {one}{}", if n.abs() == 1 { "" } else { "s" });
    let mut parts = Vec::new();
    let (years, mons) = (months / 12, months % 12);
    if years != 0 {
        parts.push(unit(years as i64, "year"));
    }
    if mons != 0 {
        parts.push(unit(mons as i64, "month"));
    }
    if days != 0 {
        parts.push(unit(days as i64, "day"));
    }
    let micros = nanos / 1000;
    if micros != 0 || parts.is_empty() {
        let sign = if micros < 0 { "-" } else { "" };
        parts.push(format!("{sign}{}", fmt_time(micros.abs())));
    }
    parts.join(" ")
}

/// JSON parameter → DuckDB value. Strings are bound as VARCHAR and DuckDB casts
/// them to the column's type (timestamps, decimals, UUIDs, BLOB escapes …).
fn json_to_duck(v: &Value) -> DV {
    match v {
        Value::Null => DV::Null,
        Value::Bool(b) => DV::Boolean(*b),
        Value::Number(n) if n.is_i64() => DV::BigInt(n.as_i64().unwrap_or(0)),
        Value::Number(n) if n.is_u64() => DV::UBigInt(n.as_u64().unwrap_or(0)),
        Value::Number(n) => DV::Double(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => DV::Text(s.clone()),
        other => DV::Text(other.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

pub fn map_error(e: &duckdb::Error) -> QueryError {
    let raw = e.to_string();
    let mut qe = QueryError::new(SYS, clean_message(&raw), raw.clone());
    qe.position = error_position(&raw);
    qe.hint = hint_for(&raw);
    // "Catalog Error: …" → code "Catalog".
    if let Some((kind, _)) = raw.split_once(" Error:") {
        if !kind.is_empty() && kind.len() <= 24 && kind.chars().all(|c| c.is_ascii_alphabetic() || c == ' ') {
            qe.code = Some(kind.trim().to_string());
        }
    }
    qe
}

/// The message without DuckDB's `LINE n: …` excerpt (the editor marks the spot).
fn clean_message(raw: &str) -> String {
    let head = raw.split("\n\nLINE ").next().unwrap_or(raw);
    head.trim().to_string()
}

/// Position from DuckDB's excerpt:
/// ```text
/// LINE 1: SELECT * FORM t
///                  ^
/// ```
/// Long lines are shortened with `...` — then the column is unknown, so none is
/// guessed.
pub fn error_position(raw: &str) -> Option<ErrorPosition> {
    let lines: Vec<&str> = raw.lines().collect();
    let idx = lines.iter().position(|l| l.starts_with("LINE "))?;
    let excerpt = lines[idx];
    let colon = excerpt.find(": ")?;
    let line: u32 = excerpt[5..colon].trim().parse().ok()?;
    let caret = lines.get(idx + 1)?.find('^')?;
    let body = &excerpt[colon + 2..];
    if body.starts_with("...") {
        return None;
    }
    let col = caret.checked_sub(colon + 2)? as u32 + 1;
    Some(ErrorPosition { line, col })
}

fn hint_for(raw: &str) -> Option<String> {
    let lower = raw.to_lowercase();
    let hint = if lower.contains("could not set lock on file") || lower.contains("conflicting lock") {
        "The file is locked by another process (DuckDB allows one writer). Close the other program, or open this connection Read-Only."
    } else if lower.contains("read-only") || lower.contains("read only") {
        "The database is open Read-Only — change the connection mode to write."
    } else if lower.contains("does not exist") && lower.contains("catalog error") {
        "Object does not exist in this database. Check the name, schema and the current database (USE)."
    } else if lower.contains("parser error") {
        "DuckDB syntax error."
    } else if lower.contains("constraint error") {
        "Constraint violation (PRIMARY KEY / UNIQUE / FOREIGN KEY / CHECK / NOT NULL)."
    } else if lower.contains("conversion error") {
        "A value could not be converted to the column's type."
    } else if lower.contains("interrupt") {
        "The query was cancelled."
    } else {
        return None;
    };
    Some(hint.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(path: &str, mode: SqliteMode, owner: &str) -> DuckConnParams {
        DuckConnParams { path: path.into(), mode, database: String::new(), owner: owner.into() }
    }

    #[test]
    fn instances_are_shared_per_file_and_per_in_memory_profile() {
        // Every connection of one profile shares the in-memory database…
        assert_eq!(
            instance_key(&params("", SqliteMode::ReadWrite, "c1")),
            instance_key(&params("", SqliteMode::InMemory, "c1#tab-7")),
        );
        assert_eq!(base_owner("c1::analytics"), "c1");
        assert_eq!(base_owner("c1#tab-3"), "c1");
        // …but two profiles never do.
        assert_ne!(
            instance_key(&params("", SqliteMode::InMemory, "c1")),
            instance_key(&params("", SqliteMode::InMemory, "c2")),
        );
        // A file is shared by path (two profiles on one file), split by mode.
        let f = std::env::temp_dir().join("dbstudio-key-test.duckdb");
        let f = f.to_string_lossy().to_string();
        assert_eq!(
            instance_key(&params(&f, SqliteMode::ReadWrite, "a")),
            instance_key(&params(&f, SqliteMode::ReadWrite, "b")),
        );
        assert_ne!(
            instance_key(&params(&f, SqliteMode::ReadWrite, "a")),
            instance_key(&params(&f, SqliteMode::ReadOnly, "a")),
        );
    }

    /// Regression: the key must not change when the file comes into existence —
    /// a new database file is created by the FIRST open, and a key that changed
    /// then made the second connection open the file again (DuckDB lock error).
    #[test]
    fn the_instance_key_is_the_same_before_and_after_the_file_exists() {
        let dir = std::env::temp_dir().join(format!("dbstudio-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("fresh.duckdb");
        let _ = std::fs::remove_file(&f);
        let f = f.to_string_lossy().to_string();
        let before = instance_key(&params(&f, SqliteMode::ReadWrite, "a"));
        std::fs::write(&f, b"x").unwrap();
        let after = instance_key(&params(&f, SqliteMode::ReadWrite, "b"));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(before, after);
    }

    #[test]
    fn temporal_and_interval_values_print_like_duckdb() {
        assert_eq!(fmt_date(0), "1970-01-01");
        assert_eq!(fmt_date(19723), "2024-01-01");
        assert_eq!(fmt_time(3_723_500_000), "01:02:03.5");
        assert_eq!(fmt_timestamp(1_704_067_200_000_000, false), "2024-01-01 00:00:00");
        assert_eq!(fmt_timestamp(1_704_067_200_123_456, true), "2024-01-01 00:00:00.123456+00");
        assert_eq!(fmt_interval(14, 3, 4 * 3_600_000_000_000), "1 year 2 months 3 days 04:00:00");
        assert_eq!(fmt_interval(0, 0, 0), "00:00:00");
        assert_eq!(fmt_interval(1, 1, 0), "1 month 1 day");
        assert_eq!(blob_text(&[0xAB, 0x01]), "\\xAB\\x01");
    }

    #[test]
    fn wide_numbers_and_decimals_keep_every_digit() {
        assert_eq!(to_json(DV::BigInt(42), false), json!(42));
        assert_eq!(to_json(DV::HugeInt(i128::MAX), false), json!(i128::MAX.to_string()));
        assert_eq!(to_json(DV::UBigInt(u64::MAX), false), json!(u64::MAX.to_string()));
        assert_eq!(to_json(DV::Double(f64::NAN), false), json!("nan"));
    }

    #[test]
    fn index_columns_come_from_the_create_statement() {
        assert_eq!(
            index_columns(Some("CREATE INDEX ix ON t(a, \"b c\");"), None),
            vec!["a".to_string(), "b c".to_string()]
        );
        assert_eq!(index_columns(Some("CREATE INDEX ix ON t (lower(name), id)"), None), vec!["lower(name)", "id"]);
        assert_eq!(index_columns(None, Some("[a, b]")), vec!["a", "b"]);
        assert!(index_columns(None, None).is_empty());
    }

    #[test]
    fn ddl_placeholder_results_read_as_ok_or_affected() {
        let count = vec![("Count".to_string(), "BIGINT".to_string())];
        let success = vec![("Success".to_string(), "BOOLEAN".to_string())];
        assert!(matches!(status_outcome("CREATE", &count, &[]), Some(StatementOutcome::Ok)));
        assert!(matches!(
            status_outcome("CREATE", &count, &[json!({"Count": 3})]),
            Some(StatementOutcome::Affected { affected: 3 })
        ));
        assert!(matches!(status_outcome("SET", &success, &[]), Some(StatementOutcome::Ok)));
        // a user's own column named Count is a result set
        assert!(status_outcome("SELECT", &count, &[json!({"Count": 3})]).is_none());
        assert!(status_outcome("CREATE", &[("x".into(), "INTEGER".into())], &[]).is_none());
    }

    #[test]
    fn parser_errors_carry_the_position_of_the_caret() {
        let raw = "Parser Error: syntax error at or near \"FORM\"\n\nLINE 1: SELECT * FORM t\n                 ^";
        let p = error_position(raw).expect("position");
        assert_eq!((p.line, p.col), (1, 10));
        assert_eq!(clean_message(raw), "Parser Error: syntax error at or near \"FORM\"");
        // Shortened excerpt → no guessed column.
        assert!(error_position("Parser Error: x\n\nLINE 1: ...abc FORM\n            ^").is_none());
    }
}
