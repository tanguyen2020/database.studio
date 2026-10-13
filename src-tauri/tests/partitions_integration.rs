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
/// The "P" badge on MySQL: information_schema.PARTITIONS carries one NULL-named row
/// for an ordinary table, so the flag must come from a non-null PARTITION_NAME.
/// The correlated EXISTS also has to be aliased — PARTITIONS shares the
/// TABLE_SCHEMA/TABLE_NAME column names with TABLES, and an unqualified reference
/// would compare the inner table against itself and badge every table.
#[tokio::test]
async fn mysql_partitioned_table_is_flagged_and_plain_tables_are_not() {
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

    for sql in [
        "CREATE TABLE sales (id INT NOT NULL, sold_on DATE NOT NULL, PRIMARY KEY (id, sold_on)) \
         PARTITION BY RANGE (YEAR(sold_on)) (PARTITION p2024 VALUES LESS THAN (2025), \
         PARTITION p2025 VALUES LESS THAN (2026))",
        "CREATE TABLE plain (id INT)",
    ] {
        drv.exec(sql).await.unwrap_or_else(|e| panic!("setup failed [{sql}]: {}", e.message));
    }

    let tables = drv.tables("testdb").await.expect("tables");
    let flagged: Vec<&str> = tables
        .iter()
        .filter(|t| t.is_partitioned == Some(true))
        .map(|t| t.name.as_str())
        .collect();
    assert_eq!(flagged, vec!["sales"], "only the partitioned table is badged: {flagged:?}");
    let plain = tables.iter().find(|t| t.name == "plain").expect("plain row");
    assert_eq!(plain.is_partitioned, Some(false), "a plain table is never badged: {plain:?}");

    // and the badge agrees with what the Partitions node will show
    let parts = drv.partitions("testdb", "sales").await.expect("partitions");
    assert_eq!(parts.len(), 2, "two partitions behind the badge: {parts:?}");
}

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

    // ClickHouse badge: a non-empty system.tables.partition_key is what marks the
    // table as partitioned, so it must agree with partitions() above.
    let tables = drv.tables("default").await.expect("tables");
    let flagged: Vec<&str> = tables
        .iter()
        .filter(|t| t.is_partitioned == Some(true))
        .map(|t| t.name.as_str())
        .collect();
    assert_eq!(flagged, vec!["hits"], "only the partitioned table is badged: {flagged:?}");
    let plain = tables.iter().find(|t| t.name == "plain").expect("plain row");
    assert_eq!(plain.is_partitioned, Some(false), "a plain table is never badged: {plain:?}");
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
/// The "P" badge on SQL Server: a partitioned table stores its heap/clustered index
/// on a partition SCHEME, which is what the flag reads.
#[tokio::test]
async fn mssql_partitioned_table_is_flagged_and_plain_tables_are_not() {
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

    for sql in [
        "CREATE PARTITION FUNCTION pf_year (int) AS RANGE RIGHT FOR VALUES (2025, 2026)",
        "CREATE PARTITION SCHEME ps_year AS PARTITION pf_year ALL TO ([PRIMARY])",
        "CREATE TABLE dbo.sales (id INT NOT NULL, yr INT NOT NULL)",
        "CREATE CLUSTERED INDEX ix_sales ON dbo.sales (yr) ON ps_year (yr)",
        "CREATE TABLE dbo.plain (id INT)",
    ] {
        drv.exec(sql).await.unwrap_or_else(|e| panic!("setup failed [{sql}]: {}", e.message));
    }

    let tables = drv.tables("dbo").await.expect("tables");
    let flagged: Vec<&str> = tables
        .iter()
        .filter(|t| t.is_partitioned == Some(true))
        .map(|t| t.name.as_str())
        .collect();
    assert_eq!(flagged, vec!["sales"], "only the partitioned table is badged: {flagged:?}");
    let plain = tables.iter().find(|t| t.name == "plain").expect("plain row");
    assert_eq!(plain.is_partitioned, Some(false), "a plain table is never badged: {plain:?}");
}

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

/// A PostgreSQL partition IS a table in pg_class. `tables()` must keep returning
/// it — autocomplete, Generate Scripts, Schema Compare and every other consumer
/// read this list and would silently lose those relations — but flag it with
/// `partition_of` so only the tree/Objects tab hide it under its parent, and roll
/// rows/size into the parent (whose own relation stores nothing).
/// Legacy INHERITS children are NOT partitions and must stay unflagged.
#[tokio::test]
async fn pg_partitions_are_flagged_not_dropped_from_the_table_list() {
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

    for sql in [
        "CREATE TABLE events (id bigint, created_at date NOT NULL) PARTITION BY RANGE (created_at)",
        "CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
        "CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')",
        "INSERT INTO events SELECT g, DATE '2024-06-01' FROM generate_series(1, 50000) g",
        "INSERT INTO events SELECT g, DATE '2025-06-01' FROM generate_series(1, 20000) g",
        "ANALYZE events",
        "CREATE TABLE plain (id int)",
        // legacy inheritance — NOT declarative partitioning; both must stay visible
        "CREATE TABLE base_t (id int)",
        "CREATE TABLE child_t () INHERITS (base_t)",
    ] {
        drv.exec(sql).await.unwrap_or_else(|e| panic!("setup failed [{sql}]: {}", e.message));
    }

    let tables = drv.tables("public").await.expect("tables");
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["base_t", "child_t", "events", "events_2024", "events_2025", "plain"],
        "every relation is still returned — dropping rows here breaks autocomplete / \
         Generate Scripts / Schema Compare: {names:?}"
    );

    // Only the partitions are flagged, and they point at their parent.
    for part in ["events_2024", "events_2025"] {
        let row = tables.iter().find(|t| t.name == part).expect("partition row");
        assert_eq!(row.partition_of.as_deref(), Some("events"), "{part} flagged with its parent: {row:?}");
    }
    for plain in ["events", "plain", "base_t", "child_t"] {
        let row = tables.iter().find(|t| t.name == plain).expect("table row");
        assert_eq!(row.partition_of, None, "{plain} must NOT be flagged as a partition: {row:?}");
    }

    // The tree badges a partitioned PARENT with a "P". Only `events` owns partitions:
    // a partition itself does not, a plain table does not, and legacy INHERITS
    // (base_t/child_t) is not declarative partitioning — flagging it would badge
    // ordinary tables all over older schemas.
    let flagged: Vec<&str> = tables
        .iter()
        .filter(|t| t.is_partitioned == Some(true))
        .map(|t| t.name.as_str())
        .collect();
    assert_eq!(flagged, vec!["events"], "only the partitioned parent is badged: {flagged:?}");

    // The parent carries the partitions' totals — listing it with its own 0-byte
    // relation size would make a 3 MB table look empty.
    let parent = tables.iter().find(|t| t.name == "events").expect("parent row");
    assert_eq!(parent.kind, "table", "parent is a table row: {parent:?}");
    assert_eq!(parent.row_estimate, Some(70_000), "rows rolled up: {parent:?}");
    let bytes = parent.data_length.expect("parent data_length");
    assert!(bytes > 1_000_000, "size rolled up from the partitions, got {bytes}");

    // The partitions are still reachable — through the parent's Partitions node,
    // and each one is still a real table the viewer can open.
    let parts = drv.partitions("public", "events").await.expect("partitions");
    assert_eq!(parts.len(), 2, "both partitions listed under the parent: {parts:?}");
    let probe = drv.exec("SELECT count(*) AS n FROM public.events_2024").await.expect("open a partition");
    match probe {
        StatementOutcome::Rows { result } => {
            let n = result.rows[0]["n"].as_i64().or_else(|| result.rows[0]["n"].as_str().and_then(|s| s.parse().ok()));
            assert_eq!(n, Some(50_000), "the hidden partition still holds its own rows");
        }
        other => panic!("expected rows, got {other:?}"),
    }
    eprintln!("CHK pg_partitions_are_flagged_not_dropped_from_the_table_list OK");
}
