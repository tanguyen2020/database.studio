//! Lint tầng 1 — advisory, parse-only, KHÔNG chạy DB, KHÔNG bao giờ chặn Run
//! (QUERY_EDITOR_ERROR_HANDLING_ADDENDUM §1). Hai lớp:
//!   1. Cú pháp: sqlparser-rs với đúng dialect — chỉ báo khi parser CHẮC CHẮN
//!      (có vị trí token lỗi); không chắc → im lặng.
//!   2. Rule pack đặc thù từng hệ (semantic/text): danger UPDATE/DELETE thiếu
//!      WHERE, MSSQL LIMIT→TOP, ClickHouse không OFFSET/transaction, v.v.
//! Cảnh báo schema-aware (Unknown table/column) chạy ở frontend từ cache
//! autocomplete — không đi qua đây.

use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlparser::ast::{Expr, GroupByExpr, SelectItem, SetExpr, Statement};
use sqlparser::dialect::{
    ClickHouseDialect, Dialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect,
    SQLiteDialect,
};
use sqlparser::parser::Parser;

use crate::drivers::util::offset_to_line_col;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LintSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LintPos {
    pub line: u32,
    pub col: u32,
}

/// Output tầng 1 (addendum §1.5)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LintDiagnostic {
    pub severity: LintSeverity,
    pub message: String,
    pub from: LintPos,
    pub to: LintPos,
    pub rule: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quickfix: Option<String>,
}

fn dialect_of(system: &str) -> Box<dyn Dialect> {
    match system {
        "postgres" => Box::new(PostgreSqlDialect {}),
        "mysql" | "mariadb" => Box::new(MySqlDialect {}),
        "mssql" => Box::new(MsSqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        "clickhouse" => Box::new(ClickHouseDialect {}),
        _ => Box::new(GenericDialect {}),
    }
}

fn pos_at(sql: &str, offset0: usize) -> LintPos {
    let (line, col) = offset_to_line_col(sql, offset0 + 1);
    LintPos { line, col }
}

fn span(sql: &str, start0: usize, len: usize) -> (LintPos, LintPos) {
    (pos_at(sql, start0), pos_at(sql, start0 + len))
}

fn diag(
    sql: &str,
    start0: usize,
    len: usize,
    severity: LintSeverity,
    rule: &str,
    message: &str,
    quickfix: Option<&str>,
) -> LintDiagnostic {
    let (from, to) = span(sql, start0, len);
    LintDiagnostic {
        severity,
        message: message.to_string(),
        from,
        to,
        rule: rule.to_string(),
        quickfix: quickfix.map(str::to_string),
    }
}

/// Tách vị trí "Line: N, Column: M" trong message lỗi của sqlparser.
/// Không tách được → None (im lặng, tránh báo nhầm).
fn parse_error_location(msg: &str) -> Option<(u32, u32)> {
    let re = Regex::new(r"Line:\s*(\d+),\s*Column:\s*(\d+)").ok()?;
    let caps = re.captures(msg)?;
    Some((caps[1].parse().ok()?, caps[2].parse().ok()?))
}

/// Lint cú pháp qua sqlparser — Cassandra (CQL) KHÔNG đi qua đây (rule pack
/// riêng, phase Cassandra); Redis/Kafka/NATS không parse SQL.
fn syntax_lints(system: &str, sql: &str) -> (Vec<LintDiagnostic>, Option<Vec<Statement>>) {
    let dialect = dialect_of(system);
    match Parser::parse_sql(dialect.as_ref(), sql) {
        Ok(ast) => (Vec::new(), Some(ast)),
        Err(e) => {
            let msg = e.to_string();
            let mut out = Vec::new();
            if let Some((line, col)) = parse_error_location(&msg) {
                // gọn message: bỏ phần vị trí lặp lại
                let clean = Regex::new(r"\s*at Line:.*$")
                    .map(|re| re.replace(&msg, "").to_string())
                    .unwrap_or(msg.clone());
                out.push(LintDiagnostic {
                    severity: LintSeverity::Error,
                    message: clean,
                    from: LintPos { line, col },
                    to: LintPos { line, col: col + 1 },
                    rule: "syntax".into(),
                    quickfix: None,
                });
            }
            // không có vị trí → im lặng (addendum §1.1)
            (out, None)
        }
    }
}

/// AST checks khi parse thành công.
fn ast_lints(system: &str, sql: &str, ast: &[Statement]) -> Vec<LintDiagnostic> {
    let mut out = Vec::new();
    for stmt in ast {
        match stmt {
            Statement::Update { selection, .. } if selection.is_none() => {
                if let Some(m) = find_keyword(sql, "UPDATE") {
                    out.push(diag(
                        sql, m, 6,
                        LintSeverity::Warning,
                        "danger.update_without_where",
                        "UPDATE không có WHERE — sẽ sửa TOÀN BỘ bảng",
                        None,
                    ));
                }
            }
            Statement::Delete(d) if d.selection.is_none() => {
                if let Some(m) = find_keyword(sql, "DELETE") {
                    out.push(diag(
                        sql, m, 6,
                        LintSeverity::Warning,
                        "danger.delete_without_where",
                        "DELETE không có WHERE — sẽ xóa TOÀN BỘ bảng",
                        None,
                    ));
                }
            }
            Statement::Query(q) => {
                if let SetExpr::Select(sel) = q.body.as_ref() {
                    // MySQL/MariaDB ONLY_FULL_GROUP_BY (xấp xỉ): có GROUP BY mà
                    // projection chứa cột trần không nằm trong GROUP BY
                    if matches!(system, "mysql" | "mariadb") {
                        if let GroupByExpr::Expressions(group_exprs, _) = &sel.group_by {
                            if !group_exprs.is_empty() {
                                let grouped: Vec<String> =
                                    group_exprs.iter().map(|e| e.to_string()).collect();
                                for item in &sel.projection {
                                    let expr = match item {
                                        SelectItem::UnnamedExpr(e) => Some(e),
                                        SelectItem::ExprWithAlias { expr, .. } => Some(expr),
                                        _ => None,
                                    };
                                    if let Some(Expr::Identifier(id)) = expr {
                                        let name = id.to_string();
                                        if !grouped.contains(&name) {
                                            if let Some(m) = find_word(sql, &name) {
                                                out.push(diag(
                                                    sql, m, name.len(),
                                                    LintSeverity::Warning,
                                                    "mysql.only_full_group_by",
                                                    &format!(
                                                        "Cột `{name}` không nằm trong GROUP BY — lỗi với ONLY_FULL_GROUP_BY"
                                                    ),
                                                    None,
                                                ));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn find_keyword(sql: &str, kw: &str) -> Option<usize> {
    let re = Regex::new(&format!(r"(?i)\b{kw}\b")).ok()?;
    re.find(sql).map(|m| m.start())
}

fn find_word(sql: &str, word: &str) -> Option<usize> {
    let re = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(word))).ok()?;
    re.find(sql).map(|m| m.start())
}

/// Rule pack text-based per hệ (addendum §1.2 + §1.4) — chạy cả khi parse fail.
fn rule_pack_lints(system: &str, sql: &str) -> Vec<LintDiagnostic> {
    let mut out = Vec::new();
    let push_all = |out: &mut Vec<LintDiagnostic>,
                    pattern: &str,
                    severity: LintSeverity,
                    rule: &str,
                    message: &str,
                    quickfix: Option<&str>| {
        if let Ok(re) = Regex::new(pattern) {
            for m in re.find_iter(sql) {
                out.push(diag(sql, m.start(), m.len(), severity.clone(), rule, message, quickfix));
            }
        }
    };

    // danger chung (addendum §1.4)
    push_all(
        &mut out,
        r"(?i)\bTRUNCATE\s+TABLE\b|\bTRUNCATE\b",
        LintSeverity::Warning,
        "danger.truncate",
        "TRUNCATE xóa toàn bộ dữ liệu bảng — cần xác nhận khi chạy",
        None,
    );
    push_all(
        &mut out,
        r"(?i)\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|INDEX)\b",
        LintSeverity::Warning,
        "danger.drop",
        "DROP là thao tác không hoàn tác — cần xác nhận khi chạy",
        None,
    );

    match system {
        "postgres" => {
            if sql.contains('`') {
                if let Some(m) = sql.find('`') {
                    out.push(diag(
                        sql, m, 1,
                        LintSeverity::Warning,
                        "pg.backtick_ident",
                        "PostgreSQL dùng \"…\" cho định danh, không phải backtick",
                        Some("Thay ` bằng \""),
                    ));
                }
            }
        }
        "mssql" => {
            push_all(
                &mut out,
                r"(?i)\bLIMIT\s+\d+",
                LintSeverity::Warning,
                "mssql.limit_to_top",
                "SQL Server không có LIMIT — dùng TOP n (hoặc OFFSET…FETCH)",
                Some("SELECT TOP n …"),
            );
        }
        "sqlite" => {
            push_all(
                &mut out,
                r"(?i)\b(RIGHT|FULL)\s+(OUTER\s+)?JOIN\b",
                LintSeverity::Warning,
                "sqlite.right_full_join",
                "SQLite bản cũ (<3.39) không hỗ trợ RIGHT/FULL JOIN",
                None,
            );
        }
        "clickhouse" => {
            push_all(
                &mut out,
                r"(?i)\bOFFSET\s+\d+",
                LintSeverity::Warning,
                "ch.no_offset",
                "ClickHouse không dùng OFFSET kiểu SQL — dùng LIMIT n, m hoặc paging",
                None,
            );
            push_all(
                &mut out,
                r"(?i)^\s*UPDATE\b",
                LintSeverity::Warning,
                "ch.update_is_mutation",
                "ClickHouse: UPDATE phải là `ALTER TABLE … UPDATE … WHERE …` (mutation async)",
                Some("ALTER TABLE <bảng> UPDATE … WHERE …"),
            );
            push_all(
                &mut out,
                r"(?i)^\s*DELETE\s+FROM\b",
                LintSeverity::Warning,
                "ch.delete_is_mutation",
                "ClickHouse: DELETE là mutation async (`ALTER TABLE … DELETE WHERE …`)",
                Some("ALTER TABLE <bảng> DELETE WHERE …"),
            );
            push_all(
                &mut out,
                r"(?i)\b(BEGIN|COMMIT|ROLLBACK)\b",
                LintSeverity::Warning,
                "ch.no_transaction",
                "ClickHouse không có transaction — BEGIN/COMMIT/ROLLBACK không có tác dụng",
                None,
            );
        }
        _ => {}
    }
    out
}

/// CQL rule pack (Phase 4b) — KHÔNG ép qua parser SQL. CQL không phải SQL:
/// chặn JOIN/subquery/UNION/OFFSET (error), cảnh báo ALLOW FILTERING (anti-
/// pattern), LWT (Paxos) và BATCH (không phải để tăng tốc). WHERE ngoài key
/// → không parse được schema ở tầng 1; driver báo lỗi ở tầng 2 (map_exec_err).
fn cql_lints(sql: &str) -> Vec<LintDiagnostic> {
    let mut out = Vec::new();
    let push_all = |out: &mut Vec<LintDiagnostic>,
                    pattern: &str,
                    severity: LintSeverity,
                    rule: &str,
                    message: &str,
                    quickfix: Option<&str>| {
        if let Ok(re) = Regex::new(pattern) {
            for m in re.find_iter(sql) {
                out.push(diag(sql, m.start(), m.len(), severity.clone(), rule, message, quickfix));
            }
        }
    };

    push_all(
        &mut out,
        r"(?i)\b(INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+|CROSS\s+)?(OUTER\s+)?JOIN\b",
        LintSeverity::Error,
        "cql.no_join",
        "CQL không hỗ trợ JOIN — mô hình wide-column phi chuẩn hoá (đọc theo partition key)",
        None,
    );
    push_all(
        &mut out,
        r"(?i)\bUNION\b",
        LintSeverity::Error,
        "cql.no_union",
        "CQL không hỗ trợ UNION",
        None,
    );
    push_all(
        &mut out,
        r"(?i)\bOFFSET\b",
        LintSeverity::Error,
        "cql.no_offset",
        "CQL không có OFFSET — phân trang bằng paging state (LIMIT + token trang kế)",
        None,
    );
    push_all(
        &mut out,
        r"(?i)\(\s*SELECT\b",
        LintSeverity::Error,
        "cql.no_subquery",
        "CQL không hỗ trợ subquery",
        None,
    );
    push_all(
        &mut out,
        r"(?i)\bALLOW\s+FILTERING\b",
        LintSeverity::Warning,
        "cql.allow_filtering",
        "ALLOW FILTERING quét toàn cluster (anti-pattern) — chỉ dùng khi thật sự cần",
        None,
    );
    push_all(
        &mut out,
        r"(?i)\bIF\s+NOT\s+EXISTS\b|\bIF\s+EXISTS\b",
        LintSeverity::Info,
        "cql.lwt_cost",
        "Lightweight transaction (Paxos) — chi phí cao, tránh dùng ở hot path",
        None,
    );
    push_all(
        &mut out,
        r"(?i)\bBEGIN\s+(LOGGED\s+|UNLOGGED\s+)?BATCH\b",
        LintSeverity::Info,
        "cql.batch_not_faster",
        "BATCH chỉ đảm bảo atomicity trong 1 partition — KHÔNG dùng để tăng tốc",
        None,
    );
    // danger chung
    push_all(
        &mut out,
        r"(?i)\bTRUNCATE\b",
        LintSeverity::Warning,
        "danger.truncate",
        "TRUNCATE xóa toàn bộ dữ liệu bảng — cần xác nhận khi chạy",
        None,
    );
    push_all(
        &mut out,
        r"(?i)\bDROP\s+(KEYSPACE|TABLE|MATERIALIZED\s+VIEW|TYPE|INDEX|FUNCTION|AGGREGATE)\b",
        LintSeverity::Warning,
        "danger.drop",
        "DROP là thao tác không hoàn tác — cần xác nhận khi chạy",
        None,
    );
    out
}

/// Entry point — chạy trên TOÀN BỘ nội dung editor (vị trí đã là toàn document).
pub fn lint(system: &str, sql: &str) -> Vec<LintDiagnostic> {
    // Redis/Kafka/NATS: không parse SQL (addendum §1.2 dòng cuối)
    if matches!(system, "redis" | "kafka" | "nats") {
        return Vec::new();
    }
    // Cassandra: rule pack CQL riêng — KHÔNG ép qua parser SQL.
    if system == "cassandra" {
        return cql_lints(sql);
    }
    let (mut out, ast) = syntax_lints(system, sql);
    if let Some(ast) = &ast {
        out.extend(ast_lints(system, sql, ast));
    } else {
        // parse fail vẫn quét danger bằng regex (best-effort)
    }
    out.extend(rule_pack_lints(system, sql));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(system: &str, sql: &str) -> Vec<String> {
        lint(system, sql).into_iter().map(|d| d.rule).collect()
    }

    #[test]
    fn syntax_error_has_position() {
        let out = lint("postgres", "SELEC * FROM t");
        assert!(out.iter().any(|d| d.rule == "syntax"), "{out:?}");
        let s = out.iter().find(|d| d.rule == "syntax").unwrap();
        assert_eq!(s.severity, LintSeverity::Error);
        assert!(s.from.line >= 1 && s.from.col >= 1);
    }

    #[test]
    fn valid_sql_is_silent() {
        assert!(lint("postgres", "SELECT id, name FROM users WHERE id = 1").is_empty());
    }

    #[test]
    fn update_delete_without_where() {
        assert!(rules("postgres", "UPDATE t SET a = 1").contains(&"danger.update_without_where".into()));
        assert!(rules("mysql", "DELETE FROM t").contains(&"danger.delete_without_where".into()));
        // có WHERE → im lặng
        assert!(!rules("postgres", "UPDATE t SET a = 1 WHERE id = 2")
            .contains(&"danger.update_without_where".into()));
    }

    #[test]
    fn danger_truncate_drop() {
        assert!(rules("postgres", "TRUNCATE TABLE logs").contains(&"danger.truncate".into()));
        assert!(rules("mysql", "DROP TABLE cu").contains(&"danger.drop".into()));
    }

    #[test]
    fn mssql_limit_suggests_top() {
        let out = lint("mssql", "SELECT * FROM t LIMIT 10");
        let d = out.iter().find(|d| d.rule == "mssql.limit_to_top").expect("phải có lint LIMIT");
        assert!(d.quickfix.is_some());
    }

    #[test]
    fn pg_backtick_warns() {
        assert!(rules("postgres", "SELECT `name` FROM t").contains(&"pg.backtick_ident".into()));
        // backtick hợp lệ ở MySQL → không cảnh báo rule này
        assert!(!rules("mysql", "SELECT `name` FROM t").contains(&"pg.backtick_ident".into()));
    }

    #[test]
    fn sqlite_right_join_warns() {
        assert!(rules("sqlite", "SELECT * FROM a RIGHT JOIN b ON a.id=b.id")
            .contains(&"sqlite.right_full_join".into()));
    }

    #[test]
    fn clickhouse_rules() {
        assert!(rules("clickhouse", "SELECT * FROM t LIMIT 10 OFFSET 20").contains(&"ch.no_offset".into()));
        assert!(rules("clickhouse", "UPDATE t SET a=1 WHERE id=2").contains(&"ch.update_is_mutation".into()));
        assert!(rules("clickhouse", "DELETE FROM t WHERE id=2").contains(&"ch.delete_is_mutation".into()));
        assert!(rules("clickhouse", "BEGIN").contains(&"ch.no_transaction".into()));
    }

    #[test]
    fn mysql_only_full_group_by_approx() {
        let out = lint("mysql", "SELECT name, count(*) FROM t GROUP BY id");
        assert!(out.iter().any(|d| d.rule == "mysql.only_full_group_by"), "{out:?}");
        // cột nằm trong GROUP BY → im lặng
        let ok = lint("mysql", "SELECT id, count(*) FROM t GROUP BY id");
        assert!(!ok.iter().any(|d| d.rule == "mysql.only_full_group_by"));
    }

    #[test]
    fn non_sql_systems_silent() {
        assert!(lint("redis", "GET key").is_empty());
        assert!(lint("kafka", "whatever").is_empty());
        // CQL hợp lệ (SELECT theo partition key) → im lặng
        assert!(lint("cassandra", "SELECT * FROM students_by_id WHERE student_id = 1").is_empty());
    }

    #[test]
    fn cql_rejects_join_union_offset_subquery() {
        assert!(rules("cassandra", "SELECT * FROM a JOIN b ON a.id=b.id").contains(&"cql.no_join".into()));
        assert!(rules("cassandra", "SELECT * FROM a INNER JOIN b ON x").contains(&"cql.no_join".into()));
        assert!(rules("cassandra", "SELECT * FROM a UNION SELECT * FROM b").contains(&"cql.no_union".into()));
        assert!(rules("cassandra", "SELECT * FROM t LIMIT 10 OFFSET 5").contains(&"cql.no_offset".into()));
        assert!(rules("cassandra", "SELECT * FROM t WHERE id IN (SELECT id FROM u)")
            .contains(&"cql.no_subquery".into()));
        // JOIN là Error, không phải Warning
        let d = lint("cassandra", "SELECT * FROM a JOIN b ON x");
        assert_eq!(d.iter().find(|x| x.rule == "cql.no_join").unwrap().severity, LintSeverity::Error);
    }

    #[test]
    fn cql_warns_allow_filtering_lwt_batch() {
        assert!(rules("cassandra", "SELECT * FROM t WHERE name='x' ALLOW FILTERING")
            .contains(&"cql.allow_filtering".into()));
        assert!(rules("cassandra", "INSERT INTO t (a) VALUES (1) IF NOT EXISTS")
            .contains(&"cql.lwt_cost".into()));
        assert!(rules("cassandra", "BEGIN BATCH INSERT INTO t (a) VALUES (1) APPLY BATCH")
            .contains(&"cql.batch_not_faster".into()));
        assert!(rules("cassandra", "BEGIN UNLOGGED BATCH INSERT INTO t (a) VALUES (1) APPLY BATCH")
            .contains(&"cql.batch_not_faster".into()));
    }

    #[test]
    fn mariadb_uses_mysql_dialect() {
        assert!(lint("mariadb", "SELECT `a` FROM t WHERE id = 1").is_empty());
    }
}
