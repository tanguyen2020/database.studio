//! Query Plan command (Phase 5 · T1). Chạy EXPLAIN native theo hệ rồi map về
//! `QueryPlan` chuẩn hóa (drivers/plan.rs). Redis/Kafka/NATS → not_applicable.

use tauri::State;

use crate::drivers::plan::{self, QueryPlan};
use crate::drivers::types::StatementOutcome;
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

/// EXPLAIN một câu lệnh → cây kế hoạch chuẩn hóa. `actual=true` sẽ THỰC SỰ chạy
/// query (ANALYZE) — chỉ khi người dùng chủ động bật.
#[tauri::command]
pub async fn explain_plan(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
    actual: bool,
) -> Result<QueryPlan, AppError> {
    let system = state
        .storage
        .get_connection(&conn_id)
        .map(|p| p.system.as_str().to_string())
        .unwrap_or_else(|_| "unknown".into());

    // Hệ không áp dụng: trả not_applicable (nút Explain disabled ở UI, không lỗi).
    if matches!(system.as_str(), "redis" | "kafka" | "nats") {
        return Ok(QueryPlan::not_applicable(&system));
    }

    // Cassandra: không có EXPLAIN → chạy TRACING, dựng timeline + cờ ALLOW FILTERING.
    if system == "cassandra" {
        return explain_cassandra(state.inner(), &conn_id, &sql).await;
    }

    // MSSQL: SHOWPLAN_XML phải là statement duy nhất của batch → bật, chạy query
    // (KHÔNG thực thi — chỉ sinh plan), rồi tắt (best-effort, luôn tắt).
    if system == "mssql" {
        return explain_mssql(state.inner(), &conn_id, &sql).await;
    }

    let explain_sql = build_explain(&system, &sql, actual);
    let outcome = state
        .registry
        .exec_statement(&conn_id, explain_sql)
        .await?
        .map_err(|e| AppError::Driver(e.message))?;

    let rows = match outcome {
        StatementOutcome::Rows { result } => result.rows,
        _ => return Err(AppError::Driver("EXPLAIN did not return a plan".into())),
    };

    parse_for_system(&system, actual, &rows).map_err(AppError::Driver)
}

/// MSSQL estimated plan qua `SET SHOWPLAN_XML ON`. Bật → chạy query (server trả
/// XML plan, không thực thi) → LUÔN tắt lại (kể cả khi query lỗi).
async fn explain_mssql(
    state: &AppState,
    conn_id: &str,
    sql: &str,
) -> Result<QueryPlan, AppError> {
    let sql = sql.trim().trim_end_matches(';').to_string();
    state
        .registry
        .exec_statement(conn_id, "SET SHOWPLAN_XML ON".into())
        .await?
        .map_err(|e| AppError::Driver(e.message))?;
    let res = state.registry.exec_statement(conn_id, sql).await;
    // best-effort tắt lại — không để connection kẹt ở chế độ SHOWPLAN.
    let _ = state.registry.exec_statement(conn_id, "SET SHOWPLAN_XML OFF".into()).await;

    let outcome = res?.map_err(|e| AppError::Driver(e.message))?;
    let rows = match outcome {
        StatementOutcome::Rows { result } => result.rows,
        _ => return Err(AppError::Driver("SHOWPLAN_XML did not return a plan".into())),
    };
    let xml = rows
        .first()
        .and_then(|r| r.as_object())
        .and_then(|o| o.values().next())
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Driver("SHOWPLAN_XML is empty".into()))?;
    plan::parse_mssql_xml(xml).map_err(AppError::Driver)
}

/// Cassandra query plan qua TRACING (không có EXPLAIN). Chạy CQL với tracing bật
/// → timeline events; cờ ALLOW FILTERING suy ra ở tầng normalize.
async fn explain_cassandra(
    state: &AppState,
    conn_id: &str,
    cql: &str,
) -> Result<QueryPlan, AppError> {
    let cql_owned = cql.trim().trim_end_matches(';').to_string();
    let traced = cql_owned.clone();
    let (warnings, events) = state
        .registry
        .with_driver(conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Cassandra(c) => c.trace_cql(&traced).await,
                _ => Err(QueryError::new("cassandra", "Connection is not Cassandra", "not cassandra")),
            }
        })
        .await?
        .map_err(|e| AppError::Driver(e.message))?;
    Ok(plan::parse_cassandra_trace(&cql_owned, &warnings, &events))
}

/// Câu EXPLAIN native theo hệ.
fn build_explain(system: &str, sql: &str, actual: bool) -> String {
    let sql = sql.trim().trim_end_matches(';');
    match system {
        "postgres" => {
            if actual {
                format!("EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) {sql}")
            } else {
                format!("EXPLAIN (FORMAT JSON) {sql}")
            }
        }
        // MariaDB hỗ trợ ANALYZE FORMAT=JSON (số liệu thực tế r_rows/r_total_time_ms).
        "mariadb" if actual => format!("ANALYZE FORMAT=JSON {sql}"),
        "mysql" | "mariadb" => format!("EXPLAIN FORMAT=JSON {sql}"),
        "sqlite" => format!("EXPLAIN QUERY PLAN {sql}"),
        "clickhouse" => format!("EXPLAIN indexes = 1 {sql}"),
        _ => format!("EXPLAIN {sql}"),
    }
}

fn parse_for_system(
    system: &str,
    actual: bool,
    rows: &[serde_json::Value],
) -> Result<QueryPlan, String> {
    match system {
        "postgres" => {
            let cell = first_cell(rows).ok_or("PG EXPLAIN returned no rows")?;
            let json = if cell.is_string() {
                cell.as_str().unwrap().to_string()
            } else {
                serde_json::to_string(cell).map_err(|e| e.to_string())?
            };
            plan::parse_pg(&json, actual)
        }
        "mysql" | "mariadb" => {
            let cell = first_cell(rows).ok_or("MySQL EXPLAIN returned no rows")?;
            let json = cell.as_str().map(String::from).unwrap_or_else(|| cell.to_string());
            plan::parse_mysql(&json, system, actual && system == "mariadb")
        }
        "sqlite" => {
            // mỗi row: { id, parent, notused, detail }
            let parsed: Vec<(i64, i64, String)> = rows
                .iter()
                .map(|r| {
                    let id = json_i64(r, "id");
                    let parent = json_i64(r, "parent");
                    let detail = r.get("detail").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    (id, parent, detail)
                })
                .collect();
            Ok(plan::parse_sqlite(&parsed))
        }
        "clickhouse" => {
            let text = rows
                .iter()
                .filter_map(|r| r.as_object().and_then(|o| o.values().next()))
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            Ok(plan::parse_clickhouse(&text))
        }
        _ => Ok(plan::from_raw_text(system, "")),
    }
}

/// Ô đầu tiên của row đầu tiên (EXPLAIN thường trả 1 cột).
fn first_cell(rows: &[serde_json::Value]) -> Option<&serde_json::Value> {
    rows.first().and_then(|r| r.as_object()).and_then(|o| o.values().next())
}

fn json_i64(row: &serde_json::Value, key: &str) -> i64 {
    row.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0)
}
