//! Shared driver helpers: statement classification + identifier quoting.

/// Leading verb of a statement, with comments and whitespace stripped.
pub fn leading_verb(sql: &str) -> String {
    let stripped = strip_leading_comments(sql);
    stripped
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}

/// Removes leading line (`--`) and block (`/* */`) comments plus whitespace.
pub fn strip_leading_comments(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            match r.find('\n') {
                Some(idx) => rest = r[idx + 1..].trim_start(),
                None => return "",
            }
        } else if let Some(r) = rest.strip_prefix("/*") {
            match r.find("*/") {
                Some(idx) => rest = r[idx + 2..].trim_start(),
                None => return "",
            }
        } else {
            return rest;
        }
    }
}

/// True when the statement is expected to produce a result set.
pub fn returns_rows(sql: &str) -> bool {
    let verb = leading_verb(sql);
    matches!(
        verb.as_str(),
        // CALL: MySQL/MariaDB stored procedures return result set(s); routing CALL
        // through the rows path reads them instead of discarding them on the
        // execute() path (which also trips a protocol/"data" error on some servers).
        // PG CALL returns no rows → an empty result set, which is fine.
        "SELECT" | "WITH" | "SHOW" | "EXPLAIN" | "VALUES" | "TABLE" | "PRAGMA" | "DESCRIBE" | "DESC" | "ANALYZE" | "CALL"
    ) || contains_returning(sql)
}

/// DML verbs (affected-rows semantics when not RETURNING).
pub fn is_dml(sql: &str) -> bool {
    matches!(
        leading_verb(sql).as_str(),
        "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "MERGE" | "TRUNCATE"
    )
}

/// Best-effort check for a RETURNING / OUTPUT clause outside of strings.
fn contains_returning(sql: &str) -> bool {
    let upper = sql.to_ascii_uppercase();
    let verb = leading_verb(sql);
    if !matches!(verb.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE") {
        return false;
    }
    upper.contains("RETURNING") || upper.contains(" OUTPUT ")
}

/// Dialect-correct identifier quoting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteStyle {
    /// PostgreSQL / SQLite / Cassandra: "ident"
    DoubleQuote,
    /// MySQL / MariaDB / ClickHouse: `ident`
    Backtick,
    /// MSSQL: [ident]
    Bracket,
}

pub fn quote_ident(name: &str, style: QuoteStyle) -> String {
    match style {
        QuoteStyle::DoubleQuote => format!("\"{}\"", name.replace('"', "\"\"")),
        QuoteStyle::Backtick => format!("`{}`", name.replace('`', "``")),
        QuoteStyle::Bracket => format!("[{}]", name.replace(']', "]]")),
    }
}

/// Maps a 1-based character offset within `sql` to (line, col), both 1-based.
pub fn offset_to_line_col(sql: &str, offset_1based: usize) -> (u32, u32) {
    let mut line = 1u32;
    let mut col = 1u32;
    for (i, ch) in sql.chars().enumerate() {
        if i + 1 == offset_1based {
            return (line, col);
        }
        if ch == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verb_detection() {
        assert_eq!(leading_verb("  -- c\n SELECT 1"), "SELECT");
        assert_eq!(leading_verb("/* x */ UPDATE t SET a=1"), "UPDATE");
        assert!(returns_rows("select * from t"));
        assert!(returns_rows("INSERT INTO t VALUES (1) RETURNING id"));
        assert!(!returns_rows("INSERT INTO t VALUES (1)"));
        assert!(is_dml("delete from t"));
    }

    #[test]
    fn offset_mapping() {
        // "SELECT\nx" — offset of 'x' is 8 (1-based)
        assert_eq!(offset_to_line_col("SELECT\nx", 8), (2, 1));
        assert_eq!(offset_to_line_col("ab\ncd", 4), (2, 1));
    }
}
