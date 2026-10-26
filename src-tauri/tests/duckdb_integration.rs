//! DuckDB — integration tests on the REAL engine (embedded: a temp `.duckdb`
//! file or `:memory:`, no container needed). Everything goes through the same
//! layers the app uses: `LiveConnection` dispatch, the `Registry` (per-tab
//! connections, cancel), the grid statement builders and the definition queries.
//!
//! Run: `cargo test --test duckdb_integration -- --test-threads=1`

use std::sync::Arc;
use std::time::{Duration, Instant};

use database_studio_lib::commands::schema::{definition_query, index_definition_query};
use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
use database_studio_lib::connections::registry::Registry;
use database_studio_lib::drivers::grid::{build_select, FilterCond, GridChange};
use database_studio_lib::drivers::types::{StatementOutcome, SystemType};
use database_studio_lib::drivers::{Endpoint, LiveConnection};
use serde_json::{json, Value};

fn temp_db(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("dbstudio-duck-{}-{}", std::process::id(), name));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(format!("{name}.duckdb")).to_string_lossy().to_string()
}

fn profile(id: &str, path: &str, mode: SqliteMode, database: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.into(),
        name: "duck".into(),
        system: SystemType::Duckdb,
        host: String::new(),
        port: 0,
        database: database.into(),
        user: String::new(),
        password_enc: String::new(),
        group: String::new(),
        env: Environment::Local,
        ssh: SshConfig::default(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
        sqlite_path: path.into(),
        sqlite_mode: mode,
        mssql_auth: String::new(),
        schema_registry_url: String::new(),
        cassandra_dc: String::new(),
        cassandra_consistency: String::new(),
        cassandra_flavor: String::new(),
        admin_url: String::new(),
    }
}

fn ep() -> Endpoint {
    Endpoint { host: String::new(), port: 0 }
}

async fn open(id: &str, path: &str) -> LiveConnection {
    LiveConnection::connect(&profile(id, path, SqliteMode::ReadWrite, ""), &ep(), "")
        .await
        .unwrap_or_else(|e| panic!("open {path}: {}", e.message))
}

async fn rows(c: &mut LiveConnection, sql: &str) -> (Vec<(String, String)>, Vec<Value>) {
    match c.exec(sql).await.unwrap_or_else(|e| panic!("{sql}: {}", e.message)) {
        StatementOutcome::Rows { result } => (result.cols, result.rows),
        other => panic!("{sql}: expected rows, got {other:?}"),
    }
}

async fn run(c: &mut LiveConnection, sql: &str) -> StatementOutcome {
    c.exec(sql).await.unwrap_or_else(|e| panic!("{sql}: {}", e.message))
}

async fn scalar(c: &mut LiveConnection, sql: &str) -> Value {
    let (_, r) = rows(c, sql).await;
    r[0].as_object().unwrap().values().next().unwrap().clone()
}

/// Autocomplete quoting (src/lib/sql/reserved.ts, DuckDB list): DuckDB's
/// `reserved` AND `type_function` keywords break as a bare column reference, its
/// `column_name` / unreserved keywords do not. Checked against the engine's own
/// duckdb_keywords() so the frontend list cannot drift silently.
#[tokio::test]
async fn duckdb_keyword_categories_match_the_quoting_rules() {
    let mut c = LiveConnection::connect(&profile("kw", "", SqliteMode::InMemory, ""), &ep(), "").await.unwrap();
    run(&mut c, "CREATE TABLE kw (\"at\" INTEGER, \"left\" INTEGER, \"between\" INTEGER, \"bigint\" INTEGER, \"type\" INTEGER)").await;
    for w in ["at", "left"] {
        assert!(c.exec(&format!("SELECT {w} FROM kw")).await.is_err(), "{w} must be quoted");
        assert!(c.exec(&format!("SELECT \"{w}\" FROM kw")).await.is_ok());
    }
    for w in ["between", "bigint", "type"] {
        assert!(c.exec(&format!("SELECT {w} FROM kw")).await.is_ok(), "{w} works bare");
    }
    // the frontend list (BY_SYSTEM.duckdb) = reserved + type_function, verbatim
    let (_, r) = rows(
        &mut c,
        "SELECT string_agg(keyword_name, ' ' ORDER BY keyword_name) AS k FROM duckdb_keywords() \
         WHERE keyword_category IN ('reserved', 'type_function')",
    )
    .await;
    let engine: Vec<&str> = r[0]["k"].as_str().unwrap().split(' ').collect();
    let ts = include_str!("../../src/lib/sql/reserved.ts");
    let block = ts.split("BY_SYSTEM.duckdb = [").nth(1).unwrap().split(']').next().unwrap();
    let mut front: Vec<&str> = block.split(',').map(|w| w.trim().trim_matches('\'')).filter(|w| !w.is_empty()).collect();
    front.sort_unstable();
    assert_eq!(front, engine, "src/lib/sql/reserved.ts DuckDB list = duckdb_keywords()");
}

/// Connect + Test, file and in-memory, and every value type decoded to the grid's
/// JSON contract with DuckDB's own type names in the header.
#[tokio::test]
async fn duckdb_connect_types_and_statements() {
    let path = temp_db("types");
    let t = LiveConnection::test(&profile("t", &path, SqliteMode::ReadWrite, ""), &ep(), "").await;
    assert!(t.ok, "test: {:?}", t.error);
    assert!(t.server_version.unwrap_or_default().starts_with("DuckDB v"), "version string");
    assert!(std::path::Path::new(&path).exists(), "a new file is created for a new path");

    let mut c = open("types", &path).await;
    assert!(c.ping().await);

    // DDL → OK (no result set); DML → affected count.
    assert!(matches!(
        run(&mut c, "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')").await,
        StatementOutcome::Ok
    ));
    assert!(matches!(
        run(
            &mut c,
            "CREATE TABLE t (i INTEGER, b BIGINT, h HUGEINT, d DECIMAL(18,3), f DOUBLE, s VARCHAR, ok BOOLEAN, \
             dt DATE, ts TIMESTAMP, tz TIMESTAMPTZ, iv INTERVAL, bl BLOB, u UUID, l INTEGER[], \
             st STRUCT(a INTEGER, b VARCHAR), m MAP(VARCHAR, INTEGER), j JSON, e mood)"
        )
        .await,
        StatementOutcome::Ok
    ));
    let ins = run(
        &mut c,
        "INSERT INTO t VALUES (1, 9007199254740993, 170141183460469231731687303715884105727, 12345.678, 1.5, \
         'Nguyễn', true, DATE '2024-01-02', TIMESTAMP '2024-01-02 03:04:05.5', TIMESTAMPTZ '2024-01-02 03:04:05+00', \
         INTERVAL 14 MONTH + INTERVAL 3 DAY + INTERVAL 4 HOUR, '\\xAB\\x01'::BLOB, \
         '550e8400-e29b-41d4-a716-446655440000', [1, 2, NULL], {'a': 7, 'b': 'x'}, MAP {'k': 1}, '{\"x\": [1, 2]}', 'happy'), \
         (2, NULL, NULL, NULL, 'nan'::DOUBLE, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
    )
    .await;
    assert!(matches!(ins, StatementOutcome::Affected { affected: 2 }), "{ins:?}");

    let (cols, r) = rows(&mut c, "SELECT * FROM t ORDER BY i").await;
    let ty = |n: &str| cols.iter().find(|(c, _)| c == n).unwrap().1.clone();
    assert_eq!(ty("i"), "INTEGER");
    assert_eq!(ty("d"), "DECIMAL(18,3)");
    assert_eq!(ty("tz"), "TIMESTAMP WITH TIME ZONE");
    assert_eq!(ty("l"), "INTEGER[]");
    assert_eq!(ty("st"), "STRUCT(a INTEGER, b VARCHAR)");
    assert_eq!(ty("m"), "MAP(VARCHAR, INTEGER)");
    assert_eq!(ty("u"), "UUID");
    assert_eq!(ty("j"), "JSON");

    let r0 = &r[0];
    assert_eq!(r0["i"], json!(1));
    assert_eq!(r0["b"], json!(9007199254740993i64));
    assert_eq!(r0["h"], json!("170141183460469231731687303715884105727"), "HUGEINT keeps every digit");
    assert_eq!(r0["d"], json!("12345.678"), "DECIMAL keeps every digit");
    assert_eq!(r0["f"], json!(1.5));
    assert_eq!(r0["s"], json!("Nguyễn"));
    assert_eq!(r0["ok"], json!(true));
    assert_eq!(r0["dt"], json!("2024-01-02"));
    assert_eq!(r0["ts"], json!("2024-01-02 03:04:05.5"));
    assert_eq!(r0["tz"], json!("2024-01-02 03:04:05+00"));
    assert_eq!(r0["iv"], json!("1 year 2 months 3 days 04:00:00"));
    assert_eq!(r0["bl"], json!("\\xAB\\x01"));
    assert_eq!(r0["u"], json!("550e8400-e29b-41d4-a716-446655440000"));
    assert_eq!(r0["l"], json!([1, 2, null]));
    assert_eq!(r0["st"], json!({"a": 7, "b": "x"}));
    assert_eq!(r0["m"], json!({"k": 1}));
    assert_eq!(r0["e"], json!("happy"));
    assert_eq!(r[1]["f"], json!("nan"));
    assert_eq!(r[1]["s"], Value::Null);

    // The values the grid shows can be written back: blob escape + interval text.
    let back = scalar(&mut c, "SELECT count(*) FROM t WHERE bl = '\\xAB\\x01'::BLOB AND iv = '1 year 2 months 3 days 04:00:00'::INTERVAL").await;
    assert_eq!(back, json!(1));

    // DuckDB-only syntax runs (FROM-first, SUMMARIZE, PIVOT, EXCLUDE).
    let (_, from_first) = rows(&mut c, "FROM t SELECT i WHERE i = 2").await;
    assert_eq!(from_first.len(), 1);
    // (SUMMARIZE over `t` itself fails inside DuckDB — STDDEV of a NaN is "out of
    // range" — so it runs on clean numbers; the engine error is surfaced as-is.)
    run(&mut c, "CREATE TABLE nums AS SELECT range AS n, range * 1.5 AS x FROM range(10)").await;
    let (scols, srows) = rows(&mut c, "SUMMARIZE nums").await;
    assert!(scols.iter().any(|(n, _)| n == "column_name") && srows.len() == 2);
    let (ecols, _) = rows(&mut c, "SELECT * EXCLUDE (bl, j) FROM t").await;
    assert_eq!(ecols.len(), 16);

    // An empty result still reports its columns (Open Data on an empty table).
    let (empty_cols, empty_rows) = rows(&mut c, "SELECT i, s FROM t WHERE false").await;
    assert_eq!(empty_cols.len(), 2);
    assert!(empty_rows.is_empty());

    // UPDATE … RETURNING reads rows; a plain UPDATE reports the count.
    let (_, ret) = rows(&mut c, "UPDATE t SET s = 'x' WHERE i = 2 RETURNING i").await;
    assert_eq!(ret, vec![json!({"i": 2})]);
    assert!(matches!(run(&mut c, "DELETE FROM t WHERE i = 99").await, StatementOutcome::Affected { affected: 0 }));

    // Errors: parser error with the caret's position; catalog error typed.
    // DuckDB reads `FORM` as an alias and fails at `t` — its own caret (and so the
    // position the editor marks) is column 15.
    let e = c.exec("SELECT * FORM t").await.unwrap_err();
    assert_eq!(e.code.as_deref(), Some("Parser"), "{e:?}");
    let p = e.position.expect("parser error carries a position");
    assert_eq!((p.line, p.col), (1, 15), "{}", e.raw);
    assert!(!e.message.contains("LINE 1"), "excerpt stripped from the message");
    let e = c.exec("SELECT * FROM missing_table").await.unwrap_err();
    assert_eq!(e.code.as_deref(), Some("Catalog"), "{e:?}");
    assert!(e.hint.is_some());

    // In-memory database works too.
    let mut mem = LiveConnection::connect(&profile("mem-a", "", SqliteMode::InMemory, ""), &ep(), "").await.unwrap();
    assert_eq!(scalar(&mut mem, "SELECT 40 + 2 AS n").await, json!(42));
    eprintln!("CHK duckdb_connect_types_and_statements OK");
}

/// Explorer introspection on a real catalog: schemas, tables/views, columns with
/// PK/FK/auto-increment, indexes (constraint-backed + CREATE INDEX), constraints,
/// macros, sequences, FKs, the function catalog, attached databases, and the
/// definitions behind Show Definition / Alter.
#[tokio::test]
async fn duckdb_introspection_and_definitions() {
    let path = temp_db("intro");
    let lake = temp_db("lake");
    let mut c = open("intro", &path).await;
    for sql in [
        "CREATE SCHEMA staging",
        "CREATE SEQUENCE user_id_seq START 1",
        "CREATE TABLE users (id INTEGER PRIMARY KEY DEFAULT nextval('user_id_seq'), email VARCHAR UNIQUE, name VARCHAR NOT NULL)",
        "CREATE TABLE events (id BIGINT PRIMARY KEY, user_id INTEGER REFERENCES users(id), kind VARCHAR CHECK (kind <> ''), ts TIMESTAMP)",
        "CREATE INDEX events_kind_at ON events (kind, ts)",
        "CREATE VIEW recent AS SELECT * FROM events WHERE ts > TIMESTAMP '2024-01-01'",
        "CREATE MACRO add_tax(amount, rate := 0.1) AS amount * (1 + rate)",
        "CREATE MACRO top_users(n) AS TABLE SELECT * FROM users LIMIT n",
        "CREATE TABLE staging.raw (payload JSON)",
    ] {
        run(&mut c, sql).await;
    }
    run(&mut c, &format!("ATTACH '{lake}' AS lake")).await;
    run(&mut c, "CREATE TABLE lake.main.trips (id INTEGER)").await;

    let dbs = c.databases().await.unwrap();
    let names: Vec<_> = dbs.iter().map(|d| (d.name.as_str(), d.current)).collect();
    assert_eq!(names, vec![("intro", true), ("lake", false)], "the file + the ATTACHed database");

    let schemas = c.schemas().await.unwrap();
    let sn: Vec<_> = schemas.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(sn, vec!["main", "staging"]);
    assert!(schemas[0].is_default);

    let tables = c.tables("main").await.unwrap();
    let tn: Vec<_> = tables.iter().map(|t| (t.name.as_str(), t.kind.as_str())).collect();
    assert_eq!(tn, vec![("events", "table"), ("recent", "view"), ("users", "table")]);
    assert_eq!(c.tables("staging").await.unwrap()[0].name, "raw");

    let cols = c.columns("main", "users").await.unwrap();
    let id = &cols[0];
    assert!(id.is_pk && id.auto_increment && !id.nullable, "{id:?}");
    assert_eq!(id.data_type, "INTEGER");
    assert!(!cols[2].nullable, "name NOT NULL");
    let ecols = c.columns("main", "events").await.unwrap();
    assert!(ecols.iter().find(|c| c.name == "user_id").unwrap().is_fk);

    let idx = c.indexes("main", "events").await.unwrap();
    assert!(idx.iter().any(|i| i.primary && i.columns == vec!["id".to_string()]), "{idx:?}");
    let ix = idx.iter().find(|i| i.name == "events_kind_at").expect("CREATE INDEX listed");
    assert_eq!(ix.columns, vec!["kind".to_string(), "ts".to_string()]);
    assert!(c.indexes("main", "users").await.unwrap().iter().any(|i| i.unique && i.columns == vec!["email".to_string()]));

    let cons = c.constraints("main", "events").await.unwrap();
    let kinds: Vec<_> = cons.iter().map(|c| c.kind.as_str()).collect();
    for k in ["PK", "FK", "CHECK"] {
        assert!(kinds.contains(&k), "{k} in {kinds:?}");
    }

    let fks = c.foreign_keys("main").await.unwrap();
    assert_eq!(fks.len(), 1);
    assert_eq!(
        (fks[0].from_table.as_str(), fks[0].from_column.as_str(), fks[0].to_table.as_str(), fks[0].to_column.as_str()),
        ("events", "user_id", "users", "id")
    );

    let routines = c.routines("main").await.unwrap();
    let add = routines.iter().find(|r| r.name == "add_tax").expect("scalar macro");
    assert_eq!(add.kind, "function");
    assert_eq!(add.params.iter().map(|p| p.name.as_str()).collect::<Vec<_>>()[0], "amount");
    assert_eq!(routines.iter().find(|r| r.name == "top_users").unwrap().kind, "table_function");
    assert!(c.triggers("main").await.unwrap().is_empty());
    assert_eq!(c.sequences("main").await.unwrap()[0].name, "user_id_seq");

    let fns = c.functions("main").await.unwrap();
    for f in ["read_parquet", "read_json", "list_transform", "strftime", "add_tax"] {
        assert!(fns.iter().any(|x| x.name == f), "function catalog has {f}");
    }
    assert!(fns.iter().all(|f| !f.name.contains('+')), "operators are not functions");

    let scan = c.scan_indexes("main").await.unwrap();
    assert!(scan.indexes.iter().any(|i| i.name == "events_kind_at"));
    assert!(c.partitions("main", "events").await.unwrap().is_empty());

    // Show Definition / Alter: each query returns a statement DuckDB re-runs.
    let def = |kind: &str, name: &str| definition_query("duckdb", kind, "main", name).unwrap();
    for (kind, name) in [("view", "recent"), ("function", "add_tax"), ("function", "top_users"), ("sequence", "user_id_seq")] {
        let v = scalar(&mut c, &def(kind, name)).await;
        let text = v.as_str().unwrap_or_else(|| panic!("{kind} {name}: {v:?}")).to_string();
        assert!(text.to_uppercase().contains("CREATE"), "{text}");
        if kind == "function" {
            // the rebuilt CREATE OR REPLACE MACRO re-runs in place …
            assert!(text.contains("CREATE OR REPLACE MACRO"), "{text}");
            // … and says that parameter defaults are not in the catalog
            assert!(text.starts_with("-- DuckDB does not keep parameter defaults"), "{text}");
            run(&mut c, &text).await;
        }
    }
    // re-run without the default (as the warning says): explicit argument works
    assert_eq!(scalar(&mut c, "SELECT add_tax(100, 0.1)").await, json!("110.0"));
    let ix_def = scalar(&mut c, &index_definition_query("duckdb", "main", "events", "events_kind_at").unwrap()).await;
    assert!(ix_def.as_str().unwrap().contains("CREATE INDEX events_kind_at"), "{ix_def:?}");

    // The Explorer's per-database sub-connection (`{id}::lake` → USE lake) sees the
    // attached database's own catalog — and shares the instance (no lock error).
    let mut sub = LiveConnection::connect(&profile("intro::lake", &path, SqliteMode::ReadWrite, "lake"), &ep(), "")
        .await
        .expect("sub-connection on the same file shares the instance");
    assert_eq!(scalar(&mut sub, "SELECT current_database()").await, json!("lake"));
    let lt = sub.tables("main").await.unwrap();
    assert_eq!(lt.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["trips"]);
    eprintln!("CHK duckdb_introspection_and_definitions OK");
}

/// The Table Viewer + editable grid: parameterised filter/paging, an empty table's
/// headers, and grid changes (typed values written back as text) in a transaction.
#[tokio::test]
async fn duckdb_table_viewer_and_grid_edits() {
    let path = temp_db("grid");
    let mut c = open("grid", &path).await;
    run(&mut c, "CREATE TABLE p (id INTEGER PRIMARY KEY, name VARCHAR, price DECIMAL(10,2), ts TIMESTAMP, u UUID)").await;
    run(&mut c, "CREATE TABLE empty_t (a INTEGER, b VARCHAR)").await;
    run(&mut c, "INSERT INTO p SELECT range, 'item ' || range, range * 1.25, TIMESTAMP '2024-01-01' + INTERVAL (range) DAY, uuid() FROM range(1, 51)").await;

    // filter + sort + page, bound with `?`
    let filters = vec![FilterCond { col: "name".into(), op: "LIKE".into(), value: json!("item 1%") }];
    let sel = build_select("duckdb", &Some("main".into()), "p", &filters, false, &[], 5, 2);
    assert!(sel.sql.contains("\"main\".\"p\"") && sel.sql.contains("LIMIT 5 OFFSET 2"), "{}", sel.sql);
    let StatementOutcome::Rows { result } = c.exec_params(&sel.sql, &sel.params).await.unwrap() else { panic!() };
    assert_eq!(result.rows.len(), 5, "page of the 11 'item 1…' rows");

    // Open Data on an empty table still has its header.
    let sel = build_select("duckdb", &Some("main".into()), "empty_t", &[], false, &[], 100, 0);
    let StatementOutcome::Rows { result } = c.exec_params(&sel.sql, &sel.params).await.unwrap() else { panic!() };
    assert_eq!(result.cols.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);

    let col = |name: &str, value: Value| database_studio_lib::drivers::grid::Col { name: name.into(), value, col_type: None };
    let changes = vec![
        GridChange::Update {
            schema: Some("main".into()),
            table: "p".into(),
            pk: vec![col("id", json!(3))],
            set: vec![col("price", json!("99.95")), col("ts", json!("2030-05-06 07:08:09")), col("name", json!("renamed"))],
        },
        GridChange::Insert {
            schema: Some("main".into()),
            table: "p".into(),
            values: vec![col("id", json!(100)), col("name", json!("new")), col("u", json!("550e8400-e29b-41d4-a716-446655440000"))],
        },
        GridChange::Delete { schema: Some("main".into()), table: "p".into(), pk: vec![col("id", json!(50))] },
    ];
    assert_eq!(c.apply_grid_changes(&changes).await.unwrap(), 3);
    let (_, r) = rows(&mut c, "SELECT price, ts, name FROM p WHERE id = 3").await;
    assert_eq!(r[0], json!({"price": "99.95", "ts": "2030-05-06 07:08:09", "name": "renamed"}));
    assert_eq!(scalar(&mut c, "SELECT u FROM p WHERE id = 100").await, json!("550e8400-e29b-41d4-a716-446655440000"));
    assert_eq!(scalar(&mut c, "SELECT count(*) FROM p WHERE id = 50").await, json!(0));

    // A failing change rolls the whole batch back.
    let bad = vec![
        GridChange::Update { schema: None, table: "p".into(), pk: vec![col("id", json!(4))], set: vec![col("name", json!("kept?"))] },
        GridChange::Insert { schema: None, table: "p".into(), values: vec![col("id", json!(4))] }, // duplicate PK
    ];
    assert!(c.apply_grid_changes(&bad).await.is_err());
    assert_eq!(scalar(&mut c, "SELECT name FROM p WHERE id = 4").await, json!("item 4"), "rolled back");

    // Import "skip duplicates" form.
    assert!(matches!(
        run(&mut c, "INSERT OR IGNORE INTO p (id, name) VALUES (4, 'dup'), (200, 'fresh')").await,
        StatementOutcome::Affected { affected: 1 }
    ));
    eprintln!("CHK duckdb_table_viewer_and_grid_edits OK");
}

/// One database instance per file per process: the Explorer, every Query Editor
/// tab and Test connection share it (a second open of a read-write file would hit
/// DuckDB's lock). In-memory databases are shared per profile — never across.
/// Cancel interrupts a running query for real.
#[tokio::test(flavor = "multi_thread")]
async fn duckdb_shared_instance_tabs_and_cancel() {
    let path = temp_db("shared");
    let registry = Arc::new(Registry::default());
    registry.connect(profile("dk", &path, SqliteMode::ReadWrite, ""), String::new(), String::new()).await.unwrap();
    registry.exec_statement("dk", "CREATE TABLE seen (n INTEGER)".into()).await.unwrap().unwrap();
    registry.exec_statement("dk", "INSERT INTO seen VALUES (1)".into()).await.unwrap().unwrap();

    // per-tab connection on the same file: no lock error, sees the base's table
    registry.connect(profile("dk#tab-1", &path, SqliteMode::ReadWrite, ""), String::new(), String::new()).await
        .expect("a second connection to the same file shares the instance");
    let StatementOutcome::Rows { result } =
        registry.exec_statement("dk#tab-1", "SELECT count(*) AS n FROM seen".into()).await.unwrap().unwrap()
    else {
        panic!()
    };
    assert_eq!(result.rows[0]["n"], json!(1));
    // Test connection while connected also works.
    let t = LiveConnection::test(&profile("dk", &path, SqliteMode::ReadWrite, ""), &ep(), "").await;
    assert!(t.ok, "{:?}", t.error);

    // in-memory: shared by one profile's connections, isolated from another profile
    registry.connect(profile("m1", "", SqliteMode::InMemory, ""), String::new(), String::new()).await.unwrap();
    registry.connect(profile("m1#tab-9", "", SqliteMode::InMemory, ""), String::new(), String::new()).await.unwrap();
    registry.connect(profile("m2", "", SqliteMode::InMemory, ""), String::new(), String::new()).await.unwrap();
    registry.exec_statement("m1", "CREATE TABLE only_m1 AS SELECT 7 AS v".into()).await.unwrap().unwrap();
    assert!(registry.exec_statement("m1#tab-9", "SELECT v FROM only_m1".into()).await.unwrap().is_ok());
    assert!(registry.exec_statement("m2", "SELECT v FROM only_m1".into()).await.unwrap().is_err());

    // Cancel: a long query on the tab connection stops within a second.
    let reg = Arc::clone(&registry);
    let started = Instant::now();
    let long = tokio::spawn(async move {
        reg.exec_statement("dk#tab-1", "SELECT count(*) FROM range(10000000000) a".into()).await
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(registry.cancel("dk#tab-1"), "cancel reports a running statement");
    let res = tokio::time::timeout(Duration::from_secs(5), long).await.expect("caller released").unwrap();
    assert!(res.unwrap().is_err(), "cancelled statement reports an error");
    // the connection heals and is usable again
    tokio::time::sleep(Duration::from_millis(300)).await;
    let ok = registry.exec_statement("dk#tab-1", "SELECT 1 AS n".into()).await.unwrap();
    assert!(ok.is_ok(), "{ok:?}");
    assert!(started.elapsed() < Duration::from_secs(10), "query stopped instead of running to the end");

    registry.disconnect("dk#tab-1").await.unwrap();
    registry.disconnect("dk").await.unwrap();
    // every connection gone → the instance closes and the file lock is released:
    // the file opens again from scratch and keeps its data.
    let mut again = open("dk-again", &path).await;
    assert_eq!(scalar(&mut again, "SELECT count(*) FROM seen").await, json!(1));
    eprintln!("CHK duckdb_shared_instance_tabs_and_cancel OK");
}

/// Statements the frontend generates for DuckDB run on the engine (the TS
/// generators are unit-tested to emit exactly these strings).
#[tokio::test]
async fn duckdb_generated_statements_run() {
    let path = temp_db("gen");
    let other = temp_db("gen_other");
    let mut c = open("gen", &path).await;
    for sql in [
        "CREATE SCHEMA IF NOT EXISTS \"sales\";",                 // genCreateSchema
        "CREATE TABLE \"sales\".\"orders\" (\"id\" INTEGER PRIMARY KEY, \"amount\" DOUBLE)",
        "CREATE INDEX \"ix_amount\" ON \"sales\".\"orders\" (\"amount\");", // genCreateIndex
        "DROP INDEX IF EXISTS \"sales\".\"ix_amount\";",            // genDropIndex
        "TRUNCATE TABLE \"sales\".\"orders\";",                     // genTruncateStatements
        "ALTER TABLE \"sales\".\"orders\"\n  ADD COLUMN \"new_column\" INT;", // genAlterTable
        "CREATE SEQUENCE \"sales\".\"new_sequence\"\n  START WITH 1\n  INCREMENT BY 1;", // createTemplate sequence
        "CREATE OR REPLACE MACRO \"sales\".\"new_function\"(a, b) AS\n  a + b;", // createTemplate function
        "DROP MACRO IF EXISTS \"sales\".\"new_function\";",          // dropObject
        "SET search_path = '\"sales\",main'",                       // schema picker
    ] {
        run(&mut c, sql).await;
    }
    assert_eq!(scalar(&mut c, "SELECT count(*) FROM orders").await, json!(0), "search_path picks the schema");
    // RESTRICT refuses a non-empty schema; CASCADE drops it.
    assert!(c.exec("DROP SCHEMA IF EXISTS \"sales\" RESTRICT;").await.is_err());
    run(&mut c, "DROP SCHEMA IF EXISTS \"sales\" CASCADE;").await;
    // DETACH (the "Detach Database…" statement) keeps the file.
    run(&mut c, &format!("ATTACH '{other}' AS other")).await;
    run(&mut c, "DETACH DATABASE IF EXISTS \"other\";").await;
    assert!(std::path::Path::new(&other).exists());
    eprintln!("CHK duckdb_generated_statements_run OK");
}

/// Backup = a consistent copy into a new .duckdb file; Restore replaces the
/// current contents with it.
#[tokio::test]
async fn duckdb_backup_restore_roundtrip() {
    use database_studio_lib::drivers::duckdb::{DuckConnParams, DuckDriver};
    let path = temp_db("bk");
    let dest = temp_db("bk_copy");
    let drv = DuckDriver::connect(&DuckConnParams {
        path: path.clone(),
        mode: SqliteMode::ReadWrite,
        database: String::new(),
        owner: "bk".into(),
    })
    .await
    .unwrap();
    for sql in [
        "CREATE SCHEMA s2",
        "CREATE SEQUENCE seq1",
        "CREATE TABLE a (id INTEGER PRIMARY KEY, v VARCHAR)",
        "INSERT INTO a VALUES (1, 'one'), (2, 'two')",
        "CREATE TABLE s2.b AS SELECT 5 AS x",
        "CREATE VIEW va AS SELECT v FROM a",
        "CREATE MACRO m1(x) AS x * 2",
    ] {
        drv.exec(sql).await.unwrap();
    }
    drv.backup_to(dest.clone()).await.expect("backup");
    assert!(std::fs::metadata(&dest).unwrap().len() > 0);

    // change everything, then restore
    for sql in ["DROP VIEW va", "DELETE FROM a WHERE id = 1", "CREATE TABLE junk (z INTEGER)", "DROP MACRO m1"] {
        drv.exec(sql).await.unwrap();
    }
    drv.restore_from(dest.clone()).await.expect("restore");
    let count = |sql: &'static str| {
        let d = drv.clone();
        async move {
            match d.exec(sql).await.unwrap() {
                StatementOutcome::Rows { result } => result.rows[0].as_object().unwrap().values().next().unwrap().clone(),
                _ => panic!(),
            }
        }
    };
    assert_eq!(count("SELECT count(*) FROM a").await, json!(2));
    assert_eq!(count("SELECT count(*) FROM va").await, json!(2));
    assert_eq!(count("SELECT x FROM s2.b").await, json!(5));
    assert_eq!(count("SELECT m1(21)").await, json!(42));
    assert!(drv.exec("SELECT * FROM junk").await.is_err(), "objects not in the backup are gone");
    assert!(drv.restore_from(format!("{dest}.missing")).await.is_err());
    eprintln!("CHK duckdb_backup_restore_roundtrip OK");
}

/// DuckDB workspace (Overview · Extensions · Settings · Import file · Export ·
/// Attach · Profile): runs, in order, EXACTLY the statements the frontend
/// builders produce (src/lib/duckdb/sql.ts — duckdb.test pins them to this same
/// fixture), with the expectation written next to each one.
#[tokio::test]
async fn duckdb_workspace_statements_run() {
    let path = temp_db("workspace");
    let dir = std::path::Path::new(&path).parent().unwrap().to_string_lossy().replace('\\', "/");
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/duckdb-statements.json")).expect("fixture json");
    let mut c = open("workspace", &path).await;
    let mut ran = 0;
    for step in fixture["steps"].as_array().unwrap() {
        let key = step["key"].as_str().unwrap();
        let sql = step["sql"].as_str().unwrap().replace("{dir}", &dir);
        assert!(!sql.is_empty(), "{key}: empty statement in the fixture");
        let expect = &step["expect"];
        let out = c.exec(&sql).await;
        ran += 1;
        if let Some(needle) = expect.get("error").and_then(Value::as_str) {
            let err = match out {
                Err(e) => e.message,
                Ok(o) => panic!("{key}: expected an error containing {needle:?}, got {o:?}"),
            };
            assert!(err.to_lowercase().contains(&needle.to_lowercase()), "{key}: error {err:?} lacks {needle:?}");
            continue;
        }
        let out = out.unwrap_or_else(|e| panic!("{key}: {sql}\n  -> {}", e.message));
        if expect.as_str() == Some("ok") {
            continue;
        }
        if let Some(n) = expect.get("affected").and_then(Value::as_u64) {
            match out {
                StatementOutcome::Affected { affected } => assert_eq!(affected, n, "{key}: affected"),
                other => panic!("{key}: expected {n} affected, got {other:?}"),
            }
            continue;
        }
        let rows = match out {
            StatementOutcome::Rows { result } => result.rows,
            other => panic!("{key}: expected rows, got {other:?}"),
        };
        if let Some(n) = expect.get("rows").and_then(Value::as_u64) {
            assert_eq!(rows.len() as u64, n, "{key}: row count ({rows:?})");
        }
        if let Some(n) = expect.get("rows_min").and_then(Value::as_u64) {
            assert!(rows.len() as u64 >= n, "{key}: at least {n} rows, got {}", rows.len());
        }
        if let Some(first) = expect.get("first").and_then(Value::as_object) {
            for (col, want) in first {
                assert_eq!(&rows[0][col], want, "{key}: first row column {col} ({:?})", rows[0]);
            }
        }
    }
    assert!(ran > 50, "ran {ran} steps");

    // Shapes the screens read (column names / value kinds), on the same connection.
    let (cols, r) = rows(&mut c, "SELECT * FROM (SELECT version() AS version, (SELECT platform FROM pragma_platform()) AS platform) t").await;
    assert_eq!(cols.len(), 2);
    assert!(r[0]["version"].as_str().unwrap().starts_with('v'));
    let (cols, r) = rows(&mut c, fixture_sql(&fixture, "databases")).await;
    let names: Vec<&str> = cols.iter().map(|(n, _)| n.as_str()).collect();
    for want in ["name", "path", "type", "readonly", "database_size", "wal_size", "memory_usage", "current"] {
        assert!(names.contains(&want), "databases column {want} in {names:?}");
    }
    assert_eq!(r[0]["current"], json!(true), "the opened file comes first");
    assert_eq!(r[0]["readonly"], json!(false));
    let (_, r) = rows(&mut c, fixture_sql(&fixture, "extensions")).await;
    let json_ext = r.iter().find(|e| e["extension_name"] == json!("json")).expect("json extension listed");
    assert_eq!(json_ext["loaded"], json!(true), "json is bundled and loaded: {json_ext:?}");
    let (_, r) = rows(&mut c, fixture_sql(&fixture, "settings")).await;
    let threads = r.iter().find(|s| s["name"] == json!("threads")).expect("threads setting");
    assert_eq!(threads["input_type"], json!("BIGINT"));
    assert!(threads["scope"].is_string());
    let (_, r) = rows(&mut c, fixture_sql(&fixture, "profile.summarize_table")).await;
    for want in ["column_name", "column_type", "min", "max", "approx_unique", "avg", "std", "q25", "q50", "q75", "count", "null_percentage"] {
        assert!(r[0].get(want).is_some(), "SUMMARIZE column {want}: {:?}", r[0]);
    }
    eprintln!("CHK duckdb_workspace_statements_run OK ({ran} steps)");
}

fn fixture_sql<'a>(fixture: &'a Value, key: &str) -> &'a str {
    fixture["steps"].as_array().unwrap().iter().find(|s| s["key"] == json!(key)).unwrap()["sql"].as_str().unwrap()
}
