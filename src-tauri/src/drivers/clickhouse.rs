//! ClickHouse driver — HTTP 8123 + `FORMAT JSON` (CLICKHOUSE_SPEC_ADDENDUM).
//! Không phải OLTP: không transaction, UPDATE/DELETE là mutation async (lint
//! tầng 1 cảnh báo); giữ nguyên shape `{ ok, result:{cols,rows,total}, error }`.
//! Tham số introspection truyền qua `param_*` của ClickHouse — KHÔNG nối chuỗi.

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, Instant};

use crate::drivers::types::{
    ColumnInfo, QueryResultSet, SchemaInfo, StatementOutcome, TableInfo, TestResult,
};
use crate::drivers::util::{is_dml, returns_rows};
use crate::error::QueryError;

#[derive(Clone)]
pub struct ChConnParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub ssl: bool,
}

pub struct ChDriver {
    client: reqwest::Client,
    params: ChConnParams,
}

#[derive(Deserialize)]
struct ChMeta {
    name: String,
    #[serde(rename = "type")]
    ty: String,
}

#[derive(Deserialize)]
struct ChJsonBody {
    meta: Vec<ChMeta>,
    data: Vec<Value>,
    rows: u64,
    #[serde(default)]
    rows_before_limit_at_least: Option<u64>,
}

const SYSTEM: &str = "clickhouse";

fn hint_for(code: Option<&str>) -> Option<String> {
    match code {
        Some("60") => Some("Bảng không tồn tại. Kiểm tra database hiện tại hoặc tên bảng.".into()),
        Some("81") => Some("Database không tồn tại.".into()),
        Some("62") => Some("Lỗi cú pháp ClickHouse. Lưu ý: không có OFFSET kiểu SQL, UPDATE/DELETE phải là ALTER TABLE.".into()),
        Some("516") => Some("Sai user hoặc password.".into()),
        _ => None,
    }
}

fn parse_ch_error(status: u16, body: &str) -> QueryError {
    let code = Regex::new(r"Code:\s*(\d+)")
        .ok()
        .and_then(|re| re.captures(body))
        .map(|c| c[1].to_string());
    // message gọn: phần DB::Exception đầu tiên, bỏ stack
    let message = Regex::new(r"DB::Exception:\s*([^\n]+)")
        .ok()
        .and_then(|re| re.captures(body))
        .map(|c| c[1].trim().to_string())
        .unwrap_or_else(|| format!("HTTP {status}: {}", body.chars().take(200).collect::<String>()));
    let mut err = QueryError::new(SYSTEM, message, body.to_string());
    err.hint = hint_for(code.as_deref());
    err.code = code;
    err
}

impl ChDriver {
    fn base_url(p: &ChConnParams) -> String {
        let scheme = if p.ssl { "https" } else { "http" };
        format!("{scheme}://{}:{}/", p.host, p.port)
    }

    async fn raw_query(
        &self,
        sql: &str,
        params: &[(&str, &str)],
    ) -> Result<(String, Option<String>), QueryError> {
        let mut query: Vec<(String, String)> = vec![
            ("database".into(), self.params.database.clone()),
            ("default_format".into(), "JSON".into()),
        ];
        for (k, v) in params {
            query.push((format!("param_{k}"), (*v).to_string()));
        }
        let res = self
            .client
            .post(Self::base_url(&self.params))
            .query(&query)
            .header("X-ClickHouse-User", &self.params.user)
            .header("X-ClickHouse-Key", &self.params.password)
            .body(sql.to_string())
            .send()
            .await
            .map_err(|e| QueryError::new(SYSTEM, format!("Không kết nối được ClickHouse: {e}"), e.to_string()))?;

        let status = res.status().as_u16();
        let summary = res
            .headers()
            .get("x-clickhouse-summary")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let body = res
            .text()
            .await
            .map_err(|e| QueryError::new(SYSTEM, format!("Lỗi đọc response: {e}"), e.to_string()))?;
        if status != 200 {
            return Err(parse_ch_error(status, &body));
        }
        Ok((body, summary))
    }

    pub async fn connect(params: &ChConnParams) -> Result<Self, QueryError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| QueryError::new(SYSTEM, e.to_string(), e.to_string()))?;
        let drv = Self { client, params: params.clone() };
        // handshake thật
        drv.raw_query("SELECT 1", &[]).await?;
        Ok(drv)
    }

    pub async fn test(params: &ChConnParams) -> TestResult {
        let start = Instant::now();
        match Self::connect(params).await {
            Ok(drv) => {
                let version = drv
                    .raw_query("SELECT version() AS v", &[])
                    .await
                    .ok()
                    .and_then(|(body, _)| serde_json::from_str::<ChJsonBody>(&body).ok())
                    .and_then(|b| b.data.first().and_then(|r| r["v"].as_str().map(String::from)))
                    .map(|v| format!("ClickHouse {v}"));
                TestResult {
                    ok: true,
                    latency_ms: Some(start.elapsed().as_millis() as u64),
                    server_version: version,
                    error: None,
                }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    pub async fn ping(&mut self) -> bool {
        self.raw_query("SELECT 1", &[]).await.is_ok()
    }

    pub async fn exec(&mut self, sql: &str) -> Result<StatementOutcome, QueryError> {
        let (body, summary) = self.raw_query(sql, &[]).await?;
        if body.trim().is_empty() {
            // non-SELECT: INSERT/DDL — written_rows từ X-ClickHouse-Summary
            let written = summary
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .and_then(|v| v["written_rows"].as_str().and_then(|n| n.parse::<u64>().ok()))
                .unwrap_or(0);
            if is_dml(sql) || written > 0 {
                return Ok(StatementOutcome::Affected { affected: written });
            }
            return Ok(StatementOutcome::Ok);
        }
        if !returns_rows(sql) && !body.trim_start().starts_with('{') {
            return Ok(StatementOutcome::Ok);
        }
        let parsed: ChJsonBody = serde_json::from_str(&body)
            .map_err(|e| QueryError::new(SYSTEM, format!("Không parse được JSON từ ClickHouse: {e}"), body.clone()))?;
        Ok(StatementOutcome::Rows {
            result: QueryResultSet {
                cols: parsed.meta.into_iter().map(|m| (m.name, m.ty)).collect(),
                // total: ước lượng server (rows_before_limit) — KHÔNG đếm client-side
                total: parsed.rows_before_limit_at_least.unwrap_or(parsed.rows),
                rows: parsed.data,
            },
        })
    }

    // ---- introspection (system.* — addendum §9), tham số hóa param_* ---------

    pub async fn schemas(&mut self) -> Result<Vec<SchemaInfo>, QueryError> {
        let (body, _) = self.raw_query("SELECT name FROM system.databases ORDER BY name", &[]).await?;
        let parsed: ChJsonBody = serde_json::from_str(&body)
            .map_err(|e| QueryError::new(SYSTEM, e.to_string(), body.clone()))?;
        Ok(parsed
            .data
            .iter()
            .filter_map(|r| r["name"].as_str())
            .map(|name| SchemaInfo {
                name: name.to_string(),
                is_default: name == self.params.database,
            })
            .collect())
    }

    pub async fn tables(&mut self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        let (body, _) = self
            .raw_query(
                "SELECT name, engine, total_rows FROM system.tables WHERE database = {db:String} ORDER BY name",
                &[("db", schema)],
            )
            .await?;
        let parsed: ChJsonBody = serde_json::from_str(&body)
            .map_err(|e| QueryError::new(SYSTEM, e.to_string(), body.clone()))?;
        Ok(parsed
            .data
            .iter()
            .map(|r| {
                let engine = r["engine"].as_str().unwrap_or("");
                TableInfo {
                    schema: schema.to_string(),
                    name: r["name"].as_str().unwrap_or("").to_string(),
                    kind: if engine.contains("View") { "view".into() } else { "table".into() },
                    row_estimate: r["total_rows"]
                        .as_str()
                        .and_then(|s| s.parse::<i64>().ok())
                        .or_else(|| r["total_rows"].as_i64()),
                    locked: schema == "system", // database system là read-only
                }
            })
            .collect())
    }

    pub async fn columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        let (body, _) = self
            .raw_query(
                "SELECT name, type, is_in_primary_key, default_expression FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position",
                &[("db", schema), ("t", table)],
            )
            .await?;
        let parsed: ChJsonBody = serde_json::from_str(&body)
            .map_err(|e| QueryError::new(SYSTEM, e.to_string(), body.clone()))?;
        Ok(parsed
            .data
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let ty = r["type"].as_str().unwrap_or("").to_string();
                ColumnInfo {
                    name: r["name"].as_str().unwrap_or("").to_string(),
                    // Nullable(...) quyết định nullability trong CH
                    nullable: ty.starts_with("Nullable("),
                    default: r["default_expression"].as_str().filter(|s| !s.is_empty()).map(String::from),
                    is_pk: r["is_in_primary_key"].as_u64() == Some(1)
                        || r["is_in_primary_key"].as_str() == Some("1"),
                    is_fk: false, // ClickHouse không có FK
                    data_type: ty,
                    ordinal: i as i32,
                }
            })
            .collect())
    }
}
