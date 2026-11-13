//! MCP server — data-path integration against a real PostgreSQL container.
//!
//! Drives `mcp::dispatch::handle_inner(&AppState, None, json)` directly (the same
//! routine the axum endpoint calls per request; `None` = no Tauri AppHandle, so no
//! approval popup — these cases use Auto mode / are blocked by policy before any
//! approval). The bearer-token 401 path is a pure unit test in `mcp::mod`.
//!
//! Covers SPEC-MCP-SERVER.md §5: initialize → tools/list → run_query SELECT (result
//! correct + capped) → INSERT blocked when writes off → connection not opted-in;
//! the `database` argument (another database on the same server, via the same
//! per-database sub-connection the Explorer uses) + list_databases; protocol
//! revision negotiation and JSON-RPC batches; and the `--mcp-stdio` bridge run as
//! the real executable against a local endpoint.

#![recursion_limit = "256"]

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
use database_studio_lib::connections::registry::Registry;
use database_studio_lib::drivers::types::SystemType;
use database_studio_lib::mcp::config::{ApprovalMode, ConnPolicy, McpConfig};
use database_studio_lib::mcp::{config, dispatch};
use database_studio_lib::state::AppState;
use database_studio_lib::storage::{crypto, Storage};
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

async fn connect(state: &AppState, mut p: ConnectionProfile) {
    // Dispatch reads connection metadata from storage (list_connections /
    // get_connection), so persist the profile as the app would before connecting.
    // The password is stored encrypted, as the app does: opening another database
    // (the `database` argument) re-reads credentials from storage.
    crypto::set_key_dir(std::env::temp_dir().join("ds-mcp-it-key"));
    p.password_enc = crypto::encrypt(PASS).unwrap();
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

    // initialize — the server answers with the revision the client asked for when
    // it speaks it (old Claude clients 2024-11-05, newer clients 2025-06-18), else
    // with its newest.
    for (asked, answered) in [("2024-11-05", "2024-11-05"), ("2025-03-26", "2025-03-26"), ("2025-06-18", "2025-06-18"), ("1999-01-01", "2025-06-18")] {
        let init = dispatch::handle_inner(
            &state,
            None,
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": asked, "capabilities": {}, "clientInfo": { "name": "it", "version": "1" } } }),
        )
        .await
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], answered, "asked {asked}");
        assert_eq!(init["result"]["serverInfo"]["name"], "database-studio");
    }

    // JSON-RPC batch (2024-11-05 / 2025-03-26): one reply per request, none for the
    // notification; a notification-only body answers nothing.
    let batch = dispatch::handle_message(
        &state,
        None,
        json!([
            { "jsonrpc": "2.0", "id": 10, "method": "ping" },
            { "jsonrpc": "2.0", "method": "notifications/initialized" },
            { "jsonrpc": "2.0", "id": 11, "method": "tools/list" }
        ]),
    )
    .await
    .unwrap();
    let ids: Vec<i64> = batch.as_array().unwrap().iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![10, 11]);
    assert!(dispatch::handle_message(&state, None, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.is_none());
    // probes some clients send are answered (empty), not "method not found"
    let res = dispatch::handle_inner(&state, None, json!({ "jsonrpc": "2.0", "id": 12, "method": "resources/list" })).await.unwrap();
    assert_eq!(res["result"]["resources"], json!([]));

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
    for want in ["list_connections", "list_databases", "list_schemas", "list_tables", "describe_table", "sample_rows", "run_query"] {
        assert!(names.contains(&want.to_string()), "missing tool {want}");
    }
    // read tools are flagged read-only; run_query is not
    for t in list["result"]["tools"].as_array().unwrap() {
        let ro = t["annotations"]["readOnlyHint"].as_bool().unwrap();
        assert_eq!(ro, t["name"] != "run_query", "readOnlyHint of {}", t["name"]);
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

    // ---- another database on the same server -------------------------------
    // PostgreSQL binds one database per connection; the `database` argument opens
    // the per-database sub-connection (`c1::otherdb`) the Explorer also uses.
    state.registry.exec_statement("c1", "CREATE DATABASE otherdb".into()).await.unwrap().unwrap();
    let (dbs, derr) = call(&state, "list_databases", json!({ "connection": "c1" })).await;
    assert!(!derr, "list_databases: {dbs}");
    let db_names: Vec<&str> = dbs["databases"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect();
    assert!(db_names.contains(&"testdb") && db_names.contains(&"otherdb"), "{db_names:?}");
    let current: Vec<&str> = dbs["databases"].as_array().unwrap().iter().filter(|d| d["current"] == true).map(|d| d["name"].as_str().unwrap()).collect();
    assert_eq!(current, vec!["testdb"]);

    // write in otherdb (writes are allowed on c1 now), then read it back
    let (_, e1) = call(&state, "run_query", json!({ "connection": "c1", "database": "otherdb", "sql": "CREATE TABLE other_items (id int PRIMARY KEY, label text)" })).await;
    assert!(!e1);
    let (_, e2) = call(&state, "run_query", json!({ "connection": "c1", "database": "otherdb", "sql": "INSERT INTO other_items VALUES (1,'x'),(2,'y')" })).await;
    assert!(!e2);
    let (cur, _) = call(&state, "run_query", json!({ "connection": "c1", "database": "otherdb", "sql": "SELECT current_database() AS db" })).await;
    assert_eq!(cur["rows"][0]["db"], "otherdb", "ran in the requested database");
    let (cur0, _) = call(&state, "run_query", json!({ "connection": "c1", "sql": "SELECT current_database() AS db" })).await;
    assert_eq!(cur0["rows"][0]["db"], "testdb", "no database = the connection's own");

    // every read tool honours `database`
    let (tables, terr) = call(&state, "list_tables", json!({ "connection": "c1", "database": "otherdb", "schema": "public" })).await;
    assert!(!terr);
    let tnames: Vec<&str> = tables["tables"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(tnames, vec!["other_items"], "only otherdb's tables");
    let (desc, _) = call(&state, "describe_table", json!({ "connection": "c1", "database": "otherdb", "schema": "public", "table": "other_items" })).await;
    assert_eq!(desc["columns"].as_array().unwrap().len(), 2);
    let (srows, serr2) = call(&state, "sample_rows", json!({ "connection": "c1", "database": "otherdb", "schema": "public", "table": "other_items" })).await;
    assert!(!serr2, "{srows}");
    assert_eq!(srows["rows"].as_array().unwrap().len(), 2);
    let (schemas, _) = call(&state, "list_schemas", json!({ "connection": "c1", "database": "otherdb" })).await;
    assert!(schemas["schemas"].as_array().unwrap().iter().any(|s| s["name"] == "public"));
    // the table does not exist in the connection's own database
    let (_, miss) = call(&state, "sample_rows", json!({ "connection": "c1", "schema": "public", "table": "other_items" })).await;
    assert!(miss, "other_items is only in otherdb");

    // writes in another database follow the same per-connection switch
    config::save_config(&state.storage, &cfg).unwrap(); // writes off again
    let (wb, wberr) = call(&state, "run_query", json!({ "connection": "c1", "database": "otherdb", "sql": "DELETE FROM other_items" })).await;
    assert!(wberr && wb.as_str().unwrap_or("").contains("read-only"), "{wb}");
    let (still, _) = call(&state, "sample_rows", json!({ "connection": "c1", "database": "otherdb", "schema": "public", "table": "other_items" })).await;
    assert_eq!(still["rows"].as_array().unwrap().len(), 2, "DELETE did not run");

    // a database that does not exist is a clear error
    let (bad, berr) = call(&state, "list_schemas", json!({ "connection": "c1", "database": "no_such_db" })).await;
    assert!(berr && bad.as_str().unwrap_or("").contains("no_such_db"), "{bad}");

    // audit log recorded the calls, with the database they ran in
    let audit = config::load_audit(&state.storage);
    assert!(audit.iter().any(|a| a.tool == "run_query" && a.outcome == "ok"));
    assert!(audit.iter().any(|a| a.outcome == "blocked"));
    assert!(audit.iter().any(|a| a.connection.as_deref() == Some("c1 · otherdb")), "activity shows the database");

    // ---- stdio bridge -------------------------------------------------------
    // The real executable started with `--mcp-stdio`, pointed (DS_MCP_URL /
    // DS_MCP_TOKEN) at a local endpoint serving this same state.
    stdio_bridge_round_trip(state).await;
}

async fn stdio_bridge_round_trip(state: AppState) {
    use axum::{body::Bytes, http::{HeaderMap, StatusCode}, response::IntoResponse, routing::post, Router};
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    const TOKEN: &str = "bridge-test-token";
    let state = Arc::new(state);
    let st = state.clone();
    let app = Router::new().route(
        "/mcp",
        post(move |headers: HeaderMap, body: Bytes| {
            let st = st.clone();
            async move {
                let auth = headers.get("authorization").and_then(|v| v.to_str().ok());
                if let Err((code, msg)) = database_studio_lib::mcp::authorize(true, TOKEN, auth) {
                    return (code, msg).into_response();
                }
                let msg: Value = serde_json::from_slice(&body).unwrap();
                match dispatch::handle_message(&st, None, msg).await {
                    Some(r) => axum::Json(r).into_response(),
                    None => StatusCode::ACCEPTED.into_response(),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_database-studio"))
        .arg("--mcp-stdio")
        .env("DS_MCP_URL", format!("http://127.0.0.1:{port}/mcp"))
        .env("DS_MCP_TOKEN", TOKEN)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the app executable in bridge mode");
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap()).lines();

    let send = |v: Value| format!("{}
", serde_json::to_string(&v).unwrap());
    stdin
        .write_all(send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "it", "version": "1" } } })).as_bytes())
        .await
        .unwrap();
    // a notification must produce NO line on stdout
    stdin.write_all(send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).as_bytes()).await.unwrap();
    stdin.write_all(send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).as_bytes()).await.unwrap();
    stdin
        .write_all(send(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "sample_rows", "arguments": { "connection": "c1", "database": "otherdb", "schema": "public", "table": "other_items" } } })).as_bytes())
        .await
        .unwrap();
    stdin.write_all(b"this is not json
").await.unwrap();

    let mut replies = std::collections::HashMap::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    while replies.len() < 4 {
        assert!(Instant::now() < deadline, "bridge answered only {replies:?}");
        let line = tokio::time::timeout(Duration::from_secs(60), out.next_line()).await.expect("bridge reply").unwrap().expect("bridge line");
        let v: Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("stdout must carry only JSON-RPC, got {line:?}"));
        replies.insert(v["id"].to_string(), v);
    }
    assert_eq!(replies["1"]["result"]["protocolVersion"], "2025-06-18");
    assert!(replies["2"]["result"]["tools"].as_array().unwrap().len() >= 7);
    let text = replies["3"]["result"]["content"][0]["text"].as_str().unwrap();
    let rows: Value = serde_json::from_str(text).unwrap();
    assert_eq!(rows["rows"].as_array().unwrap().len(), 2, "query ran through the bridge");
    assert_eq!(replies["null"]["error"]["code"], -32700, "bad line answered with a parse error");

    // closing stdin ends the bridge cleanly
    drop(stdin);
    let status = tokio::time::timeout(Duration::from_secs(20), child.wait()).await.expect("bridge exits").unwrap();
    assert!(status.success());

    // a wrong token yields a JSON-RPC error the agent can read (not a crash)
    let mut bad = tokio::process::Command::new(env!("CARGO_BIN_EXE_database-studio"))
        .arg("--mcp-stdio")
        .env("DS_MCP_URL", format!("http://127.0.0.1:{port}/mcp"))
        .env("DS_MCP_TOKEN", "wrong")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut bin = bad.stdin.take().unwrap();
    let mut bout = BufReader::new(bad.stdout.take().unwrap()).lines();
    bin.write_all(send(json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/list" })).as_bytes()).await.unwrap();
    let line = tokio::time::timeout(Duration::from_secs(30), bout.next_line()).await.unwrap().unwrap().unwrap();
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["id"], 9);
    assert!(v["error"]["message"].as_str().unwrap().contains("token"), "{v}");
    drop(bin);
    let _ = bad.wait().await;
}
