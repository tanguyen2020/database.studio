//! Query Plan command (Phase 5 · T1). Chạy EXPLAIN native theo hệ rồi map về
//! `QueryPlan` chuẩn hóa (drivers/plan.rs). Redis/Kafka/NATS → not_applicable.

use tauri::State;

use crate::drivers::plan::{self, QueryPlan};
use crate::drivers::types::StatementOutcome;
use crate::error::AppError;
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
    if matches!(system.as_str(), "redis" | "kafka" | "nats" | "cassandra") {
        return Ok(QueryPlan::not_applicable(&system));
    }

    let explain_sql = build_explain(&system, &sql, actual);
    let outcome = state
        .registry
        .exec_statement(&conn_id, explain_sql)
        .await?
        .map_err(|e| AppError::Driver(e.message))?;

    let rows = match outcome {
        StatementOutcome::Rows { result } => result.rows,
        _ => return Err(AppError::Driver("EXPLAIN không trả về kế hoạch".into())),
    };

    parse_for_system(&system, actual, &rows).map_err(AppError::Driver)
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
            let cell = first_cell(rows).ok_or("PG EXPLAIN rỗng")?;
            let json = if cell.is_string() {
                cell.as_str().unwrap().to_string()
            } else {
                serde_json::to_string(cell).map_err(|e| e.to_string())?
            };
            plan::parse_pg(&json, actual)
        }
        "mysql" | "mariadb" => {
            let cell = first_cell(rows).ok_or("MySQL EXPLAIN rỗng")?;
            let json = cell.as_str().map(String::from).unwrap_or_else(|| cell.to_string());
            plan::parse_mysql(&json, system)
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
