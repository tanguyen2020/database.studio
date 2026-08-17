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

/// Items 1/2/4 — the Schema Compare snapshot (and the Explorer tree) rely on the
/// driver returning EVERY object type for PostgreSQL, not just tables/columns.
/// Seed a view, function, procedure, trigger, secondary index and sequence, then
/// prove each introspection call surfaces them (so the compare can display them).
#[tokio::test]
async fn pg_full_introspection_surfaces_every_object_type() {
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

    drv.exec("CREATE TABLE emp (id int PRIMARY KEY, name text, dept text)").await.unwrap();
    drv.exec("CREATE INDEX idx_emp_dept ON emp (dept)").await.unwrap();
    drv.exec("CREATE VIEW v_emp AS SELECT id, name FROM emp").await.unwrap();
    drv.exec("CREATE SEQUENCE seq_emp START 1").await.unwrap();
    drv.exec("CREATE FUNCTION emp_count() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM emp $$").await.unwrap();
    drv.exec("CREATE PROCEDURE touch_emp() LANGUAGE sql AS $$ UPDATE emp SET name = name $$").await.unwrap();
    drv.exec(
        "CREATE FUNCTION trg_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
    )
    .await
    .unwrap();
    drv.exec("CREATE TRIGGER trg_emp BEFORE INSERT ON emp FOR EACH ROW EXECUTE FUNCTION trg_fn()").await.unwrap();

    // columns (item 4 — must be present for every engine, not only MySQL)
    let cols = drv.columns("public", "emp").await.unwrap();
    assert!(cols.iter().any(|c| c.name == "id" && c.is_pk), "columns introspected: {cols:?}");
    assert_eq!(cols.len(), 3);

    // views appear in tables() with kind=view
    let tbls = drv.tables("public").await.unwrap();
    assert!(tbls.iter().any(|t| t.name == "v_emp" && t.kind == "view"), "view listed: {tbls:?}");

    // data_length (Objects tab): base tables report an on-disk size (pg_total_relation_size,
    // ≥ one index metapage even when empty); views leave it unreported.
    let emp_row = tbls.iter().find(|t| t.name == "emp").unwrap();
    assert!(emp_row.data_length.is_some_and(|b| b > 0), "table data_length reported: {emp_row:?}");

    // secondary index (not the PK) — used by the compare's index diff
    let ix = drv.indexes("public", "emp").await.unwrap();
    assert!(ix.iter().any(|i| i.name == "idx_emp_dept" && !i.primary && i.columns == vec!["dept".to_string()]), "secondary index: {ix:?}");

    // routines: both the function AND the procedure
    let routines = drv.routines("public").await.unwrap();
    assert!(routines.iter().any(|r| r.name == "emp_count"), "function listed: {routines:?}");
    assert!(routines.iter().any(|r| r.name == "touch_emp"), "procedure listed: {routines:?}");

    // functions() (Query Editor autocomplete): built-ins from pg_catalog that the
    // curated frontend set omits, PLUS the user function. Operator-support noise is
    // filtered, and a representative signature is attached.
    let fns = drv.functions("public").await.unwrap();
    for builtin in ["to_char", "date_trunc", "regexp_replace", "split_part", "jsonb_agg"] {
        assert!(fns.iter().any(|f| f.name == builtin), "built-in {builtin} suggested: {} fns", fns.len());
    }
    assert!(fns.iter().any(|f| f.name == "emp_count"), "user function suggested");
    // names fold overloads to one completion (no duplicate suggestions)
    let mut names: Vec<&String> = fns.iter().map(|f| &f.name).collect();
    let n = names.len();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), n, "function names are unique (overloads folded)");
    let to_char = fns.iter().find(|f| f.name == "to_char").unwrap();
    assert!(to_char.signature.as_deref().is_some_and(|s| s.starts_with("to_char(")), "signature: {to_char:?}");

    // triggers
    let trigs = drv.triggers("public").await.unwrap();
    assert!(trigs.iter().any(|t| t.name == "trg_emp" && t.table == "emp"), "trigger listed: {trigs:?}");

    // sequences (a bare CREATE SEQUENCE — the SERIAL-backed ones are also fine)
    let seqs = drv.sequences("public").await.unwrap();
    assert!(seqs.iter().any(|s| s.name == "seq_emp"), "sequence listed: {seqs:?}");

    eprintln!("CHK pg_full_introspection_surfaces_every_object_type OK");
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

/// Generate Test Data backend contract: columns() must flag IDENTITY *and* serial
/// columns as auto_increment (so the wizard omits them), and the exact INSERT the
/// generator emits — auto-increment columns omitted, FK drawn from a pool, PG
/// boolean rendered as the quoted literal 'true'/'false' — must run, with the DB
/// assigning the identity itself.
#[tokio::test]
async fn pg_columns_detect_identity_and_generate_contract() {
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
    drv.exec("CREATE TABLE tdc_p (id int PRIMARY KEY)").await.unwrap();
    drv.exec("INSERT INTO tdc_p VALUES (1),(2),(3)").await.unwrap();
    drv.exec(
        "CREATE TABLE tdc_c (\
           id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, \
           legacy_id serial, \
           parent_id int NOT NULL REFERENCES tdc_p(id), \
           is_active boolean NOT NULL, \
           status int NOT NULL, \
           name text NOT NULL)",
    )
    .await
    .unwrap();

    // introspection: IDENTITY + serial are auto_increment; ordinary columns are not.
    let cols = drv.columns("public", "tdc_c").await.unwrap();
    let get = |n: &str| cols.iter().find(|c| c.name == n).unwrap_or_else(|| panic!("col {n} missing: {cols:?}"));
    assert!(get("id").auto_increment, "IDENTITY flagged auto_increment: {cols:?}");
    assert!(get("legacy_id").auto_increment, "serial flagged auto_increment");
    assert!(!get("parent_id").auto_increment, "FK not auto_increment");
    assert!(!get("is_active").auto_increment, "bool not auto_increment");
    assert!(!get("status").auto_increment, "int not auto_increment");
    assert!(!get("name").auto_increment, "text not auto_increment");

    // The generator's INSERT: auto-increment columns omitted, FK from {1,2,3},
    // PG boolean as 'true'/'false', status int, name text.
    let pool = [1, 2, 3];
    let rows: Vec<String> = (0..300)
        .map(|i| {
            let b = if i % 2 == 0 { "'true'" } else { "'false'" };
            format!("({}, {b}, {}, 'n{i}')", pool[i % 3], i % 3)
        })
        .collect();
    let ins = drv
        .exec(&format!("INSERT INTO tdc_c (parent_id, is_active, status, name) VALUES {}", rows.join(",")))
        .await
        .unwrap();
    assert!(matches!(ins, StatementOutcome::Affected { affected: 300 }), "300 rows insert cleanly");

    // identity auto-assigned to unique values, FK integrity holds, booleans parsed.
    let out = drv
        .exec(
            "SELECT count(*) AS n, count(DISTINCT tdc_c.id) AS ids, \
                    count(*) FILTER (WHERE is_active) AS act \
             FROM tdc_c JOIN tdc_p ON tdc_c.parent_id = tdc_p.id",
        )
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(300), "FK integrity: all rows join a parent");
    assert_eq!(result.rows[0]["ids"], serde_json::json!(300), "identity assigned 300 distinct ids");
    assert_eq!(result.rows[0]["act"], serde_json::json!(150), "150 'true' booleans parsed");
}

/// columns() flags a MySQL AUTO_INCREMENT column so Generate Test Data omits it;
/// the generator's INSERT (id omitted, tinyint bool as 1/0) then round-trips.
#[tokio::test]
async fn mysql_columns_detect_auto_increment() {
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
    drv.exec("CREATE TABLE tdc_ai (id int AUTO_INCREMENT PRIMARY KEY, is_active tinyint(1) NOT NULL, name varchar(50) NOT NULL)")
        .await
        .unwrap();
    let cols = drv.columns("testdb", "tdc_ai").await.unwrap();
    assert!(cols.iter().find(|c| c.name == "id").unwrap().auto_increment, "AUTO_INCREMENT flagged: {cols:?}");
    assert!(!cols.iter().find(|c| c.name == "is_active").unwrap().auto_increment);
    assert!(!cols.iter().find(|c| c.name == "name").unwrap().auto_increment);

    // generator INSERT — id omitted, bool as 1/0
    drv.exec("INSERT INTO tdc_ai (is_active, name) VALUES (1,'a'),(0,'b'),(1,'c')").await.unwrap();
    let out = drv.exec("SELECT id, name FROM tdc_ai ORDER BY id").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows.len(), 3, "3 rows inserted");
    assert!(result.rows.iter().all(|r| !r["id"].is_null()), "AUTO_INCREMENT assigned ids: {:?}", result.rows);
}

/// U2 — MySQL User Manager, Definition-of-Done (spec §1.9). Runs EXACTLY the
/// SQL the frontend builders (`src/lib/users/mysql.ts`) produce, over the driver
/// exec path (TEXT protocol — proving CREATE USER/GRANT do NOT hit error 1295).
/// 6 steps: create → login as new account → denied → grant db read-only → OK →
/// write still denied → revoke → denied again → drop.
#[tokio::test]
async fn mysql_user_manager_end_to_end() {
    let c = GenericImage::new("mysql", "8")
        .with_exposed_port(3306.tcp())
        .with_env_var("MYSQL_ROOT_PASSWORD", PASS)
        .with_env_var("MYSQL_DATABASE", "testdb")
        .start()
        .await
        .expect("start mysql container");
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    // The admin binds to testdb; the new account connects with NO default
    // database (a fresh account cannot open testdb until granted) and uses
    // fully-qualified table names.
    let mk = |user: &str, password: &str, db: &str| MySqlConnParams {
        host: "localhost".into(),
        port,
        database: db.into(),
        user: user.into(),
        password: password.into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    };
    let admin_params = mk("root", PASS, "testdb");
    let user_params = mk("u_spec", "p'wd", "");
    let mut admin = retry("mysql", || MySqlDriver::connect(&admin_params, "mysql")).await;

    admin.exec("CREATE TABLE secret (id int PRIMARY KEY, v text)").await.unwrap();
    admin.exec("INSERT INTO secret VALUES (1,'x'),(2,'y')").await.unwrap();

    // 1. CREATE — exact output of createUser('mysql', {user:'u_spec', host:'%',
    //    password:"p'wd"}) — default plugin (caching_sha2_password).
    admin.exec(r#"CREATE USER 'u_spec'@'%' IDENTIFIED BY 'p''wd'"#).await.unwrap();

    // 2. LOGIN as the new account (TEXT-protocol driver path)
    let mut user = retry("mysql", || MySqlDriver::connect(&user_params, "mysql")).await;
    let out = user.exec("SELECT 1 AS ok").await.expect("login ok");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["ok"], serde_json::json!(1));

    // 3. DENIED before grant
    assert!(user.exec("SELECT * FROM testdb.secret").await.is_err(), "denied before grant");

    // 4. GRANT — exact output of dbPreset('read-only','testdb','u_spec','%')
    admin.exec("GRANT SELECT ON `testdb`.* TO 'u_spec'@'%'").await.unwrap();
    // reconnect so the new privileges take effect for the session
    let mut user = retry("mysql", || MySqlDriver::connect(&user_params, "mysql")).await;
    let out = user.exec("SELECT count(*) AS n FROM testdb.secret").await.expect("select after grant");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(2));

    // 5. WRITE still denied
    assert!(user.exec("INSERT INTO testdb.secret VALUES (3,'z')").await.is_err(), "read-only cannot INSERT");

    // 6. REVOKE — exact output of dbPreset('revoke-all','testdb','u_spec','%')
    admin.exec("REVOKE ALL PRIVILEGES ON `testdb`.* FROM 'u_spec'@'%'").await.unwrap();
    let mut user = retry("mysql", || MySqlDriver::connect(&user_params, "mysql")).await;
    assert!(user.exec("SELECT * FROM testdb.secret").await.is_err(), "denied again after revoke");

    admin.exec("DROP USER 'u_spec'@'%'").await.unwrap();
    let out = admin
        .exec("SELECT count(*) AS n FROM mysql.user WHERE user = 'u_spec'")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(0), "account gone");
}

/// U2 — MariaDB variant: same 6-step golden path + prove the `is_role` flag and
/// `SET DEFAULT ROLE … FOR` (MariaDB-only) grammar actually run.
#[tokio::test]
async fn mariadb_user_manager_end_to_end() {
    let c = GenericImage::new("mariadb", "11")
        .with_exposed_port(3306.tcp())
        .with_env_var("MARIADB_ROOT_PASSWORD", PASS)
        .with_env_var("MARIADB_DATABASE", "testdb")
        .start()
        .await
        .expect("start mariadb container");
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    let mk = |user: &str, password: &str, db: &str| MySqlConnParams {
        host: "localhost".into(),
        port,
        database: db.into(),
        user: user.into(),
        password: password.into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    };
    let admin_params = mk("root", PASS, "testdb");
    let user_params = mk("u_spec", "pw", "");
    let mut admin = retry("mariadb", || MySqlDriver::connect(&admin_params, "mariadb")).await;

    admin.exec("CREATE TABLE secret (id int PRIMARY KEY, v text)").await.unwrap();
    admin.exec("INSERT INTO secret VALUES (1,'x'),(2,'y')").await.unwrap();

    // 1. CREATE — createUser('mariadb', {user:'u_spec', host:'%', password:'pw'})
    admin.exec(r#"CREATE USER 'u_spec'@'%' IDENTIFIED BY 'pw'"#).await.unwrap();

    // 2. LOGIN (no default database — fresh account can't open testdb yet)
    let mut user = retry("mariadb", || MySqlDriver::connect(&user_params, "mariadb")).await;
    user.exec("SELECT 1 AS ok").await.expect("login ok");

    // 3. denied → 4. grant → OK
    assert!(user.exec("SELECT * FROM testdb.secret").await.is_err(), "denied before grant");
    admin.exec("GRANT SELECT ON `testdb`.* TO 'u_spec'@'%'").await.unwrap();
    let mut user = retry("mariadb", || MySqlDriver::connect(&user_params, "mariadb")).await;
    let out = user.exec("SELECT count(*) AS n FROM testdb.secret").await.expect("ok after grant");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(2));

    // 5. write denied → 6. revoke → denied
    assert!(user.exec("INSERT INTO testdb.secret VALUES (3,'z')").await.is_err(), "read-only cannot INSERT");
    admin.exec("REVOKE ALL PRIVILEGES ON `testdb`.* FROM 'u_spec'@'%'").await.unwrap();

    // MariaDB-specific: is_role flag + roles_mapping + `SET DEFAULT ROLE … FOR`
    admin.exec("CREATE ROLE 'reader'").await.unwrap();
    admin.exec("GRANT SELECT ON `testdb`.* TO 'reader'").await.unwrap();
    admin.exec("GRANT 'reader' TO 'u_spec'@'%'").await.unwrap();
    admin.exec("SET DEFAULT ROLE 'reader' FOR 'u_spec'@'%'").await.unwrap();
    let out = admin
        .exec("SELECT is_role FROM mysql.user WHERE user = 'reader'")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["is_role"], serde_json::json!("Y"), "reader is flagged is_role=Y");
    // default role active → the user reads via the role after reconnect
    let mut user = retry("mariadb", || MySqlDriver::connect(&user_params, "mariadb")).await;
    let out = user.exec("SELECT count(*) AS n FROM testdb.secret").await.expect("reads via default role");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(2), "default role grants SELECT");

    admin.exec("DROP USER 'u_spec'@'%'").await.unwrap();
    admin.exec("DROP ROLE 'reader'").await.unwrap();
}

/// columns() flags a SQL Server IDENTITY column as auto_increment; the generator's
/// INSERT (identity omitted, bit bool as 1/0) round-trips with server-assigned ids.
#[tokio::test]
async fn mssql_columns_detect_identity() {
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
    drv.exec("CREATE TABLE dbo.tdc_id (id int IDENTITY(1,1) PRIMARY KEY, is_active bit NOT NULL, name nvarchar(50) NOT NULL)")
        .await
        .unwrap();
    let cols = drv.columns("dbo", "tdc_id").await.unwrap();
    assert!(cols.iter().find(|c| c.name == "id").unwrap().auto_increment, "IDENTITY flagged: {cols:?}");
    assert!(!cols.iter().find(|c| c.name == "is_active").unwrap().auto_increment);
    assert!(!cols.iter().find(|c| c.name == "name").unwrap().auto_increment);

    drv.exec("INSERT INTO dbo.tdc_id (is_active, name) VALUES (1,'a'),(0,'b'),(1,'c')").await.unwrap();
    let out = drv.exec("SELECT id, name FROM dbo.tdc_id ORDER BY id").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows.len(), 3, "3 rows inserted");
    assert!(result.rows.iter().all(|r| !r["id"].is_null()), "IDENTITY assigned ids: {:?}", result.rows);
}

/// columns() flags a SQLite INTEGER PRIMARY KEY (rowid alias) as auto_increment;
/// the generator's INSERT omits it and SQLite assigns the rowid.
#[tokio::test]
async fn sqlite_columns_detect_integer_pk_rowid() {
    let drv = SqliteDriver::connect(&SqliteConnParams { path: String::new(), mode: SqliteMode::InMemory })
        .await
        .unwrap();
    drv.exec("CREATE TABLE tdc_row (id INTEGER PRIMARY KEY, is_active INTEGER NOT NULL, name TEXT NOT NULL)")
        .await
        .unwrap();
    let cols = drv.columns("main", "tdc_row").await.unwrap();
    assert!(cols.iter().find(|c| c.name == "id").unwrap().auto_increment, "INTEGER PK flagged: {cols:?}");
    assert!(!cols.iter().find(|c| c.name == "is_active").unwrap().auto_increment);
    assert!(!cols.iter().find(|c| c.name == "name").unwrap().auto_increment);

    drv.exec("INSERT INTO tdc_row (is_active, name) VALUES (1,'a'),(0,'b'),(1,'c')").await.unwrap();
    let out = drv.exec("SELECT id, name FROM tdc_row ORDER BY id").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows.len(), 3, "3 rows inserted");
    assert!(result.rows.iter().all(|r| !r["id"].is_null()), "rowid assigned: {:?}", result.rows);
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

/// U1 — PostgreSQL User Manager, Definition-of-Done (spec §1.9): the 6-step
/// golden path proven on a real container. Runs EXACTLY the SQL the frontend
/// builders (`src/lib/users/postgres.ts`) produce (locked by unit tests).
///   1 CREATE role+password → 2 LOGIN as it → 3 SELECT denied → 4 GRANT (preset
///   read-only) → SELECT OK → 5 INSERT still denied → 6 REVOKE → denied again,
///   DROP → gone.
#[tokio::test]
async fn pg_user_manager_end_to_end() {
    let (_c, port) = start_pg().await;
    let admin_params = PgConnParams {
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
    let mut admin = retry("postgres", || PgDriver::connect(&admin_params)).await;

    // seed a table the new role must NOT be able to read until granted
    admin.exec("CREATE TABLE secret (id int PRIMARY KEY, v text)").await.unwrap();
    admin.exec("INSERT INTO secret VALUES (1,'x'), (2,'y')").await.unwrap();

    // 1. CREATE — exact output of createRole('u_spec', {login:true, password:"p'wd"})
    admin.exec(r#"CREATE ROLE "u_spec" LOGIN PASSWORD 'p''wd'"#).await.unwrap();

    // 2. LOGIN — connect a NEW driver as the created role
    let user_params = PgConnParams {
        host: "localhost".into(),
        port,
        database: "testdb".into(),
        user: "u_spec".into(),
        password: "p'wd".into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    };
    let mut user = retry("postgres", || PgDriver::connect(&user_params)).await;
    let out = user.exec("SELECT 1 AS ok").await.expect("login + trivial select");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["ok"], serde_json::json!(1));

    // 3. DENIED before grant
    assert!(user.exec("SELECT * FROM secret").await.is_err(), "must be denied before grant");

    // 4. GRANT — exact output of presetReadOnly('public','u_spec')
    admin.exec(r#"GRANT USAGE ON SCHEMA "public" TO "u_spec""#).await.unwrap();
    admin.exec(r#"GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "u_spec""#).await.unwrap();
    admin.exec(r#"GRANT SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "u_spec""#).await.unwrap();
    let out = user.exec("SELECT count(*) AS n FROM secret").await.expect("select after grant");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(2), "read-only user can now SELECT");

    // 5. WRITE still denied (read-only boundary)
    assert!(
        user.exec("INSERT INTO secret VALUES (3,'z')").await.is_err(),
        "read-only user must NOT be able to INSERT",
    );

    // 6. REVOKE — exact output of presetRevokeAll('public','u_spec', ['postgres'])
    admin.exec(r#"REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM "u_spec""#).await.unwrap();
    admin.exec(r#"REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "public" FROM "u_spec""#).await.unwrap();
    admin.exec(r#"REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "public" FROM "u_spec""#).await.unwrap();
    admin.exec(r#"REVOKE USAGE, CREATE ON SCHEMA "public" FROM "u_spec""#).await.unwrap();
    assert!(user.exec("SELECT * FROM secret").await.is_err(), "must be denied again after revoke");

    // create-with-role parity: a NEW role created with `IN ROLE <group>` (the
    // exact inline output of createRole('u_inrole', {login, password, inRole})
    // from the create popup) inherits the group's privileges immediately.
    admin.exec(r#"CREATE ROLE "grp_spec" NOLOGIN"#).await.unwrap();
    admin.exec(r#"GRANT USAGE ON SCHEMA "public" TO "grp_spec""#).await.unwrap();
    admin.exec(r#"GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "grp_spec""#).await.unwrap();
    admin.exec(r#"CREATE ROLE "u_inrole" LOGIN PASSWORD 'r''wd' IN ROLE "grp_spec""#).await.unwrap();
    let inrole_params = PgConnParams {
        host: "localhost".into(),
        port,
        database: "testdb".into(),
        user: "u_inrole".into(),
        password: "r'wd".into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    };
    let mut inrole = retry("postgres", || PgDriver::connect(&inrole_params)).await;
    let out = inrole.exec("SELECT count(*) AS n FROM secret").await.expect("member inherits group SELECT");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(2), "IN ROLE membership grants inherited read at creation");
    drop(inrole);
    admin.exec(r#"DROP OWNED BY "grp_spec""#).await.unwrap();
    admin.exec(r#"DROP ROLE "u_inrole""#).await.unwrap();
    admin.exec(r#"DROP ROLE "grp_spec""#).await.unwrap();

    // multi-database grants: PG roles are cluster-level, but grants are per
    // database. The wizard applies the SAME schema grants to each selected
    // database via a connection to it (attach_database). Prove it works across
    // a SECOND database: grant read-only there and confirm u_spec can read.
    admin.exec("CREATE DATABASE testdb2").await.unwrap();
    let admin2_params = PgConnParams { database: "testdb2".into(), user: "postgres".into(), password: PASS.into(), host: "localhost".into(), port, ssl: false, ssl_ca: String::new(), ssl_cert: String::new(), ssl_key: String::new() };
    let mut admin2 = retry("postgres", || PgDriver::connect(&admin2_params)).await;
    admin2.exec("CREATE TABLE only_db2 (id int PRIMARY KEY)").await.unwrap();
    admin2.exec("INSERT INTO only_db2 VALUES (1),(2),(3)").await.unwrap();
    // read-only preset run ON testdb2 (exact presetReadOnly output)
    admin2.exec(r#"GRANT USAGE ON SCHEMA "public" TO "u_spec""#).await.unwrap();
    admin2.exec(r#"GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "u_spec""#).await.unwrap();
    let u2_params = PgConnParams { database: "testdb2".into(), user: "u_spec".into(), password: "p'wd".into(), host: "localhost".into(), port, ssl: false, ssl_ca: String::new(), ssl_cert: String::new(), ssl_key: String::new() };
    let mut u2 = retry("postgres", || PgDriver::connect(&u2_params)).await;
    let out = u2.exec("SELECT count(*) AS n FROM only_db2").await.expect("read granted in testdb2");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(3), "u_spec reads its granted table in the second database");
    drop(u2);
    admin2.exec(r#"DROP OWNED BY "u_spec""#).await.unwrap(); // clear testdb2 grants so DROP ROLE succeeds
    drop(admin2);
    admin.exec("DROP DATABASE testdb2").await.unwrap();

    // DROP — clean up (DROP OWNED clears any residual grants first)
    admin.exec(r#"DROP OWNED BY "u_spec""#).await.unwrap();
    admin.exec(r#"DROP ROLE "u_spec""#).await.unwrap();
    let out = admin
        .exec("SELECT count(*) AS n FROM pg_roles WHERE rolname = 'u_spec'")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(0), "role must be gone");
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

/// Item 6 — per-tab connection isolation. `open_tab_connection` gives each Query
/// Editor tab its own registry entry (`{base}#tab-N`). This proves the guarantee
/// those entries provide: a hung query on one tab does NOT block another tab, and
/// cancel/disconnect stops the hung one. (If tabs shared one connection, tab-2
/// would block until the 30s sleep finished → the 8s timeout would fire.)
#[tokio::test]
async fn tab_connections_are_isolated_hung_query_does_not_block() {
    use database_studio_lib::connections::profile::{
        ConnectionProfile, Environment, SqliteMode, SshConfig,
    };
    use database_studio_lib::connections::registry::Registry;
    use database_studio_lib::drivers::types::{StatementOutcome, SystemType};
    use std::sync::Arc;

    let (_c, port) = start_pg().await;
    let mk = |id: &str| ConnectionProfile {
        id: id.into(),
        name: "tabconn".into(),
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

    let registry = Arc::new(Registry::default());
    // two dedicated per-tab connections to the SAME database (retry until ready)
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        match registry.connect(mk("base#tab-1"), PASS.into(), String::new()).await {
            Ok(_) => break,
            Err(e) => {
                assert!(Instant::now() < deadline, "connect timeout: {e:?}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    registry.connect(mk("base#tab-2"), PASS.into(), String::new()).await.expect("second tab connection");

    // tab-1: a hung query (30s) — spawn, do NOT await.
    let reg1 = Arc::clone(&registry);
    let hung = tokio::spawn(async move { reg1.exec_statement("base#tab-1", "SELECT pg_sleep(30)".into()).await });
    tokio::time::sleep(Duration::from_millis(500)).await; // let it start + register its abort handle

    // tab-2: a normal query must finish quickly despite tab-1 being stuck.
    let t2 = tokio::time::timeout(
        Duration::from_secs(8),
        registry.exec_statement("base#tab-2", "SELECT 1 AS n".into()),
    )
    .await;
    let outcome = t2.expect("tab-2 was blocked by tab-1's hung query — NOT isolated").unwrap().unwrap();
    let StatementOutcome::Rows { result } = outcome else { panic!("expected rows") };
    assert_eq!(result.total, 1, "tab-2 ran independently while tab-1 hung");

    // cancel the hung tab-1 query (as closing tab-1 would) → its task aborts.
    assert!(registry.cancel("base#tab-1"), "cancel returns true for tab-1's running query");
    let _ = hung.await;

    registry.disconnect("base#tab-1").await.unwrap();
    registry.disconnect("base#tab-2").await.unwrap();
    assert!(!registry.is_connected("base#tab-1") && !registry.is_connected("base#tab-2"));
    eprintln!("CHK tab_connections_are_isolated_hung_query_does_not_block OK");
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

/// Bug: a VARCHAR/TEXT column with a `_bin` collation (e.g. utf8mb4_bin) makes
/// MySQL set the protocol BINARY_FLAG on the result column, so sqlx types it
/// VARBINARY and `decode_value` used to hex-dump the (UTF-8 text) bytes as `0x…`.
/// The column's real catalog type stays `varchar` (collation-independent), which
/// is why Table Designer showed varchar while the grid showed varbinary+hex.
/// decode_value now decodes such bytes as UTF-8 → real text; genuine non-UTF-8
/// binary still renders as a hex string.
#[tokio::test]
async fn mysql_bin_collation_text_column_is_not_hex() {
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
    // receipt_no mirrors the reported column (varchar + _bin collation).
    // blob_col is genuine binary that is NOT valid UTF-8 → must stay hex.
    drv.exec(
        "CREATE TABLE it_bin (id int PRIMARY KEY, \
         receipt_no varchar(100) COLLATE utf8mb4_bin, \
         blob_col varbinary(16))",
    )
    .await
    .unwrap();
    drv.exec("INSERT INTO it_bin VALUES (1, 'PT-d49534d4', UNHEX('00ff01fe'))")
        .await
        .unwrap();

    let out = drv.exec("SELECT receipt_no, blob_col FROM it_bin WHERE id = 1").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    let row = &result.rows[0];
    // _bin-collation text → real text, NOT a 0x… hex dump
    assert_eq!(row["receipt_no"], serde_json::json!("PT-d49534d4"));
    // genuine non-UTF-8 binary (has 0xff + NUL) → hex string
    assert_eq!(row["blob_col"], serde_json::json!("0x00ff01fe"));

    // Header type is corrected: the all-text _bin column reads as varchar, while
    // the genuinely-binary column stays varbinary.
    let ty = |name: &str| result.cols.iter().find(|(n, _)| n == name).map(|(_, t)| t.as_str());
    assert_eq!(ty("receipt_no"), Some("varchar"), "cols: {:?}", result.cols);
    assert_eq!(ty("blob_col"), Some("varbinary"), "cols: {:?}", result.cols);
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
    drv.exec("CREATE PROCEDURE p_touch(IN v INT) BEGIN UPDATE students SET gpa = gpa WHERE id = v; END")
        .await
        .unwrap();
    drv.exec("CREATE FUNCTION f_double(x INT) RETURNS INT DETERMINISTIC RETURN x * 2").await.unwrap();

    // Reproduce the user's "Illegal mix of collations" scenario: force a connection
    // collation (utf8mb4_0900_as_cs) that differs from the information_schema column
    // collations. Every introspection query below must still work — they are
    // COLLATE-guarded. Without the guards, routines()/triggers()/schemas() would raise
    // MySQL error 1267 here.
    drv.exec("SET collation_connection = 'utf8mb4_0900_as_cs'").await.unwrap();

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
    // data_length (Objects tab): InnoDB reports DATA_LENGTH + INDEX_LENGTH for the
    // seeded table (≥ one 16 KB page after the insert above).
    assert!(base.data_length.is_some_and(|b| b > 0), "table data_length reported: {base:?}");
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

    // Stored Procedures + Functions folders (the reported failure): routines() must
    // list both, with parameters, under the mismatched connection collation.
    let routines = drv.routines("testdb").await.unwrap();
    let proc = routines.iter().find(|r| r.name == "p_touch").expect("procedure listed");
    assert_eq!(proc.kind, "procedure");
    assert_eq!(proc.params.len(), 1, "procedure IN param read (routine_params collation-safe)");
    let func = routines.iter().find(|r| r.name == "f_double").expect("function listed");
    assert_eq!(func.kind, "function");

    // functions() (Query Editor autocomplete): MySQL built-ins aren't in any catalog
    // (the frontend merges those in statically), so this surfaces the USER function.
    let fns = drv.functions("testdb").await.unwrap();
    assert!(fns.iter().any(|f| f.name == "f_double"), "user function suggested: {fns:?}");

    // remaining introspection under the mismatched collation must not raise 1267 either.
    assert!(drv.indexes("testdb", "students").await.unwrap().iter().any(|i| i.primary), "PK index read");
    assert!(!drv.constraints("testdb", "students").await.unwrap().is_empty(), "constraints read");
    drv.foreign_keys("testdb").await.unwrap();
    drv.scan_indexes("testdb").await.unwrap();
}

/// Item 7 — executing MySQL stored functions/procedures of assorted parameter and
/// return data types (SELECT func(...) / CALL proc(...)), exactly as the Execute
/// Routine dialog builds them. Guards that value decoding handles each result type.
#[tokio::test]
async fn mysql_execute_stored_routines_datatypes() {
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

    // functions returning INT / DECIMAL / DATETIME / VARCHAR with typed params
    drv.exec("CREATE FUNCTION f_add(a INT, b INT) RETURNS INT DETERMINISTIC RETURN a + b").await.unwrap();
    drv.exec("CREATE FUNCTION f_price(qty INT, unit DECIMAL(10,2)) RETURNS DECIMAL(12,2) DETERMINISTIC RETURN qty * unit").await.unwrap();
    drv.exec("CREATE FUNCTION f_greet(who VARCHAR(50)) RETURNS VARCHAR(120) DETERMINISTIC RETURN CONCAT('hi ', who)").await.unwrap();
    drv.exec("CREATE FUNCTION f_when(d DATE) RETURNS DATETIME DETERMINISTIC RETURN TIMESTAMP(d)").await.unwrap();
    // a procedure that returns a result set (CALL)
    drv.exec("CREATE PROCEDURE p_nums() BEGIN SELECT 1 AS n UNION SELECT 2 UNION SELECT 3; END").await.unwrap();

    // SELECT db.func(args) — the shape buildCall() emits for a scalar function
    let row1 = |o: &StatementOutcome| -> serde_json::Value {
        let StatementOutcome::Rows { result } = o else { panic!("expected rows, got {o:?}") };
        result.rows.first().and_then(|r| r.as_object()).and_then(|m| m.values().next()).cloned().unwrap_or(serde_json::Value::Null)
    };

    let out = drv.exec("SELECT `testdb`.`f_add`(2, 3)").await.expect("execute f_add");
    assert_eq!(row1(&out), serde_json::json!(5), "INT function result");

    let out = drv.exec("SELECT `testdb`.`f_price`(3, '4.50')").await.expect("execute f_price");
    assert_eq!(row1(&out), serde_json::json!("13.50"), "DECIMAL function result (string-preserved)");

    let out = drv.exec("SELECT `testdb`.`f_greet`('bo')").await.expect("execute f_greet");
    assert_eq!(row1(&out), serde_json::json!("hi bo"), "VARCHAR function result");

    let out = drv.exec("SELECT `testdb`.`f_when`('2026-07-07')").await.expect("execute f_when");
    let StatementOutcome::Rows { result } = &out else { panic!("expected rows") };
    let dt = result.rows[0].as_object().unwrap().values().next().unwrap().as_str().unwrap_or("");
    assert!(dt.starts_with("2026-07-07"), "DATETIME function result: {dt}");

    // CALL db.proc() — procedure returning a result set
    let out = drv.exec("CALL `testdb`.`p_nums`()").await.expect("execute p_nums");
    let StatementOutcome::Rows { result } = &out else { panic!("CALL should return rows, got {out:?}") };
    assert_eq!(result.total, 3, "procedure result set rows");

    // procedure with IN + OUT + INOUT params — the real item-7 failure. Passing a
    // literal for OUT/INOUT (what the old dialog did) is rejected by MySQL; the fix
    // (buildRoutineExec) must use session variables and SELECT them back.
    drv.exec(
        "CREATE PROCEDURE p_calc(IN qty INT, IN unit DECIMAL(10,2), OUT total DECIMAL(12,2), INOUT tax DECIMAL(12,2)) \
         BEGIN SET total = qty * unit; SET tax = total * tax; END",
    )
    .await
    .unwrap();

    // OLD (buggy) shape: literal for OUT/INOUT → MySQL "not a variable" error
    assert!(
        drv.exec("CALL `testdb`.`p_calc`(3, 4.50, 0, 0.1)").await.is_err(),
        "passing a literal for OUT/INOUT must fail — this is the reported item-7 bug",
    );

    // NEW shape (exactly what buildRoutineExec emits): SET @vars; CALL(...@vars...); SELECT @vars
    drv.exec("SET @_total = NULL").await.unwrap();
    drv.exec("SET @_tax = 0.10").await.unwrap();
    drv.exec("CALL `testdb`.`p_calc`(3, 4.50, @_total, @_tax)").await.expect("CALL with session vars");
    let out = drv.exec("SELECT @_total AS `total`, @_tax AS `tax`").await.expect("read OUT/INOUT vars");
    let StatementOutcome::Rows { result } = &out else { panic!("expected rows") };
    let obj = result.rows[0].as_object().unwrap();
    assert!(obj["total"].to_string().contains("13.5"), "OUT total via session var: {}", obj["total"]);
    assert!(obj["tax"].to_string().contains("1.35"), "INOUT tax via session var: {}", obj["tax"]);

    eprintln!("CHK mysql_execute_stored_routines_datatypes OK");
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

/// Query Editor must ALWAYS return the latest committed data — reproduces the
/// "results are cached" report. The container's server default is
/// `autocommit=0`; before the driver pinned `SET SESSION autocommit = 1`, the
/// editor's long-lived connection opened an implicit transaction on its first
/// statement and, under InnoDB's REPEATABLE READ, replayed that same snapshot
/// for every later SELECT — so another session's committed UPDATE stayed
/// invisible forever.
async fn mysql_like_reads_latest_committed(image: (&str, &str), env_prefix: &str, system: &'static str) {
    let c = GenericImage::new(image.0, image.1)
        .with_exposed_port(3306.tcp())
        .with_env_var(format!("{env_prefix}_ROOT_PASSWORD"), PASS)
        .with_env_var(format!("{env_prefix}_DATABASE"), "testdb")
        .with_cmd(vec!["--autocommit=0"])
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
    // The editor's connection (the app keeps one per tab, long-lived).
    let mut editor = retry(system, || MySqlDriver::connect(&params, system)).await;
    // A second, independent session stands in for "someone else changes the data"
    // (another app, another tab, a DBA). It COMMITs explicitly, so the test proves
    // the reader's behaviour and does not depend on the writer's autocommit.
    let mut writer = MySqlDriver::connect(&params, system).await.expect("second session");

    async fn v_of(drv: &mut MySqlDriver) -> i64 {
        let out = drv.exec("SELECT v FROM fresh_reads WHERE id = 1").await.unwrap();
        let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
        result.rows[0]["v"].as_i64().expect("int value")
    }

    writer.exec("CREATE TABLE fresh_reads (id int PRIMARY KEY, v int)").await.unwrap();
    writer.exec("INSERT INTO fresh_reads VALUES (1, 1)").await.unwrap();
    writer.exec("COMMIT").await.unwrap();

    assert_eq!(v_of(&mut editor).await, 1, "{system}: editor reads the seeded value");

    writer.exec("UPDATE fresh_reads SET v = 2 WHERE id = 1").await.unwrap();
    writer.exec("COMMIT").await.unwrap();

    assert_eq!(
        v_of(&mut editor).await,
        2,
        "{system}: the editor connection served a STALE snapshot — a committed change was not visible",
    );

    // The fix must not take explicit transactions away: a user-typed
    // START TRANSACTION still overrides autocommit until COMMIT/ROLLBACK.
    editor.exec("START TRANSACTION").await.unwrap();
    editor.exec("UPDATE fresh_reads SET v = 9 WHERE id = 1").await.unwrap();
    assert_eq!(v_of(&mut editor).await, 9, "{system}: sees its own uncommitted write");
    editor.exec("ROLLBACK").await.unwrap();
    assert_eq!(v_of(&mut editor).await, 2, "{system}: ROLLBACK restored the committed value");

    // …and after the transaction ends, fresh reads resume.
    writer.exec("UPDATE fresh_reads SET v = 3 WHERE id = 1").await.unwrap();
    writer.exec("COMMIT").await.unwrap();
    assert_eq!(v_of(&mut editor).await, 3, "{system}: reads stay fresh after an explicit transaction");
    eprintln!("CHK {system}_editor_reads_latest_committed OK");
}

/// Same freshness contract for PostgreSQL, including the hostile server config
/// (`default_transaction_isolation = repeatable read`) — each editor statement
/// must still see another session's committed change. Also pins down the ONE
/// way a PG editor connection can serve stale data: a transaction the user
/// opened by hand (`BEGIN`) and never closed.
#[tokio::test]
async fn pg_editor_reads_latest_committed() {
    let c = GenericImage::new("postgres", "16-alpine")
        .with_exposed_port(5432.tcp())
        .with_env_var("POSTGRES_PASSWORD", PASS)
        .with_env_var("POSTGRES_DB", "testdb")
        // Worst case for snapshot reuse: a session that opens a transaction keeps
        // ONE snapshot for its whole life.
        .with_cmd(vec!["postgres", "-c", "default_transaction_isolation=repeatable read"])
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
    let mut editor = retry("postgres", || PgDriver::connect(&params)).await;
    let mut writer = PgDriver::connect(&params).await.expect("second session");

    async fn v_of(d: &mut PgDriver) -> i64 {
        let out = d.exec("SELECT v FROM fresh_reads WHERE id = 1").await.unwrap();
        let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
        result.rows[0]["v"].as_i64().expect("int value")
    }

    writer.exec("CREATE TABLE fresh_reads (id int PRIMARY KEY, v int)").await.unwrap();
    writer.exec("INSERT INTO fresh_reads VALUES (1, 1)").await.unwrap();
    assert_eq!(v_of(&mut editor).await, 1, "editor reads the seeded value");

    writer.exec("UPDATE fresh_reads SET v = 2 WHERE id = 1").await.unwrap();
    assert_eq!(
        v_of(&mut editor).await,
        2,
        "postgres: the editor connection served a STALE snapshot — a committed change was not visible",
    );

    // The editor's own writes are committed immediately (autocommit), so another
    // session sees them without any extra step.
    editor.exec("UPDATE fresh_reads SET v = 5 WHERE id = 1").await.unwrap();
    assert_eq!(v_of(&mut writer).await, 5, "postgres: editor write was not committed");

    // …and the ONE stale case: a hand-typed BEGIN pins the snapshot until the
    // user ends the transaction (this is correct SQL semantics, not a bug — the
    // app must SHOW it, which is what the transaction indicator does).
    editor.exec("BEGIN").await.unwrap();
    let _ = v_of(&mut editor).await; // takes the snapshot
    writer.exec("UPDATE fresh_reads SET v = 6 WHERE id = 1").await.unwrap();
    assert_eq!(v_of(&mut editor).await, 5, "inside an explicit transaction the snapshot is pinned");
    editor.exec("ROLLBACK").await.unwrap();
    assert_eq!(v_of(&mut editor).await, 6, "after ROLLBACK reads are fresh again");
    eprintln!("CHK pg_editor_reads_latest_committed OK");
}

#[tokio::test]
async fn mysql_editor_reads_latest_committed() {
    mysql_like_reads_latest_committed(("mysql", "8"), "MYSQL", "mysql").await;
}

#[tokio::test]
async fn mariadb_editor_reads_latest_committed() {
    mysql_like_reads_latest_committed(("mariadb", "11"), "MARIADB", "mariadb").await;
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

    // tables() lists the table with a data_length (Objects tab) — reserved pages from
    // sys.dm_db_partition_stats (≥ one 8 KB page for the seeded table).
    let tbls = drv.tables("dbo").await.unwrap();
    let it_t = tbls.iter().find(|t| t.name == "it_t").expect("it_t listed");
    assert!(it_t.data_length.is_some_and(|b| b > 0), "mssql data_length reported: {it_t:?}");

    // functions() (Query Editor autocomplete): built-in T-SQL functions aren't
    // catalog objects (the frontend supplies those statically) — this surfaces the
    // USER function below.
    drv.exec("CREATE FUNCTION dbo.fn_double(@x int) RETURNS int AS BEGIN RETURN @x * 2 END")
        .await
        .unwrap();
    let fns = drv.functions("dbo").await.unwrap();
    assert!(fns.iter().any(|f| f.name == "fn_double"), "mssql user function suggested: {fns:?}");

    // MSSQL trả line number cho lỗi → position
    let err = drv.exec("SELECT 1\nFROM bang_khong_co").await.expect_err("phải fail");
    assert_eq!(err.code.as_deref(), Some("208"));
    assert!(err.position.is_some(), "MSSQL line phải map sang position");
}

/// U3 — MSSQL User Manager, Definition-of-Done (spec §1.9 + §5.4). Two-tier
/// Login↔User, and DENY overriding a schema GRANT. Runs EXACTLY the SQL the
/// frontend builders (`src/lib/users/mssql.ts`) produce, over the raw-batch
/// path (is_raw_batch now covers GRANT/DENY/REVOKE).
#[tokio::test]
async fn mssql_user_manager_end_to_end() {
    let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
        .with_exposed_port(1433.tcp())
        .with_env_var("ACCEPT_EULA", "Y")
        .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
        .start()
        .await
        .expect("start mssql container");
    let port = c.get_host_port_ipv4(1433).await.unwrap();
    let mk = |db: &str, user: &str, password: &str| MssqlConnParams {
        host: "localhost".into(),
        port,
        database: db.into(),
        user: user.into(),
        password: password.into(),
        ssl: false,
        ssl_ca: String::new(),
        auth: "sql".into(),
    };
    // admin on master → create the app database
    let admin_params = mk("", "sa", MSSQL_PASS);
    let mut admin = retry("mssql", || MssqlDriver::connect(&admin_params)).await;
    admin.exec("CREATE DATABASE appdb").await.unwrap();
    // admin bound to appdb for database-scoped statements
    let app_params = mk("appdb", "sa", MSSQL_PASS);
    let mut app = retry("mssql", || MssqlDriver::connect(&app_params)).await;
    app.exec("CREATE TABLE dbo.secret (id int PRIMARY KEY, v nvarchar(20))").await.unwrap();
    app.exec("INSERT INTO dbo.secret VALUES (1, N'x'), (2, N'y')").await.unwrap();
    app.exec("CREATE TABLE dbo.other (id int PRIMARY KEY)").await.unwrap();
    app.exec("INSERT INTO dbo.other VALUES (1)").await.unwrap();

    // 1. CREATE LOGIN — exact output of createLogin({name:'u_spec', password, checkPolicy:false})
    admin
        .exec("CREATE LOGIN [u_spec] WITH PASSWORD = N'Str0ngPwd!', CHECK_POLICY = OFF")
        .await
        .unwrap();
    // CREATE USER FOR LOGIN (needed to open appdb) — createUser('u_spec','u_spec')
    app.exec("CREATE USER [u_spec] FOR LOGIN [u_spec]").await.unwrap();

    // 2. LOGIN as the new principal into appdb
    let user_params = mk("appdb", "u_spec", "Str0ngPwd!");
    let mut user = retry("mssql", || MssqlDriver::connect(&user_params)).await;
    user.exec("SELECT 1 AS ok").await.expect("login + connect to appdb");

    // 3. DENIED before grant
    assert!(user.exec("SELECT * FROM dbo.secret").await.is_err(), "denied before grant");

    // 4. GRANT — schemaPreset('read-only','dbo','u_spec'). Reassign (not shadow)
    // so the previous session is dropped — else stale u_spec logins block DROP.
    app.exec("GRANT SELECT ON SCHEMA::[dbo] TO [u_spec]").await.unwrap();
    user = retry("mssql", || MssqlDriver::connect(&user_params)).await;
    let out = user.exec("SELECT count(*) AS n FROM dbo.secret").await.expect("select after grant");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(2));

    // 5a. WRITE denied (read-only)
    assert!(user.exec("INSERT INTO dbo.secret VALUES (3, N'z')").await.is_err(), "read-only cannot INSERT");

    // 5b. DENY on one table overrides the schema GRANT (DENY wins)
    app.exec("DENY SELECT ON [dbo].[secret] TO [u_spec]").await.unwrap();
    user = retry("mssql", || MssqlDriver::connect(&user_params)).await;
    assert!(user.exec("SELECT * FROM dbo.secret").await.is_err(), "DENY overrides schema GRANT on secret");
    let out = user.exec("SELECT count(*) AS n FROM dbo.other").await.expect("other still readable");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(1), "schema GRANT still applies to other");

    // 6. REVOKE + DROP — permission('REVOKE', …) → uses FROM (removes GRANT & DENY)
    app.exec("REVOKE SELECT ON [dbo].[secret] FROM [u_spec]").await.unwrap();
    app.exec("REVOKE SELECT ON SCHEMA::[dbo] FROM [u_spec]").await.unwrap();
    user = retry("mssql", || MssqlDriver::connect(&user_params)).await;
    assert!(user.exec("SELECT * FROM dbo.other").await.is_err(), "denied again after revoke");
    // close the user's session before dropping its login (else error 15434)
    drop(user);
    tokio::time::sleep(Duration::from_secs(2)).await;
    app.exec("DROP USER [u_spec]").await.unwrap();
    admin.exec("DROP LOGIN [u_spec]").await.unwrap();
    let out = admin
        .exec("SELECT count(*) AS n FROM sys.server_principals WHERE name = 'u_spec'")
        .await
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(0), "login gone");
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

    let p = plan::parse_mssql_xml(&xml, false).expect("parse SHOWPLAN_XML");
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

/// U4 — ClickHouse User Manager, Definition-of-Done (spec §1.9). Requires
/// ACCESS MANAGEMENT (env CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1). Runs EXACTLY
/// the SQL the frontend builders (`src/lib/users/clickhouse.ts`) produce, and
/// locks the `storage` value ('local_directory') the read-only badge depends on.
#[tokio::test]
async fn clickhouse_user_manager_end_to_end() {
    let c = GenericImage::new("clickhouse/clickhouse-server", "24.8")
        .with_exposed_port(8123.tcp())
        .with_env_var("CLICKHOUSE_PASSWORD", PASS)
        .with_env_var("CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", "1")
        .start()
        .await
        .expect("start clickhouse container");
    let port = c.get_host_port_ipv4(8123).await.unwrap();
    let mk = |user: &str, password: &str| ChConnParams {
        host: "localhost".into(),
        port,
        database: "default".into(),
        user: user.into(),
        password: password.into(),
        ssl: false,
    };
    let admin_params = mk("default", PASS);
    let mut admin = retry("clickhouse", || ChDriver::connect(&admin_params)).await;

    admin.exec("CREATE DATABASE appdb").await.unwrap();
    admin.exec("CREATE TABLE appdb.secret (id UInt64, v String) ENGINE = MergeTree ORDER BY id").await.unwrap();
    admin.exec("INSERT INTO appdb.secret VALUES (1,'x'),(2,'y')").await.unwrap();

    // 1. CREATE — createUser({name:'app', password:'pw'})
    admin.exec("CREATE USER `app` IDENTIFIED WITH sha256_password BY 'pw'").await.unwrap();
    // lock the storage value the UI's read-only badge depends on
    let out = admin.exec("SELECT storage FROM system.users WHERE name = 'app'").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["storage"], serde_json::json!("local_directory"), "SQL-created user storage is local_directory");

    // 2. LOGIN as the new user
    let user_params = mk("app", "pw");
    let mut user = retry("clickhouse", || ChDriver::connect(&user_params)).await;
    user.exec("SELECT 1 AS ok").await.expect("login ok");

    // 3. DENIED before grant
    assert!(user.exec("SELECT * FROM appdb.secret").await.is_err(), "denied before grant");

    // 4. GRANT via a role — createRole + grant + grantRole + set default role
    admin.exec("CREATE ROLE `reader`").await.unwrap();
    admin.exec("GRANT SELECT ON `appdb`.* TO `reader`").await.unwrap();
    admin.exec("GRANT `reader` TO `app`").await.unwrap();
    admin.exec("SET DEFAULT ROLE ALL TO `app`").await.unwrap();
    let mut user = retry("clickhouse", || ChDriver::connect(&user_params)).await;
    let out = user.exec("SELECT count() AS n FROM appdb.secret").await.expect("select after grant via role");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    // ClickHouse's HTTP driver returns UInt64 as a string.
    assert_eq!(result.rows[0]["n"], serde_json::json!("2"));

    // 5. WRITE still denied (role only granted SELECT)
    assert!(user.exec("INSERT INTO appdb.secret VALUES (3,'z')").await.is_err(), "read-only cannot INSERT");

    // 6. REVOKE + DROP
    admin.exec("REVOKE SELECT ON `appdb`.* FROM `reader`").await.unwrap();
    let mut user = retry("clickhouse", || ChDriver::connect(&user_params)).await;
    assert!(user.exec("SELECT * FROM appdb.secret").await.is_err(), "denied again after revoke");
    admin.exec("DROP USER `app`").await.unwrap();
    admin.exec("DROP ROLE `reader`").await.unwrap();
    let out = admin.exec("SELECT count() AS n FROM system.users WHERE name = 'app'").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!("0"), "user gone");
}

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

    // functions() (Query Editor autocomplete): system.functions liệt kê đầy đủ hàm
    // (regular + aggregate + combinators) — dùng cho tô màu + gợi ý.
    let fns = drv.functions().await.unwrap();
    for f in ["arrayJoin", "toDateTime", "uniqExact", "count"] {
        assert!(fns.iter().any(|x| x.name == f), "clickhouse function {f} listed ({} fns)", fns.len());
    }
    assert!(fns.len() > 100, "system.functions returns the full catalog: {}", fns.len());

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

/// ClickHouse parity (P1/P2/P3a): the Table Viewer's literal SELECT builder, the
/// Show Definition query (SHOW CREATE), and the Admin views all RUN on a real
/// server — proving these previously-broken/missing features now work for CH.
#[tokio::test]
async fn clickhouse_parity_grid_showcreate_admin() {
    use database_studio_lib::commands::admin::admin_query;
    use database_studio_lib::commands::schema::definition_query;
    use database_studio_lib::drivers::grid::{build_select_literal, FilterCond, SortSpec};
    use serde_json::json;

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

    drv.exec("CREATE TABLE pv (kind String, n UInt64) ENGINE = MergeTree ORDER BY n").await.unwrap();
    drv.exec("INSERT INTO pv VALUES ('click',1),('view',2),('click',3)").await.unwrap();

    // P1 — Table Viewer literal SELECT (filter + sort + paginate) runs on ClickHouse.
    let sql = build_select_literal(
        &Some("default".into()),
        "pv",
        &[FilterCond { col: "kind".into(), op: "=".into(), value: json!("click") }],
        false,
        &[SortSpec { col: "n".into(), desc: true }],
        10,
        0,
    );
    let StatementOutcome::Rows { result } = drv.exec(&sql).await.expect("literal select runs") else {
        panic!("expected rows")
    };
    assert_eq!(result.rows.len(), 2, "kind='click' → 2 rows, SQL={sql}");
    let first_n = result.rows[0]["n"].as_str().and_then(|s| s.parse::<i64>().ok()).or_else(|| result.rows[0]["n"].as_i64());
    assert_eq!(first_n, Some(3), "ORDER BY n DESC → first row n=3");

    // P2 — Show Definition (SHOW CREATE) returns the view's DDL.
    drv.exec("CREATE VIEW pv_v AS SELECT kind, n FROM pv").await.unwrap();
    let defq = definition_query("clickhouse", "view", "default", "pv_v").unwrap();
    let StatementOutcome::Rows { result } = drv.exec(&defq).await.expect("SHOW CREATE runs") else {
        panic!("expected rows")
    };
    let ddl = result.rows[0].as_object().and_then(|o| o.values().next()).and_then(|v| v.as_str()).unwrap_or("");
    assert!(ddl.to_uppercase().contains("CREATE"), "SHOW CREATE → DDL, got: {ddl}");

    // P3a — Admin views (sessions / mutations / users) run; users includes 'default'.
    for view in ["sessions", "mutations", "users"] {
        let q = admin_query("clickhouse", view).unwrap();
        drv.exec(&q).await.unwrap_or_else(|e| panic!("admin '{view}' failed: {}", e.message));
    }
    let uq = admin_query("clickhouse", "users").unwrap();
    let StatementOutcome::Rows { result } = drv.exec(&uq).await.unwrap() else { panic!("rows") };
    assert!(result.rows.iter().any(|r| r["name"].as_str() == Some("default")), "system.users has 'default'");

    eprintln!("CHK ClickHouse parity P1/P2/P3a OK");
}

/// ClickHouse P3b — streaming export runs on a real server: FORMAT
/// JSONCompactEachRowWithNames streamed to a writer, one row at a time.
#[tokio::test]
async fn clickhouse_stream_export_csv() {
    use database_studio_lib::drivers::postgres::ExportFormat;
    use std::sync::atomic::AtomicBool;

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
    drv.exec("CREATE TABLE ex (id UInt64, name String) ENGINE = MergeTree ORDER BY id").await.unwrap();
    drv.exec("INSERT INTO ex VALUES (1,'a'),(2,'b'),(3,'c')").await.unwrap();

    let mut buf: Vec<u8> = Vec::new();
    let cancel = AtomicBool::new(false);
    let n = drv
        .stream_export("SELECT id, name FROM ex ORDER BY id", ExportFormat::Csv, "ex", &mut buf, |_n| {}, &cancel)
        .await
        .expect("stream export");
    assert_eq!(n, 3, "3 rows streamed");
    let text = String::from_utf8(buf).unwrap();
    assert!(text.starts_with("id,name"), "CSV header first: {text}");
    assert!(text.contains("1,a") && text.contains("3,c"), "rows present: {text}");
    eprintln!("CHK ClickHouse streaming export OK");
}

/// ClickHouse — New Table (the exact DDL the Table Designer emits: MergeTree +
/// PARTITION BY + ORDER BY) executes, is introspectable, and its DDL is retrievable
/// via Show Definition / Copy DDL (SHOW CREATE). Verifies the designer + scripts path.
#[tokio::test]
async fn clickhouse_table_designer_create_and_ddl_end_to_end() {
    use database_studio_lib::commands::schema::definition_query;

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

    // DDL exactly as buildTableDdl emits for ClickHouse (MergeTree + PARTITION BY + ORDER BY).
    drv.exec("CREATE TABLE td (id UInt64, d Date, kind String)\nENGINE = MergeTree\nPARTITION BY toYYYYMM(d)\nORDER BY (id)")
        .await
        .expect("designer DDL runs");

    // introspection: engine badge, kind, PK on the ORDER BY key
    let tables = drv.tables("default").await.unwrap();
    let t = tables.iter().find(|x| x.name == "td").expect("table created");
    assert_eq!(t.engine.as_deref(), Some("MergeTree"));
    assert_eq!(t.kind, "table");
    let cols = drv.columns("default", "td").await.unwrap();
    assert!(cols.iter().find(|c| c.name == "id").unwrap().is_pk, "ORDER BY id → is_pk");

    // insert → a partition part exists → partitions() (tree node source) sees it
    drv.exec("INSERT INTO td VALUES (1, '2026-07-01', 'x')").await.unwrap();
    let parts = drv.partitions("default", "td").await.unwrap();
    assert!(!parts.is_empty(), "partitioned table → at least one partition, got {parts:?}");

    // Show Definition / Copy DDL backend (SHOW CREATE) returns runnable DDL
    let defq = definition_query("clickhouse", "table", "default", "td").unwrap();
    let StatementOutcome::Rows { result } = drv.exec(&defq).await.unwrap() else { panic!("rows") };
    let ddl = result.rows[0].as_object().and_then(|o| o.values().next()).and_then(|v| v.as_str()).unwrap_or("");
    assert!(ddl.contains("CREATE TABLE") && ddl.contains("MergeTree"), "SHOW CREATE DDL: {ddl}");
    eprintln!("CHK ClickHouse table designer + DDL OK");
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

    // functions() via pragma_function_list — the full built-in set (autocomplete).
    let fns = mem.functions().await.unwrap();
    for builtin in ["json_extract", "substr", "coalesce", "strftime", "length"] {
        assert!(fns.iter().any(|f| f.name == builtin), "sqlite built-in {builtin} listed ({} fns)", fns.len());
    }
    assert!(fns.len() > 20, "pragma_function_list returns the full catalog: {}", fns.len());
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
    let bad = open_tunnel(&ssh, "sai-mat-khau", "127.0.0.1", echo_port, false).await;
    assert!(bad.is_err(), "auth sai phải lỗi");

    // auth đúng → forward 2 chiều qua tunnel
    let tunnel = open_tunnel(&ssh, "test123", "127.0.0.1", echo_port, false).await.unwrap();
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
    assert!(drv.js_streams().await.unwrap().iter().any(|s| s.name == "T9S"), "created stream listed");
    drv.js_purge_stream("ORDERS").await.unwrap();
    drv.js_delete_stream("T9S").await.unwrap();
    // Item 2: a deleted stream must NOT reappear when the list is refreshed — the
    // delete persists on the NATS server (js.delete_stream), not just in the UI.
    let after_del: Vec<String> = drv.js_streams().await.unwrap().into_iter().map(|s| s.name).collect();
    assert!(!after_del.contains(&"T9S".to_string()), "deleted stream gone from list, got {after_del:?}");
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

/// Delete stream must remove it ON THE SERVER (not just the local view): after
/// deleting, a FRESH reconnected client must no longer see the stream. `js_delete_stream`
/// now verifies the server acknowledged the delete (DeleteStatus.success).
#[tokio::test]
async fn nats_delete_stream_persists_on_server_after_reconnect() {
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
    drv.js_create_stream("DELME".into(), vec!["delme.>".into()]).await.unwrap();
    assert!(drv.js_streams().await.unwrap().iter().any(|s| s.name == "DELME"), "created");
    drv.js_delete_stream("DELME").await.unwrap(); // returns Err if the server doesn't ack

    // reconnect a brand-new client → the server itself must no longer have it
    let drv2 = retry("nats-js", || NatsDriver::connect(&params)).await;
    let names: Vec<String> = drv2.js_streams().await.unwrap().into_iter().map(|s| s.name).collect();
    assert!(!names.contains(&"DELME".to_string()), "stream gone ON SERVER after reconnect: {names:?}");
    eprintln!("CHK nats_delete_stream_persists_on_server_after_reconnect OK");
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
    let consumer = drv
        .browse_consumer("phase4_itest", "earliest", 0, None, rdkafka::consumer::DefaultConsumerContext)
        .unwrap();
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

/// U7 — Cassandra User Manager, Definition-of-Done (spec §1.9 + §7.5). Runs a
/// container with PasswordAuthenticator + CassandraAuthorizer (via an entrypoint
/// that seds cassandra.yaml). Runs EXACTLY the CQL the frontend builders
/// (`src/lib/users/cassandra.ts`) produce.
#[tokio::test]
async fn cassandra_user_manager_end_to_end() {
    use database_studio_lib::drivers::cassandra::{CassandraConnParams, CassandraDriver};

    let c = GenericImage::new("cassandra", "5.0")
        .with_exposed_port(9042.tcp())
        .with_env_var("HEAP_NEWSIZE", "128M")
        .with_env_var("MAX_HEAP_SIZE", "512M")
        // Enable auth by rewriting cassandra.yaml before the normal entrypoint.
        .with_cmd(vec![
            "bash".to_string(),
            "-c".to_string(),
            "sed -i 's/AllowAllAuthenticator/PasswordAuthenticator/; s/AllowAllAuthorizer/CassandraAuthorizer/' \
             /etc/cassandra/cassandra.yaml && exec docker-entrypoint.sh cassandra -f"
                .to_string(),
        ])
        .start()
        .await
        .expect("start cassandra container with auth");
    let port = c.get_host_port_ipv4(9042).await.unwrap();

    let mk = |user: &str, password: &str| CassandraConnParams {
        contact_points: vec![format!("127.0.0.1:{port}")],
        user: user.into(),
        password: password.into(),
        datacenter: "datacenter1".into(),
        consistency: "ONE".into(),
        keyspace: String::new(),
        ssl: false,
        ssl_ca: String::new(),
    };

    // superuser cassandra/cassandra is created asynchronously after auth is up —
    // retry login + a real query. Deadline generous (auth bootstrap ~30-60s).
    let admin_params = mk("cassandra", "cassandra");
    let admin = {
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut last = String::new();
        loop {
            match CassandraDriver::connect_translating_to(&admin_params, "127.0.0.1", port).await {
                Ok(d) => match d.exec_cql("LIST ROLES", None, None).await {
                    Ok(_) => break d,
                    Err(e) => last = format!("query: {}", e.message),
                },
                Err(e) => last = format!("connect: {}", e.message),
            }
            assert!(Instant::now() < deadline, "cassandra(auth) not ready: {last}");
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    };

    // seed keyspace + table + row
    admin
        .exec_cql(
            "CREATE KEYSPACE app_ks WITH replication = {'class':'SimpleStrategy','replication_factor':1}",
            None,
            None,
        )
        .await
        .expect("create keyspace");
    admin.exec_cql("CREATE TABLE app_ks.secret (id int PRIMARY KEY, v text)", None, None).await.expect("create table");
    admin.exec_cql("INSERT INTO app_ks.secret (id, v) VALUES (1, 'x')", None, None).await.expect("seed row");

    // 1. CREATE — createRole({name:'app_role', password:'pw', login:true})
    admin
        .exec_cql("CREATE ROLE app_role WITH PASSWORD = 'pw' AND LOGIN = true AND SUPERUSER = false", None, None)
        .await
        .expect("create role");

    // 2. LOGIN as the new role
    let user_params = mk("app_role", "pw");
    let connect_user = || async {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Ok(d) = CassandraDriver::connect_translating_to(&user_params, "127.0.0.1", port).await {
                if d.exec_cql("SELECT release_version FROM system.local", None, None).await.is_ok() {
                    return d;
                }
            }
            assert!(Instant::now() < deadline, "app_role cannot log in");
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    };
    let user = connect_user().await;

    // 3. DENIED before grant
    assert!(user.exec_cql("SELECT * FROM app_ks.secret", None, None).await.is_err(), "denied before grant");

    // 4. GRANT — keyspacePreset('read-only','app_ks','app_role'). Cassandra caches
    // permissions per-role (~2s) → wait past the cache + reconnect a fresh session.
    admin.exec_cql("GRANT SELECT ON KEYSPACE app_ks TO app_role", None, None).await.expect("grant select");
    tokio::time::sleep(Duration::from_secs(3)).await;
    let user = connect_user().await;
    let out = user.exec_cql("SELECT count(*) AS n FROM app_ks.secret", None, None).await.expect("select after grant");
    let StatementOutcome::Rows { result } = out.outcome else { panic!("expected rows") };
    // count(*) is a bigint — accept number or string form.
    let n = result.rows[0]["n"].as_i64().or_else(|| result.rows[0]["n"].as_str().and_then(|s| s.parse().ok()));
    assert_eq!(n, Some(1), "read granted (count via role): {:?}", result.rows[0]["n"]);

    // 5. WRITE (MODIFY) denied
    assert!(
        user.exec_cql("INSERT INTO app_ks.secret (id, v) VALUES (2, 'z')", None, None).await.is_err(),
        "SELECT-only role cannot MODIFY",
    );

    // 6. REVOKE → denied; DROP → gone (wait past the permission cache + reconnect)
    admin.exec_cql("REVOKE ALL PERMISSIONS ON KEYSPACE app_ks FROM app_role", None, None).await.expect("revoke");
    tokio::time::sleep(Duration::from_secs(3)).await;
    let user = connect_user().await;
    assert!(user.exec_cql("SELECT * FROM app_ks.secret", None, None).await.is_err(), "denied again after revoke");
    admin.exec_cql("DROP ROLE IF EXISTS app_role", None, None).await.expect("drop role");
    let roles = admin.exec_cql("LIST ROLES", None, None).await.expect("list roles");
    let StatementOutcome::Rows { result } = roles.outcome else { panic!("expected rows") };
    assert!(!result.rows.iter().any(|r| r["role"] == serde_json::json!("app_role")), "role gone");
    eprintln!("U7 OK — Cassandra role create/login/deny/grant/deny-write/revoke/drop verified");
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

// ---------------------------------------------------------------------------
// Cancel of a LARGE result set — the case T11 above does not cover.
//
// `pg_sleep(30)` is cancelled while the task sits on an `.await`, which the old
// abort-only implementation handled. A big SELECT is different: the rows arrive,
// and the driver then spends seconds in ONE synchronous loop turning them into
// JSON. `AbortHandle::abort()` cannot interrupt that (a tokio abort only lands at
// an await point), so Cancel was silently ignored until the whole result had been
// built — the reported "cannot stop it". Cancel must now:
//   * return CANCELLED to the caller immediately,
//   * stop the query ON THE SERVER (pg_cancel_backend over a second connection),
//   * leave the connection usable.
//
// Multi-threaded on purpose: that is the runtime Tauri gives the commands, and a
// synchronous decode loop occupies a worker for its whole duration. On the
// single-threaded runtime `#[tokio::test]` defaults to, that loop would starve
// the test itself (and Cancel with it) — which is precisely the behaviour this
// test must not depend on.
// ---------------------------------------------------------------------------
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn query_cancel_stops_a_large_result_and_the_server() {
    use std::sync::Arc;
    use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
    use database_studio_lib::connections::registry::Registry;
    use database_studio_lib::drivers::types::SystemType;

    let (_c, port) = start_pg().await;
    let profile = |id: &str| ConnectionProfile {
        id: id.into(),
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
            match reg.connect(profile("big"), PASS.into(), String::new()).await {
                Ok(_) => break,
                Err(e) => {
                    assert!(Instant::now() < deadline, "connect PG failed: {e:?}");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    }
    // Observer connection — proves what the SERVER is doing, independently.
    reg.connect(profile("watch"), PASS.into(), String::new()).await.unwrap();

    // ---- (a) a big result set: the caller must be released, not made to wait ---
    // The server produces these rows quickly; the seconds go into the driver's
    // synchronous row→JSON loop, which is exactly the stretch a tokio abort
    // cannot interrupt. Baseline first, so "it stopped early" is measured against
    // this machine instead of a hard-coded number.
    const BIG: &str = "SELECT i AS id, md5(i::text) AS h FROM generate_series(1, 1500000) AS i";
    let base_start = Instant::now();
    let full = reg.exec_statement("big", BIG.into()).await.unwrap().unwrap();
    let baseline = base_start.elapsed();
    match full {
        StatementOutcome::Rows { result } => assert_eq!(result.total, 1_500_000, "baseline must return every row"),
        other => panic!("expected Rows, got {other:?}"),
    }
    assert!(baseline > Duration::from_secs(3), "baseline too fast to be a meaningful test: {baseline:?}");
    eprintln!("CHK uncancelled baseline = {baseline:?}");

    let r2 = reg.clone();
    let run_start = Instant::now();
    let handle = tokio::spawn(async move { r2.exec_statement("big", BIG.into()).await });
    tokio::time::sleep(Duration::from_millis(1200)).await;

    // While that big result is being decoded, ANOTHER connection (i.e. another
    // tab, or the Explorer) must stay responsive. Without the periodic yield in
    // the driver's row loop this measured multiple seconds — the decode held its
    // worker and delayed every other command, `cancel_query` included, which is
    // what made one tab's query freeze the rest of the app.
    let probe = Instant::now();
    reg.exec_statement("watch", "SELECT 1 AS n".into()).await.unwrap().unwrap();
    let probe = probe.elapsed();
    assert!(probe < Duration::from_secs(2), "another connection must stay responsive, took {probe:?}");
    eprintln!("CHK second connection answered in {probe:?} while the big result was decoding");

    let cstart = Instant::now();
    assert!(reg.cancel("big"), "cancel must find the in-flight statement");
    let joined = tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("exec_statement must return right after cancel (not after the full decode)")
        .unwrap();
    let (ack, total) = (cstart.elapsed(), run_start.elapsed());
    assert!(ack < Duration::from_secs(2), "cancel must release the caller fast, took {ack:?}");
    assert!(
        total < baseline / 2,
        "the run must stop early, not finish: total {total:?} vs baseline {baseline:?}"
    );
    match joined {
        Ok(Err(qe)) => assert_eq!(qe.code.as_deref(), Some("CANCELLED"), "expected CANCELLED, got {qe:?}"),
        other => panic!("expected Ok(Err(CANCELLED)), got {other:?}"),
    }
    eprintln!("CHK large result cancelled: caller released in {ack:?}, run stopped after {total:?}");

    // ---- (b) a long SERVER-side query: the server must stop too ---------------
    // Tiny result, huge amount of work inside PG — so this measures the server,
    // not the decode loop. Abandoning the client task would leave PG grinding;
    // `pg_cancel_backend` over a second connection is what actually stops it.
    const SLOW: &str = "SELECT count(*) AS n FROM generate_series(1, 4000000000) AS g";
    const WATCH: &str = "SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'active' \
                         AND query LIKE '%generate_series(1, 4000000000)%' \
                         AND query NOT LIKE '%pg_stat_activity%'";
    let active_count = |reg: Arc<Registry>| async move {
        match reg.exec_statement("watch", WATCH.into()).await.unwrap().unwrap() {
            StatementOutcome::Rows { result } => result.rows[0]["n"].as_i64().unwrap_or(-1),
            other => panic!("expected Rows, got {other:?}"),
        }
    };

    let r3 = reg.clone();
    let slow = tokio::spawn(async move { r3.exec_statement("big", SLOW.into()).await });
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(active_count(reg.clone()).await, 1, "the slow query must be running server-side");
    eprintln!("CHK slow query is active on the server");

    assert!(reg.cancel("big"), "cancel must find the slow statement");
    let joined = tokio::time::timeout(Duration::from_secs(5), slow)
        .await
        .expect("exec_statement must return right after cancel")
        .unwrap();
    match joined {
        Ok(Err(qe)) => assert_eq!(qe.code.as_deref(), Some("CANCELLED"), "expected CANCELLED, got {qe:?}"),
        other => panic!("expected Ok(Err(CANCELLED)), got {other:?}"),
    }

    // The server-side cancel is dispatched asynchronously (it needs its own
    // connection), so poll rather than assume.
    let mut still_active = -1;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(500)).await;
        still_active = active_count(reg.clone()).await;
        if still_active == 0 {
            break;
        }
    }
    assert_eq!(still_active, 0, "the server must stop executing the cancelled query");
    eprintln!("CHK server stopped executing the cancelled query");

    // The connection heals and is usable again.
    let follow = reg
        .exec_statement("big", "SELECT 1 AS n".into())
        .await
        .expect("registry err")
        .expect("follow-up query must work after cancel");
    match follow {
        StatementOutcome::Rows { result } => assert_eq!(result.rows[0]["n"], serde_json::json!(1)),
        other => panic!("expected Rows, got {other:?}"),
    }
    eprintln!("CHK connection reusable — test end");
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

/// Cassandra feature-completion (Phase C): object DDL viewer for non-table objects
/// (C2), editable-grid apply by full primary key (C3), and per-statement
/// consistency override (C4) — all against a real cluster.
#[tokio::test]
async fn cassandra_object_ddl_grid_edit_and_consistency() {
    use database_studio_lib::drivers::cassandra::{CassandraConnParams, CassandraDriver};
    use database_studio_lib::drivers::grid::{Col, GridChange};

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

    // setup: keyspace + UDT + table + secondary index
    drv.exec_cql(
        "CREATE KEYSPACE IF NOT EXISTS cfeat_ks WITH replication = {'class':'SimpleStrategy','replication_factor':1}",
        None, None,
    ).await.expect("create keyspace");
    drv.exec_cql("CREATE TYPE cfeat_ks.address (street text, city text)", None, None)
        .await
        .expect("create type");
    drv.exec_cql(
        "CREATE TABLE cfeat_ks.students (id uuid PRIMARY KEY, name text, grade int)",
        None, None,
    ).await.expect("create table");
    drv.exec_cql("CREATE INDEX idx_name ON cfeat_ks.students (name)", None, None)
        .await
        .expect("create index");

    // --- C2: object_ddl for non-table objects (reconstructed, re-runnable) ---
    let type_ddl = drv.object_ddl("cfeat_ks", "type", "address").await.expect("type ddl");
    assert!(type_ddl.contains("CREATE TYPE cfeat_ks.address"), "{type_ddl}");
    assert!(type_ddl.contains("street text") && type_ddl.contains("city text"), "{type_ddl}");
    let idx_ddl = drv.object_ddl("cfeat_ks", "index", "idx_name").await.expect("index ddl");
    assert!(idx_ddl.contains("CREATE INDEX idx_name ON cfeat_ks.students"), "{idx_ddl}");
    // Re-create the type into a fresh keyspace from its own DDL → proves round-trip.
    drv.exec_cql(
        "CREATE KEYSPACE IF NOT EXISTS cfeat_ks2 WITH replication = {'class':'SimpleStrategy','replication_factor':1}",
        None, None,
    ).await.expect("create ks2");
    let type_ddl2 = type_ddl.replace("cfeat_ks.address", "cfeat_ks2.address");
    drv.exec_cql(&type_ddl2, None, None).await.expect("recreate type from its DDL");
    eprintln!("CHK C2 object_ddl (type/index) + round-trip OK");

    // --- C3: editable-grid apply by full primary key (INSERT → UPDATE → DELETE) ---
    let id = "11111111-1111-1111-1111-111111111111";
    let uuid_col = |v: &str| Col { name: "id".into(), value: serde_json::json!(v), col_type: Some("Uuid".into()) };
    let n = drv
        .apply_grid(&[GridChange::Insert {
            schema: Some("cfeat_ks".into()),
            table: "students".into(),
            values: vec![
                uuid_col(id),
                Col { name: "name".into(), value: serde_json::json!("Ada"), col_type: Some("Text".into()) },
                Col { name: "grade".into(), value: serde_json::json!(10), col_type: Some("Int".into()) },
            ],
        }])
        .await
        .expect("grid insert");
    assert_eq!(n, 1);
    // UPDATE name by PK
    drv.apply_grid(&[GridChange::Update {
        schema: Some("cfeat_ks".into()),
        table: "students".into(),
        pk: vec![uuid_col(id)],
        set: vec![Col { name: "name".into(), value: serde_json::json!("Ada Lovelace"), col_type: Some("Text".into()) }],
    }])
    .await
    .expect("grid update");
    // verify the update landed
    let sel = drv
        .exec_cql(&format!("SELECT name FROM cfeat_ks.students WHERE id = {id}"), None, None)
        .await
        .expect("select after update");
    match sel.outcome {
        StatementOutcome::Rows { result } => {
            assert_eq!(result.rows.len(), 1);
            assert!(format!("{:?}", result.rows[0]).contains("Ada Lovelace"), "row: {:?}", result.rows[0]);
        }
        _ => panic!("expected rows"),
    }
    // DELETE by PK → row gone
    drv.apply_grid(&[GridChange::Delete {
        schema: Some("cfeat_ks".into()),
        table: "students".into(),
        pk: vec![uuid_col(id)],
    }])
    .await
    .expect("grid delete");
    let after = drv
        .exec_cql(&format!("SELECT name FROM cfeat_ks.students WHERE id = {id}"), None, None)
        .await
        .expect("select after delete");
    match after.outcome {
        StatementOutcome::Rows { result } => assert_eq!(result.rows.len(), 0, "row must be deleted"),
        _ => panic!("expected rows"),
    }
    eprintln!("CHK C3 editable-grid INSERT/UPDATE/DELETE by PK OK");

    // --- C4: per-statement consistency override runs on a single node ---
    for cl in ["ONE", "QUORUM", "LOCAL_QUORUM"] {
        drv.exec_cql_c("SELECT * FROM cfeat_ks.students", None, None, Some(cl))
            .await
            .unwrap_or_else(|e| panic!("consistency {cl} should run: {}", e.message));
    }
    eprintln!("CHK C4 per-statement consistency (ONE/QUORUM/LOCAL_QUORUM) OK");
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

/// Backup & Restore (native MSSQL) — `BACKUP DATABASE … TO DISK` / `RESTORE …
/// FROM DISK` chạy qua CHÍNH connection app (`mssql_backup_sql`/`mssql_restore_sql`,
/// route qua is_raw_batch). Connect tới master để BACKUP/RESTORE `bkptest` tự do
/// (DB không bận). .bak nằm trong container (server-side path).
#[tokio::test]
async fn mssql_native_backup_restore_roundtrip() {
    use database_studio_lib::drivers::backup::{mssql_backup_sql, mssql_restore_sql};

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
        database: String::new(), // master — không bận bkptest khi RESTORE
        user: "sa".into(),
        password: MSSQL_PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        auth: "sql".into(),
    };
    let mut drv = retry("mssql", || MssqlDriver::connect(&params)).await;

    // seed 1 user database thật với 2 dòng
    drv.exec("CREATE DATABASE bkptest").await.unwrap();
    drv.exec("CREATE TABLE bkptest.dbo.t (id int PRIMARY KEY)").await.unwrap();
    drv.exec("INSERT INTO bkptest.dbo.t VALUES (1), (2)").await.unwrap();

    // BACKUP → .bak server-side
    let bak = "/var/opt/mssql/data/bkptest.bak";
    drv.exec(&mssql_backup_sql("bkptest", bak)).await.unwrap();

    // đổi dữ liệu (thêm dòng 3) → RESTORE WITH REPLACE → về đúng 2 dòng
    drv.exec("INSERT INTO bkptest.dbo.t VALUES (3)").await.unwrap();
    drv.exec(&mssql_restore_sql("bkptest", bak)).await.unwrap();

    let out = drv.exec("SELECT count(*) AS n FROM bkptest.dbo.t").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(2), "restore khôi phục đúng 2 dòng (bỏ dòng 3)");
    eprintln!("CHK MSSQL native BACKUP/RESTORE round-trip OK");
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

/// Item 2 — the MySQL "Sessions" admin query must RUN (previously failed with a
/// syntax error because the reserved word `database` was used as an unquoted alias).
#[tokio::test]
async fn mysql_admin_sessions_query_runs() {
    use database_studio_lib::commands::admin::admin_query;
    let c = GenericImage::new("mysql", "8")
        .with_exposed_port(3306.tcp())
        .with_env_var("MYSQL_ROOT_PASSWORD", PASS)
        .with_env_var("MYSQL_DATABASE", "testdb")
        .start()
        .await
        .expect("start mysql container");
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    let params = MySqlConnParams {
        host: "localhost".into(), port, database: "testdb".into(), user: "root".into(),
        password: PASS.into(), ssl: false, ssl_ca: String::new(), ssl_cert: String::new(), ssl_key: String::new(),
    };
    let mut drv = retry("mysql", || MySqlDriver::connect(&params, "mysql")).await;

    let out = drv.exec(&admin_query("mysql", "sessions").unwrap()).await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("sessions rows") };
    assert!(result.total >= 1, "at least the current session is listed");
    assert!(result.cols.iter().any(|c| c.0 == "database"), "the `database` alias resolves: {:?}", result.cols);
    assert!(result.cols.iter().any(|c| c.0 == "pid") && result.cols.iter().any(|c| c.0 == "state"));
    eprintln!("CHK mysql_admin_sessions_query_runs OK");
}

/// Item 3 — the MSSQL "Sessions" admin query must RUN (previously failed with
/// "Incorrect syntax near the keyword 'database'" — the alias is now bracket-quoted).
#[tokio::test]
async fn mssql_admin_sessions_query_runs() {
    use database_studio_lib::commands::admin::admin_query;
    let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
        .with_exposed_port(1433.tcp())
        .with_env_var("ACCEPT_EULA", "Y")
        .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
        .start()
        .await
        .expect("start mssql container");
    let port = c.get_host_port_ipv4(1433).await.unwrap();
    let params = MssqlConnParams {
        host: "localhost".into(), port, database: String::new(), user: "sa".into(),
        password: MSSQL_PASS.into(), ssl: false, ssl_ca: String::new(), auth: "sql".into(),
    };
    let mut drv = retry("mssql", || MssqlDriver::connect(&params)).await;

    let out = drv.exec(&admin_query("mssql", "sessions").unwrap()).await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("sessions rows") };
    assert!(result.total >= 1, "at least the current session is listed");
    assert!(result.cols.iter().any(|c| c.0 == "database"), "the [database] alias resolves: {:?}", result.cols);
    assert!(result.cols.iter().any(|c| c.0 == "pid") && result.cols.iter().any(|c| c.0 == "state"));
    eprintln!("CHK mssql_admin_sessions_query_runs OK");
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
        // publish with a Nats-Msg-Id header so the browsed message exposes a key
        let mut h = async_nats::HeaderMap::new();
        h.insert("Nats-Msg-Id", format!("eu-key-{i}").as_str());
        js.publish_with_headers("orders.eu", h, bytes::Bytes::from(format!("eu{i}"))).await.unwrap().await.unwrap();
    }
    for i in 0..2 {
        js.publish("orders.us", bytes::Bytes::from(format!("us{i}"))).await.unwrap().await.unwrap();
    }

    // retry helper: browse a subject until it reports the expected count (or times out)
    async fn count_until(drv: &NatsDriver, subject: &str, want: usize) -> usize {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let n = drv.js_subject_messages("ORDERS", subject, 100, None).await.unwrap().len();
            if n == want || Instant::now() >= deadline {
                return n;
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }

    // browse: only orders.eu messages, correct subject
    let eu = drv.js_subject_messages("ORDERS", "orders.eu", 100, None).await.unwrap();
    assert_eq!(count_until(&drv, "orders.eu", 3).await, 3, "3 messages on orders.eu");
    assert!(eu.iter().all(|m| m.subject == "orders.eu"), "all messages belong to orders.eu");
    // the Nats-Msg-Id header is surfaced as the per-message key
    assert!(eu.iter().all(|m| m.key.starts_with("eu-key-")), "each message exposes its Nats-Msg-Id key");

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

#[tokio::test]
async fn redis_select_db_switches_and_isolates_keys() {
    use database_studio_lib::drivers::redis::{RedisConnParams, RedisDriver};
    let (_c, port) = start_redis("test123").await;
    let params = RedisConnParams { host: "localhost".into(), port, password: "test123".into(), db: 0, ssl: false, ssl_ca: String::new() };
    let mut drv = retry("redis", || RedisDriver::connect(&params)).await;

    // default db0: set a key, verify present
    drv.command(&["SET".into(), "k".into(), "v0".into()]).await.unwrap();
    let g0 = drv.command(&["GET".into(), "k".into()]).await.unwrap();
    assert!(g0.contains("v0"), "db0 key present, got {g0}");

    // database_count for the dropdown (default 16 on stock redis)
    assert!(drv.database_count().await.unwrap() >= 1, "database_count sane");

    // switch to db1 → key from db0 is NOT visible (logical DB isolation)
    drv.select_db(1).await.unwrap();
    let g1 = drv.command(&["GET".into(), "k".into()]).await.unwrap();
    assert!(!g1.contains("v0"), "db1 must not see db0 key, got {g1}");
    drv.command(&["SET".into(), "k".into(), "v1".into()]).await.unwrap();

    // switch back to db0 → original value intact
    drv.select_db(0).await.unwrap();
    let g0b = drv.command(&["GET".into(), "k".into()]).await.unwrap();
    assert!(g0b.contains("v0"), "db0 value preserved, got {g0b}");
    eprintln!("CHK redis_select_db_switches_and_isolates_keys OK");
}

/// Explorer Redis context menu — "Delete" must remove the key on the server for real
/// (DEL), and a subsequent SCAN must no longer list it while siblings survive.
/// "Refresh" is the same SCAN path the explorer's load() uses.
#[tokio::test]
async fn redis_del_removes_key_and_scan_reflects_it() {
    use database_studio_lib::drivers::redis::{RedisConnParams, RedisDriver};
    let (_c, port) = start_redis("test123").await;
    let params = RedisConnParams { host: "localhost".into(), port, password: "test123".into(), db: 0, ssl: false, ssl_ca: String::new() };
    let mut drv = retry("redis", || RedisDriver::connect(&params)).await;

    // seed a small keyspace (a folder prefix + a sibling)
    for (k, v) in [("user:1", "a"), ("user:2", "b"), ("session:x", "c")] {
        drv.command(&["SET".into(), k.into(), v.into()]).await.unwrap();
    }
    async fn scan_names(drv: &mut RedisDriver) -> Vec<String> {
        let mut names = Vec::new();
        let mut cursor = 0u64;
        loop {
            let (next, keys) = drv.scan("*", cursor, 100).await.unwrap();
            names.extend(keys.into_iter().map(|k| k.name));
            cursor = next;
            if cursor == 0 {
                break;
            }
        }
        names
    }
    let before = scan_names(&mut drv).await;
    assert!(before.contains(&"user:1".to_string()) && before.contains(&"user:2".to_string()) && before.contains(&"session:x".to_string()), "seed present: {before:?}");

    // Delete (single key) → DEL returns 1, key gone from SCAN, siblings intact
    assert_eq!(drv.del("user:1").await.unwrap(), 1, "DEL removed exactly one key");
    let after = scan_names(&mut drv).await;
    assert!(!after.contains(&"user:1".to_string()), "deleted key gone from SCAN: {after:?}");
    assert!(after.contains(&"user:2".to_string()) && after.contains(&"session:x".to_string()), "siblings survive: {after:?}");

    // DEL of a missing key is a no-op (0), not an error
    assert_eq!(drv.del("user:1").await.unwrap(), 0, "second DEL removes nothing");
    eprintln!("CHK redis_del_removes_key_and_scan_reflects_it OK");
}

/// Key-explorer load path: `scan_page` fetches TYPE + TTL for the whole batch (plus
/// DBSIZE) in ONE pipelined round-trip instead of 2·N sequential commands. Pipelines
/// answer in send order, so the risk of the optimisation is a shifted mapping — this
/// seeds every Redis type interleaved, each string with its OWN distinct TTL, and
/// verifies each key still reports its own type and TTL across several SCAN pages.
#[tokio::test]
async fn redis_scan_page_pipelines_type_ttl_and_dbsize_without_mismatching_keys() {
    use database_studio_lib::drivers::redis::{RedisConnParams, RedisDriver};
    let (_c, port) = start_redis("test123").await;
    let params = RedisConnParams { host: "localhost".into(), port, password: "test123".into(), db: 0, ssl: false, ssl_ca: String::new() };
    let mut drv = retry("redis", || RedisDriver::connect(&params)).await;

    // Seed: 30 of each type. Strings carry a unique TTL (100 + i) so any off-by-one
    // in the pairing shows up as a wrong TTL, not just a wrong type.
    const N: i64 = 30;
    let mut expected: std::collections::HashMap<String, (&'static str, i64)> = std::collections::HashMap::new();
    for i in 0..N {
        let s = format!("str:{i:03}");
        drv.command(&["SET".into(), s.clone(), format!("v{i}")]).await.unwrap();
        drv.command(&["EXPIRE".into(), s.clone(), (100 + i).to_string()]).await.unwrap();
        expected.insert(s, ("string", 100 + i));

        let h = format!("hash:{i:03}");
        drv.command(&["HSET".into(), h.clone(), "f".into(), "v".into()]).await.unwrap();
        expected.insert(h, ("hash", -1));

        let l = format!("list:{i:03}");
        drv.command(&["RPUSH".into(), l.clone(), "a".into()]).await.unwrap();
        expected.insert(l, ("list", -1));

        let st = format!("set:{i:03}");
        drv.command(&["SADD".into(), st.clone(), "m".into()]).await.unwrap();
        expected.insert(st, ("set", -1));

        let z = format!("z:{i:03}");
        drv.command(&["ZADD".into(), z.clone(), "1".into(), "m".into()]).await.unwrap();
        expected.insert(z, ("zset", -1));
    }
    let total = expected.len() as u64;

    // Page through the keyspace with a small COUNT so several pipelines are exercised.
    let mut seen = std::collections::HashMap::new();
    let mut cursor = 0u64;
    let mut pages = 0;
    loop {
        let (next, keys, dbsize) = drv.scan_page("*", cursor, 10).await.unwrap();
        assert_eq!(dbsize, total, "DBSIZE rides along in the same pipeline");
        for k in keys {
            seen.insert(k.name, (k.key_type, k.ttl));
        }
        pages += 1;
        cursor = next;
        if cursor == 0 {
            break;
        }
        assert!(pages < 100, "SCAN must terminate");
    }
    assert!(pages > 1, "small COUNT must span multiple pages, got {pages}");
    assert_eq!(seen.len() as u64, total, "every seeded key surfaced");

    for (name, (want_type, want_ttl)) in &expected {
        let (got_type, got_ttl) = seen.get(name).unwrap_or_else(|| panic!("missing {name}"));
        assert_eq!(got_type, want_type, "{name} kept its own TYPE");
        if *want_ttl < 0 {
            assert_eq!(*got_ttl, -1, "{name} has no expiry");
        } else {
            // TTL counts down; must be its own value (±2s), never a neighbour's.
            assert!(
                (*got_ttl - *want_ttl).abs() <= 2,
                "{name} kept its own TTL: want ~{want_ttl}, got {got_ttl}"
            );
        }
    }

    // A pattern that matches nothing: MATCH filters AFTER the scan, so the cursor keeps
    // walking the keyspace and pages come back empty — DBSIZE must still be reported
    // (that page's pipeline holds only the DBSIZE command).
    let mut cursor = 0u64;
    let mut matched = 0usize;
    loop {
        let (next, keys, dbsize) = drv.scan_page("nothing-matches:*", cursor, 10).await.unwrap();
        matched += keys.len();
        assert_eq!(dbsize, total, "DBSIZE unaffected by MATCH, even on an empty page");
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    assert_eq!(matched, 0, "no key matches the pattern");

    eprintln!("CHK redis_scan_page_pipelines_type_ttl_and_dbsize_without_mismatching_keys OK ({pages} pages, {total} keys)");
}

/// Bench (ignored): what the key-explorer load actually costs on a 5k keyspace, new
/// pipelined path vs the old "TYPE + TTL per key, sequentially" path replayed here.
/// Round-trips are what matters — on localhost each is ~0.05 ms, on a remote/tunnelled
/// server 10–30 ms, so multiply the round-trip counts printed below by your RTT.
/// Run: cargo test --test drivers_integration bench_redis_ -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn bench_redis_scan_load_pipelined_vs_sequential() {
    use database_studio_lib::drivers::redis::{RedisConnParams, RedisDriver};
    use std::time::Instant;

    let (_c, port) = start_redis("test123").await;
    let params = RedisConnParams { host: "localhost".into(), port, password: "test123".into(), db: 0, ssl: false, ssl_ca: String::new() };
    let mut drv = retry("redis", || RedisDriver::connect(&params)).await;

    // seed 5000 keys (pipelined so seeding is not the bottleneck)
    const N: usize = 5000;
    let client = redis::Client::open(format!("redis://:test123@localhost:{port}/0")).unwrap();
    let mut raw = client.get_multiplexed_async_connection().await.unwrap();
    for chunk in (0..N).collect::<Vec<_>>().chunks(500) {
        let mut pipe = redis::pipe();
        for i in chunk {
            pipe.cmd("SET").arg(format!("bench:{i:05}")).arg("v").ignore();
        }
        let _: () = pipe.query_async(&mut raw).await.unwrap();
    }

    // NEW: SCAN + one pipeline (TYPE/TTL batch + DBSIZE) per page — 2 round-trips/page.
    let t0 = Instant::now();
    let (mut cursor, mut got, mut pages) = (0u64, 0usize, 0u32);
    loop {
        let (next, keys, _dbsize) = drv.scan_page("*", cursor, 500).await.unwrap();
        got += keys.len();
        pages += 1;
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    let new_ms = t0.elapsed().as_millis();
    let new_rt = pages * 2;

    // OLD: SCAN, then TYPE and TTL awaited per key, plus a separate DBSIZE per page.
    let t1 = Instant::now();
    let (mut cursor, mut old_keys, mut old_pages) = (0u64, 0usize, 0u32);
    loop {
        let (next, names): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("MATCH").arg("*").arg("COUNT").arg(500)
            .query_async(&mut raw).await.unwrap();
        for name in &names {
            let _t: String = redis::cmd("TYPE").arg(name).query_async(&mut raw).await.unwrap();
            let _l: i64 = redis::cmd("TTL").arg(name).query_async(&mut raw).await.unwrap();
        }
        let _d: u64 = redis::cmd("DBSIZE").query_async(&mut raw).await.unwrap();
        old_keys += names.len();
        old_pages += 1;
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    let old_ms = t1.elapsed().as_millis();
    let old_rt = old_pages * 2 + old_keys as u32 * 2;

    assert_eq!(got, N, "new path returned every key");
    assert_eq!(old_keys, N, "replayed old path saw the same keyspace");
    eprintln!(
        "BENCH redis load {N} keys: pipelined {new_ms} ms / {new_rt} round-trips ({pages} pages) \
         vs sequential {old_ms} ms / {old_rt} round-trips — {:.0}x fewer round-trips",
        old_rt as f64 / new_rt.max(1) as f64
    );
}

// Task 4 — Design Table edit/delete across tabs: the DROP + ALTER COLUMN DDL that
// buildTableDdl emits for an existing table runs on real PostgreSQL.
#[tokio::test]
async fn pg_table_designer_edit_and_drop_objects_end_to_end() {
    let (_c, port) = start_pg().await;
    let params = PgConnParams {
        host: "localhost".into(), port, database: "testdb".into(), user: "postgres".into(),
        password: PASS.into(), ssl: false, ssl_ca: String::new(), ssl_cert: String::new(), ssl_key: String::new(),
    };
    let mut drv = retry("postgres", || PgDriver::connect(&params)).await;
    async fn n(drv: &mut PgDriver, sql: &str) -> i64 {
        let StatementOutcome::Rows { result } = drv.exec(sql).await.unwrap() else { panic!("rows") };
        let v = &result.rows[0]["n"];
        v.as_i64().unwrap_or_else(|| v.as_f64().unwrap() as i64)
    }

    drv.exec("CREATE TABLE parent (id int PRIMARY KEY)").await.unwrap();
    drv.exec("CREATE TABLE td (id int PRIMARY KEY, price int NOT NULL, old_col text, email text, org_id int)").await.unwrap();
    drv.exec("CREATE INDEX ix_old ON td (old_col)").await.unwrap();
    drv.exec("ALTER TABLE td ADD CONSTRAINT uq_email UNIQUE (email)").await.unwrap();
    drv.exec("ALTER TABLE td ADD CONSTRAINT ck_price CHECK (price >= 0)").await.unwrap();
    drv.exec("ALTER TABLE td ADD CONSTRAINT fk_org FOREIGN KEY (org_id) REFERENCES parent (id)").await.unwrap();

    // pre-conditions
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.columns WHERE table_name='td' AND column_name='old_col'").await, 1, "old_col present");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM pg_indexes WHERE indexname='ix_old'").await, 1, "ix_old present");

    // --- DROP statements exactly as buildTableDdl(existing) emits ---
    drv.exec("DROP TRIGGER IF EXISTS \"whatever\" ON \"public\".\"td\";").await.ok(); // no-op tolerant
    drv.exec("ALTER TABLE \"public\".\"td\" DROP CONSTRAINT \"fk_org\";").await.unwrap();
    drv.exec("ALTER TABLE \"public\".\"td\" DROP CONSTRAINT \"ck_price\";").await.unwrap();
    drv.exec("ALTER TABLE \"public\".\"td\" DROP CONSTRAINT \"uq_email\";").await.unwrap();
    drv.exec("DROP INDEX IF EXISTS \"public\".\"ix_old\";").await.unwrap();
    drv.exec("ALTER TABLE \"public\".\"td\" DROP COLUMN \"old_col\";").await.unwrap();
    // --- ALTER COLUMN (edit existing) exactly as alterColumn() emits for PG ---
    drv.exec("ALTER TABLE \"public\".\"td\" ALTER COLUMN \"price\" TYPE numeric(10,2);").await.unwrap();
    drv.exec("ALTER TABLE \"public\".\"td\" ALTER COLUMN \"price\" DROP NOT NULL;").await.unwrap();

    // verify drops + edit landed
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.columns WHERE table_name='td' AND column_name='old_col'").await, 0, "old_col dropped");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM pg_indexes WHERE indexname='ix_old'").await, 0, "ix_old dropped");
    assert_eq!(n(&mut drv, "SELECT count(*) AS n FROM information_schema.table_constraints WHERE constraint_name IN ('uq_email','ck_price','fk_org')").await, 0, "constraints dropped");
    let StatementOutcome::Rows { result } = drv.exec("SELECT data_type AS n, is_nullable FROM information_schema.columns WHERE table_name='td' AND column_name='price'").await.unwrap() else { panic!("rows") };
    assert_eq!(result.rows[0]["n"].as_str().unwrap(), "numeric", "price altered to numeric");
    assert_eq!(result.rows[0]["is_nullable"].as_str().unwrap(), "YES", "price now nullable");
    eprintln!("CHK pg_table_designer_edit_and_drop_objects_end_to_end OK");
}

// ---------------------------------------------------------------------------
// Reserved-word identifier quoting (Query Editor autocomplete `quoteIfReserved`).
// The quoted identifier the editor inserts on Tab/Enter must be valid SQL the
// real engine accepts, with the right quote character per dialect:
//   PostgreSQL / SQLite → "…"   MySQL / MariaDB / ClickHouse → `…`   MSSQL → […]
// A table named `order` (reserved everywhere) with a column `select`, plus the
// reported MySQL case of a table named `schedule`, are created + round-tripped
// through the exact quoting the frontend emits.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_reserved_identifier_quoting_roundtrip() {
    let mut drv = SqliteDriver::connect(&SqliteConnParams { path: String::new(), mode: SqliteMode::InMemory })
        .await
        .unwrap();
    drv.exec("CREATE TABLE \"order\" (\"select\" int)").await.unwrap();
    drv.exec("INSERT INTO \"order\" (\"select\") VALUES (7)").await.unwrap();
    let out = drv.exec("SELECT \"select\" FROM \"order\"").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["select"], serde_json::json!(7));
    eprintln!("CHK sqlite_reserved_identifier_quoting_roundtrip OK");
}

#[tokio::test]
async fn pg_reserved_identifier_quoting_roundtrip() {
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
    drv.exec("CREATE TABLE \"order\" (\"select\" int)").await.unwrap();
    drv.exec("INSERT INTO \"order\" (\"select\") VALUES (7)").await.unwrap();
    let out = drv.exec("SELECT \"select\" FROM \"order\"").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["select"], serde_json::json!(7));
    eprintln!("CHK pg_reserved_identifier_quoting_roundtrip OK");
}

#[tokio::test]
async fn mysql_reserved_identifier_quoting_roundtrip() {
    let c = GenericImage::new("mysql", "8.0")
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
    // `order` reserved everywhere → backtick for MySQL
    drv.exec("CREATE TABLE `order` (`select` int)").await.unwrap();
    drv.exec("INSERT INTO `order` (`select`) VALUES (7)").await.unwrap();
    let out = drv.exec("SELECT `select` FROM `order`").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["select"], serde_json::json!(7));
    // the reported case: a table literally named `schedule` (MySQL keyword)
    drv.exec("CREATE TABLE `schedule` (id int)").await.unwrap();
    drv.exec("INSERT INTO `schedule` VALUES (1)").await.unwrap();
    let out = drv.exec("SELECT * FROM `schedule`").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.total, 1);
    eprintln!("CHK mysql_reserved_identifier_quoting_roundtrip OK");
}

#[tokio::test]
async fn mssql_reserved_identifier_quoting_roundtrip() {
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
    drv.exec("CREATE TABLE [order] ([select] int)").await.unwrap();
    drv.exec("INSERT INTO [order] ([select]) VALUES (7)").await.unwrap();
    let out = drv.exec("SELECT [select] FROM [order]").await.unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["select"], serde_json::json!(7));
    eprintln!("CHK mssql_reserved_identifier_quoting_roundtrip OK");
}

/// A `SELECT` returning a type with no binary output function (`aclitem` /
/// `aclitem[]`, e.g. `pg_namespace.nspacl`) must still run: the driver falls
/// back to the simple/text query protocol instead of erroring with
/// "no binary output function available for type aclitem".
#[tokio::test]
async fn pg_aclitem_query_uses_text_protocol() {
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
    let mut d = retry("postgres", || PgDriver::connect(&params)).await;
    // aclitem[] column
    let out = d
        .exec("SELECT nspname, nspacl FROM pg_namespace WHERE nspname = 'public'")
        .await
        .expect("aclitem[] query must execute via text protocol");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows.len(), 1, "one public schema row");
    assert_eq!(result.rows[0]["nspname"], serde_json::json!("public"));
    // scalar aclitem too (default ACL of a fresh object may be null; just must not error)
    d.exec("SELECT (aclexplode(nspacl)).grantee FROM pg_namespace WHERE nspname='public'")
        .await
        .expect("aclitem-derived query must execute");
    eprintln!("CHK pg_aclitem_query_uses_text_protocol OK");
}

// ============================================================================
// PERF BENCH — SELECT of 1,000,000 rows: real backend exec() time per engine.
//
// The interactive query editor path (`exec`) uses fetch_all: it buffers EVERY
// row in memory, then decodes each cell into a serde_json object-per-row before
// returning. These benches print the wall time of a full `SELECT *` (all 1M) vs
// a `LIMIT 1000` capped fetch — the capped number is the headroom an automatic
// result cap would recover. #[ignore]d (they seed 1M rows); run explicitly:
//   cargo test --test drivers_integration bench_ -- --ignored --nocapture --test-threads=1
// ============================================================================

fn bench_rows(o: &StatementOutcome) -> u64 {
    match o {
        StatementOutcome::Rows { result } => result.total,
        _ => 0,
    }
}

#[tokio::test]
#[ignore]
async fn bench_pg_select_million() {
    let (_c, port) = start_pg().await;
    let params = PgConnParams {
        host: "localhost".into(), port, database: "testdb".into(), user: "postgres".into(),
        password: PASS.into(), ssl: false, ssl_ca: String::new(), ssl_cert: String::new(), ssl_key: String::new(),
    };
    let mut drv = retry("postgres", || PgDriver::connect(&params)).await;
    drv.exec("CREATE TABLE big AS SELECT g AS id, 'row-' || g AS label FROM generate_series(1,1000000) g")
        .await.unwrap();

    let t = std::time::Instant::now();
    let full = drv.exec("SELECT * FROM big").await.unwrap();
    let full_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _capped = drv.exec("SELECT * FROM big LIMIT 1000").await.unwrap();
    let capped_ms = t.elapsed().as_millis();

    // Open Data path: first page (LIMIT 100) + footer COUNT(*).
    let t = std::time::Instant::now();
    let _page = drv.exec("SELECT * FROM big LIMIT 100").await.unwrap();
    let page_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _cnt = drv.exec("SELECT COUNT(*) AS c FROM big").await.unwrap();
    let count_ms = t.elapsed().as_millis();

    eprintln!(
        "BENCH postgres   full SELECT*={} ms | cap1000={} ms || OpenData: page100={} ms + count(*)={} ms  (rows={})",
        full_ms, capped_ms, page_ms, count_ms, bench_rows(&full)
    );
    assert_eq!(bench_rows(&full), 1_000_000);
}

#[tokio::test]
#[ignore]
async fn bench_mysql_select_million() {
    let c = GenericImage::new("mysql", "8")
        .with_exposed_port(3306.tcp())
        .with_env_var("MYSQL_ROOT_PASSWORD", PASS)
        .with_env_var("MYSQL_DATABASE", "testdb")
        .start().await.expect("start mysql");
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    let params = MySqlConnParams {
        host: "localhost".into(), port, database: "testdb".into(), user: "root".into(),
        password: PASS.into(), ssl: false, ssl_ca: String::new(), ssl_cert: String::new(), ssl_key: String::new(),
    };
    let mut drv = retry("mysql", || MySqlDriver::connect(&params, "mysql")).await;
    drv.exec("SET SESSION cte_max_recursion_depth = 2000000").await.unwrap();
    drv.exec("CREATE TABLE big AS WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM seq WHERE id < 1000000) SELECT id, CONCAT('row-', id) AS label FROM seq")
        .await.unwrap();

    let t = std::time::Instant::now();
    let full = drv.exec("SELECT * FROM big").await.unwrap();
    let full_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _capped = drv.exec("SELECT * FROM big LIMIT 1000").await.unwrap();
    let capped_ms = t.elapsed().as_millis();

    let t = std::time::Instant::now();
    let _page = drv.exec("SELECT * FROM big LIMIT 100").await.unwrap();
    let page_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _cnt = drv.exec("SELECT COUNT(*) AS c FROM big").await.unwrap();
    let count_ms = t.elapsed().as_millis();

    eprintln!(
        "BENCH mysql      full SELECT*={} ms | cap1000={} ms || OpenData: page100={} ms + count(*)={} ms  (rows={})",
        full_ms, capped_ms, page_ms, count_ms, bench_rows(&full)
    );
    assert_eq!(bench_rows(&full), 1_000_000);
}

#[tokio::test]
#[ignore]
async fn bench_mariadb_select_million() {
    let c = GenericImage::new("mariadb", "11")
        .with_exposed_port(3306.tcp())
        .with_env_var("MARIADB_ROOT_PASSWORD", PASS)
        .with_env_var("MARIADB_DATABASE", "testdb")
        .start().await.expect("start mariadb");
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    let params = MySqlConnParams {
        host: "localhost".into(), port, database: "testdb".into(), user: "root".into(),
        password: PASS.into(), ssl: false, ssl_ca: String::new(), ssl_cert: String::new(), ssl_key: String::new(),
    };
    let mut drv = retry("mariadb", || MySqlDriver::connect(&params, "mariadb")).await;
    // MariaDB defaults max_recursive_iterations = 1000 → raise it for the 1M seed.
    drv.exec("SET SESSION max_recursive_iterations = 2000000").await.unwrap();
    drv.exec("CREATE TABLE big AS WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM seq WHERE id < 1000000) SELECT id, CONCAT('row-', id) AS label FROM seq")
        .await.unwrap();

    let t = std::time::Instant::now();
    let full = drv.exec("SELECT * FROM big").await.unwrap();
    let full_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _capped = drv.exec("SELECT * FROM big LIMIT 1000").await.unwrap();
    let capped_ms = t.elapsed().as_millis();

    let t = std::time::Instant::now();
    let _page = drv.exec("SELECT * FROM big LIMIT 100").await.unwrap();
    let page_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _cnt = drv.exec("SELECT COUNT(*) AS c FROM big").await.unwrap();
    let count_ms = t.elapsed().as_millis();

    eprintln!(
        "BENCH mariadb    full SELECT*={} ms | cap1000={} ms || OpenData: page100={} ms + count(*)={} ms  (rows={})",
        full_ms, capped_ms, page_ms, count_ms, bench_rows(&full)
    );
    assert_eq!(bench_rows(&full), 1_000_000);
}

#[tokio::test]
#[ignore]
async fn bench_clickhouse_select_million() {
    let c = GenericImage::new("clickhouse/clickhouse-server", "24.8")
        .with_exposed_port(8123.tcp())
        .with_env_var("CLICKHOUSE_PASSWORD", PASS)
        .start().await.expect("start clickhouse");
    let port = c.get_host_port_ipv4(8123).await.unwrap();
    let params = ChConnParams {
        host: "localhost".into(), port, database: "default".into(), user: "default".into(),
        password: PASS.into(), ssl: false,
    };
    let mut drv = retry("clickhouse", || ChDriver::connect(&params)).await;
    // ClickHouse HTTP connects lazily (stateless) → retry a trivial query until the
    // server actually answers before seeding.
    for _ in 0..30 {
        if drv.exec("SELECT 1").await.is_ok() { break; }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    drv.exec("CREATE TABLE big ENGINE = MergeTree ORDER BY id AS SELECT number AS id, concat('row-', toString(number)) AS label FROM numbers(1000000)")
        .await.unwrap();

    let t = std::time::Instant::now();
    let full = drv.exec("SELECT * FROM big").await.unwrap();
    let full_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _capped = drv.exec("SELECT * FROM big LIMIT 1000").await.unwrap();
    let capped_ms = t.elapsed().as_millis();

    let t = std::time::Instant::now();
    let _page = drv.exec("SELECT * FROM big LIMIT 100").await.unwrap();
    let page_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _cnt = drv.exec("SELECT COUNT(*) AS c FROM big").await.unwrap();
    let count_ms = t.elapsed().as_millis();

    eprintln!(
        "BENCH clickhouse full SELECT*={} ms | cap1000={} ms || OpenData: page100={} ms + count(*)={} ms  (rows={})",
        full_ms, capped_ms, page_ms, count_ms, bench_rows(&full)
    );
    assert_eq!(bench_rows(&full), 1_000_000);
}

#[tokio::test]
#[ignore]
async fn bench_sqlite_select_million() {
    // No container — in-process file DB.
    let path = std::env::temp_dir().join(format!("ds_bench_{}.db", std::process::id()));
    let params = SqliteConnParams { path: path.to_string_lossy().into_owned(), mode: SqliteMode::ReadWrite };
    let drv = SqliteDriver::connect(&params).await.unwrap();
    drv.exec("CREATE TABLE big AS WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM seq WHERE id < 1000000) SELECT id, 'row-' || id AS label FROM seq")
        .await.unwrap();

    let t = std::time::Instant::now();
    let full = drv.exec("SELECT * FROM big").await.unwrap();
    let full_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _capped = drv.exec("SELECT * FROM big LIMIT 1000").await.unwrap();
    let capped_ms = t.elapsed().as_millis();

    let t = std::time::Instant::now();
    let _page = drv.exec("SELECT * FROM big LIMIT 100").await.unwrap();
    let page_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _cnt = drv.exec("SELECT COUNT(*) AS c FROM big").await.unwrap();
    let count_ms = t.elapsed().as_millis();

    eprintln!(
        "BENCH sqlite     full SELECT*={} ms | cap1000={} ms || OpenData: page100={} ms + count(*)={} ms  (rows={})",
        full_ms, capped_ms, page_ms, count_ms, bench_rows(&full)
    );
    assert_eq!(bench_rows(&full), 1_000_000);
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
#[ignore]
async fn bench_mssql_select_million() {
    let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
        .with_exposed_port(1433.tcp())
        .with_env_var("ACCEPT_EULA", "Y")
        .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
        .start().await.expect("start mssql");
    let port = c.get_host_port_ipv4(1433).await.unwrap();
    let params = MssqlConnParams {
        host: "localhost".into(), port, database: "".into(), user: "sa".into(),
        password: MSSQL_PASS.into(), ssl: false, ssl_ca: String::new(), auth: "sql".into(),
    };
    let mut drv = retry("mssql", || MssqlDriver::connect(&params)).await;
    // Seed 1M rows via a cross join of the catalog (fast; sys.all_objects^2 ≫ 1M).
    drv.exec("SELECT TOP 1000000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS id, CAST(NULL AS varchar(32)) AS label INTO big FROM sys.all_objects a CROSS JOIN sys.all_objects b")
        .await.unwrap();
    drv.exec("UPDATE big SET label = CONCAT('row-', id)").await.unwrap();

    let t = std::time::Instant::now();
    let full = drv.exec("SELECT * FROM big").await.unwrap();
    let full_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _capped = drv.exec("SELECT TOP 1000 * FROM big").await.unwrap();
    let capped_ms = t.elapsed().as_millis();

    let t = std::time::Instant::now();
    let _page = drv.exec("SELECT TOP 100 * FROM big").await.unwrap();
    let page_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let _cnt = drv.exec("SELECT COUNT(*) AS c FROM big").await.unwrap();
    let count_ms = t.elapsed().as_millis();

    eprintln!(
        "BENCH mssql      full SELECT*={} ms | cap1000={} ms || OpenData: page100={} ms + count(*)={} ms  (rows={})",
        full_ms, capped_ms, page_ms, count_ms, bench_rows(&full)
    );
    assert_eq!(bench_rows(&full), 1_000_000);
}

#[tokio::test]
#[ignore]
async fn bench_mysql_wide_100k() {
    let c = GenericImage::new("mysql", "8")
        .with_exposed_port(3306.tcp())
        .with_env_var("MYSQL_ROOT_PASSWORD", PASS)
        .with_env_var("MYSQL_DATABASE", "testdb")
        .start().await.expect("start mysql");
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    let params = MySqlConnParams {
        host: "localhost".into(), port, database: "testdb".into(), user: "root".into(),
        password: PASS.into(), ssl: false, ssl_ca: String::new(), ssl_cert: String::new(), ssl_key: String::new(),
    };
    let mut drv = retry("mysql", || MySqlDriver::connect(&params, "mysql")).await;
    drv.exec("SET SESSION cte_max_recursion_depth = 200000").await.unwrap();

    // 30 varchar "score/grade" columns (mostly NULL) + 4 int + datetime — mimics the
    // reported course_test_ism (wide, mostly-NULL). Build two variants: default
    // collation (VAR_STRING) vs utf8mb4_bin (flagged BINARY → the relabel pass runs).
    let vcols = |collate: &str| -> String {
        (1..=30).map(|i| format!("s{i} VARCHAR(32){collate}")).collect::<Vec<_>>().join(", ")
    };
    let mk = |name: &str, collate: &str| {
        format!(
            "CREATE TABLE {name} (key_id INT, customer_id INT, class_id INT, class_term INT, {}, created_at DATETIME)",
            vcols(collate)
        )
    };
    let seed = |name: &str| format!(
        "INSERT INTO {name} (key_id, customer_id, class_id, class_term, created_at) \
         WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM seq WHERE id < 100000) \
         SELECT id, 42260+id, 1359, 11, NOW() FROM seq"
    );

    for (name, collate) in [("wide_default", ""), ("wide_bin", " COLLATE utf8mb4_bin")] {
        drv.exec(&mk(name, collate)).await.unwrap();
        drv.exec(&seed(name)).await.unwrap();
        let t = std::time::Instant::now();
        let out = drv.exec(&format!("SELECT * FROM {name} LIMIT 100000")).await.unwrap();
        let ms = t.elapsed().as_millis();
        let (rows, ncols) = match &out {
            StatementOutcome::Rows { result } => (result.total, result.cols.len()),
            _ => (0, 0),
        };
        eprintln!("BENCH mysql-wide {name}: SELECT* LIMIT 100000 = {ms} ms  ({rows} rows x {ncols} cols)");
    }
}

// Wide-table (35 cols, 100k rows, mostly-NULL) benches for the OTHER engines — to
// see whether the object-per-row materialization cost is engine-agnostic (it is).
// vcols(n, type) builds "s1 <type>, s2 <type>, …".
fn wide_vcols(ty: &str) -> String {
    (1..=30).map(|i| format!("s{i} {ty}")).collect::<Vec<_>>().join(", ")
}

#[tokio::test]
#[ignore]
async fn bench_pg_wide_100k() {
    let (_c, port) = start_pg().await;
    let params = PgConnParams {
        host: "localhost".into(), port, database: "testdb".into(), user: "postgres".into(),
        password: PASS.into(), ssl: false, ssl_ca: String::new(), ssl_cert: String::new(), ssl_key: String::new(),
    };
    let mut drv = retry("postgres", || PgDriver::connect(&params)).await;
    drv.exec(&format!("CREATE TABLE wide (key_id int, customer_id int, class_id int, class_term int, {}, created_at timestamp)", wide_vcols("varchar(32)"))).await.unwrap();
    drv.exec("INSERT INTO wide (key_id, customer_id, class_id, class_term, created_at) SELECT g, 42260+g, 1359, 11, now() FROM generate_series(1,100000) g").await.unwrap();
    let t = std::time::Instant::now();
    let out = drv.exec("SELECT * FROM wide LIMIT 100000").await.unwrap();
    let ms = t.elapsed().as_millis();
    eprintln!("BENCH wide postgres  = {ms} ms  ({} rows x {} cols)", bench_rows(&out), match &out { StatementOutcome::Rows { result } => result.cols.len(), _ => 0 });
}

#[tokio::test]
#[ignore]
async fn bench_mariadb_wide_100k() {
    let c = GenericImage::new("mariadb", "11")
        .with_exposed_port(3306.tcp()).with_env_var("MARIADB_ROOT_PASSWORD", PASS).with_env_var("MARIADB_DATABASE", "testdb")
        .start().await.expect("start mariadb");
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    let params = MySqlConnParams { host: "localhost".into(), port, database: "testdb".into(), user: "root".into(), password: PASS.into(), ssl: false, ssl_ca: String::new(), ssl_cert: String::new(), ssl_key: String::new() };
    let mut drv = retry("mariadb", || MySqlDriver::connect(&params, "mariadb")).await;
    drv.exec("SET SESSION max_recursive_iterations = 2000000").await.unwrap();
    drv.exec(&format!("CREATE TABLE wide (key_id int, customer_id int, class_id int, class_term int, {}, created_at datetime)", wide_vcols("varchar(32)"))).await.unwrap();
    drv.exec("INSERT INTO wide (key_id, customer_id, class_id, class_term, created_at) WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM seq WHERE id < 100000) SELECT id, 42260+id, 1359, 11, NOW() FROM seq").await.unwrap();
    let t = std::time::Instant::now();
    let out = drv.exec("SELECT * FROM wide LIMIT 100000").await.unwrap();
    let ms = t.elapsed().as_millis();
    eprintln!("BENCH wide mariadb   = {ms} ms  ({} rows x {} cols)", bench_rows(&out), match &out { StatementOutcome::Rows { result } => result.cols.len(), _ => 0 });
}

#[tokio::test]
#[ignore]
async fn bench_mssql_wide_100k() {
    let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
        .with_exposed_port(1433.tcp()).with_env_var("ACCEPT_EULA", "Y").with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
        .start().await.expect("start mssql");
    let port = c.get_host_port_ipv4(1433).await.unwrap();
    let params = MssqlConnParams { host: "localhost".into(), port, database: "".into(), user: "sa".into(), password: MSSQL_PASS.into(), ssl: false, ssl_ca: String::new(), auth: "sql".into() };
    let mut drv = retry("mssql", || MssqlDriver::connect(&params)).await;
    drv.exec(&format!("CREATE TABLE wide (key_id int, customer_id int, class_id int, class_term int, {}, created_at datetime)", wide_vcols("varchar(32)"))).await.unwrap();
    drv.exec("INSERT INTO wide (key_id, customer_id, class_id, class_term, created_at) SELECT n, 42260+n, 1359, 11, GETDATE() FROM (SELECT TOP 100000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b) t").await.unwrap();
    let t = std::time::Instant::now();
    let out = drv.exec("SELECT TOP 100000 * FROM wide").await.unwrap();
    let ms = t.elapsed().as_millis();
    eprintln!("BENCH wide mssql     = {ms} ms  ({} rows x {} cols)", bench_rows(&out), match &out { StatementOutcome::Rows { result } => result.cols.len(), _ => 0 });
}

#[tokio::test]
#[ignore]
async fn bench_clickhouse_wide_100k() {
    let c = GenericImage::new("clickhouse/clickhouse-server", "24.8")
        .with_exposed_port(8123.tcp()).with_env_var("CLICKHOUSE_PASSWORD", PASS)
        .start().await.expect("start clickhouse");
    let port = c.get_host_port_ipv4(8123).await.unwrap();
    let params = ChConnParams { host: "localhost".into(), port, database: "default".into(), user: "default".into(), password: PASS.into(), ssl: false };
    let mut drv = retry("clickhouse", || ChDriver::connect(&params)).await;
    for _ in 0..30 { if drv.exec("SELECT 1").await.is_ok() { break; } tokio::time::sleep(std::time::Duration::from_millis(500)).await; }
    drv.exec(&format!("CREATE TABLE wide (key_id UInt64, customer_id UInt64, class_id UInt64, class_term UInt64, {}, created_at DateTime) ENGINE = MergeTree ORDER BY key_id", wide_vcols("Nullable(String)"))).await.unwrap();
    drv.exec("INSERT INTO wide (key_id, customer_id, class_id, class_term, created_at) SELECT number, 42260+number, 1359, 11, now() FROM numbers(100000)").await.unwrap();
    let t = std::time::Instant::now();
    let out = drv.exec("SELECT * FROM wide LIMIT 100000").await.unwrap();
    let ms = t.elapsed().as_millis();
    eprintln!("BENCH wide clickhouse = {ms} ms  ({} rows x {} cols)", bench_rows(&out), match &out { StatementOutcome::Rows { result } => result.cols.len(), _ => 0 });
}

#[tokio::test]
#[ignore]
async fn bench_sqlite_wide_100k() {
    let path = std::env::temp_dir().join(format!("ds_bench_wide_{}.db", std::process::id()));
    let params = SqliteConnParams { path: path.to_string_lossy().into_owned(), mode: SqliteMode::ReadWrite };
    let drv = SqliteDriver::connect(&params).await.unwrap();
    drv.exec(&format!("CREATE TABLE wide (key_id INTEGER, customer_id INTEGER, class_id INTEGER, class_term INTEGER, {}, created_at TEXT)", wide_vcols("TEXT"))).await.unwrap();
    drv.exec("INSERT INTO wide (key_id, customer_id, class_id, class_term, created_at) WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM seq WHERE id < 100000) SELECT id, 42260+id, 1359, 11, datetime('now') FROM seq").await.unwrap();
    let t = std::time::Instant::now();
    let out = drv.exec("SELECT * FROM wide LIMIT 100000").await.unwrap();
    let ms = t.elapsed().as_millis();
    eprintln!("BENCH wide sqlite    = {ms} ms  ({} rows x {} cols)", bench_rows(&out), match &out { StatementOutcome::Rows { result } => result.cols.len(), _ => 0 });
    let _ = std::fs::remove_file(&path);
}

/// A Query Editor tab that sat idle: the server closed its connection while
/// nobody was looking, and the next Execute hits a dead socket. Two guarantees
/// are proven here against a real server, because the reported symptom ("says
/// the connection is lost, but the list still shows connected") is exactly what
/// happens when neither one holds:
///   1. a recoverable loss is healed behind the user's back — the statement is
///      reconnected and re-run, and a write is applied exactly once;
///   2. a loss that CANNOT be healed (server gone) comes back typed as
///      `CONNECTION_LOST`, which is what makes the UI close the connection and
///      offer Reconnect instead of showing a raw wire error next to a green dot.
#[tokio::test]
async fn pg_idle_connection_is_healed_and_a_dead_server_is_reported() {
    use database_studio_lib::connections::profile::{
        ConnectionProfile, Environment, SqliteMode, SshConfig,
    };
    use database_studio_lib::connections::registry::Registry;
    use database_studio_lib::drivers::types::SystemType;

    let (container, port) = start_pg().await;
    let profile = ConnectionProfile {
        id: "idle-tab".into(),
        name: "idle".into(),
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
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        match registry.connect(profile.clone(), PASS.into(), String::new()).await {
            Ok(_) => break,
            Err(e) => {
                assert!(Instant::now() < deadline, "connect hết 240s: {e:?}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    registry
        .exec_statement("idle-tab", "CREATE TABLE t_idle(id int)".into())
        .await
        .unwrap()
        .expect("setup");

    // A second connection plays the server: it terminates the tab's backend, the
    // same thing an idle timeout / restart / dropped tunnel does to the socket.
    let killer_params = PgConnParams {
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
    let mut killer = retry("pg killer", || PgDriver::connect(&killer_params)).await;
    let kill_others = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
                       WHERE datname = 'testdb' AND pid <> pg_backend_pid()";
    killer.exec(kill_others).await.expect("terminate the idle backend");

    // 1a. A read after the drop just works — no error reaches the user.
    let out = registry
        .exec_statement("idle-tab", "SELECT 1 AS n".into())
        .await
        .unwrap()
        .expect("a server-closed connection must be healed, not reported");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(1));

    // 1b. A write after the drop is applied EXACTLY once: the statement never
    // reached the server before the retry, so healing cannot double-insert.
    killer.exec(kill_others).await.expect("terminate again");
    registry
        .exec_statement("idle-tab", "INSERT INTO t_idle VALUES (7)".into())
        .await
        .unwrap()
        .expect("write must survive a healed connection");
    let out = registry
        .exec_statement("idle-tab", "SELECT count(*) AS c FROM t_idle".into())
        .await
        .unwrap()
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["c"], serde_json::json!(1), "the retry must not double-apply the write");

    // 2. Server gone → nothing to heal. The error must be typed so the UI can
    //    say "Connection lost" and show Reconnect.
    drop(killer);
    container.stop().await.expect("stop the postgres container");
    let err = registry
        .exec_statement("idle-tab", "SELECT 1".into())
        .await
        .unwrap()
        .expect_err("a dead server must surface an error");
    assert_eq!(
        err.code.as_deref(),
        Some("CONNECTION_LOST"),
        "unhealable loss must be typed CONNECTION_LOST, got: {err:?}"
    );
    assert!(err.message.contains("Reconnect"), "message must point at the way out: {}", err.message);
    assert!(!err.raw.is_empty(), "the wire text must be kept for View raw");
}

/// The reported scenario, reproduced end to end on a real server: a tab runs a
/// query, sits idle past the server's `wait_timeout`, and the user presses
/// Execute again. MySQL reaps the idle connection and answers the next statement
/// with an ordinary error (4031 "disconnected … because of inactivity" / 2006
/// "server has gone away") — no socket error at all — which is why this used to
/// come back as an unrecoverable failure while the connection list still showed
/// a green dot. The registry must heal it and run the statement.
#[tokio::test]
async fn mysql_idle_connection_past_wait_timeout_is_healed() {
    use database_studio_lib::connections::profile::{
        ConnectionProfile, Environment, SqliteMode, SshConfig,
    };
    use database_studio_lib::connections::registry::Registry;
    use database_studio_lib::drivers::types::SystemType;

    // 3-second idle limit — the real thing, just impatient.
    let c = GenericImage::new("mysql", "8")
        .with_exposed_port(3306.tcp())
        .with_env_var("MYSQL_ROOT_PASSWORD", PASS)
        .with_env_var("MYSQL_DATABASE", "testdb")
        .with_cmd(vec!["--wait-timeout=3", "--interactive-timeout=3"])
        .start()
        .await
        .expect("start mysql container");
    let port = c.get_host_port_ipv4(3306).await.unwrap();

    let profile = ConnectionProfile {
        id: "my-idle".into(),
        name: "idle".into(),
        system: SystemType::Mysql,
        host: "localhost".into(),
        port,
        database: "testdb".into(),
        user: "root".into(),
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
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        match registry.connect(profile.clone(), PASS.into(), String::new()).await {
            Ok(_) => break,
            Err(e) => {
                assert!(Instant::now() < deadline, "mysql connect hết 240s: {e:?}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }

    // The tab runs something, then the user walks away.
    registry
        .exec_statement("my-idle", "CREATE TABLE t_idle(id int)".into())
        .await
        .unwrap()
        .expect("first statement");
    let session_before = mysql_session_id(&registry).await;
    tokio::time::sleep(Duration::from_secs(6)).await; // > wait_timeout

    // Execute again — this is where it used to fail.
    let out = registry
        .exec_statement("my-idle", "SELECT 1 AS n".into())
        .await
        .unwrap()
        .expect("an idle-reaped connection must be healed, not reported");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["n"], serde_json::json!(1));
    // Proof this is not a vacuous pass: the statement ran on a DIFFERENT server
    // session, i.e. the old one really was reaped and rebuilt underneath us.
    let session_after = mysql_session_id(&registry).await;
    assert_ne!(
        session_before, session_after,
        "the idle connection must have been replaced (same session id = the server never dropped it, \
         so this test would prove nothing)"
    );

    // And a write after another idle stretch lands exactly once.
    tokio::time::sleep(Duration::from_secs(6)).await;
    registry
        .exec_statement("my-idle", "INSERT INTO t_idle VALUES (1)".into())
        .await
        .unwrap()
        .expect("write after an idle drop");
    let out = registry
        .exec_statement("my-idle", "SELECT count(*) AS c FROM t_idle".into())
        .await
        .unwrap()
        .unwrap();
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    assert_eq!(result.rows[0]["c"], serde_json::json!(1), "the retry must not double-apply the write");
}

/// Server-side session id of the live MySQL connection (a new id means the
/// registry rebuilt the connection).
async fn mysql_session_id(registry: &database_studio_lib::connections::registry::Registry) -> String {
    let out = registry
        .exec_statement("my-idle", "SELECT CONNECTION_ID() AS id".into())
        .await
        .unwrap()
        .expect("session id");
    let StatementOutcome::Rows { result } = out else { panic!("expected rows") };
    result.rows[0]["id"].to_string()
}

// ---------------------------------------------------------------------------
// BENCH (ignored) — Kafka topic list: do chi phi lay watermark offsets.
// `topics()` hien goi fetch_watermarks TUAN TU cho MOI partition cua MOI topic
// (ke ca topic internal `__*` ma UI loc bo). Moi call = 2 ListOffsets round-trip
// (low + high) -> N partition = 2N round-trip noi duoi nhau.
// cargo test --test drivers_integration bench_kafka_topic_list -- --ignored --nocapture --test-threads=1
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore]
async fn bench_kafka_topic_list_watermarks() {
    use database_studio_lib::drivers::kafka::{KafkaConnParams, KafkaDriver};
    use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, TopicReplication};
    use rdkafka::client::DefaultClientContext;
    use rdkafka::consumer::Consumer;
    use rdkafka::{Offset, TopicPartitionList};
    use std::collections::BTreeMap;
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

    const TOPICS: usize = 40;
    const PARTS: i32 = 3;
    let admin: AdminClient<DefaultClientContext> = drv.config().create().unwrap();
    let names: Vec<String> = (0..TOPICS).map(|i| format!("bench_topic_{i:03}")).collect();
    let new_topics: Vec<NewTopic> = names
        .iter()
        .map(|n| NewTopic::new(n, PARTS, TopicReplication::Fixed(1)))
        .collect();
    let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(60)));
    admin.create_topics(new_topics.iter(), &opts).await.unwrap();

    // ep Kafka tao __consumer_offsets (50 partition) - dung thuc te cluster dang dung
    drv.reset_group_offset("bench_group".into(), names[0].clone(), 0, "offset".into(), 0)
        .await
        .ok();
    for i in 0..10 {
        drv.produce(&names[i % TOPICS], "k", "v", Some(0)).await.ok();
    }
    tokio::time::sleep(Duration::from_secs(2)).await;

    let consumer = drv.consumer();
    let _ = drv.topics().await.unwrap(); // warm-up metadata

    // --- A) DUONG HIEN TAI ---
    let t0 = Instant::now();
    let listed = drv.topics().await.unwrap();
    let current_ms = t0.elapsed().as_millis();
    let all_parts: usize = listed.iter().map(|t| t.partitions.len()).sum();
    let user_parts: usize = listed.iter().filter(|t| !t.internal).map(|t| t.partitions.len()).sum();
    let internal_parts = all_parts - user_parts;

    let mut expect: BTreeMap<(String, i32), (i64, i64)> = BTreeMap::new();
    for t in &listed {
        for p in &t.partitions {
            expect.insert((t.name.clone(), p.id), (p.low, p.high));
        }
    }

    // --- B) DUONG CU: fetch_watermarks TUAN TU cho MOI partition (ke ca internal) ---
    let md_pairs = {
        let c = consumer.clone();
        tokio::task::spawn_blocking(move || {
            let md = c.fetch_metadata(None, Duration::from_secs(10)).unwrap();
            let mut user = Vec::new();
            let mut all = Vec::new();
            for t in md.topics() {
                for p in t.partitions() {
                    all.push((t.name().to_string(), p.id()));
                    if !t.name().starts_with("__") {
                        user.push((t.name().to_string(), p.id()));
                    }
                }
            }
            (user, all)
        })
        .await
        .unwrap()
    };
    let targets = md_pairs.0;
    let all_targets = md_pairs.1;

    let c = consumer.clone();
    let tg = all_targets.clone();
    let t0 = Instant::now();
    let seq_user = tokio::task::spawn_blocking(move || {
        let mut out = BTreeMap::new();
        for (t, p) in &tg {
            let w = c.fetch_watermarks(t, *p, Duration::from_secs(2)).unwrap_or((0, 0));
            out.insert((t.clone(), *p), w);
        }
        out
    })
    .await
    .unwrap();
    let skip_internal_ms = t0.elapsed().as_millis();

    // --- C) SONG SONG (16 luong) ---
    let t0 = Instant::now();
    let par_user: BTreeMap<(String, i32), (i64, i64)> = {
        let mut chunks: Vec<Vec<(String, i32)>> = (0..16).map(|_| Vec::new()).collect();
        for (i, item) in targets.iter().enumerate() {
            chunks[i % 16].push(item.clone());
        }
        let mut handles = Vec::new();
        for ch in chunks {
            let c = consumer.clone();
            handles.push(tokio::task::spawn_blocking(move || {
                let mut out = Vec::new();
                for (t, p) in ch {
                    let w = c.fetch_watermarks(&t, p, Duration::from_secs(2)).unwrap_or((0, 0));
                    out.push(((t, p), w));
                }
                out
            }));
        }
        let mut merged = BTreeMap::new();
        for h in handles {
            for (k, v) in h.await.unwrap() {
                merged.insert(k, v);
            }
        }
        merged
    };
    let parallel_ms = t0.elapsed().as_millis();

    // --- D) BATCH offsets_for_times(-2 earliest, -1 latest) ---
    let c = consumer.clone();
    let tg = targets.clone();
    let t0 = Instant::now();
    let batched: Option<BTreeMap<(String, i32), (i64, i64)>> = tokio::task::spawn_blocking(move || {
        let mk = |sentinel: Offset| -> Option<TopicPartitionList> {
            let mut tpl = TopicPartitionList::new();
            for (t, p) in &tg {
                if let Err(e) = tpl.add_partition_offset(t, *p, sentinel) {
                    eprintln!("  D add_partition_offset({sentinel:?}) loi: {e}");
                    return None;
                }
            }
            match c.offsets_for_times(tpl, Duration::from_secs(10)) {
                Ok(v) => Some(v),
                Err(e) => {
                    eprintln!("  D offsets_for_times({sentinel:?}) loi: {e}");
                    None
                }
            }
        };
        let low = mk(Offset::Beginning)?;
        let high = mk(Offset::End)?;
        let mut out = BTreeMap::new();
        for e in low.elements() {
            let o = match e.offset() {
                Offset::Offset(o) => o,
                _ => -1,
            };
            out.insert((e.topic().to_string(), e.partition()), (o, 0));
        }
        for e in high.elements() {
            let o = match e.offset() {
                Offset::Offset(o) => o,
                _ => -1,
            };
            if let Some(v) = out.get_mut(&(e.topic().to_string(), e.partition())) {
                v.1 = o;
            }
        }
        Some(out)
    })
    .await
    .unwrap();
    let batched_ms = t0.elapsed().as_millis();

    for (k, v) in &seq_user {
        assert_eq!(expect.get(k), Some(v), "sequential-skip-internal lech tai {k:?}");
    }
    for (k, v) in &par_user {
        assert_eq!(expect.get(k), Some(v), "parallel lech tai {k:?}");
    }
    let batched_ok = match &batched {
        None => "N/A (offsets_for_times loi)".to_string(),
        Some(b) => {
            let mut wrong = 0usize;
            for (k, v) in b {
                if expect.get(k) != Some(v) {
                    if wrong < 3 {
                        eprintln!("  batched lech {k:?}: batched={v:?} expect={:?}", expect.get(k));
                    }
                    wrong += 1;
                }
            }
            format!("{} sai / {} partition", wrong, b.len())
        }
    };

    eprintln!(
        "BENCH kafka topic list: topics={} partitions_total={} (user={} internal={})",
        listed.len(),
        all_parts,
        user_parts,
        internal_parts
    );
    eprintln!("BENCH   A topics() SAU khi sua          = {current_ms} ms  [2 request ListOffsets]");
    eprintln!(
        "BENCH   B duong CU (seq per-partition)   = {skip_internal_ms} ms  [{} watermark call = {} round-trip]",
        all_targets.len(),
        all_targets.len() * 2
    );
    eprintln!("BENCH   C parallel x16 (du phong)       = {parallel_ms} ms  [{} call]", targets.len());
    eprintln!("BENCH   D batched offsets_for_times     = {batched_ms} ms  [2 request] · dung: {batched_ok}");
    eprintln!("BENCH   internal partition trong list   = {internal_parts}");
}

// ---------------------------------------------------------------------------
// BENCH (ignored) — Kafka browse message: mo 1 topic lon.
// Duong hien tai auto-start tu "earliest" -> doc TOAN BO log (va backend emit 1
// event Tauri / message) du UI chi giu 500 dong moi nhat.
// cargo test --test drivers_integration bench_kafka_browse -- --ignored --nocapture --test-threads=1
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore]
async fn bench_kafka_browse_large_topic() {
    use database_studio_lib::drivers::kafka::{KafkaConnParams, KafkaDriver};
    use rdkafka::consumer::{Consumer, DefaultConsumerContext};
    use rdkafka::error::KafkaError;
    use rdkafka::producer::{FutureProducer, FutureRecord};
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

    const TOPIC: &str = "bench_big";
    const PARTS: i32 = 3;
    const N: usize = 200_000;
    drv.create_topic(TOPIC, PARTS, 1).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;

    let producer: FutureProducer = drv.config().clone().set("queue.buffering.max.messages", "1000000").create().unwrap();
    let payload = format!("{{\"id\":0,\"name\":\"row\",\"blob\":\"{}\"}}", "x".repeat(80));
    let t0 = Instant::now();
    let mut futs = Vec::with_capacity(N);
    for i in 0..N {
        let key = format!("k{i}");
        futs.push(producer.send_result(FutureRecord::to(TOPIC).key(&key).payload(&payload)).map_err(|(e, _)| e));
    }
    let mut sent = 0usize;
    for f in futs {
        if let Ok(f) = f {
            if f.await.is_ok() {
                sent += 1;
            }
        }
    }
    eprintln!("BENCH seed {sent} messages in {} ms", t0.elapsed().as_millis());

    // helper: poll cho toi khi moi partition bao EOF (hoac het deadline)
    fn drain(consumer: rdkafka::consumer::BaseConsumer<DefaultConsumerContext>, parts: usize, budget: Duration) -> (usize, u128) {
        let t0 = Instant::now();
        let mut count = 0usize;
        let mut eof = std::collections::HashSet::new();
        let deadline = t0 + budget;
        while Instant::now() < deadline && eof.len() < parts {
            match consumer.poll(Duration::from_millis(200)) {
                Some(Ok(_m)) => count += 1,
                Some(Err(KafkaError::PartitionEOF(p))) => {
                    eof.insert(p);
                }
                _ => {}
            }
        }
        let ms = t0.elapsed().as_millis();
        drop(consumer);
        (count, ms)
    }

    // --- E) DUONG HIEN TAI: tu "earliest" ---
    let c = drv.browse_consumer(TOPIC, "earliest", 0, None, DefaultConsumerContext).unwrap();
    let (n_e, ms_e) = tokio::task::spawn_blocking(move || drain(c, PARTS as usize, Duration::from_secs(180)))
        .await
        .unwrap();

    // --- F) chi lay ~500 message moi nhat (high - 500/parts moi partition) ---
    let consumer = drv.consumer();
    let per = (500 / PARTS as i64).max(1);
    let mut starts = Vec::new();
    for p in 0..PARTS {
        let (low, high) = {
            let c = consumer.clone();
            tokio::task::spawn_blocking(move || c.fetch_watermarks(TOPIC, p, Duration::from_secs(5)))
                .await
                .unwrap()
                .unwrap()
        };
        starts.push((p, (high - per).max(low)));
    }
    let t0 = Instant::now();
    let mut n_f = 0usize;
    for (p, off) in starts {
        let c = drv.browse_consumer(TOPIC, "offset", off, Some(p), DefaultConsumerContext).unwrap();
        let (n, _) = tokio::task::spawn_blocking(move || drain(c, 1, Duration::from_secs(30))).await.unwrap();
        n_f += n;
    }
    let ms_f = t0.elapsed().as_millis();

    eprintln!("BENCH kafka browse topic {N} messages / {PARTS} partitions");
    eprintln!("BENCH   E from=earliest (hien tai) = {ms_e} ms · {n_e} message doc ve · {n_e} event Tauri");
    eprintln!("BENCH   F chi 500 moi nhat         = {ms_f} ms · {n_f} message doc ve");
    eprintln!("BENCH   UI chi hien MAX=500 dong -> E doc thua {} message", n_e.saturating_sub(500));
}

// ---------------------------------------------------------------------------
// Kafka perf fix (container that): (1) topics() lay watermark GOP phai ra dung
// y het duong hoi tung partition; (2) browse "recent" chi doc N message moi nhat
// thay vi doc lai ca log.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn kafka_topic_watermarks_match_per_partition_and_recent_browse_reads_only_the_tail() {
    use database_studio_lib::drivers::kafka::{KafkaConnParams, KafkaDriver};
    use rdkafka::consumer::{Consumer, DefaultConsumerContext};
    use rdkafka::error::KafkaError;
    use std::collections::BTreeSet;
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

    const TOPIC: &str = "wm_itest";
    drv.create_topic(TOPIC, 3, 1).await.unwrap();
    // p0 = 30 message, p1 = 20, p2 = 0 (rong) -> phu ca partition co va khong co data
    for i in 0..30 {
        drv.produce(TOPIC, "k", &format!("p0-{i}"), Some(0)).await.unwrap();
    }
    for i in 0..20 {
        drv.produce(TOPIC, "k", &format!("p1-{i}"), Some(1)).await.unwrap();
    }

    // --- (1) topics() (duong GOP moi) phai trung fetch_watermarks tung partition ---
    let mut listed = None;
    for _ in 0..20 {
        let all = drv.topics().await.unwrap();
        if let Some(t) = all.into_iter().find(|t| t.name == TOPIC) {
            if t.partitions.len() == 3 && t.partitions.iter().any(|p| p.high > 0) {
                listed = Some(t);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let topic = listed.expect("phai thay topic wm_itest");
    let consumer = drv.consumer();
    for p in &topic.partitions {
        let c = consumer.clone();
        let id = p.id;
        let truth = tokio::task::spawn_blocking(move || {
            c.fetch_watermarks(TOPIC, id, Duration::from_secs(10)).unwrap()
        })
        .await
        .unwrap();
        assert_eq!(
            (p.low, p.high),
            truth,
            "partition {id}: watermark gop phai trung watermark hoi rieng tung partition"
        );
        assert_eq!(p.lag, (p.high - p.low).max(0), "lag phai = high - low");
    }
    assert!(
        topic.offsets_known,
        "broker khoe manh thi phai doc duoc watermark; offsets_error = {:?}",
        topic.offsets_error
    );
    assert!(topic.offsets_error.is_none());
    let total: i64 = topic.partitions.iter().map(|p| (p.high - p.low).max(0)).sum();
    assert_eq!(total, 50, "tong message giu lai phai dung 50 (30 + 20 + 0)");
    // partition rong van phai ra 0/0 (khong bi mat khoi ket qua gop)
    let empty = topic.partitions.iter().find(|p| p.id == 2).expect("partition 2");
    assert_eq!((empty.low, empty.high), (0, 0), "partition rong phai la 0/0");
    eprintln!("CHK topics(): watermark gop == watermark tung partition (50 message)");

    // helper: doc toi khi moi partition bao EOF
    fn drain(
        consumer: rdkafka::consumer::BaseConsumer<DefaultConsumerContext>,
        parts: usize,
        budget: Duration,
    ) -> Vec<String> {
        let t0 = Instant::now();
        let mut out = Vec::new();
        let mut eof = std::collections::HashSet::new();
        while t0.elapsed() < budget && eof.len() < parts {
            match consumer.poll(Duration::from_millis(200)) {
                Some(Ok(m)) => out.push(
                    database_studio_lib::drivers::kafka::borrowed_to_message(&m).value,
                ),
                Some(Err(KafkaError::PartitionEOF(p))) => {
                    eof.insert(p);
                }
                _ => {}
            }
        }
        drop(consumer);
        out
    }

    // --- (2) browse "recent" 6 -> 6 message moi nhat MOI partition (khong chia deu:
    // du lieu Kafka thuong don theo key vao vai partition), KHONG doc ca log ---
    let c = drv.browse_consumer(TOPIC, "recent", 6, None, DefaultConsumerContext).unwrap();
    let got = tokio::task::spawn_blocking(move || drain(c, 3, Duration::from_secs(30)))
        .await
        .unwrap();
    let got: BTreeSet<String> = got.into_iter().collect();
    let want: BTreeSet<String> = (24..30)
        .map(|i| format!("p0-{i}"))
        .chain((14..20).map(|i| format!("p1-{i}")))
        .collect();
    assert_eq!(got, want, "recent phai doc DUNG duoi moi partition, khong doc lai tu dau");
    eprintln!("CHK browse recent: chi 12/50 message (duoi log) duoc doc ve");

    // --- (3) khong pha hanh vi cu: earliest van doc du 50 ---
    let c = drv.browse_consumer(TOPIC, "earliest", 0, None, DefaultConsumerContext).unwrap();
    let all = tokio::task::spawn_blocking(move || drain(c, 3, Duration::from_secs(60)))
        .await
        .unwrap();
    assert_eq!(all.len(), 50, "earliest van phai doc du ca log");
    eprintln!("CHK browse earliest: van doc du 50 message (khong regress)");

    // --- (4) topic RONG: moi partition phai bao PartitionEOF (tin hieu ma
    // kafka_consume dung de emit "kafka-eof" -> UI noi "khong co message" thay vi
    // "Waiting for messages..." mai mai) ---
    const EMPTY: &str = "wm_itest_empty";
    drv.create_topic(EMPTY, 2, 1).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let c = drv.browse_consumer(EMPTY, "recent", 500, None, DefaultConsumerContext).unwrap();
    let (msgs, eofs) = tokio::task::spawn_blocking(move || {
        let t0 = Instant::now();
        let mut msgs = 0usize;
        let mut eof = std::collections::HashSet::new();
        while t0.elapsed() < Duration::from_secs(30) && eof.len() < 2 {
            match c.poll(Duration::from_millis(200)) {
                Some(Ok(_)) => msgs += 1,
                Some(Err(KafkaError::PartitionEOF(p))) => {
                    eof.insert(p);
                }
                _ => {}
            }
        }
        drop(c);
        (msgs, eof.len())
    })
    .await
    .unwrap();
    assert_eq!(msgs, 0, "topic rong khong duoc tra ve message nao");
    assert_eq!(eofs, 2, "CA 2 partition cua topic rong phai bao PartitionEOF");
    eprintln!("CHK topic rong: 0 message + EOF du 2/2 partition (co tin hieu de bao 'no messages')");
}

// ---------------------------------------------------------------------------
// Kafka: topic CON message thi khong bao gio duoc bao la rong.
//
// Tai hien dung trieu chung user gap: doc ve 0 message KHONG co nghia topic rong.
// Transaction cua Kafka ghi them "control record" chiem offset nhung KHONG bao gio
// duoc tra ve cho consumer -> high watermark > offset cua message doc duoc cuoi
// cung, nen mot cua so doc ngan o duoi log co the khong chua message nao trong khi
// topic van con day du lieu. (Log compaction cho ket qua tuong tu.)
// ---------------------------------------------------------------------------
#[tokio::test]
async fn kafka_topic_with_records_is_never_reported_empty() {
    use database_studio_lib::drivers::kafka::{KafkaConnParams, KafkaDriver};
    use rdkafka::consumer::DefaultConsumerContext;
    use rdkafka::error::KafkaError;
    use rdkafka::producer::{FutureProducer, FutureRecord, Producer};
    use testcontainers_modules::kafka::{Kafka, KAFKA_PORT};

    // transaction can transaction-state topic RF=1 tren cluster 1 broker
    let node = Kafka::default()
        .with_env_var("KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR", "1")
        .with_env_var("KAFKA_TRANSACTION_STATE_LOG_MIN_ISR", "1")
        .start()
        .await
        .expect("start kafka container");
    let port = node.get_host_port_ipv4(KAFKA_PORT).await.unwrap();
    let params = KafkaConnParams {
        bootstrap: format!("127.0.0.1:{port}"),
        sasl_mechanism: String::new(),
        user: String::new(),
        password: String::new(),
        ssl: false,
    };
    let drv = retry("kafka", || KafkaDriver::connect(&params)).await;

    const TOPIC: &str = "txn_tail";
    drv.create_topic(TOPIC, 1, 1).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;

    // 1 message trong 1 transaction da commit -> log co [msg@0, control@1]
    let mut cfg = drv.config();
    cfg.set("transactional.id", "itest-txn");
    let producer: FutureProducer = cfg.create().unwrap();
    producer.init_transactions(Duration::from_secs(30)).unwrap();
    producer.begin_transaction().unwrap();
    producer
        .send(FutureRecord::to(TOPIC).key("k").payload("committed-record"), Duration::from_secs(15))
        .await
        .unwrap();
    producer.commit_transaction(Duration::from_secs(30)).unwrap();

    // high phai vuot qua offset cua message doc duoc (control record chiem 1 offset)
    let mut listed = None;
    for _ in 0..20 {
        if let Some(t) = drv.topics().await.unwrap().into_iter().find(|t| t.name == TOPIC) {
            if t.partitions.first().map(|p| p.high).unwrap_or(0) > 0 {
                listed = Some(t);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let topic = listed.expect("phai thay topic txn_tail");
    let p0 = &topic.partitions[0];
    assert!(p0.high >= 2, "control record phai day high len >= 2, nhan {}", p0.high);
    eprintln!("CHK log co control record: low={} high={}", p0.low, p0.high);

    fn drain(
        consumer: rdkafka::consumer::BaseConsumer<DefaultConsumerContext>,
        budget: Duration,
    ) -> Vec<String> {
        let t0 = Instant::now();
        let mut out = Vec::new();
        let mut eof = false;
        while t0.elapsed() < budget && !eof {
            match consumer.poll(Duration::from_millis(200)) {
                Some(Ok(m)) => out.push(
                    database_studio_lib::drivers::kafka::borrowed_to_message(&m).value,
                ),
                Some(Err(KafkaError::PartitionEOF(_))) => eof = true,
                _ => {}
            }
        }
        drop(consumer);
        out
    }

    // (a) cua so duoi log CHI 1 offset = dung control record -> doc ve 0 message,
    //     day chinh la luc giao dien tuong "topic rong"
    let c = drv.browse_consumer(TOPIC, "recent", 1, None, DefaultConsumerContext).unwrap();
    let tail = tokio::task::spawn_blocking(move || drain(c, Duration::from_secs(30))).await.unwrap();
    assert!(tail.is_empty(), "cua so 1 offset chi chua control record, phai doc ve 0 message");

    // (b) NHUNG watermark cua broker van bao topic con du lieu -> khong duoc noi "rong"
    let (retained, wm_err) = drv.retained_messages(TOPIC, &[0]);
    assert!(
        retained > 0,
        "topic con message thi retained_messages phai > 0 (nhan {retained}, loi watermark: \
         {wm_err:?}) — day la thu duy nhat duoc phep ket luan 'topic khong co message'"
    );
    eprintln!("CHK doc ve 0 message NHUNG retained={retained} > 0 → khong bao 'rong'");

    // (c) mac dinh that (Recent 500): moi partition lui 500 offset → phai thay message
    let c = drv.browse_consumer(TOPIC, "recent", 500, None, DefaultConsumerContext).unwrap();
    let got = tokio::task::spawn_blocking(move || drain(c, Duration::from_secs(30))).await.unwrap();
    assert_eq!(got, vec!["committed-record".to_string()], "Recent mac dinh phai doc duoc message");
    eprintln!("CHK Recent(500) doc duoc message that");
}

// ---------------------------------------------------------------------------
// Kafka phan trang: fetch_page doc DUNG mot cua so co bien, di lui/tien duoc,
// va khong bao gio keo ca log ve.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn kafka_fetch_page_reads_one_bounded_window_and_walks_the_log() {
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

    const TOPIC: &str = "page_itest";
    const N: i64 = 250;
    drv.create_topic(TOPIC, 1, 1).await.unwrap();
    for i in 0..N {
        drv.produce(TOPIC, "k", &format!("m-{i}"), Some(0)).await.unwrap();
    }

    // trang moi nhat: 100/250 message, moi nhat len dau
    let p1 = drv.fetch_page(TOPIC, None, -1, 100).await.unwrap();
    assert_eq!(p1.msgs.len(), 100, "phai doc DUNG 100, khong keo ca 250 ve");
    assert_eq!(p1.msgs[0].offset, 249, "moi nhat len dau");
    assert_eq!(p1.msgs[99].offset, 150);
    assert_eq!(p1.window_start, 150);
    assert_eq!(p1.retained, N, "retained = so message con giu");
    assert!(p1.has_older, "con message cu hon");
    assert!(p1.at_newest, "dang o cuoi log");

    // trang cu hon
    let p2 = drv.fetch_page(TOPIC, None, p1.window_start, 100).await.unwrap();
    assert_eq!(p2.msgs.len(), 100);
    assert_eq!(p2.msgs[0].offset, 149);
    assert_eq!(p2.msgs[99].offset, 50);
    assert!(p2.has_older);
    assert!(!p2.at_newest, "khong con o cuoi log nua");

    // trang cuoi cung (dau log): het message cu hon
    let p3 = drv.fetch_page(TOPIC, None, p2.window_start, 100).await.unwrap();
    assert_eq!(p3.msgs.len(), 50, "chi con 50 message dau log");
    assert_eq!(p3.msgs[49].offset, 0);
    assert!(!p3.has_older, "da toi dau log");

    // khong chong lap / khong sot: 3 trang ghep lai = du 250 offset khac nhau
    let mut all: Vec<i64> =
        p1.msgs.iter().chain(&p2.msgs).chain(&p3.msgs).map(|m| m.offset).collect();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), N as usize, "3 trang phai phu kin ca log, khong trung khong sot");

    // topic rong: trang rong nhung retained = 0 (KHONG phai -1/khong biet)
    const EMPTY: &str = "page_itest_empty";
    drv.create_topic(EMPTY, 1, 1).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let pe = drv.fetch_page(EMPTY, None, -1, 100).await.unwrap();
    assert!(pe.msgs.is_empty());
    assert_eq!(pe.retained, 0, "topic rong that su -> retained = 0");
    assert!(!pe.has_older);
    eprintln!("CHK fetch_page: 3 trang phu kin 250 message, moi lan chi doc <= 100");
}
