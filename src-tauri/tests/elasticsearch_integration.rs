//! Elasticsearch (REST API) against a REAL single-node cluster in a container.
//!
//! Every step sends the SAME requests the app's screens send (index browser,
//! console, management pages, SQL / ES|QL), then reads the cluster's state back to
//! verify — no hard-coded expected server output.
//!
//! Run methodology (per CLAUDE.md): prebuild, then run synchronously with a hard
//! timeout, one test at a time:
//!   cargo test --test elasticsearch_integration --no-run
//!   timeout 900 cargo test --test elasticsearch_integration -- --nocapture --test-threads=1

use std::time::{Duration, Instant};

use database_studio_lib::connections::profile::ConnectionProfile;
use database_studio_lib::drivers::elasticsearch::{EsConnParams, EsDriver, EsResponse};
use database_studio_lib::drivers::types::StatementOutcome;
use database_studio_lib::drivers::{Endpoint, LiveConnection};
use serde_json::{json, Value};
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

const IMAGE: &str = "docker.elastic.co/elasticsearch/elasticsearch";
const TAG: &str = "8.15.3";
const ELASTIC_PASSWORD: &str = "Ch4ngeMe!";

async fn start(security: bool) -> (ContainerAsync<GenericImage>, u16) {
    let mut img = GenericImage::new(IMAGE, TAG)
        .with_exposed_port(9200.tcp())
        .with_env_var("discovery.type", "single-node")
        .with_env_var("ES_JAVA_OPTS", "-Xms512m -Xmx512m")
        .with_env_var("xpack.security.http.ssl.enabled", "false")
        .with_env_var("path.repo", "/usr/share/elasticsearch/snapshots")
        .with_env_var("cluster.routing.allocation.disk.threshold_enabled", "false")
        .with_env_var("xpack.security.enabled", if security { "true" } else { "false" });
    if security {
        img = img.with_env_var("ELASTIC_PASSWORD", ELASTIC_PASSWORD);
    }
    let c = img.start().await.expect("start elasticsearch container (Docker daemon must be running)");
    let port = c.get_host_port_ipv4(9200).await.unwrap();
    (c, port)
}

fn params(port: u16, auth: &str, user: &str, password: &str) -> EsConnParams {
    EsConnParams {
        host: "localhost".into(),
        port,
        auth: auth.into(),
        user: user.into(),
        password: password.into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    }
}

async fn connect(p: EsConnParams) -> EsDriver {
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        match EsDriver::connect(&p).await {
            Ok(d) => {
                // wait until the cluster can actually serve (health at least yellow)
                let h = d.request("GET", "/_cluster/health?wait_for_status=yellow&timeout=30s", None).await;
                if matches!(&h, Ok(r) if r.ok) {
                    return d;
                }
            }
            Err(e) => assert!(Instant::now() < deadline, "elasticsearch: timed out waiting — last: {}", e.message),
        }
        assert!(Instant::now() < deadline, "elasticsearch: cluster never became ready");
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

async fn req(d: &EsDriver, method: &str, path: &str, body: Option<Value>) -> EsResponse {
    d.request(method, path, body.map(|b| b.to_string())).await.expect("request reaches the cluster")
}

async fn ok(d: &EsDriver, method: &str, path: &str, body: Option<Value>) -> Value {
    let r = req(d, method, path, body).await;
    assert!(r.ok, "{method} {path} → {} {:?}", r.status, r.json.as_ref().or(None).map(|j| j.to_string()).or(r.text));
    r.json.unwrap_or(Value::Null)
}

fn total(v: &Value) -> u64 {
    v["hits"]["total"]["value"].as_u64().expect("hits.total.value")
}

/// The developer loop on one cluster, through the exact requests the screens send:
/// create index (settings + mappings + alias) → bulk NDJSON → Discover search
/// (query_string, sort, from/size, histogram aggregation) → document CRUD →
/// mapping / settings edits → index actions → aliases → templates → pipelines
/// (+ simulate) → ILM → data stream → reindex / delete-by-query → snapshot +
/// restore → SQL (dispatch through LiveConnection, cursor) → ES|QL → console
/// error passthrough.
#[tokio::test]
async fn elasticsearch_end_to_end_without_security() {
    let (_c, port) = start(false).await;
    let d = connect(params(port, "", "", "")).await;

    // ---- connect / test / dispatch ------------------------------------------------
    let t = EsDriver::test(&params(port, "", "", "")).await;
    assert!(t.ok, "test failed: {:?}", t.error);
    assert!(t.server_version.as_deref().unwrap_or("").starts_with("Elasticsearch 8."), "{:?}", t.server_version);
    assert_eq!(d.info().version, TAG);

    let profile: ConnectionProfile = serde_json::from_value(json!({
        "id": "e1", "name": "es", "system": "elasticsearch", "host": "localhost", "port": port
    }))
    .unwrap();
    let ep = Endpoint { host: "localhost".into(), port };
    let mut live = LiveConnection::connect(&profile, &ep, "").await.expect("dispatch connect");
    assert!(live.ping().await);
    assert!(matches!(live, LiveConnection::Elasticsearch(_)));
    // the row-grid paths answer with a typed "not applicable" instead of panicking
    assert!(live.exec_params("SELECT 1", &[]).await.is_err());

    // a wrong port is reported as such
    let wrong = EsDriver::test(&params(1, "", "", "")).await;
    assert!(!wrong.ok);
    assert!(wrong.error.as_deref().unwrap_or("").contains("Cannot reach Elasticsearch"), "{:?}", wrong.error);

    // ---- create index (Create index dialog) ---------------------------------------
    ok(&d, "PUT", "/orders", Some(json!({
        "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
        "mappings": { "properties": {
            "@timestamp": { "type": "date" },
            "customer": { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
            "status": { "type": "keyword" },
            "amount": { "type": "double" },
            "items": { "type": "integer" }
        } },
        "aliases": { "orders-read": {} }
    }))).await;

    // ---- bulk NDJSON (console _bulk) ---------------------------------------------
    let mut nd = String::new();
    for i in 0..60 {
        let status = ["paid", "pending", "refunded"][i % 3];
        nd.push_str(&json!({ "index": { "_index": "orders", "_id": format!("o{i}") } }).to_string());
        nd.push('\n');
        nd.push_str(&json!({
            "@timestamp": format!("2026-10-{:02}T10:00:00Z", 1 + (i % 10)),
            "customer": format!("Customer {}", i % 7),
            "status": status, "amount": 10.5 * (i as f64 + 1.0), "items": (i % 5) + 1
        }).to_string());
        nd.push('\n');
    }
    let bulk = d.request("POST", "/_bulk?refresh=true", Some(nd)).await.unwrap();
    assert!(bulk.ok, "{:?}", bulk.json);
    assert_eq!(bulk.json.as_ref().unwrap()["errors"], json!(false));

    // the explorer's typed reads see it (docs count from _cat/indices)
    let idx = d.indices().await.unwrap();
    let orders = idx.iter().find(|i| i.name == "orders").expect("orders listed");
    assert_eq!(orders.docs_count, Some(60));
    assert_eq!(orders.status, "open");
    let ov = d.overview().await.unwrap();
    assert!(!ov.status.is_empty() && ov.number_of_nodes == 1, "{ov:?}");
    assert!(ov.docs.unwrap_or(0) >= 60);

    let fields = d.mapping_fields("orders").await.unwrap();
    assert!(fields.contains(&("customer.keyword".into(), "keyword".into())), "{fields:?}");
    assert!(fields.contains(&("@timestamp".into(), "date".into())));

    // ---- Discover search: query_string + sort + paging + date histogram ------------
    let s = ok(&d, "POST", "/orders/_search", Some(json!({
        "query": { "bool": { "filter": [
            { "query_string": { "query": "status:paid", "default_operator": "AND" } },
            { "range": { "@timestamp": { "gte": "2026-10-01T00:00:00Z", "lte": "2026-10-31T23:59:59Z" } } }
        ] } },
        "sort": [{ "amount": "desc" }],
        "from": 0, "size": 5, "track_total_hits": true,
        "aggs": { "histogram": { "date_histogram": { "field": "@timestamp", "fixed_interval": "1d" } } }
    }))).await;
    assert_eq!(total(&s), 20);
    let hits = s["hits"]["hits"].as_array().unwrap();
    assert_eq!(hits.len(), 5);
    let amounts: Vec<f64> = hits.iter().map(|h| h["_source"]["amount"].as_f64().unwrap()).collect();
    assert!(amounts.windows(2).all(|w| w[0] >= w[1]), "sorted desc: {amounts:?}");
    let buckets = s["aggregations"]["histogram"]["buckets"].as_array().unwrap();
    assert_eq!(buckets.iter().map(|b| b["doc_count"].as_u64().unwrap()).sum::<u64>(), 20);
    // page 2 continues where page 1 ended
    let s2 = ok(&d, "POST", "/orders/_search", Some(json!({
        "query": { "query_string": { "query": "status:paid" } }, "sort": [{ "amount": "desc" }], "from": 5, "size": 5
    }))).await;
    let first2 = s2["hits"]["hits"][0]["_source"]["amount"].as_f64().unwrap();
    assert!(first2 <= *amounts.last().unwrap());
    // field "terms" stats (Discover field popover)
    let top = ok(&d, "POST", "/orders/_search", Some(json!({
        "size": 0, "aggs": { "top": { "terms": { "field": "status", "size": 5 } } }
    }))).await;
    assert_eq!(top["aggregations"]["top"]["buckets"].as_array().unwrap().len(), 3);
    // _count (header total)
    assert_eq!(ok(&d, "POST", "/orders/_count", Some(json!({ "query": { "term": { "status": "pending" } } }))).await["count"], json!(20));

    // ---- document CRUD (flyout editor) ---------------------------------------------
    let created = ok(&d, "POST", "/orders/_doc?refresh=wait_for", Some(json!({ "customer": "New", "status": "paid", "amount": 1.0 }))).await;
    let new_id = created["_id"].as_str().unwrap().to_string();
    assert_eq!(created["result"], json!("created"));
    ok(&d, "PUT", &format!("/orders/_doc/{new_id}?refresh=wait_for"), Some(json!({ "customer": "Edited", "status": "paid", "amount": 2.0 }))).await;
    let got = ok(&d, "GET", &format!("/orders/_doc/{new_id}"), None).await;
    assert_eq!(got["_source"]["customer"], json!("Edited"));
    assert_eq!(got["_version"], json!(2));
    ok(&d, "POST", &format!("/orders/_update/{new_id}?refresh=wait_for"), Some(json!({ "doc": { "amount": 3.0 } }))).await;
    assert_eq!(ok(&d, "GET", &format!("/orders/_doc/{new_id}"), None).await["_source"]["amount"], json!(3.0));
    ok(&d, "DELETE", &format!("/orders/_doc/{new_id}?refresh=wait_for"), None).await;
    let gone = req(&d, "GET", &format!("/orders/_doc/{new_id}"), None).await;
    assert_eq!(gone.status, 404);
    assert_eq!(gone.json.unwrap()["found"], json!(false));

    // ---- mapping edit (add field) + settings edit -----------------------------------
    ok(&d, "PUT", "/orders/_mapping", Some(json!({ "properties": { "note": { "type": "text" } } }))).await;
    let m = ok(&d, "GET", "/orders/_mapping", None).await;
    assert_eq!(m["orders"]["mappings"]["properties"]["note"]["type"], json!("text"));
    // changing a field type is refused by the cluster (shown verbatim in the UI)
    let clash = req(&d, "PUT", "/orders/_mapping", Some(json!({ "properties": { "status": { "type": "long" } } }))).await;
    assert_eq!(clash.status, 400);
    ok(&d, "PUT", "/orders/_settings", Some(json!({ "index": { "refresh_interval": "5s", "number_of_replicas": 0 } }))).await;
    let st = ok(&d, "GET", "/orders/_settings?flat_settings=true", None).await;
    assert_eq!(st["orders"]["settings"]["index.refresh_interval"], json!("5s"));

    // ---- index actions --------------------------------------------------------------
    for a in ["_refresh", "_flush", "_cache/clear", "_forcemerge?max_num_segments=1"] {
        ok(&d, "POST", &format!("/orders/{a}"), None).await;
    }
    ok(&d, "POST", "/orders/_close", None).await;
    assert_eq!(d.indices().await.unwrap().iter().find(|i| i.name == "orders").unwrap().status, "close");
    let closed = req(&d, "POST", "/orders/_search", Some(json!({}))).await;
    assert_eq!(closed.status, 400, "searching a closed index is refused");
    ok(&d, "POST", "/orders/_open?wait_for_active_shards=1", None).await;
    let st2 = d.indices().await.unwrap();
    assert_eq!(st2.iter().find(|i| i.name == "orders").unwrap().status, "open");

    // ---- aliases ---------------------------------------------------------------------
    ok(&d, "POST", "/_aliases", Some(json!({ "actions": [{ "add": { "index": "orders", "alias": "sales" } }] }))).await;
    let al = ok(&d, "GET", "/_alias", None).await;
    assert!(al["orders"]["aliases"].get("sales").is_some() && al["orders"]["aliases"].get("orders-read").is_some());
    assert_eq!(total(&ok(&d, "POST", "/sales/_search", Some(json!({ "track_total_hits": true, "size": 0 }))).await), 60);
    ok(&d, "POST", "/_aliases", Some(json!({ "actions": [{ "remove": { "index": "orders", "alias": "sales" } }] }))).await;
    assert!(ok(&d, "GET", "/_alias", None).await["orders"]["aliases"].get("sales").is_none());

    // ---- component + index templates --------------------------------------------------
    ok(&d, "PUT", "/_component_template/ct-base", Some(json!({ "template": { "settings": { "number_of_replicas": 0 } } }))).await;
    ok(&d, "PUT", "/_index_template/logs-tpl", Some(json!({
        "index_patterns": ["applogs-*"], "composed_of": ["ct-base"], "priority": 200, "data_stream": {},
        "template": { "mappings": { "properties": { "@timestamp": { "type": "date" }, "message": { "type": "text" } } } }
    }))).await;
    let tp = ok(&d, "GET", "/_index_template/logs-tpl", None).await;
    assert_eq!(tp["index_templates"][0]["index_template"]["composed_of"], json!(["ct-base"]));
    // simulate the template an index name would get
    let sim = ok(&d, "POST", "/_index_template/_simulate_index/applogs-x", None).await;
    assert!(sim["template"]["mappings"]["properties"].get("message").is_some());

    // ---- data stream (from the template) -------------------------------------------
    ok(&d, "PUT", "/_data_stream/applogs-web", None).await;
    ok(&d, "POST", "/applogs-web/_doc?refresh=true", Some(json!({ "@timestamp": "2026-10-15T00:00:00Z", "message": "hello" }))).await;
    let ds = ok(&d, "GET", "/_data_stream/applogs-web", None).await;
    assert_eq!(ds["data_streams"][0]["name"], json!("applogs-web"));
    let backing = d.indices().await.unwrap();
    assert!(backing.iter().any(|i| i.data_stream.as_deref() == Some("applogs-web")), "backing index recognised");
    ok(&d, "POST", "/applogs-web/_rollover", None).await;
    assert_eq!(ok(&d, "GET", "/_data_stream/applogs-web", None).await["data_streams"][0]["indices"].as_array().unwrap().len(), 2);
    ok(&d, "DELETE", "/_data_stream/applogs-web", None).await;

    // ---- ingest pipeline + simulate ----------------------------------------------------
    ok(&d, "PUT", "/_ingest/pipeline/upper", Some(json!({
        "description": "uppercase status", "processors": [{ "uppercase": { "field": "status" } }, { "set": { "field": "ingested", "value": true } }]
    }))).await;
    let simp = ok(&d, "POST", "/_ingest/pipeline/upper/_simulate", Some(json!({ "docs": [{ "_source": { "status": "paid" } }] }))).await;
    assert_eq!(simp["docs"][0]["doc"]["_source"]["status"], json!("PAID"));
    ok(&d, "POST", "/orders/_doc/p1?pipeline=upper&refresh=wait_for", Some(json!({ "status": "late" }))).await;
    assert_eq!(ok(&d, "GET", "/orders/_doc/p1", None).await["_source"]["status"], json!("LATE"));

    // ---- ILM policy (basic license) ---------------------------------------------------
    ok(&d, "PUT", "/_ilm/policy/keep-30d", Some(json!({ "policy": { "phases": {
        "hot": { "actions": { "rollover": { "max_age": "7d" } } }, "delete": { "min_age": "30d", "actions": { "delete": {} } }
    } } }))).await;
    assert!(ok(&d, "GET", "/_ilm/policy/keep-30d", None).await["keep-30d"]["policy"]["phases"].get("delete").is_some());
    ok(&d, "DELETE", "/_ilm/policy/keep-30d", None).await;

    // ---- reindex + delete by query + update by query ----------------------------------
    let ri = ok(&d, "POST", "/_reindex?refresh=true", Some(json!({ "source": { "index": "orders", "query": { "term": { "status": "refunded" } } }, "dest": { "index": "orders-refunded" } }))).await;
    assert_eq!(ri["created"], json!(20));
    let dbq = ok(&d, "POST", "/orders-refunded/_delete_by_query?refresh=true", Some(json!({ "query": { "range": { "items": { "gte": 3 } } } }))).await;
    let left = total(&ok(&d, "POST", "/orders-refunded/_search", Some(json!({ "size": 0, "track_total_hits": true }))).await);
    assert_eq!(left + dbq["deleted"].as_u64().unwrap(), 20);
    let ubq = ok(&d, "POST", "/orders-refunded/_update_by_query?refresh=true", Some(json!({ "script": { "source": "ctx._source.status = 'archived'" } }))).await;
    assert_eq!(ubq["updated"].as_u64().unwrap(), left);

    // ---- snapshot repository + snapshot + restore --------------------------------------
    ok(&d, "PUT", "/_snapshot/local", Some(json!({ "type": "fs", "settings": { "location": "/usr/share/elasticsearch/snapshots/local" } }))).await;
    ok(&d, "POST", "/_snapshot/local/_verify", None).await;
    let snap = ok(&d, "PUT", "/_snapshot/local/snap-1?wait_for_completion=true", Some(json!({ "indices": "orders-refunded", "include_global_state": false }))).await;
    assert_eq!(snap["snapshot"]["state"], json!("SUCCESS"));
    let list = ok(&d, "GET", "/_snapshot/local/_all", None).await;
    assert_eq!(list["snapshots"].as_array().unwrap().len(), 1);
    ok(&d, "DELETE", "/orders-refunded", None).await;
    ok(&d, "POST", "/_snapshot/local/snap-1/_restore?wait_for_completion=true", Some(json!({ "indices": "orders-refunded" }))).await;
    ok(&d, "POST", "/orders-refunded/_refresh", None).await;
    assert_eq!(total(&ok(&d, "POST", "/orders-refunded/_search", Some(json!({ "size": 0, "track_total_hits": true }))).await), left);
    ok(&d, "DELETE", "/_snapshot/local/snap-1", None).await;

    // ---- cluster pages: health / nodes / shards / tasks / settings ---------------------
    let nodes = ok(&d, "GET", "/_nodes/stats/jvm,os,fs", None).await;
    assert_eq!(nodes["nodes"].as_object().unwrap().len(), 1);
    let shards = req(&d, "GET", "/_cat/shards?format=json&bytes=b", None).await;
    assert!(shards.json.unwrap().as_array().unwrap().iter().any(|s| s["index"] == "orders"));
    assert!(ok(&d, "GET", "/_tasks?detailed=true", None).await.get("nodes").is_some());
    ok(&d, "PUT", "/_cluster/settings", Some(json!({ "persistent": { "cluster.routing.allocation.enable": "all" } }))).await;
    assert_eq!(ok(&d, "GET", "/_cluster/settings?flat_settings=true", None).await["persistent"]["cluster.routing.allocation.enable"], json!("all"));
    // _cat without format=json comes back as text (console shows it verbatim)
    let cat = req(&d, "GET", "/_cat/indices?v", None).await;
    assert!(cat.json.is_none() && cat.text.as_deref().unwrap_or("").contains("orders"));

    // ---- SQL through the generic exec arm (Query Editor) -------------------------------
    let out = live.exec("SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY status").await.unwrap();
    match out {
        StatementOutcome::Rows { result } => {
            assert_eq!(result.cols[0].0, "status");
            let n: u64 = result.rows.iter().map(|r| r["n"].as_u64().unwrap()).sum();
            assert_eq!(n, 61, "60 bulk docs + the pipeline doc");
        }
        other => panic!("expected rows, got {other:?}"),
    }
    // cursor: fetch_size 1000 < rows → the driver follows the cursor
    let mut big = String::new();
    for i in 0..1500 {
        big.push_str(&format!("{{\"index\":{{\"_index\":\"many\"}}}}\n{{\"n\":{i}}}\n"));
    }
    assert!(d.request("POST", "/_bulk?refresh=true", Some(big)).await.unwrap().ok);
    match live.exec("SELECT n FROM many").await.unwrap() {
        StatementOutcome::Rows { result } => assert_eq!(result.rows.len(), 1500),
        other => panic!("expected rows, got {other:?}"),
    }
    let bad_sql = live.exec("SELEC wrong").await.unwrap_err();
    assert!(bad_sql.message.contains("parsing_exception") || bad_sql.message.contains("mismatched"), "{}", bad_sql.message);
    // translate (Query tab "Show DSL")
    let tr = ok(&d, "POST", "/_sql/translate", Some(json!({ "query": "SELECT * FROM orders WHERE status = 'paid'" }))).await;
    assert!(tr.get("query").is_some());
    // autocomplete introspection
    assert!(live.tables("").await.unwrap().iter().any(|t| t.name == "orders"));
    assert!(live.columns("", "orders").await.unwrap().iter().any(|c| c.name == "amount"));

    // ---- ES|QL --------------------------------------------------------------------------
    let q = ok(&d, "POST", "/_query?format=json", Some(json!({ "query": "FROM orders | STATS n = COUNT(*) BY status | SORT status | LIMIT 10" }))).await;
    let cols: Vec<&str> = q["columns"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert!(cols.contains(&"n") && cols.contains(&"status"));
    assert!(!q["values"].as_array().unwrap().is_empty());

    // ---- console: an error document is returned, not thrown ---------------------------
    let e = req(&d, "POST", "/orders/_search", Some(json!({ "query": { "mach": {} } }))).await;
    assert_eq!(e.status, 400);
    assert!(e.json.unwrap()["error"]["type"].as_str().unwrap().contains("parsing_exception"));
    let nf = req(&d, "GET", "/missing-index/_search", None).await;
    assert_eq!(nf.status, 404);
    assert!(d.request("GET", "http://example.com/x", None).await.is_err(), "absolute URLs are refused");

    // ---- delete index -------------------------------------------------------------------
    ok(&d, "DELETE", "/orders", None).await;
    assert!(!d.indices().await.unwrap().iter().any(|i| i.name == "orders"));
}

/// Security: basic auth (good/bad), API key auth, users + roles managed through
/// the Security screens, and a role's privileges enforced for a new user.
#[tokio::test]
async fn elasticsearch_security_users_roles_and_api_keys() {
    let (_c, port) = start(true).await;
    let admin = connect(params(port, "basic", "elastic", ELASTIC_PASSWORD)).await;

    let bad = EsDriver::test(&params(port, "basic", "elastic", "nope")).await;
    assert!(!bad.ok);
    assert!(bad.error.as_deref().unwrap_or("").starts_with("Authentication failed"), "{:?}", bad.error);
    let anon = EsDriver::test(&params(port, "none", "", "")).await;
    assert!(!anon.ok, "anonymous access is refused when security is on");

    ok(&admin, "PUT", "/books", Some(json!({ "settings": { "number_of_replicas": 0 } }))).await;
    ok(&admin, "POST", "/books/_doc/1?refresh=true", Some(json!({ "title": "Dune" }))).await;
    ok(&admin, "PUT", "/secret", Some(json!({ "settings": { "number_of_replicas": 0 } }))).await;

    // role: read-only on books
    ok(&admin, "PUT", "/_security/role/books_reader", Some(json!({
        "cluster": ["monitor"], "indices": [{ "names": ["books"], "privileges": ["read", "view_index_metadata"] }]
    }))).await;
    let roles = ok(&admin, "GET", "/_security/role", None).await;
    assert!(roles.get("books_reader").is_some());

    // user with that role
    ok(&admin, "PUT", "/_security/user/reader", Some(json!({ "password": "reader-pw-1", "roles": ["books_reader"], "full_name": "Book Reader" }))).await;
    let users = ok(&admin, "GET", "/_security/user", None).await;
    assert_eq!(users["reader"]["roles"], json!(["books_reader"]));

    let reader = connect(params(port, "basic", "reader", "reader-pw-1")).await;
    assert_eq!(total(&ok(&reader, "POST", "/books/_search", Some(json!({ "track_total_hits": true }))).await), 1);
    let w = req(&reader, "POST", "/books/_doc", Some(json!({ "title": "x" }))).await;
    assert_eq!(w.status, 403, "write denied by the role");
    let other = req(&reader, "POST", "/secret/_search", Some(json!({}))).await;
    assert_eq!(other.status, 403, "other index denied");
    let me = ok(&reader, "GET", "/_security/_authenticate", None).await;
    assert_eq!(me["username"], json!("reader"));

    // disable / enable / change password
    ok(&admin, "PUT", "/_security/user/reader/_disable", None).await;
    assert!(!EsDriver::test(&params(port, "basic", "reader", "reader-pw-1")).await.ok);
    ok(&admin, "PUT", "/_security/user/reader/_enable", None).await;
    ok(&admin, "POST", "/_security/user/reader/_password", Some(json!({ "password": "reader-pw-2" }))).await;
    assert!(!EsDriver::test(&params(port, "basic", "reader", "reader-pw-1")).await.ok);
    assert!(EsDriver::test(&params(port, "basic", "reader", "reader-pw-2")).await.ok);

    // API key: created with a restricted role descriptor, used as the connection's auth
    let key = ok(&admin, "POST", "/_security/api_key", Some(json!({
        "name": "studio-key", "expiration": "1d",
        "role_descriptors": { "r": { "indices": [{ "names": ["books"], "privileges": ["read"] }] } }
    }))).await;
    let encoded = key["encoded"].as_str().unwrap().to_string();
    let id_key = format!("{}:{}", key["id"].as_str().unwrap(), key["api_key"].as_str().unwrap());
    for k in [encoded.as_str(), id_key.as_str()] {
        // a key with ONLY index privileges cannot read `GET /` (cluster:monitor/main):
        // it must still connect (verified through _security/_authenticate)
        let t = EsDriver::test(&params(port, "apikey", "", k)).await;
        assert!(t.ok, "least-privilege API key must connect: {:?}", t.error);
        assert!(t.server_version.as_deref().unwrap_or("").contains("no cluster monitor privilege"), "{:?}", t.server_version);
        let mut kd = EsDriver::connect(&params(port, "apikey", "", k)).await.expect("restricted key connects");
        assert!(kd.ping().await, "403 on HEAD / still means reachable + authenticated");
        assert_eq!(total(&ok(&kd, "POST", "/books/_search", Some(json!({ "track_total_hits": true }))).await), 1);
        assert_eq!(req(&kd, "POST", "/secret/_search", Some(json!({}))).await.status, 403);
    }
    let keys = ok(&admin, "GET", "/_security/api_key?name=studio-key", None).await;
    assert_eq!(keys["api_keys"].as_array().unwrap().len(), 1);
    ok(&admin, "DELETE", "/_security/api_key", Some(json!({ "name": "studio-key" }))).await;
    assert!(!EsDriver::test(&params(port, "apikey", "", &encoded)).await.ok, "invalidated key is refused");

    // delete user / role
    ok(&admin, "DELETE", "/_security/user/reader", None).await;
    ok(&admin, "DELETE", "/_security/role/books_reader", None).await;
    assert!(!EsDriver::test(&params(port, "basic", "reader", "reader-pw-2")).await.ok);
}

/// Dev Tools + resize, with the request shapes the Dev Tools / Manage screens send:
/// Search Profiler, Grok Debugger (simulate), Painless Lab (+filter context),
/// Analyzer, and Clone / Shrink / Split with the write block set and lifted.
#[tokio::test]
async fn elasticsearch_dev_tools_and_resize() {
    let (_c, port) = start(false).await;
    let d = connect(params(port, "", "", "")).await;
    ok(&d, "PUT", "/src", Some(json!({ "settings": { "number_of_shards": 2, "number_of_replicas": 0 } }))).await;
    let mut nd = String::new();
    for i in 0..30 {
        nd.push_str(&format!("{{\"index\":{{\"_index\":\"src\",\"_id\":\"d{i}\"}}}}\n{{\"n\":{i},\"tag\":\"t{}\"}}\n", i % 3));
    }
    assert!(d.request("POST", "/_bulk?refresh=true", Some(nd)).await.unwrap().ok);

    // Search Profiler
    let p = ok(&d, "POST", "/src/_search", Some(json!({ "query": { "term": { "tag.keyword": "t1" } }, "profile": true, "size": 0 }))).await;
    let shards = p["profile"]["shards"].as_array().unwrap();
    assert_eq!(shards.len(), 2);
    let q0 = &shards[0]["searches"][0]["query"][0];
    assert!(q0["type"].is_string() && q0["time_in_nanos"].as_u64().unwrap() > 0);

    // Grok Debugger
    let g = ok(&d, "POST", "/_ingest/pipeline/_simulate", Some(json!({
        "pipeline": { "processors": [{ "grok": { "field": "message", "patterns": ["%{IP:client} %{WORD:method} %{URIPATHPARAM:request} %{NUMBER:bytes}"] } }] },
        "docs": [{ "_source": { "message": "55.3.244.1 GET /index.html 15824" } }, { "_source": { "message": "nope" } }]
    }))).await;
    assert_eq!(g["docs"][0]["doc"]["_source"]["client"], json!("55.3.244.1"));
    assert_eq!(g["docs"][0]["doc"]["_source"]["method"], json!("GET"));
    assert!(g["docs"][1]["error"]["reason"].as_str().unwrap().contains("do not match"));
    // custom pattern definitions
    let g2 = ok(&d, "POST", "/_ingest/pipeline/_simulate", Some(json!({
        "pipeline": { "processors": [{ "grok": { "field": "message", "patterns": ["%{QID:qid}"], "pattern_definitions": { "QID": "[A-F0-9]{6}" } } }] },
        "docs": [{ "_source": { "message": "ABC123" } }]
    }))).await;
    assert_eq!(g2["docs"][0]["doc"]["_source"]["qid"], json!("ABC123"));

    // Painless Lab
    let pl = ok(&d, "POST", "/_scripts/painless/_execute", Some(json!({ "script": { "source": "return params.x * params.y + 1;", "params": { "x": 6, "y": 7 } } }))).await;
    assert_eq!(pl["result"], json!("43"));
    let pf = ok(&d, "POST", "/_scripts/painless/_execute", Some(json!({
        "script": { "source": "doc['n'].value > params.min", "params": { "min": 5 } },
        "context": "filter", "context_setup": { "index": "src", "document": { "n": 9 } }
    }))).await;
    assert_eq!(pf["result"], json!(true));
    let bad = req(&d, "POST", "/_scripts/painless/_execute", Some(json!({ "script": { "source": "return )(" } }))).await;
    assert_eq!(bad.status, 400);

    // Analyzer
    let a = ok(&d, "POST", "/_analyze", Some(json!({ "analyzer": "standard", "text": "The QUICK brown-foxes" }))).await;
    let toks: Vec<&str> = a["tokens"].as_array().unwrap().iter().map(|t| t["token"].as_str().unwrap()).collect();
    assert_eq!(toks, vec!["the", "quick", "brown", "foxes"]);
    let a2 = ok(&d, "POST", "/src/_analyze", Some(json!({ "analyzer": "whitespace", "text": "A b" }))).await;
    assert_eq!(a2["tokens"].as_array().unwrap().len(), 2);

    // Clone / Shrink / Split — the source must be write-blocked first
    let refused = req(&d, "POST", "/src/_clone/src-clone", None).await;
    // Elasticsearch answers 500 (illegal_state_exception "must be read-only to resize")
    assert!(!refused.ok, "resize without a write block is refused");
    assert!(refused.json.as_ref().unwrap().to_string().contains("read-only"), "{:?}", refused.json);
    ok(&d, "PUT", "/src/_settings", Some(json!({ "index.blocks.write": true }))).await;
    // the dialog sends the replica count: a resized copy does not inherit it (would be 1 → yellow)
    ok(&d, "POST", "/src/_clone/src-clone", Some(json!({ "settings": { "index.number_of_replicas": 0 } }))).await;
    ok(&d, "POST", "/src/_shrink/src-shrunk", Some(json!({ "settings": { "index.number_of_shards": 1, "index.number_of_replicas": 0 } }))).await;
    for t in ["src-clone", "src-shrunk"] {
        ok(&d, "GET", &format!("/_cluster/health/{t}?wait_for_status=green&timeout=60s"), None).await;
        ok(&d, "PUT", &format!("/{t}/_settings"), Some(json!({ "index.blocks.write": null }))).await;
        ok(&d, "POST", &format!("/{t}/_refresh"), None).await;
        assert_eq!(ok(&d, "POST", &format!("/{t}/_count"), Some(json!({}))).await["count"], json!(30));
    }
    let shrunk = d.indices().await.unwrap().into_iter().find(|i| i.name == "src-shrunk").unwrap();
    assert_eq!(shrunk.primaries, Some(1));
    ok(&d, "POST", "/src-shrunk/_doc?refresh=true", Some(json!({ "n": 99 }))).await; // block lifted on the copy
    ok(&d, "PUT", "/src-shrunk/_settings", Some(json!({ "index.blocks.write": true }))).await;
    ok(&d, "POST", "/src-shrunk/_split/src-split", Some(json!({ "settings": { "index.number_of_shards": 3, "index.number_of_replicas": 0 } }))).await;
    ok(&d, "GET", "/_cluster/health/src-split?wait_for_status=green&timeout=60s", None).await;
    let split = d.indices().await.unwrap().into_iter().find(|i| i.name == "src-split").unwrap();
    assert_eq!(split.primaries, Some(3));
    ok(&d, "PUT", "/src/_settings", Some(json!({ "index.blocks.write": null }))).await;
    ok(&d, "POST", "/src/_doc?refresh=true", Some(json!({ "n": 100 }))).await; // source writable again
}
