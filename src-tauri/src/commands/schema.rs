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
        ("mysql" | "mariadb", "view") => format!(
            "SELECT view_definition FROM information_schema.views WHERE table_schema = '{s}' AND table_name = '{n}'"
        ),
        ("mysql" | "mariadb", "trigger") => format!(
            "SELECT action_statement FROM information_schema.triggers WHERE trigger_schema = '{s}' AND trigger_name = '{n}'"
        ),
        ("mysql" | "mariadb", _) => format!(
            "SELECT routine_definition FROM information_schema.routines WHERE routine_schema = '{s}' AND routine_name = '{n}'"
        ),
        ("mssql", _) => format!("SELECT OBJECT_DEFINITION(OBJECT_ID('{s}.{n}')) AS d"),
        ("sqlite", _) => format!("SELECT sql FROM sqlite_master WHERE name = '{n}'"),
        _ => return None,
    };
    Some(q)
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
    let system = state
        .storage
        .get_connection(&conn_id)
        .map(|p| p.system.as_str().to_string())
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
                .and_then(|o| o.values().next())
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
    use super::definition_query;

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
        assert!(definition_query("mysql", "function", "app", "f")
            .unwrap()
            .contains("information_schema.routines"));
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
    }
}
