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

/// Ngưỡng coi là "bảng lớn" khi cảnh báo full/seq scan.
const LARGE_ROWS: f64 = 10_000.0;

/// Chuẩn hóa tên operation gốc về tập chung.
pub fn normalize_op(native: &str) -> String {
    let n = native.to_lowercase();
    let canon = if n.contains("seq scan") || n == "scan" || n.contains("table scan") || n.contains("full") {
        "SeqScan"
    } else if n.contains("index only scan") {
        "IndexOnlyScan"
    } else if n.contains("bitmap") {
        "BitmapScan"
    } else if n.contains("index scan") || n.contains("index range") || n.contains("seek") || (n.contains("search") && n.contains("index")) {
        "IndexScan"
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
    let root = parse_pg_node(plan, &mut warnings);
    let total_time = obj.get("Execution Time").and_then(Value::as_f64);
    QueryPlan_ok("postgres", actual, root, total_time, warnings, json_text)
}

fn parse_pg_node(plan: &Value, warnings: &mut Vec<String>) -> PlanNode {
    let native = plan.get("Node Type").and_then(Value::as_str).unwrap_or("Unknown").to_string();
    let mut node = PlanNode::leaf(&normalize_op(&native), &native);
    node.estimated_rows = plan.get("Plan Rows").and_then(Value::as_f64);
    node.actual_rows = plan.get("Actual Rows").and_then(Value::as_f64);
    node.estimated_cost = plan.get("Total Cost").and_then(Value::as_f64);
    node.actual_time_ms = plan.get("Actual Total Time").and_then(Value::as_f64);
    for key in ["Relation Name", "Index Name", "Filter", "Join Type", "Hash Cond", "Index Cond", "Sort Key"] {
        if let Some(val) = plan.get(key) {
            node.extra.insert(key.to_string(), val.clone());
        }
    }
    mark_hotspot(&mut node, warnings);
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
    let root = parse_mysql_block(qb, actual, &mut warnings);
    let total_time = qb.get("r_total_time_ms").and_then(Value::as_f64);
    QueryPlan_ok(system, actual, root, total_time, warnings, json_text)
}

fn parse_mysql_block(block: &Value, actual: bool, warnings: &mut Vec<String>) -> PlanNode {
    // nested_loop → join; table → scan
    if let Some(nested) = block.get("nested_loop").and_then(Value::as_array) {
        let mut node = PlanNode::leaf("NestedLoop", "nested_loop");
        node.children = nested.iter().map(|t| parse_mysql_block(t, actual, warnings)).collect();
        return node;
    }
    if let Some(table) = block.get("table") {
        return parse_mysql_table(table, actual, warnings);
    }
    if let Some(cost) = block.get("cost_info").and_then(|c| c.get("query_cost")).and_then(Value::as_str) {
        let mut n = PlanNode::leaf("QueryBlock", "query_block");
        n.estimated_cost = cost.parse().ok();
        // đệ quy vào table nếu có
        return n;
    }
    PlanNode::leaf("QueryBlock", "query_block")
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
    mark_hotspot(&mut node, warnings);
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

/// Parse output `EXPLAIN indexes = 1` của ClickHouse. Mỗi dòng non-empty là 1
/// node; số space đầu dòng / 2 = độ sâu. Tên op = phần trước dấu '('.
pub fn parse_clickhouse(text: &str) -> QueryPlan {
    struct Raw {
        depth: usize,
        op: String,
        detail: String,
    }
    let mut raws: Vec<Raw> = Vec::new();
    let mut uses_index = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.chars().take_while(|c| *c == ' ').count();
        let content = line.trim();
        if content.contains("PrimaryKey") || content.contains("Skip") || content.contains("MinMax") {
            uses_index = true;
        }
        let op = content.split('(').next().unwrap_or(content).trim().trim_end_matches(':').to_string();
        raws.push(Raw { depth: indent / 2, op, detail: content.to_string() });
    }

    let mut warnings = Vec::new();
    // Stack-based tree build theo depth.
    // Mỗi phần tử stack: (depth, index trong flat Vec<PlanNode> tạm) — dùng đệ quy chỉ số cha.
    let mut nodes: Vec<PlanNode> = Vec::new();
    let mut parent_of: Vec<Option<usize>> = Vec::new();
    let mut stack: Vec<(usize, usize)> = Vec::new(); // (depth, node index)
    for r in &raws {
        while stack.last().map(|(d, _)| *d >= r.depth).unwrap_or(false) {
            stack.pop();
        }
        let parent = stack.last().map(|(_, i)| *i);
        let op = ch_op(&r.op);
        let mut node = PlanNode::leaf(&op, &r.op);
        node.extra.insert("detail".into(), Value::String(r.detail.clone()));
        // relation trong ngoặc của ReadFrom…
        if r.op.to_lowercase().starts_with("readfrom") {
            if let (Some(a), Some(b)) = (r.detail.find('('), r.detail.rfind(')')) {
                if b > a + 1 {
                    node.extra.insert("relation".into(), Value::String(r.detail[a + 1..b].to_string()));
                }
            }
        }
        let idx = nodes.len();
        nodes.push(node);
        parent_of.push(parent);
        stack.push((r.depth, idx));
    }

    // Full scan không dùng index → hotspot + cảnh báo.
    if !uses_index {
        for n in nodes.iter_mut() {
            if n.operation == "SeqScan" {
                n.is_hotspot = true;
                let rel = n.extra.get("relation").and_then(Value::as_str).unwrap_or("table");
                warnings.push(format!("ClickHouse reads all of {rel} (no index used)"));
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
    let root = build_mssql_node(root_relop, &mut warnings);
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
        mode: "actual".into(),
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
    fn normalize_ops() {
        assert_eq!(normalize_op("Seq Scan"), "SeqScan");
        assert_eq!(normalize_op("Index Scan"), "IndexScan");
        assert_eq!(normalize_op("Index Only Scan"), "IndexOnlyScan");
        assert_eq!(normalize_op("Hash Join"), "HashJoin");
        assert_eq!(normalize_op("Nested Loop"), "NestedLoop");
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
        assert_eq!(plan.mode, "actual");
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
        assert_eq!(root.children[1].operation, "IndexScan"); // Clustered Index Seek
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
    }
}
