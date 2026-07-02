//! Phase-1 driver integration tests. Relational tests expect the local test
//! containers (see docker run commands in the phase log): PG :5432, MySQL
//! :3306, MariaDB :3307, MSSQL :1433. Tests skip (not fail) when the server
//! is unreachable so the suite stays runnable without infra.

use database_studio_lib::drivers::mssql::{MssqlConnParams, MssqlDriver};
use database_studio_lib::drivers::mysql::{MySqlConnParams, MySqlDriver};
use database_studio_lib::drivers::postgres::{PgConnParams, PgDriver};
use database_studio_lib::drivers::sqlite::{SqliteConnParams, SqliteDriver};
use database_studio_lib::drivers::types::StatementOutcome;
use database_studio_lib::connections::profile::SqliteMode;

fn pg_params() -> PgConnParams {
    PgConnParams {
        host: "localhost".into(),
        port: 5432,
        database: "testdb".into(),
        user: "postgres".into(),
        password: "test123".into(),
        ssl: false,
    }
}

fn mysql_params(port: u16) -> MySqlConnParams {
    MySqlConnParams {
        host: "localhost".into(),
        port,
        database: "testdb".into(),
        user: "root".into(),
        password: "test123".into(),
        ssl: false,
    }
}

fn mssql_params() -> MssqlConnParams {
    MssqlConnParams {
        host: "localhost".into(),
        port: 1433,
        database: "".into(),
        user: "sa".into(),
        password: "Test123!Pass".into(),
        ssl: false,
        auth: "sql".into(),
    }
}

macro_rules! skip_if_down {
    ($result:expr, $name:literal) => {
        match $result {
            Ok(drv) => drv,
            Err(e) => {
                eprintln!("SKIP {}: server not reachable — {}", $name, e.message);
                return;
            }
        }
    };
}

#[tokio::test]
async fn pg_select_where_and_multi() {
    let mut drv = skip_if_down!(PgDriver::connect(&pg_params()).await, "postgres");

    drv.exec("DROP TABLE IF EXISTS it_orders").await.unwrap();
    drv.exec("CREATE TABLE it_orders (id int PRIMARY KEY, status text)")
        .await
        .unwrap();
    let ins = drv
        .exec("INSERT INTO it_orders VALUES (1,'done'), (2,'open'), (3,'done')")
        .await
        .unwrap();
    assert!(matches!(ins, StatementOutcome::Affected { affected: 3 }));

    // WHERE actually filters
    let out = drv
        .exec("SELECT id FROM it_orders WHERE status = 'done' ORDER BY id")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else {
        panic!("expected rows")
    };
    assert_eq!(result.total, 2);
    assert_eq!(result.rows[0]["id"], serde_json::json!(1));

    // NULL vs empty string distinction survives the wire
    drv.exec("INSERT INTO it_orders VALUES (4, NULL), (5, '')")
        .await
        .unwrap();
    let out = drv
        .exec("SELECT status FROM it_orders WHERE id IN (4,5) ORDER BY id")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else {
        panic!("expected rows")
    };
    assert!(result.rows[0]["status"].is_null());
    assert_eq!(result.rows[1]["status"], serde_json::json!(""));
}

#[tokio::test]
async fn pg_error_has_sqlstate_and_position() {
    let mut drv = skip_if_down!(PgDriver::connect(&pg_params()).await, "postgres");
    let err = drv
        .exec("SELECT * FROM khong_ton_tai_bang")
        .await
        .expect_err("query must fail");
    assert_eq!(err.code.as_deref(), Some("42P01"));
    // PG reports a character position → mapped to line/col within the statement
    let pos = err.position.expect("pg must provide a position");
    assert_eq!(pos.line, 1);
    assert!(pos.col > 1);
    assert!(err.hint.is_some());
    assert!(!err.raw.is_empty());
}

#[tokio::test]
async fn mysql_and_mariadb_roundtrip() {
    for (port, system) in [(3306u16, "mysql"), (3307u16, "mariadb")] {
        let mut drv = match MySqlDriver::connect(&mysql_params(port), if system == "mysql" { "mysql" } else { "mariadb" }).await {
            Ok(d) => d,
            Err(e) => {
                eprintln!("SKIP {system}: {}", e.message);
                continue;
            }
        };
        drv.exec("DROP TABLE IF EXISTS it_users").await.unwrap();
        drv.exec("CREATE TABLE it_users (id int PRIMARY KEY, name varchar(50))")
            .await
            .unwrap();
        drv.exec("INSERT INTO it_users VALUES (1,'an'), (2,'binh')")
            .await
            .unwrap();
        let out = drv
            .exec("SELECT name FROM it_users WHERE id = 2")
            .await
            .unwrap();
        let StatementOutcome::Rows { result } = out else {
            panic!("expected rows")
        };
        assert_eq!(result.rows[0]["name"], serde_json::json!("binh"));

        // error carries the system name (mysql vs mariadb identity preserved)
        let err = drv.exec("SELEC * FROM x").await.expect_err("must fail");
        assert_eq!(err.system, system);
        assert!(!err.raw.is_empty());
    }
}

#[tokio::test]
async fn mssql_roundtrip_and_line_error() {
    let mut drv = skip_if_down!(MssqlDriver::connect(&mssql_params()).await, "mssql");
    drv.exec("IF OBJECT_ID('it_t') IS NOT NULL DROP TABLE it_t")
        .await
        .unwrap();
    drv.exec("CREATE TABLE it_t (id int PRIMARY KEY, v nvarchar(50))")
        .await
        .unwrap();
    let ins = drv
        .exec("INSERT INTO it_t VALUES (1, N'xin chào')")
        .await
        .unwrap();
    assert!(matches!(ins, StatementOutcome::Affected { affected: 1 }));
    let out = drv.exec("SELECT TOP 1 v FROM it_t").await.unwrap();
    let StatementOutcome::Rows { result } = out else {
        panic!("expected rows")
    };
    assert_eq!(result.rows[0]["v"], serde_json::json!("xin chào"));

    // MSSQL gives a line number for errors
    let err = drv
        .exec("SELECT 1\nFROM bang_khong_co")
        .await
        .expect_err("must fail");
    assert_eq!(err.code.as_deref(), Some("208"));
    assert!(err.position.is_some());
}

#[tokio::test]
async fn sqlite_file_modes_and_errors() {
    let dir = std::env::temp_dir().join("ds-it-sqlite");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("it.db");
    let _ = std::fs::remove_file(&path);

    // read-write: create + insert + select
    let rw = SqliteDriver::connect(&SqliteConnParams {
        path: path.to_string_lossy().to_string(),
        mode: SqliteMode::ReadWrite,
    })
    .await
    .unwrap();
    rw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        .await
        .unwrap();
    rw.exec("INSERT INTO t (name) VALUES ('a'), ('b')").await.unwrap();
    let out = rw.exec("SELECT * FROM t ORDER BY id").await.unwrap();
    let StatementOutcome::Rows { result } = out else {
        panic!("expected rows")
    };
    assert_eq!(result.total, 2);
    assert_eq!(result.cols[1].0, "name");

    // read-only: writes must fail with a helpful hint
    let ro = SqliteDriver::connect(&SqliteConnParams {
        path: path.to_string_lossy().to_string(),
        mode: SqliteMode::ReadOnly,
    })
    .await
    .unwrap();
    let err = ro
        .exec("INSERT INTO t (name) VALUES ('c')")
        .await
        .expect_err("read-only write must fail");
    assert!(err.hint.unwrap_or_default().contains("Read-Only"));

    // in-memory: independent database
    let mem = SqliteDriver::connect(&SqliteConnParams {
        path: String::new(),
        mode: SqliteMode::InMemory,
    })
    .await
    .unwrap();
    let err = mem.exec("SELECT * FROM t").await.expect_err("no such table in memory db");
    assert!(err.message.contains("no such table"));
}

#[tokio::test]
async fn sqlite_introspection() {
    let mem = SqliteDriver::connect(&SqliteConnParams {
        path: String::new(),
        mode: SqliteMode::InMemory,
    })
    .await
    .unwrap();
    mem.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)").await.unwrap();
    mem.exec(
        "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES parent(id))",
    )
    .await
    .unwrap();

    let schemas = mem.schemas().await.unwrap();
    assert_eq!(schemas[0].name, "main");

    let tables = mem.tables("main").await.unwrap();
    let names: Vec<_> = tables.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"parent") && names.contains(&"child"));

    let cols = mem.columns("main", "child").await.unwrap();
    let pid = cols.iter().find(|c| c.name == "pid").unwrap();
    assert!(pid.is_fk, "FK flag from foreign_key_list");
    assert!(!pid.nullable);
    let id = cols.iter().find(|c| c.name == "id").unwrap();
    assert!(id.is_pk);
}
