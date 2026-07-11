//! INDEPENDENT VERIFICATION of the EXPLAIN feature (not a product change).
//! Drives real engines via testcontainers, forces a physical scan→index change,
//! feeds the raw engine output through the SAME normalizer the app uses
//! (`drivers::plan::parse_*`), and writes raw + normalized artifacts side by side
//! to `../verification-artifacts/`.
//!
//! The EXPLAIN SQL strings mirror `commands/plan.rs::build_explain` (cited inline)
//! and the cell extraction mirrors `commands/plan.rs::parse_for_system`/`first_cell`
//! — those are private, so they are replicated verbatim here and cited.

use std::time::{Duration, Instant};

use database_studio_lib::connections::profile::SqliteMode;
use database_studio_lib::drivers::clickhouse::{ChConnParams, ChDriver};
use database_studio_lib::drivers::mssql::{MssqlConnParams, MssqlDriver};
use database_studio_lib::drivers::mysql::{MySqlConnParams, MySqlDriver};
use database_studio_lib::drivers::plan;
use database_studio_lib::drivers::postgres::{PgConnParams, PgDriver};
use database_studio_lib::drivers::sqlite::{SqliteConnParams, SqliteDriver};
use database_studio_lib::drivers::types::StatementOutcome;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

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
                assert!(Instant::now() < deadline, "{what}: 240s timeout — last: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

/// Write a verification artifact (raw engine output + app-normalized output).
fn artifact(name: &str, sections: &[(&str, String)]) {
    let dir = std::path::Path::new("../verification-artifacts");
    std::fs::create_dir_all(dir).expect("mkdir verification-artifacts");
    let mut out = String::new();
    out.push_str(&format!("# ARTIFACT: {name}\n\n"));
    for (title, body) in sections {
        out.push_str(&format!("===== {title} =====\n{body}\n\n"));
    }
    std::fs::write(dir.join(format!("{name}.txt")), out).expect("write artifact");
}

fn pretty(plan: &plan::QueryPlan) -> String {
    serde_json::to_string_pretty(plan).unwrap_or_else(|e| format!("<serialize error: {e}>"))
}

/// Mirror of `commands/plan.rs::first_cell` (:181-183).
fn first_cell(rows: &[serde_json::Value]) -> serde_json::Value {
    rows.first().and_then(|r| r.as_object()).and_then(|o| o.values().next()).cloned().unwrap_or(serde_json::Value::Null)
}

/// Depth-first search for a node whose normalized operation matches `op`.
fn find_op<'a>(node: &'a plan::PlanNode, op: &str) -> Option<&'a plan::PlanNode> {
    if node.operation == op {
        return Some(node);
    }
    for c in &node.children {
        if let Some(f) = find_op(c, op) {
            return Some(f);
        }
    }
    None
}

fn any<'a>(node: &'a plan::PlanNode, pred: &dyn Fn(&plan::PlanNode) -> bool) -> bool {
    pred(node) || node.children.iter().any(|c| any(c, pred))
}

// ===========================================================================
// TIER 1a — SQLite (no container). Proves the normalize tier cheaply.
// ===========================================================================
#[tokio::test]
async fn xv_t1_sqlite_scan_vs_index() {
    let drv = SqliteDriver::connect(&SqliteConnParams { path: String::new(), mode: SqliteMode::InMemory })
        .await
        .unwrap();
    drv.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT, note TEXT)").await.unwrap();
    // 20000 rows seeded, exactly one row status='rare' (selective predicate).
    drv.exec(
        "INSERT INTO t(status, note) \
         WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x < 20000) \
         SELECT CASE WHEN x = 1 THEN 'rare' ELSE 'common' END, 'note' FROM seq",
    )
    .await
    .unwrap();
    // seed → query back to verify the row actually exists
    let StatementOutcome::Rows { result: cnt } = drv.exec("SELECT count(*) AS n FROM t WHERE status='rare'").await.unwrap() else { panic!("rows") };
    assert_eq!(cnt.rows[0]["n"].as_i64().unwrap_or_else(|| cnt.rows[0]["n"].as_f64().unwrap() as i64), 1, "seed verify");

    let q = "SELECT id FROM t WHERE status = 'rare'";

    // --- scan (no index) --- build_explain: `EXPLAIN QUERY PLAN {sql}` (commands/plan.rs:128)
    let StatementOutcome::Rows { result } = drv.exec(&format!("EXPLAIN QUERY PLAN {q}")).await.unwrap() else { panic!("rows") };
    // mirror parse_for_system sqlite branch (commands/plan.rs:154-165)
    let parsed: Vec<(i64, i64, String)> = result
        .rows
        .iter()
        .map(|r| {
            let id = r.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            let parent = r.get("parent").and_then(|v| v.as_i64()).unwrap_or(0);
            let detail = r.get("detail").and_then(|v| v.as_str()).unwrap_or("").to_string();
            (id, parent, detail)
        })
        .collect();
    let scan = plan::parse_sqlite(&parsed);

    // --- index --- create index on the filtered column, rerun
    drv.exec("CREATE INDEX ix_status ON t(status)").await.unwrap();
    let StatementOutcome::Rows { result: r2 } = drv.exec(&format!("EXPLAIN QUERY PLAN {q}")).await.unwrap() else { panic!("rows") };
    let parsed2: Vec<(i64, i64, String)> = r2
        .rows
        .iter()
        .map(|r| {
            (
                r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                r.get("parent").and_then(|v| v.as_i64()).unwrap_or(0),
                r.get("detail").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            )
        })
        .collect();
    let idx = plan::parse_sqlite(&parsed2);

    artifact(
        "sqlite-scan-vs-index",
        &[
            ("SCAN — raw engine (EXPLAIN QUERY PLAN)", scan.raw.clone()),
            ("SCAN — app normalized", pretty(&scan)),
            ("INDEX — raw engine", idx.raw.clone()),
            ("INDEX — app normalized", pretty(&idx)),
        ],
    );

    let sroot = scan.root.clone().expect("scan root");
    // full scan surfaced: a node whose detail contains SCAN + hotspot + warning
    assert!(scan.raw.to_uppercase().contains("SCAN"), "raw must show a scan");
    assert!(any(&sroot, &|n| n.is_hotspot), "scan → hotspot flagged");
    assert!(scan.summary.warnings.iter().any(|w| w.to_lowercase().contains("scan")), "scan → full-scan warning");
    // index path: normalized IndexScan node, no full-scan hotspot
    let iroot = idx.root.clone().expect("index root");
    assert!(idx.raw.to_uppercase().contains("INDEX"), "raw must show index usage (SQLite may say USING [COVERING] INDEX)");
    assert!(find_op(&iroot, "IndexScan").is_some(), "index → normalized IndexScan node");
    assert!(!any(&iroot, &|n| n.is_hotspot), "index → no hotspot");
    eprintln!("CHK xv_t1_sqlite_scan_vs_index OK");
}

// ===========================================================================
// TIER 1b — PostgreSQL. scan/index + estimated/actual + error paths.
// ===========================================================================
async fn start_pg() -> (ContainerAsync<GenericImage>, u16) {
    let c = GenericImage::new("postgres", "16-alpine")
        .with_exposed_port(5432.tcp())
        .with_env_var("POSTGRES_PASSWORD", PASS)
        .with_env_var("POSTGRES_DB", "testdb")
        .start()
        .await
        .expect("start postgres");
    let port = c.get_host_port_ipv4(5432).await.unwrap();
    (c, port)
}

#[tokio::test]
async fn xv_t1_postgres_scan_index_actual_errors() {
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
    drv.exec("CREATE TABLE it_pg (id serial PRIMARY KEY, status text, note text)").await.unwrap();
    drv.exec(
        "INSERT INTO it_pg(status, note) SELECT CASE WHEN g = 1 THEN 'rare' ELSE 'common' END, 'n' FROM generate_series(1, 50000) g",
    )
    .await
    .unwrap();
    drv.exec("ANALYZE it_pg").await.unwrap();
    let StatementOutcome::Rows { result: cnt } = drv.exec("SELECT count(*) AS n FROM it_pg WHERE status='rare'").await.unwrap() else { panic!("rows") };
    assert_eq!(cnt.rows[0]["n"].as_i64().unwrap(), 1, "seed verify");

    let q = "SELECT id FROM it_pg WHERE status = 'rare'";
    // build_explain postgres (commands/plan.rs:118-124)
    let est_sql = format!("EXPLAIN (FORMAT JSON) {q}");
    let act_sql = format!("EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) {q}");

    // scan (no index)
    let StatementOutcome::Rows { result } = drv.exec(&est_sql).await.unwrap() else { panic!("rows") };
    let cell = first_cell(&result.rows);
    let json_scan = if cell.is_string() { cell.as_str().unwrap().to_string() } else { cell.to_string() };
    let scan = plan::parse_pg(&json_scan, false).expect("parse pg scan");

    // index
    drv.exec("CREATE INDEX ix_pg_status ON it_pg(status)").await.unwrap();
    drv.exec("ANALYZE it_pg").await.unwrap();
    let StatementOutcome::Rows { result: r2 } = drv.exec(&est_sql).await.unwrap() else { panic!("rows") };
    let cell2 = first_cell(&r2.rows);
    let json_idx = if cell2.is_string() { cell2.as_str().unwrap().to_string() } else { cell2.to_string() };
    let idx = plan::parse_pg(&json_idx, false).expect("parse pg index");

    // actual (ANALYZE)
    let StatementOutcome::Rows { result: r3 } = drv.exec(&act_sql).await.unwrap() else { panic!("rows") };
    let cell3 = first_cell(&r3.rows);
    let json_act = if cell3.is_string() { cell3.as_str().unwrap().to_string() } else { cell3.to_string() };
    let act = plan::parse_pg(&json_act, true).expect("parse pg actual");

    artifact(
        "postgres-scan-index-actual",
        &[
            ("SCAN — raw engine (EXPLAIN FORMAT JSON)", json_scan.clone()),
            ("SCAN — app normalized", pretty(&scan)),
            ("INDEX — raw engine", json_idx.clone()),
            ("INDEX — app normalized", pretty(&idx)),
            ("ACTUAL — raw engine (EXPLAIN ANALYZE)", json_act.clone()),
            ("ACTUAL — app normalized", pretty(&act)),
        ],
    );

    let sroot = scan.root.clone().expect("scan root");
    assert!(find_op(&sroot, "SeqScan").is_some(), "scan → normalized SeqScan");
    assert!(scan.raw.contains("Seq Scan"), "raw preserves 'Seq Scan'");
    // FINDING (DEF-PG-HOTSPOT, Medium): mark_hotspot (plan.rs:510) keys on estimated
    // OUTPUT rows (Plan Rows). This selective Seq Scan reads 50k rows but Plan Rows=1
    // → NOT flagged. The SeqScan node IS surfaced (required behavior); the hotspot
    // heuristic simply under-warns selective full scans. Recorded, not asserted.
    eprintln!("PG scan hotspot flagged = {} (Plan Rows selective → heuristic under-warns)", any(&sroot, &|n| n.is_hotspot));

    let iroot = idx.root.clone().expect("index root");
    assert!(
        find_op(&iroot, "IndexScan").is_some() || find_op(&iroot, "BitmapScan").is_some() || find_op(&iroot, "IndexOnlyScan").is_some(),
        "index → normalized Index/Bitmap scan; got {}",
        idx.raw
    );

    // actual mode + real actual_rows captured (not just estimate)
    assert_eq!(act.mode, "actual", "ANALYZE → mode actual");
    assert!(any(&act.root.clone().unwrap(), &|n| n.actual_rows.is_some()), "actual_rows captured");
    assert!(act.summary.total_time_ms.is_some(), "actual → total execution time captured");

    // ---- error paths (typed errors, never a silent empty plan) ----
    let missing = drv.exec("EXPLAIN (FORMAT JSON) SELECT * FROM no_such_table_xyz").await;
    let syntax = drv.exec("EXPLAIN (FORMAT JSON) SELECT FROM").await;
    let err_missing = missing.err().map(|e| format!("code={:?} msg={}", e.code, e.message)).unwrap_or_default();
    let err_syntax = syntax.err().map(|e| format!("code={:?} msg={}", e.code, e.message)).unwrap_or_default();
    artifact(
        "postgres-error-paths",
        &[
            ("EXPLAIN on missing table → typed error", err_missing.clone()),
            ("EXPLAIN with syntax error → typed error", err_syntax.clone()),
        ],
    );
    assert!(!err_missing.is_empty(), "missing table → typed error, not empty plan");
    assert!(!err_syntax.is_empty(), "syntax error → typed error, not empty plan");
    eprintln!("CHK xv_t1_postgres_scan_index_actual_errors OK");
}

// ===========================================================================
// P0.1 — SAFETY: Actual EXPLAIN on a WRITE statement must not change data.
// Proves the mechanism of commands/plan.rs::explain_pg_actual_dml:
//   BEGIN → EXPLAIN (ANALYZE …) <DML> → ROLLBACK   leaves rows intact,
// while a BARE EXPLAIN ANALYZE <DML> really deletes them (ground truth that
// the wrap is required). The is_write dispatch itself is unit-tested in
// commands::plan::tests::write_detection.
// ===========================================================================
#[tokio::test]
async fn xv_p0_postgres_actual_dml_rolls_back() {
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
    for t in ["p0_wrap", "p0_bare"] {
        drv.exec(&format!("CREATE TABLE {t} (id serial PRIMARY KEY, note text)")).await.unwrap();
        drv.exec(&format!("INSERT INTO {t}(note) SELECT 'n' FROM generate_series(1, 100) g")).await.unwrap();
    }

    // (A) app path: BEGIN → EXPLAIN ANALYZE DELETE → ROLLBACK (rollback ALWAYS runs).
    drv.exec("BEGIN").await.unwrap();
    let res = drv
        .exec("EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) DELETE FROM p0_wrap")
        .await;
    let _ = drv.exec("ROLLBACK").await;
    let StatementOutcome::Rows { result } = res.expect("EXPLAIN ANALYZE DELETE returns a plan") else {
        panic!("rows")
    };
    let cell = first_cell(&result.rows);
    let json = if cell.is_string() { cell.as_str().unwrap().to_string() } else { cell.to_string() };
    let planned = plan::parse_pg(&json, true).expect("parse pg actual dml");
    assert_eq!(planned.mode, "actual", "wrapped EXPLAIN ANALYZE → mode actual");

    let StatementOutcome::Rows { result: c1 } =
        drv.exec("SELECT count(*) AS n FROM p0_wrap").await.unwrap()
    else {
        panic!("rows")
    };
    assert_eq!(c1.rows[0]["n"].as_i64().unwrap(), 100, "wrapped path: ROLLBACK preserved all 100 rows");

    // (B) ground truth: a BARE EXPLAIN ANALYZE DELETE executes destructively.
    let _ = drv.exec("EXPLAIN (ANALYZE) DELETE FROM p0_bare").await.unwrap();
    let StatementOutcome::Rows { result: c2 } =
        drv.exec("SELECT count(*) AS n FROM p0_bare").await.unwrap()
    else {
        panic!("rows")
    };
    assert_eq!(c2.rows[0]["n"].as_i64().unwrap(), 0, "bare EXPLAIN ANALYZE DELETE deleted all rows — the transaction wrap is required");

    eprintln!("CHK xv_p0_postgres_actual_dml_rolls_back OK");
}

// ===========================================================================
// TIER 1c — MySQL. scan/index + prove "actual" toggle is estimated-only.
// ===========================================================================
#[tokio::test]
async fn xv_t1_mysql_scan_index_actual_ignored() {
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
    drv.exec("CREATE TABLE it_my (id int PRIMARY KEY AUTO_INCREMENT, status varchar(20), note text)").await.unwrap();
    // MySQL 8 default cte_max_recursion_depth = 1000 → raise it for the seed CTE.
    drv.exec("SET SESSION cte_max_recursion_depth = 100000").await.unwrap();
    drv.exec("INSERT INTO it_my(status, note) WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x < 5000) SELECT IF(x=1,'rare','common'), 'n' FROM seq").await.unwrap();
    let StatementOutcome::Rows { result: cnt } = drv.exec("SELECT count(*) AS n FROM it_my WHERE status='rare'").await.unwrap() else { panic!("rows") };
    assert_eq!(cnt.rows[0]["n"].as_i64().unwrap(), 1, "seed verify");

    let q = "SELECT id FROM it_my WHERE status = 'rare'";
    let est_sql = format!("EXPLAIN FORMAT=JSON {q}"); // build_explain mysql (commands/plan.rs:127)

    let StatementOutcome::Rows { result } = drv.exec(&est_sql).await.unwrap() else { panic!("rows") };
    let cell = first_cell(&result.rows);
    let json_scan = cell.as_str().map(String::from).unwrap_or_else(|| cell.to_string());
    // parse_for_system mysql: actual = `actual && system=="mariadb"` → false for mysql (commands/plan.rs:152)
    let scan = plan::parse_mysql(&json_scan, "mysql", false).expect("parse mysql scan");

    drv.exec("CREATE INDEX ix_my_status ON it_my(status)").await.unwrap();
    let StatementOutcome::Rows { result: r2 } = drv.exec(&est_sql).await.unwrap() else { panic!("rows") };
    let cell2 = first_cell(&r2.rows);
    let json_idx = cell2.as_str().map(String::from).unwrap_or_else(|| cell2.to_string());
    let idx = plan::parse_mysql(&json_idx, "mysql", false).expect("parse mysql index");

    // Prove the "Actual" UI toggle is estimated-only for MySQL: even if a caller
    // passed actual=true, the command computes `actual && system=="mariadb"` = false,
    // AND build_explain still emits EXPLAIN FORMAT=JSON (no ANALYZE) → no r_rows.
    let idx_as_if_actual = plan::parse_mysql(&json_idx, "mysql", true && "mysql" == "mariadb").expect("mysql actual-ignored");

    artifact(
        "mysql-scan-index",
        &[
            ("SCAN — raw engine (EXPLAIN FORMAT=JSON)", json_scan.clone()),
            ("SCAN — app normalized", pretty(&scan)),
            ("INDEX — raw engine", json_idx.clone()),
            ("INDEX — app normalized", pretty(&idx)),
            ("ACTUAL-toggle path (system=mysql) — app normalized (proves estimated-only)", pretty(&idx_as_if_actual)),
        ],
    );

    assert!(find_op(&scan.root.clone().unwrap(), "SeqScan").is_some(), "scan → SeqScan (access_type ALL)");
    assert!(find_op(&idx.root.clone().unwrap(), "IndexScan").is_some(), "index → IndexScan (access_type ref/range)");
    assert_eq!(idx_as_if_actual.mode, "estimated", "MySQL 'Actual' toggle stays estimated");
    assert!(!any(&idx_as_if_actual.root.clone().unwrap(), &|n| n.actual_rows.is_some()), "MySQL never captures actual_rows");
    eprintln!("CHK xv_t1_mysql_scan_index_actual_ignored OK");
}

// ===========================================================================
// TIER 2a — MariaDB. scan/index (estimated) + ANALYZE FORMAT=JSON (actual r_rows).
// ===========================================================================
#[tokio::test]
async fn xv_t2_mariadb_scan_index_analyze_actual() {
    let c = GenericImage::new("mariadb", "11")
        .with_exposed_port(3306.tcp())
        .with_env_var("MARIADB_ROOT_PASSWORD", PASS)
        .with_env_var("MARIADB_DATABASE", "testdb")
        .start()
        .await
        .expect("start mariadb");
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
    drv.exec("CREATE TABLE it_mdb (id int PRIMARY KEY AUTO_INCREMENT, status varchar(20), note text)").await.unwrap();
    // MariaDB default max_recursive_iterations = 1000 → raise it for the seed CTE.
    drv.exec("SET SESSION max_recursive_iterations = 100000").await.unwrap();
    drv.exec("INSERT INTO it_mdb(status, note) WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x < 5000) SELECT IF(x=1,'rare','common'), 'n' FROM seq").await.unwrap();

    let q = "SELECT id FROM it_mdb WHERE status = 'rare'";
    let est_sql = format!("EXPLAIN FORMAT=JSON {q}");
    let act_sql = format!("ANALYZE FORMAT=JSON {q}"); // build_explain mariadb actual (commands/plan.rs:126)

    let StatementOutcome::Rows { result } = drv.exec(&est_sql).await.unwrap() else { panic!("rows") };
    let json_scan = { let c = first_cell(&result.rows); c.as_str().map(String::from).unwrap_or_else(|| c.to_string()) };
    let scan = plan::parse_mysql(&json_scan, "mariadb", false).expect("parse mariadb scan");

    drv.exec("CREATE INDEX ix_mdb_status ON it_mdb(status)").await.unwrap();
    let StatementOutcome::Rows { result: r2 } = drv.exec(&est_sql).await.unwrap() else { panic!("rows") };
    let json_idx = { let c = first_cell(&r2.rows); c.as_str().map(String::from).unwrap_or_else(|| c.to_string()) };
    let idx = plan::parse_mysql(&json_idx, "mariadb", false).expect("parse mariadb index");

    let StatementOutcome::Rows { result: r3 } = drv.exec(&act_sql).await.unwrap() else { panic!("rows") };
    let json_act = { let c = first_cell(&r3.rows); c.as_str().map(String::from).unwrap_or_else(|| c.to_string()) };
    let act = plan::parse_mysql(&json_act, "mariadb", true).expect("parse mariadb actual");

    artifact(
        "mariadb-scan-index-actual",
        &[
            ("SCAN — raw", json_scan.clone()),
            ("SCAN — normalized", pretty(&scan)),
            ("INDEX — raw", json_idx.clone()),
            ("INDEX — normalized", pretty(&idx)),
            ("ACTUAL (ANALYZE FORMAT=JSON) — raw", json_act.clone()),
            ("ACTUAL — normalized", pretty(&act)),
        ],
    );

    assert!(find_op(&scan.root.clone().unwrap(), "SeqScan").is_some(), "scan → SeqScan");
    assert!(find_op(&idx.root.clone().unwrap(), "IndexScan").is_some(), "index → IndexScan");
    assert_eq!(act.mode, "actual", "ANALYZE → mode actual");
    assert!(any(&act.root.clone().unwrap(), &|n| n.actual_rows.is_some()), "MariaDB actual_rows (r_rows) captured");
    eprintln!("CHK xv_t2_mariadb_scan_index_analyze_actual OK");
}

// ===========================================================================
// TIER 2b — MSSQL. SHOWPLAN_XML (estimated). scan/index. Confirm estimated-only.
// ===========================================================================
#[tokio::test]
async fn xv_t2_mssql_scan_index_estimated() {
    let c = GenericImage::new("mcr.microsoft.com/mssql/server", "2022-latest")
        .with_exposed_port(1433.tcp())
        .with_env_var("ACCEPT_EULA", "Y")
        .with_env_var("MSSQL_SA_PASSWORD", MSSQL_PASS)
        .start()
        .await
        .expect("start mssql");
    let port = c.get_host_port_ipv4(1433).await.unwrap();
    let params = MssqlConnParams {
        host: "localhost".into(),
        port,
        database: String::new(),
        user: "sa".into(),
        password: MSSQL_PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        auth: "sql".into(),
    };
    let mut drv = retry("mssql", || MssqlDriver::connect(&params)).await;
    drv.exec("CREATE TABLE it_ms (id int IDENTITY PRIMARY KEY, status nvarchar(20), note nvarchar(50))").await.unwrap();
    // seed 20000 rows via a numbers CTE, exactly one 'rare'
    drv.exec(
        "WITH n AS (SELECT TOP (20000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS r FROM sys.all_objects a CROSS JOIN sys.all_objects b) \
         INSERT INTO it_ms(status, note) SELECT CASE WHEN r = 1 THEN N'rare' ELSE N'common' END, N'n' FROM n",
    )
    .await
    .unwrap();

    let q = "SELECT id FROM it_ms WHERE status = N'rare'";
    async fn showplan(drv: &mut MssqlDriver, q: &str) -> String {
        drv.exec("SET SHOWPLAN_XML ON").await.unwrap();
        let out = drv.exec(q).await;
        let _ = drv.exec("SET SHOWPLAN_XML OFF").await;
        let StatementOutcome::Rows { result } = out.unwrap() else { panic!("SHOWPLAN rows") };
        result.rows.first().and_then(|r| r.as_object()).and_then(|o| o.values().next()).and_then(|v| v.as_str()).unwrap_or("").to_string()
    }

    let xml_scan = showplan(&mut drv, q).await;
    let scan = plan::parse_mssql_xml(&xml_scan).expect("parse mssql scan");
    drv.exec("CREATE INDEX ix_ms_status ON it_ms(status)").await.unwrap();
    let xml_idx = showplan(&mut drv, q).await;
    let idx = plan::parse_mssql_xml(&xml_idx).expect("parse mssql index");

    artifact(
        "mssql-scan-index",
        &[
            ("SCAN — raw SHOWPLAN_XML", xml_scan.clone()),
            ("SCAN — normalized", pretty(&scan)),
            ("INDEX — raw SHOWPLAN_XML", xml_idx.clone()),
            ("INDEX — normalized", pretty(&idx)),
        ],
    );

    assert!(xml_scan.contains("ShowPlanXML"), "raw is SHOWPLAN_XML");
    assert_eq!(scan.mode, "estimated", "SHOWPLAN_XML is estimated-only");
    let sroot = scan.root.clone().unwrap();
    let iroot = idx.root.clone().unwrap();
    // raw + native_op PRESERVE the physical distinction (this part is honest):
    assert!(sroot.native_op.contains("Clustered Index Scan"), "no-index → Clustered Index Scan (full scan). native={}", sroot.native_op);
    assert!(iroot.native_op.contains("Seek"), "with-index → Index Seek. native={}", iroot.native_op);
    assert!(xml_scan.contains("EstimatedRowsRead=\"20000\"") || xml_scan.contains("TableCardinality=\"20000\""), "scan reads whole table (20k)");
    // DEFECT DEF-MSSQL-CLUSTERED-SCAN (High, normalize/DBA): a full table scan
    // (Clustered Index Scan) and an efficient Index Seek BOTH normalize to
    // "IndexScan" — the scan→index physical change is invisible in the normalized
    // operation, and no hotspot is raised for the full scan.
    assert_eq!(sroot.operation, "IndexScan", "DEFECT: full Clustered Index Scan mislabeled IndexScan");
    assert_eq!(iroot.operation, "IndexScan", "Index Seek normalized IndexScan");
    assert!(!sroot.is_hotspot, "DEFECT: full table scan not flagged as hotspot");
    eprintln!(
        "CHK xv_t2_mssql — DEFECT DEF-MSSQL-CLUSTERED-SCAN: scan.op={} (native='{}') == index.op={} (native='{}'); scan hotspot={}",
        sroot.operation, sroot.native_op, iroot.operation, iroot.native_op, sroot.is_hotspot
    );
}

// ===========================================================================
// TIER 2c — ClickHouse. EXPLAIN indexes=1. full-read (hotspot) vs key-read.
// ===========================================================================
#[tokio::test]
async fn xv_t2_clickhouse_fullread_vs_key() {
    let c = GenericImage::new("clickhouse/clickhouse-server", "24.8")
        .with_exposed_port(8123.tcp())
        .with_env_var("CLICKHOUSE_PASSWORD", PASS)
        .start()
        .await
        .expect("start clickhouse");
    let port = c.get_host_port_ipv4(8123).await.unwrap();
    let params = ChConnParams { host: "localhost".into(), port, database: "default".into(), user: "default".into(), password: PASS.into(), ssl: false };
    let mut drv = retry("clickhouse", || ChDriver::connect(&params)).await;
    drv.exec("CREATE TABLE it_ch (id UInt64, v UInt64) ENGINE = MergeTree ORDER BY id").await.unwrap();
    drv.exec("INSERT INTO it_ch SELECT number, number % 100 FROM numbers(50000)").await.unwrap();

    async fn ch_plan(drv: &mut ChDriver, q: &str) -> plan::QueryPlan {
        let StatementOutcome::Rows { result } = drv.exec(&format!("EXPLAIN indexes = 1 {q}")).await.unwrap() else { panic!("rows") };
        let text = result.rows.iter().filter_map(|r| r.as_object().and_then(|o| o.values().next())).filter_map(|v| v.as_str()).collect::<Vec<_>>().join("\n");
        plan::parse_clickhouse(&text)
    }

    // full read — predicate on non-key column v
    let full = ch_plan(&mut drv, "SELECT * FROM it_ch WHERE v = 7").await;
    // key read — predicate on the ORDER BY key id (uses PrimaryKey index)
    let key = ch_plan(&mut drv, "SELECT * FROM it_ch WHERE id = 42").await;

    artifact(
        "clickhouse-fullread-vs-key",
        &[
            ("FULL READ (WHERE v=7) — raw", full.raw.clone()),
            ("FULL READ — normalized", pretty(&full)),
            ("KEY READ (WHERE id=42) — raw", key.raw.clone()),
            ("KEY READ — normalized", pretty(&key)),
        ],
    );

    let froot = full.root.clone().expect("full root");
    let kroot = key.root.clone().expect("key root");
    assert_eq!(full.mode, "estimated", "ClickHouse EXPLAIN is estimated/structural");
    assert!(any(&froot, &|n| n.operation == "SeqScan"), "full read has a ReadFromMergeTree→SeqScan node");
    // raw PRESERVES the physical truth (this part is honest):
    assert!(full.raw.contains("Granules: 6/6") && full.raw.contains("Condition: true"), "full read scans ALL granules (no pruning): {}", full.raw);
    assert!(key.raw.contains("Granules: 1/6"), "key read prunes to 1/6 granules: {}", key.raw);
    // DEFECT DEF-CH-GRANULE-BLIND (Medium, DBA): parse_clickhouse (plan.rs:289) sets
    // uses_index=true on the mere presence of a "PrimaryKey" block and ignores
    // Condition:true / Granules N/N. So the full-granule read (6/6) is NOT flagged
    // — identical hotspot/warning state to the efficient 1/6-granule key lookup.
    let full_flagged = any(&froot, &|n| n.is_hotspot) || !full.summary.warnings.is_empty();
    let key_flagged = any(&kroot, &|n| n.is_hotspot) || !key.summary.warnings.is_empty();
    assert!(!full_flagged, "observed: full-granule read not flagged (documents the defect)");
    assert!(!key_flagged, "key read not flagged (correct)");
    eprintln!(
        "CHK xv_t2_clickhouse — DEFECT DEF-CH-GRANULE-BLIND: full(6/6 granules) flagged={} vs key(1/6) flagged={} — indistinguishable",
        full_flagged, key_flagged
    );
}

// ===========================================================================
// TIER 2d — Cassandra TRACING (NOT a planner). OBS-1: no fabricated cost/rows;
// record the mode the app emits so the render severity can be judged.
// ===========================================================================
async fn start_cassandra() -> (ContainerAsync<GenericImage>, u16) {
    let c = GenericImage::new("cassandra", "5.0")
        .with_exposed_port(9042.tcp())
        .with_env_var("HEAP_NEWSIZE", "128M")
        .with_env_var("MAX_HEAP_SIZE", "512M")
        .start()
        .await
        .expect("start cassandra");
    let port = c.get_host_port_ipv4(9042).await.unwrap();
    (c, port)
}

#[tokio::test]
async fn xv_t2_cassandra_tracing_no_fabricated_cost() {
    use database_studio_lib::drivers::cassandra::{CassandraConnParams, CassandraDriver};
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
                panic!("cassandra 240s timeout — last: {last}");
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    };
    drv.exec_cql("CREATE KEYSPACE IF NOT EXISTS xv_ks WITH replication = {'class':'SimpleStrategy','replication_factor':1}", None, None).await.unwrap();
    drv.exec_cql("CREATE TABLE xv_ks.t (pk int PRIMARY KEY, v int)", None, None).await.unwrap();
    for i in 1..=20 {
        drv.exec_cql(&format!("INSERT INTO xv_ks.t (pk, v) VALUES ({i}, {})", i * 10), None, None).await.unwrap();
    }

    // ALLOW FILTERING (no partition key) — the "expensive" path
    let cql_filter = "SELECT * FROM xv_ks.t WHERE v = 30 ALLOW FILTERING";
    let (w1, e1) = drv.trace_cql(cql_filter).await.expect("trace filter");
    let p_filter = plan::parse_cassandra_trace(cql_filter, &w1, &e1);
    // partition-key lookup — the efficient path
    let cql_key = "SELECT * FROM xv_ks.t WHERE pk = 5";
    let (w2, e2) = drv.trace_cql(cql_key).await.expect("trace key");
    let p_key = plan::parse_cassandra_trace(cql_key, &w2, &e2);

    artifact(
        "cassandra-tracing",
        &[
            ("ALLOW FILTERING — raw trace", p_filter.raw.clone()),
            ("ALLOW FILTERING — normalized (OBS-1: inspect mode + node op)", pretty(&p_filter)),
            ("PARTITION KEY — raw trace", p_key.raw.clone()),
            ("PARTITION KEY — normalized", pretty(&p_key)),
        ],
    );

    let froot = p_filter.root.clone().expect("filter root");
    // Honesty guarantees: no fabricated cost, no fabricated row estimates anywhere.
    assert!(p_filter.summary.total_cost.is_none(), "no fabricated total cost");
    fn no_fake_numbers(n: &plan::PlanNode) -> bool {
        n.estimated_rows.is_none() && n.estimated_cost.is_none() && n.children.iter().all(no_fake_numbers)
    }
    assert!(no_fake_numbers(&froot), "no fabricated estimated rows/cost in tracing tree");
    assert!(froot.is_hotspot, "ALLOW FILTERING flagged as hotspot");
    assert!(p_filter.summary.warnings.iter().any(|w| w.to_uppercase().contains("ALLOW FILTERING")), "ALLOW FILTERING warning");
    assert!(!p_key.root.clone().unwrap().is_hotspot, "partition-key query → not a hotspot");
    // OBS-1 evidence: record the mode the app emits (design smell if 'actual').
    eprintln!("CHK xv_t2_cassandra_tracing OK — OBS-1 mode emitted = '{}'", p_filter.mode);
}
