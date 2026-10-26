//! Backup & Restore — end to end through the SAME functions the dialog calls
//! (`plan_for` / `run_backup` / `run_restore` in commands/backup.rs), on real
//! engines: seed → back up → damage → restore → read back and compare.
//!
//! Engines here need no client tool on this computer (in-process, built-in or
//! server-side). pg_dump / mariadb-dump / mongodump runs use the copies shipped
//! with the app: `bundled_tools_back_up_and_restore_without_any_install`.
//!
//! Run: `cargo test --test backup_integration -- --test-threads=1` (Docker running).

use std::time::{Duration, Instant};

use database_studio_lib::commands::backup::{plan_for, run_backup, run_restore};
use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
use database_studio_lib::connections::registry::Registry;
use database_studio_lib::drivers::backup_tools::BackupOptions;
use database_studio_lib::drivers::types::{StatementOutcome, SystemType};
use database_studio_lib::state::AppState;
use database_studio_lib::storage::Storage;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};

const PASS: &str = "test123";
const MSSQL_PASS: &str = "Test123!Pass";

/// Run a test body on its own runtime whose worker threads have big stacks: the
/// dialog's backup futures nest deeply, and a debug build polls them with far
/// larger frames than the release app does (the default 2 MB overflows).
fn on_big_stack<F: std::future::Future<Output = ()> + Send + 'static>(f: F) {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .thread_stack_size(32 * 1024 * 1024)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        if let Err(e) = tokio::spawn(f).await {
            if e.is_panic() {
                std::panic::resume_unwind(e.into_panic());
            }
            panic!("{e}");
        }
    });
}

static STORE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn app_state() -> AppState {
    AppState {
        storage: Storage::open(std::env::temp_dir().join(format!("ds-backup-it-store-{}-{}", std::process::id(), STORE.fetch_add(1, std::sync::atomic::Ordering::SeqCst)))).unwrap(),
        registry: Registry::default(),
        pubsub: Default::default(),
        kafka_stops: Default::default(),
        test_cancels: Default::default(),
        export_cancels: Default::default(),
    }
}

fn profile(id: &str, system: SystemType, port: u16, database: &str, user: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.into(),
        name: id.into(),
        system,
        host: "localhost".into(),
        port,
        database: database.into(),
        user: user.into(),
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
        cassandra_dc: "datacenter1".into(),
        cassandra_consistency: String::new(),
        cassandra_flavor: String::new(),
        admin_url: String::new(),
    }
}

async fn connect(state: &AppState, p: ConnectionProfile, password: &str) {
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match state.registry.connect(p.clone(), password.into(), String::new()).await {
            Ok(_) => return,
            Err(e) => {
                assert!(Instant::now() < deadline, "connect {} timed out: {e:?}", p.id);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

async fn exec(state: &AppState, id: &str, sql: &str) -> Vec<serde_json::Value> {
    match state.registry.exec_statement(id, sql.into()).await.unwrap() {
        Ok(StatementOutcome::Rows { result }) => result.rows,
        Ok(_) => Vec::new(),
        Err(e) => panic!("{sql}: {}", e.message),
    }
}

fn n(v: &serde_json::Value, k: &str) -> i64 {
    match &v[k] {
        serde_json::Value::Number(x) => x.as_i64().unwrap(),
        serde_json::Value::String(s) => s.parse().unwrap(),
        other => panic!("{k}: {other}"),
    }
}

/// CQL straight through the Cassandra driver (the SQL path refuses CQL).
async fn cql(state: &AppState, id: &str, s: &str) -> Result<Vec<serde_json::Value>, String> {
    use database_studio_lib::drivers::LiveConnection;
    let s2 = s.to_string();
    let r = state
        .registry
        .with_driver(id, move |d| async move {
            let g = d.lock().await;
            match &*g {
                LiveConnection::Cassandra(c) => c.exec_cql(&s2, Some(5000), None).await,
                _ => unreachable!(),
            }
        })
        .await
        .map_err(|e| format!("{e}"))?;
    match r {
        Ok(o) => Ok(match o.outcome {
            StatementOutcome::Rows { result } => result.rows,
            _ => Vec::new(),
        }),
        Err(e) => Err(e.message),
    }
}

fn tmp(name: &str) -> String {
    let d = std::env::temp_dir().join(format!("ds-backup-it-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d.join(name).to_string_lossy().to_string()
}

fn opts(f: impl FnOnce(&mut BackupOptions)) -> Option<BackupOptions> {
    let mut o = BackupOptions::default();
    f(&mut o);
    Some(o)
}

// ---------------------------------------------------------------------------

#[test]
fn sqlite_backup_and_restore_through_the_dialog_path() {
    on_big_stack(async move {
        let state = app_state();
        let file = tmp("app.sqlite");
        let _ = std::fs::remove_file(&file);
        let mut p = profile("lite", SystemType::Sqlite, 0, "", "");
        p.sqlite_path = file.clone();
        connect(&state, p, "").await;
        exec(&state, "lite", "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").await;
        exec(&state, "lite", "INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')").await;

        let plan = plan_for(&state, "lite".into(), None, None).await.unwrap();
        assert_eq!(plan.method, "in-process");
        assert!(plan.backup_ready && plan.restore_ready);

        // a bare file name is refused — it would land in whatever the app's cwd is
        let err = run_backup(&state, "lite".into(), "backup.db".into(), None).await.err().unwrap();
        assert!(format!("{err}").contains("full path"), "{err}");

        let dest = tmp("nested/dir/app-backup.db"); // missing folders are created
        let out = run_backup(&state, "lite".into(), dest.clone(), None).await.unwrap();
        assert!(out.bytes.unwrap() > 0 && !out.server_side);

        exec(&state, "lite", "DELETE FROM t").await;
        run_restore(&state, "lite".into(), dest, None).await.unwrap();
        let r = exec(&state, "lite", "SELECT count(*) AS n FROM t").await;
        assert_eq!(n(&r[0], "n"), 3);
    })
}

#[test]
fn duckdb_backup_and_restore_through_the_dialog_path() {
    on_big_stack(async move {
        let state = app_state();
        let file = tmp("warehouse.duckdb");
        let _ = std::fs::remove_file(&file);
        let mut p = profile("duck", SystemType::Duckdb, 0, "", "");
        p.sqlite_path = file.clone();
        connect(&state, p, "").await;
        exec(&state, "duck", "CREATE TABLE sales AS SELECT range AS id, range * 2 AS amount FROM range(500)").await;
        let dest = tmp("warehouse-backup.duckdb");
        let _ = std::fs::remove_file(&dest);
        run_backup(&state, "duck".into(), dest.clone(), None).await.unwrap();
        exec(&state, "duck", "DELETE FROM sales WHERE id > 10").await;
        run_restore(&state, "duck".into(), dest, None).await.unwrap();
        let r = exec(&state, "duck", "SELECT count(*) AS n, sum(amount) AS s FROM sales").await;
        assert_eq!(n(&r[0], "n"), 500);
        assert_eq!(n(&r[0], "s"), 249_500);
    })
}

#[test]
fn redis_backup_restore_one_logical_database_with_ttls() {
    on_big_stack(redis_backup_suite("redis", "7-alpine"))
}

/// Valkey (a flavor of the Redis engine — SPEC-VALKEY.md): the same built-in
/// DUMP/RESTORE backup must round-trip on a real Valkey server.
#[test]
fn valkey_backup_restore_one_logical_database_with_ttls() {
    on_big_stack(redis_backup_suite("valkey/valkey", "8.1-alpine"))
}

async fn redis_backup_suite(image: &'static str, tag: &'static str) {
    {
        let c = GenericImage::new(image, tag)
            .with_exposed_port(6379.tcp())
            .start()
            .await
            .expect("start redis/valkey (Docker must be running)");
        let port = c.get_host_port_ipv4(6379).await.unwrap();
        let state = app_state();
        // the app's connection sits on db0 — the backup must use db2 WITHOUT moving it
        connect(&state, profile("r", SystemType::Redis, port, "0", ""), "").await;

        let mut seed = redis::Client::open(format!("redis://127.0.0.1:{port}/2"))
            .unwrap()
            .get_multiplexed_async_connection()
            .await
            .unwrap();
        let _: () = redis::cmd("SET").arg("s").arg("hello").query_async(&mut seed).await.unwrap();
        let _: () = redis::cmd("SET").arg("ttl").arg("x").arg("EX").arg(600).query_async(&mut seed).await.unwrap();
        let _: () = redis::cmd("HSET").arg("h").arg("a").arg("1").arg("b").arg("2").query_async(&mut seed).await.unwrap();
        let _: () = redis::cmd("RPUSH").arg("l").arg("1").arg("2").arg("3").query_async(&mut seed).await.unwrap();
        let _: () = redis::cmd("SADD").arg("st").arg("x").arg("y").query_async(&mut seed).await.unwrap();
        let _: () = redis::cmd("ZADD").arg("z").arg(1).arg("one").arg(2).arg("two").query_async(&mut seed).await.unwrap();
        let _: String = redis::cmd("XADD").arg("x").arg("*").arg("k").arg("v").query_async(&mut seed).await.unwrap();
        let _: () = redis::cmd("SET").arg(&b"bin\x00\xffkey"[..]).arg(&b"\x00\x01\x02"[..]).query_async(&mut seed).await.unwrap();
        for i in 0..2500 {
            let _: () = redis::cmd("SET").arg(format!("bulk:{i}")).arg(i).query_async(&mut seed).await.unwrap();
        }
        // db0 has its own key, which must not be touched
        let mut db0 = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).unwrap().get_multiplexed_async_connection().await.unwrap();
        let _: () = redis::cmd("SET").arg("db0key").arg("keep").query_async(&mut db0).await.unwrap();

        let plan = plan_for(&state, "r".into(), Some("2".into()), None).await.unwrap();
        assert_eq!(plan.method, "built-in");
        let dest = tmp("redis_db2.redis.jsonl");
        let out = run_backup(&state, "r".into(), dest.clone(), opts(|o| o.database = Some("2".into()))).await.unwrap();
        assert_eq!(out.items, Some(2508), "{}", out.message);

        let _: () = redis::cmd("FLUSHDB").query_async(&mut seed).await.unwrap();
        let r = run_restore(&state, "r".into(), dest.clone(), opts(|o| o.database = Some("db2".into()))).await.unwrap();
        assert_eq!(r.items, Some(2508));

        let s: String = redis::cmd("GET").arg("s").query_async(&mut seed).await.unwrap();
        assert_eq!(s, "hello");
        let ttl: i64 = redis::cmd("TTL").arg("ttl").query_async(&mut seed).await.unwrap();
        assert!(ttl > 500 && ttl <= 600, "TTL kept: {ttl}");
        let persist: i64 = redis::cmd("TTL").arg("s").query_async(&mut seed).await.unwrap();
        assert_eq!(persist, -1, "a key without TTL stays persistent");
        let h: Vec<String> = redis::cmd("HMGET").arg("h").arg("a").arg("b").query_async(&mut seed).await.unwrap();
        assert_eq!(h, vec!["1", "2"]);
        let l: Vec<String> = redis::cmd("LRANGE").arg("l").arg(0).arg(-1).query_async(&mut seed).await.unwrap();
        assert_eq!(l, vec!["1", "2", "3"]);
        let zc: i64 = redis::cmd("ZCARD").arg("z").query_async(&mut seed).await.unwrap();
        assert_eq!(zc, 2);
        let xl: i64 = redis::cmd("XLEN").arg("x").query_async(&mut seed).await.unwrap();
        assert_eq!(xl, 1);
        let bin: Vec<u8> = redis::cmd("GET").arg(&b"bin\x00\xffkey"[..]).query_async(&mut seed).await.unwrap();
        assert_eq!(bin, b"\x00\x01\x02".to_vec(), "binary keys and values survive");
        let dbsize: i64 = redis::cmd("DBSIZE").query_async(&mut seed).await.unwrap();
        assert_eq!(dbsize, 2508);

        // restoring again without "replace" keeps what is there
        let _: () = redis::cmd("SET").arg("s").arg("changed").query_async(&mut seed).await.unwrap();
        let again = run_restore(&state, "r".into(), dest.clone(), opts(|o| o.database = Some("2".into()))).await.unwrap();
        assert_eq!(again.items, Some(0));
        assert!(again.notes[0].contains("2508 key(s) already existed"), "{:?}", again.notes);
        let s: String = redis::cmd("GET").arg("s").query_async(&mut seed).await.unwrap();
        assert_eq!(s, "changed");
        // …and with "replace" overwrites it
        run_restore(&state, "r".into(), dest, opts(|o| {
            o.database = Some("2".into());
            o.clean = Some(true);
        }))
        .await
        .unwrap();
        let s: String = redis::cmd("GET").arg("s").query_async(&mut seed).await.unwrap();
        assert_eq!(s, "hello");

        // db0 untouched, and the app's own connection is still on db0
        let k: String = redis::cmd("GET").arg("db0key").query_async(&mut db0).await.unwrap();
        assert_eq!(k, "keep");
        let n0: i64 = redis::cmd("DBSIZE").query_async(&mut db0).await.unwrap();
        assert_eq!(n0, 1);

        // a file that is not a Redis backup is refused, not half-applied
        let bad = tmp("not-redis.jsonl");
        std::fs::write(&bad, "hello\n").unwrap();
        assert!(run_restore(&state, "r".into(), bad, None).await.is_err());
    }
}

#[test]
fn cassandra_keyspace_backup_restores_schema_and_rows() {
    on_big_stack(async move {
        // The test goes through `registry.connect` like the app, so the node must
        // advertise an address this host can reach: 127.0.0.1 on a fixed 9042
        // (otherwise the driver follows the topology to the container's own IP).
        let c = GenericImage::new("cassandra", "5.0")
            .with_exposed_port(9042.tcp())
            .with_env_var("HEAP_NEWSIZE", "128M")
            .with_env_var("MAX_HEAP_SIZE", "512M")
            .with_env_var("CASSANDRA_BROADCAST_RPC_ADDRESS", "127.0.0.1")
            .with_mapped_port(9042, 9042.tcp())
            .start()
            .await
            .expect("start cassandra (Docker must be running; host port 9042 free)");
        let port = c.get_host_port_ipv4(9042).await.unwrap();
        let state = app_state();
        let mut p = profile("cass", SystemType::Cassandra, port, "", "");
        p.host = "127.0.0.1".into();
        connect(&state, p, "").await;
        // first statements may hit a node that is still joining — retry
        let deadline = Instant::now() + Duration::from_secs(240);
        while let Err(e) = cql(&state, "cass", "CREATE KEYSPACE IF NOT EXISTS shop WITH replication = {'class':'SimpleStrategy','replication_factor':1}").await {
            assert!(Instant::now() < deadline, "cassandra not ready: {e}");
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        let st = &state;
        let run = |s: String| async move { cql(st, "cass", &s).await.unwrap_or_else(|e| panic!("{s}: {e}")) };
        let c2 = |s: &str| s.to_string();
        run(c2("CREATE TYPE shop.point (x double, y double)")).await;
        run(c2("CREATE TYPE shop.address (street text, geo frozen<point>)")).await;
        run(c2("CREATE TABLE shop.orders (customer text, id int, total decimal, tags set<text>, ship frozen<address>, note text static, PRIMARY KEY (customer, id)) WITH CLUSTERING ORDER BY (id DESC)")).await;
        run(c2("CREATE INDEX orders_total ON shop.orders (total)")).await;
        run(c2("CREATE TABLE shop.views (page text PRIMARY KEY, hits counter)")).await;
        for i in 0..1200 {
            run(format!(
                "INSERT INTO shop.orders (customer, id, total, tags, ship, note) VALUES ('c{}', {i}, {}.5, {{'a','it''s'}}, {{street: 'Main {i}', geo: {{x: 1.5, y: 2}}}}, 'vip {}')",
                i % 40,
                i,
                i % 40
            ))
            .await;
        }
        run(c2("UPDATE shop.views SET hits = hits + 3 WHERE page = 'home'")).await;

        let dest = tmp("shop.cql");
        let out = run_backup(&state, "cass".into(), dest.clone(), opts(|o| o.database = Some("shop".into()))).await.unwrap();
        assert_eq!(out.items, Some(1200), "every row, counters skipped");
        assert!(out.notes.iter().any(|n| n.contains("counter table views")), "{:?}", out.notes);
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.contains("note text static"), "static column kept in the DDL");
        // UDTs in dependency order
        assert!(text.find("CREATE TYPE IF NOT EXISTS shop.point").unwrap() < text.find("CREATE TYPE IF NOT EXISTS shop.address").unwrap());

        run(c2("DROP KEYSPACE shop")).await;
        let r = run_restore(&state, "cass".into(), dest.clone(), None).await.unwrap();
        assert!(r.items.unwrap() > 1200);

        let rows = run(c2("SELECT count(*) AS n FROM shop.orders")).await;
        assert_eq!(n(&rows[0], "n"), 1200);
        let rows = run(c2("SELECT note, ship, tags, total FROM shop.orders WHERE customer = 'c7' AND id = 7")).await;
        assert_eq!(rows[0]["note"], "vip 7");
        assert!(rows[0]["ship"].to_string().contains("Main 7"), "{}", rows[0]["ship"]);
        assert!(rows[0]["tags"].to_string().contains("it's"));
        // the secondary index came back (a query on it works)
        let rows = run(c2("SELECT id FROM shop.orders WHERE total = 7.5")).await;
        assert_eq!(rows.len(), 1);
        // running the same backup again over the existing keyspace is harmless (IF NOT EXISTS)
        run_restore(&state, "cass".into(), dest, None).await.unwrap();
    })
}

#[test]
fn mssql_restore_works_while_the_app_is_connected_to_that_database() {
    on_big_stack(async move {
        let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
            .with_exposed_port(1433.tcp())
            .with_env_var("ACCEPT_EULA", "Y")
            .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
            .start()
            .await
            .expect("start mssql");
        let port = c.get_host_port_ipv4(1433).await.unwrap();
        let state = app_state();
        let mut setup = profile("ms-setup", SystemType::Mssql, port, "master", "sa");
        setup.mssql_auth = "sql".into();
        connect(&state, setup.clone(), MSSQL_PASS).await;
        exec(&state, "ms-setup", "CREATE DATABASE bkp").await;
        exec(&state, "ms-setup", "CREATE TABLE bkp.dbo.t (id int PRIMARY KEY)").await;
        exec(&state, "ms-setup", "INSERT INTO bkp.dbo.t VALUES (1), (2)").await;
        state.registry.disconnect("ms-setup").await.unwrap();

        // the app's connection sits IN bkp — RESTORE used to fail: no exclusive access
        let mut p = setup;
        p.id = "ms".into();
        p.database = "bkp".into();
        connect(&state, p, MSSQL_PASS).await;

        let plan = plan_for(&state, "ms".into(), None, None).await.unwrap();
        assert_eq!(plan.method, "server");
        assert!(plan.server_side && plan.backup_ready);

        let bak = "/var/opt/mssql/data/bkp_it.bak";
        let out = run_backup(&state, "ms".into(), bak.into(), None).await.unwrap();
        assert!(out.server_side);
        assert!(out.bytes.unwrap_or(0) > 0, "size read back from msdb");
        // the backup shows up in "recent backups" for the Restore tab
        let plan = plan_for(&state, "ms".into(), None, None).await.unwrap();
        assert!(plan.recent.iter().any(|r| r.path == bak), "{:?}", plan.recent.iter().map(|r| &r.path).collect::<Vec<_>>());

        exec(&state, "ms", "INSERT INTO dbo.t VALUES (3)").await;
        run_restore(&state, "ms".into(), bak.into(), None).await.unwrap();

        // the app's own connection was healed and sees the restored data
        let r = exec(&state, "ms", "SELECT count(*) AS n FROM dbo.t").await;
        assert_eq!(n(&r[0], "n"), 2);
        // and the database is usable by others again (MULTI_USER)
        let r = exec(&state, "ms", "SELECT user_access_desc AS a FROM sys.databases WHERE name = 'bkp'").await;
        assert_eq!(r[0]["a"], "MULTI_USER");

        // a failing restore leaves the database MULTI_USER too
        let err = run_restore(&state, "ms".into(), "/var/opt/mssql/data/missing.bak".into(), None).await;
        assert!(err.is_err());
        let r = exec(&state, "ms", "SELECT user_access_desc AS a FROM sys.databases WHERE name = 'bkp'").await;
        assert_eq!(r[0]["a"], "MULTI_USER", "never left SINGLE_USER after a failure");
    })
}

const CH_BACKUP_DISK: &str = r#"<clickhouse>
  <storage_configuration><disks><backups><type>local</type><path>/var/lib/clickhouse/backups/</path></backups></disks></storage_configuration>
  <backups><allowed_disk>backups</allowed_disk><allowed_path>/var/lib/clickhouse/backups/</allowed_path></backups>
</clickhouse>"#;

#[test]
fn clickhouse_native_backup_and_restore_on_a_backup_disk() {
    on_big_stack(async move {
        let c = GenericImage::new("clickhouse/clickhouse-server", "24.8")
            .with_exposed_port(8123.tcp())
            .with_env_var("CLICKHOUSE_PASSWORD", PASS)
            .with_copy_to("/etc/clickhouse-server/config.d/backups.xml", CH_BACKUP_DISK.as_bytes().to_vec())
            .start()
            .await
            .expect("start clickhouse");
        let port = c.get_host_port_ipv4(8123).await.unwrap();
        let state = app_state();
        connect(&state, profile("ch", SystemType::Clickhouse, port, "default", "default"), PASS).await;
        exec(&state, "ch", "CREATE DATABASE app").await;
        exec(&state, "ch", "CREATE TABLE app.ev (id UInt64, v String) ENGINE = MergeTree ORDER BY id").await;
        exec(&state, "ch", "INSERT INTO app.ev SELECT number, toString(number) FROM numbers(5000)").await;

        let plan = plan_for(&state, "ch".into(), Some("app".into()), None).await.unwrap();
        assert!(plan.disks.contains(&"backups".to_string()), "{:?}", plan.disks);
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);

        // a client-looking path is reduced to the file name the disk stores
        let out = run_backup(&state, "ch".into(), "C:\\Users\\me\\app_it.zip".into(), opts(|o| {
            o.database = Some("app".into());
            o.disk = Some("backups".into());
        }))
        .await
        .unwrap();
        assert_eq!(out.path, "Disk('backups', 'app_it.zip')");

        // restore under another name, then over the original with "drop first"
        run_restore(&state, "ch".into(), "app_it.zip".into(), opts(|o| {
            o.database = Some("app".into());
            o.as_database = Some("app_copy".into());
        }))
        .await
        .unwrap();
        let r = exec(&state, "ch", "SELECT count() AS n FROM app_copy.ev").await;
        assert_eq!(n(&r[0], "n"), 5000);

        // damage it but keep rows in it: ClickHouse restores into an EMPTY existing
        // table, and refuses one that still holds data unless "drop first" is on
        exec(&state, "ch", "ALTER TABLE app.ev DELETE WHERE id >= 10 SETTINGS mutations_sync = 2").await;
        let r = exec(&state, "ch", "SELECT count() AS n FROM app.ev").await;
        assert!(n(&r[0], "n") > 0 && n(&r[0], "n") < 5000);
        let refused = run_restore(&state, "ch".into(), "app_it.zip".into(), opts(|o| o.database = Some("app".into()))).await;
        assert!(refused.is_err(), "restore over a non-empty table without drop-first must be refused");
        run_restore(&state, "ch".into(), "app_it.zip".into(), opts(|o| {
            o.database = Some("app".into());
            o.clean = Some(true);
        }))
        .await
        .unwrap();
        let r = exec(&state, "ch", "SELECT count() AS n FROM app.ev").await;
        assert_eq!(n(&r[0], "n"), 5000);
    })
}

/// The client tools SHIPPED WITH THE APP (src-tauri/resources/tools, filled by
/// `npm run tools:fetch`) run the dialog's whole round trip on real servers with
/// nothing installed on this computer: the plan must pick the bundled copy,
/// then back up → damage → restore → count again.
#[test]
fn bundled_tools_back_up_and_restore_without_any_install() {
    on_big_stack(async move {
        use database_studio_lib::drivers::bundled_tools::{bundled_bin_dirs, manifests_in, resource_roots};
        let shipped: Vec<_> = resource_roots().iter().flat_map(|r| manifests_in(r)).collect();
        assert!(
            shipped.len() >= 3,
            "no bundled tools in src-tauri/resources/tools — run `npm run tools:fetch` first (found {:?}, dirs {:?})",
            shipped.iter().map(|(m, _)| &m.version).collect::<Vec<_>>(),
            bundled_bin_dirs()
        );

        // Asserts the dialog would run the copy shipped inside the installer.
        async fn assert_bundled(state: &AppState, id: &str) {
            let plan = plan_for(state, id.into(), None, None).await.unwrap();
            let b = plan.backup_tool.as_ref().expect("backup tool");
            assert!(b.found && b.bundled, "{id}: backup tool is not the bundled copy: {:?} {:?}", b.path, b.version);
            assert!(plan.restore_tools.iter().any(|t| t.found && t.bundled), "{id}: no bundled restore tool");
            assert!(plan.backup_ready && plan.restore_ready, "{id}: plan not ready: {:?}", plan.warnings);
            eprintln!("CHK {id}: {} ({})", b.version.clone().unwrap_or_default(), b.path.clone().unwrap_or_default());
        }

        // ---- PostgreSQL 16 server, bundled pg_dump 18 (a newer client is fine) --
        {
            let c = GenericImage::new("postgres", "16-alpine")
                .with_exposed_port(5432.tcp())
                .with_env_var("POSTGRES_PASSWORD", PASS)
                .with_env_var("POSTGRES_DB", "testdb")
                .start()
                .await
                .unwrap();
            let port = c.get_host_port_ipv4(5432).await.unwrap();
            let state = app_state();
            connect(&state, profile("pg", SystemType::Postgres, port, "testdb", "postgres"), PASS).await;
            exec(&state, "pg", "CREATE TABLE bk (id int PRIMARY KEY, v text)").await;
            exec(&state, "pg", "INSERT INTO bk SELECT g, 'v' || g FROM generate_series(1, 3000) g").await;
            exec(&state, "pg", "CREATE VIEW bk_v AS SELECT id FROM bk WHERE id % 2 = 0").await;
            assert_bundled(&state, "pg").await;
            for format in ["plain", "custom"] {
                let dest = tmp(&format!("bundled-pg.{}", if format == "plain" { "sql" } else { "dump" }));
                run_backup(&state, "pg".into(), dest.clone(), opts(|o| {
                    o.format = Some(format.into());
                    o.clean = Some(true);
                }))
                .await
                .unwrap();
                exec(&state, "pg", "DELETE FROM bk WHERE id > 10").await;
                run_restore(&state, "pg".into(), dest, opts(|o| o.clean = Some(true))).await.unwrap();
                assert_eq!(n(&exec(&state, "pg", "SELECT count(*) AS n FROM bk").await[0], "n"), 3000, "{format}");
                assert_eq!(n(&exec(&state, "pg", "SELECT count(*) AS n FROM bk_v").await[0], "n"), 1500, "{format} view");
            }
            eprintln!("CHK postgres: bundled pg_dump / pg_restore / psql round trip OK");
        }

        // ---- MySQL 8 (caching_sha2_password + TLS) with the bundled MariaDB tools
        {
            let c = GenericImage::new("mysql", "8.0")
                .with_exposed_port(3306.tcp())
                .with_env_var("MYSQL_ROOT_PASSWORD", PASS)
                .with_env_var("MYSQL_DATABASE", "testdb")
                .start()
                .await
                .unwrap();
            let port = c.get_host_port_ipv4(3306).await.unwrap();
            let state = app_state();
            connect(&state, profile("my", SystemType::Mysql, port, "testdb", "root"), PASS).await;
            exec(&state, "my", "CREATE TABLE bk (id int PRIMARY KEY, v varchar(40))").await;
            exec(&state, "my", "INSERT INTO bk VALUES (1,'a'),(2,'Nguyễn'),(3,'c')").await;
            assert_bundled(&state, "my").await;
            let dest = tmp("bundled-my.sql");
            run_backup(&state, "my".into(), dest.clone(), opts(|_| {})).await.unwrap();
            exec(&state, "my", "DELETE FROM bk").await;
            run_restore(&state, "my".into(), dest, opts(|_| {})).await.unwrap();
            let r = exec(&state, "my", "SELECT count(*) AS n, MAX(CASE WHEN id = 2 THEN v END) AS name FROM bk").await;
            assert_eq!(n(&r[0], "n"), 3);
            assert_eq!(r[0]["name"], "Nguyễn", "utf8 survives the round trip");
            eprintln!("CHK mysql 8: bundled mariadb-dump / mariadb round trip OK");
        }

        // ---- MariaDB 11 --------------------------------------------------------
        {
            let c = GenericImage::new("mariadb", "11")
                .with_exposed_port(3306.tcp())
                .with_env_var("MARIADB_ROOT_PASSWORD", PASS)
                .with_env_var("MARIADB_DATABASE", "testdb")
                .start()
                .await
                .unwrap();
            let port = c.get_host_port_ipv4(3306).await.unwrap();
            let state = app_state();
            connect(&state, profile("ma", SystemType::Mariadb, port, "testdb", "root"), PASS).await;
            exec(&state, "ma", "CREATE TABLE bk (id int PRIMARY KEY, v varchar(20))").await;
            exec(&state, "ma", "INSERT INTO bk SELECT seq, CONCAT('v', seq) FROM seq_1_to_2000").await;
            assert_bundled(&state, "ma").await;
            let dest = tmp("bundled-ma.sql");
            run_backup(&state, "ma".into(), dest.clone(), opts(|_| {})).await.unwrap();
            exec(&state, "ma", "DELETE FROM bk WHERE id > 5").await;
            run_restore(&state, "ma".into(), dest, opts(|_| {})).await.unwrap();
            assert_eq!(n(&exec(&state, "ma", "SELECT count(*) AS n FROM bk").await[0], "n"), 2000);
            eprintln!("CHK mariadb: bundled mariadb-dump / mariadb round trip OK");
        }

        // ---- MongoDB 7 ---------------------------------------------------------
        {
            let c = GenericImage::new("mongo", "7").with_exposed_port(27017.tcp()).start().await.unwrap();
            let port = c.get_host_port_ipv4(27017).await.unwrap();
            let state = app_state();
            connect(&state, profile("mo", SystemType::Mongodb, port, "testdb", ""), "").await;
            let docs: Vec<String> = (1..=800).map(|i| format!("{{\"n\":{i},\"tag\":\"t{}\"}}", i % 7)).collect();
            exec(&state, "mo", &format!("db.items.insertMany([{}])", docs.join(","))).await;
            assert_bundled(&state, "mo").await;
            let dest = tmp("bundled-mo.archive.gz");
            run_backup(&state, "mo".into(), dest.clone(), opts(|o| o.format = Some("gzip".into()))).await.unwrap();
            exec(&state, "mo", "db.items.deleteMany({\"n\": {\"$gt\": 10}})").await;
            run_restore(&state, "mo".into(), dest, opts(|o| o.clean = Some(true))).await.unwrap();
            let r = exec(&state, "mo", "db.items.countDocuments({})").await;
            let count = r
                .first()
                .and_then(|row| row.as_object())
                .and_then(|o| o.values().find_map(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))))
                .unwrap_or_else(|| panic!("count rows: {r:?}"));
            assert_eq!(count, 800);
            eprintln!("CHK mongodb: bundled mongodump / mongorestore round trip OK");
        }
    })
}

/// SQL Server to and from THIS computer: a .bacpac written and read by the
/// SqlPackage shipped with the app (nothing installed here) — schema with a
/// view and a foreign key, Unicode data; import as a copy, then over the
/// original with "drop first" while the app is connected to it.
#[test]
fn mssql_bacpac_export_and_import_with_the_bundled_sqlpackage() {
    on_big_stack(async move {
        let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
            .with_exposed_port(1433.tcp())
            .with_env_var("ACCEPT_EULA", "Y")
            .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
            .start()
            .await
            .expect("start mssql");
        let port = c.get_host_port_ipv4(1433).await.unwrap();
        let state = app_state();
        let mut setup = profile("msb-setup", SystemType::Mssql, port, "master", "sa");
        setup.mssql_auth = "sql".into();
        connect(&state, setup.clone(), MSSQL_PASS).await;
        exec(&state, "msb-setup", "CREATE DATABASE shop").await;
        state.registry.disconnect("msb-setup").await.unwrap();

        let mut p = setup;
        p.id = "msb".into();
        p.database = "shop".into();
        connect(&state, p, MSSQL_PASS).await;
        exec(&state, "msb", "CREATE TABLE dbo.cust (id int PRIMARY KEY, name nvarchar(50) NOT NULL)").await;
        exec(&state, "msb", "CREATE TABLE dbo.ord (id int PRIMARY KEY, cust int NOT NULL REFERENCES dbo.cust(id), total decimal(10,2))").await;
        exec(&state, "msb", "INSERT INTO dbo.cust VALUES (1, N'Nguyễn Văn A'), (2, N'Trần B'), (3, N'Lê C')").await;
        exec(&state, "msb", "INSERT INTO dbo.ord SELECT v.n, 1 + v.n % 3, v.n * 1.5 FROM (SELECT TOP 500 ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS n FROM sys.all_objects) v").await;
        exec(&state, "msb", "CREATE VIEW dbo.big_orders AS SELECT id, total FROM dbo.ord WHERE total > 300").await;

        // the plan offers the bundled SqlPackage next to the server-side .bak
        let plan = plan_for(&state, "msb".into(), None, None).await.unwrap();
        assert!(plan.server_side, ".bak stays the server-side default");
        let sp = plan.backup_tool.as_ref().expect("sqlpackage in the plan");
        assert!(sp.found && sp.bundled, "SqlPackage must be the bundled copy: {:?}", sp.path);
        assert!(!plan.local_dir.is_empty() && plan.local_dir != plan.default_dir, "local folder ≠ server folder");
        eprintln!("CHK sqlpackage {} ({})", sp.version.clone().unwrap_or_default(), sp.path.clone().unwrap_or_default());

        // export to this computer (a folder with a space in its name)
        let dir = std::env::temp_dir().join(format!("ds bacpac {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("shop.bacpac").to_string_lossy().to_string();
        let out = run_backup(&state, "msb".into(), file.clone(), opts(|o| o.format = Some("bacpac".into()))).await.unwrap();
        assert!(!out.server_side, "a .bacpac is a file on this computer");
        assert!(out.bytes.unwrap_or(0) > 1000, "bacpac written: {:?}", out.bytes);
        eprintln!("CHK exported {} bytes to {file}", out.bytes.unwrap_or(0));

        // import as a copy
        run_restore(&state, "msb".into(), file.clone(), opts(|o| o.as_database = Some("shop_copy".into()))).await.unwrap();
        let r = exec(&state, "msb", "SELECT (SELECT count(*) FROM shop_copy.dbo.ord) AS o, (SELECT count(*) FROM shop_copy.dbo.big_orders) AS v, (SELECT name FROM shop_copy.dbo.cust WHERE id = 1) AS nm").await;
        assert_eq!(n(&r[0], "o"), 500);
        assert_eq!(n(&r[0], "v"), 300, "view came along");
        assert_eq!(r[0]["nm"], "Nguyễn Văn A", "Unicode survives");

        // importing over a database that has tables is refused without "drop first"
        let refused = run_restore(&state, "msb".into(), file.clone(), opts(|_| {})).await;
        assert!(refused.is_err(), "SqlPackage imports only into a new or empty database");

        // damage the original, then import over it with "drop first" — while the
        // app's own connection sits in that database
        exec(&state, "msb", "DELETE FROM dbo.ord WHERE id > 10").await;
        run_restore(&state, "msb".into(), file.clone(), opts(|o| o.clean = Some(true))).await.unwrap();
        let r = exec(&state, "msb", "SELECT count(*) AS n FROM dbo.ord").await;
        assert_eq!(n(&r[0], "n"), 500, "the app's connection was healed and sees the imported data");
        let r = exec(&state, "msb", "SELECT count(*) AS n FROM sys.foreign_keys WHERE parent_object_id = OBJECT_ID('dbo.ord')").await;
        assert_eq!(n(&r[0], "n"), 1, "foreign key came along");
        let _ = std::fs::remove_dir_all(&dir);
        eprintln!("CHK mssql: bundled SqlPackage .bacpac export / import OK");
    })
}

/// What pg_dump prints per table depends on the format and the content: the
/// dialog's progress must count by that line, to the total it really reaches, in
/// every combination — measured on a real server with a partitioned table (whose
/// parent has no rows of its own) next to plain ones.
#[test]
fn pg_dump_progress_counts_to_the_end_in_every_mode() {
    on_big_stack(async move {
        use database_studio_lib::commands::backup::{set_progress_sink, BackupProgress};
        use std::sync::{Arc, Mutex};
        let c = GenericImage::new("postgres", "16-alpine")
            .with_exposed_port(5432.tcp())
            .with_env_var("POSTGRES_PASSWORD", PASS)
            .with_env_var("POSTGRES_DB", "testdb")
            .start()
            .await
            .unwrap();
        let port = c.get_host_port_ipv4(5432).await.unwrap();
        let state = app_state();
        connect(&state, profile("pgp", SystemType::Postgres, port, "testdb", "postgres"), PASS).await;
        for i in 1..=4 {
            exec(&state, "pgp", &format!("CREATE TABLE t_{i} (id int PRIMARY KEY, v text)")).await;
            exec(&state, "pgp", &format!("INSERT INTO t_{i} VALUES (1, 'a')")).await;
        }
        exec(&state, "pgp", "CREATE TABLE p (id int, v text) PARTITION BY RANGE (id)").await;
        exec(&state, "pgp", "CREATE TABLE p1 PARTITION OF p FOR VALUES FROM (0) TO (10)").await;
        exec(&state, "pgp", "CREATE TABLE p2 PARTITION OF p FOR VALUES FROM (10) TO (20)").await;
        exec(&state, "pgp", "INSERT INTO p VALUES (1, 'x'), (15, 'y')").await;
        exec(&state, "pgp", "CREATE VIEW v1 AS SELECT id FROM t_1").await;
        // 4 plain + 1 parent + 2 partitions = 7 tables; 6 of them hold rows
        for (format, content, expect) in [
            ("plain", "schema", Some(7)),
            ("plain", "all", Some(6)),
            ("plain", "data", Some(6)),
            ("custom", "all", Some(6)),
            ("custom", "data", Some(6)),
            ("custom", "schema", None), // names no table: counted by pg_dump's catalog steps
        ] {
            let job = format!("pgp-{format}-{content}");
            let seen: Arc<Mutex<Vec<BackupProgress>>> = Arc::default();
            let s2 = seen.clone();
            set_progress_sink(&job, move |p| s2.lock().unwrap().push(p));
            let dest = tmp(&format!("pgp-{format}-{content}.{}", if format == "plain" { "sql" } else { "dump" }));
            run_backup(&state, "pgp".into(), dest, opts(|o| {
                o.format = Some(format.into());
                o.content = Some(content.into());
                o.job_id = Some(job.clone());
            }))
            .await
            .unwrap_or_else(|e| panic!("{format}/{content}: {e:?}"));
            let ev = seen.lock().unwrap().clone();
            let last = ev.iter().rev().find(|p| p.stage == "Backing up" || p.stage == "Reading the catalog").expect("a backup stage");
            match expect {
                Some(n) => {
                    assert_eq!(last.total, Some(n), "{format}/{content}: total");
                    assert_eq!(last.done, n, "{format}/{content}: counted to the end ({ev:?})");
                    assert!(ev.iter().any(|p| p.current.is_some()), "{format}/{content}: never named a table");
                }
                None => {
                    // a real percent all the way: steps out of a total, settled at the end
                    assert_eq!(last.unit, "steps", "{format}/{content}");
                    assert!(last.done >= 30, "{format}/{content}: too few steps seen ({ev:?})");
                    assert_eq!(last.total, Some(last.done), "{format}/{content}: total settles at the steps done");
                    let mid = ev.iter().filter(|p| p.unit == "steps" && p.done > 0 && p.done < last.done).count();
                    assert!(mid > 0 || ev.len() > 2, "{format}/{content}: the percent never moved ({ev:?})");
                    assert!(ev.iter().any(|p| p.current.as_deref().is_some_and(|c| c.starts_with("reading"))), "{format}/{content}: no step named");
                }
            }
            eprintln!("CHK pg_dump {format}/{content}: {:?}/{:?} over {} events", last.done, last.total, ev.len());
        }

        // The connection sits in testdb; the dialog backs up ANOTHER database. The
        // total must be that database's tables — counting in testdb said "0 of 0".
        exec(&state, "pgp", "CREATE DATABASE other").await;
        connect(&state, profile("pgp-other", SystemType::Postgres, port, "other", "postgres"), PASS).await;
        for i in 1..=9 {
            exec(&state, "pgp-other", &format!("CREATE TABLE o_{i} (id int PRIMARY KEY)")).await;
            exec(&state, "pgp-other", &format!("INSERT INTO o_{i} VALUES (1)")).await;
        }
        let job = "pgp-other-db".to_string();
        let seen: Arc<Mutex<Vec<BackupProgress>>> = Arc::default();
        let s2 = seen.clone();
        set_progress_sink(&job, move |p| s2.lock().unwrap().push(p));
        run_backup(&state, "pgp".into(), tmp("pgp-other.sql"), opts(|o| {
            o.database = Some("other".into());
            o.content = Some("all".into());
            o.job_id = Some(job.clone());
        }))
        .await
        .unwrap();
        let ev = seen.lock().unwrap().clone();
        let last = ev.iter().rev().find(|p| p.stage == "Backing up").expect("backing up");
        assert_eq!(last.total, Some(9), "the total is the backed-up database's, not the connection's ({ev:?})");
        assert_eq!(last.done, 9);
        assert!(ev.iter().any(|p| p.current.as_deref().is_some_and(|c| c.contains("o_"))));
        eprintln!("CHK pg_dump other database: {}/{:?}", last.done, last.total);
    })
}
