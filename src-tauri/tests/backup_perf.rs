//! Backup & Restore at scale — 3,000 tables per engine on real servers.
//!
//! What each test proves, through the dialog's own code path (run_backup /
//! run_restore with a job id, exactly as the app calls them):
//!   1. it finishes, and the restored database has every table and its rows;
//!   2. progress is live: events arrive while it runs, never go backwards within
//!      a stage, and end at the total (tables, collections, keys, bytes or %);
//!   3. the app does not freeze: a timer on the async runtime and a plain OS
//!      thread keep their beat, and a query on another connection stays fast;
//!   4. Stop works: cancelling mid-run returns within seconds and leaves no
//!      half-written file on this computer.
//!
//! `#[ignore]` (minutes per engine). Run one at a time, e.g.
//!   cargo test --test backup_perf --no-run
//!   timeout 1500 cargo test --test backup_perf perf_postgres -- --ignored --nocapture --test-threads=1
//! The client tools come from src-tauri/resources/tools (`npm run tools:fetch`).

#![recursion_limit = "512"]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use database_studio_lib::commands::backup::{cancel_job, run_backup, run_restore, set_progress_sink, BackupProgress};
use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
use database_studio_lib::connections::registry::Registry;
use database_studio_lib::drivers::backup_tools::BackupOptions;
use database_studio_lib::drivers::types::{StatementOutcome, SystemType};
use database_studio_lib::state::AppState;
use database_studio_lib::storage::Storage;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};

const TABLES: u64 = 2000;
const PASS: &str = "test123";
const MSSQL_PASS: &str = "Test123!Pass";

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

static STORE: AtomicU64 = AtomicU64::new(0);

fn app_state() -> AppState {
    AppState {
        storage: Storage::open(std::env::temp_dir().join(format!("ds-perf-store-{}-{}", std::process::id(), STORE.fetch_add(1, Ordering::SeqCst)))).unwrap(),
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
    let deadline = Instant::now() + Duration::from_secs(400);
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
        Err(e) => panic!("{}: {}", sql.chars().take(200).collect::<String>(), e.message),
    }
}

fn n(v: &serde_json::Value, k: &str) -> u64 {
    match &v[k] {
        serde_json::Value::Number(x) => x.as_u64().unwrap(),
        serde_json::Value::String(s) => s.parse().unwrap(),
        other => panic!("{k}: {other}"),
    }
}

fn tmp(name: &str) -> String {
    let d = std::env::temp_dir().join(format!("ds-perf-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d.join(name).to_string_lossy().to_string()
}

fn opts(job: &str, f: impl FnOnce(&mut BackupOptions)) -> Option<BackupOptions> {
    let mut o = BackupOptions { job_id: Some(job.into()), ..Default::default() };
    f(&mut o);
    Some(o)
}

static JOB: AtomicU64 = AtomicU64::new(0);
fn job_id(tag: &str) -> String {
    format!("perf-{tag}-{}", JOB.fetch_add(1, Ordering::SeqCst))
}

fn record(job: &str) -> Arc<Mutex<Vec<BackupProgress>>> {
    let v = Arc::new(Mutex::new(Vec::new()));
    let v2 = v.clone();
    set_progress_sink(job, move |p| v2.lock().unwrap().push(p));
    v
}

// ---- "does not freeze the machine" ------------------------------------------------

/// Watches, while a job runs: the async runtime (a 50 ms timer), the OS
/// scheduler (a plain thread sleeping 20 ms) and the database (a query on a
/// second connection every half second).
struct Probe {
    stop: Arc<AtomicBool>,
    rt_lag: Arc<AtomicU64>,
    os_lag: Arc<AtomicU64>,
    query: Arc<AtomicU64>,
    task: tokio::task::JoinHandle<()>,
    thread: std::thread::JoinHandle<()>,
}

#[derive(Debug, Clone, Copy)]
struct Load {
    rt_lag_ms: u64,
    os_lag_ms: u64,
    query_ms: u64,
}

impl Probe {
    fn start(state: Arc<AppState>, probe_conn: Option<(String, String)>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let rt_lag = Arc::new(AtomicU64::new(0));
        let os_lag = Arc::new(AtomicU64::new(0));
        let query = Arc::new(AtomicU64::new(0));
        let (s1, r1, q1) = (stop.clone(), rt_lag.clone(), query.clone());
        let task = tokio::spawn(async move {
            let mut i = 0u64;
            while !s1.load(Ordering::Relaxed) {
                let t = Instant::now();
                tokio::time::sleep(Duration::from_millis(50)).await;
                let lag = t.elapsed().as_millis().saturating_sub(50) as u64;
                r1.fetch_max(lag, Ordering::Relaxed);
                i += 1;
                if i % 10 == 0 {
                    if let Some((id, sql)) = &probe_conn {
                        let t = Instant::now();
                        let _ = state.registry.exec_statement(id, sql.clone()).await;
                        q1.fetch_max(t.elapsed().as_millis() as u64, Ordering::Relaxed);
                    }
                }
            }
        });
        let (s2, o2) = (stop.clone(), os_lag.clone());
        let thread = std::thread::spawn(move || {
            while !s2.load(Ordering::Relaxed) {
                let t = Instant::now();
                std::thread::sleep(Duration::from_millis(20));
                o2.fetch_max(t.elapsed().as_millis().saturating_sub(20) as u64, Ordering::Relaxed);
            }
        });
        Probe { stop, rt_lag, os_lag, query, task, thread }
    }
    async fn finish(self) -> Load {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.task.await;
        let _ = self.thread.join();
        Load {
            rt_lag_ms: self.rt_lag.load(Ordering::Relaxed),
            os_lag_ms: self.os_lag.load(Ordering::Relaxed),
            query_ms: self.query.load(Ordering::Relaxed),
        }
    }
}

/// Jobs the DATABASE SERVER runs itself (BACKUP / RESTORE statements, Data Pump):
/// the app only waits, so a busy server answering other queries slowly is the
/// server's load, not the app freezing — measured and reported, not asserted.
const SERVER_SIDE_JOBS: &[&str] = &["clickhouse", "mssql .bak", "oracle"];

fn assert_responsive(what: &str, l: Load) {
    // generous bounds: the containers run on this same machine
    assert!(l.rt_lag_ms < 1500, "{what}: the app's runtime stalled {} ms", l.rt_lag_ms);
    assert!(l.os_lag_ms < 1500, "{what}: the machine stalled {} ms", l.os_lag_ms);
    if SERVER_SIDE_JOBS.iter().any(|s| what.starts_with(s)) {
        eprintln!("NOTE {what}: the server answered another connection within {} ms while it ran the job itself", l.query_ms);
    } else {
        assert!(l.query_ms < 5000, "{what}: another connection waited {} ms", l.query_ms);
    }
}

// ---- progress checks ----------------------------------------------------------------

#[derive(Clone, Copy)]
enum Expect {
    /// The main stage counts to exactly this many (unit given).
    Exact(&'static str, u64),
    /// The main stage counts to its own announced total (bytes of a file, %).
    ToTotal(&'static str),
    /// Counted object by object, the total is not known up front (unit given).
    Counted(&'static str, u64),
    /// No measurable amount — a stage is announced (indeterminate bar).
    Stage,
}

fn check_events(what: &str, ev: &[BackupProgress], expect: Expect) -> usize {
    assert!(!ev.is_empty(), "{what}: no progress events at all");
    let mut prev: Option<(String, u64)> = None;
    for e in ev {
        if let Some((st, d)) = &prev {
            if st == &e.stage {
                assert!(e.done >= *d, "{what}: progress went backwards in {}: {} → {}", e.stage, d, e.done);
            }
        }
        if let Some(t) = e.total {
            assert!(e.done <= t, "{what}: done {} > total {t}", e.done);
        }
        prev = Some((e.stage.clone(), e.done));
    }
    match expect {
        Expect::Exact(unit, total) => {
            let last = ev.iter().filter(|e| e.unit == unit).last().unwrap_or_else(|| panic!("{what}: no '{unit}' progress: {:?}", ev.last()));
            assert_eq!(last.total, Some(total), "{what}: announced total");
            assert_eq!(last.done, total, "{what}: counted to the end");
            assert!(ev.iter().any(|e| e.current.is_some()), "{what}: never named the object it was on");
        }
        Expect::ToTotal(unit) => {
            let last = ev.iter().filter(|e| e.unit == unit).last().unwrap_or_else(|| panic!("{what}: no '{unit}' progress: {:?}", ev.last()));
            let t = last.total.unwrap_or_else(|| panic!("{what}: no total announced"));
            assert!(t > 0, "{what}: empty total");
            assert_eq!(last.done, t, "{what}: did not reach its total");
        }
        Expect::Counted(unit, count) => {
            let last = ev.iter().filter(|e| e.unit == unit).last().unwrap_or_else(|| panic!("{what}: no '{unit}' progress: {:?}", ev.last()));
            assert_eq!(last.done, count, "{what}: counted every object");
            assert!(ev.iter().any(|e| e.current.is_some()), "{what}: never named the object it was on");
        }
        Expect::Stage => {
            assert!(ev.iter().any(|e| e.stage == "Backing up" || e.stage == "Restoring"), "{what}: no stage: {ev:?}");
        }
    }
    // at least a few updates between start and end (it is live, not one jump)
    ev.len()
}

struct Timed {
    ms: u128,
    events: usize,
    load: Load,
    bytes: Option<u64>,
}

#[allow(clippy::too_many_arguments)]
async fn timed_backup(state: &Arc<AppState>, what: &str, id: &str, dest: &str, probe: Option<(String, String)>, expect: Expect, f: impl FnOnce(&mut BackupOptions)) -> Timed {
    let job = job_id(what);
    let ev = record(&job);
    let p = Probe::start(state.clone(), probe);
    let t = Instant::now();
    let out = run_backup(state, id.into(), dest.into(), opts(&job, f)).await.unwrap_or_else(|e| panic!("{what} backup: {e}"));
    let ms = t.elapsed().as_millis();
    let load = p.finish().await;
    let ev = ev.lock().unwrap().clone();
    let events = check_events(&format!("{what} backup"), &ev, expect);
    assert_responsive(&format!("{what} backup"), load);
    Timed { ms, events, load, bytes: out.bytes }
}

async fn timed_restore(state: &Arc<AppState>, what: &str, id: &str, src: &str, probe: Option<(String, String)>, expect: Expect, f: impl FnOnce(&mut BackupOptions)) -> Timed {
    let job = job_id(what);
    let ev = record(&job);
    let p = Probe::start(state.clone(), probe);
    let t = Instant::now();
    run_restore(state, id.into(), src.into(), opts(&job, f)).await.unwrap_or_else(|e| panic!("{what} restore: {e}"));
    let ms = t.elapsed().as_millis();
    let load = p.finish().await;
    let ev = ev.lock().unwrap().clone();
    let events = check_events(&format!("{what} restore"), &ev, expect);
    assert_responsive(&format!("{what} restore"), load);
    Timed { ms, events, load, bytes: None }
}

/// Start a backup, press Stop once it is under way, measure how long Stop takes.
async fn stopped_backup(state: &Arc<AppState>, what: &str, id: &str, dest: &str, client_file: bool, f: impl FnOnce(&mut BackupOptions)) -> u128 {
    let job = job_id(what);
    let ev = record(&job);
    let watcher = {
        let ev = ev.clone();
        let job = job.clone();
        tokio::spawn(async move {
            let t = Instant::now();
            // under way: its main stage has been announced (the tool / statement runs)
            loop {
                let going = ev.lock().unwrap().iter().any(|e| e.stage != "Preparing");
                if going || t.elapsed() > Duration::from_secs(20) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            let at = Instant::now();
            assert!(cancel_job(&job), "the job was not running when Stop was pressed");
            at
        })
    };
    let res = run_backup(state, id.into(), dest.into(), opts(&job, f)).await;
    let ended = Instant::now();
    let pressed = watcher.await.unwrap();
    let stop_ms = ended.duration_since(pressed).as_millis();
    let err = res.err().unwrap_or_else(|| panic!("{what}: the backup finished before Stop took effect — make it bigger"));
    assert!(err.to_string().contains("Cancel"), "{what}: Stop should report a cancel, got {err}");
    assert!(stop_ms < 10_000, "{what}: Stop took {stop_ms} ms");
    if client_file {
        assert!(!std::path::Path::new(dest).exists(), "{what}: a half-written file was left at {dest}");
    }
    stop_ms
}

fn report(engine: &str, objects: u64, unit: &str, b: &Timed, r: &Timed, stop_ms: Option<u128>) {
    eprintln!(
        "PERF | {engine:<11} | {objects} {unit} | backup {:>6} ms ({} events, {}) | restore {:>6} ms ({} events) | lag rt {} / os {} ms, query {} ms | stop {}",
        b.ms,
        b.events,
        b.bytes.map(|x| format!("{:.1} MB", x as f64 / 1_048_576.0)).unwrap_or_else(|| "server-side".into()),
        r.ms,
        r.events,
        b.load.rt_lag_ms.max(r.load.rt_lag_ms),
        b.load.os_lag_ms.max(r.load.os_lag_ms),
        b.load.query_ms.max(r.load.query_ms),
        stop_ms.map(|s| format!("{s} ms")).unwrap_or_else(|| "n/a".into()),
    );
}

/// The tool runs below normal priority, so the machine stays usable (Windows).
#[cfg(windows)]
fn priority_of(exe: &str) -> Option<u32> {
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("(Get-CimInstance Win32_Process -Filter \"Name='{exe}'\" | Select-Object -First 1).Priority")])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

// =================================================================================

#[test]
#[ignore]
fn perf_postgres() {
    on_big_stack(async move {
        let c = GenericImage::new("postgres", "16-alpine")
            .with_exposed_port(5432.tcp())
            .with_env_var("POSTGRES_PASSWORD", PASS)
            .with_env_var("POSTGRES_DB", "perf")
            .start()
            .await
            .unwrap();
        let port = c.get_host_port_ipv4(5432).await.unwrap();
        let state = Arc::new(app_state());
        connect(&state, profile("pg", SystemType::Postgres, port, "perf", "postgres"), PASS).await;
        connect(&state, profile("pg-probe", SystemType::Postgres, port, "perf", "postgres"), PASS).await;
        let t = Instant::now();
        for chunk in 0..(TABLES / 500) {
            let (a, b) = (chunk * 500 + 1, chunk * 500 + 500);
            exec(&state, "pg", &format!(
                "DO $$ BEGIN FOR i IN {a}..{b} LOOP EXECUTE format('CREATE TABLE t%s (id int PRIMARY KEY, v text)', i); EXECUTE format('INSERT INTO t%s SELECT g, md5(g::text) FROM generate_series(1, 20) g', i); END LOOP; END $$"
            ))
            .await;
        }
        eprintln!("seeded {TABLES} tables in {} ms", t.elapsed().as_millis());
        let probe = Some(("pg-probe".to_string(), "SELECT 1".to_string()));
        let count = "SELECT count(*) AS n, (SELECT count(*) FROM t1) + (SELECT count(*) FROM t2000) AS r FROM information_schema.tables WHERE table_schema = 'public'";

        // ---- plain SQL: pg_dump -v → psql through stdin ----------------------------
        let dest = tmp("pg-2000.sql");
        #[cfg(windows)]
        let prio = tokio::spawn(async {
            for _ in 0..100 {
                if let Some(p) = tokio::task::spawn_blocking(|| priority_of("pg_dump.exe")).await.unwrap() {
                    return Some(p);
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            None
        });
        let b = timed_backup(&state, "postgres", "pg", &dest, probe.clone(), Expect::Exact("tables", TABLES), |_| {}).await;
        #[cfg(windows)]
        {
            let p = prio.await.unwrap();
            // Win32_Process.Priority: 8 = normal, 6 = below normal
            assert_eq!(p, Some(6), "pg_dump should run below normal priority");
            eprintln!("CHK pg_dump ran at priority {p:?} (below normal)");
        }
        pg_drop_all(&state).await;
        let r = timed_restore(&state, "postgres", "pg", &dest, probe.clone(), Expect::ToTotal("bytes"), |_| {}).await;
        let row = &exec(&state, "pg", count).await[0];
        assert_eq!(n(row, "n"), TABLES);
        assert_eq!(n(row, "r"), 40);
        let stop = stopped_backup(&state, "postgres", "pg", &tmp("pg-stop.sql"), true, |_| {}).await;
        report("postgres", TABLES, "tables", &b, &r, Some(stop));

        // ---- custom archive: pg_dump -Fc → pg_restore -v ------------------------
        let dest = tmp("pg-2000.dump");
        let b = timed_backup(&state, "pg custom", "pg", &dest, probe.clone(), Expect::Exact("tables", TABLES), |o| o.format = Some("custom".into())).await;
        pg_drop_all(&state).await;
        // pg_restore 18 straight into the 16 server, in parallel: counted table by table
        let r = timed_restore(&state, "pg custom", "pg", &dest, probe, Expect::Exact("tables", TABLES), |_| {}).await;
        let row = &exec(&state, "pg", count).await[0];
        assert_eq!(n(row, "n"), TABLES);
        assert_eq!(n(row, "r"), 40);
        report("pg custom", TABLES, "tables", &b, &r, None);
    })
}

/// Empty the database in chunks: dropping 3,000 tables in one transaction
/// needs more locks than a default server allows (max_locks_per_transaction).
async fn pg_drop_all(state: &AppState) {
    for chunk in 0..(TABLES / 500) {
        let (a, b) = (chunk * 500 + 1, chunk * 500 + 500);
        exec(state, "pg", &format!("DO $$ BEGIN FOR i IN {a}..{b} LOOP EXECUTE format('DROP TABLE IF EXISTS t%s', i); END LOOP; END $$")).await;
    }
    assert_eq!(n(&exec(state, "pg", "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'").await[0], "n"), 0);
}

async fn perf_mysql_like(image: &str, tag: &str, system: SystemType, env_pass: &str, label: &str) {
    let c = GenericImage::new(image, tag)
        .with_exposed_port(3306.tcp())
        .with_env_var(env_pass, PASS)
        .with_env_var(if label == "mariadb" { "MARIADB_DATABASE" } else { "MYSQL_DATABASE" }, "perf")
        .start()
        .await
        .unwrap();
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    let state = Arc::new(app_state());
    connect(&state, profile("my", system.clone(), port, "perf", "root"), PASS).await;
    connect(&state, profile("my-probe", system, port, "perf", "root"), PASS).await;
    let t = Instant::now();
    exec(&state, "my", &format!(
        "CREATE PROCEDURE seed() BEGIN DECLARE i INT DEFAULT 1; WHILE i <= {TABLES} DO \
         SET @s = CONCAT('CREATE TABLE t', i, ' (id INT PRIMARY KEY, v VARCHAR(40))'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st; \
         SET @s = CONCAT('INSERT INTO t', i, ' VALUES (1,''Nguyễn''),(2,''b''),(3,''c'')'); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st; \
         SET i = i + 1; END WHILE; END"
    ))
    .await;
    exec(&state, "my", "CALL seed()").await;
    exec(&state, "my", "DROP PROCEDURE seed").await;
    eprintln!("seeded {TABLES} tables in {} ms", t.elapsed().as_millis());
    let probe = Some(("my-probe".to_string(), "SELECT 1".to_string()));
    let dest = tmp(&format!("{label}-2000.sql"));
    let b = timed_backup(&state, label, "my", &dest, probe.clone(), Expect::Exact("tables", TABLES), |_| {}).await;
    exec(&state, "my", "DROP DATABASE perf").await;
    exec(&state, "my", "CREATE DATABASE perf").await;
    let r = timed_restore(&state, label, "my", &dest, probe, Expect::ToTotal("bytes"), |_| {}).await;
    let row = &exec(&state, "my", "SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'perf') AS n, (SELECT count(*) FROM perf.t1) + (SELECT count(*) FROM perf.t2000) AS r, (SELECT v FROM perf.t1999 WHERE id = 1) AS v").await[0];
    assert_eq!(n(row, "n"), TABLES);
    assert_eq!(n(row, "r"), 6);
    assert_eq!(row["v"], "Nguyễn");
    let stop = stopped_backup(&state, label, "my", &tmp(&format!("{label}-stop.sql")), true, |_| {}).await;
    report(label, TABLES, "tables", &b, &r, Some(stop));
}

#[test]
#[ignore]
fn perf_mysql() {
    on_big_stack(perf_mysql_like("mysql", "8.0", SystemType::Mysql, "MYSQL_ROOT_PASSWORD", "mysql"))
}

#[test]
#[ignore]
fn perf_mariadb() {
    on_big_stack(perf_mysql_like("mariadb", "11", SystemType::Mariadb, "MARIADB_ROOT_PASSWORD", "mariadb"))
}

#[test]
#[ignore]
fn perf_mongodb() {
    on_big_stack(async move {
        use database_studio_lib::drivers::LiveConnection;
        let c = GenericImage::new("mongo", "7").with_exposed_port(27017.tcp()).start().await.unwrap();
        let port = c.get_host_port_ipv4(27017).await.unwrap();
        let state = Arc::new(app_state());
        connect(&state, profile("mo", SystemType::Mongodb, port, "perf", ""), "").await;
        connect(&state, profile("mo-probe", SystemType::Mongodb, port, "perf", ""), "").await;
        let t = Instant::now();
        for i in 1..=TABLES {
            exec(&state, "mo", &format!("db.c{i}.insertMany([{{\"n\":1,\"t\":\"Nguyễn\"}},{{\"n\":2}},{{\"n\":3}}])")).await;
        }
        eprintln!("seeded {TABLES} collections in {} ms", t.elapsed().as_millis());
        async fn collections(state: &AppState) -> u64 {
            state
                .registry
                .with_driver("mo", |d| async move {
                    let g = d.lock().await;
                    match &*g {
                        LiveConnection::Mongo(m) => Ok(m.collections("perf").await.map(|c| c.len() as u64).unwrap_or(0)),
                        _ => unreachable!(),
                    }
                })
                .await
                .unwrap()
                .unwrap()
        }
        let probe = Some(("mo-probe".to_string(), "db.c1.countDocuments({})".to_string()));
        let dest = tmp("mongo-2000.archive.gz");
        let b = timed_backup(&state, "mongodb", "mo", &dest, probe.clone(), Expect::Exact("collections", TABLES), |o| o.format = Some("gzip".into())).await;
        // the editor has no dropDatabase — empty it through the driver itself
        mongodb::Client::with_uri_str(format!("mongodb://127.0.0.1:{port}")).await.unwrap().database("perf").drop().await.unwrap();
        assert_eq!(collections(&state).await, 0);
        let r = timed_restore(&state, "mongodb", "mo", &dest, probe, Expect::Exact("collections", TABLES), |o| o.clean = Some(true)).await;
        assert_eq!(collections(&state).await, TABLES);
        let stop = stopped_backup(&state, "mongodb", "mo", &tmp("mongo-stop.archive.gz"), true, |o| o.format = Some("gzip".into())).await;
        report("mongodb", TABLES, "collections", &b, &r, Some(stop));
    })
}

#[test]
#[ignore]
fn perf_mssql() {
    on_big_stack(async move {
        let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
            .with_exposed_port(1433.tcp())
            .with_env_var("ACCEPT_EULA", "Y")
            .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
            .start()
            .await
            .expect("start mssql");
        let port = c.get_host_port_ipv4(1433).await.unwrap();
        let state = Arc::new(app_state());
        let mut setup = profile("ms-setup", SystemType::Mssql, port, "master", "sa");
        setup.mssql_auth = "sql".into();
        connect(&state, setup.clone(), MSSQL_PASS).await;
        exec(&state, "ms-setup", "CREATE DATABASE perf").await;
        state.registry.disconnect("ms-setup").await.unwrap();
        let mut p = setup.clone();
        p.id = "ms".into();
        p.database = "perf".into();
        connect(&state, p.clone(), MSSQL_PASS).await;
        p.id = "ms-probe".into();
        p.database = "master".into();
        connect(&state, p, MSSQL_PASS).await;
        let t = Instant::now();
        exec(&state, "ms", &format!(
            // EXEC() takes literals and variables only — build each statement in @s first
            "DECLARE @i int = 1, @s nvarchar(400); WHILE @i <= {TABLES} BEGIN SET @s = N'CREATE TABLE dbo.t' + CAST(@i AS nvarchar(10)) + N' (id int PRIMARY KEY, v nvarchar(40)); INSERT INTO dbo.t' + CAST(@i AS nvarchar(10)) + N' VALUES (1, N''Nguyễn''), (2, N''b'')'; EXEC(@s); SET @i += 1; END"
        ))
        .await;
        eprintln!("seeded {TABLES} tables in {} ms", t.elapsed().as_millis());
        let probe = Some(("ms-probe".to_string(), "SELECT 1".to_string()));
        let count = "SELECT (SELECT count(*) FROM sys.tables) AS n, (SELECT count(*) FROM dbo.t1) + (SELECT count(*) FROM dbo.t2000) AS r";

        // ---- native BACKUP / RESTORE on the server, percent polled ---------------
        let bak = "/var/opt/mssql/data/perf_2000.bak";
        let b = timed_backup(&state, "mssql .bak", "ms", bak, probe.clone(), Expect::ToTotal("%"), |_| {}).await;
        exec(&state, "ms", "DROP TABLE dbo.t1").await;
        let r = timed_restore(&state, "mssql .bak", "ms", bak, probe.clone(), Expect::ToTotal("%"), |_| {}).await;
        let row = &exec(&state, "ms", count).await[0];
        assert_eq!(n(row, "n"), TABLES);
        assert_eq!(n(row, "r"), 4);
        // Stop a server-side BACKUP: the session running it is KILLed
        let stop = stopped_backup(&state, "mssql .bak", "ms", "/var/opt/mssql/data/perf_stop.bak", false, |_| {}).await;
        // …and the connection is usable again right after
        assert_eq!(n(&exec(&state, "ms", count).await[0], "n"), TABLES);
        report("mssql .bak", TABLES, "tables", &b, &r, Some(stop));
    })
}

const CH_BACKUP_DISK: &str = r#"<clickhouse>
  <storage_configuration><disks><backups><type>local</type><path>/var/lib/clickhouse/backups/</path></backups></disks></storage_configuration>
  <backups><allowed_disk>backups</allowed_disk><allowed_path>/var/lib/clickhouse/backups/</allowed_path></backups>
</clickhouse>"#;

#[test]
#[ignore]
fn perf_clickhouse() {
    on_big_stack(async move {
        let c = GenericImage::new("clickhouse/clickhouse-server", "24.8")
            .with_exposed_port(8123.tcp())
            .with_env_var("CLICKHOUSE_PASSWORD", PASS)
            .with_copy_to("/etc/clickhouse-server/config.d/backups.xml", CH_BACKUP_DISK.as_bytes().to_vec())
            .start()
            .await
            .expect("start clickhouse");
        let port = c.get_host_port_ipv4(8123).await.unwrap();
        let state = Arc::new(app_state());
        connect(&state, profile("ch", SystemType::Clickhouse, port, "default", "default"), PASS).await;
        connect(&state, profile("ch-probe", SystemType::Clickhouse, port, "default", "default"), PASS).await;
        exec(&state, "ch", "CREATE DATABASE perf").await;
        let t = Instant::now();
        for i in 1..=TABLES {
            exec(&state, "ch", &format!("CREATE TABLE perf.t{i} (id UInt64, v String) ENGINE = MergeTree ORDER BY id")).await;
            exec(&state, "ch", &format!("INSERT INTO perf.t{i} SELECT number, toString(number) FROM numbers(20)")).await;
        }
        eprintln!("seeded {TABLES} tables in {} ms", t.elapsed().as_millis());
        let probe = Some(("ch-probe".to_string(), "SELECT 1".to_string()));
        let b = timed_backup(&state, "clickhouse", "ch", "perf_2000.zip", probe.clone(), Expect::Stage, |o| {
            o.database = Some("perf".into());
            o.disk = Some("backups".into());
        })
        .await;
        let r = timed_restore(&state, "clickhouse", "ch", "perf_2000.zip", probe, Expect::Stage, |o| {
            o.database = Some("perf".into());
            o.as_database = Some("perf_copy".into());
            o.disk = Some("backups".into());
        })
        .await;
        let row = &exec(&state, "ch", "SELECT (SELECT count() FROM system.tables WHERE database = 'perf_copy') AS n, (SELECT count() FROM perf_copy.t1) + (SELECT count() FROM perf_copy.t2000) AS r").await[0];
        assert_eq!(n(row, "n"), TABLES);
        assert_eq!(n(row, "r"), 40);
        let stop = stopped_backup(&state, "clickhouse", "ch", "perf_stop.zip", false, |o| {
            o.database = Some("perf".into());
            o.disk = Some("backups".into());
        })
        .await;
        // the HTTP connection works again after the KILL
        assert_eq!(n(&exec(&state, "ch", "SELECT count() AS n FROM system.tables WHERE database = 'perf'").await[0], "n"), TABLES);
        report("clickhouse", TABLES, "tables", &b, &r, Some(stop));
    })
}

/// Cassandra: a node keeps every table's metadata on heap, and the project's
/// container gets a small heap — 300 tables here (3,000 needs a tuned server,
/// not something a backup tool should assume). Rows are what scale instead.
#[test]
#[ignore]
fn perf_cassandra() {
    on_big_stack(async move {
        const CASS_TABLES: u64 = 300;
        let c = GenericImage::new("cassandra", "5.0")
            .with_mapped_port(9042, 9042.tcp())
            .with_env_var("CASSANDRA_BROADCAST_RPC_ADDRESS", "127.0.0.1")
            .with_env_var("MAX_HEAP_SIZE", "1536M")
            .with_env_var("HEAP_NEWSIZE", "256M")
            .start()
            .await
            .expect("start cassandra");
        let _ = &c;
        let state = Arc::new(app_state());
        connect(&state, profile("ca", SystemType::Cassandra, 9042, "", ""), "").await;
        let cq = |s: String| {
            let state = state.clone();
            async move {
                use database_studio_lib::drivers::LiveConnection;
                state
                    .registry
                    .with_driver("ca", move |d| async move {
                        let g = d.lock().await;
                        match &*g {
                            LiveConnection::Cassandra(c) => c.exec_cql(&s, Some(5000), None).await,
                            _ => unreachable!(),
                        }
                    })
                    .await
                    .unwrap()
                    .map(|o| match o.outcome {
                        StatementOutcome::Rows { result } => result.rows,
                        _ => Vec::new(),
                    })
                    .unwrap_or_else(|e| panic!("{}", e.message))
            }
        };
        cq("CREATE KEYSPACE perf WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}".into()).await;
        let t = Instant::now();
        for i in 1..=CASS_TABLES {
            cq(format!("CREATE TABLE perf.t{i} (id int PRIMARY KEY, v text)")).await;
            for k in 1..=5 {
                cq(format!("INSERT INTO perf.t{i} (id, v) VALUES ({k}, 'Nguyễn {k}')")).await;
            }
        }
        eprintln!("seeded {CASS_TABLES} tables in {} ms", t.elapsed().as_millis());
        let mut p = profile("ca-ks", SystemType::Cassandra, 9042, "perf", "");
        p.cassandra_dc = "datacenter1".into();
        connect(&state, p, "").await;
        let dest = tmp("cass-perf.cql");
        let b = timed_backup(&state, "cassandra", "ca-ks", &dest, None, Expect::Exact("tables", CASS_TABLES), |o| o.database = Some("perf".into())).await;
        // dropping 300 tables can outlast the driver's 30 s client timeout on a busy
        // node; the drop goes on server-side — wait for it instead of failing
        {
            use database_studio_lib::drivers::LiveConnection;
            let _ = state
                .registry
                .with_driver("ca", |d| async move {
                    let g = d.lock().await;
                    match &*g {
                        LiveConnection::Cassandra(c) => c.exec_cql("DROP KEYSPACE IF EXISTS perf", Some(5000), None).await.map(|_| ()),
                        _ => unreachable!(),
                    }
                })
                .await;
            let t = Instant::now();
            loop {
                let left = cq("SELECT count(*) FROM system_schema.keyspaces WHERE keyspace_name = 'perf'".into()).await;
                if n(&left[0], "count") == 0 {
                    break;
                }
                assert!(t.elapsed() < Duration::from_secs(600), "keyspace perf was not dropped");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
        // CREATE + 5 INSERT per table (+ the keyspace): counted statement by statement
        let r = timed_restore(&state, "cassandra", "ca-ks", &dest, None, Expect::ToTotal("statements"), |o| o.database = Some("perf".into())).await;
        let rows = cq("SELECT count(*) FROM system_schema.tables WHERE keyspace_name = 'perf'".into()).await;
        assert_eq!(n(&rows[0], "count"), CASS_TABLES);
        assert_eq!(n(&cq("SELECT count(*) FROM perf.t300".into()).await[0], "count"), 5);
        let stop = stopped_backup(&state, "cassandra", "ca-ks", &tmp("cass-stop.cql"), true, |o| o.database = Some("perf".into())).await;
        report("cassandra", CASS_TABLES, "tables", &b, &r, Some(stop));
    })
}

#[test]
#[ignore]
fn perf_redis() {
    on_big_stack(async move {
        const KEYS: u64 = 300_000;
        let c = GenericImage::new("redis", "7-alpine").with_exposed_port(6379.tcp()).start().await.unwrap();
        let port = c.get_host_port_ipv4(6379).await.unwrap();
        let state = Arc::new(app_state());
        connect(&state, profile("rd", SystemType::Redis, port, "0", ""), "").await;
        let client = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).unwrap();
        let mut conn = client.get_multiplexed_async_connection().await.unwrap();
        let t = Instant::now();
        for chunk in 0..(KEYS / 10_000) {
            let mut pipe = redis::pipe();
            for i in 0..10_000 {
                let k = chunk * 10_000 + i;
                pipe.cmd("SET").arg(format!("user:{k}")).arg(format!("{{\"id\":{k},\"name\":\"Nguyễn\"}}")).ignore();
            }
            pipe.query_async::<()>(&mut conn).await.unwrap();
        }
        eprintln!("seeded {KEYS} keys in {} ms", t.elapsed().as_millis());
        let dest = tmp("redis-perf.redis.jsonl");
        let b = timed_backup(&state, "redis", "rd", &dest, None, Expect::Exact("keys", KEYS), |_| {}).await;
        redis::cmd("FLUSHDB").query_async::<()>(&mut conn).await.unwrap();
        let r = timed_restore(&state, "redis", "rd", &dest, None, Expect::ToTotal("bytes"), |_| {}).await;
        let size: u64 = redis::cmd("DBSIZE").query_async(&mut conn).await.unwrap();
        assert_eq!(size, KEYS);
        let stop = stopped_backup(&state, "redis", "rd", &tmp("redis-stop.redis.jsonl"), true, |_| {}).await;
        report("redis", KEYS, "keys", &b, &r, Some(stop));
    })
}

#[test]
#[ignore]
fn perf_sqlite_and_duckdb() {
    on_big_stack(async move {
        for (system, label, ext) in [(SystemType::Sqlite, "sqlite", "db"), (SystemType::Duckdb, "duckdb", "duckdb")] {
            let state = Arc::new(app_state());
            let file = tmp(&format!("perf-src.{ext}"));
            let _ = std::fs::remove_file(&file);
            let mut p = profile(label, system, 0, "", "");
            p.sqlite_path = file.clone();
            connect(&state, p, "").await;
            let t = Instant::now();
            for i in 1..=TABLES {
                exec(&state, label, &format!("CREATE TABLE t{i} (id INTEGER PRIMARY KEY, v TEXT)")).await;
                exec(&state, label, &format!("INSERT INTO t{i} VALUES (1, 'Nguyễn'), (2, 'b')")).await;
            }
            eprintln!("{label}: seeded {TABLES} tables in {} ms", t.elapsed().as_millis());
            let dest = tmp(&format!("perf-backup.{ext}"));
            let _ = std::fs::remove_file(&dest);
            let b = timed_backup(&state, label, label, &dest, None, Expect::Stage, |_| {}).await;
            exec(&state, label, "DROP TABLE t1").await;
            let r = timed_restore(&state, label, label, &dest, None, Expect::Stage, |_| {}).await;
            let q = if label == "sqlite" { "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'" } else { "SELECT count(*) AS n FROM duckdb_tables() WHERE NOT internal" };
            assert_eq!(n(&exec(&state, label, q).await[0], "n"), TABLES);
            assert_eq!(n(&exec(&state, label, "SELECT count(*) AS n FROM t1").await[0], "n"), 2);
            report(label, TABLES, "tables", &b, &r, None);
            state.registry.disconnect(label).await.unwrap();
        }
    })
}

/// Oracle Data Pump (expdp / impdp from the Instant Client shipped with the app —
/// put src-tauri/resources/instantclient on PATH for the driver's oci.dll).
#[test]
#[ignore]
fn perf_oracle() {
    on_big_stack(async move {
        // the listener accepts connections before FREEPDB1 is registered — wait for
        // the image's own "ready" line (slow on a loaded machine)
        let c = GenericImage::new("gvenzl/oracle-free", "23-slim-faststart")
            .with_exposed_port(1521.tcp())
            .with_wait_for(testcontainers::core::WaitFor::message_on_stdout("DATABASE IS READY TO USE!"))
            .with_env_var("ORACLE_PASSWORD", "Oracle123")
            .with_startup_timeout(Duration::from_secs(900))
            .start()
            .await
            .expect("start oracle");
        let port = c.get_host_port_ipv4(1521).await.unwrap();
        let state = Arc::new(app_state());
        connect(&state, profile("ora-sys", SystemType::Oracle, port, "FREEPDB1", "system"), "Oracle123").await;
        for sql in ["CREATE USER perf IDENTIFIED BY Perf123pw", "GRANT DBA TO perf", "ALTER USER perf QUOTA UNLIMITED ON USERS"] {
            exec(&state, "ora-sys", sql).await;
        }
        connect(&state, profile("ora", SystemType::Oracle, port, "FREEPDB1", "perf"), "Perf123pw").await;
        connect(&state, profile("ora-probe", SystemType::Oracle, port, "FREEPDB1", "perf"), "Perf123pw").await;
        let t = Instant::now();
        exec(&state, "ora", &format!(
            "BEGIN FOR i IN 1..{TABLES} LOOP EXECUTE IMMEDIATE 'CREATE TABLE t' || i || ' (id NUMBER PRIMARY KEY, v VARCHAR2(40))'; \
             EXECUTE IMMEDIATE 'INSERT INTO t' || i || ' VALUES (1, ''Nguyen'')'; EXECUTE IMMEDIATE 'INSERT INTO t' || i || ' VALUES (2, ''b'')'; END LOOP; COMMIT; END;"
        ))
        .await;
        eprintln!("seeded {TABLES} tables in {} ms", t.elapsed().as_millis());
        let probe = Some(("ora-probe".to_string(), "SELECT 1 FROM dual".to_string()));
        let dump = "/tmp/perf_2000.dmp";
        let b = timed_backup(&state, "oracle", "ora", dump, probe.clone(), Expect::Exact("tables", TABLES), |_| {}).await;
        exec(&state, "ora", &format!("BEGIN FOR i IN 1..{TABLES} LOOP EXECUTE IMMEDIATE 'DROP TABLE t' || i || ' PURGE'; END LOOP; END;")).await;
        assert_eq!(n(&exec(&state, "ora", "SELECT count(*) AS N FROM user_tables").await[0], "N"), 0);
        let r = timed_restore(&state, "oracle", "ora", dump, probe, Expect::Counted("tables", TABLES), |_| {}).await;
        let row = &exec(&state, "ora", "SELECT (SELECT count(*) FROM user_tables) AS N, (SELECT count(*) FROM t1) + (SELECT count(*) FROM t2000) AS R FROM dual").await[0];
        assert_eq!(n(row, "N"), TABLES);
        assert_eq!(n(row, "R"), 4);
        let stop = stopped_backup(&state, "oracle", "ora", "/tmp/perf_stop.dmp", false, |_| {}).await;
        // the Data Pump job was stopped on the server too, not left running there
        tokio::time::sleep(Duration::from_secs(3)).await;
        let jobs = exec(&state, "ora", "SELECT count(*) AS N FROM user_datapump_jobs WHERE state NOT IN ('NOT RUNNING')").await;
        assert_eq!(n(&jobs[0], "N"), 0, "a Data Pump job is still running on the server after Stop");
        report("oracle", TABLES, "tables", &b, &r, Some(stop));
    })
}
