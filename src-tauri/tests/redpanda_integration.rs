//! Redpanda as a flavor of the Kafka engine (SPEC-REDPANDA.md), against a real
//! `redpandadata/redpanda` container:
//!  - detection: the Admin API answers → "Redpanda v…"; nothing there → plain Kafka;
//!  - the Admin API requests the screens send (fixture built by the app's own
//!    builders in src/lib/redpanda/admin.test.ts), replayed step by step;
//!  - the Kafka workspace on Redpanda: topics, produce, paged reads, topic settings
//!    (AlterConfigs keeps the other values), consumer groups;
//!  - Kafka ACLs (create / describe / delete) with the bindings the grant dialog makes;
//!  - the built-in Schema Registry on 8081.
//!
//! Host ports 29092 (Kafka), 29644 (Admin API) and 28081 (Schema Registry) are mapped
//! 1:1 because Redpanda advertises the Kafka address it is told.
//!
//!   cargo test --test redpanda_integration -- --nocapture --test-threads=1

use std::time::{Duration, Instant};

use database_studio_lib::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
use database_studio_lib::connections::registry::Registry;
use database_studio_lib::drivers::kafka::{KafkaConnParams, KafkaDriver};
use database_studio_lib::drivers::kafka_acl::{AclFilter, KafkaAcl};
use database_studio_lib::drivers::redpanda::{RpAdmin, RpAdminParams};
use database_studio_lib::drivers::schema_registry::SchemaRegistryClient;
use database_studio_lib::drivers::types::SystemType;
use database_studio_lib::drivers::{probe_redpanda, Endpoint, LiveConnection};
use serde_json::Value;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

const IMAGE: &str = "redpandadata/redpanda";
fn tag() -> String {
    std::env::var("DS_RP_TAG").unwrap_or_else(|_| "v26.2.6".into())
}
const KAFKA: u16 = 29092;
const ADMIN: u16 = 29644;
const SR: u16 = 28081;

async fn start_redpanda() -> ContainerAsync<GenericImage> {
    let cmd: Vec<String> = [
        "redpanda",
        "start",
        "--mode",
        "dev-container",
        "--smp",
        "1",
        "--overprovisioned",
        "--kafka-addr",
        "0.0.0.0:9092",
        "--advertise-kafka-addr",
        "127.0.0.1:29092",
        "--schema-registry-addr",
        "0.0.0.0:8081",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let tag = tag();
    let node = GenericImage::new(IMAGE, &tag)
        .with_exposed_port(9092.tcp())
        .with_exposed_port(9644.tcp())
        .with_exposed_port(8081.tcp())
        .with_mapped_port(KAFKA, 9092.tcp())
        .with_mapped_port(ADMIN, 9644.tcp())
        .with_mapped_port(SR, 8081.tcp())
        .with_cmd(cmd)
        .start()
        .await
        .expect("start redpanda (Docker must be running; host ports 29092/29644/28081 free)");
    // ready when the Admin API lists a live broker and Kafka answers metadata
    let admin = RpAdmin::new(&admin_params()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if let Ok(r) = admin.request("GET", "/v1/cluster/health_overview", None).await {
            if r.json.as_ref().and_then(|j| j.get("is_healthy")).and_then(Value::as_bool) == Some(true) {
                break;
            }
        }
        assert!(Instant::now() < deadline, "redpanda did not become healthy");
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    node
}

fn admin_params() -> RpAdminParams {
    RpAdminParams { base_url: format!("http://127.0.0.1:{ADMIN}"), user: String::new(), password: String::new(), ssl_ca: String::new() }
}

fn kafka_params() -> KafkaConnParams {
    KafkaConnParams { bootstrap: format!("127.0.0.1:{KAFKA}"), sasl_mechanism: String::new(), user: String::new(), password: String::new(), ssl: false }
}

fn profile(admin_url: &str, flavor: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: "rp-it".into(),
        name: "rp-it".into(),
        system: SystemType::Kafka,
        host: "127.0.0.1".into(),
        port: KAFKA,
        database: String::new(),
        user: String::new(),
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
        cassandra_flavor: flavor.into(),
        admin_url: admin_url.into(),
    }
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/redpanda-requests.json")).expect("fixture json")
}

async fn kafka() -> KafkaDriver {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match KafkaDriver::connect(&kafka_params()).await {
            Ok(d) => return d,
            Err(e) => {
                assert!(Instant::now() < deadline, "kafka connect: {}", e.message);
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn redpanda_detection_admin_api_and_kafka_workspace() {
    let _node = start_redpanda().await;

    // ---- 1. detection (R1) ----
    let p = profile(&format!("http://127.0.0.1:{ADMIN}"), "");
    let info = probe_redpanda(&p, "").await.expect("the Admin API must answer");
    assert_eq!(info.flavor, "redpanda");
    assert!(info.version.starts_with('v'), "version {:?}", info.version);
    assert!(!info.version.contains(' '), "git hash must be dropped: {:?}", info.version);
    assert_eq!(info.brokers, 1);
    eprintln!("CHK detect: {}", info.label);
    // Test connection says it is Redpanda
    let ep = Endpoint { host: "127.0.0.1".into(), port: KAFKA };
    let t = LiveConnection::test(&p, &ep, "").await;
    assert!(t.ok, "test connection: {:?}", t.error);
    assert!(t.server_version.as_deref().unwrap_or("").starts_with("Redpanda v"), "{:?}", t.server_version);
    // no Admin API there → plain Kafka (and fast)
    let started = Instant::now();
    assert!(probe_redpanda(&profile("http://127.0.0.1:1", ""), "").await.is_none());
    assert!(started.elapsed() < Duration::from_secs(5));
    eprintln!("CHK detect: closed admin port = Apache Kafka");

    // ---- 2. registry: Admin API params + built-in Schema Registry default (R12) ----
    let reg = Registry::default();
    reg.connect(profile(&format!("http://127.0.0.1:{ADMIN}"), "redpanda"), String::new(), String::new()).await.expect("registry connect");
    let ap = reg.redpanda_admin_params("rp-it").unwrap();
    assert_eq!(ap.base_url, format!("http://127.0.0.1:{ADMIN}"));
    let srp = reg.schema_registry_params("rp-it").unwrap();
    assert_eq!(srp.base_url, "http://127.0.0.1:8081", "Redpanda's registry defaults to the first host on 8081");

    // ---- 3. the Admin API requests the screens send, replayed ----
    let admin = RpAdmin::new(&admin_params()).unwrap();
    let fx = fixture();
    for step in fx["steps"].as_array().unwrap() {
        let title = step["title"].as_str().unwrap();
        let method = step["method"].as_str().unwrap();
        let path = step["path"].as_str().unwrap();
        let body = step.get("body").and_then(Value::as_str).map(str::to_string);
        let expect: Vec<u16> = step["expect"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u16).collect();
        let r = admin.request(method, path, body).await.unwrap_or_else(|e| panic!("{title}: {}", e.message));
        let text = r.json.as_ref().map(|j| j.to_string()).or(r.text.clone()).unwrap_or_default();
        assert!(expect.contains(&r.status), "{title}: {method} {path} → {} {text}", r.status);
        if let Some(c) = step.get("contains").and_then(Value::as_str) {
            assert!(text.contains(c), "{title}: answer must contain {c:?}, got {text}");
        }
        eprintln!("CHK {title}: {}", r.status);
    }

    // ---- 4. Kafka workspace on Redpanda ----
    let k = kafka().await;
    let cluster = k.cluster_info().await.unwrap();
    assert_eq!(cluster.brokers.len(), 1);
    k.create_topic("it-orders-eu", 3, 1).await.unwrap();
    let mut seen = false;
    for _ in 0..30 {
        if k.topics().await.unwrap().iter().any(|t| t.name == "it-orders-eu" && t.partitions.len() == 3) {
            seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    assert!(seen, "topic must be listed with 3 partitions");
    for i in 0..25 {
        k.produce("it-orders-eu", &format!("k{i}"), &format!("{{\"n\":{i}}}"), Some(i % 3)).await.unwrap();
    }
    let page = k.fetch_page("it-orders-eu", None, -1, 10).await.unwrap();
    assert_eq!(page.retained, 25, "25 messages kept");
    assert!(!page.msgs.is_empty() && page.msgs.len() <= 30, "a bounded page: {}", page.msgs.len());
    assert!(page.msgs.iter().all(|m| m.value.starts_with("{\"n\":")));
    eprintln!("CHK produce + paged read: {} of {}", page.msgs.len(), page.retained);

    // topic settings: one change keeps the others (merge — R5 of the Kafka workspace)
    let mut ch = std::collections::HashMap::new();
    ch.insert("retention.ms".to_string(), Some("86400000".to_string()));
    k.alter_topic_configs("it-orders-eu", ch).await.unwrap();
    let mut ch = std::collections::HashMap::new();
    ch.insert("max.message.bytes".to_string(), Some("2097152".to_string()));
    k.alter_topic_configs("it-orders-eu", ch).await.unwrap();
    let cfg = k.topic_configs("it-orders-eu").await.unwrap();
    let get = |n: &str| cfg.iter().find(|e| e.name == n).and_then(|e| e.value.clone());
    assert_eq!(get("retention.ms").as_deref(), Some("86400000"), "the first change must survive the second");
    assert_eq!(get("max.message.bytes").as_deref(), Some("2097152"));
    eprintln!("CHK topic settings merge on Redpanda");

    // ---- 5. Kafka ACLs with the grant dialog's bindings (R10) ----
    let acls: Vec<KafkaAcl> = serde_json::from_value(fx["acls"].clone()).expect("fixture acls");
    assert_eq!(acls.len(), 4);
    let n = k.create_acls(acls.clone()).await.expect("create acls");
    assert_eq!(n, 4);
    let mut listed = Vec::new();
    for _ in 0..20 {
        listed = k.acls(AclFilter::default()).await.unwrap();
        if listed.len() >= 4 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    for a in &acls {
        assert!(
            listed.iter().any(|x| x.principal == a.principal && x.resource_type == a.resource_type && x.resource_name == a.resource_name && x.pattern_type == a.pattern_type && x.operation == a.operation && x.permission == a.permission),
            "missing ACL {a:?} in {listed:?}"
        );
    }
    let bob = k.acls(AclFilter { principal: Some("User:it_bob".into()), ..Default::default() }).await.unwrap();
    assert_eq!(bob.len(), 3, "filter by principal");
    // deleting one exact binding removes only it
    let one = acls[0].clone();
    let removed = k
        .delete_acls(vec![AclFilter {
            resource_type: Some(one.resource_type.clone()),
            resource_name: Some(one.resource_name.clone()),
            pattern_type: Some(one.pattern_type.clone()),
            principal: Some(one.principal.clone()),
            host: Some(one.host.clone()),
            operation: Some(one.operation.clone()),
            permission: Some(one.permission.clone()),
        }])
        .await
        .unwrap();
    assert_eq!(removed.len(), 1, "exact filter removes exactly one");
    let removed = k.delete_acls(vec![AclFilter { principal: Some("User:it_bob".into()), ..Default::default() }]).await.unwrap();
    assert_eq!(removed.len(), 2);
    let removed = k.delete_acls(vec![AclFilter { principal: Some("RedpandaRole:it_ops".into()), ..Default::default() }]).await.unwrap();
    assert_eq!(removed.len(), 1, "a role principal works on Redpanda");
    assert!(k.acls(AclFilter::default()).await.unwrap().iter().all(|a| !a.principal.contains("it_")));
    eprintln!("CHK ACLs create / describe / delete");

    // ---- 6. built-in Schema Registry ----
    let http = reqwest::Client::new();
    let r = http
        .post(format!("http://127.0.0.1:{SR}/subjects/it-orders-eu-value/versions"))
        .header("Content-Type", "application/vnd.schemaregistry.v1+json")
        .body(r#"{"schema":"{\"type\":\"record\",\"name\":\"Order\",\"fields\":[{\"name\":\"n\",\"type\":\"int\"}]}"}"#)
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success(), "register schema: {}", r.status());
    let sr = SchemaRegistryClient::new(database_studio_lib::drivers::schema_registry::SchemaRegistryParams {
        base_url: format!("http://127.0.0.1:{SR}"),
        user: String::new(),
        password: String::new(),
    })
    .unwrap();
    let subjects = sr.subjects().await.unwrap();
    assert!(subjects.iter().any(|s| s.name == "it-orders-eu-value"), "{subjects:?}");
    eprintln!("CHK Schema Registry");

    k.delete_topic("it-orders-eu").await.unwrap();
}

/// ACLs on Apache Kafka (the Security section is shared): a broker without an
/// authorizer lists nothing and refuses CreateAcls — the message must say why.
#[tokio::test(flavor = "multi_thread")]
async fn apache_kafka_without_authorizer_explains_why_acls_are_unavailable() {
    use testcontainers_modules::kafka::{Kafka, KAFKA_PORT};
    let node = Kafka::default().start().await.expect("start kafka container");
    let port = node.get_host_port_ipv4(KAFKA_PORT).await.unwrap();
    let p = KafkaConnParams { bootstrap: format!("127.0.0.1:{port}"), sasl_mechanism: String::new(), user: String::new(), password: String::new(), ssl: false };
    let deadline = Instant::now() + Duration::from_secs(60);
    let k = loop {
        match KafkaDriver::connect(&p).await {
            Ok(d) => break d,
            Err(e) => {
                assert!(Instant::now() < deadline, "kafka connect: {}", e.message);
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    };
    // measured: listing answers an empty list (no error), creating is refused
    assert_eq!(k.acls(AclFilter::default()).await.expect("describe answers").len(), 0);
    let one = KafkaAcl { resource_type: "TOPIC".into(), resource_name: "t".into(), pattern_type: "LITERAL".into(), principal: "User:x".into(), host: "*".into(), operation: "READ".into(), permission: "ALLOW".into() };
    let err = k.create_acls(vec![one]).await.expect_err("no authorizer → CreateAcls is refused");
    eprintln!("CHK apache kafka ACL error: {}", err.message);
    assert!(err.message.starts_with("ACLs are not available: the broker has no authorizer configured"), "explained: {}", err.message);
    // and it is not mistaken for Redpanda
    let mut prof = profile(&format!("http://127.0.0.1:{port}"), "");
    prof.port = port;
    assert!(probe_redpanda(&prof, "").await.is_none(), "a Kafka port is not a Redpanda Admin API");
}
