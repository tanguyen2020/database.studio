//! Editable grid — pending changes → statement tham số hóa theo dialect.
//! Builder này sinh (sql_với_placeholder, params theo thứ tự); driver bind giá
//! trị thật (KHÔNG nối chuỗi param vào SQL — DO NOT của spec). `preview_sql`
//! chỉ render literal để HIỂN THỊ trong dialog diff, không dùng để chạy.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::drivers::util::{quote_ident, QuoteStyle};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placeholder {
    /// PostgreSQL: $1, $2, ...
    Dollar,
    /// MySQL/MariaDB/SQLite: ?
    Question,
    /// MSSQL: @P1, @P2, ...
    AtP,
    /// Oracle: :1, :2, ...
    Colon,
}

impl Placeholder {
    pub fn of(system: &str) -> Self {
        match system {
            "postgres" => Placeholder::Dollar,
            "mssql" => Placeholder::AtP,
            "oracle" => Placeholder::Colon,
            _ => Placeholder::Question, // mysql, mariadb, sqlite
        }
    }
    fn render(&self, idx: usize) -> String {
        match self {
            Placeholder::Dollar => format!("${idx}"),
            Placeholder::Question => "?".into(),
            Placeholder::AtP => format!("@P{idx}"),
            Placeholder::Colon => format!(":{idx}"),
        }
    }
}

fn quote_style(system: &str) -> QuoteStyle {
    match system {
        "mysql" | "mariadb" | "clickhouse" => QuoteStyle::Backtick,
        "mssql" => QuoteStyle::Bracket,
        _ => QuoteStyle::DoubleQuote,
    }
}

/// Một thay đổi pending trên grid.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum GridChange {
    Update {
        schema: Option<String>,
        table: String,
        /// điều kiện định vị dòng (thường là PK; nếu không có PK → mọi cột cũ)
        pk: Vec<Col>,
        set: Vec<Col>,
    },
    Insert {
        schema: Option<String>,
        table: String,
        values: Vec<Col>,
    },
    Delete {
        schema: Option<String>,
        table: String,
        pk: Vec<Col>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Col {
    pub name: String,
    pub value: Value,
    /// SQL type of the column (e.g. "uuid", "int8"), sent by the frontend from
    /// the result-set metadata. Postgres casts the bound param to it ($1::uuid)
    /// so `uuid = $1` / `INSERT … VALUES ($1)` don't fail with a text mismatch.
    #[serde(rename = "type", default)]
    pub col_type: Option<String>,
}

/// A Postgres `::type` cast for a parameter, or "" for other systems / unsafe
/// type names. Only the introspected type name is trusted; still sanitised so a
/// crafted value can't inject SQL.
fn pg_cast(system: &str, ty: &Option<String>) -> String {
    if system != "postgres" {
        return String::new();
    }
    match ty {
        Some(t) if is_safe_type(t) => format!("::{t}"),
        _ => String::new(),
    }
}

fn is_safe_type(t: &str) -> bool {
    let t = t.trim();
    !t.is_empty()
        && t.len() <= 64
        && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '[' | ']'))
}

/// Câu lệnh đã tham số hóa: SQL + params theo đúng thứ tự placeholder.
pub struct BoundStatement {
    pub sql: String,
    pub params: Vec<Value>,
}

fn qualified(system: &str, schema: &Option<String>, table: &str) -> String {
    let q = quote_style(system);
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_ident(s, q), quote_ident(table, q)),
        _ => quote_ident(table, q),
    }
}

/// Sinh statement tham số hóa cho 1 change.
pub fn build(system: &str, change: &GridChange) -> BoundStatement {
    let ph = Placeholder::of(system);
    let q = quote_style(system);
    let mut params: Vec<Value> = Vec::new();
    let mut n = 0usize;
    let next = |v: &Value, params: &mut Vec<Value>, n: &mut usize| -> String {
        *n += 1;
        params.push(v.clone());
        ph.render(*n)
    };

    let sql = match change {
        GridChange::Update { schema, table, pk, set } => {
            let set_clause = set
                .iter()
                .map(|c| {
                    format!("{} = {}{}", quote_ident(&c.name, q), next(&c.value, &mut params, &mut n), pg_cast(system, &c.col_type))
                })
                .collect::<Vec<_>>()
                .join(", ");
            let where_clause = build_where(system, pk, &mut params, &mut n, ph, q);
            format!("UPDATE {} SET {set_clause} WHERE {where_clause}", qualified(system, schema, table))
        }
        GridChange::Insert { schema, table, values } => {
            let cols = values.iter().map(|c| quote_ident(&c.name, q)).collect::<Vec<_>>().join(", ");
            let vals = values
                .iter()
                .map(|c| format!("{}{}", next(&c.value, &mut params, &mut n), pg_cast(system, &c.col_type)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {} ({cols}) VALUES ({vals})", qualified(system, schema, table))
        }
        GridChange::Delete { schema, table, pk } => {
            let where_clause = build_where(system, pk, &mut params, &mut n, ph, q);
            format!("DELETE FROM {} WHERE {where_clause}", qualified(system, schema, table))
        }
    };
    BoundStatement { sql, params }
}

fn build_where(
    system: &str,
    cols: &[Col],
    params: &mut Vec<Value>,
    n: &mut usize,
    ph: Placeholder,
    q: QuoteStyle,
) -> String {
    cols.iter()
        .map(|c| {
            if c.value.is_null() {
                format!("{} IS NULL", quote_ident(&c.name, q))
            } else {
                *n += 1;
                params.push(c.value.clone());
                format!("{} = {}{}", quote_ident(&c.name, q), ph.render(*n), pg_cast(system, &c.col_type))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// Render literal cho DIALOG PREVIEW (chỉ hiển thị — không chạy).
pub fn preview_sql(system: &str, change: &GridChange) -> String {
    // Cassandra: preview = the exact CQL that Apply will run (INSERT/UPDATE/DELETE
    // by full primary key), reusing the driver's pure builder.
    if system == "cassandra" {
        return crate::drivers::cassandra::cql_change_sql(change);
    }
    // MongoDB: preview = the mongosh op Apply will run (insert/update/delete by _id).
    if system == "mongodb" {
        return crate::drivers::mongo::mongo_change_preview(change);
    }
    let q = quote_style(system);
    let lit = |v: &Value| -> String {
        match v {
            Value::Null => "NULL".into(),
            Value::Bool(b) => b.to_string(),
            Value::Number(num) => num.to_string(),
            other => {
                let s = other.as_str().map(String::from).unwrap_or_else(|| other.to_string());
                format!("'{}'", s.replace('\'', "''"))
            }
        }
    };
    match change {
        GridChange::Update { schema, table, pk, set } => {
            let set_clause = set
                .iter()
                .map(|c| format!("{} = {}{}", quote_ident(&c.name, q), lit(&c.value), pg_cast(system, &c.col_type)))
                .collect::<Vec<_>>()
                .join(", ");
            let where_clause = preview_where(system, pk, q, &lit);
            format!("UPDATE {} SET {set_clause} WHERE {where_clause};", qualified(system, schema, table))
        }
        GridChange::Insert { schema, table, values } => {
            let cols = values.iter().map(|c| quote_ident(&c.name, q)).collect::<Vec<_>>().join(", ");
            let vals = values.iter().map(|c| format!("{}{}", lit(&c.value), pg_cast(system, &c.col_type))).collect::<Vec<_>>().join(", ");
            format!("INSERT INTO {} ({cols}) VALUES ({vals});", qualified(system, schema, table))
        }
        GridChange::Delete { schema, table, pk } => {
            format!("DELETE FROM {} WHERE {};", qualified(system, schema, table), preview_where(system, pk, q, &lit))
        }
    }
}

/// ClickHouse "Generate mutation" (CLICKHOUSE_SPEC_ADDENDUM §7, option a): dịch
/// pending change thành mutation ASYNC. UPDATE/DELETE = `ALTER TABLE … UPDATE/DELETE`
/// (theo dõi qua system.mutations, KHÔNG commit OLTP tức thì); INSERT = INSERT lô.
/// Chỉ render literal để review/mở trong editor — người dùng chủ động chạy.
pub fn ch_mutation_sql(change: &GridChange) -> String {
    let q = QuoteStyle::Backtick;
    let lit = |v: &Value| -> String {
        match v {
            Value::Null => "NULL".into(),
            Value::Bool(b) => b.to_string(),
            Value::Number(num) => num.to_string(),
            other => {
                let s = other.as_str().map(String::from).unwrap_or_else(|| other.to_string());
                format!("'{}'", s.replace('\'', "''"))
            }
        }
    };
    match change {
        GridChange::Update { schema, table, pk, set } => {
            let set_clause = set
                .iter()
                .map(|c| format!("{} = {}", quote_ident(&c.name, q), lit(&c.value)))
                .collect::<Vec<_>>()
                .join(", ");
            let where_clause = preview_where("clickhouse", pk, q, &lit);
            format!(
                "ALTER TABLE {} UPDATE {set_clause} WHERE {where_clause};",
                qualified("clickhouse", schema, table)
            )
        }
        GridChange::Delete { schema, table, pk } => {
            format!(
                "ALTER TABLE {} DELETE WHERE {};",
                qualified("clickhouse", schema, table),
                preview_where("clickhouse", pk, q, &lit)
            )
        }
        GridChange::Insert { schema, table, values } => {
            let cols = values.iter().map(|c| quote_ident(&c.name, q)).collect::<Vec<_>>().join(", ");
            let vals = values.iter().map(|c| lit(&c.value)).collect::<Vec<_>>().join(", ");
            format!("INSERT INTO {} ({cols}) VALUES ({vals});", qualified("clickhouse", schema, table))
        }
    }
}

fn preview_where(system: &str, cols: &[Col], q: QuoteStyle, lit: &dyn Fn(&Value) -> String) -> String {
    cols.iter()
        .map(|c| {
            if c.value.is_null() {
                format!("{} IS NULL", quote_ident(&c.name, q))
            } else {
                format!("{} = {}{}", quote_ident(&c.name, q), lit(&c.value), pg_cast(system, &c.col_type))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

// ---------------------------------------------------------------------------
// Filter builder (Table Data Viewer) — SELECT tham số hóa + ORDER BY + phân trang.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterCond {
    pub col: String,
    /// = != > >= < <= LIKE "IS NULL" "IS NOT NULL"
    pub op: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortSpec {
    pub col: String,
    pub desc: bool,
}

/// Build `SELECT * FROM t [WHERE ...] [ORDER BY ...] LIMIT ? OFFSET ?`.
/// Filter values bind tham số; LIMIT/OFFSET nội suy số nguyên an toàn.
pub fn build_select(
    system: &str,
    schema: &Option<String>,
    table: &str,
    filters: &[FilterCond],
    combinator_or: bool,
    sorts: &[SortSpec],
    limit: u32,
    offset: u32,
) -> BoundStatement {
    let ph = Placeholder::of(system);
    let q = quote_style(system);
    let mut params: Vec<Value> = Vec::new();
    let mut n = 0usize;

    let mut sql = format!("SELECT * FROM {}", qualified(system, schema, table));

    let valid_ops = ["=", "!=", "<>", ">", ">=", "<", "<=", "LIKE"];
    let conds: Vec<String> = filters
        .iter()
        .filter_map(|f| {
            let ident = quote_ident(&f.col, q);
            match f.op.to_uppercase().as_str() {
                "IS NULL" => Some(format!("{ident} IS NULL")),
                "IS NOT NULL" => Some(format!("{ident} IS NOT NULL")),
                op if valid_ops.contains(&op) || valid_ops.contains(&f.op.as_str()) => {
                    n += 1;
                    params.push(f.value.clone());
                    let real_op = if op == "LIKE" { "LIKE" } else { &f.op };
                    Some(format!("{ident} {real_op} {}", ph.render(n)))
                }
                _ => None, // toán tử lạ → bỏ (không nối chuỗi bừa)
            }
        })
        .collect();
    if !conds.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conds.join(if combinator_or { " OR " } else { " AND " }));
    }

    let orders: Vec<String> = sorts
        .iter()
        .map(|s| format!("{} {}", quote_ident(&s.col, q), if s.desc { "DESC" } else { "ASC" }))
        .collect();
    if !orders.is_empty() {
        sql.push_str(" ORDER BY ");
        sql.push_str(&orders.join(", "));
    }

    // LIMIT/OFFSET: MSSQL cần ORDER BY cho OFFSET…FETCH → thêm ORDER BY (SELECT 1) nếu thiếu
    let lim = limit.min(100_000);
    if system == "mssql" {
        if orders.is_empty() {
            sql.push_str(" ORDER BY (SELECT NULL)");
        }
        sql.push_str(&format!(" OFFSET {offset} ROWS FETCH NEXT {lim} ROWS ONLY"));
    } else if system == "oracle" {
        // Oracle 12c+ row limiting; unlike MSSQL it does not require an ORDER BY.
        sql.push_str(&format!(" OFFSET {offset} ROWS FETCH NEXT {lim} ROWS ONLY"));
    } else {
        sql.push_str(&format!(" LIMIT {lim} OFFSET {offset}"));
    }

    BoundStatement { sql, params }
}

/// ClickHouse-only filtered SELECT with values inlined as literals. ClickHouse's
/// HTTP interface has no positional bind, so `exec_params` is unavailable — this
/// mirrors `build_select` (filters / sorts / LIMIT-OFFSET) but escapes values into
/// the SQL text (single-quote doubling), then runs via the raw `exec` path. Only
/// used for ClickHouse; every other engine keeps the parameterized `build_select`.
pub fn build_select_literal(
    schema: &Option<String>,
    table: &str,
    filters: &[FilterCond],
    combinator_or: bool,
    sorts: &[SortSpec],
    limit: u32,
    offset: u32,
) -> String {
    let system = "clickhouse";
    let q = quote_style(system);
    let lit = |v: &Value| -> String {
        match v {
            Value::Null => "NULL".into(),
            Value::Bool(b) => b.to_string(),
            Value::Number(num) => num.to_string(),
            other => {
                let s = other.as_str().map(String::from).unwrap_or_else(|| other.to_string());
                format!("'{}'", s.replace('\'', "''"))
            }
        }
    };

    let mut sql = format!("SELECT * FROM {}", qualified(system, schema, table));

    let valid_ops = ["=", "!=", "<>", ">", ">=", "<", "<=", "LIKE"];
    let conds: Vec<String> = filters
        .iter()
        .filter_map(|f| {
            let ident = quote_ident(&f.col, q);
            match f.op.to_uppercase().as_str() {
                "IS NULL" => Some(format!("{ident} IS NULL")),
                "IS NOT NULL" => Some(format!("{ident} IS NOT NULL")),
                op if valid_ops.contains(&op) || valid_ops.contains(&f.op.as_str()) => {
                    let real_op = if op == "LIKE" { "LIKE" } else { &f.op };
                    Some(format!("{ident} {real_op} {}", lit(&f.value)))
                }
                _ => None,
            }
        })
        .collect();
    if !conds.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conds.join(if combinator_or { " OR " } else { " AND " }));
    }

    let orders: Vec<String> = sorts
        .iter()
        .map(|s| format!("{} {}", quote_ident(&s.col, q), if s.desc { "DESC" } else { "ASC" }))
        .collect();
    if !orders.is_empty() {
        sql.push_str(" ORDER BY ");
        sql.push_str(&orders.join(", "));
    }

    sql.push_str(&format!(" LIMIT {} OFFSET {offset}", limit.min(100_000)));
    sql
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(name: &str, value: Value) -> Col {
        Col { name: name.into(), value, col_type: None }
    }

    fn upd() -> GridChange {
        GridChange::Update {
            schema: Some("public".into()),
            table: "users".into(),
            pk: vec![col("id", json!(5))],
            set: vec![col("name", json!("An"))],
        }
    }

    #[test]
    fn pg_update_uses_dollar_placeholders() {
        let b = build("postgres", &upd());
        assert_eq!(b.sql, r#"UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2"#);
        assert_eq!(b.params, vec![json!("An"), json!(5)]);
    }

    #[test]
    fn pg_casts_typed_params_so_uuid_where_matches() {
        // A uuid PK: the value comes from the grid as a text string; without the
        // cast Postgres errors "operator does not exist: uuid = text".
        let ch = GridChange::Update {
            schema: Some("public".into()),
            table: "files".into(),
            pk: vec![Col { name: "id".into(), value: json!("019a8f69-cbe8-70cc"), col_type: Some("uuid".into()) }],
            set: vec![Col { name: "name".into(), value: json!("x.png"), col_type: Some("varchar".into()) }],
        };
        let b = build("postgres", &ch);
        assert_eq!(b.sql, r#"UPDATE "public"."files" SET "name" = $1::varchar WHERE "id" = $2::uuid"#);
        // insert casts too (uuid text → uuid column)
        let ins = build(
            "postgres",
            &GridChange::Insert {
                schema: None,
                table: "files".into(),
                values: vec![Col { name: "id".into(), value: json!("019a…"), col_type: Some("uuid".into()) }],
            },
        );
        assert_eq!(ins.sql, r#"INSERT INTO "files" ("id") VALUES ($1::uuid)"#);
        // other engines never get the ::cast (their operators are lenient)
        let m = build("mysql", &ch);
        assert!(!m.sql.contains("::"), "mysql should not receive pg casts: {}", m.sql);
    }

    #[test]
    fn pg_cast_rejects_unsafe_type_names() {
        // A crafted type must not inject SQL — only simple type names are cast.
        assert_eq!(pg_cast("postgres", &Some("uuid; DROP TABLE t".into())), "");
        assert_eq!(pg_cast("postgres", &Some("int8".into())), "::int8");
        assert_eq!(pg_cast("postgres", &Some("timestamp without time zone".into())), "::timestamp without time zone");
        assert_eq!(pg_cast("mysql", &Some("uuid".into())), "");
    }

    #[test]
    fn mysql_uses_question_and_backtick() {
        let b = build("mysql", &upd());
        assert_eq!(b.sql, "UPDATE `public`.`users` SET `name` = ? WHERE `id` = ?");
    }

    #[test]
    fn mssql_uses_atp_and_brackets() {
        let b = build("mssql", &upd());
        assert_eq!(b.sql, "UPDATE [public].[users] SET [name] = @P1 WHERE [id] = @P2");
    }

    #[test]
    fn insert_and_delete() {
        let ins = build(
            "sqlite",
            &GridChange::Insert {
                schema: None,
                table: "t".into(),
                values: vec![col("a", json!(1)), col("b", json!("x"))],
            },
        );
        assert_eq!(ins.sql, r#"INSERT INTO "t" ("a", "b") VALUES (?, ?)"#);
        assert_eq!(ins.params, vec![json!(1), json!("x")]);

        let del = build(
            "postgres",
            &GridChange::Delete {
                schema: None,
                table: "t".into(),
                pk: vec![col("id", json!(9))],
            },
        );
        assert_eq!(del.sql, r#"DELETE FROM "t" WHERE "id" = $1"#);
    }

    #[test]
    fn null_in_where_uses_is_null_not_param() {
        let b = build(
            "postgres",
            &GridChange::Delete {
                schema: None,
                table: "t".into(),
                pk: vec![col("note", json!(null))],
            },
        );
        assert_eq!(b.sql, r#"DELETE FROM "t" WHERE "note" IS NULL"#);
        assert!(b.params.is_empty(), "NULL không được bind làm param");
    }

    #[test]
    fn build_select_where_order_limit() {
        let b = build_select(
            "postgres",
            &Some("public".into()),
            "students",
            &[
                FilterCond { col: "status".into(), op: "=".into(), value: json!("active") },
                FilterCond { col: "gpa".into(), op: ">".into(), value: json!(3.0) },
            ],
            false,
            &[SortSpec { col: "gpa".into(), desc: true }],
            100,
            200,
        );
        assert_eq!(
            b.sql,
            r#"SELECT * FROM "public"."students" WHERE "status" = $1 AND "gpa" > $2 ORDER BY "gpa" DESC LIMIT 100 OFFSET 200"#
        );
        assert_eq!(b.params, vec![json!("active"), json!(3.0)]);
    }

    #[test]
    fn build_select_is_null_no_param() {
        let b = build_select("sqlite", &None, "t", &[FilterCond { col: "note".into(), op: "IS NULL".into(), value: json!(null) }], false, &[], 50, 0);
        assert_eq!(b.sql, r#"SELECT * FROM "t" WHERE "note" IS NULL LIMIT 50 OFFSET 0"#);
        assert!(b.params.is_empty());
    }

    #[test]
    fn build_select_mssql_offset_fetch() {
        let b = build_select("mssql", &None, "t", &[], false, &[], 100, 100);
        assert!(b.sql.contains("ORDER BY (SELECT NULL)"));
        assert!(b.sql.contains("OFFSET 100 ROWS FETCH NEXT 100 ROWS ONLY"));
    }

    #[test]
    fn build_select_rejects_unknown_operator() {
        // op lạ (SQL injection attempt) → điều kiện bị bỏ, không nối chuỗi
        let b = build_select("postgres", &None, "t", &[FilterCond { col: "a".into(), op: "; DROP TABLE t --".into(), value: json!(1) }], false, &[], 50, 0);
        assert!(!b.sql.contains("DROP"));
        assert!(!b.sql.contains("WHERE"));
    }

    #[test]
    fn ch_build_select_literal_inlines_values_backtick() {
        let sql = build_select_literal(
            &Some("analytics".into()),
            "events",
            &[
                FilterCond { col: "kind".into(), op: "=".into(), value: json!("click") },
                FilterCond { col: "n".into(), op: ">".into(), value: json!(5) },
            ],
            false,
            &[SortSpec { col: "ts".into(), desc: true }],
            100,
            200,
        );
        assert_eq!(
            sql,
            "SELECT * FROM `analytics`.`events` WHERE `kind` = 'click' AND `n` > 5 ORDER BY `ts` DESC LIMIT 100 OFFSET 200"
        );
    }

    #[test]
    fn ch_build_select_literal_escapes_quotes_and_rejects_bad_op() {
        // single quotes doubled (no injection); unknown op dropped
        let sql = build_select_literal(
            &None,
            "t",
            &[
                FilterCond { col: "name".into(), op: "=".into(), value: json!("O'Brien") },
                FilterCond { col: "a".into(), op: "; DROP TABLE t --".into(), value: json!(1) },
            ],
            false,
            &[],
            50,
            0,
        );
        assert!(sql.contains("`name` = 'O''Brien'"));
        assert!(!sql.contains("DROP"));
        assert!(sql.ends_with("LIMIT 50 OFFSET 0"));
    }

    #[test]
    fn ch_mutation_update_delete_insert() {
        // UPDATE → ALTER TABLE … UPDATE … WHERE (async mutation)
        let u = ch_mutation_sql(&GridChange::Update {
            schema: Some("analytics".into()),
            table: "events".into(),
            pk: vec![col("id", json!(7))],
            set: vec![col("status", json!("done"))],
        });
        assert_eq!(u, "ALTER TABLE `analytics`.`events` UPDATE `status` = 'done' WHERE `id` = 7;");
        // DELETE → ALTER TABLE … DELETE WHERE
        let d = ch_mutation_sql(&GridChange::Delete {
            schema: None,
            table: "events".into(),
            pk: vec![col("id", json!(7))],
        });
        assert_eq!(d, "ALTER TABLE `events` DELETE WHERE `id` = 7;");
        // INSERT → INSERT lô (không phải mutation)
        let i = ch_mutation_sql(&GridChange::Insert {
            schema: None,
            table: "events".into(),
            values: vec![col("a", json!(1)), col("b", json!("x"))],
        });
        assert_eq!(i, "INSERT INTO `events` (`a`, `b`) VALUES (1, 'x');");
    }

    #[test]
    fn preview_renders_literals_escaped() {
        let p = preview_sql(
            "postgres",
            &GridChange::Update {
                schema: None,
                table: "t".into(),
                pk: vec![col("id", json!(1))],
                set: vec![col("name", json!("O'Brien"))],
            },
        );
        assert_eq!(p, r#"UPDATE "t" SET "name" = 'O''Brien' WHERE "id" = 1;"#);
    }
}
