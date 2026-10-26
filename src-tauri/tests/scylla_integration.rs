//! ScyllaDB = a flavor of the Cassandra engine (SPEC-SCYLLADB.md). Every check
//! runs against a real `scylladb/scylla:6.2` container and goes through the
//! same code the app uses (registry + LiveConnection + backup commands). Data is
//! seeded first and read back — nothing is hard-coded.
//!
//! Run (one at a time — they map fixed host ports):
//!   cargo test --test scylla_integration --no-run
//!   timeout 900 cargo test --test scylla_integration -- --nocapture --test-threads=1

use std::time::{Duration, Instant};

use database_studio_lib::commands::backup::{run_backup, run_restore};
use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
use database_studio_lib::connections::registry::Registry;
use database_studio_lib::drivers::backup_tools::BackupOptions;
use database_studio_lib::drivers::cassandra::{
    CassFlavor, CassKeyspaceTree, CassServerInfo, CassandraConnParams, CassandraDriver, RingNode,
};
use database_studio_lib::drivers::types::{PartitionInfo, StatementOutcome, SystemType};
use database_studio_lib::drivers::LiveConnection;
use database_studio_lib::state::AppState;
use database_studio_lib::storage::Storage;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

const IMAGE: &str = "scylladb/scylla";
const TAG: &str = "6.2";

/// Backup futures nest deeply — debug builds overflow tokio's default 2 MB stack.
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

/// A single small node. The node advertises 127.0.0.1 and both CQL ports are
/// mapped 1:1, so the driver (which follows the topology and opens the
/// shard-aware port 19042) reaches it from the host exactly like the app does.
async fn start_scylla(auth: bool) -> ContainerAsync<GenericImage> {
    let mut cmd: Vec<String> = [
        "--smp", "1", "--memory", "750M", "--overprovisioned", "1", "--developer-mode", "1",
        "--broadcast-rpc-address", "127.0.0.1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if auth {
        for s in ["--authenticator", "PasswordAuthenticator", "--authorizer", "CassandraAuthorizer"] {
            cmd.push(s.into());
        }
    }
    GenericImage::new(IMAGE, TAG)
        .with_exposed_port(9042.tcp())
        .with_exposed_port(19042.tcp())
        .with_mapped_port(9042, 9042.tcp())
        .with_mapped_port(19042, 19042.tcp())
        .with_cmd(cmd)
        .start()
        .await
        .expect("start scylla (Docker must be running; host ports 9042/19042 free)")
}

static STORE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn app_state() -> AppState {
    AppState {
        storage: Storage::open(std::env::temp_dir().join(format!(
            "ds-scylla-it-store-{}-{}",
            std::process::id(),
            STORE.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        )))
        .unwrap(),
        registry: Registry::default(),
        pubsub: Default::default(),
        kafka_stops: Default::default(),
        test_cancels: Default::default(),
        export_cancels: Default::default(),
    }
}

fn profile(id: &str, user: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.into(),
        name: id.into(),
        system: SystemType::Cassandra,
        host: "127.0.0.1".into(),
        port: 9042,
        database: String::new(),
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
        cassandra_consistency: "ONE".into(),
        cassandra_flavor: String::new(),
        admin_url: String::new(),
    }
}

fn params(user: &str, password: &str) -> CassandraConnParams {
    CassandraConnParams {
        contact_points: vec!["127.0.0.1:9042".into()],
        user: user.into(),
        password: password.into(),
        datacenter: "datacenter1".into(),
        consistency: "ONE".into(),
        keyspace: String::new(),
        ssl: false,
        ssl_ca: String::new(),
    }
}

/// Connect through the registry (the app's path) once the node answers CQL.
async fn connect(state: &AppState, p: ConnectionProfile, password: &str) {
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match state.registry.connect(p.clone(), password.into(), String::new()).await {
            Ok(_) => return,
            Err(e) => {
                assert!(Instant::now() < deadline, "connect {} timed out: {e:?}", p.id);
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    }
}

/// Run `f` against the live Cassandra-engine driver of connection `id`.
async fn with_cass<T: Send + 'static, F, Fut>(state: &AppState, id: &str, f: F) -> T
where
    F: FnOnce(std::sync::Arc<tokio::sync::Mutex<LiveConnection>>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = T> + Send,
{
    state
        .registry
        .with_driver(id, move |d| async move { Ok::<T, database_studio_lib::error::QueryError>(f(d).await) })
        .await
        .expect("connection present")
        .expect("infallible")
}

async fn cql(state: &AppState, id: &str, s: &str) -> Result<Vec<serde_json::Value>, String> {
    let s2 = s.to_string();
    let r = with_cass(state, id, move |d| async move {
        let g = d.lock().await;
        match &*g {
            LiveConnection::Cassandra(c) => c.exec_cql(&s2, Some(5000), None).await,
            _ => unreachable!(),
        }
    })
    .await;
    match r {
        Ok(o) => Ok(match o.outcome {
            StatementOutcome::Rows { result } => result.rows,
            _ => Vec::new(),
        }),
        Err(e) => Err(e.message),
    }
}

fn num(v: &serde_json::Value) -> i64 {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or_else(|| panic!("not a number: {v}"))
}

async fn info(state: &AppState, id: &str) -> CassServerInfo {
    with_cass(state, id, |d| async move {
        match &*d.lock().await {
            LiveConnection::Cassandra(c) => c.server_info().clone(),
            _ => unreachable!(),
        }
    })
    .await
}

async fn tree(state: &AppState, id: &str, ks: &str) -> CassKeyspaceTree {
    let ks = ks.to_string();
    with_cass(state, id, move |d| async move {
        match &*d.lock().await {
            LiveConnection::Cassandra(c) => c.keyspace_tree(&ks).await.expect("keyspace tree"),
            _ => unreachable!(),
        }
    })
    .await
}

async fn ddl(state: &AppState, id: &str, ks: &str, kind: &str, name: &str) -> String {
    let (ks, kind, name) = (ks.to_string(), kind.to_string(), name.to_string());
    with_cass(state, id, move |d| async move {
        match &*d.lock().await {
            LiveConnection::Cassandra(c) => c.object_ddl(&ks, &kind, &name).await.expect("object ddl"),
            _ => unreachable!(),
        }
    })
    .await
}

fn opts(database: &str) -> Option<BackupOptions> {
    let mut o = BackupOptions::default();
    o.database = Some(database.into());
    Some(o)
}

fn tmp(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("ds-scylla-it-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name).to_string_lossy().to_string()
}

#[test]
fn scylla_is_detected_and_every_cassandra_feature_works_on_it() {
    on_big_stack(async move {
        let _c = start_scylla(false).await;
        let state = app_state();
        connect(&state, profile("sc", ""), "").await;
        // the node may accept the session before schema changes are allowed — retry
        let deadline = Instant::now() + Duration::from_secs(240);
        while let Err(e) = cql(
            &state,
            "sc",
            "CREATE KEYSPACE IF NOT EXISTS vn WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':1} AND tablets = {'enabled': false}",
        )
        .await
        {
            assert!(Instant::now() < deadline, "scylla not ready: {e}");
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        let st = &state;
        let run = |s: String| async move { cql(st, "sc", &s).await.unwrap_or_else(|e| panic!("{s}: {e}")) };

        // ---- S1: detection (P1) ------------------------------------------------
        let i = info(&state, "sc").await;
        assert_eq!(i.flavor, CassFlavor::Scylla, "{i:?}");
        assert!(i.version.starts_with("6."), "real version, not the compat 3.0.8: {}", i.version);
        assert_eq!(i.tablets_enabled, Some(true), "6.2 enables tablets by default");
        let t = CassandraDriver::test(&params("", "")).await;
        assert!(t.ok, "{:?}", t.error);
        let label = t.server_version.unwrap_or_default();
        assert!(label.starts_with("ScyllaDB 6."), "{label}");
        eprintln!("CHK detection: {label}");

        // ---- seed: vnodes keyspace (CDC/counters/LWT) + two tablets keyspaces ----
        run("CREATE KEYSPACE tb WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':1}".into()).await;
        run("CREATE KEYSPACE t8 WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':1} AND tablets = {'initial': 8}".into()).await;
        run("CREATE TYPE vn.addr (street text, city text)".into()).await;
        run("CREATE TABLE vn.orders (id int PRIMARY KEY, name text, total decimal, ship frozen<addr>) WITH cdc = {'enabled': true}".into()).await;
        run("CREATE TABLE vn.hits (page text PRIMARY KEY, n counter)".into()).await;
        run("CREATE INDEX orders_name ON vn.orders (name)".into()).await;
        run("CREATE MATERIALIZED VIEW vn.orders_by_name AS SELECT * FROM vn.orders WHERE name IS NOT NULL AND id IS NOT NULL PRIMARY KEY (name, id)".into()).await;
        for i in 0..50 {
            run(format!(
                "INSERT INTO vn.orders (id, name, total, ship) VALUES ({i}, 'n{}', {i}.5, {{street: 'Main {i}', city: 'HN'}})",
                i % 5
            ))
            .await;
        }
        run("UPDATE vn.hits SET n = n + 3 WHERE page = 'home'".into()).await;
        // LWT works on the vnodes keyspace, and is refused (with ScyllaDB's own words) on tablets
        run("INSERT INTO vn.orders (id, name) VALUES (1000, 'lwt') IF NOT EXISTS".into()).await;
        run("CREATE TABLE tb.items (id int PRIMARY KEY, v text)".into()).await;
        let lwt = cql(&state, "sc", "INSERT INTO tb.items (id, v) VALUES (1, 'x') IF NOT EXISTS").await;
        assert!(lwt.as_ref().err().is_some_and(|e| e.to_lowercase().contains("tablets")), "{lwt:?}");

        // ---- S1: system keyspaces hidden (P2) -----------------------------------
        let kss: Vec<String> = with_cass(&state, "sc", |d| async move {
            match &*d.lock().await {
                LiveConnection::Cassandra(c) => c.keyspaces().await.unwrap(),
                _ => unreachable!(),
            }
        })
        .await;
        assert!(kss.iter().all(|k| !k.starts_with("system")), "{kss:?}");
        assert!(["vn", "tb", "t8"].iter().all(|k| kss.contains(&k.to_string())), "{kss:?}");

        // ---- S2: tree (P3 index views hidden, P4 CDC log tagged, P5 tablets) ----
        let tr = tree(&state, "sc", "vn").await;
        let views: Vec<&str> = tr.views.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(views, ["orders_by_name"], "the view backing index orders_name is hidden");
        assert_eq!(tr.indexes.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["orders_name"]);
        let log = tr.tables.iter().find(|t| t.name == "orders_scylla_cdc_log").expect("cdc log listed");
        assert_eq!(log.cdc_of.as_deref(), Some("orders"));
        assert!(tr.tables.iter().filter(|t| t.name != log.name).all(|t| t.cdc_of.is_none()));
        assert_eq!(tr.tablets.as_deref(), Some("vnodes"));
        assert_eq!(tree(&state, "sc", "tb").await.tablets.as_deref(), Some("tablets"));
        assert_eq!(tree(&state, "sc", "t8").await.tablets.as_deref(), Some("tablets · initial 8"));
        eprintln!("CHK tree");

        // ---- S2: DDL from the server's DESCRIBE (P6) ------------------------------
        let t_ddl = ddl(&state, "sc", "vn", "table", "orders").await;
        assert!(t_ddl.contains("CREATE TABLE vn.orders"), "{t_ddl}");
        assert!(t_ddl.contains("cdc = {"), "options kept: {t_ddl}");
        assert!(ddl(&state, "sc", "vn", "index", "orders_name").await.contains("CREATE INDEX orders_name"));
        assert!(ddl(&state, "sc", "vn", "view", "orders_by_name").await.contains("CREATE MATERIALIZED VIEW vn.orders_by_name"));
        assert!(ddl(&state, "sc", "vn", "type", "addr").await.contains("CREATE TYPE vn.addr"));
        eprintln!("CHK describe");

        // ---- S2: ring from system.cluster_status (P7) ------------------------------
        let ring: Vec<RingNode> = with_cass(&state, "sc", |d| async move {
            match &*d.lock().await {
                LiveConnection::Cassandra(c) => c.ring().await.unwrap(),
                _ => unreachable!(),
            }
        })
        .await;
        assert_eq!(ring.len(), 1, "{ring:?}");
        assert_eq!(ring[0].state, "UN");
        assert!(ring[0].version.starts_with("6."), "{:?}", ring[0]);
        assert!(!ring[0].load.contains("tokens"), "real load, not a token count: {:?}", ring[0]);
        assert!(ring[0].owns.ends_with('%'), "{:?}", ring[0]);
        eprintln!("CHK ring {:?}", ring[0]);

        // ---- S6 parity: paging, consistency, warnings ------------------------------
        let page1 = with_cass(&state, "sc", |d| async move {
            match &*d.lock().await {
                LiveConnection::Cassandra(c) => c.exec_cql("SELECT id FROM vn.orders", Some(20), None).await.unwrap(),
                _ => unreachable!(),
            }
        })
        .await;
        let token = page1.next_page.clone().expect("51 rows at 20/page → a next page");
        let page2 = with_cass(&state, "sc", move |d| async move {
            match &*d.lock().await {
                LiveConnection::Cassandra(c) => c.exec_cql("SELECT id FROM vn.orders", Some(20), Some(&token)).await.unwrap(),
                _ => unreachable!(),
            }
        })
        .await;
        let ids = |o: &StatementOutcome| match o {
            StatementOutcome::Rows { result } => result.rows.iter().map(|r| num(&r["id"])).collect::<Vec<_>>(),
            _ => panic!("rows"),
        };
        let (a, b) = (ids(&page1.outcome), ids(&page2.outcome));
        assert_eq!((a.len(), b.len()), (20, 20));
        assert!(a.iter().all(|x| !b.contains(x)), "pages do not overlap");
        for level in ["ONE", "QUORUM", "LOCAL_QUORUM"] {
            let ok = with_cass(&state, "sc", move |d| async move {
                match &*d.lock().await {
                    LiveConnection::Cassandra(c) => c.exec_cql_c("SELECT count(*) FROM vn.orders", None, None, Some(level)).await,
                    _ => unreachable!(),
                }
            })
            .await;
            assert!(ok.is_ok(), "{level}: {:?}", ok.err());
        }
        let w = with_cass(&state, "sc", |d| async move {
            match &*d.lock().await {
                LiveConnection::Cassandra(c) => c
                    .exec_cql("CREATE KEYSPACE warn_ks WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':1}", None, None)
                    .await
                    .unwrap(),
                _ => unreachable!(),
            }
        })
        .await;
        assert!(!w.warnings.is_empty(), "server warnings reach the editor");
        eprintln!("CHK paging/consistency/warnings: {:?}", w.warnings);

        // ---- S6 parity: grid apply, partitions, index scan, tracing ----------------
        use database_studio_lib::drivers::grid::{Col, GridChange};
        let col = |n: &str, v: serde_json::Value, ty: &str| Col { name: n.into(), value: v, col_type: Some(ty.into()) };
        let changes = vec![
            GridChange::Insert {
                schema: Some("vn".into()),
                table: "orders".into(),
                values: vec![col("id", serde_json::json!(500), "int"), col("name", serde_json::json!("grid"), "text")],
            },
            GridChange::Update {
                schema: Some("vn".into()),
                table: "orders".into(),
                pk: vec![col("id", serde_json::json!(1), "int")],
                set: vec![col("name", serde_json::json!("edited"), "text")],
            },
            GridChange::Delete { schema: Some("vn".into()), table: "orders".into(), pk: vec![col("id", serde_json::json!(2), "int")] },
        ];
        let applied = with_cass(&state, "sc", move |d| async move {
            match &*d.lock().await {
                LiveConnection::Cassandra(c) => c.apply_grid(&changes).await.unwrap(),
                _ => unreachable!(),
            }
        })
        .await;
        assert_eq!(applied, 3);
        assert_eq!(run("SELECT name FROM vn.orders WHERE id = 500".into()).await[0]["name"], "grid");
        assert_eq!(run("SELECT name FROM vn.orders WHERE id = 1".into()).await[0]["name"], "edited");
        assert!(run("SELECT name FROM vn.orders WHERE id = 2".into()).await.is_empty());

        let (parts, scanned, traced): (Vec<PartitionInfo>, Vec<String>, usize) = with_cass(&state, "sc", |d| async move {
            match &*d.lock().await {
                LiveConnection::Cassandra(c) => {
                    let p = c.partitions("vn", "orders").await.unwrap();
                    let s = c.scan_indexes("vn").await.unwrap().into_iter().map(|r| r.name).collect();
                    let (_, events) = c.trace_cql("SELECT * FROM vn.orders WHERE id = 3").await.unwrap();
                    (p, s, events.len())
                }
                _ => unreachable!(),
            }
        })
        .await;
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].key.as_deref(), Some("id"));
        assert_eq!(scanned, ["orders_name"], "index scanner lists the index, not its backing view");
        assert!(traced > 0, "tracing returns events on ScyllaDB");
        eprintln!("CHK grid/partitions/index-scan/trace ({traced} events)");

        // ---- S3: backup keeps tablets/cdc, skips CDC-log data, restores --------------
        let rows_before = num(&run("SELECT count(*) AS n FROM vn.orders".into()).await[0]["n"]);
        let dest = tmp("vn.cql");
        let out = run_backup(&state, "sc".into(), dest.clone(), opts("vn")).await.unwrap();
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.contains("tablets = {'enabled': false}"), "vnodes keyspace stays vnodes:\n{text}");
        assert!(text.contains("cdc = {"), "CDC option kept");
        assert!(!text.contains("CREATE MATERIALIZED VIEW IF NOT EXISTS vn.orders_name_index"), "no index backing view");
        assert!(!text.contains("INSERT INTO \"vn\".\"orders_scylla_cdc_log\""), "CDC log data not dumped");
        assert!(out.notes.iter().any(|n| n.contains("orders_scylla_cdc_log")), "{:?}", out.notes);
        assert!(out.notes.iter().any(|n| n.contains("counter table hits")), "{:?}", out.notes);
        assert_eq!(out.items, Some(rows_before as u64));

        run("DROP KEYSPACE vn".into()).await;
        run_restore(&state, "sc".into(), dest.clone(), None).await.unwrap();
        let tr = tree(&state, "sc", "vn").await;
        assert_eq!(tr.tablets.as_deref(), Some("vnodes"), "restored as vnodes, so CDC/counters/LWT still work");
        assert!(ddl(&state, "sc", "vn", "table", "orders").await.contains("cdc = {"));
        assert_eq!(tr.views.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["orders_by_name"]);
        assert_eq!(num(&run("SELECT count(*) AS n FROM vn.orders".into()).await[0]["n"]), rows_before);
        assert_eq!(run("SELECT id FROM vn.orders WHERE name = 'edited'".into()).await.len(), 1, "index restored");
        run("UPDATE vn.hits SET n = n + 1 WHERE page = 'x'".into()).await; // counters allowed (vnodes)
        run("INSERT INTO vn.orders (id) VALUES (9999) IF NOT EXISTS".into()).await; // LWT allowed (vnodes)
        // restoring again over the existing keyspace is harmless
        run_restore(&state, "sc".into(), dest, None).await.unwrap();
        eprintln!("CHK backup/restore");
    })
}

/// Users & privileges on ScyllaDB with auth: the 6 steps of SPEC-USERS-PRIVILEGES
/// §1.9, running exactly the CQL `src/lib/users/cassandra.ts` produces.
#[test]
fn scylla_user_manager_end_to_end() {
    on_big_stack(async move {
        let _c = start_scylla(true).await;
        let connect_as = |user: &'static str, pw: &'static str, wait: u64| async move {
            let deadline = Instant::now() + Duration::from_secs(wait);
            let mut last;
            loop {
                match CassandraDriver::connect(&params(user, pw)).await {
                    // a query any logged-in role may run (superuser bootstrap is async)
                    Ok(d) => match d.exec_cql("SELECT release_version FROM system.local", None, None).await {
                        Ok(_) => return d,
                        Err(e) => last = format!("query: {}", e.message),
                    },
                    Err(e) => last = format!("connect: {}", e.message),
                }
                assert!(Instant::now() < deadline, "{user} cannot log in: {last}");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        };
        let admin = connect_as("cassandra", "cassandra", 300).await;
        assert_eq!(admin.server_info().flavor, CassFlavor::Scylla);
        let ok = |r: Result<_, database_studio_lib::error::QueryError>, what: &str| {
            r.unwrap_or_else(|e| panic!("{what}: {}", e.message));
        };
        ok(admin.exec_cql("CREATE KEYSPACE app_ks WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':1}", None, None).await, "keyspace");
        ok(admin.exec_cql("CREATE TABLE app_ks.secret (id int PRIMARY KEY, v text)", None, None).await, "table");
        ok(admin.exec_cql("INSERT INTO app_ks.secret (id, v) VALUES (1, 'x')", None, None).await, "seed");

        // 1. CREATE  2. LOGIN
        ok(admin.exec_cql("CREATE ROLE app_role WITH PASSWORD = 'pw' AND LOGIN = true AND SUPERUSER = false", None, None).await, "create role");
        let user = connect_as("app_role", "pw", 60).await;
        // 3. DENIED before grant
        assert!(user.exec_cql("SELECT * FROM app_ks.secret", None, None).await.is_err(), "denied before grant");
        // 4. GRANT read-only → reads (permissions are cached per role — wait + fresh session)
        ok(admin.exec_cql("GRANT SELECT ON KEYSPACE app_ks TO app_role", None, None).await, "grant");
        tokio::time::sleep(Duration::from_secs(3)).await;
        let user = connect_as("app_role", "pw", 60).await;
        let out = user.exec_cql("SELECT count(*) AS n FROM app_ks.secret", None, None).await.expect("select after grant");
        let StatementOutcome::Rows { result } = out.outcome else { panic!("rows") };
        assert_eq!(num(&result.rows[0]["n"]), 1);
        // the User Manager reads permissions back with LIST ALL PERMISSIONS OF
        let perms = admin.exec_cql("LIST ALL PERMISSIONS OF app_role", None, None).await.expect("list permissions");
        let StatementOutcome::Rows { result } = perms.outcome else { panic!("rows") };
        assert!(result.rows.iter().any(|r| r["permission"] == "SELECT"), "{:?}", result.rows);
        // 5. WRITE denied
        assert!(user.exec_cql("INSERT INTO app_ks.secret (id, v) VALUES (2, 'z')", None, None).await.is_err(), "MODIFY denied");
        // 6. REVOKE → denied; DROP → gone
        ok(admin.exec_cql("REVOKE ALL PERMISSIONS ON KEYSPACE app_ks FROM app_role", None, None).await, "revoke");
        tokio::time::sleep(Duration::from_secs(3)).await;
        let user = connect_as("app_role", "pw", 60).await;
        assert!(user.exec_cql("SELECT * FROM app_ks.secret", None, None).await.is_err(), "denied after revoke");
        ok(admin.exec_cql("DROP ROLE IF EXISTS app_role", None, None).await, "drop role");
        let roles = admin.exec_cql("LIST ROLES", None, None).await.expect("list roles");
        let StatementOutcome::Rows { result } = roles.outcome else { panic!("rows") };
        assert!(result.rows.iter().all(|r| r["role"] != "app_role"), "{:?}", result.rows);
        assert!(CassandraDriver::connect(&params("app_role", "pw")).await.is_err(), "dropped role cannot log in");
        eprintln!("CHK users 6 steps");
    })
}
