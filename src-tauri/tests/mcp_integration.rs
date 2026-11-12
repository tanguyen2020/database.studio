//! MCP server — data-path integration against a real PostgreSQL container.
//!
//! Drives `mcp::dispatch::handle_inner(&AppState, None, json)` directly (the same
//! routine the axum endpoint calls per request; `None` = no Tauri AppHandle, so no
//! approval popup — these cases use Auto mode / are blocked by policy before any
//! approval). The bearer-token 401 path is a pure unit test in `mcp::mod`.
//!
//! Covers SPEC-MCP-SERVER.md §5: initialize → tools/list → run_query SELECT (result
//! correct + capped) → INSERT blocked when writes off → connection not opted-in.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
use database_studio_lib::connections::registry::Registry;
use database_studio_lib::drivers::types::SystemType;
use database_studio_lib::mcp::config::{ApprovalMode, ConnPolicy, McpConfig};
use database_studio_lib::mcp::{config, dispatch};
use database_studio_lib::state::AppState;
use database_studio_lib::storage::Storage;
use serde_json::{json, Value};
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};

const PASS: &str = "test123";
static STORE: AtomicU32 = AtomicU32::new(0);

/// The registry's statement future nests deeply; the default test thread stack
/// (2 MB) overflows in a debug build. Run on a runtime with 32 MB worker stacks
/// (same as the other integration suites).
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
        }
    });
}

fn app_state() -> AppState {
    AppState {
        storage: Storage::open(std::env::temp_dir().join(format!(
            "ds-mcp-it-store-{}-{}",
            std::process::id(),
            STORE.fetch_add(1, Ordering::SeqCst)
        )))
        .unwrap(),
        registry: Registry::default(),
        pubsub: Default::default(),
        kafka_stops: Default::default(),
        test_cancels: Default::default(),
        export_cancels: Default::default(),
        mcp: Default::default(),
    }
}

fn pg_profile(id: &str, port: u16) -> ConnectionProfile {
    ConnectionProfile {
        id: id.into(),
        name: id.into(),
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
        cassandra_dc: "datacenter1".into(),
        cassandra_consistency: String::new(),
        cassandra_flavor: String::new(),
        admin_url: String::new(),
    }
}

async fn connect(state: &AppState, p: ConnectionProfile) {
    // Dispatch reads connection metadata from storage (list_connections /
    // get_connection), so persist the profile as the app would before connecting.
    state.storage.save_connection(&p).unwrap();
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match state.registry.connect(p.clone(), PASS.into(), String::new()).await {
            Ok(_) => return,
            Err(e) => {
                assert!(Instant::now() < deadline, "connect timed out: {e:?}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

/// Call a tool and return the parsed JSON inside the single text content block,
/// plus whether the result was flagged isError.
async fn call(state: &AppState, name: &str, args: Value) -> (Value, bool) {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } });
    let resp = dispatch::handle_inner(state, None, body).await.expect("request gets a response");
    let result = &resp["result"];
    let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
    let text = result["content"][0]["text"].as_str().unwrap_or("");
    let parsed = serde_json::from_str::<Value>(text).unwrap_or(Value::String(text.to_string()));
    (parsed, is_error)
}

#[test]
fn mcp_data_path_initialize_list_query_cap_and_policy() {
    on_big_stack(data_path_test());
}

async fn data_path_test() {
    let c = GenericImage::new("postgres", "16-alpine")
        .with_exposed_port(5432.tcp())
        .with_env_var("POSTGRES_PASSWORD", PASS)
        .with_env_var("POSTGRES_DB", "testdb")
        .start()
        .await
        .expect("start postgres (Docker must be running)");
    let port = c.get_host_port_ipv4(5432).await.unwrap();

    let state = app_state();
    connect(&state, pg_profile("c1", port)).await;

    // Seed 5 rows so the cap (3) is observable.
    state
        .registry
        .exec_statement("c1", "CREATE TABLE mcp_items (id int PRIMARY KEY, name text)".into())
        .await
        .unwrap()
        .unwrap();
    state
        .registry
        .exec_statement("c1", "INSERT INTO mcp_items VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')".into())
        .await
        .unwrap()
        .unwrap();

    // Policy: c1 readable (no writes), small cap, Auto (no approval popup).
    let mut cfg = McpConfig { enabled: true, approval_mode: ApprovalMode::Auto, row_cap: 3, ..Default::default() };
    cfg.connections.insert("c1".into(), ConnPolicy { read: true, write: false });
    config::save_config(&state.storage, &cfg).unwrap();

    // initialize
    let init = dispatch::handle_inner(&state, None, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }))
        .await
        .unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(init["result"]["serverInfo"]["name"], "database-studio");

    // tools/list — all six tools present
    let list = dispatch::handle_inner(&state, None, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
        .await
        .unwrap();
    let names: Vec<String> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    for want in ["list_connections", "list_schemas", "list_tables", "describe_table", "sample_rows", "run_query"] {
        assert!(names.contains(&want.to_string()), "missing tool {want}");
    }

    // list_connections only shows the opted-in one
    let (conns, err) = call(&state, "list_connections", json!({})).await;
    assert!(!err);
    let ids: Vec<String> = conns["connections"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().into()).collect();
    assert_eq!(ids, vec!["c1".to_string()]);

    // run_query SELECT — returns rows, capped to 3 of 5, truncated=true
    let (res, err) = call(&state, "run_query", json!({ "connection": "c1", "sql": "SELECT * FROM mcp_items ORDER BY id" })).await;
    assert!(!err, "read should succeed: {res}");
    assert_eq!(res["rows"].as_array().unwrap().len(), 3, "capped to row_cap");
    assert_eq!(res["rowCount"], 3);
    assert_eq!(res["truncated"], true);

    // an explicit smaller limit is honored
    let (res2, _) = call(&state, "run_query", json!({ "connection": "c1", "sql": "SELECT * FROM mcp_items ORDER BY id", "limit": 2 })).await;
    assert_eq!(res2["rows"].as_array().unwrap().len(), 2);

    // sample_rows works and respects the cap
    let (sample, serr) = call(&state, "sample_rows", json!({ "connection": "c1", "schema": "public", "table": "mcp_items" })).await;
    assert!(!serr, "sample_rows: {sample}");
    assert!(sample["rows"].as_array().unwrap().len() <= 3);

    // INSERT is blocked because writes are off for c1
    let (ins, ierr) = call(&state, "run_query", json!({ "connection": "c1", "sql": "INSERT INTO mcp_items VALUES (6,'f')" })).await;
    assert!(ierr, "write must be blocked");
    assert!(ins.as_str().unwrap_or("").to_lowercase().contains("read-only"), "reason mentions read-only: {ins}");
    // and nothing was written
    let (check, _) = call(&state, "run_query", json!({ "connection": "c1", "sql": "SELECT count(*) AS n FROM mcp_items" })).await;
    let n = &check["rows"][0];
    // count(*) comes back as a number or string depending on driver shaping
    let got = n.get("n").and_then(|v| v.as_i64()).or_else(|| n.get("n").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()));
    assert_eq!(got, Some(5), "INSERT did not run");

    // multi-statement is rejected by policy
    let (multi, merr) = call(&state, "run_query", json!({ "connection": "c1", "sql": "SELECT 1; SELECT 2" })).await;
    assert!(merr, "multi-statement blocked: {multi}");

    // a connection that is NOT opted in is refused (c2 unknown to config)
    let (no, nerr) = call(&state, "list_schemas", json!({ "connection": "c2" })).await;
    assert!(nerr, "not-opted-in refused: {no}");

    // allow writes, then the INSERT runs (still Auto, so no popup)
    let mut cfg2 = cfg.clone();
    cfg2.connections.insert("c1".into(), ConnPolicy { read: true, write: true });
    config::save_config(&state.storage, &cfg2).unwrap();
    let (w, werr) = call(&state, "run_query", json!({ "connection": "c1", "sql": "INSERT INTO mcp_items VALUES (6,'f')" })).await;
    assert!(!werr, "write allowed now: {w}");
    assert_eq!(w["affected"], 1);

    // audit log recorded the calls
    let audit = config::load_audit(&state.storage);
    assert!(audit.iter().any(|a| a.tool == "run_query" && a.outcome == "ok"));
    assert!(audit.iter().any(|a| a.outcome == "blocked"));
}
