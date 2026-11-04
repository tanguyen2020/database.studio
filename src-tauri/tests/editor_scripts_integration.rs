//! The Query Editor's statement splitter, checked on REAL engines.
//!
//! `tests/fixtures/editor-scripts.json` is written by the frontend test
//! `src/lib/sql/editor-scripts.fixture.test.ts` from the splitter itself: every
//! script and the statements the editor sends for it. Here each statement runs one
//! by one — exactly what the editor does — on a container of that engine, then the
//! checks read the result. A wrong cut (a DELETE hidden in a procedure body, a
//! routine chopped at an inner `;`, a backslash read as an escape where it isn't)
//! fails here.
//!
//! Run: `cargo test --test editor_scripts_integration -- --test-threads=1`
//! (needs Docker). Oracle is `#[ignore]` (needs Oracle Instant Client on PATH).

use std::time::{Duration, Instant};

use database_studio_lib::drivers::mssql::{MssqlConnParams, MssqlDriver};
use database_studio_lib::drivers::mysql::{MySqlConnParams, MySqlDriver};
use database_studio_lib::drivers::oracle::{OracleConnParams, OracleDriver};
use database_studio_lib::drivers::postgres::{PgConnParams, PgDriver};
use database_studio_lib::drivers::types::StatementOutcome;
use database_studio_lib::error::QueryError;
use serde_json::Value;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

const PASS: &str = "test123";
const MSSQL_PASS: &str = "Test123!Pass";
const FIXTURE: &str = include_str!("fixtures/editor-scripts.json");

struct Case {
    name: String,
    statements: Vec<String>,
    checks: Vec<(String, String)>,
}

fn cases(system: &str) -> Vec<Case> {
    let v: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let out: Vec<Case> = v["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter(|c| c["system"] == system)
        .map(|c| Case {
            name: c["name"].as_str().unwrap().to_string(),
            statements: c["statements"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect(),
            checks: c["checks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| (k["sql"].as_str().unwrap().to_string(), k["expect"].as_str().unwrap().to_string()))
                .collect(),
        })
        .collect();
    assert!(!out.is_empty(), "no {system} cases in the fixture");
    out
}

/// First cell of the first row, as text.
fn first_cell(out: StatementOutcome, sql: &str) -> String {
    let StatementOutcome::Rows { result } = out else { panic!("{sql}: expected rows, got {out:?}") };
    let col = &result.cols.first().unwrap_or_else(|| panic!("{sql}: no columns")).0;
    match result.rows.first().and_then(|r| r.get(col)) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => "NULL".into(),
        Some(v) => v.to_string(),
    }
}

async fn retry<T, F, Fut>(what: &str, mut connect: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, QueryError>>,
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

/// Run every case of `system` on one driver: statements in order, then checks.
macro_rules! run_cases {
    ($system:expr, $drv:expr) => {{
        for case in cases($system) {
            for (i, sql) in case.statements.iter().enumerate() {
                if let Err(e) = $drv.exec(sql).await {
                    panic!("[{}] {} — statement #{} failed: {}\n{}", $system, case.name, i + 1, e.message, sql);
                }
            }
            for (sql, want) in &case.checks {
                let got = first_cell($drv.exec(sql).await.unwrap_or_else(|e| panic!("[{}] check failed: {}\n{sql}", $system, e.message)), sql);
                assert_eq!(&got, want, "[{}] {} — {sql}", $system, case.name);
            }
            println!("[{}] ok — {} ({} statements)", $system, case.name, case.statements.len());
        }
    }};
}

#[tokio::test]
async fn postgres_editor_scripts_run_as_split() {
    let c: ContainerAsync<GenericImage> = GenericImage::new("postgres", "16-alpine")
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
    let mut drv = retry("postgres", || PgDriver::connect(&params)).await;
    run_cases!("postgres", drv);
}

#[tokio::test]
async fn mysql_editor_scripts_run_as_split() {
    let c = GenericImage::new("mysql", "8")
        .with_exposed_port(3306.tcp())
        .with_env_var("MYSQL_ROOT_PASSWORD", PASS)
        .with_env_var("MYSQL_DATABASE", "testdb")
        .start()
        .await
        .expect("start mysql");
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    let params = MySqlConnParams {
        host: "localhost".into(),
        port,
        database: "testdb".into(),
        user: "root".into(),
        password: PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    };
    let mut drv = retry("mysql", || MySqlDriver::connect(&params, "mysql")).await;
    run_cases!("mysql", drv);
}

#[tokio::test]
async fn mssql_editor_scripts_run_as_split_and_ddl_is_transactional() {
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
    let mut drv = retry("mssql", || MssqlDriver::connect(&params)).await;
    run_cases!("mssql", drv);

    // SQL Server DDL is transactional: a CREATE TABLE inside a transaction is rolled
    // back with it — so the editor must NOT treat it as ending the transaction.
    drv.exec("BEGIN TRAN CREATE TABLE ddl_in_txn (a int) ROLLBACK").await.expect("txn batch");
    let gone = first_cell(drv.exec("SELECT CASE WHEN OBJECT_ID('ddl_in_txn') IS NULL THEN 'rolled back' ELSE 'kept' END").await.unwrap(), "ddl check");
    assert_eq!(gone, "rolled back");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Oracle Instant Client on PATH — run with --ignored"]
async fn oracle_editor_scripts_run_as_split() {
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
    let mut drv = retry("oracle", || OracleDriver::connect(&params)).await;
    run_cases!("oracle", drv);
}
