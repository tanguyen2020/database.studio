//! Partition introspection (View) — seed a partitioned table on a real engine,
//! then read it back via `LiveConnection`/driver `partitions()`. Kept in its own
//! test target so it compiles independently of drivers_integration.rs.
//!
//! Run methodology (per CLAUDE.md): prebuild, then run synchronously with a hard
//! timeout, one test at a time, --test-threads=1.

use std::time::{Duration, Instant};

use database_studio_lib::drivers::clickhouse::{ChConnParams, ChDriver};
use database_studio_lib::drivers::mssql::{MssqlConnParams, MssqlDriver};
use database_studio_lib::drivers::mysql::{MySqlConnParams, MySqlDriver};
use database_studio_lib::drivers::postgres::{PgConnParams, PgDriver};
use database_studio_lib::drivers::types::StatementOutcome;
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

/// PostgreSQL declarative partitions: RANGE parent + child partitions listed with
/// their bounds; a non-partitioned table returns none.
#[tokio::test]
async fn pg_declarative_partitions_introspected() {
    let c = GenericImage::new("postgres", "16-alpine")
        .with_exposed_port(5432.tcp())
        .with_env_var("POSTGRES_PASSWORD", PASS)
        .with_env_var("POSTGRES_DB", "testdb")
        .start()
        .await
        .expect("start postgres container");
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
    drv.exec("CREATE TABLE events (id bigint, created_at date NOT NULL) PARTITION BY RANGE (created_at)").await.unwrap();
    drv.exec("CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')").await.unwrap();
    drv.exec("CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')").await.unwrap();

    let parts = drv.partitions("public", "events").await.unwrap();
    assert_eq!(parts.len(), 2, "two child partitions: {parts:?}");
    assert!(parts.iter().any(|p| p.name == "events_2024" && p.method == "RANGE"), "child listed: {parts:?}");
    assert!(parts.iter().all(|p| p.key.as_deref() == Some("RANGE (created_at)")), "partition key: {parts:?}");
    assert!(parts.iter().any(|p| p.expression.as_deref().unwrap_or("").contains("2024-01-01")), "bound present: {parts:?}");

    drv.exec("CREATE TABLE plain (id int)").await.unwrap();
    assert!(drv.partitions("public", "plain").await.unwrap().is_empty(), "non-partitioned → none");
    eprintln!("CHK pg_declarative_partitions_introspected OK");
}

/// MySQL partitions from information_schema.PARTITIONS: RANGE parts + description.
#[tokio::test]
async fn mysql_partitions_introspected() {
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
    drv.exec(
        "CREATE TABLE logs (id int, ts date NOT NULL) PARTITION BY RANGE (YEAR(ts)) \
         (PARTITION p2023 VALUES LESS THAN (2024), PARTITION p2024 VALUES LESS THAN (2025))",
    )
    .await
    .unwrap();

    let parts = drv.partitions("testdb", "logs").await.unwrap();
    assert_eq!(parts.len(), 2, "two partitions: {parts:?}");
    assert!(parts.iter().any(|p| p.name == "p2023" && p.method == "RANGE"), "p2023 listed: {parts:?}");
    assert!(parts.iter().any(|p| p.expression.as_deref() == Some("2024")), "description bound: {parts:?}");

    drv.exec("CREATE TABLE plain (id int)").await.unwrap();
    assert!(drv.partitions("testdb", "plain").await.unwrap().is_empty(), "non-partitioned → none");
    eprintln!("CHK mysql_partitions_introspected OK");
}

/// ClickHouse partitions from system.parts: one row per active partition value,
/// carrying the table's PARTITION BY expression as the key.
#[tokio::test]
async fn clickhouse_partitions_introspected() {
    let c = GenericImage::new("clickhouse/clickhouse-server", "24.8")
        .with_exposed_port(8123.tcp())
        .with_env_var("CLICKHOUSE_PASSWORD", PASS)
        .start()
        .await
        .expect("start clickhouse container");
    let port = c.get_host_port_ipv4(8123).await.unwrap();
    let params = ChConnParams {
        host: "localhost".into(),
        port,
        database: "default".into(),
        user: "default".into(),
        password: PASS.into(),
        ssl: false,
    };
    let mut drv = retry("clickhouse", || ChDriver::connect(&params)).await;
    drv.exec("CREATE TABLE hits (d Date, x UInt32) ENGINE = MergeTree PARTITION BY toYYYYMM(d) ORDER BY x").await.unwrap();
    drv.exec("INSERT INTO hits VALUES ('2024-01-15', 1), ('2024-02-20', 2)").await.unwrap();

    let parts = drv.partitions("default", "hits").await.unwrap();
    assert_eq!(parts.len(), 2, "two month partitions: {parts:?}");
    assert!(parts.iter().any(|p| p.name == "202401"), "202401 present: {parts:?}");
    assert!(parts.iter().all(|p| p.key.as_deref() == Some("toYYYYMM(d)")), "partition key expr: {parts:?}");

    drv.exec("CREATE TABLE plain (x UInt32) ENGINE = MergeTree ORDER BY x").await.unwrap();
    assert!(drv.partitions("default", "plain").await.unwrap().is_empty(), "no PARTITION BY → none");
    eprintln!("CHK clickhouse_partitions_introspected OK");
}

/// MSSQL partitions via a partition function + scheme: sys.partitions rows carry
/// the RANGE method, the partition column, and boundary values.
#[tokio::test]
async fn mssql_partitions_introspected() {
    let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
        .with_exposed_port(1433.tcp())
        .with_env_var("ACCEPT_EULA", "Y")
        .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
        .start()
        .await
        .expect("start mssql container");
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
    drv.exec("CREATE PARTITION FUNCTION pf_sales (int) AS RANGE RIGHT FOR VALUES (100, 200)").await.unwrap();
    drv.exec("CREATE PARTITION SCHEME ps_sales AS PARTITION pf_sales ALL TO ([PRIMARY])").await.unwrap();
    drv.exec("CREATE TABLE sales (id int NOT NULL, amt int) ON ps_sales (id)").await.unwrap();

    let parts = drv.partitions("dbo", "sales").await.unwrap();
    assert!(parts.len() >= 3, "three partitions from two boundaries: {parts:?}");
    assert!(parts.iter().all(|p| p.method == "RANGE"), "RANGE method: {parts:?}");
    assert!(parts.iter().any(|p| p.key.as_deref() == Some("id")), "partition column: {parts:?}");
    assert!(parts.iter().any(|p| p.expression.as_deref() == Some("100")), "boundary value: {parts:?}");

    drv.exec("CREATE TABLE plain (id int)").await.unwrap();
    assert!(drv.partitions("dbo", "plain").await.unwrap().is_empty(), "non-partitioned → none");
    eprintln!("CHK mssql_partitions_introspected OK");
}

/// ADD partition to an existing PG table, running exactly the DDL the designer's
/// buildAddPartition emits (CREATE TABLE … PARTITION OF …), then verify it landed.
#[tokio::test]
async fn pg_add_partition_to_existing_table() {
    let c = GenericImage::new("postgres", "16-alpine")
        .with_exposed_port(5432.tcp())
        .with_env_var("POSTGRES_PASSWORD", PASS)
        .with_env_var("POSTGRES_DB", "testdb")
        .start()
        .await
        .expect("start postgres container");
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
    drv.exec("CREATE TABLE events (id bigint, created_at date NOT NULL) PARTITION BY RANGE (created_at)").await.unwrap();
    drv.exec("CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')").await.unwrap();
    assert_eq!(drv.partitions("public", "events").await.unwrap().len(), 1);

    // exactly what buildAddPartition('postgres', …) produces:
    drv.exec("CREATE TABLE public.events_2026 PARTITION OF public.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');").await.unwrap();
    let parts = drv.partitions("public", "events").await.unwrap();
    assert_eq!(parts.len(), 2, "partition added: {parts:?}");
    assert!(parts.iter().any(|p| p.name == "events_2026"), "new partition present: {parts:?}");
    eprintln!("CHK pg_add_partition_to_existing_table OK");
}

/// ADD partition to an existing MySQL table, running exactly the DDL the designer's
/// buildAddPartition emits (ALTER TABLE … ADD PARTITION …), then verify it landed.
#[tokio::test]
async fn mysql_add_partition_to_existing_table() {
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
    drv.exec(
        "CREATE TABLE logs (id int, ts date NOT NULL) PARTITION BY RANGE (YEAR(ts)) \
         (PARTITION p2023 VALUES LESS THAN (2024))",
    )
    .await
    .unwrap();
    assert_eq!(drv.partitions("testdb", "logs").await.unwrap().len(), 1);

    // exactly what buildAddPartition('mysql', …) produces:
    drv.exec("ALTER TABLE `testdb`.`logs` ADD PARTITION (PARTITION `p2024` VALUES LESS THAN (2025));").await.unwrap();
    let parts = drv.partitions("testdb", "logs").await.unwrap();
    assert_eq!(parts.len(), 2, "partition added: {parts:?}");
    assert!(parts.iter().any(|p| p.name == "p2024"), "new partition present: {parts:?}");
    eprintln!("CHK mysql_add_partition_to_existing_table OK");
}

/// CONVERT an existing PG table to partitioned, running exactly the DDL the
/// designer's buildConvertToPartitioned emits (rename → CREATE LIKE partitioned →
/// children → copy → drop), then verify partitions + row count are preserved.
#[tokio::test]
async fn pg_convert_existing_table_to_partitioned() {
    let c = GenericImage::new("postgres", "16-alpine")
        .with_exposed_port(5432.tcp())
        .with_env_var("POSTGRES_PASSWORD", PASS)
        .with_env_var("POSTGRES_DB", "testdb")
        .start()
        .await
        .expect("start postgres container");
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
    drv.exec("CREATE TABLE events (id bigint, created_at date NOT NULL)").await.unwrap();
    drv.exec("INSERT INTO events VALUES (1,'2024-05-01'), (2,'2025-05-01')").await.unwrap();
    assert!(drv.partitions("public", "events").await.unwrap().is_empty(), "starts non-partitioned");

    for stmt in [
        r#"ALTER TABLE "public"."events" RENAME TO "events_old";"#,
        r#"CREATE TABLE "public"."events" (LIKE "public"."events_old" INCLUDING DEFAULTS) PARTITION BY RANGE ("created_at");"#,
        r#"CREATE TABLE "public"."events_2024" PARTITION OF "public"."events" FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');"#,
        r#"CREATE TABLE "public"."events_2025" PARTITION OF "public"."events" FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');"#,
        r#"INSERT INTO "public"."events" SELECT * FROM "public"."events_old";"#,
        r#"DROP TABLE "public"."events_old";"#,
    ] {
        drv.exec(stmt).await.unwrap();
    }

    let parts = drv.partitions("public", "events").await.unwrap();
    assert_eq!(parts.len(), 2, "converted → 2 partitions: {parts:?}");
    let StatementOutcome::Rows { result } = drv.exec("SELECT count(*) AS n FROM events").await.unwrap() else { panic!("rows") };
    assert_eq!(result.rows[0]["n"].as_i64(), Some(2), "rows preserved after convert");
    eprintln!("CHK pg_convert_existing_table_to_partitioned OK");
}

/// CONVERT an existing MySQL table to partitioned in place (ALTER TABLE … PARTITION
/// BY …) — exactly what buildConvertToPartitioned emits — and verify.
#[tokio::test]
async fn mysql_convert_existing_table_to_partitioned() {
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
    drv.exec("CREATE TABLE logs (id int, ts date NOT NULL)").await.unwrap();
    drv.exec("INSERT INTO logs VALUES (1,'2023-05-01'), (2,'2024-05-01')").await.unwrap();
    assert!(drv.partitions("testdb", "logs").await.unwrap().is_empty(), "starts non-partitioned");

    drv.exec(
        "ALTER TABLE `testdb`.`logs`\nPARTITION BY RANGE (YEAR(ts)) (\n  PARTITION `p2023` VALUES LESS THAN (2024),\n  PARTITION `p2024` VALUES LESS THAN (2025)\n);",
    )
    .await
    .unwrap();

    let parts = drv.partitions("testdb", "logs").await.unwrap();
    assert_eq!(parts.len(), 2, "converted in place → 2 partitions: {parts:?}");
    let StatementOutcome::Rows { result } = drv.exec("SELECT count(*) AS n FROM logs").await.unwrap() else { panic!("rows") };
    assert_eq!(result.rows[0]["n"].as_i64(), Some(2), "rows preserved");
    eprintln!("CHK mysql_convert_existing_table_to_partitioned OK");
}

/// CONVERT an existing MSSQL heap to partitioned via partition function + scheme +
/// clustered index on the scheme — exactly what buildConvertToPartitioned emits.
#[tokio::test]
async fn mssql_convert_existing_table_to_partitioned() {
    let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
        .with_exposed_port(1433.tcp())
        .with_env_var("ACCEPT_EULA", "Y")
        .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
        .start()
        .await
        .expect("start mssql container");
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
    drv.exec("CREATE TABLE sales (id int NOT NULL, sale_date int NOT NULL)").await.unwrap();
    drv.exec("INSERT INTO sales VALUES (1, 50), (2, 150)").await.unwrap();
    assert!(drv.partitions("dbo", "sales").await.unwrap().is_empty(), "starts non-partitioned");

    drv.exec("CREATE PARTITION FUNCTION [pf_sales] (int)\n  AS RANGE RIGHT FOR VALUES (100);").await.unwrap();
    drv.exec("CREATE PARTITION SCHEME [ps_sales]\n  AS PARTITION [pf_sales] ALL TO ([PRIMARY]);").await.unwrap();
    drv.exec("CREATE CLUSTERED INDEX [CIX_sales_partition] ON [dbo].[sales] ([sale_date]) ON [ps_sales] ([sale_date]);").await.unwrap();

    let parts = drv.partitions("dbo", "sales").await.unwrap();
    assert!(parts.len() >= 2, "converted → ≥2 partitions: {parts:?}");
    let StatementOutcome::Rows { result } = drv.exec("SELECT count(*) AS n FROM sales").await.unwrap() else { panic!("rows") };
    assert_eq!(result.rows[0]["n"].as_i64(), Some(2), "rows preserved");
    eprintln!("CHK mssql_convert_existing_table_to_partitioned OK");
}
