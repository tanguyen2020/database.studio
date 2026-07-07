//! Integration test Phase 1 — mỗi hệ trong phase chạy trên DB THẬT qua
//! testcontainers (container tự bật/tắt, không phụ thuộc DB cài sẵn trên máy).
//! SQLite chạy trên file/in-memory thật (không cần container).
//! SSH tunnel test bằng SSH server in-process (russh server) + echo target —
//! kiểm auth password + forward bytes thật của `open_tunnel`.
//!
//! Chạy: `cargo test --test drivers_integration` (cần Docker daemon).

use std::time::{Duration, Instant};

use database_studio_lib::connections::profile::SqliteMode;
use database_studio_lib::drivers::clickhouse::{ChConnParams, ChDriver};
use database_studio_lib::drivers::mssql::{MssqlConnParams, MssqlDriver};
use database_studio_lib::drivers::mysql::{MySqlConnParams, MySqlDriver};
use database_studio_lib::drivers::postgres::{PgConnParams, PgDriver};
use database_studio_lib::drivers::sqlite::{SqliteConnParams, SqliteDriver};
use database_studio_lib::drivers::types::StatementOutcome;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

const PASS: &str = "test123";
const MSSQL_PASS: &str = "Test123!Pass";

/// Container mới start cần thời gian sẵn sàng — retry connect tới deadline.
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
                assert!(
                    Instant::now() < deadline,
                    "{what}: hết 240s chờ container sẵn sàng — lỗi cuối: {}",
                    e.message
                );
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

async fn start_pg() -> (ContainerAsync<GenericImage>, u16) {
    let c = GenericImage::new("postgres", "16-alpine")
        .with_exposed_port(5432.tcp())
        .with_env_var("POSTGRES_PASSWORD", PASS)
        .with_env_var("POSTGRES_DB", "testdb")
        .start()
        .await
        .expect("start postgres container (Docker daemon phải đang chạy)");
    let port = c.get_host_port_ipv4(5432).await.unwrap();
    (c, port)
}

#[tokio::test]
async fn pg_roundtrip_null_multi_and_error_position() {
    let (_c, port) = start_pg().await;
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

    // --- CRUD + WHERE lọc thật -------------------------------------------
    drv.exec("CREATE TABLE it_orders (id int PRIMARY KEY, status text)").await.unwrap();
    let ins = drv
        .exec("INSERT INTO it_orders VALUES (1,'done'), (2,'open'), (3,'done')")
        .await
        .unwrap();
    assert!(matches!(ins, StatementOutcome::Affected { affected: 3 }));

    let out = drv
        .exec("SELECT id FROM it_orders WHERE status = 'done' ORDER BY id")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.total, 2);
    assert_eq!(result.rows[0]["id"], serde_json::json!(1));

    // --- NULL vs chuỗi rỗng giữ nguyên qua wire ---------------------------
    drv.exec("INSERT INTO it_orders VALUES (4, NULL), (5, '')").await.unwrap();
    let out = drv
        .exec("SELECT status FROM it_orders WHERE id IN (4,5) ORDER BY id")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert!(result.rows[0]["status"].is_null());
    assert_eq!(result.rows[1]["status"], serde_json::json!(""));

    // --- Transaction/rollback thật ----------------------------------------
    drv.exec("BEGIN").await.unwrap();
    drv.exec("INSERT INTO it_orders VALUES (99, 'tx')").await.unwrap();
    drv.exec("ROLLBACK").await.unwrap();
    let out = drv.exec("SELECT count(*) AS n FROM it_orders WHERE id = 99").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(0), "rollback phải hủy insert");

    // --- QueryError tầng 2: SQLSTATE 42P01 + position → line/col ----------
    let err = drv
        .exec("SELECT * FROM khong_ton_tai_bang")
        .await
        .expect_err("query phải fail");
    assert_eq!(err.code.as_deref(), Some("42P01"));
    let pos = err.position.expect("PG phải trả position");
    assert_eq!(pos.line, 1);
    assert!(pos.col > 1);
    assert!(err.hint.is_some(), "42P01 phải có hint tiếng Việt");
    assert!(!err.raw.is_empty(), "raw error phải giữ nguyên văn");

    // --- Phase 5 T1: EXPLAIN (FORMAT JSON) thật → parse_pg ra cây chuẩn hóa ---
    let out = drv
        .exec("EXPLAIN (FORMAT JSON) SELECT id FROM it_orders WHERE status = 'done'")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("EXPLAIN phải trả rows") };
    let cell = result.rows[0].as_object().unwrap().values().next().unwrap();
    let json = if cell.is_string() { cell.as_str().unwrap().to_string() } else { cell.to_string() };
    let plan = database_studio_lib::drivers::plan::parse_pg(&json, false).expect("parse PG plan");
    let root = plan.root.expect("phải có root node");
    // scan node cơ bản (Seq Scan bảng nhỏ) — operation đã chuẩn hóa
    assert!(
        root.operation.contains("Scan") || !root.children.is_empty(),
        "root phải là scan/tree node, got {}",
        root.operation
    );
    assert_eq!(plan.system, "postgres");
    assert!(!plan.raw.is_empty());

    // --- Phase 5 T7b: Index Scanner thật (pg_stat + prefix redundancy) ---
    drv.exec("CREATE INDEX idx_status ON it_orders (status)").await.unwrap();
    let mut idxs = drv.scan_indexes("public").await.unwrap();
    let summary = database_studio_lib::drivers::index_scan::compute_flags(&mut idxs);
    let pk = idxs.iter().find(|i| i.primary).expect("phải thấy PK index");
    assert!(pk.columns.iter().any(|c| c == "id"), "PK trên id");
    let idx = idxs.iter().find(|i| i.name == "idx_status").expect("thấy idx_status");
    assert_eq!(idx.columns, vec!["status".to_string()]);
    assert!(idx.usage.is_some(), "PG có idx_scan usage");
    assert!(summary.total >= 2);
}

/// Item 3 — Explorer must list every database on a Postgres server. `databases()`
/// returns the server catalog with `current` marking the connected DB (testdb).
#[tokio::test]
async fn pg_list_databases_marks_current() {
    let (_c, port) = start_pg().await;
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
    // Seed a second database so the list has more than the connected one.
    drv.exec("CREATE DATABASE extra_db").await.unwrap();

    let dbs = drv.databases().await.unwrap();
    let cur = dbs.iter().find(|d| d.name == "testdb").expect("testdb listed");
    assert!(cur.current, "connected database is marked current");
    let extra = dbs.iter().find(|d| d.name == "extra_db").expect("extra_db listed");
    assert!(!extra.current, "other databases are not current");
    // Template databases must be filtered out.
    assert!(!dbs.iter().any(|d| d.name == "template0"), "template dbs excluded");
    assert_eq!(dbs.iter().filter(|d| d.current).count(), 1, "exactly one current db");
}

/// T31 — Azure AD Service Principal connect to a real Azure SQL Database.
/// Requires Azure infra + secrets, so it is #[ignore] (run manually):
///   AZURE_SQL_HOST=<srv>.database.windows.net AZURE_SQL_DB=<db> \
///   AZURE_CLIENT_ID=<id> AZURE_TENANT=<tenant> AZURE_CLIENT_SECRET=<secret> \
///   cargo test --test drivers_integration mssql_aad_service_principal -- --ignored --nocapture
#[tokio::test]
#[ignore = "needs a real Azure SQL Database + service principal (see doc comment)"]
async fn mssql_aad_service_principal() {
    let host = std::env::var("AZURE_SQL_HOST").expect("AZURE_SQL_HOST");
    let db = std::env::var("AZURE_SQL_DB").unwrap_or_default();
    let client_id = std::env::var("AZURE_CLIENT_ID").expect("AZURE_CLIENT_ID");
    let tenant = std::env::var("AZURE_TENANT").expect("AZURE_TENANT");
    let secret = std::env::var("AZURE_CLIENT_SECRET").expect("AZURE_CLIENT_SECRET");
    let params = MssqlConnParams {
        host,
        port: 1433,
        database: db,
        user: format!("{client_id}@{tenant}"), // clientId@tenant convention
        password: secret,
        ssl: true,
        ssl_ca: String::new(),
        auth: "aad-sp".into(),
    };
    let mut drv = MssqlDriver::connect(&params).await.expect("AAD SP connect");
    let out = drv.exec("SELECT 1 AS n").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(1));
}

/// T28 — Rename a function on PostgreSQL (ALTER FUNCTION … RENAME, as emitted by
/// genRenameRoutine). The new name is callable; the old one is gone.
#[tokio::test]
async fn pg_rename_function() {
    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE FUNCTION t_add(integer) RETURNS integer AS $$ SELECT $1 + 1 $$ LANGUAGE sql").await.unwrap();
    drv.exec("ALTER FUNCTION \"public\".\"t_add\"(integer) RENAME TO \"t_plus\";").await.unwrap();
    let out = drv.exec("SELECT \"public\".\"t_plus\"(41) AS n").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(42), "renamed function is callable");
    drv.exec("SELECT t_add(1)").await.expect_err("old function name is gone");
}

/// T28 — Rename a stored procedure on SQL Server (EXEC sp_rename, as emitted by
/// genRenameRoutine). The object is renamed in the catalog.
#[tokio::test]
async fn mssql_rename_procedure() {
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
    // CREATE PROCEDURE must be first in its batch → run via dynamic SQL here.
    drv.exec("EXEC('CREATE PROCEDURE dbo.t_p AS SELECT 1 AS n')").await.unwrap();
    drv.exec("EXEC sp_rename 'dbo.t_p', 't_q';").await.unwrap();
    let out = drv.exec("SELECT count(*) AS n FROM sys.objects WHERE name = 't_q' AND type = 'P'").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(1), "procedure renamed in catalog");
    let gone = drv.exec("SELECT count(*) AS n FROM sys.objects WHERE name = 't_p'").await.unwrap();
    let StatementOutcome::Rows { result } = gone else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(0), "old name gone");
}

/// T26 — Generate Test Data output contract (id=sequence, parent_id from the
/// parent-key pool, email unique) must satisfy FK + UNIQUE on a real engine.
/// The pure generator (testdata/generate.ts) produces exactly this shape.
#[tokio::test]
async fn pg_test_data_contract_respects_fk_and_unique() {
    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE TABLE td_parent (id int PRIMARY KEY)").await.unwrap();
    drv.exec("INSERT INTO td_parent VALUES (1),(2),(3)").await.unwrap();
    drv.exec("CREATE TABLE td_child (id int PRIMARY KEY, parent_id int NOT NULL REFERENCES td_parent(id), email text UNIQUE NOT NULL)")
        .await
        .unwrap();

    // Rows shaped like generateRows() output: sequence PK, FK from pool {1,2,3}, unique email.
    let pool = [1, 2, 3];
    let values: Vec<String> = (1..=300).map(|i| format!("({i}, {}, 'user{i}@example.com')", pool[(i - 1) % 3])).collect();
    let ins = drv
        .exec(&format!("INSERT INTO td_child (id, parent_id, email) VALUES {}", values.join(",")))
        .await
        .unwrap();
    assert!(matches!(ins, StatementOutcome::Affected { affected: 300 }), "all rows insert without constraint violation");

    // FK integrity: every child references a real parent.
    let out = drv.exec("SELECT count(*) AS n FROM td_child c JOIN td_parent p ON c.parent_id = p.id").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(300));
    // UNIQUE holds (the insert would have failed otherwise).
    let u = drv.exec("SELECT count(DISTINCT email) AS n FROM td_child").await.unwrap();
    let StatementOutcome::Rows { result } = u else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(300));
}

/// T24 — streaming export writes ≥1M rows straight to a file one row at a time,
/// so memory stays bounded regardless of result size (no fetch_all buffering).
/// Verifies the exact row count + file line count.
#[tokio::test]
async fn pg_stream_export_million_rows_to_file() {
    use database_studio_lib::drivers::postgres::ExportFormat;
    use std::io::BufRead;
    use std::sync::atomic::AtomicBool;

    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE TABLE big AS SELECT g AS id, 'row-' || g AS label FROM generate_series(1, 1000000) g")
        .await
        .unwrap();

    let path = std::env::temp_dir().join(format!("ds_stream_export_{port}.csv"));
    let mut w = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let cancel = AtomicBool::new(false);
    let mut last_progress = 0u64;
    let total = drv
        .stream_export("SELECT id, label FROM big ORDER BY id", ExportFormat::Csv, "big", &mut w, |n| last_progress = n, &cancel)
        .await
        .unwrap();
    drop(w); // flush BufWriter

    assert_eq!(total, 1_000_000, "all rows streamed");
    assert_eq!(last_progress, 1_000_000, "final progress reported");
    let lines = std::io::BufReader::new(std::fs::File::open(&path).unwrap()).lines().count();
    assert_eq!(lines, 1_000_001, "CSV header + 1M data rows");
    let _ = std::fs::remove_file(&path);
}

/// T24 — cancelling a streaming export stops the loop promptly and cleanly (no
/// connection poison): the follow-up query still runs on the same connection.
#[tokio::test]
async fn pg_stream_export_cancel_stops_early() {
    use database_studio_lib::drivers::postgres::ExportFormat;
    use std::sync::atomic::{AtomicBool, Ordering};

    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE TABLE big AS SELECT g AS id FROM generate_series(1, 1000000) g").await.unwrap();

    let path = std::env::temp_dir().join(format!("ds_stream_cancel_{port}.csv"));
    let mut w = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let cancel = AtomicBool::new(false);
    // flip cancel once the first progress tick (10k rows) fires
    let total = drv
        .stream_export("SELECT id FROM big ORDER BY id", ExportFormat::Csv, "big", &mut w, |n| {
            if n >= 10_000 {
                cancel.store(true, Ordering::Relaxed);
            }
        }, &cancel)
        .await
        .unwrap();
    drop(w);
    let _ = std::fs::remove_file(&path);

    assert!(total >= 10_000 && total < 1_000_000, "cancel stopped early, got {total}");
    // connection is still usable after cancel (no poison / half-read stream)
    let out = drv.exec("SELECT count(*) AS n FROM big").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(1_000_000));
}

/// AUDIT-4 item 2 — per-database Explorer relies on opening a connection to
/// another database on the same server (what `attach_database` does with an
/// internal sub-connection id). Verify a connection bound to database B sees B's
/// catalog, not A's — i.e. cross-database browsing needs a separate connection.
#[tokio::test]
async fn pg_connection_to_other_database_sees_its_own_catalog() {
    let (_c, port) = start_pg().await;
    let mk = |db: &str| PgConnParams {
        host: "localhost".into(),
        port,
        database: db.into(),
        user: "postgres".into(),
        password: PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    };
    // Seed: table only in testdb, and a second database with its own table.
    let pa = mk("testdb");
    let mut a = retry("postgres", || PgDriver::connect(&pa)).await;
    a.exec("CREATE TABLE only_in_a (id int)").await.unwrap();
    a.exec("CREATE DATABASE it_other").await.unwrap();

    let mut b = PgDriver::connect(&mk("it_other")).await.expect("connect to it_other");
    b.exec("CREATE TABLE only_in_b (id int)").await.unwrap();

    let a_tables = a.tables("public").await.unwrap();
    let b_tables = b.tables("public").await.unwrap();
    assert!(a_tables.iter().any(|t| t.name == "only_in_a"), "A sees its own table");
    assert!(!a_tables.iter().any(|t| t.name == "only_in_b"), "A does NOT see B's table");
    assert!(b_tables.iter().any(|t| t.name == "only_in_b"), "B sees its own table");
    assert!(!b_tables.iter().any(|t| t.name == "only_in_a"), "B does NOT see A's table");
}

/// Item 5 — a `timestamp`/`timestamptz`/`date` value of ±infinity or beyond
/// chrono's range must NOT panic (sqlx's decoder does `NaiveDateTime + Duration`
/// which panics; under `panic = "abort"` that kills the app). We decode raw bytes
/// defensively and return sentinel strings instead.
#[tokio::test]
async fn pg_infinity_and_out_of_range_timestamp_do_not_panic() {
    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE TABLE it_ts (id int PRIMARY KEY, ts timestamp, tstz timestamptz, d date)")
        .await
        .unwrap();
    drv.exec(
        "INSERT INTO it_ts VALUES \
         (1, 'infinity', 'infinity', 'infinity'), \
         (2, '-infinity', '-infinity', '-infinity'), \
         (3, '2024-01-15 10:30:00', '2024-01-15 10:30:00+00', '2024-01-15')",
    )
    .await
    .unwrap();

    // This SELECT would previously panic the task while decoding row 1/2.
    let out = drv.exec("SELECT ts, tstz, d FROM it_ts ORDER BY id").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.total, 3);
    assert_eq!(result.rows[0]["ts"], serde_json::json!("infinity"));
    assert_eq!(result.rows[0]["tstz"], serde_json::json!("infinity"));
    assert_eq!(result.rows[0]["d"], serde_json::json!("infinity"));
    assert_eq!(result.rows[1]["ts"], serde_json::json!("-infinity"));
    assert_eq!(result.rows[1]["d"], serde_json::json!("-infinity"));
    // A normal value still decodes to a readable ISO string.
    assert!(
        result.rows[2]["ts"].as_str().unwrap().starts_with("2024-01-15"),
        "normal timestamp decodes, got {:?}",
        result.rows[2]["ts"]
    );
    assert_eq!(result.rows[2]["d"], serde_json::json!("2024-01-15"));

    // A far-future timestamp beyond chrono's range is clamped to a marker, not a panic.
    drv.exec("INSERT INTO it_ts (id, ts) VALUES (4, '294276-01-01 00:00:00')").await.unwrap();
    let out = drv.exec("SELECT ts FROM it_ts WHERE id = 4").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    let v = result.rows[0]["ts"].as_str().unwrap();
    assert!(
        v.starts_with("<timestamp out of range") || v.starts_with("294276"),
        "out-of-range timestamp is handled without panic, got {v:?}"
    );
}

/// Phase 2 · Section 8 — Quick Connect: một connection với id ephemeral (`quick-*`)
/// được đăng ký thẳng vào Registry (không qua storage) và truy vấn được như mọi
/// live connection; disconnect gỡ sạch. Đây là hợp đồng backend của `quick_connect`.
#[tokio::test]
async fn quick_connect_ephemeral_id_is_queryable_via_registry() {
    use database_studio_lib::connections::profile::{
        ConnectionProfile, Environment, SqliteMode, SshConfig,
    };
    use database_studio_lib::connections::registry::Registry;
    use database_studio_lib::drivers::types::{StatementOutcome, SystemType};

    let (_c, port) = start_pg().await;
    let profile = ConnectionProfile {
        id: "quick-itest".into(),
        name: "adhoc".into(),
        system: SystemType::Postgres,
        host: "localhost".into(),
        port,
        database: "testdb".into(),
        user: "postgres".into(),
        password_enc: String::new(),
        group: String::new(),
        env: Environment::Development,
        ssh: SshConfig::default(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
        sqlite_path: String::new(),
        sqlite_mode: SqliteMode::ReadWrite,
        mssql_auth: String::new(),
        schema_registry_url: String::new(),
        cassandra_dc: String::new(),
        cassandra_consistency: String::new(),
    };

    let registry = Registry::default();
    // retry tới khi container sẵn sàng (registry.connect trả AppError nên loop tay)
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        match registry.connect(profile.clone(), PASS.into(), String::new()).await {
            Ok(_) => break,
            Err(e) => {
                assert!(Instant::now() < deadline, "quick connect hết 240s: {e:?}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }

    assert!(registry.is_connected("quick-itest"), "ephemeral id phải sống trong registry");
    // system_of resolves the engine from the LIVE connection even when the id is
    // not in storage (sub-connections / quick-connects) — used by object_definition
    // (Show Definition / Alter) so it doesn't fail with an empty-system driver error.
    assert_eq!(registry.system_of("quick-itest").as_deref(), Some("postgres"));
    assert_eq!(registry.system_of("nope"), None);
    let outcome = registry
        .exec_statement("quick-itest", "SELECT 1 AS n".into())
        .await
        .unwrap()
        .unwrap();
    let StatementOutcome::Rows { result } = outcome else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(1));

    registry.disconnect("quick-itest").await.unwrap();
    assert!(!registry.is_connected("quick-itest"), "disconnect phải gỡ sạch");
}

// ---------------------------------------------------------------------------
// MySQL + MariaDB (chung driver sqlx-mysql, system type riêng)
// ---------------------------------------------------------------------------

async fn mysql_like_roundtrip(image: (&str, &str), env_prefix: &str, system: &'static str) {
    let c = GenericImage::new(image.0, image.1)
        .with_exposed_port(3306.tcp())
        .with_env_var(format!("{env_prefix}_ROOT_PASSWORD"), PASS)
        .with_env_var(format!("{env_prefix}_DATABASE"), "testdb")
        .start()
        .await
        .unwrap_or_else(|e| panic!("start {system} container: {e}"));
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
    let mut drv = retry(system, || MySqlDriver::connect(&params, system)).await;

    drv.exec("CREATE TABLE it_users (id int PRIMARY KEY, name varchar(50))").await.unwrap();
    drv.exec("INSERT INTO it_users VALUES (1,'an'), (2,'binh')").await.unwrap();
    let out = drv.exec("SELECT name FROM it_users WHERE id = 2").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["name"], serde_json::json!("binh"));

    // lỗi giữ đúng system identity (mysql vs mariadb) + raw
    let err = drv.exec("SELEC * FROM x").await.expect_err("phải fail");
    assert_eq!(err.system, system);
    assert!(!err.raw.is_empty());
}

#[tokio::test]
async fn mysql_roundtrip() {
    mysql_like_roundtrip(("mysql", "8"), "MYSQL", "mysql").await;
}

/// Bug: Alter/Show Definition of a MySQL routine showed a `0x…` hex BLOB (the raw
/// body from information_schema) which wasn't a runnable statement. `definition_query`
/// now uses `SHOW CREATE …` → the full, valid CREATE DDL as TEXT.
#[tokio::test]
async fn mysql_routine_definition_is_text_not_hex() {
    use database_studio_lib::commands::schema::definition_query;
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
    drv.exec("CREATE FUNCTION add_one(x INT) RETURNS INT DETERMINISTIC BEGIN RETURN x + 1; END")
        .await
        .unwrap();

    let q = definition_query("mysql", "function", "testdb", "add_one").expect("query built");
    assert!(q.starts_with("SHOW CREATE FUNCTION"), "uses SHOW CREATE: {q}");
    let StatementOutcome::Rows { result } = drv.exec(&q).await.unwrap() else { panic!("rows") };
    // pick the "Create Function" column like object_definition does
    let obj = result.rows[0].as_object().unwrap();
    let def = obj
        .iter()
        .find(|(k, _)| k.to_lowercase().starts_with("create "))
        .map(|(_, v)| v)
        .and_then(|v| v.as_str())
        .expect("Create Function column present");
    assert!(def.contains("FUNCTION") && def.contains("RETURN"), "full CREATE text, got: {def}");
    assert!(!def.starts_with("0x"), "definition must NOT be a hex BLOB: {def}");
}

/// AUDIT-5 item 4 — the Object Explorer renders MySQL correctly. Drives the exact
/// introspection chain the tree uses (loadSchemas → loadSchemaChildren →
/// loadTableDetail): schemas() must surface the connected DB (marked default),
/// tables() must list both a base table AND a view, columns() the real columns,
/// triggers() the seeded trigger. Seeds then queries back (no hard-coded expects).
#[tokio::test]
async fn mysql_explorer_tree_introspection() {
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

    drv.exec("CREATE TABLE students (id int PRIMARY KEY, name varchar(50), gpa decimal(3,2))").await.unwrap();
    drv.exec("INSERT INTO students VALUES (1,'an',3.5)").await.unwrap();
    drv.exec("CREATE VIEW v_students AS SELECT id, name FROM students").await.unwrap();
    drv.exec(
        "CREATE TRIGGER trg_students_ins BEFORE INSERT ON students \
         FOR EACH ROW SET NEW.gpa = COALESCE(NEW.gpa, 0)",
    )
    .await
    .unwrap();

    // loadSchemas: the connected database appears and is flagged default.
    let schemas = drv.schemas().await.unwrap();
    let testdb = schemas.iter().find(|s| s.name == "testdb").expect("testdb schema present in tree");
    assert!(testdb.is_default, "connected DB flagged as default (DATABASE())");
    assert!(
        !schemas.iter().any(|s| ["mysql", "information_schema", "performance_schema", "sys"].contains(&s.name.as_str())),
        "system schemas hidden from the tree",
    );

    // loadSchemaChildren: base table + view both listed with the right kind.
    let tables = drv.tables("testdb").await.unwrap();
    let base = tables.iter().find(|t| t.name == "students").expect("students table listed");
    assert_eq!(base.kind, "table");
    let view = tables.iter().find(|t| t.name == "v_students").expect("view listed");
    assert_eq!(view.kind, "view", "view rendered under Views, not Tables");

    // loadTableDetail: real columns.
    let cols = drv.columns("testdb", "students").await.unwrap();
    let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"id") && names.contains(&"name") && names.contains(&"gpa"), "columns: {names:?}");
    assert!(cols.iter().find(|c| c.name == "id").unwrap().is_pk, "id is PK");

    // triggers folder.
    let trigs = drv.triggers("testdb").await.unwrap();
    assert!(trigs.iter().any(|t| t.name == "trg_students_ins" && t.table == "students"), "trigger listed: {trigs:?}");
}

/// T29 — Index/FK Manager DDL runs on MySQL: create/drop index (DROP INDEX … ON)
/// + add/drop FK (DROP FOREIGN KEY), exactly as genCreate/DropIndex/ForeignKey emit.
#[tokio::test]
async fn mysql_index_fk_crud() {
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
    drv.exec("CREATE TABLE im_parent (id int PRIMARY KEY)").await.unwrap();
    drv.exec("CREATE TABLE im_child (id int PRIMARY KEY, pid int, email varchar(100))").await.unwrap();

    async fn n(drv: &mut MySqlDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        result.rows[0]["n"].as_i64().unwrap()
    }

    drv.exec("CREATE INDEX `ix_im_child_email` ON `testdb`.`im_child` (`email`);").await.unwrap();
    assert!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.statistics WHERE index_name='ix_im_child_email' AND table_name='im_child'").await >= 1, "index created");
    drv.exec("ALTER TABLE `testdb`.`im_child` ADD CONSTRAINT `fk_im_child_parent` FOREIGN KEY (`pid`) REFERENCES `testdb`.`im_parent` (`id`);").await.unwrap();
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE constraint_name='fk_im_child_parent' AND constraint_type='FOREIGN KEY'").await, 1, "FK added");
    drv.exec("ALTER TABLE `testdb`.`im_child` DROP FOREIGN KEY `fk_im_child_parent`;").await.unwrap();
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE constraint_name='fk_im_child_parent' AND constraint_type='FOREIGN KEY'").await, 0, "FK dropped");
    drv.exec("DROP INDEX `ix_im_child_email` ON `testdb`.`im_child`;").await.unwrap();
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.statistics WHERE index_name='ix_im_child_email' AND table_name='im_child'").await, 0, "index dropped");
}

/// T29 — Index/FK Manager DDL runs on PostgreSQL: create/drop index + add/drop FK,
/// exactly as genCreateIndex/genDropIndex/genAddForeignKey/genDropForeignKey emit.
#[tokio::test]
async fn pg_index_fk_crud() {
    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE TABLE im_parent (id int PRIMARY KEY)").await.unwrap();
    drv.exec("CREATE TABLE im_child (id int PRIMARY KEY, pid int, email text)").await.unwrap();

    async fn n(drv: &mut PgDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        result.rows[0]["n"].as_i64().unwrap()
    }

    drv.exec("CREATE INDEX \"ix_im_child_email\" ON \"public\".\"im_child\" (\"email\");").await.unwrap();
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'ix_im_child_email'").await, 1, "index created");
    drv.exec("ALTER TABLE \"public\".\"im_child\" ADD CONSTRAINT \"fk_im_child_parent\" FOREIGN KEY (\"pid\") REFERENCES \"public\".\"im_parent\" (\"id\");").await.unwrap();
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE constraint_name='fk_im_child_parent' AND constraint_type='FOREIGN KEY'").await, 1, "FK added");
    drv.exec("ALTER TABLE \"public\".\"im_child\" DROP CONSTRAINT \"fk_im_child_parent\";").await.unwrap();
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE constraint_name='fk_im_child_parent' AND constraint_type='FOREIGN KEY'").await, 0, "FK dropped");
    drv.exec("DROP INDEX IF EXISTS \"public\".\"ix_im_child_email\";").await.unwrap();
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'ix_im_child_email'").await, 0, "index dropped");
}

#[tokio::test]
async fn mariadb_roundtrip() {
    mysql_like_roundtrip(("mariadb", "11"), "MARIADB", "mariadb").await;
}

/// Phase 5 · T16 — MariaDB `ANALYZE FORMAT=JSON` (số liệu thực tế). Seed rows,
/// chạy ANALYZE, parse → mode=actual + node có actual_rows (r_rows).
#[tokio::test]
async fn mariadb_analyze_actual_plan() {
    use database_studio_lib::drivers::plan::{self, PlanNode};

    let c = GenericImage::new("mariadb", "11")
        .with_exposed_port(3306.tcp())
        .with_env_var("MARIADB_ROOT_PASSWORD", PASS)
        .with_env_var("MARIADB_DATABASE", "testdb")
        .start()
        .await
        .expect("start mariadb container");
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
    let mut drv = retry("mariadb", || MySqlDriver::connect(&params, "mariadb")).await;

    drv.exec("CREATE TABLE it_an (id int PRIMARY KEY, v varchar(20))").await.unwrap();
    drv.exec("INSERT INTO it_an VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')").await.unwrap();

    let out = drv.exec("ANALYZE FORMAT=JSON SELECT * FROM it_an WHERE v = 'c'").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("ANALYZE phải trả rows") };
    let cell = result.rows[0].as_object().unwrap().values().next().unwrap();
    let json = cell.as_str().map(String::from).unwrap_or_else(|| cell.to_string());

    let p = plan::parse_mysql(&json, "mariadb", true).expect("parse ANALYZE JSON");
    assert_eq!(p.mode, "actual", "ANALYZE → mode actual");
    let root = p.root.expect("có root");
    fn has_actual(n: &PlanNode) -> bool {
        n.actual_rows.is_some() || n.children.iter().any(has_actual)
    }
    assert!(has_actual(&root), "ANALYZE phải có actual_rows (r_rows). raw:\n{json}");
    eprintln!("CHK MariaDB ANALYZE actual OK");
}

// ---------------------------------------------------------------------------
// MSSQL
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mssql_roundtrip_and_line_error() {
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

    drv.exec("CREATE TABLE it_t (id int PRIMARY KEY, v nvarchar(50))").await.unwrap();
    let ins = drv.exec("INSERT INTO it_t VALUES (1, N'xin chào')").await.unwrap();
    assert!(matches!(ins, StatementOutcome::Affected { affected: 1 }));
    let out = drv.exec("SELECT TOP 1 v FROM it_t").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["v"], serde_json::json!("xin chào"));

    // MSSQL trả line number cho lỗi → position
    let err = drv.exec("SELECT 1\nFROM bang_khong_co").await.expect_err("phải fail");
    assert_eq!(err.code.as_deref(), Some("208"));
    assert!(err.position.is_some(), "MSSQL line phải map sang position");
}

/// AUDIT-3 item 4 — MSSQL Explorer must list every (user) database. `databases()`
/// returns the server catalog excluding the system DBs (master/tempdb/model/msdb).
#[tokio::test]
async fn mssql_list_databases_excludes_system() {
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

    drv.exec("CREATE DATABASE it_extra").await.unwrap();
    let dbs = drv.databases().await.unwrap();
    assert!(dbs.iter().any(|d| d.name == "it_extra"), "user database is listed");
    assert!(
        !dbs.iter().any(|d| matches!(d.name.as_str(), "master" | "tempdb" | "model" | "msdb")),
        "system databases are excluded",
    );
}

/// Phase 5 · T16 — MSSQL estimated plan qua `SET SHOWPLAN_XML ON`. Seed table,
/// bật SHOWPLAN → query trả XML plan (không thực thi) → parse → node tham chiếu
/// đúng bảng. Tắt SHOWPLAN sau cùng.
#[tokio::test]
async fn mssql_showplan_xml_estimated_plan() {
    use database_studio_lib::drivers::plan::{self, PlanNode};

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

    drv.exec("CREATE TABLE it_plan (id int PRIMARY KEY, v nvarchar(50))").await.unwrap();
    drv.exec("INSERT INTO it_plan VALUES (1,N'a'),(2,N'b'),(3,N'c')").await.unwrap();

    // Cùng 1 connection nên SET giữ trạng thái qua các exec kế tiếp.
    drv.exec("SET SHOWPLAN_XML ON").await.unwrap();
    let out = drv.exec("SELECT * FROM it_plan WHERE id = 2").await.unwrap();
    let _ = drv.exec("SET SHOWPLAN_XML OFF").await;

    let StatementOutcome::Rows { result } = out else { panic!("SHOWPLAN phải trả rows") };
    let cell = result.rows[0].as_object().unwrap().values().next().unwrap();
    let xml = cell.as_str().expect("XML string").to_string();
    assert!(xml.contains("ShowPlanXML"), "phải là SHOWPLAN_XML");

    let p = plan::parse_mssql_xml(&xml).expect("parse SHOWPLAN_XML");
    let root = p.root.expect("có root");
    fn refs_table(n: &PlanNode) -> bool {
        n.extra.get("Relation Name").and_then(|v| v.as_str()).map(|s| s.contains("it_plan")).unwrap_or(false)
            || n.children.iter().any(refs_table)
    }
    assert!(refs_table(&root), "plan phải tham chiếu it_plan. raw:\n{xml}");
    eprintln!("CHK MSSQL SHOWPLAN_XML OK");
}

// ---------------------------------------------------------------------------
// ClickHouse — HTTP 8123, kiểu dữ liệu cột + total ước lượng + lỗi có code
// (Phase 2 basics — CLICKHOUSE_SPEC_ADDENDUM)
// ---------------------------------------------------------------------------

/// T30 — Create a ClickHouse Materialized View + Dictionary (as emitted by
/// buildCreateMaterializedView / buildCreateDictionary). Both appear in the
/// system catalog.
#[tokio::test]
async fn clickhouse_create_mv_and_dictionary() {
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
    drv.exec("CREATE TABLE it_src (n UInt64, kind String) ENGINE = MergeTree ORDER BY n").await.unwrap();

    async fn n(drv: &mut ChDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        let v = result.rows[0].as_object().unwrap().values().next().unwrap();
        // CH returns UInt64 as a JSON string to preserve precision.
        v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap()
    }

    // Materialized view (ENGINE form, as buildCreateMaterializedView emits).
    drv.exec("CREATE MATERIALIZED VIEW default.mv_kind ENGINE = MergeTree() ORDER BY kind\nAS SELECT kind, count() AS c FROM it_src GROUP BY kind;").await.unwrap();
    assert!(n(&mut drv, "SELECT count() AS c FROM system.tables WHERE database='default' AND name='mv_kind'").await >= 1, "MV in catalog");

    // Dictionary (CLICKHOUSE source referencing it_src), as buildCreateDictionary emits.
    let dict = format!(
        "CREATE DICTIONARY default.dict_kind (\n  n UInt64,\n  kind String\n)\nPRIMARY KEY n\nSOURCE(CLICKHOUSE(TABLE 'it_src' DB 'default' USER 'default' PASSWORD '{PASS}'))\nLAYOUT(FLAT())\nLIFETIME(MIN 0 MAX 3600);"
    );
    drv.exec(&dict).await.unwrap();
    assert!(n(&mut drv, "SELECT count() AS c FROM system.dictionaries WHERE database='default' AND name='dict_kind'").await >= 1, "dictionary in catalog");
}

#[tokio::test]
async fn clickhouse_roundtrip_types_and_errors() {
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

    // DDL MergeTree + kiểu đặc thù CH
    drv.exec(
        "CREATE TABLE it_events (d Date, kind LowCardinality(String), note Nullable(String), n UInt64) \
         ENGINE = MergeTree ORDER BY n",
    )
    .await
    .unwrap();
    let ins = drv
        .exec("INSERT INTO it_events VALUES ('2026-07-01','click',NULL,1),('2026-07-02','view','ok',2)")
        .await
        .unwrap();
    assert!(matches!(ins, StatementOutcome::Affected { affected: 2 }), "{ins:?}");

    // SELECT: kiểu cột render đúng (LowCardinality/Nullable), NULL giữ nguyên
    let out = drv.exec("SELECT kind, note, n FROM it_events ORDER BY n").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.total, 2);
    let types: Vec<&str> = result.cols.iter().map(|c| c.1.as_str()).collect();
    assert!(types.contains(&"LowCardinality(String)"), "{types:?}");
    assert!(types.contains(&"Nullable(String)"), "{types:?}");
    assert!(result.rows[0]["note"].is_null(), "Nullable NULL phải giữ nguyên");

    // total = rows_before_limit (ước lượng server) khi có LIMIT
    let out = drv.exec("SELECT n FROM it_events ORDER BY n LIMIT 1").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows.len(), 1);
    assert!(result.total >= 2, "total phải là ước lượng trước LIMIT, got {}", result.total);

    // lỗi có code (60 = UNKNOWN_TABLE) + hint + raw
    let err = drv.exec("SELECT * FROM khong_ton_tai").await.expect_err("phải fail");
    assert_eq!(err.code.as_deref(), Some("60"), "{err:?}");
    assert!(err.hint.is_some());
    assert!(!err.raw.is_empty());

    // introspection cơ bản
    let schemas = drv.schemas().await.unwrap();
    assert!(schemas.iter().any(|s| s.name == "default" && s.is_default));
    assert!(schemas.iter().any(|s| s.name == "system"));
    let tables = drv.tables("default").await.unwrap();
    let t = tables.iter().find(|t| t.name == "it_events").expect("bảng vừa tạo");
    assert_eq!(t.kind, "table");
    let cols = drv.columns("default", "it_events").await.unwrap();
    let note = cols.iter().find(|c| c.name == "note").unwrap();
    assert!(note.nullable, "Nullable(...) → nullable=true");
    let n = cols.iter().find(|c| c.name == "n").unwrap();
    assert!(n.is_pk, "ORDER BY key → is_in_primary_key");

    // Phase 5 T7c: engine badge trong TableInfo
    assert_eq!(t.engine.as_deref(), Some("MergeTree"), "engine badge phải là MergeTree");

    // Phase 5 T7c: table_meta + parse TTL (DELETE + MOVE) từ CREATE thật
    drv.exec(
        "CREATE TABLE it_ttl (d Date, x UInt32) ENGINE = MergeTree ORDER BY x \
         TTL d + INTERVAL 90 DAY DELETE, d + INTERVAL 30 DAY TO VOLUME 'default'",
    )
    .await
    .unwrap();
    let meta = drv.table_meta("default", "it_ttl").await.unwrap();
    assert_eq!(meta.engine, "MergeTree");
    assert!(meta.create_sql.contains("TTL"), "create_sql phải chứa TTL: {}", meta.create_sql);
    assert!(meta.ttl_rules.len() >= 2, "phải parse >=2 TTL rule, got {:?}", meta.ttl_rules);
    assert!(meta.ttl_rules.iter().any(|r| r.action == "DELETE"), "{:?}", meta.ttl_rules);
    assert!(meta.ttl_rules.iter().any(|r| r.action == "MOVE"), "{:?}", meta.ttl_rules);
    // bảng không TTL → rỗng
    let meta2 = drv.table_meta("default", "it_events").await.unwrap();
    assert!(meta2.ttl_rules.is_empty(), "it_events không có TTL: {:?}", meta2.ttl_rules);

    // Phase 5 T7c-pt2: Dictionaries node (§3) — seed dictionary thật rồi query ngược.
    drv.exec("CREATE TABLE dict_src (id UInt64, name String) ENGINE = MergeTree ORDER BY id").await.unwrap();
    drv.exec("INSERT INTO dict_src VALUES (1, 'alpha')").await.unwrap();
    drv.exec(
        "CREATE DICTIONARY it_dict (id UInt64, name String) PRIMARY KEY id \
         SOURCE(CLICKHOUSE(TABLE 'dict_src')) LAYOUT(FLAT()) LIFETIME(0)",
    )
    .await
    .unwrap();
    let dicts = drv.dictionaries("default").await.unwrap();
    assert!(dicts.iter().any(|d| d == "it_dict"), "dictionaries phải liệt kê it_dict, got {dicts:?}");
}

// ---------------------------------------------------------------------------
// SQLite — file thật + in-memory, đủ 3 mode (không cần container)
// ---------------------------------------------------------------------------

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
    rw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();
    rw.exec("INSERT INTO t (name) VALUES ('a'), ('b')").await.unwrap();
    let out = rw.exec("SELECT * FROM t ORDER BY id").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.total, 2);
    assert_eq!(result.cols[1].0, "name");

    // read-only: write phải fail kèm hint
    let ro = SqliteDriver::connect(&SqliteConnParams {
        path: path.to_string_lossy().to_string(),
        mode: SqliteMode::ReadOnly,
    })
    .await
    .unwrap();
    let err = ro.exec("INSERT INTO t (name) VALUES ('c')").await.expect_err("RO phải chặn write");
    assert!(err.hint.unwrap_or_default().contains("Read-Only"));

    // in-memory: database độc lập
    let mem = SqliteDriver::connect(&SqliteConnParams { path: String::new(), mode: SqliteMode::InMemory })
        .await
        .unwrap();
    let err = mem.exec("SELECT * FROM t").await.expect_err("in-memory không thấy bảng file");
    assert!(err.message.contains("no such table"));
}

/// T25 — the PG→SQLite copy mapper (copy/types.ts) emits SQLite types
/// INTEGER/TEXT/REAL/NUMERIC/BLOB. Verify a real SQLite engine accepts that DDL
/// and data round-trips — i.e. the translated CREATE TABLE + INSERT actually run.
#[tokio::test]
async fn sqlite_accepts_copy_mapped_types() {
    let drv = SqliteDriver::connect(&SqliteConnParams { path: String::new(), mode: SqliteMode::InMemory })
        .await
        .unwrap();
    drv.exec(
        "CREATE TABLE copied (\"id\" INTEGER NOT NULL PRIMARY KEY, \"name\" TEXT, \"amount\" REAL, \"score\" NUMERIC, \"created\" TEXT, \"raw\" BLOB)",
    )
    .await
    .unwrap();
    let ins = drv
        .exec("INSERT INTO copied (\"id\",\"name\",\"amount\",\"score\",\"created\",\"raw\") VALUES (1,'An',1.5,3.9,'2024-01-01T00:00:00',NULL),(2,'Binh',2.0,NULL,'2025-02-02T00:00:00',NULL)")
        .await
        .unwrap();
    assert!(matches!(ins, StatementOutcome::Affected { affected: 2 }));
    let out = drv.exec("SELECT count(*) AS n FROM copied").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(2), "both rows copied");
    let s = drv.exec("SELECT name FROM copied WHERE id = 1").await.unwrap();
    let StatementOutcome::Rows { result } = s else { panic!("expected rows") };
    assert_eq!(result.rows[0]["name"], serde_json::json!("An"), "sample value round-trips");
}

#[tokio::test]
async fn sqlite_editable_grid_apply_and_rollback() {
    use database_studio_lib::drivers::grid::{Col, GridChange};
    use serde_json::json;

    let mem = SqliteDriver::connect(&SqliteConnParams { path: String::new(), mode: SqliteMode::InMemory })
        .await
        .unwrap();
    mem.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)").await.unwrap();
    mem.exec("INSERT INTO t VALUES (1,'a',10),(2,'b',20)").await.unwrap();

    // INSERT + UPDATE + DELETE trong 1 transaction
    let n = mem
        .apply_changes(vec![
            GridChange::Insert {
                schema: None,
                table: "t".into(),
                values: vec![
                    Col { name: "id".into(), value: json!(3), col_type: None },
                    Col { name: "name".into(), value: json!("c"), col_type: None },
                    Col { name: "n".into(), value: json!(30), col_type: None },
                ],
            },
            GridChange::Update {
                schema: None,
                table: "t".into(),
                pk: vec![Col { name: "id".into(), value: json!(1), col_type: None }],
                set: vec![Col { name: "name".into(), value: json!("A"), col_type: None }],
            },
            GridChange::Delete {
                schema: None,
                table: "t".into(),
                pk: vec![Col { name: "id".into(), value: json!(2), col_type: None }],
            },
        ])
        .await
        .unwrap();
    assert_eq!(n, 3);

    let out = mem.exec("SELECT id, name FROM t ORDER BY id").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("rows") };
    assert_eq!(result.total, 2); // 2 gốc - 1 xóa + 1 thêm
    assert_eq!(result.rows[0]["name"], json!("A")); // update áp dụng
    assert_eq!(result.rows[1]["id"], json!(3)); // insert áp dụng

    // rollback: 1 change hợp lệ + 1 change lỗi (cột không tồn tại) → không đổi gì
    let before = mem.exec("SELECT count(*) AS c FROM t").await.unwrap();
    let StatementOutcome::Rows { result: b } = before else { panic!("rows") };
    let count_before = b.rows[0]["c"].as_i64().unwrap();
    let err = mem
        .apply_changes(vec![
            GridChange::Update {
                schema: None,
                table: "t".into(),
                pk: vec![Col { name: "id".into(), value: json!(1), col_type: None }],
                set: vec![Col { name: "name".into(), value: json!("X"), col_type: None }],
            },
            GridChange::Insert {
                schema: None,
                table: "t".into(),
                values: vec![Col { name: "khong_co_cot".into(), value: json!(1), col_type: None }],
            },
        ])
        .await;
    assert!(err.is_err(), "batch lỗi phải fail");
    let after = mem.exec("SELECT name FROM t WHERE id = 1").await.unwrap();
    let StatementOutcome::Rows { result: a } = after else { panic!("rows") };
    assert_eq!(a.rows[0]["name"], json!("A"), "rollback: update 'X' không được commit");
    let cnt = mem.exec("SELECT count(*) AS c FROM t").await.unwrap();
    let StatementOutcome::Rows { result: c } = cnt else { panic!("rows") };
    assert_eq!(c.rows[0]["c"].as_i64().unwrap(), count_before);
}

#[tokio::test]
async fn pg_filter_sort_pagination() {
    use database_studio_lib::drivers::grid::{build_select, FilterCond, SortSpec};
    use serde_json::json;

    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE TABLE flt (id int PRIMARY KEY, status text, gpa numeric)").await.unwrap();
    drv.exec("INSERT INTO flt VALUES (1,'active',3.9),(2,'inactive',2.1),(3,'active',3.2),(4,'active',3.7)")
        .await
        .unwrap();

    // WHERE status='active' ORDER BY gpa DESC → 3 dòng, cao nhất trước
    let stmt = build_select(
        "postgres",
        &Some("public".into()),
        "flt",
        &[FilterCond { col: "status".into(), op: "=".into(), value: json!("active") }],
        false,
        &[SortSpec { col: "gpa".into(), desc: true }],
        100,
        0,
    );
    let out = drv.exec_params(&stmt.sql, &stmt.params).await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("rows") };
    assert_eq!(result.total, 3);
    assert_eq!(result.rows[0]["id"], json!(1)); // gpa 3.9 cao nhất

    // pagination: LIMIT 2 OFFSET 2 trên ORDER BY id
    let p = build_select("postgres", &Some("public".into()), "flt", &[], false, &[SortSpec { col: "id".into(), desc: false }], 2, 2);
    let out = drv.exec_params(&p.sql, &p.params).await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("rows") };
    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.rows[0]["id"], json!(3));

    // filter value là tham số → không injection
    let inj = build_select(
        "postgres",
        &Some("public".into()),
        "flt",
        &[FilterCond { col: "status".into(), op: "=".into(), value: json!("x'; DROP TABLE flt; --") }],
        false,
        &[],
        100,
        0,
    );
    let out = drv.exec_params(&inj.sql, &inj.params).await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("rows") };
    assert_eq!(result.total, 0); // không match, bảng vẫn còn
    let still = drv.exec("SELECT count(*) AS c FROM flt").await.unwrap();
    let StatementOutcome::Rows { result: s } = still else { panic!("rows") };
    assert_eq!(s.rows[0]["c"], json!(4), "bảng không bị DROP");
}

#[tokio::test]
async fn pg_editable_grid_apply_transaction() {
    use database_studio_lib::drivers::grid::{Col, GridChange};
    use serde_json::json;

    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE TABLE grid_t (id int PRIMARY KEY, name text, active bool)").await.unwrap();
    drv.exec("INSERT INTO grid_t VALUES (1,'a',true),(2,'b',false)").await.unwrap();

    let n = drv
        .apply_changes(&[
            GridChange::Update {
                schema: Some("public".into()),
                table: "grid_t".into(),
                pk: vec![Col { name: "id".into(), value: json!(1), col_type: None }],
                set: vec![
                    Col { name: "name".into(), value: json!("An"), col_type: None },
                    Col { name: "active".into(), value: json!(false), col_type: None },
                ],
            },
            GridChange::Insert {
                schema: Some("public".into()),
                table: "grid_t".into(),
                values: vec![
                    Col { name: "id".into(), value: json!(3), col_type: None },
                    Col { name: "name".into(), value: json!("Chi"), col_type: None },
                    Col { name: "active".into(), value: json!(true), col_type: None },
                ],
            },
        ])
        .await
        .unwrap();
    assert_eq!(n, 2);
    let out = drv.exec("SELECT name, active FROM grid_t WHERE id = 1").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("rows") };
    assert_eq!(result.rows[0]["name"], json!("An"));
    assert_eq!(result.rows[0]["active"], json!(false));
}

// A uuid primary key: the grid holds the PK value as a text string. Without the
// per-column ::type cast the UPDATE/DELETE WHERE fails with Postgres error
// "operator does not exist: uuid = text" (the bug this test guards).
#[tokio::test]
async fn pg_editable_grid_uuid_pk_updates_and_deletes() {
    use database_studio_lib::drivers::grid::{Col, GridChange};
    use serde_json::json;

    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE TABLE files (id uuid PRIMARY KEY, name varchar)").await.unwrap();
    let id1 = "019a8f69-cbe8-70cc-b784-000000000001";
    let id2 = "019a8f69-cbe8-70cc-b784-000000000002";
    drv.exec(&format!(
        "INSERT INTO files VALUES ('{id1}','a.png'),('{id2}','b.png')"
    ))
    .await
    .unwrap();

    // UPDATE name WHERE id = <uuid as text> — cast makes uuid = $n::uuid.
    // Also INSERT a new uuid row (text → uuid column) and DELETE by uuid.
    let id3 = "019a8f69-cbe8-70cc-b784-000000000003";
    let n = drv
        .apply_changes(&[
            GridChange::Update {
                schema: Some("public".into()),
                table: "files".into(),
                pk: vec![Col { name: "id".into(), value: json!(id1), col_type: Some("uuid".into()) }],
                set: vec![Col { name: "name".into(), value: json!("renamed.png"), col_type: Some("varchar".into()) }],
            },
            GridChange::Insert {
                schema: Some("public".into()),
                table: "files".into(),
                values: vec![
                    Col { name: "id".into(), value: json!(id3), col_type: Some("uuid".into()) },
                    Col { name: "name".into(), value: json!("c.png"), col_type: Some("varchar".into()) },
                ],
            },
            GridChange::Delete {
                schema: Some("public".into()),
                table: "files".into(),
                pk: vec![Col { name: "id".into(), value: json!(id2), col_type: Some("uuid".into()) }],
            },
        ])
        .await
        .unwrap();
    assert_eq!(n, 3);

    let out = drv.exec("SELECT id::text AS id, name FROM files ORDER BY name").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("rows") };
    assert_eq!(result.total, 2, "one row deleted, one inserted → still 2");
    assert_eq!(result.rows[0]["name"], json!("c.png"));
    assert_eq!(result.rows[0]["id"], json!(id3), "inserted uuid row present");
    assert_eq!(result.rows[1]["name"], json!("renamed.png"), "update applied to id1");
}

#[tokio::test]
async fn sqlite_pragma_panel_round_trip() {
    let dir = std::env::temp_dir().join("ds-it-sqlite");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pragma.db");
    let _ = std::fs::remove_file(&path);

    let drv = SqliteDriver::connect(&SqliteConnParams {
        path: path.to_string_lossy().to_string(),
        mode: SqliteMode::ReadWrite,
    })
    .await
    .unwrap();
    drv.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)").await.unwrap();

    // file_info đọc pragma thật
    let info = drv.file_info().await.unwrap();
    assert_eq!(info.version.split('.').count(), 3, "sqlite_version dạng x.y.z");
    assert!(!info.page_size.is_empty());

    // đổi journal_mode → WAL, đọc lại phải đúng (round-trip)
    drv.set_pragma("journal_mode", "wal").await.unwrap();
    let info = drv.file_info().await.unwrap();
    assert_eq!(info.journal_mode, "WAL");

    // foreign_keys ON
    drv.set_pragma("foreign_keys", "on").await.unwrap();
    assert_eq!(drv.file_info().await.unwrap().foreign_keys, "ON");

    // whitelist: key lạ / value lạ phải bị chặn (không nối chuỗi tự do)
    assert!(drv.set_pragma("secure_delete", "on").await.is_err(), "key ngoài whitelist");
    assert!(drv.set_pragma("journal_mode", "hacked; DROP TABLE t").await.is_err());

    // integrity_check → ok
    assert_eq!(drv.integrity_check().await.unwrap(), vec!["ok".to_string()]);
}

#[tokio::test]
async fn sqlite_introspection() {
    let mem = SqliteDriver::connect(&SqliteConnParams { path: String::new(), mode: SqliteMode::InMemory })
        .await
        .unwrap();
    mem.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)").await.unwrap();
    mem.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES parent(id))")
        .await
        .unwrap();

    let schemas = mem.schemas().await.unwrap();
    assert_eq!(schemas[0].name, "main");

    let tables = mem.tables("main").await.unwrap();
    let names: Vec<_> = tables.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"parent") && names.contains(&"child"));

    let cols = mem.columns("main", "child").await.unwrap();
    let pid = cols.iter().find(|c| c.name == "pid").unwrap();
    assert!(pid.is_fk, "FK flag từ foreign_key_list");
    assert!(!pid.nullable);
    let id = cols.iter().find(|c| c.name == "id").unwrap();
    assert!(id.is_pk);
}

// ---------------------------------------------------------------------------
// SSH tunnel — SSH server in-process (russh server API) + echo target.
// Kiểm thật: connect, auth password, direct-tcpip forward 2 chiều.
// ---------------------------------------------------------------------------

mod ssh_support {
    use std::sync::Arc;

    use russh::server::{self, Auth, Msg, Server as _, Session};
    use russh::Channel;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    #[derive(Clone)]
    pub struct TestSshServer;

    impl server::Server for TestSshServer {
        type Handler = TestHandler;
        fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> TestHandler {
            TestHandler
        }
    }

    pub struct TestHandler;

    impl server::Handler for TestHandler {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
            if user == "tester" && password == "test123" {
                Ok(Auth::Accept)
            } else {
                Ok(Auth::reject())
            }
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<Msg>,
            host_to_connect: &str,
            port_to_connect: u32,
            _originator_address: &str,
            _originator_port: u32,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            // forward thật tới target — như sshd làm
            let addr = format!("{host_to_connect}:{port_to_connect}");
            tokio::spawn(async move {
                if let Ok(mut target) = TcpStream::connect(addr).await {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut target).await;
                }
            });
            Ok(true)
        }
    }

    /// SSH server + echo TCP server, trả (ssh_port, echo_port).
    pub async fn start() -> (u16, u16) {
        // echo server: viết gì nhận lại nấy
        let echo = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = echo.accept().await else { break };
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = sock.read(&mut buf).await {
                        if n == 0 {
                            break;
                        }
                        if sock.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });

        let key = russh::keys::PrivateKey::random(
            &mut russh::keys::ssh_key::rand_core::OsRng,
            russh::keys::Algorithm::Ed25519,
        )
        .unwrap();
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let ssh_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut srv = TestSshServer;
            srv.run_on_socket(config, &listener).await.ok();
        });
        (ssh_port, echo_port)
    }
}

#[tokio::test]
async fn ssh_tunnel_forwards_and_rejects_bad_auth() {
    use database_studio_lib::connections::profile::{SshAuthMethod, SshConfig};
    use database_studio_lib::connections::tunnel::open_tunnel;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (ssh_port, echo_port) = ssh_support::start().await;
    let ssh = SshConfig {
        enabled: true,
        host: "127.0.0.1".into(),
        port: ssh_port,
        user: "tester".into(),
        auth: SshAuthMethod::Password,
        password_enc: String::new(),
        key_path: String::new(),
    };

    // auth sai → phải bị từ chối
    let bad = open_tunnel(&ssh, "sai-mat-khau", "127.0.0.1", echo_port).await;
    assert!(bad.is_err(), "auth sai phải lỗi");

    // auth đúng → forward 2 chiều qua tunnel
    let tunnel = open_tunnel(&ssh, "test123", "127.0.0.1", echo_port).await.unwrap();
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", tunnel.local_port)).await.unwrap();
    sock.write_all(b"xin chao qua tunnel").await.unwrap();
    let mut buf = [0u8; 64];
    let n = sock.read(&mut buf).await.unwrap();
    assert_eq!(&buf[..n], b"xin chao qua tunnel");
    tunnel.shutdown().await;
}

// ---------------------------------------------------------------------------
// Redis (Phase 3 · T2) — connect + AUTH + PING trên container thật
// ---------------------------------------------------------------------------

async fn start_redis(pass: &str) -> (ContainerAsync<GenericImage>, u16) {
    let c = GenericImage::new("redis", "7-alpine")
        .with_exposed_port(6379.tcp())
        .with_cmd(vec!["redis-server", "--requirepass", pass])
        .start()
        .await
        .expect("start redis container (Docker daemon phải đang chạy)");
    let port = c.get_host_port_ipv4(6379).await.unwrap();
    (c, port)
}

#[tokio::test]
async fn redis_connect_auth_ping_and_version() {
    use database_studio_lib::drivers::redis::{RedisConnParams, RedisDriver};

    let (_c, port) = start_redis("test123").await;
    let params = |pw: &str| RedisConnParams {
        host: "localhost".into(),
        port,
        password: pw.into(),
        db: 0,
        ssl: false,
        ssl_ca: String::new(),
    };

    // password đúng → connect + PING + INFO version
    let p_ok = params("test123");
    let mut drv = retry("redis", || RedisDriver::connect(&p_ok)).await;
    assert!(drv.ping().await, "PING phải thành công");
    let t = RedisDriver::test(&p_ok).await;
    assert!(t.ok, "test connection phải OK");
    assert!(
        t.server_version.as_deref().unwrap_or("").starts_with("Redis"),
        "phải parse được redis_version, nhận: {:?}",
        t.server_version
    );

    // Nạp key qua connection thô (redis crate) rồi kiểm SCAN + TYPE + TTL.
    let client = redis::Client::open(format!("redis://:test123@localhost:{port}/0")).unwrap();
    let mut raw = client.get_multiplexed_async_connection().await.unwrap();
    let _: () = redis::cmd("SET").arg("user:1").arg("a").query_async(&mut raw).await.unwrap();
    let _: () = redis::cmd("SET").arg("user:2").arg("b").query_async(&mut raw).await.unwrap();
    let _: () = redis::cmd("HSET").arg("acct:1").arg("f").arg("v").query_async(&mut raw).await.unwrap();
    let _: () = redis::cmd("EXPIRE").arg("user:1").arg(100).query_async(&mut raw).await.unwrap();

    // gom hết key qua nhiều vòng SCAN (cursor tới khi 0)
    let mut all = Vec::new();
    let mut cursor = 0u64;
    loop {
        let (next, keys) = drv.scan("*", cursor, 100).await.unwrap();
        all.extend(keys);
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    let user1 = all.iter().find(|k| k.name == "user:1").expect("phải thấy user:1");
    assert_eq!(user1.key_type, "string");
    assert!(user1.ttl > 0 && user1.ttl <= 100, "TTL phải ~100s, nhận {}", user1.ttl);
    let acct = all.iter().find(|k| k.name == "acct:1").expect("phải thấy acct:1");
    assert_eq!(acct.key_type, "hash");
    assert_eq!(acct.ttl, -1, "acct:1 không set TTL → -1");

    // --- get_value theo từng kiểu (T4) ---
    use database_studio_lib::drivers::redis::RedisValue;
    let _: () = redis::cmd("RPUSH").arg("mylist").arg("a").arg("b").arg("c").query_async(&mut raw).await.unwrap();
    let _: () = redis::cmd("SADD").arg("myset").arg("x").arg("y").query_async(&mut raw).await.unwrap();
    let _: () = redis::cmd("ZADD").arg("myz").arg(1.5).arg("lo").arg(9.0).arg("hi").query_async(&mut raw).await.unwrap();

    match drv.get_value("user:1").await.unwrap().value {
        RedisValue::String { value } => assert_eq!(value, "a"),
        other => panic!("string mong đợi, nhận {other:?}"),
    }
    match drv.get_value("acct:1").await.unwrap().value {
        RedisValue::Hash { fields } => assert!(fields.iter().any(|(f, v)| f == "f" && v == "v")),
        other => panic!("hash mong đợi, nhận {other:?}"),
    }
    match drv.get_value("mylist").await.unwrap().value {
        RedisValue::List { items } => assert_eq!(items, vec!["a", "b", "c"]),
        other => panic!("list mong đợi, nhận {other:?}"),
    }
    match drv.get_value("myset").await.unwrap().value {
        RedisValue::Set { mut members } => {
            members.sort();
            assert_eq!(members, vec!["x", "y"]);
        }
        other => panic!("set mong đợi, nhận {other:?}"),
    }
    match drv.get_value("myz").await.unwrap().value {
        RedisValue::Zset { members } => {
            assert_eq!(members[0], ("lo".into(), 1.5));
            assert_eq!(members[1], ("hi".into(), 9.0));
        }
        other => panic!("zset mong đợi, nhận {other:?}"),
    }

    // --- apply_edit (T4b) ---
    use database_studio_lib::drivers::redis::RedisEditOp;
    drv.apply_edit("newstr", RedisEditOp::SetString { value: "hello".into() }).await.unwrap();
    match drv.get_value("newstr").await.unwrap().value {
        RedisValue::String { value } => assert_eq!(value, "hello"),
        other => panic!("SET string, nhận {other:?}"),
    }
    drv.apply_edit("acct:1", RedisEditOp::HSet { field: "role".into(), value: "admin".into() }).await.unwrap();
    match drv.get_value("acct:1").await.unwrap().value {
        RedisValue::Hash { fields } => assert!(fields.iter().any(|(f, v)| f == "role" && v == "admin")),
        other => panic!("HSET, nhận {other:?}"),
    }
    drv.apply_edit("acct:1", RedisEditOp::HDel { field: "role".into() }).await.unwrap();
    match drv.get_value("acct:1").await.unwrap().value {
        RedisValue::Hash { fields } => assert!(!fields.iter().any(|(f, _)| f == "role"), "role phải bị HDEL"),
        other => panic!("hash sau HDEL, nhận {other:?}"),
    }
    drv.apply_edit("myset", RedisEditOp::SAdd { member: "z".into() }).await.unwrap();
    match drv.get_value("myset").await.unwrap().value {
        RedisValue::Set { members } => assert!(members.contains(&"z".to_string())),
        other => panic!("SADD, nhận {other:?}"),
    }

    // CLI command + MEMORY USAGE (T5/T7)
    assert_eq!(drv.command(&["PING".into()]).await.unwrap(), "PONG");
    assert!(drv.memory_usage("acct:1").await.unwrap().unwrap_or(0) > 0, "MEMORY USAGE > 0");

    // set_ttl (EXPIRE) rồi del
    drv.set_ttl("mylist", 50).await.unwrap();
    let after = drv.get_value("mylist").await.unwrap();
    assert!(after.ttl > 0 && after.ttl <= 50, "TTL sau EXPIRE ~50s, nhận {}", after.ttl);
    assert_eq!(drv.del("mylist").await.unwrap(), 1, "DEL trả 1");
    assert!(matches!(drv.get_value("mylist").await.unwrap().value, RedisValue::None), "key đã xóa → none");

    // --- Pub/Sub (T6): subscribe pattern rồi PUBLISH → nhận đúng message ---
    use futures::StreamExt;
    let mut pubsub = RedisDriver::open_pubsub(&p_ok).await.unwrap();
    pubsub.psubscribe("news.*").await.unwrap();
    // publish qua driver chính (connection khác) sau khi subscriber đã sẵn sàng
    let n = drv.publish("news.tech", "hello-pubsub").await.unwrap();
    assert_eq!(n, 1, "PUBLISH phải tới 1 subscriber");
    let msg = tokio::time::timeout(Duration::from_secs(5), pubsub.on_message().next())
        .await
        .expect("không nhận được message trong 5s")
        .expect("stream đóng sớm");
    assert_eq!(msg.get_channel_name(), "news.tech");
    assert_eq!(msg.get_payload::<String>().unwrap(), "hello-pubsub");
    drop(pubsub);

    // FLUSHDB xóa sạch (T7) — làm cuối cùng
    drv.flushdb().await.unwrap();
    assert_eq!(drv.dbsize().await.unwrap(), 0, "FLUSHDB → DBSIZE 0");

    // password sai/thiếu → NOAUTH, connect phải lỗi
    let p_bad = params("");
    let bad = RedisDriver::connect(&p_bad).await;
    assert!(bad.is_err(), "thiếu password phải bị NOAUTH từ chối");
}

// ---------------------------------------------------------------------------
// NATS (Phase 3 · T8) — connect + test + ping trên container thật
// ---------------------------------------------------------------------------

async fn start_nats() -> (ContainerAsync<GenericImage>, u16) {
    let c = GenericImage::new("nats", "2.10-alpine")
        .with_exposed_port(4222.tcp())
        .start()
        .await
        .expect("start nats container (Docker daemon phải đang chạy)");
    let port = c.get_host_port_ipv4(4222).await.unwrap();
    (c, port)
}

#[tokio::test]
async fn nats_connect_test_and_ping() {
    use database_studio_lib::drivers::nats::{NatsConnParams, NatsDriver};

    let (_c, port) = start_nats().await;
    let params = NatsConnParams {
        host: "localhost".into(),
        port,
        user: String::new(),
        password: String::new(),
        ssl: false,
    };

    let mut drv = retry("nats", || NatsDriver::connect(&params)).await;
    assert!(drv.ping().await, "connection_state phải Connected");

    let t = NatsDriver::test(&params).await;
    assert!(t.ok, "test connection phải OK");
    assert!(
        t.server_version.as_deref().unwrap_or("").starts_with("NATS"),
        "phải parse được server version, nhận: {:?}",
        t.server_version
    );

    // --- pub/sub (T9): subscribe wildcard rồi publish → nhận đúng ---
    use futures::StreamExt;
    let mut sub = drv.subscribe("demo.>".into()).await.unwrap();
    drv.publish("demo.a".into(), "hi".into(), None).await.unwrap();
    let msg = tokio::time::timeout(Duration::from_secs(5), sub.next())
        .await
        .expect("không nhận được message trong 5s")
        .expect("subscription đóng sớm");
    assert_eq!(msg.subject.to_string(), "demo.a");
    assert_eq!(String::from_utf8_lossy(&msg.payload), "hi");

    // --- request/reply (T9): responder echo lại payload ---
    let client = drv.client();
    let mut svc = client.subscribe("svc.echo").await.unwrap();
    let responder = tokio::spawn(async move {
        if let Some(m) = svc.next().await {
            if let Some(reply) = m.reply {
                let _ = client.publish(reply, m.payload).await;
                let _ = client.flush().await;
            }
        }
    });
    let resp = drv.request("svc.echo".into(), "ping".into(), 3000).await.unwrap();
    assert_eq!(resp, "ping", "request/reply phải echo lại payload");
    responder.abort();
}

#[tokio::test]
async fn nats_jetstream_streams_consumers_peek() {
    use async_nats::jetstream;
    use database_studio_lib::drivers::nats::{NatsConnParams, NatsDriver};

    // NATS bật JetStream (-js)
    let c = GenericImage::new("nats", "2.10-alpine")
        .with_exposed_port(4222.tcp())
        .with_cmd(vec!["-js"])
        .start()
        .await
        .expect("start nats -js");
    let port = c.get_host_port_ipv4(4222).await.unwrap();
    let params = NatsConnParams { host: "localhost".into(), port, user: String::new(), password: String::new(), ssl: false };
    let drv = retry("nats-js", || NatsDriver::connect(&params)).await;

    // tạo stream + publish + consumer qua jetstream context
    let js = jetstream::new(drv.client());
    js.create_stream(jetstream::stream::Config {
        name: "ORDERS".into(),
        subjects: vec!["orders.>".into()],
        ..Default::default()
    })
    .await
    .unwrap();
    js.publish("orders.new", bytes::Bytes::from_static(b"hello"))
        .await
        .unwrap()
        .await
        .unwrap();
    let stream = js.get_stream("ORDERS").await.unwrap();
    stream
        .create_consumer(jetstream::consumer::pull::Config {
            durable_name: Some("proc".into()),
            ..Default::default()
        })
        .await
        .unwrap();

    // driver methods
    let streams = drv.js_streams().await.unwrap();
    let orders = streams.iter().find(|s| s.name == "ORDERS").expect("phải thấy stream ORDERS");
    assert!(orders.messages >= 1, "ORDERS phải có >=1 message");
    assert_eq!(orders.subjects, vec!["orders.>".to_string()]);

    let cons = drv.js_consumers("ORDERS").await.unwrap();
    assert!(cons.iter().any(|c| c.name == "proc"), "phải thấy consumer proc");

    let msg = drv.js_peek("ORDERS", 1).await.unwrap();
    assert_eq!(msg.seq, 1);
    assert_eq!(msg.subject, "orders.new");
    assert_eq!(msg.payload, "hello");

    // --- Phase 4 · T9: stream mgmt + KV + Object store ---
    // create/purge/delete stream
    drv.js_create_stream("T9S".into(), vec!["t9.>".into()]).await.unwrap();
    drv.js_purge_stream("ORDERS").await.unwrap();
    drv.js_delete_stream("T9S").await.unwrap();
    // create/delete consumer + delete message trên ORDERS
    drv.js_create_consumer("ORDERS", "t9cons".into(), String::new()).await.unwrap();
    drv.js_delete_consumer("ORDERS", "t9cons").await.unwrap();

    // KV Store: create → put → get → keys → delete → delete bucket
    drv.kv_create("t9kv".into()).await.unwrap();
    drv.kv_put("t9kv", "greeting", "xin chào".into()).await.unwrap();
    assert_eq!(drv.kv_get("t9kv", "greeting").await.unwrap().as_deref(), Some("xin chào"));
    assert!(drv.kv_keys("t9kv").await.unwrap().contains(&"greeting".to_string()));
    assert!(drv.kv_buckets().await.unwrap().contains(&"t9kv".to_string()));
    drv.kv_delete("t9kv", "greeting").await.unwrap();
    drv.kv_delete_bucket("t9kv").await.unwrap();

    // Object Store: create → upload file → list → download file (verify) → delete
    drv.obj_create("t9obj".into()).await.unwrap();
    let up = std::env::temp_dir().join("dbstudio_t9_up.txt");
    let down = std::env::temp_dir().join("dbstudio_t9_down.txt");
    tokio::fs::write(&up, b"object-payload").await.unwrap();
    drv.obj_put_file("t9obj", "blob.txt".into(), up.to_str().unwrap()).await.unwrap();
    let objs = drv.obj_list("t9obj").await.unwrap();
    assert!(objs.iter().any(|o| o.name == "blob.txt"), "phải thấy object blob.txt");
    drv.obj_get_file("t9obj", "blob.txt", down.to_str().unwrap()).await.unwrap();
    assert_eq!(tokio::fs::read(&down).await.unwrap(), b"object-payload");
    drv.obj_delete("t9obj", "blob.txt").await.unwrap();
    drv.obj_delete_bucket("t9obj").await.unwrap();
    let _ = tokio::fs::remove_file(&up).await;
    let _ = tokio::fs::remove_file(&down).await;
}

// ---------------------------------------------------------------------------
// Kafka (Phase 4 · T1) — connect + metadata trên container thật
// (testcontainers-modules tự xử lý advertised.listeners)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn kafka_connect_and_metadata() {
    use database_studio_lib::drivers::kafka::{KafkaConnParams, KafkaDriver};
    use testcontainers_modules::kafka::{Kafka, KAFKA_PORT};

    let node = Kafka::default().start().await.expect("start kafka container");
    let port = node.get_host_port_ipv4(KAFKA_PORT).await.unwrap();
    let params = KafkaConnParams {
        bootstrap: format!("127.0.0.1:{port}"),
        sasl_mechanism: String::new(),
        user: String::new(),
        password: String::new(),
        ssl: false,
    };

    let mut drv = retry("kafka", || KafkaDriver::connect(&params)).await;
    assert!(drv.ping().await, "ping (fetch_metadata) phải OK");
    let t = KafkaDriver::test(&params).await;
    assert!(t.ok, "test connection phải OK");
    assert!(
        t.server_version.as_deref().unwrap_or("").contains("broker"),
        "server_version phải có broker count, nhận: {:?}",
        t.server_version
    );

    eprintln!("CHK connect+test OK");

    // --- cluster overview (T2) ---
    let cluster = drv.cluster_info().await.unwrap();
    assert!(!cluster.brokers.is_empty(), "phải có >=1 broker");
    eprintln!("CHK cluster_info OK ({} brokers)", cluster.brokers.len());

    // --- topic browser (T3): create → list → delete (RF=1 vì single-node) ---
    drv.create_topic("phase4_itest", 2, 1).await.unwrap();
    eprintln!("CHK create_topic OK");
    let mut found = None;
    for _ in 0..20 {
        let list = drv.topics().await.unwrap();
        if let Some(t) = list.into_iter().find(|t| t.name == "phase4_itest") {
            found = Some(t);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let topic = found.expect("phải thấy topic phase4_itest sau create");
    assert_eq!(topic.partitions.len(), 2, "phải có 2 partitions");
    assert!(!topic.internal);
    eprintln!("CHK topics() OK");

    // --- produce (T5) → consume (T4) round-trip ---
    use database_studio_lib::drivers::kafka::borrowed_to_message;
    use rdkafka::consumer::Consumer;
    let (_part, off) = drv.produce("phase4_itest", "k1", "hello-kafka", Some(0)).await.unwrap();
    assert!(off >= 0, "offset produce phải >= 0");
    eprintln!("CHK produce OK (offset {off})");
    // BaseConsumer (assign, không group) — build trước, chỉ move consumer vào
    // spawn_blocking để poll + drop trong đúng thread poll (tránh deadlock close rdkafka).
    let consumer = drv.browse_consumer("phase4_itest", "earliest", 0, None).unwrap();
    eprintln!("CHK browse_consumer created");
    let value = tokio::task::spawn_blocking(move || -> String {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut out = String::new();
        while Instant::now() < deadline {
            if let Some(Ok(m)) = consumer.poll(Duration::from_millis(500)) {
                out = borrowed_to_message(&m).value;
                break;
            }
        }
        drop(consumer); // drop trong thread poll → close sạch
        out
    })
    .await
    .unwrap();
    assert_eq!(value, "hello-kafka", "consume phải nhận đúng payload");
    eprintln!("CHK consume OK");

    // --- consumer groups + lag + reset (T6) ---
    drv.reset_group_offset("itest_group".into(), "phase4_itest".into(), 0, "offset".into(), 0)
        .await
        .unwrap();
    eprintln!("CHK reset_offset OK");
    let lag = drv.group_lag("itest_group".into()).await.unwrap();
    let p0 = lag
        .iter()
        .find(|l| l.topic == "phase4_itest" && l.partition == 0)
        .expect("phải có lag cho partition 0");
    assert_eq!(p0.committed, 0, "committed = 0 sau reset");
    assert_eq!(p0.high, 1, "high = 1 (đã produce 1 message vào p0)");
    assert_eq!(p0.lag, 1, "lag = high - committed = 1");
    eprintln!("CHK group_lag OK");
    let groups = drv.consumer_groups().await.unwrap();
    assert!(groups.iter().any(|g| g.name == "itest_group"), "consumer_groups phải liệt kê itest_group");
    eprintln!("CHK consumer_groups OK");

    // cleanup bọc timeout — round-trip đã PASS, cleanup treo không fail test.
    let _ = tokio::time::timeout(Duration::from_secs(30), drv.delete_topic("phase4_itest")).await;
    eprintln!("CHK delete_topic done — test end");
}

// ---------------------------------------------------------------------------
// Cassandra (Phase 4b) — 6 kịch bản self-test của CASSANDRA_SPEC_ADDENDUM §9
// ---------------------------------------------------------------------------

async fn start_cassandra() -> (ContainerAsync<GenericImage>, u16) {
    // Cassandra khởi động chậm (gossip + CQL, ~60-90s). Không dùng WaitFor log
    // (dễ StartupTimeout); để retry() 240s xử lý CQL readiness như pg/redis/nats.
    let c = GenericImage::new("cassandra", "5.0")
        .with_exposed_port(9042.tcp())
        .with_env_var("HEAP_NEWSIZE", "128M")
        .with_env_var("MAX_HEAP_SIZE", "512M")
        .start()
        .await
        .expect("start cassandra container (Docker daemon phải đang chạy)");
    let port = c.get_host_port_ipv4(9042).await.unwrap();
    (c, port)
}

#[tokio::test]
async fn cassandra_cql_semantics_paging_and_ddl_roundtrip() {
    use database_studio_lib::drivers::cassandra::{CassandraConnParams, CassandraDriver};

    let (_c, port) = start_cassandra().await;
    let params = CassandraConnParams {
        contact_points: vec![format!("127.0.0.1:{port}")],
        user: String::new(),
        password: String::new(),
        datacenter: "datacenter1".into(), // default DC name của image cassandra
        consistency: "ONE".into(),
        keyspace: String::new(),
        ssl: false,
        ssl_ca: String::new(),
    };

    // Node nhận control-connection trước khi sẵn sàng nhận query → reconnect tới
    // khi ping (query thật) OK. Deadline 240s cho Cassandra khởi động chậm.
    let drv = {
        let deadline = Instant::now() + Duration::from_secs(240);
        let mut last = String::new();
        loop {
            // testcontainers: node quảng bá IP nội bộ → dịch mọi địa chỉ về
            // 127.0.0.1:mapped_port để pool kết nối được từ host.
            match CassandraDriver::connect_translating_to(&params, "127.0.0.1", port).await {
                Ok(d) => match d
                    .exec_cql("SELECT release_version FROM system.local", None, None)
                    .await
                {
                    Ok(_) => break d,
                    Err(e) => last = format!("query: {}", e.message),
                },
                Err(e) => last = format!("connect: {}", e.message),
            }
            if Instant::now() >= deadline {
                panic!("cassandra: hết 240s chờ node sẵn sàng — lỗi cuối: {last}");
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    };
    eprintln!("CHK connect + ping OK");

    // --- setup: keyspace + bảng composite PK + clustering order + dữ liệu ---
    drv.exec_cql(
        "CREATE KEYSPACE IF NOT EXISTS itest_ks WITH replication = \
         {'class': 'SimpleStrategy', 'replication_factor': 1}",
        None,
        None,
    )
    .await
    .expect("create keyspace");
    drv.exec_cql(
        "CREATE TABLE itest_ks.grades ( \
           student_id int, term text, course text, grade text, \
           PRIMARY KEY ((student_id, term), course) \
         ) WITH CLUSTERING ORDER BY (course DESC)",
        None,
        None,
    )
    .await
    .expect("create table");
    for i in 0..7 {
        drv.exec_cql(
            &format!(
                "INSERT INTO itest_ks.grades (student_id, term, course, grade) \
                 VALUES (1, 'Fall2025', 'CS{i}', 'A')"
            ),
            None,
            None,
        )
        .await
        .expect("insert");
    }
    eprintln!("CHK setup keyspace/table/rows OK");

    // (1) SELECT đủ partition key → trả rows.
    let r1 = drv
        .exec_cql(
            "SELECT course, grade FROM itest_ks.grades WHERE student_id = 1 AND term = 'Fall2025'",
            None,
            None,
        )
        .await
        .expect("select theo full PK phải chạy");
    match r1.outcome {
        StatementOutcome::Rows { result } => assert_eq!(result.rows.len(), 7, "phải 7 rows"),
        _ => panic!("phải là Rows"),
    }
    eprintln!("CHK (1) SELECT full partition key → rows OK");

    // (2) WHERE trên cột non-index KHÔNG ALLOW FILTERING → lỗi từ driver.
    let r2 = drv
        .exec_cql("SELECT * FROM itest_ks.grades WHERE grade = 'A'", None, None)
        .await;
    assert!(r2.is_err(), "WHERE cột non-index thiếu ALLOW FILTERING phải LỖI, nhận: {r2:?}");
    eprintln!("CHK (2) WHERE non-index no ALLOW FILTERING → error OK");

    // (3) Cùng query + ALLOW FILTERING → chạy được.
    let r3 = drv
        .exec_cql(
            "SELECT * FROM itest_ks.grades WHERE grade = 'A' ALLOW FILTERING",
            None,
            None,
        )
        .await
        .expect("ALLOW FILTERING phải chạy");
    assert!(matches!(r3.outcome, StatementOutcome::Rows { .. }), "ALLOW FILTERING phải trả rows");
    eprintln!("CHK (3) ALLOW FILTERING → rows OK");

    // (4) JOIN → driver từ chối (CQL không có JOIN → SyntaxError/InvalidRequest).
    let r4 = drv
        .exec_cql("SELECT * FROM itest_ks.grades JOIN x ON a = b", None, None)
        .await;
    assert!(r4.is_err(), "JOIN phải bị từ chối");
    eprintln!("CHK (4) JOIN → rejected OK");

    // (5) Paging: page_size nhỏ → có next_page; fetch trang 2 qua paging state.
    let p1 = drv
        .exec_cql(
            "SELECT course FROM itest_ks.grades WHERE student_id = 1 AND term = 'Fall2025'",
            Some(3),
            None,
        )
        .await
        .expect("page 1");
    let n1 = match &p1.outcome {
        StatementOutcome::Rows { result } => result.rows.len(),
        _ => panic!("page1 phải Rows"),
    };
    assert!(p1.next_page.is_some(), "trang 1 (size 3/7) phải còn next_page");
    let p2 = drv
        .exec_cql(
            "SELECT course FROM itest_ks.grades WHERE student_id = 1 AND term = 'Fall2025'",
            Some(3),
            p1.next_page.as_deref(),
        )
        .await
        .expect("page 2 qua paging state");
    let n2 = match &p2.outcome {
        StatementOutcome::Rows { result } => result.rows.len(),
        _ => panic!("page2 phải Rows"),
    };
    assert!(n1 <= 3 && n2 >= 1, "paging: trang 1 ≤3 rows, trang 2 có thêm rows (n1={n1}, n2={n2})");
    eprintln!("CHK (5) paging state trang 2 OK (n1={n1}, n2={n2})");

    // (6) DDL round-trip: đọc lại metadata thấy đúng composite PK + clustering.
    let ddl = drv.table_ddl("itest_ks", "grades").await.expect("table_ddl");
    assert!(
        ddl.contains("PRIMARY KEY ((student_id, term), course)"),
        "DDL phải giữ composite partition key: {ddl}"
    );
    assert!(ddl.contains("CLUSTERING ORDER BY (course DESC)"), "DDL phải giữ clustering order: {ddl}");
    // introspection tree phản ánh đúng kind cột
    let tree = drv.keyspace_tree("itest_ks").await.expect("keyspace_tree");
    let grades = tree.tables.iter().find(|t| t.name == "grades").expect("thấy table grades");
    let parts: Vec<&str> = grades
        .columns
        .iter()
        .filter(|c| c.kind == "partition_key")
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(parts, vec!["student_id", "term"], "2 partition key đúng thứ tự");
    assert!(
        grades.columns.iter().any(|c| c.name == "course" && c.kind == "clustering"),
        "course phải là clustering"
    );
    eprintln!("CHK (6) DDL + metadata round-trip composite PK OK — test end");
}

/// Schema Registry (T7) — Confluent REST API là HTTP thuần (như driver ClickHouse
/// qua HTTP). Container `cp-schema-registry` cần cả Kafka + shared network + JVM
/// khởi động chậm → dễ EXIT=124. Thay bằng HTTP server in-process phục vụ đúng
/// JSON Confluent để kiểm ĐƯỜNG THẬT: reqwest, dựng URL, parse, và fallback
/// compat (config/{subject} 404 → config global). Deterministic, không cần Docker.
mod schema_registry_http {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread;

    use database_studio_lib::drivers::schema_registry::{
        SchemaRegistryClient, SchemaRegistryParams,
    };

    fn respond(stream: &mut std::net::TcpStream, status: &str, body: &str) {
        let resp = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
    }

    /// Bật SR mock trên cổng ephemeral, trả về base_url. Server chạy nền, dừng
    /// khi test kết thúc (thread daemon).
    fn start_mock() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock SR");
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                // "GET /path HTTP/1.1"
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                match path.as_str() {
                    "/subjects" => respond(&mut stream, "200 OK", r#"["a-value","b-value"]"#),
                    // a-value: schemaType vắng → phải chuẩn hoá thành AVRO
                    "/subjects/a-value/versions/latest" => respond(
                        &mut stream,
                        "200 OK",
                        r#"{"id":11,"version":2,"schema":"{\"type\":\"string\"}"}"#,
                    ),
                    "/subjects/b-value/versions/latest" => respond(
                        &mut stream,
                        "200 OK",
                        r#"{"id":5,"version":1,"schema":"{}","schemaType":"JSON"}"#,
                    ),
                    "/subjects/a-value/versions" => respond(&mut stream, "200 OK", "[1,2]"),
                    "/subjects/a-value/versions/1" => respond(
                        &mut stream,
                        "200 OK",
                        r#"{"id":10,"version":1,"schema":"{\"type\":\"int\"}"}"#,
                    ),
                    // a-value không có compat override → 404 → client fallback /config global
                    "/config/a-value" => respond(&mut stream, "404 Not Found", r#"{"error_code":40401}"#),
                    "/config/b-value" => {
                        respond(&mut stream, "200 OK", r#"{"compatibilityLevel":"NONE"}"#)
                    }
                    "/config" => respond(&mut stream, "200 OK", r#"{"compatibilityLevel":"BACKWARD"}"#),
                    _ => respond(&mut stream, "404 Not Found", "{}"),
                }
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn schema_registry_subjects_versions_schema_and_compat_fallback() {
        let base_url = start_mock();
        let client = SchemaRegistryClient::new(SchemaRegistryParams {
            base_url,
            user: String::new(),
            password: String::new(),
        })
        .unwrap();

        // subjects: fmt normalise + latest + compat (b override, a global fallback)
        let subs = client.subjects().await.unwrap();
        assert_eq!(subs.len(), 2);
        let a = subs.iter().find(|s| s.name == "a-value").unwrap();
        assert_eq!(a.fmt, "AVRO", "schemaType vắng phải hoá AVRO");
        assert_eq!(a.latest, 2);
        assert_eq!(a.compat, "BACKWARD", "a không có override → global BACKWARD");
        let b = subs.iter().find(|s| s.name == "b-value").unwrap();
        assert_eq!(b.fmt, "JSON");
        assert_eq!(b.compat, "NONE", "b có override NONE");
        eprintln!("CHK SR subjects OK");

        // versions
        assert_eq!(client.versions("a-value").await.unwrap(), vec![1, 2]);
        eprintln!("CHK SR versions OK");

        // schema cụ thể
        let sc = client.schema("a-value", 1).await.unwrap();
        assert_eq!(sc.version, 1);
        assert_eq!(sc.id, 10);
        assert_eq!(sc.fmt, "AVRO");
        assert!(sc.schema.contains("int"));
        assert_eq!(sc.compat, "BACKWARD");
        eprintln!("CHK SR schema OK — test end");
    }
}

// ---------------------------------------------------------------------------
// T10 — Connection Test/Cancel: bounded timeout + real abort (dùng PG container)
// ---------------------------------------------------------------------------
#[tokio::test]
async fn connection_test_bounded_and_cancellable() {
    use database_studio_lib::commands::connections::{connect_timeout, run_test_bounded};
    use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
    use database_studio_lib::drivers::types::SystemType;
    use tokio_util::sync::CancellationToken;

    fn pg_profile(host: &str, port: u16) -> ConnectionProfile {
        ConnectionProfile {
            id: "t".into(),
            name: "t".into(),
            system: SystemType::Postgres,
            host: host.into(),
            port,
            database: "testdb".into(),
            user: "postgres".into(),
            password_enc: String::new(),
            group: String::new(),
            env: Environment::Development,
            ssh: SshConfig::default(),
            ssl: false,
            ssl_ca: String::new(),
            ssl_cert: String::new(),
            ssl_key: String::new(),
            sqlite_path: String::new(),
            sqlite_mode: SqliteMode::ReadWrite,
            mssql_auth: String::new(),
            schema_registry_url: String::new(),
            cassandra_dc: String::new(),
            cassandra_consistency: String::new(),
        }
    }

    let (_c, port) = start_pg().await;

    // (a) live PG → ok + latency (retry vì container mới bật cần vài giây)
    let live = pg_profile("localhost", port);
    let ok = {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let r = run_test_bounded(&live, PASS, "", connect_timeout(), CancellationToken::new()).await;
            if r.ok {
                break r;
            }
            assert!(Instant::now() < deadline, "PG test không ok: {:?}", r.error);
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    };
    assert!(ok.latency_ms.is_some(), "live test phải có latency");
    eprintln!("CHK (a) live PG test OK");

    // (b) closed port → ✗ có message rõ, trả NHANH (< timeout, không treo)
    let started = Instant::now();
    let refused = run_test_bounded(&pg_profile("127.0.0.1", 1), PASS, "", connect_timeout(), CancellationToken::new()).await;
    assert!(!refused.ok, "closed port phải fail");
    assert!(refused.error.is_some(), "phải có error message");
    assert!(started.elapsed() < connect_timeout(), "closed port phải trả nhanh, got {:?}", started.elapsed());
    eprintln!("CHK (b) closed port → error bounded OK ({:?})", refused.error);

    // (c) cancel Test tới host không tới được → abort < 1s (không chờ timeout)
    let token = CancellationToken::new();
    let t2 = token.clone();
    let unreachable = pg_profile("10.255.255.1", 9); // blackhole: drop SYN → connect treo
    let handle = tokio::spawn(async move {
        run_test_bounded(&unreachable, PASS, "", Duration::from_secs(30), t2).await
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let cstart = Instant::now();
    token.cancel();
    let r = tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("test future phải kết thúc ngay sau cancel")
        .unwrap();
    assert!(cstart.elapsed() < Duration::from_secs(1), "cancel phải abort < 1s, mất {:?}", cstart.elapsed());
    assert!(!r.ok, "test bị hủy → not ok");
    eprintln!("CHK (c) cancel unreachable aborted in {:?} — test end", cstart.elapsed());
}

// ---------------------------------------------------------------------------
// T11 — Cancel running query: abort <1s + connection usable for follow-up (PG)
// ---------------------------------------------------------------------------
#[tokio::test]
async fn query_cancel_aborts_and_connection_recovers() {
    use std::sync::Arc;
    use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
    use database_studio_lib::connections::registry::Registry;
    use database_studio_lib::drivers::types::SystemType;

    let (_c, port) = start_pg().await;
    let profile = ConnectionProfile {
        id: "pgcancel".into(),
        name: "t".into(),
        system: SystemType::Postgres,
        host: "localhost".into(),
        port,
        database: "testdb".into(),
        user: "postgres".into(),
        password_enc: String::new(),
        group: String::new(),
        env: Environment::Development,
        ssh: SshConfig::default(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
        sqlite_path: String::new(),
        sqlite_mode: SqliteMode::ReadWrite,
        mssql_auth: String::new(),
        schema_registry_url: String::new(),
        cassandra_dc: String::new(),
        cassandra_consistency: String::new(),
    };

    let reg = Arc::new(Registry::default());
    // connect với retry (container mới bật)
    {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            match reg.connect(profile.clone(), PASS.into(), String::new()).await {
                Ok(_) => break,
                Err(e) => {
                    assert!(Instant::now() < deadline, "connect PG thất bại: {e:?}");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    }
    eprintln!("CHK connected");

    // chạy query chậm ở task nền
    let r2 = reg.clone();
    let handle = tokio::spawn(async move {
        r2.exec_statement("pgcancel".into(), "SELECT pg_sleep(30)".into()).await
    });
    // đợi statement thực sự chạy + abort handle đã đăng ký
    tokio::time::sleep(Duration::from_millis(600)).await;

    let cstart = Instant::now();
    assert!(reg.cancel("pgcancel"), "cancel phải tìm thấy statement đang chạy");
    let joined = tokio::time::timeout(Duration::from_secs(3), handle)
        .await
        .expect("exec_statement phải trả ngay sau cancel")
        .unwrap();
    assert!(cstart.elapsed() < Duration::from_secs(1), "cancel phải < 1s, mất {:?}", cstart.elapsed());
    // exec trả Ok(Err(CANCELLED))
    match joined {
        Ok(Err(qe)) => assert_eq!(qe.code.as_deref(), Some("CANCELLED"), "phải là CANCELLED, got {qe:?}"),
        other => panic!("kỳ vọng Ok(Err(CANCELLED)), got {other:?}"),
    }
    eprintln!("CHK cancel aborted in {:?}", cstart.elapsed());

    // follow-up query PHẢI chạy được (connection tự heal/reconnect)
    let follow = reg
        .exec_statement("pgcancel".into(), "SELECT 1 AS n".into())
        .await
        .expect("registry err")
        .expect("follow-up query phải chạy được sau cancel");
    match follow {
        StatementOutcome::Rows { result } => {
            assert_eq!(result.rows[0]["n"], serde_json::json!(1), "follow-up trả đúng");
        }
        other => panic!("kỳ vọng Rows, got {other:?}"),
    }
    eprintln!("CHK follow-up query OK — test end");
}

/// Phase 5 · T13 — Import wizard batched-INSERT path at scale. Mirrors the
/// wizard's approach (chunked multi-row INSERT via exec) by importing 100k rows
/// into a real PG table, then querying back the count (seed → verify, not
/// hard-coded). Also proves the Postgres skip-conflict clause (`ON CONFLICT DO
/// NOTHING`) adds no duplicate row.
#[tokio::test]
async fn pg_import_100k_rows_batched_and_count() {
    let (_c, port) = start_pg().await;
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

    drv.exec("CREATE TABLE it_import (id int PRIMARY KEY, name text)")
        .await
        .unwrap();

    const TOTAL: usize = 100_000;
    const BATCH: usize = 5_000;
    let mut inserted: usize = 0;
    for start in (1..=TOTAL).step_by(BATCH) {
        let end = (start + BATCH - 1).min(TOTAL);
        let mut sql = String::with_capacity(BATCH * 24);
        sql.push_str("INSERT INTO it_import (id, name) VALUES ");
        for i in start..=end {
            if i != start {
                sql.push(',');
            }
            // giá trị suy ra từ id → query ngược verify được, không hard-code
            sql.push_str(&format!("({i}, 'row_{i}')"));
        }
        let out = drv.exec(&sql).await.unwrap();
        match out {
            StatementOutcome::Affected { affected } => inserted += affected as usize,
            other => panic!("batch INSERT phải trả Affected, got {other:?}"),
        }
    }
    assert_eq!(inserted, TOTAL, "tổng affected phải = 100k");

    // đếm ngược từ DB thật
    let out = drv.exec("SELECT count(*) AS n FROM it_import").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(100_000));

    // spot-check 1 dòng round-trip đúng (giá trị suy ra, không hard-code sẵn)
    let probe: usize = 73_137;
    let out = drv
        .exec(&format!("SELECT name FROM it_import WHERE id = {probe}"))
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["name"], serde_json::json!(format!("row_{probe}")));

    // ON CONFLICT DO NOTHING (skip mode PG) → 0 affected, count không đổi
    let out = drv
        .exec("INSERT INTO it_import (id, name) VALUES (1, 'dup') ON CONFLICT DO NOTHING")
        .await
        .unwrap();
    assert!(
        matches!(out, StatementOutcome::Affected { affected: 0 }),
        "duplicate PK với ON CONFLICT DO NOTHING phải affected=0"
    );
    let out = drv.exec("SELECT count(*) AS n FROM it_import").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(
        result.rows[0]["n"],
        serde_json::json!(100_000),
        "skip-conflict không được thêm dòng"
    );
    eprintln!("CHK import 100k + count + skip-conflict OK");
}

/// Phase 5 · T14 — Export wizard round-trip. Seed a PG table, run the export
/// SELECT (column subset + WHERE, exactly what buildExportSelect emits), then
/// re-import the exported rows into a fresh table and assert the count matches
/// the WHERE-filtered subset (seed → verify, derived counts — nothing hard-coded).
#[tokio::test]
async fn pg_export_column_subset_where_reimport_count() {
    let (_c, port) = start_pg().await;
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

    drv.exec("CREATE TABLE it_exp (id int, region text, amount int)")
        .await
        .unwrap();
    let mut seed = String::from("INSERT INTO it_exp (id, region, amount) VALUES ");
    for i in 1..=1000 {
        if i != 1 {
            seed.push(',');
        }
        let region = if i % 3 == 0 { "north" } else { "south" };
        seed.push_str(&format!("({i}, '{region}', {})", i * 2));
    }
    drv.exec(&seed).await.unwrap();

    // Export: column subset {id, amount} + WHERE region='north'
    let out = drv
        .exec("SELECT \"id\", \"amount\" FROM \"public\".\"it_exp\" WHERE region = 'north'")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    let exported = result.rows.clone();
    let expected_north = (1..=1000usize).filter(|i| i % 3 == 0).count();
    assert_eq!(exported.len(), expected_north, "export phải trả đúng subset WHERE");
    // chỉ 2 cột được project (column subset)
    assert_eq!(result.cols.len(), 2);
    assert!(result.cols.iter().any(|c| c.0 == "id"));
    assert!(result.cols.iter().any(|c| c.0 == "amount"));

    // Re-import các dòng đã export vào bảng mới rồi đếm ngược
    drv.exec("CREATE TABLE it_exp_copy (id int, amount int)").await.unwrap();
    let mut reimport = String::from("INSERT INTO it_exp_copy (id, amount) VALUES ");
    for (k, row) in exported.iter().enumerate() {
        if k != 0 {
            reimport.push(',');
        }
        let id = row["id"].as_i64().expect("id là số");
        let amount = row["amount"].as_i64().expect("amount là số");
        reimport.push_str(&format!("({id}, {amount})"));
    }
    drv.exec(&reimport).await.unwrap();

    let out = drv.exec("SELECT count(*) AS n FROM it_exp_copy").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(
        result.rows[0]["n"],
        serde_json::json!(expected_north as i64),
        "re-import phải khớp số dòng đã export"
    );

    // giá trị round-trip đúng: north id nhỏ nhất = 3, amount = id*2 = 6
    let out = drv.exec("SELECT amount FROM it_exp_copy WHERE id = 3").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["amount"], serde_json::json!(6));
    eprintln!("CHK export subset+WHERE → reimport count OK");
}

/// Phase 5 · T18 — Explorer "Show Definition" trả về text định nghĩa THẬT của
/// server (không sinh lại). Tạo function → lấy pg_get_functiondef → chứa body.
#[tokio::test]
async fn pg_object_definition_returns_real_text() {
    use database_studio_lib::commands::schema::definition_query;

    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE FUNCTION add_one(x int) RETURNS int LANGUAGE sql AS 'SELECT x + 1'")
        .await
        .unwrap();

    let q = definition_query("postgres", "function", "public", "add_one").expect("query");
    let out = drv.exec(&q).await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    let def = result.rows[0]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .as_str()
        .unwrap();
    assert!(def.to_uppercase().contains("CREATE"), "def:\n{def}");
    assert!(def.contains("add_one"), "phải nêu tên function:\n{def}");
    assert!(def.contains("x + 1"), "phải chứa body thật:\n{def}");
    eprintln!("CHK PG object_definition real text OK");
}

/// Phase 5 · T19 — Schema Compare depth: 2 schema PG khác nhau 1 cột + 1 function.
/// Introspect → phát hiện khác biệt → chạy migration → hội tụ (TARGET khớp SOURCE).
#[tokio::test]
async fn pg_schema_compare_proc_and_column_then_migrate() {
    use database_studio_lib::commands::schema::definition_query;

    let (_c, port) = start_pg().await;
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

    // SOURCE = cmp_a (t có cột extra, f trả 1); TARGET = cmp_b (t thiếu extra, f trả 2).
    drv.exec("CREATE SCHEMA cmp_a").await.unwrap();
    drv.exec("CREATE SCHEMA cmp_b").await.unwrap();
    drv.exec("CREATE TABLE cmp_a.t (id int, extra text)").await.unwrap();
    drv.exec("CREATE TABLE cmp_b.t (id int)").await.unwrap();
    drv.exec("CREATE FUNCTION cmp_a.f() RETURNS int LANGUAGE sql AS 'SELECT 1'").await.unwrap();
    drv.exec("CREATE FUNCTION cmp_b.f() RETURNS int LANGUAGE sql AS 'SELECT 2'").await.unwrap();

    let has_extra = |rows: &[serde_json::Value]| rows.iter().any(|r| r["column_name"].as_str() == Some("extra"));
    let cols_b = gs_rows(&mut drv, "SELECT column_name FROM information_schema.columns WHERE table_schema='cmp_b' AND table_name='t'").await;
    assert!(!has_extra(&cols_b), "TARGET chưa có cột extra (khác SOURCE)");

    // function def khác nhau (body 1 vs 2)
    let qb = definition_query("postgres", "function", "cmp_b", "f").unwrap();
    let def_b = {
        let StatementOutcome::Rows { result } = drv.exec(&qb).await.unwrap() else { panic!() };
        result.rows[0].as_object().unwrap().values().next().unwrap().as_str().unwrap().to_string()
    };
    assert!(def_b.contains("SELECT 2"), "TARGET.f ban đầu trả 2");

    // migration đồng bộ TARGET ← SOURCE
    drv.exec("ALTER TABLE cmp_b.t ADD COLUMN extra text").await.unwrap();
    drv.exec("CREATE OR REPLACE FUNCTION cmp_b.f() RETURNS int LANGUAGE sql AS 'SELECT 1'").await.unwrap();

    // hội tụ: cột extra xuất hiện + function body khớp SOURCE
    let cols_b2 = gs_rows(&mut drv, "SELECT column_name FROM information_schema.columns WHERE table_schema='cmp_b' AND table_name='t'").await;
    assert!(has_extra(&cols_b2), "sau migration TARGET.t có extra");
    let def_b2 = {
        let StatementOutcome::Rows { result } = drv.exec(&qb).await.unwrap() else { panic!() };
        result.rows[0].as_object().unwrap().values().next().unwrap().as_str().unwrap().to_string()
    };
    assert!(def_b2.contains("SELECT 1"), "sau migration TARGET.f khớp SOURCE:\n{def_b2}");
    eprintln!("CHK PG schema compare proc+column → migrate converge OK");
}

/// Phase 5 · T20 — ER create-relationship "Save to DB": áp câu ALTER ADD FK (đúng
/// shape genForeignKey sinh ra) lên cặp bảng seeded → introspect thấy FK thật.
#[tokio::test]
async fn pg_er_add_relationship_creates_fk() {
    let (_c, port) = start_pg().await;
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

    drv.exec("CREATE TABLE er_parent (id int PRIMARY KEY)").await.unwrap();
    drv.exec("CREATE TABLE er_child (id int PRIMARY KEY, parent_id int)").await.unwrap();

    // trước: chưa có FK
    let before = drv.foreign_keys("public").await.unwrap();
    assert!(!before.iter().any(|f| f.from_table == "er_child"), "chưa có FK ban đầu");

    // "Save to DB" — câu ALTER ADD CONSTRAINT FK (giống genForeignKey('postgres',...)).
    drv.exec(
        "ALTER TABLE \"public\".\"er_child\" ADD CONSTRAINT \"fk_er_child_parent_id\" \
         FOREIGN KEY (\"parent_id\") REFERENCES \"public\".\"er_parent\" (\"id\");",
    )
    .await
    .unwrap();

    // sau: introspect thấy FK từ er_child.parent_id → er_parent.id
    let after = drv.foreign_keys("public").await.unwrap();
    let fk = after
        .iter()
        .find(|f| f.from_table == "er_child")
        .expect("FK vừa tạo phải xuất hiện trong introspection");
    assert_eq!(fk.from_column, "parent_id");
    assert_eq!(fk.to_table, "er_parent");
    assert_eq!(fk.to_column, "id");
    eprintln!("CHK ER add-relationship → FK introspected OK");
}

/// Phase 5 · T21 — concurrent tabs dùng CHUNG connection của profile qua registry
/// mà không cạn kiệt/deadlock; và transaction ROLLBACK huỷ insert đã seed.
#[tokio::test]
async fn pg_registry_concurrent_and_rollback() {
    use std::sync::Arc;
    use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
    use database_studio_lib::connections::registry::Registry;
    use database_studio_lib::drivers::types::SystemType;

    let (_c, port) = start_pg().await;
    let profile = ConnectionProfile {
        id: "pgpool".into(),
        name: "t".into(),
        system: SystemType::Postgres,
        host: "localhost".into(),
        port,
        database: "testdb".into(),
        user: "postgres".into(),
        password_enc: String::new(),
        group: String::new(),
        env: Environment::Development,
        ssh: SshConfig::default(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
        sqlite_path: String::new(),
        sqlite_mode: SqliteMode::ReadWrite,
        mssql_auth: String::new(),
        schema_registry_url: String::new(),
        cassandra_dc: String::new(),
        cassandra_consistency: String::new(),
    };

    let reg = Arc::new(Registry::default());
    {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            match reg.connect(profile.clone(), PASS.into(), String::new()).await {
                Ok(_) => break,
                Err(e) => {
                    assert!(Instant::now() < deadline, "connect PG: {e:?}");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    }

    // Concurrency: 16 "tabs" chạy đồng thời qua registry, tất cả phải OK.
    let mut handles = Vec::new();
    for i in 0..16u32 {
        let reg = reg.clone();
        handles.push(tokio::spawn(async move {
            reg.exec_statement("pgpool", format!("SELECT {i} AS n"))
                .await
                .expect("no infra error")
                .expect("no query error")
        }));
    }
    let mut ok = 0;
    for (i, h) in handles.into_iter().enumerate() {
        let out = h.await.unwrap();
        let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
        assert_eq!(result.rows[0]["n"], serde_json::json!(i as i64));
        ok += 1;
    }
    assert_eq!(ok, 16, "cả 16 truy vấn đồng thời phải thành công (không cạn kiệt)");
    eprintln!("CHK 16 concurrent queries via registry OK");
    // (transaction rollback ở test riêng phía dưới đã dùng chung registry pattern)

    // Transaction: BEGIN → INSERT → ROLLBACK → count = 0.
    let run = |sql: &'static str| {
        let reg = reg.clone();
        async move { reg.exec_statement("pgpool", sql.into()).await.expect("infra").expect("query") }
    };
    run("CREATE TABLE tx_demo (id int)").await;
    run("BEGIN").await;
    run("INSERT INTO tx_demo VALUES (1), (2)").await;
    run("ROLLBACK").await;
    let out = run("SELECT count(*) AS n FROM tx_demo").await;
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(0), "ROLLBACK phải huỷ insert");
    eprintln!("CHK transaction ROLLBACK discards insert OK");
}

// --- T15 helpers: introspect a schema into a canonical, comparable signature ---
async fn gs_rows(drv: &mut PgDriver, sql: &str) -> Vec<serde_json::Value> {
    match drv.exec(sql).await.unwrap() {
        StatementOutcome::Rows { result } => result.rows,
        other => panic!("kỳ vọng Rows từ `{sql}`, got {other:?}"),
    }
}

/// Chuẩn hóa toàn bộ cấu trúc schema (objects + columns + PK + FK) thành 1 chuỗi
/// so sánh được — dùng để chứng minh generate-structure round-trip identical.
async fn gs_signature(drv: &mut PgDriver, schema: &str) -> String {
    let mut sig = String::new();
    let objs = gs_rows(
        drv,
        &format!("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema='{schema}' ORDER BY table_name"),
    )
    .await;
    for o in &objs {
        let name = o["table_name"].as_str().unwrap();
        sig.push_str(&format!("OBJ {name} {}\n", o["table_type"].as_str().unwrap()));
        let cols = gs_rows(
            drv,
            &format!("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='{schema}' AND table_name='{name}' ORDER BY ordinal_position"),
        )
        .await;
        for c in &cols {
            sig.push_str(&format!(
                "  COL {} {} {}\n",
                c["column_name"].as_str().unwrap(),
                c["data_type"].as_str().unwrap(),
                c["is_nullable"].as_str().unwrap()
            ));
        }
    }
    let pks = gs_rows(
        drv,
        &format!("SELECT kcu.table_name AS t, kcu.column_name AS c FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema='{schema}' ORDER BY t, c"),
    )
    .await;
    for p in &pks {
        sig.push_str(&format!("PK {}.{}\n", p["t"].as_str().unwrap(), p["c"].as_str().unwrap()));
    }
    let fks = gs_rows(
        drv,
        &format!("SELECT kcu.table_name AS ft, kcu.column_name AS fc, ccu.table_name AS tt, ccu.column_name AS tc FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='{schema}' ORDER BY ft, fc"),
    )
    .await;
    for f in &fks {
        sig.push_str(&format!(
            "FK {}.{} -> {}.{}\n",
            f["ft"].as_str().unwrap(),
            f["fc"].as_str().unwrap(),
            f["tt"].as_str().unwrap(),
            f["tc"].as_str().unwrap()
        ));
    }
    sig
}

/// Phase 5 · T15 — Generate Scripts structure round-trip. Seed a schema
/// (tables + FK + view), regenerate its structure from introspection into a
/// fresh schema (CREATE tables → FK ALTERs last → view), then assert the two
/// schemas introspect identically. Seed → verify; nothing hard-coded.
#[tokio::test]
async fn pg_generate_structure_roundtrip_identical() {
    let (_c, port) = start_pg().await;
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

    // seed source schema
    drv.exec("CREATE SCHEMA gs_src").await.unwrap();
    drv.exec("CREATE TABLE gs_src.parent (id int PRIMARY KEY, name text NOT NULL)").await.unwrap();
    drv.exec("CREATE TABLE gs_src.child (id int PRIMARY KEY, parent_id int, note text)").await.unwrap();
    drv.exec("ALTER TABLE gs_src.child ADD CONSTRAINT fk_child_parent FOREIGN KEY (parent_id) REFERENCES gs_src.parent (id)")
        .await
        .unwrap();
    drv.exec("CREATE VIEW gs_src.v_children AS SELECT id, parent_id FROM gs_src.child")
        .await
        .unwrap();

    // regenerate structure into a fresh schema, driven by introspection
    drv.exec("CREATE SCHEMA gs_dst").await.unwrap();
    let base_tables = gs_rows(
        &mut drv,
        "SELECT table_name FROM information_schema.tables WHERE table_schema='gs_src' AND table_type='BASE TABLE' ORDER BY table_name",
    )
    .await;
    for t in &base_tables {
        let name = t["table_name"].as_str().unwrap();
        let cols = gs_rows(
            &mut drv,
            &format!("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='gs_src' AND table_name='{name}' ORDER BY ordinal_position"),
        )
        .await;
        let pks: Vec<String> = gs_rows(
            &mut drv,
            &format!("SELECT kcu.column_name AS c FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema='gs_src' AND tc.table_name='{name}'"),
        )
        .await
        .iter()
        .map(|r| r["c"].as_str().unwrap().to_string())
        .collect();
        let mut defs = Vec::new();
        for c in &cols {
            let cn = c["column_name"].as_str().unwrap();
            let ty = c["data_type"].as_str().unwrap();
            let is_pk = pks.iter().any(|p| p == cn);
            let mut line = format!("\"{cn}\" {ty}");
            if is_pk {
                line.push_str(" PRIMARY KEY");
            } else if c["is_nullable"].as_str().unwrap() == "NO" {
                line.push_str(" NOT NULL");
            }
            defs.push(line);
        }
        drv.exec(&format!("CREATE TABLE gs_dst.{name} ({})", defs.join(", "))).await.unwrap();
    }
    // FK ALTERs last
    let fks = gs_rows(
        &mut drv,
        "SELECT tc.constraint_name AS n, kcu.table_name AS ft, kcu.column_name AS fc, ccu.table_name AS tt, ccu.column_name AS tc FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='gs_src'",
    )
    .await;
    for f in &fks {
        drv.exec(&format!(
            "ALTER TABLE gs_dst.{} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES gs_dst.{} ({})",
            f["ft"].as_str().unwrap(),
            f["n"].as_str().unwrap(),
            f["fc"].as_str().unwrap(),
            f["tt"].as_str().unwrap(),
            f["tc"].as_str().unwrap()
        ))
        .await
        .unwrap();
    }
    // views (re-point definition from src → dst schema)
    let views = gs_rows(
        &mut drv,
        "SELECT table_name FROM information_schema.tables WHERE table_schema='gs_src' AND table_type='VIEW'",
    )
    .await;
    for v in &views {
        let name = v["table_name"].as_str().unwrap();
        let def = gs_rows(&mut drv, &format!("SELECT pg_get_viewdef('gs_src.{name}', true) AS d")).await;
        let body = def[0]["d"].as_str().unwrap().replace("gs_src.", "gs_dst.");
        drv.exec(&format!("CREATE VIEW gs_dst.{name} AS {body}")).await.unwrap();
    }

    let src_sig = gs_signature(&mut drv, "gs_src").await;
    let dst_sig = gs_signature(&mut drv, "gs_dst").await;
    assert_eq!(src_sig, dst_sig, "structure round-trip phải introspect identical");
    // sanity: signature thật sự có nội dung (không phải hai chuỗi rỗng bằng nhau)
    assert!(src_sig.contains("OBJ parent BASE TABLE"));
    assert!(src_sig.contains("FK child.parent_id -> parent.id"));
    assert!(src_sig.contains("OBJ v_children VIEW"));
    eprintln!("CHK generate-structure round-trip identical OK");
}

/// Phase 5 · T16 — ClickHouse EXPLAIN tree. Seed a MergeTree table, run
/// `EXPLAIN indexes = 1`, and assert the normalized plan has a ReadFrom* node
/// mapped to SeqScan referencing the table (seed → introspect the real plan).
#[tokio::test]
async fn clickhouse_explain_tree_has_read_node() {
    use database_studio_lib::drivers::plan::{self, PlanNode};

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

    drv.exec("CREATE TABLE it_plan (id UInt64, v String) ENGINE = MergeTree ORDER BY id")
        .await
        .unwrap();
    drv.exec("INSERT INTO it_plan VALUES (1,'a'),(2,'b'),(3,'c')").await.unwrap();

    let out = drv
        .exec("EXPLAIN indexes = 1 SELECT * FROM it_plan WHERE id = 2")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("EXPLAIN phải trả rows") };
    let text = result
        .rows
        .iter()
        .filter_map(|r| r.as_object().and_then(|o| o.values().next()))
        .filter_map(|v| v.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!text.is_empty(), "EXPLAIN phải có output");

    let plan = plan::parse_clickhouse(&text);
    let root = plan.root.expect("có root");

    fn has_read(n: &PlanNode) -> bool {
        (n.native_op.starts_with("ReadFrom") && n.operation == "SeqScan")
            || n.children.iter().any(has_read)
    }
    fn refs_table(n: &PlanNode) -> bool {
        n.extra.get("relation").and_then(|v| v.as_str()).map(|s| s.contains("it_plan")).unwrap_or(false)
            || n.children.iter().any(refs_table)
    }
    assert!(has_read(&root), "cây CH phải có ReadFrom* → SeqScan. raw:\n{text}");
    assert!(refs_table(&root), "node ReadFrom phải tham chiếu it_plan. raw:\n{text}");
    eprintln!("CHK ClickHouse EXPLAIN tree OK");

    // T17 — data-skipping index scanner: tạo index minmax rồi quét ngược verify.
    drv.exec("ALTER TABLE it_plan ADD INDEX idx_v v TYPE minmax GRANULARITY 4")
        .await
        .unwrap();
    drv.exec("ALTER TABLE it_plan MATERIALIZE INDEX idx_v").await.ok();
    let idxs = drv.scan_indexes("default").await.expect("scan_indexes CH");
    let idx = idxs.iter().find(|i| i.name == "idx_v").expect("thấy idx_v trong data_skipping_indices");
    assert_eq!(idx.table, "it_plan");
    assert!(idx.index_type.contains("minmax"), "type_full = {}", idx.index_type);
    assert!(idx.columns.iter().any(|c| c.contains('v')), "expr chứa cột v: {:?}", idx.columns);
    eprintln!("CHK ClickHouse data-skipping index scan OK");
}

/// Phase 5 · T16 — Cassandra query plan qua TRACING (không có EXPLAIN). Seed
/// bảng, chạy query cần ALLOW FILTERING với tracing bật → timeline events có nội
/// dung + cờ ALLOW FILTERING được đánh dấu hotspot.
#[tokio::test]
async fn cassandra_trace_plan_flags_allow_filtering() {
    use database_studio_lib::drivers::cassandra::{CassandraConnParams, CassandraDriver};
    use database_studio_lib::drivers::plan;

    let (_c, port) = start_cassandra().await;
    let params = CassandraConnParams {
        contact_points: vec![format!("127.0.0.1:{port}")],
        user: String::new(),
        password: String::new(),
        datacenter: "datacenter1".into(),
        consistency: "ONE".into(),
        keyspace: String::new(),
        ssl: false,
        ssl_ca: String::new(),
    };
    let drv = {
        let deadline = Instant::now() + Duration::from_secs(240);
        let mut last = String::new();
        loop {
            match CassandraDriver::connect_translating_to(&params, "127.0.0.1", port).await {
                Ok(d) => match d.exec_cql("SELECT release_version FROM system.local", None, None).await {
                    Ok(_) => break d,
                    Err(e) => last = format!("query: {}", e.message),
                },
                Err(e) => last = format!("connect: {}", e.message),
            }
            if Instant::now() >= deadline {
                panic!("cassandra: hết 240s chờ node — lỗi cuối: {last}");
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    };

    drv.exec_cql(
        "CREATE KEYSPACE IF NOT EXISTS itplan_ks WITH replication = {'class':'SimpleStrategy','replication_factor':1}",
        None,
        None,
    )
    .await
    .expect("create keyspace");
    drv.exec_cql("CREATE TABLE itplan_ks.t (pk int PRIMARY KEY, v int)", None, None)
        .await
        .expect("create table");
    for i in 1..=5 {
        drv.exec_cql(&format!("INSERT INTO itplan_ks.t (pk, v) VALUES ({i}, {})", i * 10), None, None)
            .await
            .expect("insert");
    }

    // query lọc trên cột không phải partition key → cần ALLOW FILTERING
    let cql = "SELECT * FROM itplan_ks.t WHERE v = 30 ALLOW FILTERING";
    let (warnings, events) = drv.trace_cql(cql).await.expect("trace_cql");
    let p = plan::parse_cassandra_trace(cql, &warnings, &events);
    let root = p.root.expect("có root");
    assert!(root.is_hotspot, "ALLOW FILTERING → hotspot");
    assert!(
        p.summary.warnings.iter().any(|w| w.to_uppercase().contains("ALLOW FILTERING")),
        "phải có cảnh báo ALLOW FILTERING"
    );
    assert!(!events.is_empty(), "TRACING phải trả về timeline events");
    assert!(!root.children.is_empty(), "timeline phải có node event");
    eprintln!("CHK Cassandra TRACING + ALLOW FILTERING flag OK ({} events)", events.len());

    // T17 — secondary index scanner: tạo index rồi quét ngược verify.
    drv.exec_cql("CREATE INDEX idx_v ON itplan_ks.t (v)", None, None).await.expect("create index");
    let idxs = drv.scan_indexes("itplan_ks").await.expect("scan_indexes cassandra");
    let idx = idxs.iter().find(|i| i.name == "idx_v").expect("thấy idx_v trong system_schema.indexes");
    assert_eq!(idx.table, "t");
    assert!(idx.columns.iter().any(|c| c.contains('v')), "target chứa cột v: {:?}", idx.columns);
    eprintln!("CHK Cassandra secondary index scan OK");
}

/// Phase 5 · T22 — SQLite backup/restore round-trip (rusqlite backup API, đảm bảo,
/// không cần công cụ ngoài). Seed → backup ra file → mở file thấy dữ liệu; xoá →
/// restore → khôi phục.
#[tokio::test]
async fn sqlite_backup_restore_roundtrip() {
    let dir = std::env::temp_dir().join("ds-it-backup");
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("src.db");
    let bak = dir.join("bak.db");
    let _ = std::fs::remove_file(&src);
    let _ = std::fs::remove_file(&bak);

    let drv = SqliteDriver::connect(&SqliteConnParams {
        path: src.to_string_lossy().to_string(),
        mode: SqliteMode::ReadWrite,
    })
    .await
    .unwrap();
    drv.exec("CREATE TABLE t (id integer primary key, v text)").await.unwrap();
    drv.exec("INSERT INTO t (id, v) VALUES (1,'a'), (2,'b'), (3,'c')").await.unwrap();

    // backup → file không rỗng
    drv.backup_to(bak.to_string_lossy().to_string()).await.unwrap();
    assert!(bak.exists() && std::fs::metadata(&bak).unwrap().len() > 0, "file backup phải tồn tại + khác rỗng");

    // mở backup như DB độc lập → dữ liệu khớp
    let bakdrv = SqliteDriver::connect(&SqliteConnParams {
        path: bak.to_string_lossy().to_string(),
        mode: SqliteMode::ReadWrite,
    })
    .await
    .unwrap();
    let out = bakdrv.exec("SELECT count(*) AS n FROM t").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(3), "backup giữ đủ 3 dòng");

    // xoá dữ liệu gốc → restore từ backup → khôi phục
    drv.exec("DELETE FROM t").await.unwrap();
    let out = drv.exec("SELECT count(*) AS n FROM t").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(0));
    drv.restore_from(bak.to_string_lossy().to_string()).await.unwrap();
    let out = drv.exec("SELECT count(*) AS n FROM t").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(3), "restore khôi phục 3 dòng");
    eprintln!("CHK SQLite backup/restore round-trip OK");
}

/// Phase 5 · T22 — PG pg_dump nếu binary có trên PATH; nếu không → skip + note
/// (theo done-criteria). Kiểm câu lệnh external_backup_cmd chạy thật ra file dump.
#[tokio::test]
async fn pg_pg_dump_if_binary_present() {
    let has_pg_dump = std::process::Command::new("pg_dump")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !has_pg_dump {
        eprintln!("SKIP pg_dump không có trên PATH — bỏ qua (đúng done-criteria)");
        return;
    }

    let (_c, port) = start_pg().await;
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
    drv.exec("CREATE TABLE bkp_t (id int PRIMARY KEY, v text)").await.unwrap();
    drv.exec("INSERT INTO bkp_t VALUES (1, 'hello')").await.unwrap();

    let dest = std::env::temp_dir().join("ds-it-pgdump.sql");
    let _ = std::fs::remove_file(&dest);
    let out = tokio::process::Command::new("pg_dump")
        .args([
            "-h", "localhost",
            "-p", &port.to_string(),
            "-U", "postgres",
            "-d", "testdb",
            "-f", dest.to_str().unwrap(),
        ])
        .env("PGPASSWORD", PASS)
        .output()
        .await
        .unwrap();
    assert!(out.status.success(), "pg_dump lỗi: {}", String::from_utf8_lossy(&out.stderr));
    let content = std::fs::read_to_string(&dest).unwrap();
    assert!(content.contains("CREATE TABLE") && content.contains("bkp_t"), "dump phải chứa DDL bảng");
    eprintln!("CHK pg_dump backup OK ({} bytes)", content.len());
}

/// Phase 5 · T23 — Admin views đọc system view THẬT của Postgres: Session Monitor
/// (pg_stat_activity) + Users (pg_roles) + Extensions (pg_available_extensions) +
/// Kill session (pg_terminate_backend) trên 1 phiên thứ hai.
#[tokio::test]
async fn pg_admin_views_and_kill_session() {
    use database_studio_lib::commands::admin::{admin_query, kill_query};

    let (_c, port) = start_pg().await;
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

    // sessions: có ít nhất phiên hiện tại
    let out = drv.exec(&admin_query("postgres", "sessions").unwrap()).await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("sessions rows") };
    assert!(result.total >= 1, "phải thấy ≥1 phiên");
    assert!(result.cols.iter().any(|c| c.0 == "pid") && result.cols.iter().any(|c| c.0 == "state"));

    // users: pg_roles chứa 'postgres'
    let out = drv.exec(&admin_query("postgres", "users").unwrap()).await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("users rows") };
    assert!(result.rows.iter().any(|r| r["role"].as_str() == Some("postgres")), "phải thấy role postgres");

    // extensions: plpgsql luôn có + đã cài
    let out = drv.exec(&admin_query("postgres", "extensions").unwrap()).await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("ext rows") };
    let plpgsql = result.rows.iter().find(|r| r["name"].as_str() == Some("plpgsql")).expect("thấy plpgsql");
    assert!(!plpgsql["installed_version"].is_null(), "plpgsql phải đã cài");

    // kill: mở phiên thứ 2, lấy pid, terminate từ phiên chính
    let mut drv2 = retry("postgres", || PgDriver::connect(&params)).await;
    let out = drv2.exec("SELECT pg_backend_pid() AS p").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("pid") };
    let pid2 = result.rows[0]["p"].as_i64().expect("pid i64");
    let out = drv.exec(&kill_query("postgres", pid2).unwrap()).await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("terminate rows") };
    // pg_terminate_backend trả boolean true
    assert_eq!(result.rows[0].as_object().unwrap().values().next().unwrap(), &serde_json::json!(true), "terminate phải trả true");
    eprintln!("CHK PG admin views (sessions/users/extensions) + kill OK");
}

/// Phase 5 · T23 (CE alternative) — Redis memory analysis qua INFO memory (bản CE
/// hỗ trợ sẵn), parse thành bảng metric/value.
#[tokio::test]
async fn redis_memory_info_view() {
    use database_studio_lib::commands::admin::parse_redis_info;
    use database_studio_lib::drivers::redis::{RedisConnParams, RedisDriver};

    let (_c, port) = start_redis("test123").await;
    let params = RedisConnParams {
        host: "localhost".into(),
        port,
        password: "test123".into(),
        db: 0,
        ssl: false,
        ssl_ca: String::new(),
    };
    let mut drv = retry("redis", || RedisDriver::connect(&params)).await;

    let text = drv.command(&["INFO".into(), "memory".into()]).await.unwrap();
    let rs = parse_redis_info(&text);
    assert!(rs.total >= 1, "INFO memory phải có metric");
    assert!(rs.rows.iter().any(|r| r["metric"] == serde_json::json!("used_memory")), "phải có used_memory");
    eprintln!("CHK Redis memory INFO view OK ({} metrics)", rs.total);
}

/// Phase 5 · T23 (CE alternative) — MSSQL admin views đọc được trên bản
/// Developer/container: Agent Jobs (msdb.sysjobs), Availability Groups (DMV rỗng
/// nếu không cluster), Query Store (bật trên 1 DB rồi truy catalog view).
#[tokio::test]
async fn mssql_admin_extra_views() {
    use database_studio_lib::commands::admin::admin_query;

    let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
        .with_exposed_port(1433.tcp())
        .with_env_var("ACCEPT_EULA", "Y")
        .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
        .start()
        .await
        .expect("start mssql container");
    let port = c.get_host_port_ipv4(1433).await.unwrap();
    let params_master = MssqlConnParams {
        host: "localhost".into(),
        port,
        database: String::new(),
        user: "sa".into(),
        password: MSSQL_PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        auth: "sql".into(),
    };
    let params_qs = MssqlConnParams {
        host: "localhost".into(),
        port,
        database: "qsdb".into(),
        user: "sa".into(),
        password: MSSQL_PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        auth: "sql".into(),
    };
    let mut drv = retry("mssql", || MssqlDriver::connect(&params_master)).await;

    // Agent Jobs — msdb.sysjobs đọc được (rỗng trong container) không lỗi
    let out = drv.exec(&admin_query("mssql", "agent_jobs").unwrap()).await.unwrap();
    assert!(matches!(out, StatementOutcome::Rows { .. }), "agent_jobs phải trả rows (có thể rỗng)");

    // Availability Groups — DMV luôn tồn tại, rỗng nếu không cluster
    let out = drv.exec(&admin_query("mssql", "availability_groups").unwrap()).await.unwrap();
    assert!(matches!(out, StatementOutcome::Rows { .. }), "availability_groups phải trả rows");

    // Query Store — bật trên 1 DB người dùng rồi truy catalog view
    drv.exec("CREATE DATABASE qsdb").await.unwrap();
    drv.exec("ALTER DATABASE qsdb SET QUERY_STORE = ON").await.unwrap();
    let mut drv2 = retry("mssql", || MssqlDriver::connect(&params_qs)).await;
    let out = drv2.exec(&admin_query("mssql", "query_store").unwrap()).await.unwrap();
    assert!(matches!(out, StatementOutcome::Rows { .. }), "query_store catalog view phải truy được khi QS bật");
    eprintln!("CHK MSSQL agent_jobs + availability_groups + query_store OK");
}

// ---------------------------------------------------------------------------
// Table Designer end-to-end — the exact DDL buildTableDdl(system, model, isNew)
// emits (see src/lib/sql/table-designer.test.ts) runs on real engines. Covers a
// new table (columns + table-level PK + inline UNIQUE/CHECK/FK + CREATE INDEX +
// CREATE TRIGGER) and the ALTER-add path, verified via each engine's catalog.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pg_table_designer_create_alter_end_to_end() {
    let (_c, port) = start_pg().await;
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

    async fn n(drv: &mut PgDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        let v = &result.rows[0]["n"];
        v.as_i64().unwrap_or_else(|| v.as_f64().unwrap() as i64)
    }

    drv.exec("CREATE TABLE \"public\".\"customers\" (\"id\" int4 PRIMARY KEY)").await.unwrap();
    drv.exec("CREATE FUNCTION orders_bi() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql").await.unwrap();

    // new table (isNew = true)
    drv.exec("CREATE TABLE \"public\".\"orders\" (\n  \"id\" int4,\n  \"customer_id\" int4 NOT NULL,\n  \"email\" varchar(255) NOT NULL,\n  \"total\" numeric,\n  PRIMARY KEY (\"id\"),\n  CONSTRAINT \"uq_orders_email\" UNIQUE (\"email\"),\n  CONSTRAINT \"ck_total\" CHECK (total >= 0),\n  CONSTRAINT \"fk_orders_customer_id\" FOREIGN KEY (\"customer_id\") REFERENCES \"public\".\"customers\" (\"id\") ON DELETE CASCADE\n);").await.unwrap();
    drv.exec("CREATE INDEX \"idx_orders_email\" ON \"public\".\"orders\" USING btree (\"email\");").await.unwrap();
    drv.exec("CREATE TRIGGER \"trg_orders\" BEFORE INSERT ON \"public\".\"orders\"\nFOR EACH ROW EXECUTE FUNCTION orders_bi();").await.unwrap();

    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'").await, 4, "columns");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE constraint_name='uq_orders_email' AND constraint_type='UNIQUE'").await, 1, "unique");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM pg_constraint WHERE conname='ck_total' AND contype='c'").await, 1, "check");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE constraint_name='fk_orders_customer_id' AND constraint_type='FOREIGN KEY'").await, 1, "fk");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM pg_indexes WHERE indexname='idx_orders_email'").await, 1, "index");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.triggers WHERE trigger_name='trg_orders'").await, 1, "trigger");

    // ALTER additions (isNew = false) on the now-existing table
    drv.exec("ALTER TABLE \"public\".\"orders\" ADD COLUMN \"note\" text;").await.unwrap();
    drv.exec("ALTER TABLE \"public\".\"orders\" ADD CONSTRAINT \"uq_orders_note\" UNIQUE (\"note\");").await.unwrap();
    drv.exec("ALTER TABLE \"public\".\"orders\" ADD CONSTRAINT \"ck_note\" CHECK (length(note) >= 0);").await.unwrap();
    drv.exec("CREATE INDEX \"idx_orders_note\" ON \"public\".\"orders\" (\"note\");").await.unwrap();

    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.columns WHERE table_name='orders' AND column_name='note'").await, 1, "note added");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE constraint_name='uq_orders_note'").await, 1, "unique added");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM pg_constraint WHERE conname='ck_note'").await, 1, "check added");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM pg_indexes WHERE indexname='idx_orders_note'").await, 1, "index added");
    eprintln!("CHK pg_table_designer_create_alter_end_to_end OK");
}

#[tokio::test]
async fn mysql_table_designer_create_alter_end_to_end() {
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

    async fn n(drv: &mut MySqlDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        let v = &result.rows[0]["n"];
        v.as_i64().unwrap_or_else(|| v.as_f64().unwrap() as i64)
    }

    drv.exec("CREATE TABLE `customers` (`id` int PRIMARY KEY)").await.unwrap();

    drv.exec("CREATE TABLE `orders` (\n  `id` int,\n  `customer_id` int NOT NULL,\n  `email` varchar(255) NOT NULL,\n  `total` decimal,\n  PRIMARY KEY (`id`),\n  CONSTRAINT `uq_orders_email` UNIQUE (`email`),\n  CONSTRAINT `ck_total` CHECK (total >= 0),\n  CONSTRAINT `fk_orders_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE\n);").await.unwrap();
    drv.exec("CREATE INDEX `idx_orders_email` ON `orders` (`email`) USING BTREE;").await.unwrap();
    drv.exec("CREATE TRIGGER `trg_orders` BEFORE INSERT ON `orders`\nFOR EACH ROW SET @x = 1;").await.unwrap();

    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='testdb' AND table_name='orders'").await, 4, "columns");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE table_schema='testdb' AND constraint_name='uq_orders_email' AND constraint_type='UNIQUE'").await, 1, "unique");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE table_schema='testdb' AND constraint_name='ck_total' AND constraint_type='CHECK'").await, 1, "check");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE table_schema='testdb' AND constraint_name='fk_orders_customer_id' AND constraint_type='FOREIGN KEY'").await, 1, "fk");
    assert!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.statistics WHERE table_schema='testdb' AND index_name='idx_orders_email'").await >= 1, "index");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.triggers WHERE trigger_schema='testdb' AND trigger_name='trg_orders'").await, 1, "trigger");

    drv.exec("ALTER TABLE `orders` ADD COLUMN `note` varchar(50);").await.unwrap();
    drv.exec("ALTER TABLE `orders` ADD CONSTRAINT `uq_orders_note` UNIQUE (`note`);").await.unwrap();
    drv.exec("ALTER TABLE `orders` ADD CONSTRAINT `ck_note` CHECK (char_length(note) >= 0);").await.unwrap();
    drv.exec("CREATE INDEX `idx_orders_note` ON `orders` (`note`);").await.unwrap();

    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='testdb' AND table_name='orders' AND column_name='note'").await, 1, "note added");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE table_schema='testdb' AND constraint_name='uq_orders_note'").await, 1, "unique added");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE table_schema='testdb' AND constraint_name='ck_note' AND constraint_type='CHECK'").await, 1, "check added");
    assert!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.statistics WHERE table_schema='testdb' AND index_name='idx_orders_note'").await >= 1, "index added");
    eprintln!("CHK mysql_table_designer_create_alter_end_to_end OK");
}

#[tokio::test]
async fn mssql_table_designer_create_alter_end_to_end() {
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

    async fn n(drv: &mut MssqlDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        let v = &result.rows[0]["n"];
        v.as_i64().unwrap_or_else(|| v.as_f64().unwrap() as i64)
    }

    drv.exec("CREATE TABLE [dbo].[customers] ([id] int PRIMARY KEY)").await.unwrap();

    // new table (CREATE TRIGGER on MSSQL needs its own batch → covered by the unit test)
    drv.exec("CREATE TABLE [dbo].[orders] (\n  [id] int,\n  [customer_id] int NOT NULL,\n  [email] nvarchar(255) NOT NULL,\n  [total] decimal,\n  PRIMARY KEY ([id]),\n  CONSTRAINT [uq_orders_email] UNIQUE ([email]),\n  CONSTRAINT [ck_total] CHECK (total >= 0),\n  CONSTRAINT [fk_orders_customer_id] FOREIGN KEY ([customer_id]) REFERENCES [dbo].[customers] ([id]) ON DELETE CASCADE\n);").await.unwrap();
    drv.exec("CREATE INDEX [idx_orders_email] ON [dbo].[orders] ([email]);").await.unwrap();

    assert_eq!(n(&mut drv, "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='orders'").await, 4, "columns");
    assert_eq!(n(&mut drv, "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_NAME='uq_orders_email' AND CONSTRAINT_TYPE='UNIQUE'").await, 1, "unique");
    assert_eq!(n(&mut drv, "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_NAME='ck_total' AND CONSTRAINT_TYPE='CHECK'").await, 1, "check");
    assert_eq!(n(&mut drv, "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_NAME='fk_orders_customer_id' AND CONSTRAINT_TYPE='FOREIGN KEY'").await, 1, "fk");
    assert_eq!(n(&mut drv, "SELECT COUNT(*) AS n FROM sys.indexes WHERE name='idx_orders_email'").await, 1, "index");

    drv.exec("ALTER TABLE [dbo].[orders] ADD [note] nvarchar(50);").await.unwrap();
    drv.exec("ALTER TABLE [dbo].[orders] ADD CONSTRAINT [uq_orders_note] UNIQUE ([note]);").await.unwrap();
    drv.exec("ALTER TABLE [dbo].[orders] ADD CONSTRAINT [ck_note] CHECK (LEN(note) >= 0);").await.unwrap();
    drv.exec("CREATE INDEX [idx_orders_note] ON [dbo].[orders] ([note]);").await.unwrap();

    assert_eq!(n(&mut drv, "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='orders' AND COLUMN_NAME='note'").await, 1, "note added");
    assert_eq!(n(&mut drv, "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_NAME='uq_orders_note'").await, 1, "unique added");
    assert_eq!(n(&mut drv, "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_NAME='ck_note' AND CONSTRAINT_TYPE='CHECK'").await, 1, "check added");
    assert_eq!(n(&mut drv, "SELECT COUNT(*) AS n FROM sys.indexes WHERE name='idx_orders_note'").await, 1, "index added");
    eprintln!("CHK mssql_table_designer_create_alter_end_to_end OK");
}

#[tokio::test]
async fn sqlite_table_designer_create_alter_end_to_end() {
    let drv = SqliteDriver::connect(&SqliteConnParams { path: String::new(), mode: SqliteMode::InMemory })
        .await
        .unwrap();

    async fn n(drv: &SqliteDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        let v = &result.rows[0]["n"];
        v.as_i64().unwrap_or_else(|| v.as_f64().unwrap() as i64)
    }

    drv.exec("CREATE TABLE \"customers\" (\"id\" INTEGER PRIMARY KEY)").await.unwrap();
    drv.exec("CREATE TABLE \"orders_log\" (\"n\" INTEGER)").await.unwrap();

    // new table (isNew = true) — inline PK/UNIQUE/CHECK/FK
    drv.exec("CREATE TABLE \"orders\" (\n  \"id\" INTEGER,\n  \"customer_id\" INTEGER NOT NULL,\n  \"email\" TEXT NOT NULL,\n  \"total\" NUMERIC,\n  PRIMARY KEY (\"id\"),\n  CONSTRAINT \"uq_orders_email\" UNIQUE (\"email\"),\n  CONSTRAINT \"ck_total\" CHECK (total >= 0),\n  CONSTRAINT \"fk_orders_customer_id\" FOREIGN KEY (\"customer_id\") REFERENCES \"customers\" (\"id\") ON DELETE CASCADE\n);").await.unwrap();
    drv.exec("CREATE INDEX \"idx_orders_email\" ON \"orders\" (\"email\");").await.unwrap();
    drv.exec("CREATE TRIGGER \"trg_orders\" BEFORE INSERT ON \"orders\"\nBEGIN\n  INSERT INTO orders_log VALUES (1);\nEND;").await.unwrap();

    assert_eq!(n(&drv, "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='orders'").await, 1, "table");
    assert_eq!(n(&drv, "SELECT count(*) AS n FROM pragma_table_info('orders')").await, 4, "columns");
    assert_eq!(n(&drv, "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_orders_email'").await, 1, "index");
    assert_eq!(n(&drv, "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='trg_orders'").await, 1, "trigger");
    // the stored CREATE carries the named UNIQUE/CHECK/FK constraints
    let StatementOutcome::Rows { result } = drv.exec("SELECT sql FROM sqlite_master WHERE name='orders'").await.unwrap() else { panic!("rows") };
    let create_sql = result.rows[0]["sql"].as_str().unwrap();
    assert!(create_sql.contains("uq_orders_email"), "unique in DDL");
    assert!(create_sql.contains("ck_total"), "check in DDL");
    assert!(create_sql.contains("fk_orders_customer_id"), "fk in DDL");

    // ALTER additions (isNew = false): ADD COLUMN + UNIQUE degrades to a UNIQUE INDEX
    drv.exec("ALTER TABLE \"orders\" ADD COLUMN \"note\" TEXT;").await.unwrap();
    drv.exec("CREATE UNIQUE INDEX \"uq_orders_note\" ON \"orders\" (\"note\");").await.unwrap();
    drv.exec("CREATE INDEX \"idx_orders_note\" ON \"orders\" (\"note\");").await.unwrap();

    assert_eq!(n(&drv, "SELECT count(*) AS n FROM pragma_table_info('orders') WHERE name='note'").await, 1, "note added");
    assert_eq!(n(&drv, "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='uq_orders_note'").await, 1, "unique index added");
    assert_eq!(n(&drv, "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_orders_note'").await, 1, "index added");
    eprintln!("CHK sqlite_table_designer_create_alter_end_to_end OK");
}

// ---------------------------------------------------------------------------
// Streaming feature end-to-end: Kafka clear-messages (purge) + NATS subject
// browse / purge-subject / remove-subject, on real containers.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn kafka_purge_topic_clears_messages() {
    use database_studio_lib::drivers::kafka::{KafkaConnParams, KafkaDriver};
    use testcontainers_modules::kafka::{Kafka, KAFKA_PORT};

    let node = Kafka::default().start().await.expect("start kafka container");
    let port = node.get_host_port_ipv4(KAFKA_PORT).await.unwrap();
    let params = KafkaConnParams {
        bootstrap: format!("127.0.0.1:{port}"),
        sasl_mechanism: String::new(),
        user: String::new(),
        password: String::new(),
        ssl: false,
    };
    let drv = retry("kafka", || KafkaDriver::connect(&params)).await;

    drv.create_topic("purge_test", 1, 1).await.unwrap();
    for _ in 0..20 {
        if drv.topics().await.unwrap().iter().any(|t| t.name == "purge_test") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    for i in 0..5 {
        drv.produce("purge_test", &format!("k{i}"), "v", Some(0)).await.unwrap();
    }

    // messages present (high − low >= 5)
    let mut retained = 0i64;
    for _ in 0..20 {
        let t = drv.topics().await.unwrap().into_iter().find(|t| t.name == "purge_test").unwrap();
        let p = &t.partitions[0];
        retained = p.high - p.low;
        if retained >= 5 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(retained >= 5, "expected >=5 messages before purge, got {retained}");

    // clear messages (delete_records to high watermark)
    drv.purge_topic("purge_test").await.unwrap();

    // after purge the low watermark advances to high → 0 retained
    let mut after = i64::MAX;
    for _ in 0..20 {
        let t = drv.topics().await.unwrap().into_iter().find(|t| t.name == "purge_test").unwrap();
        let p = &t.partitions[0];
        after = p.high - p.low;
        if after == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(after, 0, "purge must clear all retained messages");

    // topic itself still exists, then delete it
    assert!(drv.topics().await.unwrap().iter().any(|t| t.name == "purge_test"), "topic kept after purge");
    drv.delete_topic("purge_test").await.unwrap();
    eprintln!("CHK kafka_purge_topic_clears_messages OK");
}

#[tokio::test]
async fn nats_subject_messages_purge_and_remove() {
    use async_nats::jetstream;
    use database_studio_lib::drivers::nats::{NatsConnParams, NatsDriver};

    let c = GenericImage::new("nats", "2.10-alpine")
        .with_exposed_port(4222.tcp())
        .with_cmd(vec!["-js"])
        .start()
        .await
        .expect("start nats -js");
    let port = c.get_host_port_ipv4(4222).await.unwrap();
    let params = NatsConnParams { host: "localhost".into(), port, user: String::new(), password: String::new(), ssl: false };
    let drv = retry("nats-js", || NatsDriver::connect(&params)).await;

    let js = jetstream::new(drv.client());
    js.create_stream(jetstream::stream::Config {
        name: "ORDERS".into(),
        subjects: vec!["orders.eu".into(), "orders.us".into()],
        ..Default::default()
    })
    .await
    .unwrap();
    for i in 0..3 {
        js.publish("orders.eu", bytes::Bytes::from(format!("eu{i}"))).await.unwrap().await.unwrap();
    }
    for i in 0..2 {
        js.publish("orders.us", bytes::Bytes::from(format!("us{i}"))).await.unwrap().await.unwrap();
    }

    // retry helper: browse a subject until it reports the expected count (or times out)
    async fn count_until(drv: &NatsDriver, subject: &str, want: usize) -> usize {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let n = drv.js_subject_messages("ORDERS", subject, 100).await.unwrap().len();
            if n == want || Instant::now() >= deadline {
                return n;
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }

    // browse: only orders.eu messages, correct subject
    let eu = drv.js_subject_messages("ORDERS", "orders.eu", 100).await.unwrap();
    assert_eq!(count_until(&drv, "orders.eu", 3).await, 3, "3 messages on orders.eu");
    assert!(eu.iter().all(|m| m.subject == "orders.eu"), "all messages belong to orders.eu");

    // clear one subject → its messages gone, the other subject intact
    drv.js_purge_subject("ORDERS", "orders.eu").await.unwrap();
    assert_eq!(count_until(&drv, "orders.eu", 0).await, 0, "orders.eu cleared");
    assert_eq!(count_until(&drv, "orders.us", 2).await, 2, "orders.us intact");

    // remove a subject from the stream config
    drv.js_remove_subject("ORDERS", "orders.us").await.unwrap();
    let s = drv.js_streams().await.unwrap().into_iter().find(|s| s.name == "ORDERS").unwrap();
    assert_eq!(s.subjects, vec!["orders.eu".to_string()], "orders.us removed from config");
    // removing the last remaining subject must be refused
    assert!(drv.js_remove_subject("ORDERS", "orders.eu").await.is_err(), "cannot remove the last subject");

    drv.js_delete_stream("ORDERS").await.unwrap();
    eprintln!("CHK nats_subject_messages_purge_and_remove OK");
}

// ---------------------------------------------------------------------------
// Alter + Execute of views/procedures/functions/triggers, end-to-end on real
// engines. Proves the "Alter…" statements the app generates (CREATE OR REPLACE /
// CREATE OR ALTER / DROP+CREATE — see sql/alter.ts) actually modify the object,
// and that Execute (buildCall — CALL/SELECT/EXEC) runs. Also guards the MSSQL
// raw-batch DDL routing (CREATE OR ALTER PROCEDURE must be first in its batch).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pg_alter_and_execute_objects_end_to_end() {
    let (_c, port) = start_pg().await;
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
    async fn scalar(drv: &mut PgDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        let v = result.rows[0].as_object().unwrap().values().next().unwrap();
        v.as_i64().unwrap_or_else(|| v.as_f64().unwrap() as i64)
    }

    drv.exec("CREATE TABLE t (id int)").await.unwrap();
    drv.exec("INSERT INTO t VALUES (1),(2)").await.unwrap();

    // function: create → EXECUTE (SELECT) → ALTER (CREATE OR REPLACE) → EXECUTE
    drv.exec("CREATE FUNCTION public.addone(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 1 $$").await.unwrap();
    assert_eq!(scalar(&mut drv, "SELECT \"public\".\"addone\"(41)").await, 42, "execute function");
    drv.exec("CREATE OR REPLACE FUNCTION public.addone(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 2 $$").await.unwrap();
    assert_eq!(scalar(&mut drv, "SELECT \"public\".\"addone\"(41)").await, 43, "alter function took effect");

    // procedure: create → EXECUTE (CALL)
    drv.exec("CREATE PROCEDURE public.noop() LANGUAGE sql AS $$ SELECT 1 $$").await.unwrap();
    drv.exec("CALL \"public\".\"noop\"()").await.unwrap();

    // view: create → ALTER (CREATE OR REPLACE VIEW) adds a column
    drv.exec("CREATE VIEW public.v AS SELECT id FROM t").await.unwrap();
    assert_eq!(scalar(&mut drv, "SELECT count(*) FROM information_schema.columns WHERE table_name='v'").await, 1, "1 col before");
    drv.exec("CREATE OR REPLACE VIEW \"public\".\"v\" AS\nSELECT id, id * 2 AS dbl FROM t").await.unwrap();
    assert_eq!(scalar(&mut drv, "SELECT count(*) FROM information_schema.columns WHERE table_name='v'").await, 2, "alter view added a column");

    // trigger: create fn + trigger → ALTER (CREATE OR REPLACE TRIGGER, PG 14+)
    drv.exec("CREATE FUNCTION public.tf() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$").await.unwrap();
    drv.exec("CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION public.tf()").await.unwrap();
    drv.exec("CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION public.tf()").await.unwrap();
    assert_eq!(scalar(&mut drv, "SELECT count(*) FROM information_schema.triggers WHERE trigger_name='trg'").await, 1, "trigger present after alter");
    eprintln!("CHK pg_alter_and_execute_objects_end_to_end OK");
}

#[tokio::test]
async fn mssql_alter_and_execute_objects_end_to_end() {
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
    async fn scalar(drv: &mut MssqlDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        let v = result.rows[0].as_object().unwrap().values().next().unwrap();
        v.as_i64().unwrap_or_else(|| v.as_f64().unwrap() as i64)
    }

    // procedure: CREATE then CREATE OR ALTER (both DDL → routed via simple_query,
    // which previously failed with "CREATE/ALTER PROC must be first in batch").
    drv.exec("CREATE PROCEDURE dbo.p AS SELECT 1 AS a").await.unwrap();
    assert_eq!(scalar(&mut drv, "EXEC dbo.p").await, 1, "execute procedure");
    drv.exec("CREATE OR ALTER PROCEDURE dbo.p AS SELECT 2 AS a").await.unwrap();
    assert_eq!(scalar(&mut drv, "EXEC dbo.p").await, 2, "alter procedure took effect");

    // view via CREATE OR ALTER
    drv.exec("CREATE VIEW dbo.v AS SELECT 1 AS a").await.unwrap();
    drv.exec("CREATE OR ALTER VIEW dbo.v AS SELECT 2 AS a").await.unwrap();
    assert_eq!(scalar(&mut drv, "SELECT a FROM dbo.v").await, 2, "alter view took effect");

    // scalar function via CREATE OR ALTER
    drv.exec("CREATE FUNCTION dbo.addone(@x int) RETURNS int AS BEGIN RETURN @x + 1 END").await.unwrap();
    assert_eq!(scalar(&mut drv, "SELECT dbo.addone(41) AS n").await, 42, "execute function");
    drv.exec("CREATE OR ALTER FUNCTION dbo.addone(@x int) RETURNS int AS BEGIN RETURN @x + 2 END").await.unwrap();
    assert_eq!(scalar(&mut drv, "SELECT dbo.addone(41) AS n").await, 43, "alter function took effect");
    eprintln!("CHK mssql_alter_and_execute_objects_end_to_end OK");
}

#[tokio::test]
async fn mysql_alter_and_execute_objects_end_to_end() {
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
    async fn scalar(drv: &mut MySqlDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        let v = result.rows[0].as_object().unwrap().values().next().unwrap();
        v.as_i64().unwrap_or_else(|| v.as_f64().unwrap() as i64)
    }

    // function: create → EXECUTE (SELECT) → ALTER (DROP + CREATE) → EXECUTE
    drv.exec("CREATE FUNCTION addone(x int) RETURNS int DETERMINISTIC RETURN x + 1").await.unwrap();
    assert_eq!(scalar(&mut drv, "SELECT `testdb`.`addone`(41)").await, 42, "execute function");
    drv.exec("DROP FUNCTION IF EXISTS `testdb`.`addone`").await.unwrap();
    drv.exec("CREATE FUNCTION addone(x int) RETURNS int DETERMINISTIC RETURN x + 2").await.unwrap();
    assert_eq!(scalar(&mut drv, "SELECT `testdb`.`addone`(41)").await, 43, "alter function took effect");

    // procedure: create → EXECUTE (CALL)
    drv.exec("CREATE PROCEDURE p() SELECT 1").await.unwrap();
    drv.exec("CALL `testdb`.`p`()").await.unwrap();

    // view: create → ALTER (CREATE OR REPLACE VIEW)
    drv.exec("CREATE TABLE t (id int)").await.unwrap();
    drv.exec("CREATE VIEW v AS SELECT id FROM t").await.unwrap();
    drv.exec("CREATE OR REPLACE VIEW `v` AS SELECT id, id * 2 AS dbl FROM t").await.unwrap();
    assert_eq!(
        scalar(&mut drv, "SELECT count(*) FROM information_schema.columns WHERE table_schema='testdb' AND table_name='v'").await,
        2,
        "alter view added a column",
    );
    eprintln!("CHK mysql_alter_and_execute_objects_end_to_end OK");
}

#[tokio::test]
async fn sqlite_alter_view_and_trigger_end_to_end() {
    let drv = SqliteDriver::connect(&SqliteConnParams { path: String::new(), mode: SqliteMode::InMemory })
        .await
        .unwrap();
    async fn text(drv: &SqliteDriver, sql: &str) -> String {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        result.rows[0].as_object().unwrap().values().next().unwrap().as_str().unwrap_or("").to_string()
    }

    drv.exec("CREATE TABLE t (id INTEGER)").await.unwrap();
    drv.exec("CREATE TABLE log (n INTEGER)").await.unwrap();

    // view: create → ALTER (DROP + CREATE, as sql/alter.ts emits for SQLite)
    drv.exec("CREATE VIEW v AS SELECT id FROM t").await.unwrap();
    drv.exec("DROP VIEW IF EXISTS \"v\"").await.unwrap();
    drv.exec("CREATE VIEW v AS SELECT id, id * 2 AS dbl FROM t").await.unwrap();
    assert!(text(&drv, "SELECT sql FROM sqlite_master WHERE name='v'").await.contains("dbl"), "alter view took effect");

    // trigger: create → ALTER (DROP + CREATE)
    drv.exec("CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO log VALUES (1); END").await.unwrap();
    drv.exec("DROP TRIGGER IF EXISTS \"trg\"").await.unwrap();
    drv.exec("CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO log VALUES (2); END").await.unwrap();
    assert!(text(&drv, "SELECT sql FROM sqlite_master WHERE name='trg'").await.contains("VALUES (2)"), "alter trigger took effect");
    eprintln!("CHK sqlite_alter_view_and_trigger_end_to_end OK");
}

#[tokio::test]
async fn mysql_proc_and_func_execute_return_results() {
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

    // FUNCTION → executed via `SELECT func()` (the Execute dialog form)
    drv.exec("CREATE FUNCTION addone(x int) RETURNS int DETERMINISTIC RETURN x + 1").await.unwrap();
    let out = drv.exec("SELECT `testdb`.`addone`(41) AS n").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("function SELECT must return rows, got a non-rows outcome") };
    let v = result.rows[0].as_object().unwrap().values().next().unwrap();
    assert_eq!(v.as_i64().unwrap_or_else(|| v.as_f64().unwrap() as i64), 42, "function returned wrong value");

    // PROCEDURE → executed via `CALL proc()`; must surface its result set (was
    // discarded / errored before CALL was treated as row-returning).
    drv.exec("CREATE PROCEDURE list_it() BEGIN SELECT 7 AS a, 'hi' AS b; END").await.unwrap();
    let out2 = drv.exec("CALL `testdb`.`list_it`()").await.unwrap();
    let StatementOutcome::Rows { result: r2 } = out2 else { panic!("CALL proc must return its result set rows") };
    assert_eq!(r2.rows[0]["a"].as_i64().unwrap_or_else(|| r2.rows[0]["a"].as_f64().unwrap() as i64), 7, "proc result value");
    assert_eq!(r2.rows[0]["b"].as_str().unwrap(), "hi", "proc result string");
    eprintln!("CHK mysql_proc_and_func_execute_return_results OK");
}
