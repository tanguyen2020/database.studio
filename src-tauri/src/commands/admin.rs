//! Admin views (Phase 5 · T23) — Session Monitor, Users & privileges, Extensions.
//! Đọc system views THẬT của engine. Query builder thuần → unit-test được;
//! command chạy qua registry.exec_statement và trả về QueryResultSet.

use tauri::State;

use crate::drivers::types::{QueryResultSet, StatementOutcome};
use crate::error::AppError;
use crate::state::AppState;

/// SQL cho từng admin view theo hệ. None nếu hệ không hỗ trợ view đó.
pub fn admin_query(system: &str, view: &str) -> Option<String> {
    let sql = match (system, view) {
        // --- Session Monitor: phiên đang chạy ---
        ("postgres", "sessions") => {
            "SELECT pid, usename AS username, datname AS database, state, \
                    COALESCE(wait_event_type, '') AS wait, \
                    LEFT(COALESCE(query, ''), 120) AS query \
             FROM pg_stat_activity WHERE pid <> pg_backend_pid() OR pid = pg_backend_pid() \
             ORDER BY state, pid"
        }
        ("mysql" | "mariadb", "sessions") => {
            "SELECT id AS pid, user AS username, db AS database, command AS state, \
                    time AS seconds, LEFT(COALESCE(info,''),120) AS query \
             FROM information_schema.processlist ORDER BY time DESC"
        }
        ("mssql", "sessions") => {
            "SELECT session_id AS pid, login_name AS username, DB_NAME(database_id) AS database, \
                    status AS state, cpu_time AS cpu_ms FROM sys.dm_exec_sessions WHERE is_user_process = 1 \
             ORDER BY session_id"
        }
        // --- Locks ---
        ("postgres", "locks") => {
            "SELECT l.pid, l.locktype, l.mode, l.granted, c.relname AS relation \
             FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation \
             ORDER BY l.granted, l.pid LIMIT 200"
        }
        // --- Users & privileges ---
        ("postgres", "users") => {
            "SELECT rolname AS role, rolsuper AS is_superuser, rolcreatedb AS can_create_db, \
                    rolcreaterole AS can_create_role, rolcanlogin AS can_login \
             FROM pg_roles ORDER BY rolname"
        }
        ("mysql" | "mariadb", "users") => {
            "SELECT user AS role, host, \
                    CASE WHEN Super_priv='Y' THEN 1 ELSE 0 END AS is_superuser \
             FROM mysql.user ORDER BY user"
        }
        ("mssql", "users") => {
            "SELECT name AS role, type_desc AS kind, is_disabled \
             FROM sys.server_principals WHERE type IN ('S','U','G') ORDER BY name"
        }
        // --- PG Extension Manager ---
        ("postgres", "extensions") => {
            "SELECT a.name, a.default_version, i.extversion AS installed_version, a.comment \
             FROM pg_available_extensions a \
             LEFT JOIN pg_extension i ON i.extname = a.name \
             ORDER BY (i.extversion IS NULL), a.name"
        }
        _ => return None,
    };
    Some(sql.to_string())
}

/// Câu lệnh Kill/terminate phiên theo hệ. None nếu không hỗ trợ.
pub fn kill_query(system: &str, pid: i64) -> Option<String> {
    let sql = match system {
        "postgres" => format!("SELECT pg_terminate_backend({pid})"),
        "mysql" | "mariadb" => format!("KILL {pid}"),
        "mssql" => format!("KILL {pid}"),
        _ => return None,
    };
    Some(sql)
}

#[tauri::command]
pub async fn admin_view(
    state: State<'_, AppState>,
    conn_id: String,
    view: String,
) -> Result<QueryResultSet, AppError> {
    let system = state
        .storage
        .get_connection(&conn_id)
        .map(|p| p.system.as_str().to_string())
        .unwrap_or_default();
    let sql = admin_query(&system, &view)
        .ok_or_else(|| AppError::Driver(format!("Admin view '{view}' chưa hỗ trợ cho {system}")))?;
    let outcome = state
        .registry
        .exec_statement(&conn_id, sql)
        .await?
        .map_err(|e| AppError::Driver(e.message))?;
    match outcome {
        StatementOutcome::Rows { result } => Ok(result),
        _ => Ok(QueryResultSet { cols: Vec::new(), rows: Vec::new(), total: 0 }),
    }
}

#[tauri::command]
pub async fn kill_session(
    state: State<'_, AppState>,
    conn_id: String,
    pid: i64,
) -> Result<(), AppError> {
    let system = state
        .storage
        .get_connection(&conn_id)
        .map(|p| p.system.as_str().to_string())
        .unwrap_or_default();
    let sql = kill_query(&system, pid)
        .ok_or_else(|| AppError::Driver(format!("Kill session chưa hỗ trợ cho {system}")))?;
    state
        .registry
        .exec_statement(&conn_id, sql)
        .await?
        .map_err(|e| AppError::Driver(e.message))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_query_per_dialect() {
        assert!(admin_query("postgres", "sessions").unwrap().contains("pg_stat_activity"));
        assert!(admin_query("postgres", "locks").unwrap().contains("pg_locks"));
        assert!(admin_query("postgres", "users").unwrap().contains("pg_roles"));
        assert!(admin_query("postgres", "extensions").unwrap().contains("pg_available_extensions"));
        assert!(admin_query("mysql", "sessions").unwrap().contains("processlist"));
        assert!(admin_query("mssql", "sessions").unwrap().contains("dm_exec_sessions"));
        assert!(admin_query("redis", "sessions").is_none());
        // extensions chỉ PG
        assert!(admin_query("mysql", "extensions").is_none());
    }

    #[test]
    fn kill_query_per_dialect() {
        assert_eq!(kill_query("postgres", 42).unwrap(), "SELECT pg_terminate_backend(42)");
        assert_eq!(kill_query("mysql", 42).unwrap(), "KILL 42");
        assert_eq!(kill_query("mssql", 7).unwrap(), "KILL 7");
        assert!(kill_query("sqlite", 1).is_none());
    }
}
