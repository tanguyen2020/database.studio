//! Query Plan normalization (Phase 5 · T1). Mỗi hệ chạy EXPLAIN theo cơ chế
//! native rồi map về struct chuẩn `QueryPlan { system, mode, root, summary, raw }`
//! để 1 component visualizer duy nhất hiển thị mọi hệ. Parser thuần (không I/O)
//! → unit-test được; orchestration (chạy EXPLAIN) ở commands/plan.rs.

use serde::Serialize;
use serde_json::{Map, Value};

/// Một node trong cây kế hoạch, đã chuẩn hóa tên operation.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlanNode {
    /// Tên chuẩn hóa (SeqScan/IndexScan/HashJoin/Sort/Aggregate/…).
    pub operation: String,
    /// Tên gốc của hệ (giữ nguyên để tham chiếu).
    pub native_op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_rows: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_rows: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost: Option<f64>,
    /// Self-cost = cost node − Σ cost con (P3.1). Cho cumulative-cost engine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_self: Option<f64>,
    /// % self-cost trên tổng cây (kiểu "Cost: N%" của SSMS).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_time_ms: Option<f64>,
    /// Chi tiết thô (relation, filter, join cond, buffers, loops…).
    pub extra: Map<String, Value>,
    pub children: Vec<PlanNode>,
    pub is_hotspot: bool,
}

impl PlanNode {
    fn leaf(operation: &str, native: &str) -> Self {
        PlanNode {
            operation: operation.to_string(),
            native_op: native.to_string(),
            estimated_rows: None,
            actual_rows: None,
            estimated_cost: None,
            cost_self: None,
            cost_pct: None,
            actual_time_ms: None,
            extra: Map::new(),
            children: Vec::new(),
            is_hotspot: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlanSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_time_ms: Option<f64>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QueryPlan {
    pub system: String,
    /// "estimated" | "actual" | "not_applicable"
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<PlanNode>,
    pub summary: PlanSummary,
    /// Bản gốc (JSON/XML/text/trace) cho nút "View raw".
    pub raw: String,
}

impl QueryPlan {
    pub fn not_applicable(system: &str) -> Self {
        QueryPlan {
            system: system.to_string(),
            mode: "not_applicable".into(),
            root: None,
            summary: PlanSummary { total_cost: None, total_time_ms: None, warnings: Vec::new() },
            raw: String::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Engine capability descriptor (P1.1) — khai báo năng lực EXPLAIN mỗi hệ để UI
// biết có bật toggle Actual hay không, và mode "actual" mang nghĩa gì. Đây là
// NGUỒN DUY NHẤT cho orchestration + UI, thay cho việc suy diễn từ chuỗi rải rác.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ActualKind {
    /// Chỉ có estimated, không có chế độ actual.
    None,
    /// EXPLAIN ANALYZE thật — số liệu thực thi (PG/MariaDB).
    Analyze,
    /// Không có planner tĩnh; chạy tracing/diagnostics (Cassandra).
    Tracing,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CostBasis {
    /// Engine trả cost thật (PG/MySQL/MSSQL).
    Cost,
    /// Xếp hạng theo thời gian (tracing).
    Duration,
    /// Xấp xỉ theo số rows (SQLite/ClickHouse — không có per-node cost).
    RowsProxy,
    /// Không có cơ sở cost.
    None,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct EngineCapability {
    /// Có planner cost-based (EXPLAIN trả cây operator).
    pub has_planner: bool,
    /// Có thể lấy plan "actual" (chạy thật) — tiện cho UI bật/tắt toggle.
    pub supports_actual: bool,
    pub actual_kind: ActualKind,
    pub cost_basis: CostBasis,
}

/// Năng lực EXPLAIN theo hệ.
pub fn capability(system: &str) -> EngineCapability {
    let (has_planner, actual_kind, cost_basis) = match system {
        "postgres" => (true, ActualKind::Analyze, CostBasis::Cost),
        "mariadb" => (true, ActualKind::Analyze, CostBasis::Cost),
        // MySQL/MSSQL có planner nhưng app CHƯA lấy actual (P3.3) → toggle tắt.
        "mysql" => (true, ActualKind::None, CostBasis::Cost),
        "mssql" => (true, ActualKind::None, CostBasis::Cost),
        "sqlite" => (true, ActualKind::None, CostBasis::RowsProxy),
        "clickhouse" => (true, ActualKind::None, CostBasis::RowsProxy),
        // Cassandra: không planner tĩnh, chỉ tracing (chạy thật, không có toggle).
        "cassandra" => (false, ActualKind::Tracing, CostBasis::Duration),
        // redis/kafka/nats: không áp dụng.
        _ => (false, ActualKind::None, CostBasis::None),
    };
    EngineCapability {
        has_planner,
        supports_actual: !matches!(actual_kind, ActualKind::None),
        actual_kind,
        cost_basis,
    }
}

/// Ngưỡng coi là "bảng lớn" khi cảnh báo full/seq scan.
const LARGE_ROWS: f64 = 10_000.0;

/// Chuẩn hóa tên operation gốc về tập chung.
///
/// Thứ tự nhánh quan trọng (P1.2 — DEF-MSSQL-CLUSTERED-SCAN, DEF-SQLITE-LABEL):
/// - `seek` → IndexSeek TRƯỚC mọi nhánh scan (Clustered Index Seek ≠ scan).
/// - "Clustered Index Scan"/"Table Scan" là FULL SCAN dù có chữ "index" → SeqScan.
/// - Có dùng index (Index Scan, SQLite `SEARCH/SCAN … USING INDEX`) → IndexScan.
/// - `SCAN t` trần (SQLite, không index) → SeqScan.
pub fn normalize_op(native: &str) -> String {
    let n = native.to_lowercase();
    let canon = if n.contains("index only scan") {
        "IndexOnlyScan"
    } else if n.contains("seek") {
        // Index Seek / Clustered Index Seek (MSSQL) — key access, KHÔNG phải scan.
        "IndexSeek"
    } else if n.contains("bitmap") {
        "BitmapScan"
    } else if n.contains("clustered index scan") || n.contains("table scan") || n.contains("seq scan") {
        // Full read: Clustered Index Scan / Table Scan (MSSQL), Seq Scan (PG).
        "SeqScan"
    } else if n.contains("index scan")
        || n.contains("index range")
        || (n.contains("search") && n.contains("index"))
        || (n.starts_with("scan") && n.contains("index"))
    {
        // Có dùng index: Index Scan (PG/MSSQL), SQLite SEARCH/SCAN … USING INDEX.
        "IndexScan"
    } else if n.starts_with("scan") || n.contains("full") {
        // Full read trần: SQLite `SCAN t` (không index) / generic "full".
        "SeqScan"
    } else if n.contains("nested loop") {
        "NestedLoop"
    } else if n.contains("hash join") || n.contains("hash") && n.contains("join") {
        "HashJoin"
    } else if n.contains("merge join") {
        "MergeJoin"
    } else if n.contains("sort") {
        "Sort"
    } else if n.contains("aggregate") || n.contains("group") {
        "Aggregate"
    } else if n.contains("limit") {
        "Limit"
    } else if n.contains("materialize") {
        "Materialize"
    } else if n.contains("gather") {
        "Gather"
    } else if n.contains("hash") {
        "Hash"
    } else if n.contains("search") {
        "IndexScan"
    } else {
        return native.to_string();
    };
    canon.to_string()
}

// ---------------------------------------------------------------------------
// PostgreSQL — EXPLAIN (FORMAT JSON) / (ANALYZE, FORMAT JSON)
// ---------------------------------------------------------------------------

/// Parse output PG `EXPLAIN (FORMAT JSON)`: `[{"Plan": {...}, "Execution Time":..}]`.
pub fn parse_pg(json_text: &str, actual: bool) -> Result<QueryPlan, String> {
    let v: Value = serde_json::from_str(json_text).map_err(|e| format!("PG plan JSON error: {e}"))?;
    let obj = v.as_array().and_then(|a| a.first()).ok_or("PG plan is empty")?;
    let plan = obj.get("Plan").ok_or("missing Plan")?;
    let mut warnings = Vec::new();
    let mut root = parse_pg_node(plan, &mut warnings);
    assign_cost_pct(&mut root, true); // PG Total Cost là cumulative
    let total_time = obj.get("Execution Time").and_then(Value::as_f64);
    QueryPlan_ok("postgres", actual, root, total_time, warnings, json_text)
}

fn parse_pg_node(plan: &Value, warnings: &mut Vec<String>) -> PlanNode {
    let native = plan.get("Node Type").and_then(Value::as_str).unwrap_or("Unknown").to_string();
    let mut node = PlanNode::leaf(&normalize_op(&native), &native);
    // rows/time trong EXPLAIN là số MỖI LOOP → nhân "Actual Loops" để ra tổng thực
    // tế (nhánh trong Nested Loop chạy nhiều lần). P2.1 — DEF-PG-LOOPS.
    let loops = plan.get("Actual Loops").and_then(Value::as_f64).unwrap_or(1.0);
    node.estimated_rows = plan.get("Plan Rows").and_then(Value::as_f64).map(|r| r * loops);
    node.actual_rows = plan.get("Actual Rows").and_then(Value::as_f64).map(|r| r * loops);
    node.estimated_cost = plan.get("Total Cost").and_then(Value::as_f64);
    node.actual_time_ms = plan.get("Actual Total Time").and_then(Value::as_f64).map(|t| t * loops);
    for key in [
        "Relation Name", "Index Name", "Filter", "Join Type", "Hash Cond", "Index Cond",
        "Sort Key", "Rows Removed by Filter", "Actual Loops",
    ] {
        if let Some(val) = plan.get(key) {
            node.extra.insert(key.to_string(), val.clone());
        }
    }
    mark_hotspot(&mut node, warnings);
    // P2.1 — DEF-PG-HOTSPOT: full scan quét NHIỀU nhưng trả ÍT là dấu hiệu thiếu
    // index. Đánh giá theo rows QUÉT (output + "Rows Removed by Filter"), không
    // phải rows đầu ra. Chỉ khả dụng ở actual mode (EXPLAIN ANALYZE mới có số này).
    if node.operation == "SeqScan" && !node.is_hotspot {
        let removed = plan.get("Rows Removed by Filter").and_then(Value::as_f64).unwrap_or(0.0) * loops;
        let scanned = node.actual_rows.unwrap_or(0.0) + removed;
        if scanned > LARGE_ROWS {
            node.is_hotspot = true;
            let rel = node.extra.get("Relation Name").and_then(Value::as_str).unwrap_or("table");
            let out = node.actual_rows.unwrap_or(0.0) as i64;
            warnings.push(format!(
                "Seq Scan on {rel} scans ~{} rows to return {} (missing index?)",
                scanned as i64, out
            ));
        }
    }
    if let Some(children) = plan.get("Plans").and_then(Value::as_array) {
        node.children = children.iter().map(|c| parse_pg_node(c, warnings)).collect();
    }
    node
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB — EXPLAIN FORMAT=JSON (query_block → nested table nodes)
// ---------------------------------------------------------------------------

/// Parse `EXPLAIN FORMAT=JSON` (estimated) hoặc `ANALYZE FORMAT=JSON` (actual —
/// MariaDB, có `r_rows`/`r_total_time_ms`). Đơn giản hóa: 1 nhánh chính theo
/// query_block/nested_loop/table.
pub fn parse_mysql(json_text: &str, system: &str, actual: bool) -> Result<QueryPlan, String> {
    let v: Value = serde_json::from_str(json_text).map_err(|e| format!("MySQL plan JSON error: {e}"))?;
    let qb = v.get("query_block").ok_or("missing query_block")?;
    let mut warnings = Vec::new();
    let mut root = parse_mysql_block(qb, actual, &mut warnings);
    assign_cost_pct(&mut root, false); // MySQL read_cost đã là self-cost
    let total_time = qb.get("r_total_time_ms").and_then(Value::as_f64);
    QueryPlan_ok(system, actual, root, total_time, warnings, json_text)
}

/// Rows lớn nhất trong subtree (để cảnh báo filesort/temp trên tập lớn).
fn mysql_subtree_rows(node: &PlanNode) -> f64 {
    let self_rows = node.actual_rows.or(node.estimated_rows).unwrap_or(0.0);
    node.children.iter().fold(self_rows, |m, c| m.max(mysql_subtree_rows(c)))
}

/// Parse một khối MySQL/MariaDB. Ngoài nested_loop/table, xử lý các wrapper
/// thường gặp (P2.3 — DEF-MYSQL-TREE-PARTIAL): ordering_operation (filesort),
/// grouping_operation (temp table), union_result, và subquery lồng.
fn parse_mysql_block(block: &Value, actual: bool, warnings: &mut Vec<String>) -> PlanNode {
    // UNION
    if let Some(u) = block.get("union_result") {
        let mut node = PlanNode::leaf("Union", "union_result");
        if let Some(specs) = u.get("query_specifications").and_then(Value::as_array) {
            node.children = specs
                .iter()
                .filter_map(|s| s.get("query_block"))
                .map(|qb| parse_mysql_block(qb, actual, warnings))
                .collect();
        }
        return node;
    }
    // ORDER BY → Sort (filesort)
    if let Some(ord) = block.get("ordering_operation") {
        let mut node = PlanNode::leaf("Sort", "ordering_operation");
        let filesort = ord.get("using_filesort").and_then(Value::as_bool).unwrap_or(false);
        let child = parse_mysql_block(ord, actual, warnings);
        if filesort {
            node.extra.insert("using_filesort".into(), Value::Bool(true));
            let rows = mysql_subtree_rows(&child);
            if rows > LARGE_ROWS {
                node.is_hotspot = true;
                warnings.push(format!("Using filesort over ~{} rows", rows as i64));
            }
        }
        node.children.push(child);
        return node;
    }
    // GROUP BY → Aggregate (temp table)
    if let Some(grp) = block.get("grouping_operation") {
        let mut node = PlanNode::leaf("Aggregate", "grouping_operation");
        let temp = grp.get("using_temporary_table").and_then(Value::as_bool).unwrap_or(false);
        let child = parse_mysql_block(grp, actual, warnings);
        if temp {
            node.extra.insert("using_temporary_table".into(), Value::Bool(true));
            let rows = mysql_subtree_rows(&child);
            if rows > LARGE_ROWS {
                node.is_hotspot = true;
                warnings.push(format!("Using temporary table over ~{} rows", rows as i64));
            }
        }
        node.children.push(child);
        return node;
    }
    // JOIN
    if let Some(nested) = block.get("nested_loop").and_then(Value::as_array) {
        let mut node = PlanNode::leaf("NestedLoop", "nested_loop");
        node.children = nested.iter().map(|t| parse_mysql_block(t, actual, warnings)).collect();
        return node;
    }
    // TABLE
    if let Some(table) = block.get("table") {
        return parse_mysql_table(table, actual, warnings);
    }
    // query_block lồng (subquery)
    if let Some(qb) = block.get("query_block") {
        return parse_mysql_block(qb, actual, warnings);
    }
    // fallback
    let mut n = PlanNode::leaf("QueryBlock", "query_block");
    if let Some(cost) = block.get("cost_info").and_then(|c| c.get("query_cost")).and_then(Value::as_str) {
        n.estimated_cost = cost.parse().ok();
    }
    n
}

fn parse_mysql_table(table: &Value, actual: bool, warnings: &mut Vec<String>) -> PlanNode {
    let access = table.get("access_type").and_then(Value::as_str).unwrap_or("ALL");
    let native = format!("{access} access");
    let op = match access {
        "ALL" => "SeqScan",
        "index" => "IndexOnlyScan",
        "ref" | "eq_ref" | "range" | "const" => "IndexScan",
        _ => "SeqScan",
    };
    let mut node = PlanNode::leaf(op, &native);
    node.estimated_rows = table.get("rows_examined_per_scan").and_then(Value::as_f64);
    if actual {
        // ANALYZE FORMAT=JSON: r_rows (thực tế / loop), r_total_time_ms
        node.actual_rows = table.get("r_rows").and_then(Value::as_f64);
        node.actual_time_ms = table.get("r_total_time_ms").and_then(Value::as_f64);
    }
    if let Some(name) = table.get("table_name").and_then(Value::as_str) {
        node.extra.insert("Relation Name".into(), Value::String(name.into()));
    }
    if let Some(cost) = table.get("cost_info").and_then(|c| c.get("read_cost")).and_then(Value::as_str) {
        node.estimated_cost = cost.parse().ok();
    }
    if let Some(cond) = table.get("attached_condition").and_then(Value::as_str) {
        node.extra.insert("Filter".into(), Value::String(cond.into()));
    }
    mark_hotspot(&mut node, warnings);
    // Subquery lồng dưới table (P2.3): materialized_from_subquery + attached_subqueries.
    if let Some(mat) = table.get("materialized_from_subquery").and_then(|m| m.get("query_block")) {
        let mut m = PlanNode::leaf("Materialize", "materialized_from_subquery");
        m.children.push(parse_mysql_block(mat, actual, warnings));
        node.children.push(m);
    }
    if let Some(subs) = table.get("attached_subqueries").and_then(Value::as_array) {
        for s in subs {
            if let Some(qb) = s.get("query_block") {
                node.children.push(parse_mysql_block(qb, actual, warnings));
            }
        }
    }
    node
}

// ---------------------------------------------------------------------------
// SQLite — EXPLAIN QUERY PLAN (id, parent, notused, detail)
// ---------------------------------------------------------------------------

/// Parse các dòng `EXPLAIN QUERY PLAN`: mỗi dòng (id, parent, detail) → cây theo parent.
pub fn parse_sqlite(rows: &[(i64, i64, String)]) -> QueryPlan {
    // Node giả gốc = QUERY PLAN; con theo parent id (0 = gốc).
    fn build(id: i64, rows: &[(i64, i64, String)], warnings: &mut Vec<String>) -> Vec<PlanNode> {
        rows.iter()
            .filter(|(_, parent, _)| *parent == id)
            .map(|(nid, _, detail)| {
                let op = normalize_op(detail);
                let mut node = PlanNode::leaf(&op, detail);
                node.extra.insert("detail".into(), Value::String(detail.clone()));
                if detail.to_uppercase().contains("SCAN") && !detail.to_uppercase().contains("USING INDEX") {
                    node.is_hotspot = true;
                    warnings.push(format!("Full scan: {detail}"));
                }
                node.children = build(*nid, rows, warnings);
                node
            })
            .collect()
    }
    let mut warnings = Vec::new();
    let children = build(0, rows, &mut warnings);
    let mut root = PlanNode::leaf("QueryPlan", "QUERY PLAN");
    root.children = children;
    QueryPlan {
        system: "sqlite".into(),
        mode: "estimated".into(),
        root: Some(root),
        summary: PlanSummary { total_cost: None, total_time_ms: None, warnings },
        raw: rows.iter().map(|(i, p, d)| format!("{i}|{p}|{d}")).collect::<Vec<_>>().join("\n"),
    }
}

// ---------------------------------------------------------------------------
// ClickHouse — EXPLAIN (indexes = 1): cây theo thụt đầu dòng (2 space / cấp).
// ---------------------------------------------------------------------------

/// Map tên bước ClickHouse → operation chuẩn hóa.
fn ch_op(op: &str) -> String {
    let low = op.to_lowercase();
    if low.starts_with("readfrom") {
        "SeqScan".into()
    } else if low.contains("aggregat") {
        "Aggregate".into()
    } else if low.contains("sorting") {
        "Sort".into()
    } else if low.starts_with("limit") {
        "Limit".into()
    } else if low.contains("join") {
        normalize_op(op)
    } else {
        // Expression/Filter/Distinct/Union… giữ nguyên native (normalize fallback).
        normalize_op(op)
    }
}

/// Một dòng metadata phân tích index (thuộc tính của ReadFromMergeTree, KHÔNG
/// phải một bước plan) → gộp vào node đọc thay vì tạo node riêng
/// (P2.2 — DEF-CH-METADATA-NODES).
fn ch_is_index_meta(content: &str) -> bool {
    let c = content.trim();
    [
        "Indexes", "PrimaryKey", "MinMax", "Partition", "Skip", "Keys:", "Key:",
        "Condition:", "Parts:", "Granules:", "Ranges:", "Search algorithm", "Name:",
        "Type:", "Description:",
    ]
    .iter()
    .any(|p| c.starts_with(p))
}

/// Parse "x/y" trong dòng "Granules: x/y" / "Parts: x/y" → (x, y).
fn ch_ratio(content: &str) -> Option<(f64, f64)> {
    let after = content.split(':').nth(1)?.trim();
    let frac = after.split_whitespace().next()?;
    let (a, b) = frac.split_once('/')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

/// Parse output `EXPLAIN indexes = 1` của ClickHouse. Mỗi dòng plan là 1 node
/// (indent/2 = độ sâu). Các dòng metadata index-analysis (Indexes/PrimaryKey/
/// Granules/Parts/Condition…) được GỘP vào ReadFromMergeTree gần nhất, không tạo
/// node. Hotspot theo tỉ lệ granule đọc (P2.2 — DEF-CH-GRANULE-BLIND).
pub fn parse_clickhouse(text: &str) -> QueryPlan {
    let mut warnings = Vec::new();
    let mut nodes: Vec<PlanNode> = Vec::new();
    let mut parent_of: Vec<Option<usize>> = Vec::new();
    let mut stack: Vec<(usize, usize)> = Vec::new(); // (depth, node index)
    let mut last_read: Option<usize> = None;

    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.chars().take_while(|c| *c == ' ').count();
        let depth = indent / 2;
        let content = line.trim().to_string();

        // Metadata index-analysis → gộp vào ReadFromMergeTree gần nhất.
        if ch_is_index_meta(&content) {
            if let Some(ri) = last_read {
                let node = &mut nodes[ri];
                let prev = node.extra.get("index_analysis").and_then(Value::as_str).unwrap_or("").to_string();
                let combined = if prev.is_empty() { content.clone() } else { format!("{prev}\n{content}") };
                node.extra.insert("index_analysis".into(), Value::String(combined));
                if content.starts_with("Granules:") {
                    if let Some((r, t)) = ch_ratio(&content) {
                        node.extra.insert("granules_read".into(), Value::from(r));
                        node.extra.insert("granules_total".into(), Value::from(t));
                    }
                }
                if content.starts_with("Parts:") {
                    if let Some((r, t)) = ch_ratio(&content) {
                        node.extra.insert("parts_read".into(), Value::from(r));
                        node.extra.insert("parts_total".into(), Value::from(t));
                    }
                }
                if ["PrimaryKey", "MinMax", "Skip", "Partition"].iter().any(|p| content.starts_with(p)) {
                    node.extra.insert("has_index".into(), Value::Bool(true));
                }
            }
            continue; // KHÔNG tạo node cho dòng metadata
        }

        let op_name = content.split('(').next().unwrap_or(&content).trim().trim_end_matches(':').to_string();
        while stack.last().map(|(d, _)| *d >= depth).unwrap_or(false) {
            stack.pop();
        }
        let parent = stack.last().map(|(_, i)| *i);
        let mut node = PlanNode::leaf(&ch_op(&op_name), &op_name);
        node.extra.insert("detail".into(), Value::String(content.clone()));
        let is_read = op_name.to_lowercase().starts_with("readfrom");
        if is_read {
            if let (Some(a), Some(b)) = (content.find('('), content.rfind(')')) {
                if b > a + 1 {
                    node.extra.insert("relation".into(), Value::String(content[a + 1..b].to_string()));
                }
            }
        }
        let idx = nodes.len();
        nodes.push(node);
        parent_of.push(parent);
        stack.push((depth, idx));
        if is_read {
            last_read = Some(idx);
        }
    }

    // Hotspot mỗi ReadFromMergeTree theo tỉ lệ granule đọc: ≥50% granule (hoặc
    // không có index để prune) = full read → hotspot; prune tốt → không.
    const FULL_GRANULE_RATIO: f64 = 0.5;
    for n in nodes.iter_mut() {
        if n.operation != "SeqScan" {
            continue;
        }
        let rel = n.extra.get("relation").and_then(Value::as_str).unwrap_or("table").to_string();
        let ratio = match (
            n.extra.get("granules_read").and_then(Value::as_f64),
            n.extra.get("granules_total").and_then(Value::as_f64),
        ) {
            (Some(r), Some(t)) if t > 0.0 => Some(r / t),
            _ => None,
        };
        match ratio {
            Some(r) if r >= FULL_GRANULE_RATIO => {
                n.is_hotspot = true;
                let gr = n.extra.get("granules_read").and_then(Value::as_f64).unwrap_or(0.0) as i64;
                let gt = n.extra.get("granules_total").and_then(Value::as_f64).unwrap_or(0.0) as i64;
                warnings.push(format!("ClickHouse reads {gr}/{gt} granules of {rel} (no effective pruning)"));
            }
            Some(_) => {} // prune tốt → không hotspot
            None => {
                // Không có số granule: fallback theo có index metadata hay không.
                if !n.extra.get("has_index").and_then(Value::as_bool).unwrap_or(false) {
                    n.is_hotspot = true;
                    warnings.push(format!("ClickHouse reads all of {rel} (no index used)"));
                }
            }
        }
    }

    // Ghép cây từ dưới lên (con vào cha) — duyệt ngược để giữ thứ tự.
    let mut built: Vec<Option<PlanNode>> = nodes.into_iter().map(Some).collect();
    for i in (0..built.len()).rev() {
        if let Some(p) = parent_of[i] {
            let child = built[i].take().unwrap();
            if let Some(parent) = built[p].as_mut() {
                parent.children.insert(0, child);
            }
        }
    }
    let root = built.into_iter().find_map(|n| n);

    QueryPlan {
        system: "clickhouse".into(),
        mode: "estimated".into(),
        root,
        summary: PlanSummary { total_cost: None, total_time_ms: None, warnings },
        raw: text.to_string(),
    }
}

// ---------------------------------------------------------------------------
// MSSQL — SET SHOWPLAN_XML ON → <ShowPlanXML> … nested <RelOp PhysicalOp=…>.
// ---------------------------------------------------------------------------

/// RelOp cha gần nhất của `n` (bỏ chính nó) — để xác định cây RelOp lồng nhau.
fn mssql_parent_relop(n: roxmltree::Node) -> Option<roxmltree::NodeId> {
    n.ancestors().skip(1).find(|a| a.tag_name().name() == "RelOp").map(|a| a.id())
}

/// Parse SHOWPLAN_XML: mỗi `<RelOp>` là 1 node; con là các `<RelOp>` lồng bên
/// trong (không có RelOp trung gian). PhysicalOp → operation chuẩn hóa.
pub fn parse_mssql_xml(xml: &str) -> Result<QueryPlan, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("SHOWPLAN_XML error: {e}"))?;
    let root_relop = doc
        .descendants()
        .find(|n| n.tag_name().name() == "RelOp")
        .ok_or("no RelOp found in SHOWPLAN_XML")?;
    let mut warnings = Vec::new();
    let mut root = build_mssql_node(root_relop, &mut warnings);
    assign_cost_pct(&mut root, true); // EstimatedTotalSubtreeCost là cumulative
    let total_cost = root.estimated_cost;
    Ok(QueryPlan {
        system: "mssql".into(),
        mode: "estimated".into(),
        summary: PlanSummary { total_cost, total_time_ms: None, warnings },
        root: Some(root),
        raw: xml.to_string(),
    })
}

fn build_mssql_node(relop: roxmltree::Node, warnings: &mut Vec<String>) -> PlanNode {
    let phys = relop.attribute("PhysicalOp").unwrap_or("Unknown");
    let logical = relop.attribute("LogicalOp").unwrap_or("");
    let mut node = PlanNode::leaf(&normalize_op(phys), phys);
    node.estimated_rows = relop.attribute("EstimateRows").and_then(|s| s.parse().ok());
    node.estimated_cost = relop.attribute("EstimatedTotalSubtreeCost").and_then(|s| s.parse().ok());
    if !logical.is_empty() {
        node.extra.insert("LogicalOp".into(), Value::String(logical.into()));
    }
    // Tên bảng: <Object Table="[db].[schema].[t]"> thuộc chính RelOp này.
    if let Some(obj) = relop
        .descendants()
        .find(|n| n.tag_name().name() == "Object" && mssql_parent_relop(*n) == Some(relop.id()))
    {
        if let Some(t) = obj.attribute("Table") {
            node.extra.insert("Relation Name".into(), Value::String(t.replace(['[', ']'], "")));
        }
    }
    // Con = RelOp lồng trực tiếp (RelOp cha gần nhất là relop này).
    for child in relop
        .descendants()
        .filter(|n| n.tag_name().name() == "RelOp" && mssql_parent_relop(*n) == Some(relop.id()))
    {
        node.children.push(build_mssql_node(child, warnings));
    }
    // Full scan MSSQL: EstimateRows có thể NHỎ (đã trừ predicate) nhưng thực tế đọc
    // cả bảng → cờ hotspot theo rows ĐỌC (EstimatedRowsRead / TableCardinality),
    // không dựa vào rows đầu ra như mark_hotspot (P1.2 — DEF-MSSQL-CLUSTERED-SCAN).
    let rows_read = relop
        .attribute("EstimatedRowsRead")
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| {
            relop
                .descendants()
                .find(|n| n.attribute("TableCardinality").is_some() && mssql_parent_relop(*n) == Some(relop.id()))
                .and_then(|n| n.attribute("TableCardinality"))
                .and_then(|s| s.parse::<f64>().ok())
        });
    if let Some(rr) = rows_read {
        node.extra.insert("EstimatedRowsRead".into(), Value::from(rr));
        if node.operation == "SeqScan" && rr > LARGE_ROWS && !node.is_hotspot {
            node.is_hotspot = true;
            let rel = node.extra.get("Relation Name").and_then(Value::as_str).unwrap_or("table");
            warnings.push(format!("Full scan on {rel} (reads ~{} rows)", rr as i64));
        }
    }
    mark_hotspot(&mut node, warnings);
    node
}

// ---------------------------------------------------------------------------
// Cassandra — không có EXPLAIN; dùng TRACING timeline + cờ ALLOW FILTERING.
// ---------------------------------------------------------------------------

/// Dựng QueryPlan cho Cassandra từ: câu CQL, cảnh báo server, và các event trace
/// `(activity, source, source_elapsed_us)`. Cờ ALLOW FILTERING (quét toàn cluster)
/// → hotspot + warning. Root = node đọc CQL; con = timeline các event trace.
pub fn parse_cassandra_trace(
    cql: &str,
    server_warnings: &[String],
    events: &[(String, String, i64)],
) -> QueryPlan {
    let filtering = cql.to_uppercase().contains("ALLOW FILTERING")
        || server_warnings.iter().any(|w| w.to_uppercase().contains("FILTER"))
        || events.iter().any(|(a, _, _)| {
            let up = a.to_uppercase();
            up.contains("ALLOW FILTERING") || up.contains("FILTERING")
        });

    let mut warnings: Vec<String> = server_warnings.to_vec();
    let mut root = PlanNode::leaf(if filtering { "SeqScan" } else { "CqlRead" }, "CQL Read");
    if filtering {
        root.is_hotspot = true;
        warnings.push("ALLOW FILTERING: scans all partitions (no partition key) — expensive".into());
    }

    for (activity, source, elapsed) in events {
        let mut n = PlanNode::leaf("TraceEvent", activity);
        n.actual_time_ms = Some(*elapsed as f64 / 1000.0);
        n.extra.insert("activity".into(), Value::String(activity.clone()));
        if !source.is_empty() {
            n.extra.insert("source".into(), Value::String(source.clone()));
        }
        root.children.push(n);
    }

    let total = events.iter().map(|(_, _, e)| *e).max().unwrap_or(0) as f64 / 1000.0;
    QueryPlan {
        system: "cassandra".into(),
        // Tracing/diagnostics, KHÔNG phải EXPLAIN ANALYZE thật (P1.3 —
        // DEF-CASS-ACTUAL-BADGE). UI hiển thị badge "TRACING", không phải "ACTUAL".
        mode: "tracing".into(),
        summary: PlanSummary {
            total_cost: None,
            total_time_ms: if total > 0.0 { Some(total) } else { None },
            warnings,
        },
        root: Some(root),
        raw: events
            .iter()
            .map(|(a, s, e)| format!("{e}us {s} {a}"))
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

// ---------------------------------------------------------------------------
// Fallback text (ClickHouse/khác trước khi có parser chuyên biệt): 1 node raw.
// ---------------------------------------------------------------------------

pub fn from_raw_text(system: &str, raw: &str) -> QueryPlan {
    let mut root = PlanNode::leaf("Plan", "Plan");
    root.extra.insert("text".into(), Value::String(raw.to_string()));
    QueryPlan {
        system: system.to_string(),
        mode: "estimated".into(),
        root: Some(root),
        summary: PlanSummary { total_cost: None, total_time_ms: None, warnings: Vec::new() },
        raw: raw.to_string(),
    }
}

// ---------------------------------------------------------------------------

#[allow(non_snake_case)]
fn QueryPlan_ok(
    system: &str,
    actual: bool,
    root: PlanNode,
    total_time: Option<f64>,
    warnings: Vec<String>,
    raw: &str,
) -> Result<QueryPlan, String> {
    Ok(QueryPlan {
        system: system.to_string(),
        mode: if actual { "actual".into() } else { "estimated".into() },
        summary: PlanSummary {
            total_cost: root.estimated_cost,
            total_time_ms: total_time.or(root.actual_time_ms),
            warnings,
        },
        root: Some(root),
        raw: raw.to_string(),
    })
}

/// Gán `cost_self` + `cost_pct` cho toàn cây (P3.1 — hiển thị "Cost: N%" kiểu SSMS).
/// `cumulative=true` khi cost node đã gồm con (PG "Total Cost", MSSQL
/// "EstimatedTotalSubtreeCost") → self = total − Σ con (clamp 0). `false` khi cost
/// đã là self (MySQL read_cost). cost_pct = self / tổng-self toàn cây × 100.
fn assign_cost_pct(root: &mut PlanNode, cumulative: bool) {
    fn set_self(node: &mut PlanNode, cumulative: bool) {
        for c in node.children.iter_mut() {
            set_self(c, cumulative);
        }
        node.cost_self = if cumulative {
            node.estimated_cost.map(|total| {
                let kids: f64 = node.children.iter().filter_map(|c| c.estimated_cost).sum();
                (total - kids).max(0.0)
            })
        } else {
            node.estimated_cost
        };
    }
    fn sum_self(node: &PlanNode) -> f64 {
        node.cost_self.unwrap_or(0.0) + node.children.iter().map(sum_self).sum::<f64>()
    }
    fn set_pct(node: &mut PlanNode, total: f64) {
        if let Some(s) = node.cost_self {
            node.cost_pct = Some((s / total * 1000.0).round() / 10.0);
        }
        for c in node.children.iter_mut() {
            set_pct(c, total);
        }
    }
    set_self(root, cumulative);
    let total = if cumulative {
        root.estimated_cost.filter(|t| *t > 0.0).unwrap_or_else(|| sum_self(root))
    } else {
        sum_self(root)
    };
    if total > 0.0 {
        set_pct(root, total);
    }
}

/// Đánh dấu hotspot + thêm cảnh báo: seq scan bảng lớn; actual lệch estimated >10x.
fn mark_hotspot(node: &mut PlanNode, warnings: &mut Vec<String>) {
    let rows = node.estimated_rows.or(node.actual_rows).unwrap_or(0.0);
    if node.operation == "SeqScan" && rows > LARGE_ROWS {
        node.is_hotspot = true;
        let rel = node.extra.get("Relation Name").and_then(Value::as_str).unwrap_or("table");
        warnings.push(format!("Seq Scan on {rel} (~{} rows)", rows as i64));
    }
    if let (Some(est), Some(act)) = (node.estimated_rows, node.actual_rows) {
        if est > 0.0 && (act / est > 10.0 || est / act.max(1.0) > 10.0) {
            node.is_hotspot = true;
            warnings.push(format!(
                "{}: actual {} vs estimated {} (off by >10x)",
                node.operation, act as i64, est as i64
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities() {
        assert_eq!(capability("postgres").actual_kind, ActualKind::Analyze);
        assert!(capability("postgres").supports_actual);
        assert_eq!(capability("mariadb").actual_kind, ActualKind::Analyze);
        // engine có planner nhưng chưa lấy actual → toggle phải tắt
        assert!(!capability("mysql").supports_actual);
        assert!(!capability("mssql").supports_actual);
        assert!(!capability("sqlite").supports_actual);
        assert!(!capability("clickhouse").supports_actual);
        assert_eq!(capability("clickhouse").cost_basis, CostBasis::RowsProxy);
        // Cassandra: tracing, không planner tĩnh
        assert_eq!(capability("cassandra").actual_kind, ActualKind::Tracing);
        assert!(!capability("cassandra").has_planner);
        // messaging: không áp dụng
        for m in ["redis", "kafka", "nats"] {
            let c = capability(m);
            assert!(!c.has_planner && !c.supports_actual);
        }
    }

    #[test]
    fn normalize_ops() {
        assert_eq!(normalize_op("Seq Scan"), "SeqScan");
        assert_eq!(normalize_op("Index Scan"), "IndexScan");
        assert_eq!(normalize_op("Index Only Scan"), "IndexOnlyScan");
        assert_eq!(normalize_op("Hash Join"), "HashJoin");
        assert_eq!(normalize_op("Nested Loop"), "NestedLoop");
        // P1.2 — MSSQL scan vs seek phải phân biệt được
        assert_eq!(normalize_op("Clustered Index Scan"), "SeqScan", "full scan, dù có chữ 'index'");
        assert_eq!(normalize_op("Table Scan"), "SeqScan");
        assert_eq!(normalize_op("Index Seek"), "IndexSeek");
        assert_eq!(normalize_op("Clustered Index Seek"), "IndexSeek");
        // SQLite: SCAN trần → SeqScan (DEF-SQLITE-LABEL); dùng index vẫn IndexScan
        assert_eq!(normalize_op("SCAN t"), "SeqScan");
        assert_eq!(normalize_op("SEARCH t USING INDEX ix (a=?)"), "IndexScan");
        // covering index của SQLite giữ IndexScan như trước (tách IndexOnlyScan
        // là cải tiến riêng, ngoài scope P1.2)
        assert_eq!(normalize_op("SCAN t USING COVERING INDEX ix"), "IndexScan");
    }

    #[test]
    fn pg_json_tree_and_hotspot() {
        let json = r#"[{"Plan":{"Node Type":"Hash Join","Total Cost":250.5,"Plan Rows":100,
          "Plans":[
            {"Node Type":"Seq Scan","Relation Name":"orders","Total Cost":180.0,"Plan Rows":50000,"Actual Rows":50000},
            {"Node Type":"Index Scan","Index Name":"users_pk","Total Cost":8.0,"Plan Rows":1}
          ]},"Execution Time":12.3}]"#;
        let plan = parse_pg(json, true).unwrap();
        assert_eq!(plan.mode, "actual");
        let root = plan.root.unwrap();
        assert_eq!(root.operation, "HashJoin");
        assert_eq!(root.children.len(), 2);
        assert_eq!(root.children[0].operation, "SeqScan");
        assert!(root.children[0].is_hotspot, "seq scan 50k rows phải là hotspot");
        assert_eq!(root.children[1].operation, "IndexScan");
        assert_eq!(plan.summary.total_time_ms, Some(12.3));
        assert!(plan.summary.warnings.iter().any(|w| w.contains("orders")));
    }

    #[test]
    fn pg_loops_multiply_rows_and_time() {
        // Nhánh trong Nested Loop: Actual Rows=1/loop × 50000 loops = 50000 tổng.
        let json = r#"[{"Plan":{"Node Type":"Nested Loop","Total Cost":100,"Plan Rows":50000,"Actual Rows":50000,"Actual Loops":1,
          "Plans":[
            {"Node Type":"Index Scan","Index Name":"ix","Total Cost":5,"Plan Rows":1,"Actual Rows":1,"Actual Total Time":0.002,"Actual Loops":50000}
          ]}}]"#;
        let plan = parse_pg(json, true).unwrap();
        let inner = &plan.root.unwrap().children[0];
        assert_eq!(inner.actual_rows, Some(50000.0), "actual rows × loops");
        assert_eq!(inner.estimated_rows, Some(50000.0), "estimated rows × loops");
        assert_eq!(inner.actual_time_ms, Some(100.0), "time × loops (0.002 × 50000)");
    }

    #[test]
    fn pg_selective_seqscan_flagged_by_rows_scanned() {
        // Seq Scan trả 1 dòng nhưng quét 50k (Rows Removed by Filter) → hotspot,
        // dù rows đầu ra nhỏ (DEF-PG-HOTSPOT).
        let json = r#"[{"Plan":{"Node Type":"Seq Scan","Relation Name":"t","Total Cost":900,"Plan Rows":1,"Actual Rows":1,"Actual Loops":1,"Rows Removed by Filter":49999}}]"#;
        let plan = parse_pg(json, true).unwrap();
        let root = plan.root.unwrap();
        assert_eq!(root.operation, "SeqScan");
        assert!(root.is_hotspot, "quét 50k trả 1 → hotspot");
        assert!(plan.summary.warnings.iter().any(|w| w.contains("scans")));
    }

    #[test]
    fn pg_cost_pct_self_cost() {
        // P3.1 — Hash Join total 250.5 gồm con (180 + 8) → self ≈ 62.5; % tổng ~100.
        let json = r#"[{"Plan":{"Node Type":"Hash Join","Total Cost":250.5,"Plan Rows":100,
          "Plans":[
            {"Node Type":"Seq Scan","Relation Name":"o","Total Cost":180.0,"Plan Rows":50},
            {"Node Type":"Index Scan","Index Name":"pk","Total Cost":8.0,"Plan Rows":1}
          ]}}]"#;
        let plan = parse_pg(json, false).unwrap();
        let root = plan.root.unwrap();
        assert_eq!(root.cost_self, Some(62.5), "self = 250.5 − (180 + 8)");
        assert_eq!(root.children[0].cost_self, Some(180.0));
        // tổng % ≈ 100 (±2 do làm tròn)
        let sum: f64 = root.cost_pct.unwrap_or(0.0)
            + root.children.iter().filter_map(|c| c.cost_pct).sum::<f64>();
        assert!((sum - 100.0).abs() <= 2.0, "tổng cost_pct ≈ 100, got {sum}");
    }

    #[test]
    fn sqlite_eqp_tree() {
        let rows = vec![
            (2, 0, "SCAN TABLE orders".to_string()),
            (3, 0, "SEARCH TABLE users USING INDEX users_pk (id=?)".to_string()),
        ];
        let plan = parse_sqlite(&rows);
        let root = plan.root.unwrap();
        assert_eq!(root.children.len(), 2);
        assert!(root.children[0].is_hotspot, "SCAN không index → hotspot");
        assert!(!root.children[1].is_hotspot, "SEARCH USING INDEX → không hotspot");
    }

    #[test]
    fn mysql_json_access_type() {
        let json = r#"{"query_block":{"table":{"table_name":"orders","access_type":"ALL",
          "rows_examined_per_scan":50000,"cost_info":{"read_cost":"1234.5"}}}}"#;
        let plan = parse_mysql(json, "mysql", false).unwrap();
        let root = plan.root.unwrap();
        assert_eq!(root.operation, "SeqScan");
        assert!(root.is_hotspot);
    }

    #[test]
    fn mysql_filesort_and_temp_table() {
        // P2.3 — ORDER BY (filesort) + GROUP BY (temp table) trên tập lớn.
        let json = r#"{"query_block":{
          "ordering_operation":{"using_filesort":true,
            "grouping_operation":{"using_temporary_table":true,
              "table":{"table_name":"orders","access_type":"ALL","rows_examined_per_scan":50000}}}}}"#;
        let plan = parse_mysql(json, "mysql", false).unwrap();
        let root = plan.root.unwrap();
        assert_eq!(root.operation, "Sort");
        assert_eq!(root.children[0].operation, "Aggregate");
        assert_eq!(root.children[0].children[0].operation, "SeqScan");
        assert!(plan.summary.warnings.iter().any(|w| w.to_lowercase().contains("filesort")));
        assert!(plan.summary.warnings.iter().any(|w| w.to_lowercase().contains("temporary")));
    }

    #[test]
    fn mysql_subquery_and_union() {
        // subquery gắn dưới table → node con xuất hiện
        let json_sub = r#"{"query_block":{"table":{"table_name":"a","access_type":"ALL","rows_examined_per_scan":10,
          "attached_subqueries":[{"query_block":{"table":{"table_name":"b","access_type":"ref"}}}]}}}"#;
        let root = parse_mysql(json_sub, "mysql", false).unwrap().root.unwrap();
        assert!(
            root.children.iter().any(|c| c.extra.get("Relation Name").and_then(|v| v.as_str()) == Some("b")),
            "subquery table 'b' phải hiện trong cây"
        );
        // UNION → node Union với 2 nhánh
        let json_u = r#"{"query_block":{"union_result":{"query_specifications":[
          {"query_block":{"table":{"table_name":"x","access_type":"ALL"}}},
          {"query_block":{"table":{"table_name":"y","access_type":"ALL"}}}]}}}"#;
        let uroot = parse_mysql(json_u, "mysql", false).unwrap().root.unwrap();
        assert_eq!(uroot.operation, "Union");
        assert_eq!(uroot.children.len(), 2);
    }

    #[test]
    fn mariadb_analyze_actual_rows() {
        // ANALYZE FORMAT=JSON: r_rows/r_total_time_ms → actual + mode=actual.
        let json = r#"{"query_block":{"r_total_time_ms":4.2,"table":{"table_name":"orders",
          "access_type":"ALL","rows_examined_per_scan":1000,"r_rows":950,"r_total_time_ms":3.1}}}"#;
        let plan = parse_mysql(json, "mariadb", true).unwrap();
        assert_eq!(plan.mode, "actual");
        assert_eq!(plan.summary.total_time_ms, Some(4.2));
        let root = plan.root.unwrap();
        assert_eq!(root.operation, "SeqScan");
        assert_eq!(root.actual_rows, Some(950.0));
        assert_eq!(root.actual_time_ms, Some(3.1));
        assert_eq!(root.estimated_rows, Some(1000.0));
    }

    #[test]
    fn not_applicable_for_messaging() {
        assert_eq!(QueryPlan::not_applicable("redis").mode, "not_applicable");
    }

    #[test]
    fn cassandra_trace_flags_allow_filtering() {
        let events = vec![
            ("Parsing CQL query".into(), "10.0.0.1".into(), 50i64),
            ("Executing seq scan across all ranges".into(), "10.0.0.1".into(), 4200i64),
        ];
        let plan = parse_cassandra_trace(
            "SELECT * FROM ks.t WHERE v = 1 ALLOW FILTERING",
            &[],
            &events,
        );
        let root = plan.root.unwrap();
        assert_eq!(root.operation, "SeqScan");
        assert!(root.is_hotspot, "ALLOW FILTERING → hotspot");
        assert!(plan.summary.warnings.iter().any(|w| w.contains("ALLOW FILTERING")));
        assert_eq!(root.children.len(), 2, "2 trace event → 2 timeline node");
        assert_eq!(plan.summary.total_time_ms, Some(4.2)); // max elapsed 4200us
        assert_eq!(plan.mode, "tracing", "Cassandra tracing ≠ EXPLAIN ANALYZE (P1.3)");
    }

    #[test]
    fn cassandra_trace_partition_key_not_hotspot() {
        // Query dùng partition key (không ALLOW FILTERING) → không hotspot.
        let plan = parse_cassandra_trace("SELECT * FROM ks.t WHERE pk = 1", &[], &[]);
        let root = plan.root.unwrap();
        assert_eq!(root.operation, "CqlRead");
        assert!(!root.is_hotspot);
        assert!(plan.summary.warnings.is_empty());
    }

    #[test]
    fn mssql_showplan_xml_tree() {
        // SHOWPLAN_XML dùng default namespace → parser phải match theo local name.
        let xml = r#"<?xml version="1.0"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
  <BatchSequence><Batch><Statements><StmtSimple>
    <QueryPlan>
      <RelOp PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="100" EstimatedTotalSubtreeCost="0.55">
        <NestedLoops>
          <RelOp PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="50000" EstimatedTotalSubtreeCost="0.4">
            <TableScan><Object Table="[db].[dbo].[orders]"/></TableScan>
          </RelOp>
          <RelOp PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.1">
            <IndexScan><Object Table="[db].[dbo].[users]"/></IndexScan>
          </RelOp>
        </NestedLoops>
      </RelOp>
    </QueryPlan>
  </StmtSimple></Statements></Batch></BatchSequence>
</ShowPlanXML>"#;
        let plan = parse_mssql_xml(xml).unwrap();
        let root = plan.root.unwrap();
        assert_eq!(root.operation, "NestedLoop");
        assert_eq!(root.children.len(), 2, "2 RelOp con lồng trong NestedLoops");
        assert_eq!(root.children[0].operation, "SeqScan"); // Table Scan
        assert_eq!(root.children[0].extra.get("Relation Name").and_then(|v| v.as_str()), Some("db.dbo.orders"));
        assert!(root.children[0].is_hotspot, "Table Scan 50k rows → hotspot");
        // P1.2: Clustered Index Seek phân biệt với scan → IndexSeek (KHÔNG còn IndexScan)
        assert_eq!(root.children[1].operation, "IndexSeek");
        assert!(!root.children[1].is_hotspot, "seek 1 row → không hotspot");
        assert_eq!(plan.summary.total_cost, Some(0.55));
    }

    #[test]
    fn clickhouse_explain_indent_tree() {
        // EXPLAIN plain (không index) → ReadFromMergeTree phải là SeqScan + hotspot.
        let text = "Expression ((Projection + Before ORDER BY))\n  Aggregating\n    Expression (Before GROUP BY)\n      ReadFromMergeTree (default.students)";
        let plan = parse_clickhouse(text);
        let root = plan.root.expect("có root");
        assert_eq!(root.native_op, "Expression");
        // đi xuống theo cây tới ReadFromMergeTree
        let agg = &root.children[0];
        assert_eq!(agg.operation, "Aggregate");
        let read = &agg.children[0].children[0];
        assert_eq!(read.operation, "SeqScan");
        assert_eq!(read.native_op, "ReadFromMergeTree");
        assert_eq!(read.extra.get("relation").and_then(|v| v.as_str()), Some("default.students"));
        assert!(read.is_hotspot, "full read không index → hotspot");
        assert!(plan.summary.warnings.iter().any(|w| w.contains("default.students")));
    }

    #[test]
    fn clickhouse_explain_with_index_no_hotspot() {
        // Có section Indexes/PrimaryKey → không cảnh báo full-scan.
        let text = "Expression (Projection)\n  ReadFromMergeTree (default.students)\n  Indexes:\n    PrimaryKey\n      Keys: id\n      Condition: (id in [5, 5])\n      Parts: 1/4";
        let plan = parse_clickhouse(text);
        let root = plan.root.unwrap();
        let read = root.children.iter().find(|n| n.native_op == "ReadFromMergeTree").unwrap();
        assert_eq!(read.operation, "SeqScan");
        assert!(!read.is_hotspot, "dùng PrimaryKey → không hotspot");
        assert!(plan.summary.warnings.is_empty());
        // metadata (Indexes/PrimaryKey/Condition/Parts) gộp vào read node, KHÔNG tạo node
        assert!(read.children.is_empty(), "metadata không thành node con");
        assert!(read.extra.contains_key("index_analysis"), "metadata gộp vào extra");
    }

    #[test]
    fn clickhouse_granule_ratio_hotspot() {
        // P2.2 — full-granule read (6/6) → hotspot; pruned (1/6) → không.
        let full = "Expression (Projection)\n  ReadFromMergeTree (db.t)\n  Indexes:\n    PrimaryKey\n      Condition: true\n      Parts: 1/1\n      Granules: 6/6";
        let pf = parse_clickhouse(full);
        let rf = pf.root.unwrap().children.into_iter().find(|n| n.native_op == "ReadFromMergeTree").unwrap();
        assert!(rf.is_hotspot, "6/6 granules → full read → hotspot");
        assert!(pf.summary.warnings.iter().any(|w| w.contains("6/6")));

        let key = "Expression (Projection)\n  ReadFromMergeTree (db.t)\n  Indexes:\n    PrimaryKey\n      Condition: (id in [42, 42])\n      Parts: 1/1\n      Granules: 1/6";
        let pk = parse_clickhouse(key);
        let rk = pk.root.unwrap().children.into_iter().find(|n| n.native_op == "ReadFromMergeTree").unwrap();
        assert!(!rk.is_hotspot, "1/6 granules → prune tốt → không hotspot");
        assert!(pk.summary.warnings.is_empty());
    }
}
