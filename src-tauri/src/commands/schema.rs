//! IPC commands: Object Explorer introspection. Each command locks the live
//! driver and returns typed catalog data (queries are parameterized inside
//! each driver — identifiers only ever pass through dialect-safe quoting).

use tauri::State;

use crate::drivers::types::*;
use crate::error::AppError;
use crate::state::AppState;

macro_rules! introspect {
    ($state:expr, $conn_id:expr, $call:expr) => {{
        let out = $state.registry.with_driver(&$conn_id, $call).await?;
        out.map_err(|e| AppError::Driver(e.message))
    }};
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<SchemaInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.schemas().await
    })
}

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<DatabaseInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.databases().await
    })
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<TableInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.tables(&schema).await
    })
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
) -> Result<Vec<ColumnInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.columns(&schema, &table).await
    })
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
) -> Result<Vec<IndexInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.indexes(&schema, &table).await
    })
}

#[tauri::command]
pub async fn list_constraints(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
) -> Result<Vec<ConstraintInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.constraints(&schema, &table).await
    })
}

#[tauri::command]
pub async fn list_partitions(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
) -> Result<Vec<PartitionInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.partitions(&schema, &table).await
    })
}

#[tauri::command]
pub async fn list_routines(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<RoutineInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.routines(&schema).await
    })
}

#[tauri::command]
pub async fn list_triggers(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<TriggerInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.triggers(&schema).await
    })
}

#[tauri::command]
pub async fn list_sequences(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<SequenceInfo>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.sequences(&schema).await
    })
}

#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<Vec<ForeignKey>, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.foreign_keys(&schema).await
    })
}

#[tauri::command]
pub async fn scan_indexes(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
) -> Result<crate::drivers::index_scan::IndexScanResult, AppError> {
    introspect!(state, conn_id, |driver| async move {
        driver.lock().await.scan_indexes(&schema).await
    })
}

/// Câu truy vấn định nghĩa THẬT của object trên server (Explorer "Show
/// Definition" — T18). `kind` ∈ view/trigger/procedure/function. None nếu hệ
/// không hỗ trợ (Cassandra/CH dùng đường riêng). Thuần → unit-test được.
pub fn definition_query(system: &str, kind: &str, schema: &str, name: &str) -> Option<String> {
    let s = schema.replace('\'', "''");
    let n = name.replace('\'', "''");
    let q = match (system, kind) {
        ("postgres", "view") => format!("SELECT pg_get_viewdef('{s}.{n}'::regclass, true)"),
        ("postgres", "trigger") => format!(
            "SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid \
             JOIN pg_namespace ns ON ns.oid = c.relnamespace \
             WHERE ns.nspname = '{s}' AND t.tgname = '{n}' AND NOT t.tgisinternal LIMIT 1"
        ),
        ("postgres", _) => format!(
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace \
             WHERE ns.nspname = '{s}' AND p.proname = '{n}' LIMIT 1"
        ),
        // SHOW CREATE returns the FULL, runnable DDL (information_schema only has the
        // body, which isn't a valid statement to re-run and also comes back as a BLOB).
        // Identifiers are backtick-quoted; object_definition picks the "Create …" col.
        ("mysql" | "mariadb", kind) => {
            let bs = schema.replace('`', "``");
            let bn = name.replace('`', "``");
            let kw = match kind {
                "view" => "VIEW",
                "trigger" => "TRIGGER",
                "procedure" => "PROCEDURE",
                _ => "FUNCTION",
            };
            format!("SHOW CREATE {kw} `{bs}`.`{bn}`")
        }
        ("mssql", _) => format!("SELECT OBJECT_DEFINITION(OBJECT_ID('{s}.{n}')) AS d"),
        ("sqlite", _) => format!("SELECT sql FROM sqlite_master WHERE name = '{n}'"),
        // ClickHouse: SHOW CREATE returns the full runnable DDL in a `statement`
        // column (object_definition falls back to the first column). Views/MVs are
        // tables in system.tables → SHOW CREATE TABLE; dictionaries have their own.
        ("clickhouse", kind) => {
            let bs = schema.replace('`', "``");
            let bn = name.replace('`', "``");
            let kw = if kind == "dictionary" { "DICTIONARY" } else { "TABLE" };
            format!("SHOW CREATE {kw} `{bs}`.`{bn}`")
        }
        _ => return None,
    };
    Some(q)
}

/// SQL that returns the REAL, complete CREATE statement for one index (a single
/// text cell). Unlike a column-list reconstruction, this preserves INCLUDE
/// (covering) columns, filtered/partial WHERE, CLUSTERED/NONCLUSTERED, method,
/// expressions and column order — straight from each engine's catalog.
pub fn index_definition_query(system: &str, schema: &str, table: &str, name: &str) -> Option<String> {
    let s = schema.replace('\'', "''");
    let t = table.replace('\'', "''");
    let n = name.replace('\'', "''");
    let q = match system {
        // pg_get_indexdef emits the exact CREATE INDEX incl. USING method, INCLUDE,
        // partial WHERE and expressions. Index names are unique within a schema.
        "postgres" => format!(
            "SELECT pg_get_indexdef(i.indexrelid) AS d \
             FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid \
             JOIN pg_namespace nsp ON nsp.oid = c.relnamespace \
             WHERE nsp.nspname = '{s}' AND c.relname = '{n}' LIMIT 1"
        ),
        // sqlite_master.sql is the verbatim CREATE INDEX (incl. partial WHERE).
        "sqlite" => format!("SELECT sql AS d FROM sqlite_master WHERE type = 'index' AND name = '{n}' LIMIT 1"),
        // MySQL/MariaDB: no INCLUDE / partial indexes → the column list (with DESC)
        // is the whole definition. Rebuild from information_schema.STATISTICS.
        "mysql" | "mariadb" => {
            let bs = schema.replace('`', "``");
            let bt = table.replace('`', "``");
            format!(
                "SELECT CONCAT('CREATE ', IF(MAX(NON_UNIQUE)=0,'UNIQUE ',''), 'INDEX `', INDEX_NAME, \
                 '` ON `{bs}`.`{bt}` (', GROUP_CONCAT(CONCAT('`',COLUMN_NAME,'`', IF(COLLATION='D',' DESC','')) \
                 ORDER BY SEQ_IN_INDEX SEPARATOR ', '), ');') AS d \
                 FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA='{s}' AND TABLE_NAME='{t}' AND INDEX_NAME='{n}' \
                 GROUP BY INDEX_NAME"
            )
        }
        // MSSQL: reconstruct with FOR XML PATH + STUFF (all versions). Includes
        // CLUSTERED/NONCLUSTERED, key cols (with DESC), INCLUDE cols and filtered WHERE.
        "mssql" => format!(
            "SELECT 'CREATE ' + CASE WHEN i.is_unique=1 THEN 'UNIQUE ' ELSE '' END + i.type_desc + \
             ' INDEX [' + i.name + '] ON [' + sch.name + '].[' + t.name + '] (' + \
             STUFF((SELECT ', [' + c.name + ']' + CASE WHEN ic.is_descending_key=1 THEN ' DESC' ELSE '' END \
               FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id \
               WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.is_included_column=0 \
               ORDER BY ic.key_ordinal FOR XML PATH('')),1,2,'') + ')' + \
             ISNULL(' INCLUDE (' + STUFF((SELECT ', [' + c.name + ']' \
               FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id \
               WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.is_included_column=1 \
               ORDER BY ic.index_column_id FOR XML PATH('')),1,2,'') + ')','') + \
             ISNULL(' WHERE ' + i.filter_definition,'') + ';' AS d \
             FROM sys.indexes i JOIN sys.tables t ON t.object_id=i.object_id \
             JOIN sys.schemas sch ON sch.schema_id=t.schema_id \
             WHERE sch.name='{s}' AND t.name='{t}' AND i.name='{n}' AND i.type>0"
        ),
        // ClickHouse data-skipping index → the ALTER … ADD INDEX with expr/type/granularity.
        "clickhouse" => {
            let bs = schema.replace('`', "``");
            let bt = table.replace('`', "``");
            format!(
                "SELECT concat('ALTER TABLE `{bs}`.`{bt}` ADD INDEX ', name, ' ', expr, ' TYPE ', type, \
                 ' GRANULARITY ', toString(granularity), ';') AS d \
                 FROM system.data_skipping_indices \
                 WHERE database='{s}' AND table='{t}' AND name='{n}' LIMIT 1"
            )
        }
        _ => return None,
    };
    Some(q)
}

/// The real CREATE statement for one index (for the "Alter…" script). Falls back to
/// an empty string when the engine/index yields nothing (frontend then reconstructs).
#[tauri::command]
pub async fn index_definition(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
    name: String,
) -> Result<String, AppError> {
    let system = state
        .registry
        .system_of(&conn_id)
        .or_else(|| state.storage.get_connection(&conn_id).ok().map(|p| p.system.as_str().to_string()))
        .unwrap_or_default();
    let Some(q) = index_definition_query(&system, &schema, &table, &name) else {
        return Ok(String::new());
    };
    let outcome = state
        .registry
        .exec_statement(&conn_id, q)
        .await?
        .map_err(|e| AppError::Driver(e.message))?;
    let def = match outcome {
        StatementOutcome::Rows { result } => result
            .rows
            .first()
            .and_then(|r| r.as_object())
            .and_then(|o| o.values().next())
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default(),
        _ => String::new(),
    };
    Ok(def)
}

/// Show Definition: chạy `definition_query` → trả text định nghĩa thật.
#[tauri::command]
pub async fn object_definition(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    kind: String,
    name: String,
) -> Result<String, AppError> {
    // Resolve the engine from the LIVE connection first — this handles attached
    // per-database sub-connections (`{base}::{db}`) and quick-connects that aren't
    // in storage (otherwise system would be empty → "not supported" driver error).
    let system = state
        .registry
        .system_of(&conn_id)
        .or_else(|| state.storage.get_connection(&conn_id).ok().map(|p| p.system.as_str().to_string()))
        .unwrap_or_default();
    let q = definition_query(&system, &kind, &schema, &name)
        .ok_or_else(|| AppError::Driver(format!("Show Definition is not supported for {system}")))?;
    let outcome = state
        .registry
        .exec_statement(&conn_id, q)
        .await?
        .map_err(|e| AppError::Driver(e.message))?;
    match outcome {
        StatementOutcome::Rows { result } => {
            let def = result
                .rows
                .first()
                .and_then(|r| r.as_object())
                .and_then(|o| {
                    // MySQL SHOW CREATE returns several columns — the DDL is in
                    // "Create View/Function/Procedure" or (triggers) "SQL Original
                    // Statement". Single-column engines fall back to the first value.
                    o.iter()
                        .find(|(k, _)| {
                            let kl = k.to_lowercase();
                            kl.starts_with("create ") || kl == "sql original statement"
                        })
                        .map(|(_, v)| v)
                        .or_else(|| o.values().next())
                })
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if def.trim().is_empty() {
                Err(AppError::Driver("Definition not found".into()))
            } else {
                Ok(def)
            }
        }
        _ => Err(AppError::Driver("No definition returned".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::{definition_query, index_definition_query};

    #[test]
    fn index_definition_query_per_dialect() {
        // PG: authoritative pg_get_indexdef (covers INCLUDE / partial WHERE / method)
        assert!(index_definition_query("postgres", "public", "users", "ix_email")
            .unwrap()
            .contains("pg_get_indexdef"));
        // SQLite: verbatim CREATE from sqlite_master (incl. partial WHERE)
        assert!(index_definition_query("sqlite", "main", "t", "ix")
            .unwrap()
            .contains("sqlite_master"));
        // MySQL: rebuild from STATISTICS
        assert!(index_definition_query("mysql", "app", "users", "ix")
            .unwrap()
            .contains("information_schema.STATISTICS"));
        // MSSQL: sys.indexes reconstruction with INCLUDE + filtered WHERE + type_desc
        let mssql = index_definition_query("mssql", "dbo", "app_account_device", "idx").unwrap();
        assert!(mssql.contains("sys.indexes") && mssql.contains("is_included_column") && mssql.contains("filter_definition") && mssql.contains("type_desc"));
        // ClickHouse: data-skipping index add
        assert!(index_definition_query("clickhouse", "db", "events", "ix")
            .unwrap()
            .contains("system.data_skipping_indices"));
        // escape single quotes
        assert!(index_definition_query("postgres", "public", "t", "a'b").unwrap().contains("a''b"));
        // Cassandra: not applicable
        assert!(index_definition_query("cassandra", "ks", "t", "i").is_none());
    }

    #[test]
    fn definition_query_per_dialect() {
        assert!(definition_query("postgres", "function", "public", "add_one")
            .unwrap()
            .contains("pg_get_functiondef"));
        assert!(definition_query("postgres", "view", "public", "v")
            .unwrap()
            .contains("pg_get_viewdef"));
        assert!(definition_query("postgres", "trigger", "public", "trg")
            .unwrap()
            .contains("pg_get_triggerdef"));
        assert_eq!(
            definition_query("mysql", "function", "app", "f").unwrap(),
            "SHOW CREATE FUNCTION `app`.`f`"
        );
        assert_eq!(
            definition_query("mariadb", "view", "app", "v").unwrap(),
            "SHOW CREATE VIEW `app`.`v`"
        );
        assert_eq!(
            definition_query("mysql", "trigger", "app", "t").unwrap(),
            "SHOW CREATE TRIGGER `app`.`t`"
        );
        assert!(definition_query("mssql", "procedure", "dbo", "p")
            .unwrap()
            .contains("OBJECT_DEFINITION"));
        assert!(definition_query("sqlite", "view", "main", "v")
            .unwrap()
            .contains("sqlite_master"));
        // escape single quote để tránh nứt câu
        assert!(definition_query("postgres", "function", "public", "a'b")
            .unwrap()
            .contains("a''b"));
        // Cassandra không hỗ trợ
        assert!(definition_query("cassandra", "view", "ks", "v").is_none());
        // ClickHouse: SHOW CREATE TABLE for views/tables, DICTIONARY for dictionaries
        assert_eq!(
            definition_query("clickhouse", "view", "analytics", "v").unwrap(),
            "SHOW CREATE TABLE `analytics`.`v`"
        );
        assert_eq!(
            definition_query("clickhouse", "table", "analytics", "t").unwrap(),
            "SHOW CREATE TABLE `analytics`.`t`"
        );
        assert_eq!(
            definition_query("clickhouse", "dictionary", "analytics", "d").unwrap(),
            "SHOW CREATE DICTIONARY `analytics`.`d`"
        );
    }
}
