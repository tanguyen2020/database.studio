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
pub fn users_query(system: &str, view: &str, _arg: Option<&str>) -> Option<String> {
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
        _ => return None,
    };
    Some(sql.to_string())
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
        assert!(users_query("mysql", "users", None).is_none());
        assert!(users_query("postgres", "nope", None).is_none());
    }
}
