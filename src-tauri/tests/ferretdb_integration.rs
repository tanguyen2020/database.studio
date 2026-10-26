//! FerretDB as a flavor of the MongoDB engine (SPEC-FERRETDB-DOCUMENTDB.md), against
//! a real `ghcr.io/ferretdb/ferretdb-eval:2` container (FerretDB v2 + PostgreSQL with
//! the DocumentDB extension, all in one):
//!  - detection: buildInfo names FerretDB (its `version` is a compatibility number);
//!  - the app's MongoDB screens on FerretDB: Explorer (databases, collections, fields,
//!    indexes), query editor (find / aggregate / count / distinct / writes, the Design
//!    Document $rename / $unset), explain (a PostgreSQL plan, read as a plan of the
//!    collection), admin views;
//!  - what FerretDB refuses is explained (mapReduce, $where, role commands);
//!  - users: create / sign in / change password / drop — and roles are NOT enforced
//!    (pinned: a "read" user can write);
//!  - Backup & Restore with the mongodump / mongorestore shipped with the app.
//!
//!   cargo test --test ferretdb_integration -- --nocapture --test-threads=1

// the registry's exec future is deep; the default limit is not enough to lay it out
#![recursion_limit = "256"]

use std::time::{Duration, Instant};

use database_studio_lib::commands::backup::{plan_for, run_backup, run_restore};
use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
use database_studio_lib::connections::registry::Registry;
use database_studio_lib::drivers::backup_tools::BackupOptions;
use database_studio_lib::drivers::mongo::{MongoConnParams, MongoDriver};
use database_studio_lib::drivers::plan::parse_mongodb;
use database_studio_lib::drivers::types::{StatementOutcome, SystemType};
use database_studio_lib::state::AppState;
use database_studio_lib::storage::Storage;
use serde_json::{json, Value};
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

const USER: &str = "fdbuser";
const PASS: &str = "fdbpass";

fn tag() -> String {
    std::env::var("DS_FERRET_TAG").unwrap_or_else(|_| "2".into())
}

/// Backup futures nest deeply — debug builds overflow tokio's default 2 MB stack.
fn on_big_stack<F: std::future::Future<Output = ()> + Send + 'static>(f: F) {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(4).thread_stack_size(32 * 1024 * 1024).enable_all().build().unwrap();
    rt.block_on(async move {
        if let Err(e) = tokio::spawn(f).await {
            if e.is_panic() {
                std::panic::resume_unwind(e.into_panic());
            }
            panic!("{e}");
        }
    });
}

async fn start() -> (ContainerAsync<GenericImage>, u16) {
    let tag = tag();
    let c = GenericImage::new("ghcr.io/ferretdb/ferretdb-eval", &tag)
        .with_exposed_port(27017.tcp())
        .with_env_var("POSTGRES_USER", USER)
        .with_env_var("POSTGRES_PASSWORD", PASS)
        .start()
        .await
        .expect("start ferretdb (Docker must be running)");
    let port = c.get_host_port_ipv4(27017).await.unwrap();
    (c, port)
}

fn params(port: u16, user: &str, pass: &str) -> MongoConnParams {
    MongoConnParams {
        host: "localhost".into(),
        port,
        database: "shop".into(),
        user: user.into(),
        password: pass.into(),
        ssl: false,
        ssl_ca: String::new(),
        flavor: String::new(),
        tunneled: false,
    }
}

async fn connect_driver(p: &MongoConnParams) -> MongoDriver {
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        match MongoDriver::connect(p).await {
            Ok(d) => return d,
            Err(e) => {
                assert!(Instant::now() < deadline, "connect: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

static STORE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn app_state() -> AppState {
    AppState {
        storage: Storage::open(std::env::temp_dir().join(format!("ds-ferret-it-{}-{}", std::process::id(), STORE.fetch_add(1, std::sync::atomic::Ordering::SeqCst)))).unwrap(),
        registry: Registry::default(),
        pubsub: Default::default(),
        kafka_stops: Default::default(),
        test_cancels: Default::default(),
        export_cancels: Default::default(),
    }
}

fn profile(port: u16) -> ConnectionProfile {
    ConnectionProfile {
        id: "fd".into(),
        name: "fd".into(),
        system: SystemType::Mongodb,
        host: "localhost".into(),
        port,
        database: "shop".into(),
        user: USER.into(),
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
        cassandra_flavor: String::new(),
        admin_url: String::new(),
    }
}

async fn exec(state: &AppState, q: &str) -> Result<Vec<Value>, String> {
    match state.registry.exec_statement("fd", q.into()).await.map_err(|e| format!("{e}"))? {
        Ok(StatementOutcome::Rows { result }) => Ok(result.rows),
        Ok(StatementOutcome::Affected { affected }) => Ok(vec![json!({ "affected": affected })]),
        Ok(_) => Ok(Vec::new()),
        Err(e) => Err(format!("{} | hint: {}", e.message, e.hint.unwrap_or_default())),
    }
}

fn count_of(rows: &[Value]) -> i64 {
    rows.first()
        .and_then(Value::as_object)
        .and_then(|o| o.values().find_map(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))))
        .unwrap_or_else(|| panic!("count rows: {rows:?}"))
}

#[test]
fn ferretdb_works_through_the_mongodb_screens() {
    on_big_stack(async move {
        let (_c, port) = start().await;
        let p = params(port, USER, PASS);
        let drv = connect_driver(&p).await;

        // ---- 1. detection ----
        let info = drv.server_info("localhost", "").await.expect("buildInfo");
        assert_eq!(info.flavor, "ferretdb");
        assert!(info.version.starts_with("v2."), "{info:?}");
        assert!(info.label.starts_with("FerretDB v2.") && info.label.contains("MongoDB 7.0 compatible"), "{}", info.label);
        let t = MongoDriver::test(&p).await;
        assert!(t.ok && t.server_version.as_deref().unwrap_or("").starts_with("FerretDB v2."), "{:?}", t.server_version);
        eprintln!("CHK detect: {}", info.label);

        // ---- 2. through the registry (the app's path) ----
        let state = app_state();
        state.registry.connect(profile(port), PASS.into(), String::new()).await.expect("registry connect");
        let docs: Vec<String> = (1..=300).map(|i| format!("{{\"n\":{i},\"tag\":\"t{}\",\"price\":{}}}", i % 5, i * 3)).collect();
        exec(&state, &format!("db.items.insertMany([{}])", docs.join(","))).await.unwrap();
        exec(&state, "db.items.createIndex({\"tag\": 1})").await.unwrap();

        // Explorer
        // the same driver methods the Explorer calls
        let r = (
            drv.databases().await.unwrap(),
            drv.collections("shop").await.unwrap(),
            drv.collection_fields("shop", "items").await.unwrap(),
            drv.indexes("shop", "items").await.unwrap(),
        );
        assert!(r.0.iter().any(|d| d.name == "shop"), "databases: {:?}", r.0.iter().map(|d| &d.name).collect::<Vec<_>>());
        assert!(r.1.iter().any(|c| c.name == "items"));
        for f in ["n", "tag", "price"] {
            assert!(r.2.iter().any(|c| c.name == f), "field {f} sampled: {:?}", r.2.iter().map(|c| &c.name).collect::<Vec<_>>());
        }
        assert!(r.3.iter().any(|i| i.name == "tag_1"), "index tag_1 listed");
        eprintln!("CHK explorer: databases, collections, fields, indexes");

        // Query editor
        let rows = exec(&state, "db.items.find({\"tag\": \"t1\"}).sort({\"n\": -1}).limit(3)").await.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["n"], json!(296));
        let g = exec(&state, "db.items.aggregate([{\"$group\": {\"_id\": \"$tag\", \"c\": {\"$sum\": 1}}}, {\"$sort\": {\"_id\": 1}}])").await.unwrap();
        assert_eq!(g.len(), 5);
        assert_eq!(count_of(&exec(&state, "db.items.countDocuments({\"price\": {\"$gt\": 600}})").await.unwrap()), 100);
        let d = exec(&state, "db.items.distinct(\"tag\")").await.unwrap();
        assert_eq!(d.len(), 5, "distinct: {d:?}");
        exec(&state, "db.items.updateMany({\"tag\": \"t0\"}, {\"$set\": {\"vip\": true}})").await.unwrap();
        assert_eq!(count_of(&exec(&state, "db.items.countDocuments({\"vip\": true})").await.unwrap()), 60);
        // Design Document = $rename / $unset over every document
        exec(&state, "db.items.updateMany({}, {\"$rename\": {\"price\": \"amount\"}})").await.unwrap();
        exec(&state, "db.items.updateMany({}, {\"$unset\": {\"vip\": \"\"}})").await.unwrap();
        assert_eq!(count_of(&exec(&state, "db.items.countDocuments({\"amount\": {\"$exists\": true}})").await.unwrap()), 300);
        assert_eq!(count_of(&exec(&state, "db.items.countDocuments({\"vip\": {\"$exists\": true}})").await.unwrap()), 0);
        exec(&state, "db.items.deleteOne({\"n\": 1})").await.unwrap();
        assert_eq!(count_of(&exec(&state, "db.items.countDocuments({})").await.unwrap()), 299);
        eprintln!("CHK query editor: find / aggregate / count / distinct / update / design ops / delete");

        // ---- 3. explain: a PostgreSQL plan, read as a plan of the collection ----
        let raw = drv.explain_mongo("db.items.find({\"tag\": \"t2\"})", false).await.expect("explain");
        assert!(raw["queryPlanner"].get("Plan").is_some(), "FerretDB explain is a PostgreSQL plan: {raw}");
        let plan = parse_mongodb(&raw, false);
        let root = plan.root.expect("plan root");
        let text = serde_json::to_string(&root).unwrap();
        assert!(!text.contains("BSONHEX"), "the encoded filter is replaced: {text}");
        assert!(!text.contains("documents_"), "the internal table is replaced: {text}");
        assert!(text.contains("items"), "the collection is named: {text}");
        eprintln!("CHK explain: {} ({} → collection)", root.native_op, plan.system);

        // ---- 4. what FerretDB refuses is explained ----
        let e = exec(&state, "db.items.find({\"$where\": \"this.n > 1\"})").await.expect_err("$where is refused");
        assert!(e.contains("$expr"), "explained: {e}");
        eprintln!("CHK unsupported $where explained");

        // ---- 5. admin views ----
        let views = (drv.admin_view("server").await.map(|r| r.rows.len()), drv.admin_view("sessions").await.map(|r| r.rows.len()), drv.admin_view("users").await.map(|r| r.rows.len()));
        assert!(views.0.is_ok(), "server view: {:?}", views.0.err().map(|e| e.message));
        assert!(views.1.is_ok(), "sessions view: {:?}", views.1.err().map(|e| e.message));
        assert!(views.2.is_ok(), "users view: {:?}", views.2.err().map(|e| e.message));
        eprintln!("CHK admin views: server / sessions / users");

        // ---- 6. users — created without roles, roles are not enforced ----
        let role = vec![json!({ "role": "read", "db": "shop" })];
        drv.um_create_user("admin", "it_reader", "Reader-123", &role).await.expect("createUser");
        drv.um_create_user("admin", "it_plain", "Plain-123", &[]).await.expect("createUser without roles");
        let users = drv.um_list_users().await.unwrap();
        let names: Vec<String> = users.rows.iter().filter_map(|r| r["user"].as_str().map(str::to_string)).collect();
        assert!(names.contains(&"it_reader".into()) && names.contains(&"it_plain".into()), "{names:?}");
        assert!(names.contains(&"documentdb_bg_worker_role".into()), "FerretDB's own background user is listed (the app hides it)");
        let reader = connect_driver(&params(port, "it_reader", "Reader-123")).await;
        let w = reader.exec_mongo("db.items.insertOne({\"by\": \"reader\"})", None, None).await;
        assert!(w.is_ok(), "measured: a user given only \"read\" can still write on FerretDB — {:?}", w.err().map(|e| e.message));
        // role commands do not exist — and are explained
        let g = drv.um_grant_roles("admin", "it_reader", &role).await.expect_err("no grantRolesToUser");
        assert!(g.message.contains("grantRolesToUser"), "{}", g.message);
        drv.um_change_password("admin", "it_reader", "Reader-456").await.expect("updateUser");
        assert!(MongoDriver::connect(&params(port, "it_reader", "Reader-123")).await.is_err(), "the old password no longer signs in");
        let _ = connect_driver(&params(port, "it_reader", "Reader-456")).await;
        drv.um_drop_user("admin", "it_reader").await.unwrap();
        drv.um_drop_user("admin", "it_plain").await.unwrap();
        eprintln!("CHK users: create / sign in / password / drop; roles not enforced");

        // ---- 7. Backup & Restore with the bundled mongodump / mongorestore ----
        let before = count_of(&exec(&state, "db.items.countDocuments({})").await.unwrap());
        let plan = plan_for(&state, "fd".into(), None, None).await.unwrap();
        let tool = plan.backup_tool.as_ref().expect("backup tool");
        assert!(tool.found, "mongodump found: {:?}", plan.warnings);
        let dest = std::env::temp_dir().join(format!("ds-ferret-{}.archive.gz", std::process::id())).to_string_lossy().to_string();
        let mut o = BackupOptions::default();
        o.format = Some("gzip".into());
        run_backup(&state, "fd".into(), dest.clone(), Some(o)).await.expect("mongodump on FerretDB");
        exec(&state, "db.items.deleteMany({\"n\": {\"$gt\": 10}})").await.unwrap();
        let mut r = BackupOptions::default();
        r.clean = Some(true);
        run_restore(&state, "fd".into(), dest, Some(r)).await.expect("mongorestore on FerretDB");
        let after = count_of(&exec(&state, "db.items.countDocuments({})").await.unwrap());
        assert_eq!(after, before, "every document is back");
        eprintln!("CHK backup & restore with {} on FerretDB ({after} documents)", tool.version.clone().unwrap_or_default());
    });
}
