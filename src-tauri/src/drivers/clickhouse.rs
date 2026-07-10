//! ClickHouse driver — HTTP 8123 + `FORMAT JSON` (CLICKHOUSE_SPEC_ADDENDUM).
//! Không phải OLTP: không transaction, UPDATE/DELETE là mutation async (lint
//! tầng 1 cảnh báo); giữ nguyên shape `{ ok, result:{cols,rows,total}, error }`.
//! Tham số introspection truyền qua `param_*` của ClickHouse — KHÔNG nối chuỗi.

use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::io::Write;
use std::time::{Duration, Instant};

use crate::drivers::postgres::ExportFormat;

use crate::drivers::types::{
    ColumnInfo, PartitionInfo, QueryResultSet, SchemaInfo, StatementOutcome, TableInfo, TestResult,
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
        Some("60") => Some("Table does not exist. Check the current database or the table name.".into()),
        Some("81") => Some("Database does not exist.".into()),
        Some("62") => Some("ClickHouse syntax error. Note: no SQL-style OFFSET; UPDATE/DELETE must be ALTER TABLE.".into()),
        Some("516") => Some("Wrong user or password.".into()),
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
            .map_err(|e| QueryError::new(SYSTEM, format!("Failed to connect to ClickHouse: {e}"), e.to_string()))?;

        let status = res.status().as_u16();
        let summary = res
            .headers()
            .get("x-clickhouse-summary")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let body = res
            .text()
            .await
            .map_err(|e| QueryError::new(SYSTEM, format!("Failed to read response: {e}"), e.to_string()))?;
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
            .map_err(|e| QueryError::new(SYSTEM, format!("Failed to parse JSON from ClickHouse: {e}"), body.clone()))?;
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
                "SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = {db:String} ORDER BY name",
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
                    engine: Some(engine.to_string()),
                    data_length: r["total_bytes"]
                        .as_str()
                        .and_then(|s| s.parse::<i64>().ok())
                        .or_else(|| r["total_bytes"].as_i64()),
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
                    auto_increment: false, // ClickHouse has no identity/auto-increment
                }
            })
            .collect())
    }

    /// Active partitions of a MergeTree table (from `system.parts`). Returns empty
    /// when the table has no PARTITION BY key. Row counts are summed per partition.
    pub async fn partitions(
        &mut self,
        schema: &str,
        table: &str,
    ) -> Result<Vec<PartitionInfo>, QueryError> {
        let (meta_body, _) = self
            .raw_query(
                "SELECT partition_key FROM system.tables WHERE database = {db:String} AND name = {t:String}",
                &[("db", schema), ("t", table)],
            )
            .await?;
        let meta: ChJsonBody = serde_json::from_str(&meta_body)
            .map_err(|e| QueryError::new(SYSTEM, e.to_string(), meta_body.clone()))?;
        let pkey = meta
            .data
            .first()
            .and_then(|r| r["partition_key"].as_str())
            .unwrap_or("")
            .to_string();
        if pkey.is_empty() {
            return Ok(Vec::new());
        }
        let (body, _) = self
            .raw_query(
                "SELECT partition, sum(rows) AS rows FROM system.parts \
                 WHERE database = {db:String} AND table = {t:String} AND active \
                 GROUP BY partition ORDER BY partition",
                &[("db", schema), ("t", table)],
            )
            .await?;
        let parsed: ChJsonBody = serde_json::from_str(&body)
            .map_err(|e| QueryError::new(SYSTEM, e.to_string(), body.clone()))?;
        Ok(parsed
            .data
            .iter()
            .map(|r| {
                let part = r["partition"].as_str().unwrap_or("").to_string();
                // ClickHouse serializes UInt64 as a JSON string.
                let rows = r["rows"]
                    .as_str()
                    .and_then(|s| s.parse::<i64>().ok())
                    .or_else(|| r["rows"].as_i64());
                PartitionInfo {
                    name: part.clone(),
                    method: "EXPRESSION".to_string(),
                    key: Some(pkey.clone()),
                    expression: Some(part),
                    rows,
                    position: None,
                }
            })
            .collect())
    }

    /// Dictionaries trong 1 database (Explorer tree §3).
    pub async fn dictionaries(&self, schema: &str) -> Result<Vec<String>, QueryError> {
        let (body, _) = self
            .raw_query(
                "SELECT name FROM system.dictionaries WHERE database = {db:String} ORDER BY name",
                &[("db", schema)],
            )
            .await?;
        let parsed: ChJsonBody = serde_json::from_str(&body)
            .map_err(|e| QueryError::new(SYSTEM, e.to_string(), body.clone()))?;
        Ok(parsed
            .data
            .iter()
            .filter_map(|r| r["name"].as_str().map(String::from))
            .collect())
    }

    /// Index Scanner (T17): data-skipping indices trong 1 database.
    pub async fn scan_indexes(
        &self,
        schema: &str,
    ) -> Result<Vec<crate::drivers::index_scan::IndexScanRow>, QueryError> {
        let (body, _) = self
            .raw_query(
                "SELECT table, name, type_full, expr, data_compressed_bytes \
                 FROM system.data_skipping_indices WHERE database = {db:String} ORDER BY table, name",
                &[("db", schema)],
            )
            .await?;
        let parsed: ChJsonBody = serde_json::from_str(&body)
            .map_err(|e| QueryError::new(SYSTEM, e.to_string(), body.clone()))?;
        Ok(parsed
            .data
            .iter()
            .map(|r| crate::drivers::index_scan::IndexScanRow {
                name: r["name"].as_str().unwrap_or("").to_string(),
                table: r["table"].as_str().unwrap_or("").to_string(),
                columns: vec![r["expr"].as_str().unwrap_or("").to_string()],
                index_type: r["type_full"].as_str().unwrap_or("").to_string(),
                unique: false,
                primary: false,
                // UInt64 render dạng string trong FORMAT JSON.
                size_bytes: r["data_compressed_bytes"]
                    .as_i64()
                    .or_else(|| r["data_compressed_bytes"].as_str().and_then(|s| s.parse().ok())),
                usage: None,
                fragmentation_pct: None,
                valid: true,
                flags: Vec::new(),
            })
            .collect())
    }

    /// Metadata bảng ClickHouse cho engine badge + TTL viewer (Phase 5 · T7c):
    /// engine, engine_full, create_table_query, partition/sorting key, TTL rules.
    pub async fn table_meta(&self, schema: &str, table: &str) -> Result<ChTableMeta, QueryError> {
        let (body, _) = self
            .raw_query(
                "SELECT engine, engine_full, partition_key, sorting_key, create_table_query \
                 FROM system.tables WHERE database = {db:String} AND name = {t:String}",
                &[("db", schema), ("t", table)],
            )
            .await?;
        let parsed: ChJsonBody = serde_json::from_str(&body)
            .map_err(|e| QueryError::new(SYSTEM, e.to_string(), body.clone()))?;
        let r = parsed
            .data
            .first()
            .ok_or_else(|| QueryError::new(SYSTEM, format!("Table {schema}.{table} does not exist"), "not found"))?;
        let create_sql = r["create_table_query"].as_str().unwrap_or("").to_string();
        let engine_full = r["engine_full"].as_str().unwrap_or("").to_string();
        Ok(ChTableMeta {
            engine: r["engine"].as_str().unwrap_or("").to_string(),
            partition_key: r["partition_key"].as_str().unwrap_or("").to_string(),
            sorting_key: r["sorting_key"].as_str().unwrap_or("").to_string(),
            ttl_rules: parse_ttl(&create_sql),
            engine_full,
            create_sql,
        })
    }

    /// Stream a query's rows to `out` in `format`, one row at a time (bounded
    /// memory — T24 parity for ClickHouse). Uses HTTP `FORMAT JSONCompactEachRowWithNames`
    /// (first line = column names, then one compact array per row) and consumes the
    /// response as a byte stream. Calls `progress` every 10k rows and stops when
    /// `cancel` is set. Returns rows written. Mirrors PgDriver::stream_export shape.
    pub async fn stream_export<W: Write>(
        &self,
        sql: &str,
        format: ExportFormat,
        table: &str,
        out: &mut W,
        mut progress: impl FnMut(u64),
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<u64, QueryError> {
        use futures::StreamExt;
        use std::sync::atomic::Ordering;

        let base = sql.trim().trim_end_matches(';');
        let stream_sql = format!("{base}\nFORMAT JSONCompactEachRowWithNames");
        let query = vec![("database".to_string(), self.params.database.clone())];
        let res = self
            .client
            .post(Self::base_url(&self.params))
            .query(&query)
            .header("X-ClickHouse-User", &self.params.user)
            .header("X-ClickHouse-Key", &self.params.password)
            .body(stream_sql)
            .send()
            .await
            .map_err(|e| QueryError::new(SYSTEM, format!("Failed to connect to ClickHouse: {e}"), e.to_string()))?;
        let status = res.status().as_u16();
        if status != 200 {
            let body = res.text().await.unwrap_or_default();
            return Err(parse_ch_error(status, &body));
        }

        let mut stream = res.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut cols: Vec<String> = Vec::new();
        let mut n: u64 = 0;
        let mut started = false;
        let mut header_done = false;
        let mut stopped = false;

        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                stopped = true;
                break;
            }
            let chunk = chunk.map_err(|e| QueryError::new(SYSTEM, format!("stream error: {e}"), e.to_string()))?;
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                ch_emit_line(out, &line[..line.len() - 1], format, table, &mut cols, &mut n, &mut started, &mut header_done)?;
                if n % 10_000 == 0 && n > 0 {
                    progress(n);
                }
                if cancel.load(Ordering::Relaxed) {
                    stopped = true;
                    break;
                }
            }
            if stopped {
                break;
            }
        }
        // trailing line without a final newline (defensive — CH usually terminates rows)
        if !stopped && !buf.is_empty() {
            ch_emit_line(out, &buf, format, table, &mut cols, &mut n, &mut started, &mut header_done)?;
        }

        let werr = |e: std::io::Error| QueryError::new(SYSTEM, format!("write error: {e}"), e.to_string());
        if let ExportFormat::Json = format {
            if !started {
                write!(out, "[").map_err(werr)?;
            }
            write!(out, "\n]").map_err(werr)?;
        }
        progress(n);
        Ok(n)
    }
}

// ---- streaming-export helpers (ClickHouse-local, mirror the PG formatting) ----
fn ch_csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn ch_value_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn ch_sql_literal(v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Number(nu) => nu.to_string(),
        Value::Bool(b) => if *b { "1" } else { "0" }.into(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

/// Emit one decoded JSONCompactEachRowWithNames line to `out`. The first line is the
/// column-names header; every subsequent line is a compact value array.
#[allow(clippy::too_many_arguments)]
fn ch_emit_line<W: Write>(
    out: &mut W,
    line: &[u8],
    format: ExportFormat,
    table: &str,
    cols: &mut Vec<String>,
    n: &mut u64,
    started: &mut bool,
    header_done: &mut bool,
) -> Result<(), QueryError> {
    let werr = |e: std::io::Error| QueryError::new(SYSTEM, format!("write error: {e}"), e.to_string());
    if line.is_empty() {
        return Ok(());
    }
    let val: Value = serde_json::from_slice(line)
        .map_err(|e| QueryError::new(SYSTEM, format!("stream parse error: {e}"), String::from_utf8_lossy(line).to_string()))?;
    if !*header_done {
        *cols = val
            .as_array()
            .map(|a| a.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect())
            .unwrap_or_default();
        *header_done = true;
        *started = true;
        match format {
            ExportFormat::Csv => writeln!(out, "{}", cols.iter().map(|c| ch_csv_cell(c)).collect::<Vec<_>>().join(",")).map_err(werr)?,
            ExportFormat::Json => write!(out, "[").map_err(werr)?,
            ExportFormat::Sql => {}
        }
        return Ok(());
    }
    let vals: Vec<Value> = val.as_array().cloned().unwrap_or_default();
    match format {
        ExportFormat::Csv => {
            let l = vals.iter().map(|v| ch_csv_cell(&ch_value_text(v))).collect::<Vec<_>>().join(",");
            writeln!(out, "{l}").map_err(werr)?;
        }
        ExportFormat::Json => {
            if *n > 0 {
                write!(out, ",").map_err(werr)?;
            }
            let obj: Map<String, Value> = cols.iter().cloned().zip(vals.iter().cloned()).collect();
            write!(out, "\n{}", Value::Object(obj)).map_err(werr)?;
        }
        ExportFormat::Sql => {
            let colnames = cols.iter().map(|c| format!("`{c}`")).collect::<Vec<_>>().join(", ");
            let vlits = vals.iter().map(ch_sql_literal).collect::<Vec<_>>().join(", ");
            writeln!(out, "INSERT INTO `{table}` ({colnames}) VALUES ({vlits});").map_err(werr)?;
        }
    }
    *n += 1;
    Ok(())
}

/// Table metadata (ClickHouse-specific) cho explorer + TTL viewer.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChTableMeta {
    pub engine: String,
    pub engine_full: String,
    pub partition_key: String,
    pub sorting_key: String,
    pub create_sql: String,
    pub ttl_rules: Vec<TtlRule>,
}

/// Một quy tắc TTL đã parse: biểu thức + hành động + mô tả tự nhiên.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TtlRule {
    pub expr: String,
    /// DELETE | MOVE | GROUP BY | RECOMPRESS
    pub action: String,
    pub human: String,
}

/// Parse mệnh đề `TTL ...` từ `CREATE TABLE ... TTL <rules> [SETTINGS ...]`.
/// Thuần (không I/O) → unit-test được. Trả [] nếu bảng không có TTL.
pub fn parse_ttl(create_sql: &str) -> Vec<TtlRule> {
    // Tìm từ khoá TTL đứng riêng (không phải trong tên cột). Lấy đoạn sau ' TTL '
    // tới ' SETTINGS ' / ' AS ' / hết chuỗi.
    let upper = create_sql.to_uppercase();
    let Some(ttl_pos) = find_kw(&upper, " TTL ") else {
        return Vec::new();
    };
    let after = &create_sql[ttl_pos + 5..];
    let after_upper = &upper[ttl_pos + 5..];
    // cắt tại SETTINGS / COMMENT / cuối
    let end = [" SETTINGS ", " COMMENT "]
        .iter()
        .filter_map(|kw| find_kw(after_upper, kw))
        .min()
        .unwrap_or(after.len());
    let clause = after[..end].trim();

    // Tách các rule theo dấu phẩy ở cấp ngoặc 0.
    split_top_level(clause)
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .map(|seg| {
            let seg = seg.trim();
            let seg_up = seg.to_uppercase();
            let (action, expr) = if let Some(p) = seg_up.find(" TO DISK ") {
                ("MOVE".to_string(), seg[..p].trim().to_string())
            } else if let Some(p) = seg_up.find(" TO VOLUME ") {
                ("MOVE".to_string(), seg[..p].trim().to_string())
            } else if let Some(p) = seg_up.find(" GROUP BY ") {
                ("GROUP BY".to_string(), seg[..p].trim().to_string())
            } else if let Some(p) = seg_up.find(" RECOMPRESS ") {
                ("RECOMPRESS".to_string(), seg[..p].trim().to_string())
            } else if let Some(p) = seg_up.rfind(" DELETE") {
                ("DELETE".to_string(), seg[..p].trim().to_string())
            } else {
                // không có hành động → mặc định DELETE (ClickHouse default)
                ("DELETE".to_string(), seg.to_string())
            };
            let human = match action.as_str() {
                "DELETE" => format!("Delete data when: {expr}"),
                "MOVE" => format!("Move part to disk/volume when: {expr} ({})", extract_tail(seg)),
                "GROUP BY" => format!("Rollup (GROUP BY) when: {expr}"),
                "RECOMPRESS" => format!("Recompress when: {expr}"),
                _ => expr.clone(),
            };
            TtlRule { expr, action, human }
        })
        .collect()
}

/// Tìm keyword bao bởi khoảng trắng (đã uppercase input + kw).
fn find_kw(haystack_upper: &str, kw_upper: &str) -> Option<usize> {
    haystack_upper.find(kw_upper)
}

/// Phần đuôi sau TO DISK/VOLUME (để mô tả đích di chuyển).
fn extract_tail(seg: &str) -> String {
    let up = seg.to_uppercase();
    for kw in [" TO DISK ", " TO VOLUME "] {
        if let Some(p) = up.find(kw) {
            return format!("{}{}", kw.trim(), &seg[p + kw.len()..]).trim().to_string();
        }
    }
    String::new()
}

/// Tách chuỗi theo dấu phẩy ở cấp ngoặc ngoài cùng (bỏ qua phẩy trong `(...)`).
fn split_top_level(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for ch in s.chars() {
        match ch {
            '(' => {
                depth += 1;
                cur.push(ch);
            }
            ')' => {
                depth -= 1;
                cur.push(ch);
            }
            ',' if depth == 0 => {
                out.push(std::mem::take(&mut cur));
            }
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ttl_delete_and_move() {
        let sql = "CREATE TABLE db.events (ts DateTime, x Int32) ENGINE = MergeTree \
                   PARTITION BY toYYYYMM(ts) ORDER BY ts \
                   TTL ts + INTERVAL 30 DAY DELETE, ts + INTERVAL 7 DAY TO DISK 'cold' \
                   SETTINGS index_granularity = 8192";
        let rules = parse_ttl(sql);
        assert_eq!(rules.len(), 2, "{rules:?}");
        assert_eq!(rules[0].action, "DELETE");
        assert!(rules[0].expr.contains("INTERVAL 30 DAY"));
        assert_eq!(rules[1].action, "MOVE");
        assert!(rules[1].expr.contains("INTERVAL 7 DAY"));
    }

    #[test]
    fn parse_ttl_none() {
        let sql = "CREATE TABLE db.t (a Int32) ENGINE = MergeTree ORDER BY a SETTINGS x=1";
        assert!(parse_ttl(sql).is_empty());
    }

    #[test]
    fn parse_ttl_implicit_delete() {
        let sql = "CREATE TABLE db.t (ts DateTime) ENGINE = MergeTree ORDER BY ts TTL ts + INTERVAL 90 DAY";
        let rules = parse_ttl(sql);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].action, "DELETE");
    }

    #[test]
    fn split_top_level_ignores_nested_commas() {
        let v = split_top_level("a + INTERVAL 1 DAY, toDate(x, 'UTC') DELETE");
        assert_eq!(v.len(), 2);
    }
}
