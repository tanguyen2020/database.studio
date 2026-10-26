//! OpenSearch (SPEC-OPENSEARCH.md) against REAL OpenSearch 3.9 containers.
//!
//! `os_fixture_replays_on_real_opensearch` replays tests/fixtures/opensearch-requests.json
//! — every request the OpenSearch screens send, generated from the app's own code by
//! src/lib/elastic/os-fixture.test.ts — and checks each answer. The security test runs
//! the security screen's request bodies on a secured cluster and proves their EFFECT
//! by signing in as the user it creates.
//!
//! Run methodology (per CLAUDE.md): prebuild, then run synchronously, one at a time:
//!   cargo test --test opensearch_integration --no-run
//!   timeout 900 cargo test --test opensearch_integration -- --nocapture --test-threads=1

use std::time::{Duration, Instant};

use database_studio_lib::drivers::elasticsearch::{describe_error, EsConnParams, EsDriver, EsResponse};
use database_studio_lib::drivers::types::StatementOutcome;
use serde_json::{json, Value};
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

const IMAGE: &str = "opensearchproject/opensearch";
/// OpenSearch major to test (3 by default); `DS_OS_TAG=2.19.7` runs the same suite on 2.x.
fn tag() -> String {
    std::env::var("DS_OS_TAG").unwrap_or_else(|_| "3".into())
}
const ADMIN_PASSWORD: &str = "DbStudio!2026x";
const FIXTURE: &str = include_str!("fixtures/opensearch-requests.json");

async fn start(security: bool) -> (ContainerAsync<GenericImage>, u16) {
    let tag = tag();
    let mut img = GenericImage::new(IMAGE, &tag)
        .with_exposed_port(9200.tcp())
        .with_env_var("discovery.type", "single-node")
        .with_env_var("OPENSEARCH_JAVA_OPTS", "-Xms768m -Xmx768m")
        .with_env_var("path.repo", "/tmp/os-snapshots")
        .with_env_var("cluster.routing.allocation.disk.threshold_enabled", "false");
    img = if security {
        // the demo security config, REST over plain HTTP (TLS is the Elasticsearch suite's job)
        img.with_env_var("OPENSEARCH_INITIAL_ADMIN_PASSWORD", ADMIN_PASSWORD)
            .with_env_var("plugins.security.ssl.http.enabled", "false")
    } else {
        img.with_env_var("DISABLE_SECURITY_PLUGIN", "true").with_env_var("DISABLE_INSTALL_DEMO_CONFIG", "true")
    };
    let c = img.start().await.expect("start opensearch container (Docker daemon must be running)");
    let port = c.get_host_port_ipv4(9200).await.unwrap();
    (c, port)
}

fn params(port: u16, user: &str, password: &str) -> EsConnParams {
    EsConnParams {
        host: "localhost".into(),
        port,
        auth: if user.is_empty() { "none".into() } else { "basic".into() },
        user: user.into(),
        password: password.into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    }
}

async fn connect(p: EsConnParams) -> EsDriver {
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match EsDriver::connect(&p).await {
            Ok(d) => {
                let h = d.request("GET", "/_cluster/health?wait_for_status=yellow&timeout=30s", None).await;
                if matches!(&h, Ok(r) if r.ok) {
                    return d;
                }
            }
            Err(e) => assert!(Instant::now() < deadline, "opensearch: timed out waiting — last: {}", e.message),
        }
        assert!(Instant::now() < deadline, "opensearch: cluster never became ready");
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

async fn req(d: &EsDriver, method: &str, path: &str, body: Option<String>) -> EsResponse {
    d.request(method, path, body).await.expect("request reaches the cluster")
}

fn text_of(r: &EsResponse) -> String {
    r.json.as_ref().map(|j| j.to_string()).or_else(|| r.text.clone()).unwrap_or_default()
}

fn fill(s: &str, vars: &std::collections::HashMap<String, String>) -> String {
    let mut out = s.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("__{k}__"), v);
    }
    out
}

/// Replays every request of the OpenSearch screens (fixture) on a real cluster, then
/// checks what the driver itself does on OpenSearch: detection, SQL through the
/// Query Editor path with cursor paging, readable plugin errors, and why the
/// Elasticsearch-only routes are never called.
#[tokio::test]
async fn os_fixture_replays_on_real_opensearch() {
    let (_c, port) = start(false).await;
    let d = connect(params(port, "", "")).await;

    // ---- detection: GET / says opensearch; Test connection names it ----
    assert_eq!(d.info().distribution, "opensearch");
    let major = tag().split('.').next().unwrap_or("3").to_string();
    assert!(d.info().version.starts_with(&format!("{major}.")), "version {}", d.info().version);
    assert!(d.is_opensearch());
    let t = EsDriver::test(&params(port, "", "")).await;
    assert!(t.ok, "{:?}", t.error);
    assert!(t.server_version.as_deref().unwrap_or("").starts_with(&format!("OpenSearch {major}.")), "{:?}", t.server_version);

    // ---- the fixture, step by step ----
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut vars = std::collections::HashMap::new();
    let steps = fixture["steps"].as_array().unwrap();
    for (i, s) in steps.iter().enumerate() {
        let title = s["title"].as_str().unwrap();
        let method = s["method"].as_str().unwrap();
        let mut path = fill(s["path"].as_str().unwrap(), &vars);
        let body = if let Some(nd) = s["ndjson"].as_str() {
            Some(nd.to_string())
        } else if s.get("body").is_some_and(|b| !b.is_null()) {
            Some(fill(&s["body"].to_string(), &vars))
        } else {
            None
        };
        // the app reads the version right before an update (O14)
        if let Some(get) = s["concurrency"].as_str() {
            let cur = req(&d, "GET", &fill(get, &vars), None).await;
            assert!(cur.ok, "[{i}] {title}: read the version → {} {}", cur.status, text_of(&cur));
            let j = cur.json.unwrap_or(Value::Null);
            let (seq, term) = (j["_seq_no"].as_i64().expect("_seq_no"), j["_primary_term"].as_i64().expect("_primary_term"));
            path = format!("{path}{}if_seq_no={seq}&if_primary_term={term}", if path.contains('?') { '&' } else { '?' });
        }
        let r = req(&d, method, &path, body).await;
        let want: Vec<u16> = s["expect"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u16).collect();
        assert!(want.contains(&r.status), "[{i}] {title}: {method} {path} → {} (want {want:?}) {}", r.status, text_of(&r));
        if let Some(c) = s["contains"].as_str() {
            assert!(text_of(&r).replace(' ', "").contains(&c.replace(' ', "")), "[{i}] {title}: answer lacks {c}: {}", text_of(&r));
        }
        if let Some(sv) = s.get("save").filter(|v| !v.is_null()) {
            let v = r.json.as_ref().and_then(|j| j[sv["field"].as_str().unwrap()].as_str()).expect("saved field").to_string();
            vars.insert(sv["name"].as_str().unwrap().to_string(), v);
        }
        eprintln!("CHK [{i:02}] {title} → {}", r.status);
    }
    assert!(vars.contains_key("monitor"), "the monitor id was captured and reused");

    // the managed-index round trip really happened: the explain after "add" names the policy
    // (ISM records it ~1–2 s later — the lifecycle tab waits the same way)
    req(&d, "POST", "/_plugins/_ism/add/books", Some(json!({ "policy_id": "it-lifecycle" }).to_string())).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let e = req(&d, "GET", "/_plugins/_ism/explain/books", None).await.json.unwrap_or(Value::Null);
        if e["books"]["policy_id"] == json!("it-lifecycle") {
            break;
        }
        assert!(Instant::now() < deadline, "ISM never recorded the policy: {e}");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    req(&d, "POST", "/_plugins/_ism/remove/books", None).await;

    // ---- SQL through the Query Editor path: _plugins/_sql + cursor beyond one page ----
    let mut lines = String::new();
    for i in 0..2_500 {
        lines.push_str("{\"index\":{}}\n");
        lines.push_str(&format!("{{\"n\":{i},\"tag\":\"t{}\"}}\n", i % 7));
    }
    let r = req(&d, "POST", "/many/_bulk?refresh=true", Some(lines)).await;
    assert!(r.ok, "bulk many → {}", r.status);
    match d.exec_sql("SELECT n, tag FROM many").await.expect("OpenSearch SQL") {
        StatementOutcome::Rows { result } => {
            assert_eq!(result.rows.len(), 2_500, "every row, across cursor pages of 1000");
            assert_eq!(result.cols.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), vec!["n", "tag"]);
        }
        o => panic!("expected rows, got {o:?}"),
    }
    let e = d.exec_sql("SELEC nope").await.expect_err("bad SQL");
    assert!(e.message.contains("Query must start with SELECT"), "details reach the user: {}", e.message);

    // ---- why the app never calls the Elasticsearch-only routes on OpenSearch ----
    for (m, p) in [("POST", "/_sql?format=json"), ("POST", "/_query"), ("GET", "/_ilm/policy"), ("GET", "/_slm/policy"), ("GET", "/_security/_authenticate"), ("GET", "/_watcher/_query/watches"), ("GET", "/_enrich/policy")] {
        let r = req(&d, m, p, Some("{}".into())).await;
        assert!(matches!(r.status, 400 | 405), "{m} {p} → {} (expected the route to be missing)", r.status);
    }
    eprintln!("CHK opensearch fixture: {} steps OK", steps.len());
}

/// The security screen's requests (built by os-security.ts) on a secured cluster —
/// each one's effect proven by signing in as the user it creates.
#[tokio::test]
async fn os_security_users_roles_and_least_privilege_login() {
    let (_c, port) = start(true).await;
    let admin = connect(params(port, "admin", ADMIN_PASSWORD)).await;
    assert!(admin.is_opensearch());
    let fx: Value = serde_json::from_str(FIXTURE).unwrap();
    let sec = &fx["security"];
    let call = |v: &Value| (v["method"].as_str().unwrap().to_string(), v["path"].as_str().unwrap().to_string(), v["body"].to_string());
    let send = |d: &EsDriver, v: &Value| {
        let (m, p, b) = call(v);
        let d = d.clone();
        async move { req(&d, &m, &p, Some(b)).await }
    };

    // data the role is about
    let r = req(&admin, "PUT", "/books", Some(json!({ "settings": { "number_of_replicas": 0 }, "mappings": { "properties": { "title": { "type": "keyword" }, "genre": { "type": "keyword" }, "pages": { "type": "integer" } } } }).to_string())).await;
    assert!(r.ok, "{}", text_of(&r));
    let bulk = "{\"index\":{}}\n{\"title\":\"Dune\",\"genre\":\"scifi\",\"pages\":412}\n{\"index\":{}}\n{\"title\":\"Emma\",\"genre\":\"drama\",\"pages\":474}\n{\"index\":{}}\n{\"title\":\"Solaris\",\"genre\":\"scifi\",\"pages\":204}\n";
    assert!(req(&admin, "POST", "/books/_bulk?refresh=true", Some(bulk.into())).await.ok);

    // ---- create user, role (DLS + FLS + tenant), mapping, action group, tenant ----
    for key in ["createUser", "role", "mapping", "actionGroup", "tenant"] {
        let r = send(&admin, &sec[key]).await;
        assert!(matches!(r.status, 200 | 201), "{key} → {} {}", r.status, text_of(&r));
    }
    let password = sec["password"].as_str().unwrap();
    let new_password = sec["newPassword"].as_str().unwrap();

    // ---- least-privilege login: GET / is refused (no cluster:monitor/main) but the app
    //      still connects through the security plugin's authinfo (O2) ----
    let reader = EsDriver::connect(&params(port, "it_reader", password)).await.expect("least-privilege user connects");
    assert_eq!(reader.info().distribution, "opensearch");
    assert!(reader.info().version.is_empty(), "version hidden from a user without monitor");
    assert!(reader.info().tagline.contains("it_reader"), "{}", reader.info().tagline);

    // ---- the role's effect: only scifi books (DLS), no pages field (FLS), no writes ----
    let hits = req(&reader, "POST", "/books/_search", Some(json!({ "query": { "match_all": {} } }).to_string())).await;
    assert!(hits.ok, "{}", text_of(&hits));
    let docs = hits.json.unwrap()["hits"]["hits"].as_array().unwrap().clone();
    assert_eq!(docs.len(), 2, "document-level security keeps only scifi: {docs:?}");
    for h in &docs {
        assert_eq!(h["_source"]["genre"], json!("scifi"));
        assert!(h["_source"].get("pages").is_none(), "field-level security hides pages: {h}");
    }
    let w = req(&reader, "POST", "/books/_doc", Some(json!({ "title": "x" }).to_string())).await;
    assert_eq!(w.status, 403, "read role cannot write: {}", text_of(&w));
    assert!(describe_error(w.status, &text_of(&w)).starts_with("Not allowed"));

    // ---- weak password refused with the server's reason (readable, not "OpenSearch 400") ----
    let weak = send(&admin, &sec["weakPassword"]).await;
    assert_eq!(weak.status, 400);
    assert_eq!(describe_error(400, &text_of(&weak)), "Elasticsearch 400: Weak password");

    // ---- patch: new backend roles + password; the old password stops working ----
    let p = send(&admin, &sec["patchUser"]).await;
    assert!(p.ok, "{}", text_of(&p));
    assert!(EsDriver::connect(&params(port, "it_reader", new_password)).await.is_ok(), "new password signs in");
    let old = EsDriver::connect(&params(port, "it_reader", password)).await;
    assert!(old.is_err(), "old password refused");
    let u = req(&admin, "GET", "/_plugins/_security/api/internalusers/it_reader", None).await.json.unwrap();
    assert_eq!(u["it_reader"]["backend_roles"], json!(["it_team", "readers"]));

    // ---- unmapping removes the role's access (the user still signs in) ----
    let um = send(&admin, &sec["unmapping"]).await;
    assert!(um.ok, "{}", text_of(&um));
    let reader2 = EsDriver::connect(&params(port, "it_reader", new_password)).await.expect("still signs in");
    let denied = req(&reader2, "POST", "/books/_search", Some("{}".into())).await;
    assert_eq!(denied.status, 403, "no role, no search: {}", text_of(&denied));

    // ---- built-in objects are protected; deletes clean up ----
    let r = req(&admin, "DELETE", "/_plugins/_security/api/roles/all_access", None).await;
    assert_eq!(r.status, 403);
    assert!(describe_error(403, &text_of(&r)).contains("static"), "{}", text_of(&r));
    for p in ["internalusers/it_reader", "rolesmapping/it_books_reader", "roles/it_books_reader", "actiongroups/it_read_only", "tenants/it_team"] {
        let r = req(&admin, "DELETE", &format!("/_plugins/_security/api/{p}"), None).await;
        assert!(r.ok, "delete {p} → {} {}", r.status, text_of(&r));
    }
    assert!(EsDriver::connect(&params(port, "it_reader", new_password)).await.is_err(), "deleted user cannot sign in");
    eprintln!("CHK opensearch security OK");
}
