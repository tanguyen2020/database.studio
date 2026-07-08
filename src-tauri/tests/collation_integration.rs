//! Collation unification (MySQL) — end-to-end on a real MySQL 8 container.
//!
//! Reproduces the AUDIT-13g bug ("Illegal mix of collations" when two columns of
//! different collation are compared), then runs the EXACT statements that
//! `sql/collation.ts::buildUnifyStatements` emits (data-driven audit → ALTER
//! DATABASE + per-table CONVERT TO, wrapped in SET FOREIGN_KEY_CHECKS) and proves
//! (a) the audit query surfaces the off-target table, (b) the join now succeeds,
//! (c) every column converged on the target collation, and (d) data is intact.
//! Stored procedures/functions/views/triggers are deliberately not touched.
//!
//! Own test target so it compiles independently of drivers_integration.rs.
//! Run methodology (per CLAUDE.md): prebuild, then run synchronously with a hard
//! timeout, --test-threads=1.

use std::time::{Duration, Instant};

use database_studio_lib::drivers::mysql::{MySqlConnParams, MySqlDriver};
use database_studio_lib::drivers::types::StatementOutcome;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};

const PASS: &str = "test123";

async fn retry<T, F, Fut>(what: &str, mut connect: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, database_studio_lib::error::QueryError>>,
{
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        match connect().await {
            Ok(v) => return v,
            Err(e) => {
                assert!(Instant::now() < deadline, "{what}: timed out waiting for container — last: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

/// The audit query mirrors `buildAuditQuery('testdb')` from sql/collation.ts.
const AUDIT_QUERY: &str = "SELECT CAST(t.TABLE_NAME AS CHAR) AS table_name,\n       CAST(t.TABLE_COLLATION AS CHAR) AS table_collation,\n       CAST(GROUP_CONCAT(DISTINCT c.COLLATION_NAME ORDER BY c.COLLATION_NAME) AS CHAR) AS column_collations\nFROM information_schema.TABLES t\nLEFT JOIN information_schema.COLUMNS c\n  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA\n AND c.TABLE_NAME = t.TABLE_NAME\n AND c.COLLATION_NAME IS NOT NULL\nWHERE t.TABLE_SCHEMA = 'testdb'\n  AND t.TABLE_TYPE = 'BASE TABLE'\nGROUP BY t.TABLE_NAME, t.TABLE_COLLATION\nORDER BY t.TABLE_NAME";

#[tokio::test]
async fn mysql_unify_collation_fixes_illegal_mix_end_to_end() {
    let c = GenericImage::new("mysql", "8")
        .with_exposed_port(3306.tcp())
        .with_env_var("MYSQL_ROOT_PASSWORD", PASS)
        .with_env_var("MYSQL_DATABASE", "testdb")
        .start()
        .await
        .expect("start mysql container");
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

    // --- seed a mixed-collation schema (the real-world starting state) ---------
    // `sequences.code` is utf8mb4_0900_ai_ci; `lookup.name` is utf8mb4_general_ci.
    drv.exec("CREATE TABLE sequences (code CHAR(4) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci, seq INT) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci")
        .await
        .unwrap();
    drv.exec("CREATE TABLE lookup (name CHAR(4) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci")
        .await
        .unwrap();
    drv.exec("INSERT INTO sequences (code, seq) VALUES ('nats', 1)").await.unwrap();
    drv.exec("INSERT INTO lookup (name) VALUES ('nats')").await.unwrap();

    // --- precondition: comparing the two differently-collated columns errors ----
    let before = drv.exec("SELECT s.seq AS seq FROM sequences s JOIN lookup l ON s.code = l.name").await;
    assert!(before.is_err(), "expected 'Illegal mix of collations' before unify, got: {before:?}");
    let msg = before.err().unwrap().message.to_lowercase();
    assert!(msg.contains("illegal mix") || msg.contains("collation"), "expected a collation error, got: {msg}");

    // --- the data-driven audit surfaces the off-target table --------------------
    let StatementOutcome::Rows { result } = drv.exec(AUDIT_QUERY).await.unwrap() else { panic!("audit rows") };
    let row = |name: &str| result.rows.iter().find(|r| r["table_name"].as_str() == Some(name)).cloned();
    let lookup = row("lookup").expect("lookup audited");
    let sequences = row("sequences").expect("sequences audited");
    assert_eq!(lookup["column_collations"].as_str(), Some("utf8mb4_general_ci"), "lookup is off-target: {lookup:?}");
    assert_eq!(sequences["column_collations"].as_str(), Some("utf8mb4_0900_ai_ci"), "sequences already on-target: {sequences:?}");
    // → tablesToConvert(target=utf8mb4_0900_ai_ci) = ["lookup"]

    // --- run EXACTLY the statements buildUnifyStatements('mysql','testdb',
    //     'utf8mb4_0900_ai_ci', ['lookup']) produces --------------------------
    for stmt in [
        "SET FOREIGN_KEY_CHECKS = 0;",
        "ALTER DATABASE `testdb` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;",
        "ALTER TABLE `testdb`.`lookup` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;",
        "SET FOREIGN_KEY_CHECKS = 1;",
    ] {
        drv.exec(stmt).await.unwrap_or_else(|e| panic!("unify statement failed [{stmt}]: {}", e.message));
    }

    // --- (b) the join now succeeds and returns the row -------------------------
    let StatementOutcome::Rows { result } = drv
        .exec("SELECT s.seq AS seq FROM sequences s JOIN lookup l ON s.code = l.name")
        .await
        .expect("join succeeds after unify")
    else {
        panic!("join rows")
    };
    assert_eq!(result.rows[0]["seq"].as_i64(), Some(1), "join returns the matching row → data intact");

    // --- (c) every string column in the database is now on the target ----------
    let StatementOutcome::Rows { result } = drv
        .exec("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='testdb' AND COLLATION_NAME IS NOT NULL AND COLLATION_NAME <> 'utf8mb4_0900_ai_ci'")
        .await
        .unwrap()
    else {
        panic!("count rows")
    };
    assert_eq!(result.rows[0]["n"].as_i64(), Some(0), "no column remains off-target");

    // --- (d) data intact -------------------------------------------------------
    let StatementOutcome::Rows { result } = drv.exec("SELECT name FROM lookup").await.unwrap() else { panic!("lookup rows") };
    assert_eq!(result.rows[0]["name"].as_str(), Some("nats"), "converted table keeps its data");

    eprintln!("CHK mysql_unify_collation_fixes_illegal_mix_end_to_end OK");
}
