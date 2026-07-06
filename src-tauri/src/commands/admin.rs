//! Admin views (Phase 5 · T23) — Session Monitor, Users & privileges, Extensions.
//! Đọc system views THẬT của engine. Query builder thuần → unit-test được;
//! command chạy qua registry.exec_statement và trả về QueryResultSet.

use tauri::State;

use crate::drivers::types::{ColumnDef, QueryResultSet, StatementOutcome};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

/// Parse output `INFO memory` của Redis (dòng `key:value`, bỏ header `# …`) →
/// bảng metric/value. Thuần → unit-test được.
pub fn parse_redis_info(text: &str) -> QueryResultSet {
    let rows: Vec<serde_json::Value> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| serde_json::json!({ "metric": k, "value": v }))
        .collect();
    let total = rows.len() as u64;
    QueryResultSet {
        cols: vec![
            ("metric".to_string(), "text".to_string()) as ColumnDef,
            ("value".to_string(), "text".to_string()),
        ],
        rows,
        total,
    }
}

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
        // --- MSSQL: Agent Jobs (đọc msdb.dbo.sysjobs — được kể cả khi Agent off) ---
        ("mssql", "agent_jobs") => {
            "SELECT j.name, j.enabled, COALESCE(c.name,'') AS category, j.date_created \
             FROM msdb.dbo.sysjobs j \
             LEFT JOIN msdb.dbo.syscategories c ON c.category_id = j.category_id \
             ORDER BY j.name"
        }
        // --- MSSQL: Query Store (mọi edition; cần bật QUERY_STORE trên DB) ---
        ("mssql", "query_store") => {
            "SELECT TOP 50 q.query_id, LEFT(t.query_sql_text, 100) AS query_text, \
                    rs.count_executions, CAST(rs.avg_duration/1000.0 AS decimal(18,2)) AS avg_ms \
             FROM sys.query_store_query q \
             JOIN sys.query_store_query_text t ON t.query_text_id = q.query_text_id \
             JOIN sys.query_store_plan p ON p.query_id = q.query_id \
             JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id \
             ORDER BY rs.avg_duration DESC"
        }
        // --- MSSQL: Availability Groups (DMV luôn tồn tại; rỗng nếu không có cluster) ---
        ("mssql", "availability_groups") => {
            "SELECT ag.name, COALESCE(rs.role_desc,'') AS role, \
                    COALESCE(rs.synchronization_health_desc,'') AS sync_health \
             FROM sys.availability_groups ag \
             LEFT JOIN sys.dm_hadr_availability_replica_states rs ON rs.group_id = ag.group_id \
             ORDER BY ag.name"
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
        .registry
        .system_of(&conn_id)
        .or_else(|| state.storage.get_connection(&conn_id).ok().map(|p| p.system.as_str().to_string()))
        .unwrap_or_default();

    // Redis không phải SQL: memory analysis qua INFO memory.
    if system == "redis" {
        if view != "memory" {
            return Err(AppError::Driver(format!("Admin view '{view}' is not supported for redis")));
        }
        let text = state
            .registry
            .with_driver(&conn_id, move |d| async move {
                let mut g = d.lock().await;
                match &mut *g {
                    LiveConnection::Redis(r) => r.command(&["INFO".into(), "memory".into()]).await,
                    _ => Err(QueryError::new("redis", "not redis", "not redis")),
                }
            })
            .await?
            .map_err(|e| AppError::Driver(e.message))?;
        return Ok(parse_redis_info(&text));
    }

    let sql = admin_query(&system, &view)
        .ok_or_else(|| AppError::Driver(format!("Admin view '{view}' is not supported for {system}")))?;
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
        .registry
        .system_of(&conn_id)
        .or_else(|| state.storage.get_connection(&conn_id).ok().map(|p| p.system.as_str().to_string()))
        .unwrap_or_default();
    let sql = kill_query(&system, pid)
        .ok_or_else(|| AppError::Driver(format!("Kill session is not supported for {system}")))?;
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
        // MSSQL admin views mở rộng (T23)
        assert!(admin_query("mssql", "agent_jobs").unwrap().contains("msdb.dbo.sysjobs"));
        assert!(admin_query("mssql", "query_store").unwrap().contains("sys.query_store_query"));
        assert!(admin_query("mssql", "availability_groups").unwrap().contains("sys.availability_groups"));
    }

    #[test]
    fn redis_info_parse() {
        let r = parse_redis_info("# Memory\nused_memory:1048576\nused_memory_human:1.00M\n\nmaxmemory:0\n");
        assert_eq!(r.total, 3);
        assert_eq!(r.rows[0]["metric"], serde_json::json!("used_memory"));
        assert_eq!(r.rows[0]["value"], serde_json::json!("1048576"));
        assert!(r.rows.iter().any(|x| x["metric"] == serde_json::json!("maxmemory")));
    }

    #[test]
    fn kill_query_per_dialect() {
        assert_eq!(kill_query("postgres", 42).unwrap(), "SELECT pg_terminate_backend(42)");
        assert_eq!(kill_query("mysql", 42).unwrap(), "KILL 42");
        assert_eq!(kill_query("mssql", 7).unwrap(), "KILL 7");
        assert!(kill_query("sqlite", 1).is_none());
    }
}
