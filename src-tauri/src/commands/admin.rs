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
            // `database` is a reserved word → must be back-quoted as a column alias.
            "SELECT id AS pid, user AS username, db AS `database`, command AS state, \
                    time AS seconds, LEFT(COALESCE(info,''),120) AS query \
             FROM information_schema.processlist ORDER BY time DESC"
        }
        ("mssql", "sessions") => {
            // `database` is a reserved keyword → must be bracket-quoted as a column alias.
            "SELECT session_id AS pid, login_name AS username, DB_NAME(database_id) AS [database], \
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
        // --- ClickHouse: running queries / mutations / users (system.*) ---
        ("clickhouse", "sessions") => {
            "SELECT query_id, user, round(elapsed, 3) AS elapsed_s, \
                    formatReadableSize(memory_usage) AS memory, read_rows, \
                    substring(query, 1, 160) AS query \
             FROM system.processes ORDER BY elapsed DESC"
        }
        ("clickhouse", "mutations") => {
            "SELECT database, table, mutation_id, command, is_done, create_time, \
                    COALESCE(latest_fail_reason, '') AS latest_fail_reason \
             FROM system.mutations ORDER BY create_time DESC LIMIT 200"
        }
        ("clickhouse", "users") => {
            "SELECT name, storage, auth_type FROM system.users ORDER BY name"
        }
        // --- PG Extension Manager ---
        ("postgres", "extensions") => {
            "SELECT a.name, a.default_version, i.extversion AS installed_version, a.comment \
             FROM pg_available_extensions a \
             LEFT JOIN pg_extension i ON i.extname = a.name \
             ORDER BY (i.extversion IS NULL), a.name"
        }
        // --- Oracle (V$/DBA views). Aliases quoted-lowercase so row keys match the
        //     frontend (`r['pid']`); Oracle would otherwise fold them to UPPERCASE. ---
        ("oracle", "sessions") => {
            "SELECT s.sid AS \"pid\", s.username AS \"username\", s.status AS \"state\", \
                    s.machine AS \"machine\", SUBSTR(NVL(q.sql_text, ' '), 1, 120) AS \"query\" \
             FROM v$session s LEFT JOIN v$sql q ON s.sql_id = q.sql_id \
             WHERE s.type = 'USER' ORDER BY s.sid"
        }
        ("oracle", "locks") => {
            "SELECT sid AS \"pid\", type AS \"locktype\", lmode AS \"mode\", request AS \"request\", block AS \"block\" \
             FROM v$lock ORDER BY sid"
        }
        ("oracle", "users") => {
            "SELECT username AS \"role\", account_status AS \"status\", default_tablespace AS \"tablespace\", \
                    TO_CHAR(created, 'YYYY-MM-DD') AS \"created\" FROM dba_users ORDER BY username"
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
        // Oracle needs 'sid,serial#'. We only get the SID → resolve serial# from
        // V$SESSION in a PL/SQL block and kill (no session found → no-op).
        "oracle" => format!(
            "BEGIN FOR s IN (SELECT sid, serial# AS sq FROM v$session WHERE sid = {pid}) LOOP \
             EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''' || s.sid || ',' || s.sq || ''' IMMEDIATE'; END LOOP; END;"
        ),
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

    // MongoDB không phải SQL: currentOp / serverStatus / usersInfo qua driver.
    if system == "mongodb" {
        let v = view.clone();
        return state
            .registry
            .with_driver(&conn_id, move |d| async move {
                let g = d.lock().await;
                match &*g {
                    LiveConnection::Mongo(m) => m.admin_view(&v).await,
                    _ => Err(QueryError::new("mongodb", "not mongodb", "not mongodb")),
                }
            })
            .await?
            .map_err(|e| AppError::Driver(e.message));
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
    // MongoDB: killOp qua driver (không phải SQL).
    if system == "mongodb" {
        return state
            .registry
            .with_driver(&conn_id, move |d| async move {
                let g = d.lock().await;
                match &*g {
                    LiveConnection::Mongo(m) => m.kill_op(pid).await,
                    _ => Err(QueryError::new("mongodb", "not mongodb", "not mongodb")),
                }
            })
            .await?
            .map_err(|e| AppError::Driver(e.message));
    }
    let sql = kill_query(&system, pid)
        .ok_or_else(|| AppError::Driver(format!("Kill session is not supported for {system}")))?;
    state
        .registry
        .exec_statement(&conn_id, sql)
        .await?
        .map_err(|e| AppError::Driver(e.message))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Drop Database when the database is held by other sessions.
// ---------------------------------------------------------------------------

/// How long MySQL/MariaDB may wait for metadata locks during DROP DATABASE.
/// MySQL does NOT error when another session holds a lock on a table of the
/// database — DROP just waits `lock_wait_timeout` (default: one YEAR), freezing
/// the connection. Bounding it turns "hangs forever" into "in use" + the list.
pub const MYSQL_DROP_LOCK_WAIT_SECS: u32 = 8;

fn lit(system: &str, s: &str) -> String {
    crate::commands::users_admin::quote_str(system, s)
}

/// Sessions (other than our own) connected to / holding locks on `db` — the
/// ones that keep DROP DATABASE from running. Every engine returns the same
/// column aliases so the dialog renders one shape: pid, username, client,
/// program, state, started, query, holds_lock. None = engine has no such notion.
pub fn database_sessions_query(system: &str, db: &str) -> Option<String> {
    let l = lit(system, db);
    let sql = match system {
        "postgres" => format!(
            "SELECT pid, COALESCE(usename, '') AS username, \
                    COALESCE(client_addr::text, 'local') AS client, \
                    COALESCE(application_name, '') AS program, COALESCE(state, '') AS state, \
                    COALESCE(to_char(backend_start, 'YYYY-MM-DD HH24:MI:SS'), '') AS started, \
                    LEFT(COALESCE(query, ''), 200) AS query, 1 AS holds_lock \
             FROM pg_stat_activity WHERE datname = {l} AND pid <> pg_backend_pid() \
             ORDER BY backend_start"
        ),
        // Idle `USE db` sessions do not block DROP DATABASE in MySQL — sessions
        // holding a metadata lock on one of its tables do. Both are listed;
        // `holds_lock` tells them apart. Needs performance_schema (MySQL 5.7+,
        // MariaDB 10.5+); `database_sessions_fallback` covers the rest.
        "mysql" | "mariadb" => {
            let mdl = format!(
                "SELECT t.PROCESSLIST_ID FROM performance_schema.metadata_locks m \
                 JOIN performance_schema.threads t ON t.THREAD_ID = m.OWNER_THREAD_ID \
                 WHERE m.OBJECT_SCHEMA = {l} AND m.LOCK_STATUS = 'GRANTED' AND t.PROCESSLIST_ID IS NOT NULL"
            );
            format!(
                "SELECT CAST(p.ID AS SIGNED) AS pid, p.USER AS username, COALESCE(p.HOST, '') AS client, \
                        '' AS program, COALESCE(p.COMMAND, '') AS state, \
                        CAST(COALESCE(p.TIME, 0) AS SIGNED) AS seconds, '' AS started, \
                        LEFT(COALESCE(p.INFO, ''), 200) AS query, \
                        CAST(CASE WHEN p.ID IN ({mdl}) THEN 1 ELSE 0 END AS SIGNED) AS holds_lock \
                 FROM information_schema.PROCESSLIST p \
                 WHERE p.ID <> CONNECTION_ID() AND (p.DB = {l} OR p.ID IN ({mdl})) \
                 ORDER BY holds_lock DESC, p.ID"
            )
        }
        // A session is "in" the database (database_id) or holds a lock on it from
        // another database (dm_tran_locks). System sessions cannot be KILLed.
        "mssql" => format!(
            "SELECT s.session_id AS pid, COALESCE(s.login_name, '') AS username, \
                    COALESCE(s.host_name, '') AS client, COALESCE(s.program_name, '') AS program, \
                    COALESCE(s.status, '') AS state, CONVERT(varchar(19), s.login_time, 120) AS started, \
                    '' AS query, 1 AS holds_lock \
             FROM sys.dm_exec_sessions s \
             WHERE s.is_user_process = 1 AND s.session_id <> @@SPID \
               AND (s.database_id = DB_ID({l}) OR s.session_id IN \
                    (SELECT request_session_id FROM sys.dm_tran_locks WHERE resource_database_id = DB_ID({l}))) \
             ORDER BY s.session_id"
        ),
        // A "database" in the tree is a schema = user; DROP USER fails with
        // ORA-01940 while that user is logged in.
        "oracle" => format!(
            "SELECT s.sid AS \"pid\", NVL(s.username, ' ') AS \"username\", NVL(s.machine, ' ') AS \"client\", \
                    NVL(s.program, ' ') AS \"program\", NVL(s.status, ' ') AS \"state\", \
                    TO_CHAR(s.logon_time, 'YYYY-MM-DD HH24:MI:SS') AS \"started\", ' ' AS \"query\", 1 AS \"holds_lock\" \
             FROM v$session s WHERE s.username = {l} AND s.sid <> SYS_CONTEXT('USERENV', 'SID') \
             ORDER BY s.sid"
        ),
        _ => return None,
    };
    Some(sql)
}

/// MySQL/MariaDB without a readable performance_schema: sessions whose current
/// database is `db` (holds_lock unknown → 0).
pub fn database_sessions_fallback(system: &str, db: &str) -> Option<String> {
    if !matches!(system, "mysql" | "mariadb") {
        return None;
    }
    let l = lit(system, db);
    Some(format!(
        "SELECT CAST(p.ID AS SIGNED) AS pid, p.USER AS username, COALESCE(p.HOST, '') AS client, \
                '' AS program, COALESCE(p.COMMAND, '') AS state, \
                CAST(COALESCE(p.TIME, 0) AS SIGNED) AS seconds, '' AS started, \
                LEFT(COALESCE(p.INFO, ''), 200) AS query, CAST(0 AS SIGNED) AS holds_lock \
         FROM information_schema.PROCESSLIST p \
         WHERE p.ID <> CONNECTION_ID() AND p.DB = {l} ORDER BY p.ID"
    ))
}

/// True when a DROP DATABASE failed because OTHER sessions use the database —
/// the case the dialog can fix by killing them. Not "it does not exist", not a
/// permission error, and (PostgreSQL) not "cannot drop the currently open
/// database" (that one is us, and killing others would not help).
pub fn database_in_use(system: &str, e: &QueryError) -> bool {
    let m = format!("{} {}", e.message, e.raw).to_lowercase();
    match system {
        "postgres" => m.contains("is being accessed by other users"),
        "mssql" => e.code.as_deref() == Some("3702") || m.contains("currently in use"),
        "mysql" | "mariadb" => m.contains("lock wait timeout exceeded"),
        "oracle" => m.contains("ora-01940"),
        _ => false,
    }
}

#[derive(serde::Serialize, Debug)]
pub struct DropDatabaseOutcome {
    pub dropped: bool,
    /// Other sessions hold the database — list them (`database_sessions`),
    /// kill (`kill_session`) and drop again.
    pub in_use: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<QueryError>,
}

fn system_for(state: &State<'_, AppState>, conn_id: &str) -> String {
    state
        .registry
        .system_of(conn_id)
        .or_else(|| state.storage.get_connection(conn_id).ok().map(|p| p.system.as_str().to_string()))
        .unwrap_or_default()
}

/// Runs a DROP DATABASE / DROP USER … CASCADE statement and reports whether it
/// failed because the database is in use. MySQL/MariaDB get a bounded
/// `lock_wait_timeout` for this one statement (restored afterwards) so a held
/// metadata lock surfaces as "in use" instead of freezing the connection.
#[tauri::command]
pub async fn drop_database(
    state: State<'_, AppState>,
    conn_id: String,
    statement: String,
) -> Result<DropDatabaseOutcome, AppError> {
    let system = system_for(&state, &conn_id);
    let mysql = matches!(system.as_str(), "mysql" | "mariadb");
    if mysql {
        state
            .registry
            .exec_statement(&conn_id, format!("SET SESSION lock_wait_timeout = {MYSQL_DROP_LOCK_WAIT_SECS}"))
            .await?
            .map_err(|e| AppError::Driver(e.message))?;
    }
    let res = state.registry.exec_statement(&conn_id, statement).await;
    if mysql {
        // `DEFAULT` = the server's global value, i.e. what the session had.
        let _ = state
            .registry
            .exec_statement(&conn_id, "SET SESSION lock_wait_timeout = DEFAULT".to_string())
            .await;
    }
    match res? {
        Ok(_) => Ok(DropDatabaseOutcome { dropped: true, in_use: false, error: None }),
        Err(e) => Ok(DropDatabaseOutcome { dropped: false, in_use: database_in_use(&system, &e), error: Some(e) }),
    }
}

/// The sessions keeping `database` from being dropped (see
/// `database_sessions_query`). Killed one by one with `kill_session`.
#[tauri::command]
pub async fn database_sessions(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<QueryResultSet, AppError> {
    let system = system_for(&state, &conn_id);
    let sql = database_sessions_query(&system, &database)
        .ok_or_else(|| AppError::Driver(format!("Listing sessions is not supported for {system}")))?;
    let first = state.registry.exec_statement(&conn_id, sql).await?;
    let outcome = match first {
        Ok(o) => o,
        Err(e) => match database_sessions_fallback(&system, &database) {
            Some(fb) => state
                .registry
                .exec_statement(&conn_id, fb)
                .await?
                .map_err(|e2| AppError::Driver(e2.message))?,
            None => return Err(AppError::Driver(e.message)),
        },
    };
    match outcome {
        StatementOutcome::Rows { result } => Ok(result),
        _ => Ok(QueryResultSet { cols: Vec::new(), rows: Vec::new(), total: 0 }),
    }
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
        // the reserved word `database` MUST be quoted as an alias (else a syntax error)
        let my = admin_query("mysql", "sessions").unwrap();
        assert!(my.contains("processlist") && my.contains("AS `database`"), "mysql alias back-quoted: {my}");
        let ms = admin_query("mssql", "sessions").unwrap();
        assert!(ms.contains("dm_exec_sessions") && ms.contains("AS [database]"), "mssql alias bracket-quoted: {ms}");
        assert!(admin_query("redis", "sessions").is_none());
        // extensions chỉ PG
        assert!(admin_query("mysql", "extensions").is_none());
        // MSSQL admin views mở rộng (T23)
        assert!(admin_query("mssql", "agent_jobs").unwrap().contains("msdb.dbo.sysjobs"));
        assert!(admin_query("mssql", "query_store").unwrap().contains("sys.query_store_query"));
        assert!(admin_query("mssql", "availability_groups").unwrap().contains("sys.availability_groups"));
        // ClickHouse: running queries / mutations / users from system.*
        assert!(admin_query("clickhouse", "sessions").unwrap().contains("system.processes"));
        assert!(admin_query("clickhouse", "mutations").unwrap().contains("system.mutations"));
        assert!(admin_query("clickhouse", "users").unwrap().contains("system.users"));
        assert!(admin_query("clickhouse", "extensions").is_none());
    }

    #[test]
    fn redis_info_parse() {
        let r = parse_redis_info("# Memory\nused_memory:1048576\nused_memory_human:1.00M\n\nmaxmemory:0\n");
        assert_eq!(r.total, 3);
        assert_eq!(r.rows[0]["metric"], serde_json::json!("used_memory"));
        assert_eq!(r.rows[0]["value"], serde_json::json!("1048576"));
        assert!(r.rows.iter().any(|x| x["metric"] == serde_json::json!("maxmemory")));
    }

    fn qe(code: Option<&str>, msg: &str) -> QueryError {
        let mut e = QueryError::new("x", msg, msg);
        e.code = code.map(|c| c.to_string());
        e
    }

    #[test]
    fn database_sessions_query_per_dialect() {
        let pg = database_sessions_query("postgres", "app's").unwrap();
        assert!(pg.contains("pg_stat_activity") && pg.contains("datname = 'app''s'") && pg.contains("pg_backend_pid()"), "{pg}");
        let my = database_sessions_query("mysql", r"a\b").unwrap();
        assert!(my.contains("metadata_locks") && my.contains("CONNECTION_ID()") && my.contains(r"'a\\b'"), "{my}");
        assert!(database_sessions_fallback("mariadb", "a").unwrap().contains("p.DB = 'a'"));
        assert!(database_sessions_fallback("postgres", "a").is_none());
        let ms = database_sessions_query("mssql", "Sales").unwrap();
        assert!(ms.contains("DB_ID(N'Sales')") && ms.contains("@@SPID") && ms.contains("is_user_process = 1"), "{ms}");
        let ora = database_sessions_query("oracle", "APP").unwrap();
        assert!(ora.contains("v$session") && ora.contains("username = 'APP'"), "{ora}");
        assert!(database_sessions_query("clickhouse", "a").is_none());
        assert!(database_sessions_query("sqlite", "a").is_none());
    }

    #[test]
    fn database_in_use_per_dialect() {
        assert!(database_in_use("postgres", &qe(Some("55006"), "database \"x\" is being accessed by other users")));
        // the SAME SQLSTATE for "currently open database" is NOT fixable by killing others
        assert!(!database_in_use("postgres", &qe(Some("55006"), "cannot drop the currently open database")));
        assert!(database_in_use("mssql", &qe(Some("3702"), "Cannot drop database \"x\" because it is currently in use.")));
        assert!(database_in_use("mysql", &qe(Some("HY000"), "Lock wait timeout exceeded; try restarting transaction")));
        assert!(database_in_use("oracle", &qe(None, "ORA-01940: cannot drop a user who is currently connected")));
        assert!(!database_in_use("postgres", &qe(Some("3D000"), "database \"x\" does not exist")));
        assert!(!database_in_use("mysql", &qe(None, "Access denied for user")));
    }

    #[test]
    fn kill_query_per_dialect() {
        assert_eq!(kill_query("postgres", 42).unwrap(), "SELECT pg_terminate_backend(42)");
        assert_eq!(kill_query("mysql", 42).unwrap(), "KILL 42");
        assert_eq!(kill_query("mssql", 7).unwrap(), "KILL 7");
        assert!(kill_query("sqlite", 1).is_none());
    }
}
