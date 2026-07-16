//! User Manager (Users / Roles & Privileges) — read side.
//!
//! Mirrors `commands/admin.rs`: a pure SQL builder (`users_query`) that is
//! unit-testable per (system, view), plus a thin `users_view` command that runs
//! it through the registry. Per-engine views are filled in phase-by-phase
//! (U1 PostgreSQL, U2 MySQL/MariaDB, …); U0 ships the framework + escapers +
//! the PostgreSQL `roles`/`users` views so the wiring is proven end-to-end.
//!
//! Mutations (CREATE/ALTER/DROP USER, GRANT/REVOKE) are built on the frontend
//! (pure builders in `src/lib/users/*.ts`) and executed via `exec_statement` /
//! `cql_exec` / Mongo commands — NOT here. This module is read-only.

use tauri::State;

use crate::drivers::types::{QueryResultSet, StatementOutcome};
use crate::error::AppError;
use crate::state::AppState;

/// Quote an identifier (role/user/schema/object name) per dialect. Free text
/// from the UI (principal names, object names) flows through here before being
/// interpolated into a statement — privilege keywords are enum whitelists in
/// the frontend builders and never reach this path.
pub fn quote_ident(system: &str, name: &str) -> String {
    match system {
        // backtick dialects — MySQL/MariaDB double the backtick; ClickHouse
        // escapes it with a backslash.
        "mysql" | "mariadb" => format!("`{}`", name.replace('`', "``")),
        "clickhouse" => format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`")),
        // bracket dialect
        "mssql" => format!("[{}]", name.replace(']', "]]")),
        // double-quote dialects (PostgreSQL, Cassandra, Oracle when quoting)
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// Quote a string literal (password, timestamp, host) per dialect.
pub fn quote_str(system: &str, s: &str) -> String {
    match system {
        // MySQL/MariaDB string literals treat backslash as an escape char.
        "mysql" | "mariadb" => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
        // ClickHouse also backslash-escapes.
        "clickhouse" => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'")),
        // MSSQL uses N'…' for unicode-safe literals.
        "mssql" => format!("N'{}'", s.replace('\'', "''")),
        // ANSI single-quote doubling (PostgreSQL, Cassandra, Oracle)
        _ => format!("'{}'", s.replace('\'', "''")),
    }
}

/// A MySQL/MariaDB account literal `'user'@'host'`.
pub fn mysql_account(system: &str, user: &str, host: &str) -> String {
    format!("{}@{}", quote_str(system, user), quote_str(system, host))
}

/// Read SQL for a (system, view). `arg` = principal name for per-user views
/// (already trusted — quoted by the caller as needed). Returns None if the
/// view is not applicable to the system.
pub fn users_query(system: &str, view: &str, arg: Option<&str>) -> Option<String> {
    // SHOW GRANTS FOR <account> — the account literal ('u'@'h') is built + quoted
    // by the frontend escaper and passed as `arg` (SHOW GRANTS can't be prepared).
    if view == "grants_for" && matches!(system, "mysql" | "mariadb") {
        let acct = arg?;
        return Some(format!("SHOW GRANTS FOR {acct}"));
    }
    let sql = match (system, view) {
        // ---- PostgreSQL (U1) --------------------------------------------
        // "users" is an alias of "roles" so the generic shell can request a
        // default view name before the PG-specific manager loads.
        ("postgres", "roles") | ("postgres", "users") => {
            "SELECT rolname AS name, rolsuper, rolinherit, rolcreaterole, rolcreatedb, \
                    rolcanlogin, rolreplication, rolbypassrls, rolconnlimit, \
                    COALESCE(rolvaliduntil::text,'') AS valid_until \
             FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname"
        }
        ("postgres", "members") => {
            "SELECT m.roleid::regrole::text AS role, m.member::regrole::text AS member, \
                    m.admin_option, m.grantor::regrole::text AS grantor \
             FROM pg_auth_members m ORDER BY 1, 2"
        }
        ("postgres", "db_grants") => {
            "SELECT d.datname AS database, \
                    CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, \
                    a.privilege_type, a.is_grantable \
             FROM pg_database d, LATERAL aclexplode(d.datacl) a \
             WHERE d.datacl IS NOT NULL ORDER BY 1, 2"
        }
        ("postgres", "schema_grants") => {
            "SELECT n.nspname AS schema, \
                    CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, \
                    a.privilege_type, a.is_grantable \
             FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a \
             WHERE n.nspacl IS NOT NULL AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1, 2"
        }
        ("postgres", "table_grants") => {
            "SELECT n.nspname AS schema, c.relname AS object, c.relkind::text AS kind, \
                    CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, \
                    a.privilege_type, a.is_grantable \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, \
                  LATERAL aclexplode(c.relacl) a \
             WHERE c.relacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog','information_schema') \
             ORDER BY 1, 2, 4"
        }
        ("postgres", "default_acl") => {
            "SELECT pg_get_userbyid(d.defaclrole) AS owner, COALESCE(n.nspname,'') AS schema, \
                    d.defaclobjtype::text AS objtype, \
                    CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, \
                    a.privilege_type, a.is_grantable \
             FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, \
                  LATERAL aclexplode(d.defaclacl) a ORDER BY 1, 2"
        }
        // schema owners — for the "future tables" default-privileges preset.
        ("postgres", "schema_owners") => {
            "SELECT nspname AS schema, pg_get_userbyid(nspowner) AS owner \
             FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' \
             ORDER BY 1"
        }
        // whether the current connection can manage roles (banner gate).
        ("postgres", "can_manage") => {
            "SELECT (rolsuper OR rolcreaterole) AS can_manage FROM pg_roles WHERE rolname = current_user"
        }

        // ---- MySQL (U2) -------------------------------------------------
        ("mysql", "users") => {
            "SELECT user, host, plugin, account_locked, password_expired, \
                    CAST(password_last_changed AS CHAR) AS password_last_changed \
             FROM mysql.user ORDER BY user, host"
        }
        ("mysql", "schema_privs") | ("mariadb", "schema_privs") => {
            "SELECT GRANTEE AS grantee, TABLE_SCHEMA AS table_schema, PRIVILEGE_TYPE AS privilege_type, \
                    IS_GRANTABLE AS is_grantable \
             FROM information_schema.SCHEMA_PRIVILEGES ORDER BY GRANTEE, TABLE_SCHEMA"
        }
        ("mysql", "table_privs") | ("mariadb", "table_privs") => {
            "SELECT GRANTEE AS grantee, TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, \
                    PRIVILEGE_TYPE AS privilege_type, IS_GRANTABLE AS is_grantable \
             FROM information_schema.TABLE_PRIVILEGES ORDER BY GRANTEE, TABLE_SCHEMA, TABLE_NAME"
        }
        ("mysql", "global_privs") | ("mariadb", "global_privs") => {
            "SELECT GRANTEE AS grantee, PRIVILEGE_TYPE AS privilege_type, IS_GRANTABLE AS is_grantable \
             FROM information_schema.USER_PRIVILEGES ORDER BY GRANTEE, PRIVILEGE_TYPE"
        }
        ("mysql", "role_edges") => {
            "SELECT FROM_USER AS role_user, FROM_HOST AS role_host, TO_USER AS member_user, \
                    TO_HOST AS member_host, WITH_ADMIN_OPTION AS with_admin_option \
             FROM mysql.role_edges ORDER BY 1, 3"
        }
        ("mysql", "default_roles") | ("mariadb", "default_roles") => {
            "SELECT USER AS member_user, HOST AS member_host, DEFAULT_ROLE_USER, DEFAULT_ROLE_HOST \
             FROM mysql.default_roles ORDER BY 1"
        }

        // ---- MariaDB (U2) — has a real is_role flag + roles_mapping ------
        ("mariadb", "users") => {
            "SELECT user, host, plugin, account_locked, password_expired, is_role \
             FROM mysql.user ORDER BY user, host"
        }
        ("mariadb", "roles_mapping") => {
            "SELECT Host AS member_host, User AS member_user, Role AS role, Admin_option AS admin_option \
             FROM mysql.roles_mapping ORDER BY Role, User"
        }

        // ---- ClickHouse (U4) — SQL-driven RBAC (system.*) ---------------
        // toString() keeps version-safe (auth_type/host_* became Arrays in newer CH).
        ("clickhouse", "users") => {
            "SELECT name, storage, toString(auth_type) AS auth_type, toString(host_ip) AS host_ip, \
                    toString(host_names) AS host_names, default_roles_all, \
                    toString(default_roles_list) AS default_roles, toString(default_database) AS default_database \
             FROM system.users ORDER BY name"
        }
        ("clickhouse", "roles") => "SELECT name, storage FROM system.roles ORDER BY name",
        ("clickhouse", "grants") => {
            "SELECT COALESCE(user_name, '') AS user, COALESCE(role_name, '') AS role, \
                    toString(access_type) AS access_type, COALESCE(database, '') AS database, \
                    COALESCE(table, '') AS table, COALESCE(column, '') AS column, \
                    is_partial_revoke, grant_option \
             FROM system.grants ORDER BY user, role, access_type"
        }
        ("clickhouse", "role_grants") => {
            "SELECT COALESCE(user_name,'') AS user, COALESCE(role_name,'') AS role, \
                    granted_role_name, with_admin_option \
             FROM system.role_grants ORDER BY 1, 3"
        }
        ("clickhouse", "can_manage") => {
            // access_management shows up as an ACCESS MANAGEMENT grant in SHOW GRANTS;
            // probe by counting the current user's access-management grants.
            "SELECT count() > 0 AS can_manage FROM system.grants \
             WHERE user_name = currentUser() AND access_type = 'ACCESS MANAGEMENT'"
        }

        // ---- MSSQL (U3) — server-level Logins + database-level Users -----
        ("mssql", "logins") => {
            "SELECT p.name, p.type_desc, p.is_disabled, CAST(p.create_date AS varchar(19)) AS create_date, \
                    p.default_database_name, COALESCE(l.is_policy_checked, 0) AS is_policy_checked \
             FROM sys.server_principals p LEFT JOIN sys.sql_logins l ON l.principal_id = p.principal_id \
             WHERE p.type IN ('S','U','G','E','X') AND p.name NOT LIKE '##%' ORDER BY p.name"
        }
        ("mssql", "server_roles") => {
            "SELECT name FROM sys.server_principals WHERE type = 'R' ORDER BY name"
        }
        ("mssql", "server_role_members") => {
            "SELECT r.name AS role, m.name AS member \
             FROM sys.server_role_members rm \
             JOIN sys.server_principals r ON r.principal_id = rm.role_principal_id \
             JOIN sys.server_principals m ON m.principal_id = rm.member_principal_id \
             ORDER BY r.name, m.name"
        }
        ("mssql", "db_users") => {
            "SELECT dp.name, dp.type_desc, COALESCE(dp.default_schema_name,'') AS default_schema, \
                    COALESCE(sp.name,'') AS login_name, \
                    CASE WHEN dp.type = 'S' AND sp.sid IS NULL AND dp.authentication_type <> 0 THEN 1 ELSE 0 END AS orphaned \
             FROM sys.database_principals dp LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid \
             WHERE dp.type IN ('S','U','G','E','X') AND dp.name NOT IN ('sys','INFORMATION_SCHEMA','guest') \
             ORDER BY dp.name"
        }
        ("mssql", "db_roles") => {
            "SELECT name, is_fixed_role FROM sys.database_principals WHERE type = 'R' \
             ORDER BY is_fixed_role DESC, name"
        }
        ("mssql", "db_role_members") => {
            "SELECT r.name AS role, m.name AS member \
             FROM sys.database_role_members rm \
             JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id \
             JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id \
             ORDER BY r.name, m.name"
        }
        ("mssql", "db_permissions") => {
            "SELECT pr.name AS principal, pe.state_desc, pe.permission_name, \
                    CASE pe.class WHEN 0 THEN 'DATABASE' \
                                  WHEN 1 THEN COALESCE(OBJECT_SCHEMA_NAME(pe.major_id) + '.' + OBJECT_NAME(pe.major_id), '?') \
                                  WHEN 3 THEN 'SCHEMA::' + SCHEMA_NAME(pe.major_id) \
                                  ELSE pe.class_desc END AS securable, \
                    COALESCE(c.name, '') AS column_name \
             FROM sys.database_permissions pe \
             JOIN sys.database_principals pr ON pr.principal_id = pe.grantee_principal_id \
             LEFT JOIN sys.columns c ON pe.class = 1 AND c.object_id = pe.major_id AND c.column_id = pe.minor_id \
             ORDER BY pr.name, securable"
        }
        ("mssql", "server_permissions") => {
            "SELECT pr.name AS principal, pe.state_desc, pe.permission_name, pe.class_desc \
             FROM sys.server_permissions pe \
             JOIN sys.server_principals pr ON pr.principal_id = pe.grantee_principal_id \
             ORDER BY pr.name"
        }

        // ---- Oracle (U6) — DBA_* catalog. Aliases quoted-lowercase so row keys
        //      match the frontend (Oracle folds bare aliases to UPPERCASE). Views
        //      that can be large are filtered by principal (arg) to dodge the
        //      driver's ~100-row fetch cap (§1.4c).
        ("oracle", "users") => {
            "SELECT username AS \"name\", account_status AS \"status\", default_tablespace AS \"tablespace\", \
                    temporary_tablespace AS \"temp_tablespace\", profile AS \"profile\", \
                    authentication_type AS \"auth_type\", TO_CHAR(created,'YYYY-MM-DD') AS \"created\", \
                    TO_CHAR(expiry_date,'YYYY-MM-DD') AS \"expires\" \
             FROM dba_users ORDER BY username"
        }
        ("oracle", "roles") => {
            "SELECT role AS \"name\", authentication_type AS \"auth_type\" FROM dba_roles ORDER BY role"
        }
        ("oracle", "role_privs") => {
            return Some(format!(
                "SELECT grantee AS \"grantee\", granted_role AS \"role\", admin_option AS \"admin_option\", \
                        default_role AS \"default_role\" FROM dba_role_privs{} ORDER BY grantee, granted_role",
                ora_grantee_filter(arg)
            ));
        }
        ("oracle", "sys_privs") => {
            return Some(format!(
                "SELECT grantee AS \"grantee\", privilege AS \"privilege\", admin_option AS \"admin_option\" \
                 FROM dba_sys_privs{} ORDER BY grantee, privilege",
                ora_grantee_filter(arg)
            ));
        }
        ("oracle", "tab_privs") => {
            return Some(format!(
                "SELECT grantee AS \"grantee\", owner AS \"owner\", table_name AS \"object\", \
                        privilege AS \"privilege\", grantable AS \"grantable\" \
                 FROM dba_tab_privs{} ORDER BY grantee, owner, table_name",
                ora_grantee_filter(arg)
            ));
        }
        ("oracle", "quotas") => {
            "SELECT username AS \"name\", tablespace_name AS \"tablespace\", \
                    CASE WHEN max_bytes = -1 THEN 'UNLIMITED' ELSE TO_CHAR(max_bytes) END AS \"quota\" \
             FROM dba_ts_quotas ORDER BY username"
        }
        ("oracle", "profiles") => {
            "SELECT DISTINCT profile AS \"name\" FROM dba_profiles ORDER BY profile"
        }
        ("oracle", "tablespaces") => {
            "SELECT tablespace_name AS \"name\" FROM dba_tablespaces ORDER BY tablespace_name"
        }

        _ => return None,
    };
    Some(sql.to_string())
}

/// Optional `WHERE grantee = '<ARG>'` clause for Oracle per-principal views.
/// The name is uppercased (Oracle stores grantees uppercase) and single-quotes
/// are doubled — arg is a principal name from our own escaper, never free SQL.
fn ora_grantee_filter(arg: Option<&str>) -> String {
    match arg {
        Some(g) if !g.is_empty() => format!(" WHERE grantee = '{}'", g.to_uppercase().replace('\'', "''")),
        _ => String::new(),
    }
}

#[tauri::command]
pub async fn users_view(
    state: State<'_, AppState>,
    conn_id: String,
    view: String,
    arg: Option<String>,
) -> Result<QueryResultSet, AppError> {
    let system = state
        .registry
        .system_of(&conn_id)
        .or_else(|| {
            state
                .storage
                .get_connection(&conn_id)
                .ok()
                .map(|p| p.system.as_str().to_string())
        })
        .unwrap_or_default();

    let sql = users_query(&system, &view, arg.as_deref()).ok_or_else(|| {
        AppError::Driver(format!("User view '{view}' is not supported for {system}"))
    })?;
    let outcome = state
        .registry
        .exec_statement(&conn_id, sql)
        .await?
        .map_err(|e| AppError::Driver(e.message))?;
    match outcome {
        StatementOutcome::Rows { result } => Ok(result),
        _ => Ok(QueryResultSet {
            cols: Vec::new(),
            rows: Vec::new(),
            total: 0,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_ident_per_dialect() {
        assert_eq!(quote_ident("postgres", "app_user"), "\"app_user\"");
        assert_eq!(quote_ident("postgres", "we\"ird"), "\"we\"\"ird\"");
        assert_eq!(quote_ident("mysql", "role"), "`role`");
        assert_eq!(quote_ident("mysql", "ba`ck"), "`ba``ck`");
        assert_eq!(quote_ident("mariadb", "read_only"), "`read_only`");
        assert_eq!(quote_ident("clickhouse", "ro`le"), "`ro\\`le`");
        assert_eq!(quote_ident("mssql", "db_role"), "[db_role]");
        assert_eq!(quote_ident("mssql", "we]rd"), "[we]]rd]");
        assert_eq!(quote_ident("cassandra", "app_role"), "\"app_role\"");
        assert_eq!(quote_ident("oracle", "APP"), "\"APP\"");
    }

    #[test]
    fn quote_str_per_dialect() {
        assert_eq!(quote_str("postgres", "p'wd"), "'p''wd'");
        assert_eq!(quote_str("mysql", "p'wd"), "'p''wd'");
        assert_eq!(quote_str("mysql", "a\\b"), "'a\\\\b'");
        assert_eq!(quote_str("clickhouse", "a'b"), "'a\\'b'");
        assert_eq!(quote_str("mssql", "p'wd"), "N'p''wd'");
        assert_eq!(quote_str("oracle", "p'wd"), "'p''wd'");
    }

    #[test]
    fn mysql_account_literal() {
        assert_eq!(mysql_account("mysql", "app", "%"), "'app'@'%'");
        assert_eq!(mysql_account("mysql", "u'x", "10.0.0.%"), "'u''x'@'10.0.0.%'");
    }

    #[test]
    fn users_query_postgres_roles() {
        let sql = users_query("postgres", "roles", None).unwrap();
        assert!(sql.contains("pg_roles"));
        assert!(sql.contains("rolcanlogin"));
        // "users" is an alias of "roles" for PG
        assert_eq!(users_query("postgres", "users", None), users_query("postgres", "roles", None));
        // unsupported (filled in later phases) → None
        assert!(users_query("cassandra", "users", None).is_none());
        assert!(users_query("postgres", "nope", None).is_none());
    }

    #[test]
    fn users_query_postgres_grant_views() {
        assert!(users_query("postgres", "members", None).unwrap().contains("pg_auth_members"));
        assert!(users_query("postgres", "db_grants", None).unwrap().contains("aclexplode(d.datacl)"));
        assert!(users_query("postgres", "schema_grants", None).unwrap().contains("aclexplode(n.nspacl)"));
        assert!(users_query("postgres", "table_grants", None).unwrap().contains("aclexplode(c.relacl)"));
        assert!(users_query("postgres", "default_acl", None).unwrap().contains("pg_default_acl"));
        assert!(users_query("postgres", "schema_owners", None).unwrap().contains("nspowner"));
        assert!(users_query("postgres", "can_manage", None).unwrap().contains("rolcreaterole"));
        assert!(users_query("mysql", "can_manage", None).is_none());
    }

    #[test]
    fn users_query_mysql_mariadb() {
        // MySQL users view (no is_role)
        let my = users_query("mysql", "users", None).unwrap();
        assert!(my.contains("mysql.user") && my.contains("account_locked") && !my.contains("is_role"));
        // MariaDB users view (has is_role)
        let ma = users_query("mariadb", "users", None).unwrap();
        assert!(ma.contains("mysql.user") && ma.contains("is_role"));
        // shared grant catalogs
        assert!(users_query("mysql", "schema_privs", None).unwrap().contains("SCHEMA_PRIVILEGES"));
        assert!(users_query("mariadb", "table_privs", None).unwrap().contains("TABLE_PRIVILEGES"));
        assert!(users_query("mysql", "global_privs", None).unwrap().contains("USER_PRIVILEGES"));
        // role catalogs differ
        assert!(users_query("mysql", "role_edges", None).unwrap().contains("mysql.role_edges"));
        assert!(users_query("mariadb", "roles_mapping", None).unwrap().contains("mysql.roles_mapping"));
        assert!(users_query("mysql", "roles_mapping", None).is_none());
        // SHOW GRANTS uses arg
        assert_eq!(
            users_query("mysql", "grants_for", Some("'app'@'%'")).unwrap(),
            "SHOW GRANTS FOR 'app'@'%'",
        );
        assert!(users_query("mysql", "grants_for", None).is_none());
    }

    #[test]
    fn users_query_mssql() {
        assert!(users_query("mssql", "logins", None).unwrap().contains("sys.server_principals"));
        assert!(users_query("mssql", "server_roles", None).unwrap().contains("type = 'R'"));
        assert!(users_query("mssql", "db_users", None).unwrap().contains("sys.database_principals") &&
                users_query("mssql", "db_users", None).unwrap().contains("orphaned"));
        assert!(users_query("mssql", "db_roles", None).unwrap().contains("is_fixed_role"));
        assert!(users_query("mssql", "db_role_members", None).unwrap().contains("sys.database_role_members"));
        let dbp = users_query("mssql", "db_permissions", None).unwrap();
        assert!(dbp.contains("sys.database_permissions") && dbp.contains("state_desc") && dbp.contains("SCHEMA::"));
        assert!(users_query("mssql", "server_permissions", None).unwrap().contains("sys.server_permissions"));
    }

    #[test]
    fn users_query_clickhouse() {
        assert!(users_query("clickhouse", "users", None).unwrap().contains("system.users"));
        assert!(users_query("clickhouse", "users", None).unwrap().contains("storage"));
        assert!(users_query("clickhouse", "roles", None).unwrap().contains("system.roles"));
        assert!(users_query("clickhouse", "grants", None).unwrap().contains("system.grants"));
        assert!(users_query("clickhouse", "role_grants", None).unwrap().contains("system.role_grants"));
        assert!(users_query("clickhouse", "can_manage", None).unwrap().contains("ACCESS MANAGEMENT"));
    }

    #[test]
    fn users_query_oracle() {
        assert!(users_query("oracle", "users", None).unwrap().contains("dba_users"));
        assert!(users_query("oracle", "roles", None).unwrap().contains("dba_roles"));
        // per-principal views filter by grantee (uppercased) to dodge the row cap
        let rp = users_query("oracle", "role_privs", Some("app")).unwrap();
        assert!(rp.contains("dba_role_privs") && rp.contains("WHERE grantee = 'APP'"));
        assert!(users_query("oracle", "sys_privs", None).unwrap().contains("dba_sys_privs"));
        assert!(!users_query("oracle", "sys_privs", None).unwrap().contains("WHERE"));
        assert!(users_query("oracle", "tab_privs", Some("app")).unwrap().contains("WHERE grantee = 'APP'"));
        assert!(users_query("oracle", "quotas", None).unwrap().contains("dba_ts_quotas"));
        assert!(users_query("oracle", "profiles", None).unwrap().contains("dba_profiles"));
        assert!(users_query("oracle", "tablespaces", None).unwrap().contains("dba_tablespaces"));
    }
}
