//! Index DDL for Generate Scripts — every index of a schema as the statement (or
//! CREATE TABLE clause) that recreates it, read from the engine's own catalog.
//!
//! PostgreSQL, Oracle and DuckDB hand back the exact DDL themselves (the SQL is
//! in their drivers). MySQL/MariaDB, SQL Server and SQLite only expose the parts,
//! so the statements are assembled here — pure, so every option is unit-tested.

use std::collections::HashMap;

use super::types::IndexDdl;

pub const PRIMARY: &str = "primary";
pub const CONSTRAINT: &str = "constraint";
pub const INDEX: &str = "index";
pub const NOTE: &str = "note";

fn bq(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}
fn br(s: &str) -> String {
    format!("[{}]", s.replace(']', "]]"))
}
fn dq(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn mysql_str(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

// ---------------------------------------------------------------- MySQL / MariaDB

/// One row of `information_schema.STATISTICS` (one key part of one index).
#[derive(Debug, Clone, Default)]
pub struct MyStatRow {
    pub table: String,
    pub index: String,
    pub non_unique: bool,
    pub column: Option<String>,
    /// prefix length — `col(10)`
    pub sub_part: Option<u32>,
    /// `A` | `D` | NULL
    pub collation: Option<String>,
    /// BTREE | HASH | FULLTEXT | SPATIAL | VECTOR
    pub index_type: String,
    pub comment: String,
    /// MySQL 8 functional key part
    pub expression: Option<String>,
    /// MySQL 8 `IS_VISIBLE = NO`
    pub invisible: bool,
    /// MariaDB 10.6 `IGNORED = YES`
    pub ignored: bool,
}

/// Index types STATISTICS cannot describe completely (a FULLTEXT parser, VECTOR
/// options): those take their definition verbatim from SHOW CREATE TABLE.
pub fn mysql_needs_exact(index_type: &str) -> bool {
    matches!(index_type.to_ascii_uppercase().as_str(), "FULLTEXT" | "VECTOR")
}

/// The key definitions of a SHOW CREATE TABLE output that need exact text,
/// keyed by index name: `FULLTEXT KEY \`ft\` (\`body\`) /*!50100 WITH PARSER \`ngram\` */`.
pub fn mysql_exact_keys(create_table: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for raw in create_table.lines() {
        let line = raw.trim().trim_end_matches(',').trim_end();
        let upper = line.to_ascii_uppercase();
        let rest = ["FULLTEXT KEY ", "FULLTEXT INDEX ", "VECTOR KEY ", "VECTOR INDEX "]
            .iter()
            .find(|p| upper.starts_with(*p))
            .map(|p| &line[p.len()..]);
        let Some(rest) = rest else { continue };
        if let Some(name) = read_backticked(rest) {
            out.insert(name, line.to_string());
        }
    }
    out
}

fn read_backticked(s: &str) -> Option<String> {
    let mut chars = s.strip_prefix('`')?.chars().peekable();
    let mut name = String::new();
    while let Some(c) = chars.next() {
        if c == '`' {
            if chars.peek() == Some(&'`') {
                chars.next();
                name.push('`');
            } else {
                return Some(name);
            }
        } else {
            name.push(c);
        }
    }
    None
}

/// `exact` = SHOW CREATE TABLE key lines, keyed by (table, index).
pub fn mysql_index_ddl(schema: &str, rows: &[MyStatRow], exact: &HashMap<(String, String), String>) -> Vec<IndexDdl> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let mut j = i;
        while j < rows.len() && rows[j].table == rows[i].table && rows[j].index == rows[i].index {
            j += 1;
        }
        let parts_rows = &rows[i..j];
        let first = &parts_rows[0];
        let target = format!("{}.{}", bq(schema), bq(&first.table));
        let columns: Vec<String> = parts_rows.iter().filter_map(|r| r.column.clone()).collect();
        // STATISTICS reports SUB_PART 32 for a SPATIAL key, which CREATE rejects
        // ("Incorrect prefix key") — a prefix only means something on a plain key.
        let ty_upper = first.index_type.to_ascii_uppercase();
        let prefixable = !matches!(ty_upper.as_str(), "SPATIAL" | "FULLTEXT" | "VECTOR");
        let parts: Vec<String> = parts_rows
            .iter()
            .map(|r| {
                let mut p = match (&r.expression, &r.column) {
                    (Some(e), _) if !e.is_empty() => format!("({e})"),
                    (_, Some(c)) => bq(c),
                    _ => String::new(),
                };
                if let (Some(n), None, true) = (r.sub_part, &r.expression, prefixable) {
                    p.push_str(&format!("({n})"));
                }
                if r.collation.as_deref() == Some("D") {
                    p.push_str(" DESC");
                }
                p
            })
            .collect();
        let list = parts.join(", ");
        if first.index == "PRIMARY" {
            out.push(IndexDdl {
                table: first.table.clone(),
                name: first.index.clone(),
                role: PRIMARY.into(),
                ddl: format!("PRIMARY KEY ({list})"),
                columns,
            });
        } else if let Some(line) = exact.get(&(first.table.clone(), first.index.clone())) {
            out.push(IndexDdl {
                table: first.table.clone(),
                name: first.index.clone(),
                role: INDEX.into(),
                ddl: format!("ALTER TABLE {target} ADD {line}"),
                columns,
            });
        } else {
            let ty = first.index_type.to_ascii_uppercase();
            let kind = match ty.as_str() {
                "FULLTEXT" => "FULLTEXT ",
                "SPATIAL" => "SPATIAL ",
                "VECTOR" => "VECTOR ",
                _ if !first.non_unique => "UNIQUE ",
                _ => "",
            };
            let mut ddl = format!("CREATE {kind}INDEX {} ON {target} ({list})", bq(&first.index));
            if ty == "HASH" {
                ddl.push_str(" USING HASH");
            }
            if !first.comment.is_empty() {
                ddl.push_str(&format!(" COMMENT {}", mysql_str(&first.comment)));
            }
            if first.invisible {
                ddl.push_str(" INVISIBLE");
            }
            if first.ignored {
                ddl.push_str(" IGNORED");
            }
            out.push(IndexDdl {
                table: first.table.clone(),
                name: first.index.clone(),
                role: INDEX.into(),
                ddl,
                columns,
            });
        }
        i = j;
    }
    out
}

// ---------------------------------------------------------------- SQL Server

/// One key/included column of one index (`sys.indexes` + `sys.index_columns`).
#[derive(Debug, Clone, Default)]
pub struct MsIdxRow {
    pub table: String,
    pub index: String,
    pub index_id: i32,
    /// sys.indexes.type: 1 clustered · 2 nonclustered · 3 XML · 4 spatial ·
    /// 5 clustered columnstore · 6 nonclustered columnstore · 7 hash
    pub kind: i32,
    pub unique: bool,
    pub primary: bool,
    pub unique_constraint: bool,
    pub ignore_dup_key: bool,
    pub filter: Option<String>,
    pub column: Option<String>,
    pub descending: bool,
    pub included: bool,
    /// 0 primary XML · 1 secondary XML · 2/3 selective XML
    pub xml_type: Option<i32>,
    /// secondary XML index: the primary XML index it uses + PATH | VALUE | PROPERTY
    pub xml_using: Option<String>,
    pub xml_for: Option<String>,
    /// spatial: GEOMETRY_GRID | GEOMETRY_AUTO_GRID | GEOGRAPHY_GRID | GEOGRAPHY_AUTO_GRID
    pub tessellation: Option<String>,
    pub bbox: Option<[f64; 4]>,
    pub grids: Option<[String; 4]>,
    pub cells_per_object: Option<i32>,
}

fn ms_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

pub fn mssql_index_ddl(schema: &str, rows: &[MsIdxRow]) -> Vec<IndexDdl> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let mut j = i;
        while j < rows.len() && rows[j].table == rows[i].table && rows[j].index_id == rows[i].index_id {
            j += 1;
        }
        let g = &rows[i..j];
        let f = &g[0];
        let target = format!("{}.{}", br(schema), br(&f.table));
        let name = br(&f.index);
        let keys: Vec<&MsIdxRow> = g.iter().filter(|r| !r.included && r.column.is_some()).collect();
        let key_list = keys
            .iter()
            .map(|r| format!("{} {}", br(r.column.as_deref().unwrap_or_default()), if r.descending { "DESC" } else { "ASC" }))
            .collect::<Vec<_>>()
            .join(", ");
        let all_cols = g.iter().filter_map(|r| r.column.as_deref()).map(br).collect::<Vec<_>>().join(", ");
        let include = g
            .iter()
            .filter(|r| r.included)
            .filter_map(|r| r.column.as_deref())
            .map(br)
            .collect::<Vec<_>>()
            .join(", ");
        let columns: Vec<String> = keys.iter().filter_map(|r| r.column.clone()).collect();
        let cluster = if f.kind == 1 { "CLUSTERED" } else { "NONCLUSTERED" };
        let with_dup = if f.ignore_dup_key { " WITH (IGNORE_DUP_KEY = ON)" } else { "" };
        let filter = f.filter.as_deref().filter(|s| !s.is_empty()).map(|s| format!(" WHERE {s}")).unwrap_or_default();
        let item = |role: &str, ddl: String| IndexDdl {
            table: f.table.clone(),
            name: f.index.clone(),
            role: role.into(),
            ddl,
            columns: columns.clone(),
        };
        let note = |why: &str| {
            item(NOTE, format!("-- Index {name} on {target} is {why}; it is not scripted."))
        };
        let entry = match f.kind {
            1 | 2 if f.primary => item(PRIMARY, format!("CONSTRAINT {name} PRIMARY KEY {cluster} ({key_list}){with_dup}")),
            1 | 2 if f.unique_constraint => item(CONSTRAINT, format!("CONSTRAINT {name} UNIQUE {cluster} ({key_list}){with_dup}")),
            1 | 2 => {
                let mut ddl = format!(
                    "CREATE {}{cluster} INDEX {name} ON {target} ({key_list})",
                    if f.unique { "UNIQUE " } else { "" }
                );
                if !include.is_empty() {
                    ddl.push_str(&format!(" INCLUDE ({include})"));
                }
                ddl.push_str(&filter);
                ddl.push_str(with_dup);
                item(INDEX, ddl)
            }
            3 => match f.xml_type {
                Some(0) => item(INDEX, format!("CREATE PRIMARY XML INDEX {name} ON {target} ({all_cols})")),
                Some(1) => match (&f.xml_using, &f.xml_for) {
                    (Some(using), Some(kind)) => item(
                        INDEX,
                        format!("CREATE XML INDEX {name} ON {target} ({all_cols}) USING XML INDEX {} FOR {kind}", br(using)),
                    ),
                    _ => note("a secondary XML index whose primary XML index could not be read"),
                },
                _ => note("a selective XML index"),
            },
            4 => {
                let scheme = f.tessellation.clone().unwrap_or_else(|| "GEOMETRY_AUTO_GRID".into());
                let mut opts = Vec::new();
                if scheme.starts_with("GEOMETRY") {
                    if let Some(b) = f.bbox {
                        opts.push(format!("BOUNDING_BOX = ({}, {}, {}, {})", ms_num(b[0]), ms_num(b[1]), ms_num(b[2]), ms_num(b[3])));
                    }
                }
                if !scheme.contains("AUTO") {
                    if let Some(gr) = &f.grids {
                        opts.push(format!(
                            "GRIDS = (LEVEL_1 = {}, LEVEL_2 = {}, LEVEL_3 = {}, LEVEL_4 = {})",
                            gr[0], gr[1], gr[2], gr[3]
                        ));
                    }
                }
                if let Some(c) = f.cells_per_object {
                    opts.push(format!("CELLS_PER_OBJECT = {c}"));
                }
                let mut ddl = format!("CREATE SPATIAL INDEX {name} ON {target} ({all_cols}) USING {scheme}");
                if !opts.is_empty() {
                    ddl.push_str(&format!(" WITH ({})", opts.join(", ")));
                }
                item(INDEX, ddl)
            }
            5 => item(INDEX, format!("CREATE CLUSTERED COLUMNSTORE INDEX {name} ON {target}")),
            6 => item(INDEX, format!("CREATE NONCLUSTERED COLUMNSTORE INDEX {name} ON {target} ({all_cols}){filter}")),
            7 => note("a HASH index of a memory-optimized table (it is declared inside CREATE TABLE … WITH (MEMORY_OPTIMIZED = ON))"),
            _ => note("of an index type this version cannot script"),
        };
        out.push(entry);
        i = j;
    }
    // key, then UNIQUE constraints, then the indexes in index_id order (clustered
    // first). index_id alone is not stable: CREATE TABLE numbers the key and the
    // constraints in the order it declares them.
    let rank = |r: &str| match r {
        PRIMARY => 0,
        CONSTRAINT => 1,
        _ => 2,
    };
    out.sort_by(|a, b| a.table.cmp(&b.table).then(rank(&a.role).cmp(&rank(&b.role))));
    out
}

// ---------------------------------------------------------------- SQLite

/// One key column of an index (`PRAGMA index_xinfo`, key columns only).
#[derive(Debug, Clone, Default)]
pub struct LiteKeyCol {
    pub name: Option<String>,
    pub desc: bool,
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct LiteIndex {
    pub table: String,
    pub index: String,
    /// `c` CREATE INDEX · `u` UNIQUE constraint · `pk` PRIMARY KEY
    pub origin: String,
    /// `sqlite_master.sql` (NULL for the automatic indexes of constraints)
    pub sql: Option<String>,
    pub cols: Vec<LiteKeyCol>,
}

pub fn sqlite_index_ddl(rows: &[LiteIndex]) -> Vec<IndexDdl> {
    rows.iter()
        .map(|r| {
            let columns: Vec<String> = r.cols.iter().filter_map(|c| c.name.clone()).collect();
            let list = r
                .cols
                .iter()
                .map(|c| {
                    let mut p = dq(c.name.as_deref().unwrap_or_default());
                    if let Some(coll) = c.collation.as_deref().filter(|s| !s.eq_ignore_ascii_case("BINARY")) {
                        p.push_str(&format!(" COLLATE {coll}"));
                    }
                    if c.desc {
                        p.push_str(" DESC");
                    }
                    p
                })
                .collect::<Vec<_>>()
                .join(", ");
            let (role, ddl) = match (r.origin.as_str(), &r.sql) {
                ("pk", _) => (PRIMARY, format!("PRIMARY KEY ({list})")),
                ("u", None) => (CONSTRAINT, format!("UNIQUE ({list})")),
                (_, Some(sql)) => (INDEX, sql.trim().trim_end_matches(';').trim_end().to_string()),
                _ => (NOTE, format!("-- Index {} on {} has no stored definition; it is not scripted.", dq(&r.index), dq(&r.table))),
            };
            IndexDdl { table: r.table.clone(), name: r.index.clone(), role: role.into(), ddl, columns }
        })
        .collect()
}

/// DuckDB stores its CREATE INDEX with a trailing `;`.
pub fn strip_terminator(sql: &str) -> String {
    sql.trim().trim_end_matches(';').trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn my(table: &str, index: &str, col: &str) -> MyStatRow {
        MyStatRow {
            table: table.into(),
            index: index.into(),
            non_unique: true,
            column: Some(col.into()),
            collation: Some("A".into()),
            index_type: "BTREE".into(),
            ..Default::default()
        }
    }

    #[test]
    fn mysql_every_key_part_option_survives() {
        let mut pk1 = my("orders", "PRIMARY", "customer_id");
        pk1.non_unique = false;
        let mut pk2 = my("orders", "PRIMARY", "id");
        pk2.non_unique = false;
        let mut uq = my("orders", "uq_ref", "ref");
        uq.non_unique = false;
        let mut prefix = my("orders", "ix_note", "note");
        prefix.sub_part = Some(20);
        let mut desc = my("orders", "ix_note", "created_at");
        desc.collation = Some("D".into());
        let mut expr = my("orders", "ix_lower", "");
        expr.column = None;
        expr.expression = Some("lower(`ref`)".into());
        let mut hidden = my("orders", "ix_hidden", "total");
        hidden.invisible = true;
        hidden.comment = "it's \\ slow".into();
        let mut geo = my("places", "sp_pos", "pos");
        geo.index_type = "SPATIAL".into();
        geo.sub_part = Some(32); // what MySQL 8.4 / MariaDB 11 report for a SPATIAL key
        let rows = vec![pk1, pk2, uq, prefix, desc, expr, hidden, geo];
        let out = mysql_index_ddl("shop", &rows, &HashMap::new());
        let by = |n: &str| out.iter().find(|d| d.name == n).unwrap();
        assert_eq!(by("PRIMARY").role, PRIMARY);
        assert_eq!(by("PRIMARY").ddl, "PRIMARY KEY (`customer_id`, `id`)");
        assert_eq!(by("PRIMARY").columns, vec!["customer_id", "id"]);
        assert_eq!(by("uq_ref").ddl, "CREATE UNIQUE INDEX `uq_ref` ON `shop`.`orders` (`ref`)");
        assert_eq!(by("ix_note").ddl, "CREATE INDEX `ix_note` ON `shop`.`orders` (`note`(20), `created_at` DESC)");
        assert_eq!(by("ix_lower").ddl, "CREATE INDEX `ix_lower` ON `shop`.`orders` ((lower(`ref`)))");
        assert_eq!(
            by("ix_hidden").ddl,
            "CREATE INDEX `ix_hidden` ON `shop`.`orders` (`total`) COMMENT 'it''s \\\\ slow' INVISIBLE"
        );
        assert_eq!(by("sp_pos").ddl, "CREATE SPATIAL INDEX `sp_pos` ON `shop`.`places` (`pos`)");
    }

    #[test]
    fn mysql_fulltext_uses_the_exact_show_create_line() {
        let ddl = "CREATE TABLE `posts` (\n  `id` int NOT NULL,\n  `body` text,\n  PRIMARY KEY (`id`),\n  FULLTEXT KEY `ft``body` (`body`) /*!50100 WITH PARSER `ngram` */ \n) ENGINE=InnoDB";
        let keys = mysql_exact_keys(ddl);
        assert_eq!(keys.get("ft`body").unwrap(), "FULLTEXT KEY `ft``body` (`body`) /*!50100 WITH PARSER `ngram` */");
        let mut ft = my("posts", "ft`body", "body");
        ft.index_type = "FULLTEXT".into();
        assert!(mysql_needs_exact(&ft.index_type));
        let mut exact = HashMap::new();
        exact.insert(("posts".to_string(), "ft`body".to_string()), keys["ft`body"].clone());
        let out = mysql_index_ddl("app", &[ft.clone()], &exact);
        assert_eq!(out[0].ddl, "ALTER TABLE `app`.`posts` ADD FULLTEXT KEY `ft``body` (`body`) /*!50100 WITH PARSER `ngram` */");
        // without the exact line it still produces a runnable FULLTEXT index
        let out = mysql_index_ddl("app", &[ft], &HashMap::new());
        assert_eq!(out[0].ddl, "CREATE FULLTEXT INDEX `ft``body` ON `app`.`posts` (`body`)");
    }

    fn ms(index: &str, id: i32, kind: i32, col: &str) -> MsIdxRow {
        MsIdxRow { table: "orders".into(), index: index.into(), index_id: id, kind, column: Some(col.into()), ..Default::default() }
    }

    #[test]
    fn mssql_keys_includes_filters_and_constraints() {
        let mut pk = ms("pk_orders", 1, 2, "id");
        pk.primary = true;
        pk.unique = true;
        let mut cl = ms("cx_orders", 2, 1, "created_at");
        cl.descending = true;
        let mut uq = ms("uq_ref", 3, 2, "ref");
        uq.unique_constraint = true;
        uq.unique = true;
        let a = ms("ix_cover", 4, 2, "customer_id");
        let mut inc = ms("ix_cover", 4, 2, "total");
        inc.included = true;
        let mut filtered = ms("ux_open", 5, 2, "ref");
        filtered.unique = true;
        filtered.filter = Some("([status]='open')".into());
        filtered.ignore_dup_key = true;
        let ncci1 = ms("ncci", 6, 6, "total");
        let mut ncci2 = ms("ncci", 6, 6, "qty");
        ncci2.included = true;
        let out = mssql_index_ddl("dbo", &[pk, cl, uq, a, inc, filtered, ncci1, ncci2]);
        let by = |n: &str| out.iter().find(|d| d.name == n).unwrap();
        assert_eq!(by("pk_orders").role, PRIMARY);
        assert_eq!(by("pk_orders").ddl, "CONSTRAINT [pk_orders] PRIMARY KEY NONCLUSTERED ([id] ASC)");
        assert_eq!(by("cx_orders").ddl, "CREATE CLUSTERED INDEX [cx_orders] ON [dbo].[orders] ([created_at] DESC)");
        assert_eq!(by("uq_ref").role, CONSTRAINT);
        assert_eq!(by("uq_ref").ddl, "CONSTRAINT [uq_ref] UNIQUE NONCLUSTERED ([ref] ASC)");
        assert_eq!(
            by("ix_cover").ddl,
            "CREATE NONCLUSTERED INDEX [ix_cover] ON [dbo].[orders] ([customer_id] ASC) INCLUDE ([total])"
        );
        assert_eq!(by("ix_cover").columns, vec!["customer_id"]);
        assert_eq!(
            by("ux_open").ddl,
            "CREATE UNIQUE NONCLUSTERED INDEX [ux_open] ON [dbo].[orders] ([ref] ASC) WHERE ([status]='open') WITH (IGNORE_DUP_KEY = ON)"
        );
        assert_eq!(by("ncci").ddl, "CREATE NONCLUSTERED COLUMNSTORE INDEX [ncci] ON [dbo].[orders] ([total], [qty])");
    }

    #[test]
    fn mssql_xml_spatial_columnstore_and_hash() {
        let mut px = ms("px", 2, 3, "doc");
        px.xml_type = Some(0);
        let mut sx = ms("sx_path", 3, 3, "doc");
        sx.xml_type = Some(1);
        sx.xml_using = Some("px".into());
        sx.xml_for = Some("PATH".into());
        let mut sp = ms("sp_shape", 4, 4, "shape");
        sp.tessellation = Some("GEOMETRY_GRID".into());
        sp.bbox = Some([0.0, 0.0, 500.0, 200.5]);
        sp.grids = Some(["MEDIUM".into(), "MEDIUM".into(), "LOW".into(), "HIGH".into()]);
        sp.cells_per_object = Some(16);
        let mut geo = ms("sp_geo", 5, 4, "loc");
        geo.tessellation = Some("GEOGRAPHY_AUTO_GRID".into());
        geo.cells_per_object = Some(12);
        let cci = ms("cci", 6, 5, "id");
        let hash = ms("hx", 7, 7, "id");
        let out = mssql_index_ddl("s", &[px, sx, sp, geo, cci, hash]);
        let by = |n: &str| out.iter().find(|d| d.name == n).unwrap();
        assert_eq!(by("px").ddl, "CREATE PRIMARY XML INDEX [px] ON [s].[orders] ([doc])");
        assert_eq!(by("sx_path").ddl, "CREATE XML INDEX [sx_path] ON [s].[orders] ([doc]) USING XML INDEX [px] FOR PATH");
        assert_eq!(
            by("sp_shape").ddl,
            "CREATE SPATIAL INDEX [sp_shape] ON [s].[orders] ([shape]) USING GEOMETRY_GRID WITH (BOUNDING_BOX = (0, 0, 500, 200.5), GRIDS = (LEVEL_1 = MEDIUM, LEVEL_2 = MEDIUM, LEVEL_3 = LOW, LEVEL_4 = HIGH), CELLS_PER_OBJECT = 16)"
        );
        assert_eq!(by("sp_geo").ddl, "CREATE SPATIAL INDEX [sp_geo] ON [s].[orders] ([loc]) USING GEOGRAPHY_AUTO_GRID WITH (CELLS_PER_OBJECT = 12)");
        assert_eq!(by("cci").ddl, "CREATE CLUSTERED COLUMNSTORE INDEX [cci] ON [s].[orders]");
        assert_eq!(by("hx").role, NOTE);
        assert!(by("hx").ddl.starts_with("-- "));
    }

    #[test]
    fn sqlite_constraint_indexes_become_clauses() {
        let col = |n: &str, desc: bool, coll: &str| LiteKeyCol { name: Some(n.into()), desc, collation: Some(coll.into()) };
        let rows = vec![
            LiteIndex { table: "t".into(), index: "sqlite_autoindex_t_1".into(), origin: "pk".into(), sql: None, cols: vec![col("a", false, "BINARY"), col("b", true, "BINARY")] },
            LiteIndex { table: "t".into(), index: "sqlite_autoindex_t_2".into(), origin: "u".into(), sql: None, cols: vec![col("email", false, "NOCASE")] },
            LiteIndex { table: "t".into(), index: "ix_t".into(), origin: "c".into(), sql: Some("CREATE INDEX ix_t ON t (lower(email)) WHERE a > 0;".into()), cols: vec![] },
        ];
        let out = sqlite_index_ddl(&rows);
        assert_eq!(out[0].role, PRIMARY);
        assert_eq!(out[0].ddl, "PRIMARY KEY (\"a\", \"b\" DESC)");
        assert_eq!(out[1].role, CONSTRAINT);
        assert_eq!(out[1].ddl, "UNIQUE (\"email\" COLLATE NOCASE)");
        assert_eq!(out[2].ddl, "CREATE INDEX ix_t ON t (lower(email)) WHERE a > 0");
        assert_eq!(strip_terminator("CREATE INDEX i ON t(a); "), "CREATE INDEX i ON t(a)");
    }
}
