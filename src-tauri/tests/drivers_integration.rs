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

#[tokio::test]
async fn mariadb_roundtrip() {
    mysql_like_roundtrip(("mariadb", "11"), "MARIADB", "mariadb").await;
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

// ---------------------------------------------------------------------------
// ClickHouse — HTTP 8123, kiểu dữ liệu cột + total ước lượng + lỗi có code
// (Phase 2 basics — CLICKHOUSE_SPEC_ADDENDUM)
// ---------------------------------------------------------------------------

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
                    Col { name: "id".into(), value: json!(3) },
                    Col { name: "name".into(), value: json!("c") },
                    Col { name: "n".into(), value: json!(30) },
                ],
            },
            GridChange::Update {
                schema: None,
                table: "t".into(),
                pk: vec![Col { name: "id".into(), value: json!(1) }],
                set: vec![Col { name: "name".into(), value: json!("A") }],
            },
            GridChange::Delete {
                schema: None,
                table: "t".into(),
                pk: vec![Col { name: "id".into(), value: json!(2) }],
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
                pk: vec![Col { name: "id".into(), value: json!(1) }],
                set: vec![Col { name: "name".into(), value: json!("X") }],
            },
            GridChange::Insert {
                schema: None,
                table: "t".into(),
                values: vec![Col { name: "khong_co_cot".into(), value: json!(1) }],
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
    };
    let mut drv = retry("postgres", || PgDriver::connect(&params)).await;
    drv.exec("CREATE TABLE grid_t (id int PRIMARY KEY, name text, active bool)").await.unwrap();
    drv.exec("INSERT INTO grid_t VALUES (1,'a',true),(2,'b',false)").await.unwrap();

    let n = drv
        .apply_changes(&[
            GridChange::Update {
                schema: Some("public".into()),
                table: "grid_t".into(),
                pk: vec![Col { name: "id".into(), value: json!(1) }],
                set: vec![
                    Col { name: "name".into(), value: json!("An") },
                    Col { name: "active".into(), value: json!(false) },
                ],
            },
            GridChange::Insert {
                schema: Some("public".into()),
                table: "grid_t".into(),
                values: vec![
                    Col { name: "id".into(), value: json!(3) },
                    Col { name: "name".into(), value: json!("Chi") },
                    Col { name: "active".into(), value: json!(true) },
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
