//! Generate Scripts carries every index of a table — proven on real engines.
//!
//! For each engine: build tables holding every kind of index the engine has, read
//! the index DDL the app reads (`index_ddl`), DROP the tables, recreate them the
//! way the generated script does (columns + the PRIMARY KEY / UNIQUE clauses in
//! CREATE TABLE, then the index statements, then the foreign keys), and read the
//! index DDL again: it must be IDENTICAL — same indexes, same names, same text.
//!
//! Run: `cargo test --test index_ddl_integration -- --test-threads=1` (Docker for
//! the server engines; Oracle is `#[ignore]` — needs Oracle Instant Client).

use std::time::{Duration, Instant};

use database_studio_lib::connections::profile::SqliteMode;
use database_studio_lib::drivers::clickhouse::{ChConnParams, ChDriver};
use database_studio_lib::drivers::duckdb::{DuckConnParams, DuckDriver};
use database_studio_lib::drivers::mssql::{MssqlConnParams, MssqlDriver};
use database_studio_lib::drivers::mysql::{MySqlConnParams, MySqlDriver};
use database_studio_lib::drivers::oracle::{OracleConnParams, OracleDriver};
use database_studio_lib::drivers::postgres::{PgConnParams, PgDriver};
use database_studio_lib::drivers::sqlite::{SqliteConnParams, SqliteDriver};
use database_studio_lib::drivers::types::{IndexDdl, StatementOutcome};
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};

const PASS: &str = "test123";
const MSSQL_PASS: &str = "Test123!Pass";

async fn retry<T, F, Fut>(what: &str, mut connect: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, database_studio_lib::error::QueryError>>,
{
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match connect().await {
            Ok(v) => return v,
            Err(e) => {
                assert!(Instant::now() < deadline, "{what}: not ready after 300s — {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

/// One table as the script recreates it: `CREATE TABLE <head> (<columns>, <PK>, <UNIQUE…>)`.
struct Table<'a> {
    name: &'a str,
    head: &'a str,
    columns: &'a str,
}

/// The statements a generated script runs, in its order: every CREATE TABLE (with
/// its key clauses), then every index, then the foreign keys.
fn script(tables: &[Table], ddl: &[IndexDdl], fks: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for t in tables {
        let mut lines = vec![t.columns.to_string()];
        for d in ddl.iter().filter(|d| d.table == t.name && d.role == "primary") {
            lines.push(d.ddl.clone());
        }
        for d in ddl.iter().filter(|d| d.table == t.name && d.role == "constraint") {
            lines.push(d.ddl.clone());
        }
        out.push(format!("CREATE TABLE {} (\n  {}\n)", t.head, lines.join(",\n  ")));
    }
    for t in tables {
        for d in ddl.iter().filter(|d| d.table == t.name && d.role == "index") {
            out.push(d.ddl.clone());
        }
    }
    out.extend(fks.iter().map(|s| s.to_string()));
    out
}

fn roles(ddl: &[IndexDdl], table: &str) -> Vec<(String, String)> {
    ddl.iter().filter(|d| d.table == table).map(|d| (d.name.clone(), d.role.clone())).collect()
}

fn show(ddl: &[IndexDdl]) -> String {
    ddl.iter().map(|d| format!("  [{}] {} {}: {}", d.role, d.table, d.name, d.ddl)).collect::<Vec<_>>().join("\n")
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pg_every_index_survives_generate_scripts() {
    let c = GenericImage::new("postgres", "16-alpine")
        .with_exposed_port(5432.tcp())
        .with_env_var("POSTGRES_PASSWORD", PASS)
        .with_env_var("POSTGRES_DB", "testdb")
        .start()
        .await
        .expect("start postgres (Docker must be running)");
    let port = c.get_host_port_ipv4(5432).await.unwrap();
    let params = PgConnParams {
        host: "localhost".into(),
        port,
        database: "testdb".into(),
        user: "postgres".into(),
        password: PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    };
    let mut d = retry("postgres", || PgDriver::connect(&params)).await;
    let cols = "id int NOT NULL, sku text NOT NULL, qty int, note text, doc jsonb, period tsrange, created timestamptz, code text";
    let run = |sql: &'static str| sql;
    for sql in [
        run("CREATE SCHEMA app"),
        // a name that needs quotes, a key over two columns with INCLUDE, UNIQUE NULLS
        // NOT DISTINCT, an EXCLUDE constraint
        run("CREATE TABLE app.\"Order Items\" (id int NOT NULL, sku text NOT NULL, qty int, note text, doc jsonb, period tsrange, created timestamptz, code text,
               CONSTRAINT \"OI_pk\" PRIMARY KEY (id, sku) INCLUDE (qty),
               CONSTRAINT oi_code_key UNIQUE NULLS NOT DISTINCT (code),
               CONSTRAINT oi_no_overlap EXCLUDE USING gist (period WITH &&))"),
        run("CREATE INDEX \"OI_Lower\" ON app.\"Order Items\" (lower(note) text_pattern_ops) WHERE qty > 0"),
        run("CREATE INDEX oi_created ON app.\"Order Items\" (created DESC NULLS LAST, qty)"),
        run("CREATE INDEX oi_doc ON app.\"Order Items\" USING gin (doc jsonb_path_ops)"),
        run("CREATE INDEX oi_hash ON app.\"Order Items\" USING hash (sku)"),
        run("CREATE INDEX oi_brin ON app.\"Order Items\" USING brin (created) WITH (pages_per_range = 16)"),
        run("CREATE UNIQUE INDEX oi_note_c ON app.\"Order Items\" (note COLLATE \"C\") WHERE note IS NOT NULL"),
        run("CREATE INDEX oi_cover ON app.\"Order Items\" (qty) INCLUDE (note) WITH (fillfactor = 70)"),
        // a foreign key that needs the UNIQUE constraint of its target
        run("CREATE TABLE app.notes (id int PRIMARY KEY, code text REFERENCES app.\"Order Items\" (code))"),
        run("CREATE TABLE app.plain (a int)"),
    ] {
        d.exec(sql).await.unwrap_or_else(|e| panic!("setup [{sql}]: {}", e.message));
    }

    let before = d.index_ddl("app").await.expect("index_ddl");
    eprintln!("PG index DDL:\n{}", show(&before));
    let mut oi = roles(&before, "Order Items");
    assert_eq!(oi[0], ("OI_pk".to_string(), "primary".to_string()), "the key first");
    oi.sort();
    assert_eq!(
        oi,
        vec![
            ("OI_Lower".to_string(), "index".to_string()),
            ("OI_pk".into(), "primary".into()),
            ("oi_brin".into(), "index".into()),
            ("oi_code_key".into(), "constraint".into()),
            ("oi_cover".into(), "index".into()),
            ("oi_created".into(), "index".into()),
            ("oi_doc".into(), "index".into()),
            ("oi_hash".into(), "index".into()),
            ("oi_no_overlap".into(), "constraint".into()),
            ("oi_note_c".into(), "index".into()),
        ],
        "every index of the table"
    );
    assert_eq!(roles(&before, "notes"), vec![("notes_pkey".to_string(), "primary".to_string())]);
    assert!(roles(&before, "plain").is_empty());
    let pk = &before[0];
    assert_eq!(pk.columns, vec!["id", "sku", "qty"], "key columns read (INCLUDE listed too)");

    d.exec("DROP TABLE app.notes, app.\"Order Items\"").await.unwrap();
    let tables = [
        Table { name: "Order Items", head: "app.\"Order Items\"", columns: cols },
        Table { name: "notes", head: "app.notes", columns: "id int NOT NULL, code text" },
    ];
    for sql in script(&tables, &before, &["ALTER TABLE app.notes ADD CONSTRAINT notes_code_fkey FOREIGN KEY (code) REFERENCES app.\"Order Items\" (code)"]) {
        d.exec(&sql).await.unwrap_or_else(|e| panic!("generated statement failed:\n{sql}\n→ {}", e.message));
    }
    let after = d.index_ddl("app").await.unwrap();
    assert_eq!(after, before, "recreated indexes identical:\n{}", show(&after));

    // An index of a partitioned table reads `ON ONLY`; the script recreates the
    // tables as plain tables, where that statement must still run.
    for sql in [
        "CREATE TABLE app.parted (a int, b int) PARTITION BY RANGE (a)",
        "CREATE TABLE app.parted_1 PARTITION OF app.parted FOR VALUES FROM (0) TO (10)",
        "CREATE INDEX parted_b ON app.parted (b)",
    ] {
        d.exec(sql).await.unwrap();
    }
    let parted: Vec<IndexDdl> = d.index_ddl("app").await.unwrap().into_iter().filter(|x| x.table.starts_with("parted")).collect();
    assert_eq!(parted.len(), 2, "parent + partition index:\n{}", show(&parted));
    assert!(parted.iter().any(|x| x.ddl.contains("ON ONLY app.parted ")), "{}", show(&parted));
    d.exec("DROP TABLE app.parted").await.unwrap();
    d.exec("CREATE TABLE app.parted (a int, b int)").await.unwrap();
    d.exec("CREATE TABLE app.parted_1 (a int, b int)").await.unwrap();
    for x in &parted {
        d.exec(&x.ddl).await.unwrap_or_else(|e| panic!("{} → {}", x.ddl, e.message));
    }
    eprintln!("CHK pg_every_index_survives_generate_scripts OK");
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB
// ---------------------------------------------------------------------------

async fn mysql_conn(image: &str, tag: &str, env: &str, system: &'static str) -> (testcontainers::ContainerAsync<GenericImage>, MySqlDriver) {
    let c = GenericImage::new(image, tag)
        .with_exposed_port(3306.tcp())
        .with_env_var(format!("{env}_ROOT_PASSWORD"), PASS)
        .with_env_var(format!("{env}_DATABASE"), "app")
        .start()
        .await
        .unwrap_or_else(|e| panic!("start {system}: {e}"));
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    let params = MySqlConnParams {
        host: "localhost".into(),
        port,
        database: "app".into(),
        user: "root".into(),
        password: PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    };
    let d = retry(system, || MySqlDriver::connect(&params, system)).await;
    (c, d)
}

async fn mysql_like(d: &mut MySqlDriver, system: &str, orders: &str, orders_cols: &str, expect: Vec<(&str, &str)>) {
    for sql in [
        orders,
        // a foreign key over two columns: MySQL backs it with an index of its own
        "CREATE TABLE app.lines (id int NOT NULL PRIMARY KEY, order_customer int, order_id int,
           CONSTRAINT fk_lines_order FOREIGN KEY (order_customer, order_id) REFERENCES app.orders (customer_id, id))",
        "CREATE TABLE app.plain (a int)",
    ] {
        d.exec(sql).await.unwrap_or_else(|e| panic!("{system} setup [{sql}]: {}", e.message));
    }
    let before = d.index_ddl("app").await.expect("index_ddl");
    eprintln!("{system} index DDL:\n{}", show(&before));
    let want: Vec<(String, String)> = expect.into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    assert_eq!(roles(&before, "orders"), want, "{system}: every index of orders");
    assert_eq!(
        roles(&before, "lines"),
        vec![("PRIMARY".to_string(), "primary".to_string()), ("fk_lines_order".to_string(), "index".to_string())]
    );
    assert!(roles(&before, "plain").is_empty());

    d.exec("DROP TABLE app.lines, app.orders").await.unwrap();
    let tables = [
        Table { name: "orders", head: "app.orders", columns: orders_cols },
        Table { name: "lines", head: "app.lines", columns: "id int NOT NULL, order_customer int, order_id int" },
    ];
    let fk = "ALTER TABLE app.lines ADD CONSTRAINT fk_lines_order FOREIGN KEY (order_customer, order_id) REFERENCES app.orders (customer_id, id)";
    for sql in script(&tables, &before, &[fk]) {
        d.exec(&sql).await.unwrap_or_else(|e| panic!("{system}: generated statement failed:\n{sql}\n→ {}", e.message));
    }
    let after = d.index_ddl("app").await.unwrap();
    assert_eq!(after, before, "{system}: recreated indexes identical:\n{}", show(&after));
}

#[tokio::test]
async fn mysql_every_index_survives_generate_scripts() {
    let (_c, mut d) = mysql_conn("mysql", "8.4", "MYSQL", "mysql").await;
    let cols = "customer_id int NOT NULL, id int NOT NULL, ref varchar(40) NOT NULL, note varchar(200), total decimal(10,2), created_at datetime, body text, pos POINT NOT NULL SRID 0";
    let orders = "CREATE TABLE app.orders (customer_id int NOT NULL, id int NOT NULL, ref varchar(40) NOT NULL, note varchar(200), total decimal(10,2), created_at datetime, body text, pos POINT NOT NULL SRID 0,
          PRIMARY KEY (customer_id, id),
          UNIQUE KEY uq_ref (ref),
          KEY ix_note (note(20), created_at DESC),
          KEY ix_lower ((lower(ref))),
          KEY ix_hidden (total) COMMENT 'it''s slow' INVISIBLE,
          FULLTEXT KEY ft_body (body) WITH PARSER ngram,
          SPATIAL KEY sp_pos (pos)) ENGINE=InnoDB";
    mysql_like(
        &mut d,
        "mysql",
        orders,
        cols,
        vec![
            ("PRIMARY", "primary"),
            ("ft_body", "index"),
            ("ix_hidden", "index"),
            ("ix_lower", "index"),
            ("ix_note", "index"),
            ("sp_pos", "index"),
            ("uq_ref", "index"),
        ],
    )
    .await;
    let ddl = d.index_ddl("app").await.unwrap();
    let by = |n: &str| ddl.iter().find(|x| x.name == n).unwrap().ddl.clone();
    assert!(by("ft_body").contains("WITH PARSER `ngram`"), "the parser is kept: {}", by("ft_body"));
    assert!(by("ix_hidden").ends_with("INVISIBLE"), "{}", by("ix_hidden"));
    eprintln!("CHK mysql_every_index_survives_generate_scripts OK");
}

#[tokio::test]
async fn mariadb_every_index_survives_generate_scripts() {
    let (_c, mut d) = mysql_conn("mariadb", "11.4", "MARIADB", "mariadb").await;
    let cols = "customer_id int NOT NULL, id int NOT NULL, ref varchar(40) NOT NULL, note varchar(200), total decimal(10,2), created_at datetime, body text, pos POINT NOT NULL";
    let orders = "CREATE TABLE app.orders (customer_id int NOT NULL, id int NOT NULL, ref varchar(40) NOT NULL, note varchar(200), total decimal(10,2), created_at datetime, body text, pos POINT NOT NULL,
          PRIMARY KEY (customer_id, id),
          UNIQUE KEY uq_ref (ref),
          UNIQUE KEY uq_body (body) USING HASH,
          KEY ix_note (note(20), created_at DESC),
          KEY ix_ignored (total) COMMENT 'kept for later' IGNORED,
          FULLTEXT KEY ft_body (body),
          SPATIAL KEY sp_pos (pos)) ENGINE=InnoDB";
    mysql_like(
        &mut d,
        "mariadb",
        orders,
        cols,
        vec![
            ("PRIMARY", "primary"),
            ("ft_body", "index"),
            ("ix_ignored", "index"),
            ("ix_note", "index"),
            ("sp_pos", "index"),
            ("uq_body", "index"),
            ("uq_ref", "index"),
        ],
    )
    .await;
    eprintln!("CHK mariadb_every_index_survives_generate_scripts OK");
}

// ---------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mssql_every_index_survives_generate_scripts() {
    let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
        .with_exposed_port(1433.tcp())
        .with_env_var("ACCEPT_EULA", "Y")
        .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
        .start()
        .await
        .expect("start mssql");
    let port = c.get_host_port_ipv4(1433).await.unwrap();
    let params = MssqlConnParams {
        host: "localhost".into(),
        port,
        database: "".into(),
        user: "sa".into(),
        password: MSSQL_PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        auth: "sql".into(),
    };
    let mut d = retry("mssql", || MssqlDriver::connect(&params)).await;
    let orders_cols = "id int NOT NULL, created_at datetime2 NULL, ref nvarchar(40) NULL, status nvarchar(10) NULL, total money NULL, customer_id int NULL";
    let docs_cols = "id int NOT NULL, doc xml NULL, shape geometry NULL, loc geography NULL";
    for sql in [
        "CREATE SCHEMA app",
        // nonclustered key + a separate clustered index; a UNIQUE constraint
        "CREATE TABLE app.orders (id int NOT NULL, created_at datetime2 NULL, ref nvarchar(40) NULL, status nvarchar(10) NULL, total money NULL, customer_id int NULL,
           CONSTRAINT pk_orders PRIMARY KEY NONCLUSTERED (id),
           CONSTRAINT uq_orders_ref UNIQUE NONCLUSTERED (ref) WITH (IGNORE_DUP_KEY = ON))",
        "CREATE CLUSTERED INDEX cx_orders_created ON app.orders (created_at DESC)",
        "CREATE NONCLUSTERED INDEX ix_orders_cover ON app.orders (customer_id ASC, status DESC) INCLUDE (total)",
        "CREATE UNIQUE NONCLUSTERED INDEX ux_orders_open ON app.orders (ref) WHERE (status = N'open')",
        "CREATE NONCLUSTERED COLUMNSTORE INDEX ncci_orders ON app.orders (total, customer_id)",
        // XML and spatial indexes need a clustered primary key (unnamed here)
        "CREATE TABLE app.docs (id int NOT NULL PRIMARY KEY CLUSTERED, doc xml NULL, shape geometry NULL, loc geography NULL)",
        "CREATE PRIMARY XML INDEX px_docs ON app.docs (doc)",
        "CREATE XML INDEX sx_docs_path ON app.docs (doc) USING XML INDEX px_docs FOR PATH",
        "CREATE SPATIAL INDEX sp_docs_shape ON app.docs (shape) USING GEOMETRY_GRID WITH (BOUNDING_BOX = (0, 0, 500, 200), GRIDS = (LEVEL_1 = MEDIUM, LEVEL_2 = LOW, LEVEL_3 = HIGH, LEVEL_4 = MEDIUM), CELLS_PER_OBJECT = 16)",
        "CREATE SPATIAL INDEX sp_docs_loc ON app.docs (loc) USING GEOGRAPHY_AUTO_GRID",
        "CREATE TABLE app.facts (id int NOT NULL, amount int NULL)",
        "CREATE CLUSTERED COLUMNSTORE INDEX cci_facts ON app.facts",
        "CREATE TABLE app.plain (a int)",
    ] {
        d.exec(sql).await.unwrap_or_else(|e| panic!("mssql setup [{sql}]: {}", e.message));
    }
    let before = d.index_ddl("app").await.expect("index_ddl");
    eprintln!("MSSQL index DDL:\n{}", show(&before));
    assert_eq!(
        roles(&before, "orders"),
        vec![
            ("pk_orders".to_string(), "primary".to_string()),
            ("uq_orders_ref".to_string(), "constraint".to_string()),
            ("cx_orders_created".to_string(), "index".to_string()),
            ("ix_orders_cover".to_string(), "index".to_string()),
            ("ux_orders_open".to_string(), "index".to_string()),
            ("ncci_orders".to_string(), "index".to_string()),
        ]
    );
    let docs: Vec<(String, String)> = roles(&before, "docs");
    assert_eq!(docs.len(), 5, "{docs:?}");
    assert_eq!(docs[0].1, "primary", "the unnamed clustered key, under its system name");
    assert_eq!(roles(&before, "facts"), vec![("cci_facts".to_string(), "index".to_string())]);
    assert!(roles(&before, "plain").is_empty());
    assert!(before.iter().all(|x| x.role != "note"), "nothing left unscripted");

    d.exec("DROP TABLE app.orders; DROP TABLE app.docs; DROP TABLE app.facts").await.unwrap();
    let tables = [
        Table { name: "orders", head: "[app].[orders]", columns: orders_cols },
        Table { name: "docs", head: "[app].[docs]", columns: docs_cols },
        Table { name: "facts", head: "[app].[facts]", columns: "id int NOT NULL, amount int NULL" },
    ];
    for sql in script(&tables, &before, &[]) {
        d.exec(&sql).await.unwrap_or_else(|e| panic!("mssql: generated statement failed:\n{sql}\n→ {}", e.message));
    }
    let after = d.index_ddl("app").await.unwrap();
    assert_eq!(after, before, "mssql: recreated indexes identical:\n{}", show(&after));
    eprintln!("CHK mssql_every_index_survives_generate_scripts OK");
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_every_index_survives_generate_scripts() {
    let d = SqliteDriver::connect(&SqliteConnParams { path: String::new(), mode: SqliteMode::InMemory }).await.unwrap();
    for sql in [
        "CREATE TABLE t (a INT, b TEXT, email TEXT, n INT, PRIMARY KEY (a, b DESC), UNIQUE (email COLLATE NOCASE))",
        "CREATE INDEX ix_t_lower ON t (lower(b)) WHERE n > 0",
        "CREATE UNIQUE INDEX ux_t_n ON t (n DESC)",
        "CREATE TABLE r (id INTEGER PRIMARY KEY, v TEXT UNIQUE)",
        "CREATE TABLE plain (a INT)",
    ] {
        d.exec(sql).await.unwrap_or_else(|e| panic!("sqlite setup [{sql}]: {}", e.message));
    }
    let before = d.index_ddl("main").await.expect("index_ddl");
    eprintln!("SQLite index DDL:\n{}", show(&before));
    let t: Vec<String> = before.iter().filter(|x| x.table == "t").map(|x| x.role.clone()).collect();
    assert_eq!(t, vec!["primary", "constraint", "index", "index"]);
    assert_eq!(roles(&before, "r").iter().map(|x| x.1.as_str()).collect::<Vec<_>>(), vec!["constraint"]);
    let pk = before.iter().find(|x| x.table == "t" && x.role == "primary").unwrap();
    assert_eq!(pk.ddl, "PRIMARY KEY (\"a\", \"b\" DESC)");
    assert!(before.iter().any(|x| x.ddl == "UNIQUE (\"email\" COLLATE NOCASE)"), "{}", show(&before));

    d.exec("DROP TABLE t").await.unwrap();
    d.exec("DROP TABLE r").await.unwrap();
    let tables = [
        Table { name: "t", head: "t", columns: "a INT, b TEXT, email TEXT, n INT" },
        Table { name: "r", head: "r", columns: "id INTEGER PRIMARY KEY, v TEXT" },
    ];
    for sql in script(&tables, &before, &[]) {
        d.exec(&sql).await.unwrap_or_else(|e| panic!("sqlite: generated statement failed:\n{sql}\n→ {}", e.message));
    }
    let after = d.index_ddl("main").await.unwrap();
    assert_eq!(after, before, "sqlite: recreated indexes identical:\n{}", show(&after));
}

// ---------------------------------------------------------------------------
// DuckDB
// ---------------------------------------------------------------------------

#[tokio::test]
async fn duckdb_every_index_survives_generate_scripts() {
    let dir = std::env::temp_dir().join(format!("dbstudio-ixddl-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("ix.duckdb").to_string_lossy().to_string();
    let d = DuckDriver::connect(&DuckConnParams { path, mode: SqliteMode::ReadWrite, database: String::new(), owner: "ixddl".into() })
        .await
        .unwrap();
    for sql in [
        "CREATE SCHEMA sales",
        "CREATE TABLE sales.orders (id INTEGER, region VARCHAR, code VARCHAR, amount DOUBLE, PRIMARY KEY (id, region), UNIQUE (code))",
        "CREATE INDEX ix_amount ON sales.orders (amount)",
        "CREATE INDEX ix_expr ON sales.orders ((amount * 2))",
        "CREATE TABLE sales.plain (a INTEGER)",
    ] {
        d.exec(sql).await.unwrap_or_else(|e| panic!("duckdb setup [{sql}]: {}", e.message));
    }
    let before = d.index_ddl("sales").await.expect("index_ddl");
    eprintln!("DuckDB index DDL:\n{}", show(&before));
    assert_eq!(
        before.iter().filter(|x| x.table == "orders").map(|x| x.role.as_str()).collect::<Vec<_>>(),
        vec!["primary", "constraint", "index", "index"]
    );
    assert!(roles(&before, "plain").is_empty());

    d.exec("DROP TABLE sales.orders").await.unwrap();
    let tables = [Table { name: "orders", head: "\"sales\".\"orders\"", columns: "id INTEGER, region VARCHAR, code VARCHAR, amount DOUBLE" }];
    for sql in script(&tables, &before, &[]) {
        d.exec(&sql).await.unwrap_or_else(|e| panic!("duckdb: generated statement failed:\n{sql}\n→ {}", e.message));
    }
    let after = d.index_ddl("sales").await.unwrap();
    assert_eq!(after, before, "duckdb: recreated indexes identical:\n{}", show(&after));
}

// ---------------------------------------------------------------------------
// ClickHouse — the script uses the server's own CREATE TABLE (SHOW CREATE TABLE),
// which carries the data-skipping indexes and projections.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn clickhouse_table_ddl_keeps_skip_indexes() {
    let c = GenericImage::new("clickhouse/clickhouse-server", "24.8")
        .with_exposed_port(8123.tcp())
        .with_env_var("CLICKHOUSE_PASSWORD", PASS)
        .start()
        .await
        .expect("start clickhouse");
    let port = c.get_host_port_ipv4(8123).await.unwrap();
    let params = ChConnParams { host: "localhost".into(), port, database: "default".into(), user: "default".into(), password: PASS.into(), ssl: false };
    let mut d = retry("clickhouse", || ChDriver::connect(&params)).await;
    d.exec("CREATE DATABASE app").await.unwrap();
    d.exec(
        "CREATE TABLE app.events (id UInt64, user String, ts DateTime, amount Float64,
           INDEX ix_user user TYPE bloom_filter(0.01) GRANULARITY 3,
           INDEX ix_amount amount TYPE minmax GRANULARITY 1,
           PROJECTION by_user (SELECT user, sum(amount) GROUP BY user))
         ENGINE = MergeTree ORDER BY (ts, id)",
    )
    .await
    .unwrap();
    let show_create = |out: StatementOutcome| match out {
        StatementOutcome::Rows { result } => result.rows[0].as_object().unwrap().values().next().unwrap().as_str().unwrap().to_string(),
        _ => panic!("rows expected"),
    };
    // exactly what object_definition runs for a ClickHouse table
    let q = database_studio_lib::commands::schema::definition_query("clickhouse", "table", "app", "events").unwrap();
    let before = show_create(d.exec(&q).await.unwrap());
    assert!(before.contains("INDEX ix_user user TYPE bloom_filter(0.01) GRANULARITY 3"), "{before}");
    assert!(before.contains("INDEX ix_amount amount TYPE minmax GRANULARITY 1"), "{before}");
    assert!(before.contains("PROJECTION by_user"), "{before}");
    d.exec("DROP TABLE app.events SYNC").await.unwrap();
    d.exec(&before).await.unwrap_or_else(|e| panic!("SHOW CREATE output must run:\n{before}\n→ {}", e.message));
    assert_eq!(show_create(d.exec(&q).await.unwrap()), before, "recreated identical");
}

// ---------------------------------------------------------------------------
// Oracle — needs Oracle Instant Client on PATH (ODPI-C)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Oracle Instant Client — run with --ignored"]
async fn oracle_every_index_survives_generate_scripts() {
    let c = GenericImage::new("gvenzl/oracle-free", "23-slim-faststart")
        .with_exposed_port(1521.tcp())
        .with_env_var("ORACLE_PASSWORD", "Oracle123")
        .start()
        .await
        .expect("start oracle");
    let port = c.get_host_port_ipv4(1521).await.unwrap();
    let params = OracleConnParams {
        host: "127.0.0.1".into(),
        port,
        service: "FREEPDB1".into(),
        use_sid: false,
        user: "system".into(),
        password: "Oracle123".into(),
        ssl: false,
        ssl_ca: String::new(),
    };
    let mut d = retry("oracle", || OracleDriver::connect(&params)).await;
    let cols = "id NUMBER NOT NULL, region VARCHAR2(10) NOT NULL, code VARCHAR2(20), note VARCHAR2(100), amount NUMBER, status VARCHAR2(10)";
    for sql in [
        "CREATE USER appix IDENTIFIED BY Appix123",
        "ALTER USER appix QUOTA UNLIMITED ON USERS",
        "CREATE TABLE appix.orders (id NUMBER NOT NULL, region VARCHAR2(10) NOT NULL, code VARCHAR2(20), note VARCHAR2(100), amount NUMBER, status VARCHAR2(10),
           CONSTRAINT orders_pk PRIMARY KEY (id, region),
           CONSTRAINT orders_code_uk UNIQUE (code) DEFERRABLE INITIALLY DEFERRED)",
        "CREATE INDEX appix.ix_upper ON appix.orders (UPPER(note))",
        "CREATE BITMAP INDEX appix.bx_status ON appix.orders (status)",
        "CREATE INDEX appix.ix_rev ON appix.orders (amount) REVERSE",
        "CREATE INDEX appix.ix_desc ON appix.orders (amount DESC, note)",
        "CREATE UNIQUE INDEX appix.ux_note ON appix.orders (note, status)",
        "CREATE TABLE appix.plain (a NUMBER)",
    ] {
        d.exec(sql).await.unwrap_or_else(|e| panic!("oracle setup [{sql}]: {}", e.message));
    }
    let before = d.index_ddl("APPIX").await.expect("index_ddl");
    eprintln!("Oracle index DDL:\n{}", show(&before));
    let orders = roles(&before, "ORDERS");
    assert_eq!(orders.len(), 7, "{orders:?}");
    assert_eq!(orders[0], ("ORDERS_PK".to_string(), "primary".to_string()));
    assert_eq!(orders[1], ("ORDERS_CODE_UK".to_string(), "constraint".to_string()));
    assert!(before.iter().all(|x| !x.ddl.contains("TABLESPACE") && !x.ddl.contains("STORAGE(")), "no storage clauses:\n{}", show(&before));
    assert!(roles(&before, "PLAIN").is_empty());

    d.exec("DROP TABLE appix.orders").await.unwrap();
    let tables = [Table { name: "ORDERS", head: "appix.orders", columns: cols }];
    for sql in script(&tables, &before, &[]) {
        d.exec(&sql).await.unwrap_or_else(|e| panic!("oracle: generated statement failed:\n{sql}\n→ {}", e.message));
    }
    let after = d.index_ddl("APPIX").await.unwrap();
    assert_eq!(after, before, "oracle: recreated indexes identical:\n{}", show(&after));
    let _ = d.exec("DROP USER appix CASCADE").await;
    eprintln!("CHK oracle_every_index_survives_generate_scripts OK");
}
