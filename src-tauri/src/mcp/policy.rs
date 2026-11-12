//! MCP policy — the one security gate every SQL from an agent passes through.
//!
//! Pure + unit-tested (no DB). Two jobs:
//!   * `classify(sql)` — is this statement Read (SELECT/EXPLAIN/SHOW/…), Write
//!     (INSERT/UPDATE/DELETE/DDL/CALL/…), or Blocked (more than one statement)?
//!   * `enforce_limit(sql, system, cap)` — push a row cap onto a plain read so the
//!     agent (and this process) never pulls millions of rows. Belt-and-suspenders:
//!     the dispatcher ALSO truncates the fetched rows to the cap.
//!
//! The SQL from an agent is untrusted; a column value that looks like SQL must
//! never change the verdict, so classification runs on a *masked* copy where the
//! contents of strings, quoted identifiers and comments are blanked out.

/// What the agent is allowed to do with a statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Access {
    /// SELECT / WITH…SELECT / EXPLAIN / SHOW / DESCRIBE / PRAGMA / VALUES / TABLE.
    Read,
    /// Anything that can change data or schema (INSERT/UPDATE/DELETE/MERGE/DDL/CALL…),
    /// or EXPLAIN ANALYZE of such a statement (it actually runs).
    Write,
    /// Rejected outright (never runs), with a reason for the agent.
    Blocked(String),
}

/// Blank out the contents of string literals, quoted identifiers and comments so
/// keyword/`;`/paren scanning can't be fooled by data. Keeps every char position
/// (replaces masked chars with a space) so lengths line up.
fn mask(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    let n = chars.len();
    while i < n {
        let c = chars[i];
        // line comment --...
        if c == '-' && i + 1 < n && chars[i + 1] == '-' {
            while i < n && chars[i] != '\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        // block comment /* ... */
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            out.push(' ');
            out.push(' ');
            i += 2;
            while i < n && !(chars[i] == '*' && i + 1 < n && chars[i + 1] == '/') {
                out.push(if chars[i] == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            if i < n {
                out.push(' ');
                out.push(' ');
                i += 2;
            }
            continue;
        }
        // # comment (MySQL)
        if c == '#' {
            while i < n && chars[i] != '\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        // PostgreSQL / DuckDB dollar-quote  $$...$$  or  $tag$...$tag$
        if c == '$' {
            if let Some(tag_len) = dollar_tag(&chars[i..]) {
                let tag: String = chars[i..i + tag_len].iter().collect();
                for _ in 0..tag_len {
                    out.push(' ');
                }
                i += tag_len;
                // consume until closing tag
                while i < n {
                    if chars[i] == '$' && starts_with(&chars[i..], &tag) {
                        for _ in 0..tag_len {
                            out.push(' ');
                        }
                        i += tag_len;
                        break;
                    }
                    out.push(if chars[i] == '\n' { '\n' } else { ' ' });
                    i += 1;
                }
                continue;
            }
        }
        // quoted spans: '...'  "..."  `...`  [...]
        let close = match c {
            '\'' => Some('\''),
            '"' => Some('"'),
            '`' => Some('`'),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(closing) = close {
            out.push(' ');
            i += 1;
            while i < n {
                let d = chars[i];
                // '' or "" or `` doubled-escape → stay inside
                if d == closing && closing != ']' && i + 1 < n && chars[i + 1] == closing {
                    out.push(' ');
                    out.push(' ');
                    i += 2;
                    continue;
                }
                // backslash escape inside single quotes (MySQL/MariaDB/ClickHouse)
                if d == '\\' && closing == '\'' && i + 1 < n {
                    out.push(' ');
                    out.push(' ');
                    i += 2;
                    continue;
                }
                if d == closing {
                    out.push(' ');
                    i += 1;
                    break;
                }
                out.push(if d == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

fn starts_with(chars: &[char], tag: &str) -> bool {
    let t: Vec<char> = tag.chars().collect();
    chars.len() >= t.len() && chars[..t.len()] == t[..]
}

/// If `chars` starts with a dollar-quote opening tag (`$$` or `$word$`), return
/// its length in chars; else None.
fn dollar_tag(chars: &[char]) -> Option<usize> {
    if chars.first() != Some(&'$') {
        return None;
    }
    let mut j = 1;
    while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
        j += 1;
    }
    if j < chars.len() && chars[j] == '$' {
        Some(j + 1)
    } else {
        None
    }
}

/// Number of non-empty statements (split on top-level `;`, ignoring ones that are
/// only whitespace after masking).
fn statement_count(masked: &str) -> usize {
    let mut depth: i32 = 0;
    let mut count = 0;
    let mut seg_has_content = false;
    for c in masked.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = (depth - 1).max(0),
            ';' if depth == 0 => {
                if seg_has_content {
                    count += 1;
                }
                seg_has_content = false;
                continue;
            }
            _ => {}
        }
        if !c.is_whitespace() {
            seg_has_content = true;
        }
    }
    if seg_has_content {
        count += 1;
    }
    count
}

/// Lowercased first word of the (masked) statement.
fn leading_word(masked: &str) -> String {
    masked
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .find(|w| !w.is_empty())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Set of lowercase words that appear at paren-depth 0 (for spotting a top-level
/// LIMIT / TOP / FETCH / ROWNUM / OFFSET regardless of subqueries).
fn depth0_words(masked: &str) -> Vec<String> {
    let mut depth: i32 = 0;
    let mut words = Vec::new();
    let mut cur = String::new();
    for c in masked.chars() {
        if c.is_alphanumeric() || c == '_' {
            cur.push(c.to_ascii_lowercase());
            continue;
        }
        if !cur.is_empty() {
            if depth == 0 {
                words.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
        match c {
            '(' => depth += 1,
            ')' => depth = (depth - 1).max(0),
            _ => {}
        }
    }
    if !cur.is_empty() && depth == 0 {
        words.push(cur);
    }
    words
}

const READ_LEADERS: &[&str] = &["select", "with", "explain", "show", "describe", "desc", "pragma", "values", "table"];

fn masked_contains_write(masked: &str) -> bool {
    let words = all_words(masked);
    words.iter().any(|w| {
        matches!(
            w.as_str(),
            "insert" | "update" | "delete" | "merge" | "upsert" | "replace" | "truncate" | "create" | "alter" | "drop" | "grant" | "revoke" | "call" | "do" | "copy" | "vacuum" | "analyze"
        )
    })
}

fn all_words(masked: &str) -> Vec<String> {
    masked
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(|w| w.to_ascii_lowercase())
        .collect()
}

/// Classify a single agent statement. More than one statement is always blocked —
/// the MCP contract is one statement at a time.
pub fn classify(sql: &str) -> Access {
    let masked = mask(sql);
    let count = statement_count(&masked);
    if count == 0 {
        return Access::Blocked("empty statement".into());
    }
    if count > 1 {
        return Access::Blocked("one statement at a time".into());
    }
    let lead = leading_word(&masked);
    if lead.is_empty() {
        return Access::Blocked("empty statement".into());
    }
    if !READ_LEADERS.contains(&lead.as_str()) {
        return Access::Write;
    }
    // A read leader that still performs a write:
    //   WITH … (INSERT/UPDATE/DELETE …)      — data-modifying CTE
    //   EXPLAIN ANALYZE <write>              — actually executes
    match lead.as_str() {
        "with" => {
            if masked_contains_write(&masked) {
                Access::Write
            } else {
                Access::Read
            }
        }
        "explain" => {
            let words = all_words(&masked);
            let analyze = words.iter().any(|w| w == "analyze" || w == "analyse");
            // EXPLAIN (ANALYZE) <verb> → the inner verb decides when analyzing.
            if analyze && inner_after_explain_is_write(&masked) {
                Access::Write
            } else {
                Access::Read
            }
        }
        _ => Access::Read,
    }
}

/// After `EXPLAIN [ (options) ] [ANALYZE]`, does the real statement write?
fn inner_after_explain_is_write(masked: &str) -> bool {
    let words = all_words(masked);
    for w in words {
        match w.as_str() {
            "explain" | "analyze" | "analyse" | "verbose" | "costs" | "buffers" | "format" | "json" | "text" | "yaml" | "xml" | "on" | "off" | "true" | "false" | "settings" | "wal" | "timing" | "summary" => continue,
            "select" | "with" | "table" | "values" => return false,
            other => {
                return matches!(
                    other,
                    "insert" | "update" | "delete" | "merge" | "create" | "alter" | "drop" | "call" | "truncate" | "copy"
                )
            }
        }
    }
    false
}

/// Row-capped statements: a plain read that returns a row set and could be huge.
fn is_cappable(masked: &str) -> bool {
    matches!(leading_word(masked).as_str(), "select" | "with" | "values" | "table")
}

/// Whether the statement already sets a top-level row bound (so we leave it alone).
fn already_bounded(masked: &str, system: &str) -> bool {
    let w = depth0_words(masked);
    let has = |k: &str| w.iter().any(|x| x == k);
    match system {
        "mssql" => has("top") || (has("offset") && has("fetch")),
        "oracle" => has("fetch") || has("rownum"),
        _ => has("limit"),
    }
}

/// Wrap a plain read in a capped outer query. No-op for non-read or already-bounded
/// statements, and for reads that aren't row sets (EXPLAIN/SHOW/PRAGMA/DESCRIBE).
pub fn enforce_limit(sql: &str, system: &str, cap: u32) -> String {
    let masked = mask(sql);
    if !is_cappable(&masked) || already_bounded(&masked, system) {
        return sql.to_string();
    }
    let inner = sql.trim().trim_end_matches(';').trim_end();
    match system {
        "mssql" => format!("SELECT TOP {cap} * FROM (\n{inner}\n) AS _mcp"),
        "oracle" => format!("SELECT * FROM (\n{inner}\n) WHERE ROWNUM <= {cap}"),
        _ => format!("SELECT * FROM (\n{inner}\n) AS _mcp LIMIT {cap}"),
    }
}

/// One-line, length-bounded form of a statement for the audit log (whitespace
/// collapsed, never longer than 2000 chars).
pub fn redact(sql: &str) -> String {
    let mut s: String = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > 2000 {
        s = s.chars().take(2000).collect::<String>() + " …";
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_are_read() {
        for sql in [
            "SELECT * FROM t",
            "select id from t where name = 'DELETE everything'",
            "  WITH x AS (SELECT 1) SELECT * FROM x",
            "EXPLAIN SELECT * FROM t",
            "EXPLAIN ANALYZE SELECT * FROM t",
            "SHOW TABLES",
            "DESCRIBE t",
            "PRAGMA table_info(t)",
            "VALUES (1),(2)",
            "TABLE orders",
            "select * from t -- ; drop table t",
        ] {
            assert_eq!(classify(sql), Access::Read, "{sql}");
        }
    }

    #[test]
    fn writes_are_write() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            "update t set a=1",
            "DELETE FROM t",
            "merge into t ...",
            "CREATE TABLE t (id int)",
            "drop table t",
            "TRUNCATE t",
            "GRANT SELECT ON t TO u",
            "CALL do_thing()",
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
            "EXPLAIN ANALYZE INSERT INTO t VALUES (1)",
            "COPY t FROM '/x'",
        ] {
            assert_eq!(classify(sql), Access::Write, "{sql}");
        }
    }

    #[test]
    fn multiple_statements_blocked() {
        assert!(matches!(classify("SELECT 1; SELECT 2"), Access::Blocked(_)));
        assert!(matches!(classify("SELECT 1; DROP TABLE t"), Access::Blocked(_)));
        // a single statement with a trailing semicolon is fine
        assert_eq!(classify("SELECT 1;"), Access::Read);
        // a semicolon inside a string is not a separator
        assert_eq!(classify("SELECT ';' AS a"), Access::Read);
        // empty / comment-only
        assert!(matches!(classify("   "), Access::Blocked(_)));
        assert!(matches!(classify("-- just a comment"), Access::Blocked(_)));
    }

    #[test]
    fn enforce_limit_wraps_only_unbounded_reads() {
        assert_eq!(
            enforce_limit("SELECT * FROM t", "postgres", 1000),
            "SELECT * FROM (\nSELECT * FROM t\n) AS _mcp LIMIT 1000"
        );
        assert_eq!(
            enforce_limit("SELECT * FROM t;", "mysql", 50),
            "SELECT * FROM (\nSELECT * FROM t\n) AS _mcp LIMIT 50"
        );
        assert_eq!(
            enforce_limit("SELECT * FROM t", "mssql", 10),
            "SELECT TOP 10 * FROM (\nSELECT * FROM t\n) AS _mcp"
        );
        assert_eq!(
            enforce_limit("SELECT * FROM t", "oracle", 10),
            "SELECT * FROM (\nSELECT * FROM t\n) WHERE ROWNUM <= 10"
        );
        // already bounded → untouched
        assert_eq!(enforce_limit("SELECT * FROM t LIMIT 5", "postgres", 1000), "SELECT * FROM t LIMIT 5");
        assert_eq!(enforce_limit("SELECT TOP 5 * FROM t", "mssql", 1000), "SELECT TOP 5 * FROM t");
        assert_eq!(
            enforce_limit("SELECT * FROM t FETCH FIRST 5 ROWS ONLY", "oracle", 1000),
            "SELECT * FROM t FETCH FIRST 5 ROWS ONLY"
        );
        // a LIMIT inside a subquery is NOT a top-level bound → still wrap
        assert_eq!(
            enforce_limit("SELECT * FROM (SELECT * FROM t LIMIT 5) x", "postgres", 1000),
            "SELECT * FROM (\nSELECT * FROM (SELECT * FROM t LIMIT 5) x\n) AS _mcp LIMIT 1000"
        );
        // non-row reads are left alone
        assert_eq!(enforce_limit("EXPLAIN SELECT 1", "postgres", 10), "EXPLAIN SELECT 1");
        assert_eq!(enforce_limit("SHOW TABLES", "mysql", 10), "SHOW TABLES");
    }

    #[test]
    fn with_select_is_capped_values_and_table_too() {
        assert!(enforce_limit("WITH x AS (SELECT 1) SELECT * FROM x", "postgres", 10).contains("LIMIT 10"));
        assert!(enforce_limit("VALUES (1),(2)", "postgres", 10).contains("LIMIT 10"));
        assert!(enforce_limit("TABLE orders", "postgres", 10).contains("LIMIT 10"));
    }

    #[test]
    fn redact_collapses_and_caps() {
        assert_eq!(redact("SELECT\n  *\nFROM   t"), "SELECT * FROM t");
        assert!(redact(&"x ".repeat(3000)).chars().count() <= 2002);
    }
}
