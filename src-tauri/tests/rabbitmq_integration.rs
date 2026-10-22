//! RabbitMQ (Management HTTP API) against a REAL broker in a container.
//!
//! Seeds topology + messages through the driver, then reads everything back from
//! the broker to verify — no hard-coded expected server output.
//!
//! Run methodology (per CLAUDE.md): prebuild, then run synchronously with a hard
//! timeout, one test at a time:
//!   cargo test --test rabbitmq_integration --no-run
//!   timeout 400 cargo test --test rabbitmq_integration -- --nocapture --test-threads=1

use std::time::{Duration, Instant};

use database_studio_lib::connections::profile::ConnectionProfile;
use database_studio_lib::drivers::rabbitmq::{RabbitConnParams, RabbitDriver};
use database_studio_lib::drivers::{Endpoint, LiveConnection};
use serde_json::json;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

const USER: &str = "studio";
const PASS: &str = "s3cret";

async fn start() -> (ContainerAsync<GenericImage>, u16) {
    // `guest` may only log in from localhost INSIDE the container, and a mapped
    // port is not loopback from the broker's point of view — use a real user.
    let c = GenericImage::new("rabbitmq", "3.13-management-alpine")
        .with_exposed_port(15672.tcp())
        .with_env_var("RABBITMQ_DEFAULT_USER", USER)
        .with_env_var("RABBITMQ_DEFAULT_PASS", PASS)
        .start()
        .await
        .expect("start rabbitmq container (Docker daemon must be running)");
    let port = c.get_host_port_ipv4(15672).await.unwrap();
    (c, port)
}

fn params(port: u16, password: &str) -> RabbitConnParams {
    RabbitConnParams {
        host: "localhost".into(),
        port,
        vhost: String::new(),
        user: USER.into(),
        password: password.into(),
        ssl: false,
        ssl_ca: String::new(),
    }
}

async fn connect(port: u16) -> RabbitDriver {
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        match RabbitDriver::connect(&params(port, PASS)).await {
            Ok(d) => return d,
            Err(e) => {
                assert!(Instant::now() < deadline, "rabbitmq: timed out waiting — last: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

/// The whole developer loop on one broker: connect/test/dispatch, declare a
/// queue + exchange + binding, publish (routed and unroutable), peek WITHOUT
/// consuming, consume with ack, purge, unbind, delete — and each step is checked
/// by reading the broker's state back.
#[tokio::test]
async fn rabbitmq_end_to_end_topology_and_messages() {
    let (_c, port) = start().await;
    let drv = connect(port).await;

    // ---- connect / test / dispatch through LiveConnection ------------------------
    let t = RabbitDriver::test(&params(port, PASS)).await;
    assert!(t.ok, "test failed: {:?}", t.error);
    assert!(t.server_version.as_deref().unwrap_or("").starts_with("RabbitMQ 3."), "{:?}", t.server_version);

    let bad = RabbitDriver::test(&params(port, "wrong")).await;
    assert!(!bad.ok);
    assert!(bad.error.as_deref().unwrap_or("").contains("Authentication failed"), "{:?}", bad.error);

    let profile: ConnectionProfile = serde_json::from_value(json!({
        "id": "r1", "name": "rabbit", "system": "rabbitmq",
        "host": "localhost", "port": port, "database": "/", "user": USER
    }))
    .unwrap();
    let ep = Endpoint { host: "localhost".into(), port };
    let mut live = LiveConnection::connect(&profile, &ep, PASS).await.expect("dispatch connect");
    assert!(live.ping().await);
    assert!(matches!(live, LiveConnection::Rabbitmq(_)));
    // SQL paths answer with a typed "not applicable" instead of panicking.
    let e = live.exec("SELECT 1").await.err().expect("not sql");
    assert!(e.message.contains("message broker"), "{}", e.message);
    assert!(live.schemas().await.unwrap().is_empty());

    // ---- overview / vhosts --------------------------------------------------------
    let ov = drv.overview().await.unwrap();
    assert!(ov.rabbitmq_version.starts_with("3."), "{}", ov.rabbitmq_version);
    assert_eq!(ov.vhost, "/");
    assert!(drv.vhosts().await.unwrap().contains(&"/".to_string()));

    // ---- declare (a name with '/' and a space proves per-segment encoding) ---------
    let q = "orders/eu new";
    drv.declare_queue("/", q, "classic", true, false, json!({})).await.unwrap();
    drv.declare_queue("/", "orders.q", "quorum", true, false, json!({})).await.unwrap();
    drv.declare_exchange("/", "orders.x", "topic", true, false, false).await.unwrap();
    drv.bind_queue("/", "orders.x", q, "order.*.eu", json!({})).await.unwrap();

    let queues = drv.queues("/").await.unwrap();
    let names: Vec<&str> = queues.iter().map(|x| x.name.as_str()).collect();
    assert!(names.contains(&q) && names.contains(&"orders.q"), "{names:?}");
    let quorum = queues.iter().find(|x| x.name == "orders.q").unwrap();
    assert_eq!(quorum.queue_type, "quorum");
    let ex = drv.exchanges("/").await.unwrap();
    assert!(ex.iter().any(|e| e.name == "orders.x" && e.exchange_type == "topic"));
    assert!(ex.iter().any(|e| e.name.is_empty()), "default exchange listed");

    let qb = drv.queue_bindings("/", q).await.unwrap();
    let ours = qb.iter().find(|b| b.source == "orders.x").expect("binding from orders.x");
    assert_eq!(ours.routing_key, "order.*.eu");
    let xb = drv.exchange_bindings("/", "orders.x").await.unwrap();
    assert!(xb.iter().any(|b| b.destination == q));
    assert!(drv.exchange_bindings("/", "").await.unwrap().is_empty());

    // ---- publish: routed via the topic, via the default exchange, and unroutable ---
    let r1 = drv
        .publish("/", "orders.x", "order.42.eu", r#"{"id":42}"#, "string", json!({"content_type": "application/json", "headers": {"src": "it"}}))
        .await
        .unwrap();
    assert!(r1.routed);
    let r2 = drv.publish("/", "", q, "plain text", "string", json!({})).await.unwrap();
    assert!(r2.routed, "default exchange routes by queue name");
    let r3 = drv.publish("/", "orders.x", "order.42.us", "nowhere", "string", json!({})).await.unwrap();
    assert!(!r3.routed, "no binding matches → not routed");

    // Stats are refreshed by the broker asynchronously; wait for the count.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let n = drv.queue("/", q).await.unwrap().messages.unwrap_or(0);
        if n == 2 {
            break;
        }
        assert!(Instant::now() < deadline, "queue never reported 2 messages (last {n})");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // ---- peek: messages come back, and STAY in the queue -------------------------
    let peek = drv.get_messages("/", q, 10, "requeue").await.unwrap();
    assert_eq!(peek.len(), 2);
    assert_eq!(peek[0].payload, r#"{"id":42}"#);
    assert_eq!(peek[0].routing_key, "order.42.eu");
    assert_eq!(peek[0].exchange, "orders.x");
    assert_eq!(peek[0].properties["content_type"], "application/json");
    assert_eq!(peek[0].properties["headers"]["src"], "it");
    assert_eq!(peek[1].payload, "plain text");
    let again = drv.get_messages("/", q, 10, "requeue").await.unwrap();
    assert_eq!(again.len(), 2, "a peek must not consume");
    assert!(again.iter().all(|m| m.redelivered), "requeued messages come back as redelivered");

    // ---- consume one with ack: it is gone ------------------------------------------
    let taken = drv.get_messages("/", q, 1, "ack").await.unwrap();
    assert_eq!(taken.len(), 1);
    let rest = drv.get_messages("/", q, 10, "requeue").await.unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].payload, "plain text");

    // ---- purge -----------------------------------------------------------------------
    drv.purge_queue("/", q).await.unwrap();
    assert!(drv.get_messages("/", q, 10, "requeue").await.unwrap().is_empty());

    // ---- unbind / refuse built-ins / delete -------------------------------------------
    drv.unbind_queue("/", "orders.x", q, &ours.properties_key).await.unwrap();
    assert!(!drv.queue_bindings("/", q).await.unwrap().iter().any(|b| b.source == "orders.x"));
    assert!(drv.delete_exchange("/", "").await.is_err());
    assert!(drv.delete_exchange("/", "amq.topic").await.is_err());

    drv.delete_exchange("/", "orders.x").await.unwrap();
    drv.delete_queue("/", q).await.unwrap();
    drv.delete_queue("/", "orders.q").await.unwrap();
    let after = drv.queues("/").await.unwrap();
    assert!(!after.iter().any(|x| x.name == q || x.name == "orders.q"));
    assert!(!drv.exchanges("/").await.unwrap().iter().any(|e| e.name == "orders.x"));
    let missing = drv.queue("/", q).await.err().expect("deleted queue is gone");
    assert!(missing.message.starts_with("Not found"), "{}", missing.message);
}

/// A non-default vhost: the connection opens on it, and listing is scoped to it.
#[tokio::test]
async fn rabbitmq_non_default_vhost_is_isolated() {
    let (_c, port) = start().await;
    let root = connect(port).await;

    // create vhost + grant the user on it, through the same API the app speaks
    let client = reqwest::Client::new();
    let base = format!("http://localhost:{port}/api");
    let put = client.put(format!("{base}/vhosts/staging")).basic_auth(USER, Some(PASS)).send().await.unwrap();
    assert!(put.status().is_success(), "{}", put.status());
    let perm = client
        .put(format!("{base}/permissions/staging/{USER}"))
        .basic_auth(USER, Some(PASS))
        .json(&json!({"configure": ".*", "write": ".*", "read": ".*"}))
        .send()
        .await
        .unwrap();
    assert!(perm.status().is_success(), "{}", perm.status());

    let mut p = params(port, PASS);
    p.vhost = "staging".into();
    let st = RabbitDriver::connect(&p).await.unwrap();
    assert_eq!(st.vhost(), "staging");
    assert!(st.vhosts().await.unwrap().contains(&"staging".to_string()));

    st.declare_queue("staging", "only-here", "classic", false, false, json!({})).await.unwrap();
    assert!(st.queues("staging").await.unwrap().iter().any(|q| q.name == "only-here"));
    assert!(!root.queues("/").await.unwrap().iter().any(|q| q.name == "only-here"), "vhosts are isolated");
}

/// Wait until a queue reports `want` ready messages (broker stats are refreshed
/// asynchronously), reading through a non-destructive peek.
async fn wait_ready(drv: &RabbitDriver, vhost: &str, queue: &str, want: usize) -> Vec<database_studio_lib::drivers::rabbitmq::RabbitMessage> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let got = drv.get_messages(vhost, queue, 50, "requeue").await.unwrap();
        if got.len() >= want {
            return got;
        }
        assert!(Instant::now() < deadline, "{queue}: expected {want} message(s), have {}", got.len());
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Live listening, both modes, against the real broker:
/// * watch on a topic exchange → the tap gets a COPY, the real queue keeps its own;
/// * watch on a queue → copies the queue's bindings (not the default one);
/// * headers / fanout watch → one binding receives everything;
/// * refusals that would silently watch nothing (direct without keys, default
///   exchange, a queue reachable only by name) are errors, and leave no tap behind;
/// * consume → ack removes the messages from the queue.
#[tokio::test]
async fn rabbitmq_live_watch_and_consume() {
    use database_studio_lib::drivers::rabbitmq::TAP_PREFIX;
    let (_c, port) = start().await;
    let drv = connect(port).await;

    drv.declare_exchange("/", "live.x", "topic", false, false, false).await.unwrap();
    drv.declare_queue("/", "live.q", "classic", false, false, json!({})).await.unwrap();
    drv.bind_queue("/", "live.x", "live.q", "order.#", json!({})).await.unwrap();

    // ---- watch an exchange (default "#") --------------------------------------------
    let plan = drv.prepare_live("s1", "watch", "/", None, Some("live.x"), &[]).await.unwrap();
    let tap = plan.tap_queue.clone().expect("watch creates a tap");
    assert!(tap.starts_with(TAP_PREFIX));
    assert_eq!(plan.source, tap);
    assert_eq!(plan.bindings.len(), 1);
    assert_eq!(plan.bindings[0].routing_key, "#");
    let tq = drv.queue("/", &tap).await.unwrap();
    assert_eq!(tq.arguments["x-expires"], 60000, "an abandoned tap must expire on the broker");
    assert!(!tq.durable);

    for i in 0..3 {
        let r = drv.publish("/", "live.x", &format!("order.{i}"), &format!("{{\"n\":{i}}}"), "string", json!({})).await.unwrap();
        assert!(r.routed);
    }
    drv.publish("/", "live.x", "audit.login", "not an order", "string", json!({})).await.unwrap();

    // the tap copy: everything (topic "#"), taken with ack like the live loop does
    wait_ready(&drv, "/", &tap, 4).await;
    let copy = drv.get_messages("/", &tap, 50, "ack").await.unwrap();
    assert_eq!(copy.len(), 4);
    assert_eq!(copy[0].payload, "{\"n\":0}");
    assert_eq!(copy[3].routing_key, "audit.login");
    // …and the real queue still has its own messages: watching consumed nothing
    let real = wait_ready(&drv, "/", "live.q", 3).await;
    assert_eq!(real.len(), 3, "watch must not take messages from the real queue");
    drv.delete_queue("/", &tap).await.unwrap();

    // ---- watch a queue = copy its (non-default) bindings ------------------------------
    let qplan = drv.prepare_live("s2", "watch", "/", Some("live.q"), None, &[]).await.unwrap();
    let qtap = qplan.tap_queue.clone().unwrap();
    assert_eq!(qplan.bindings.len(), 1, "only live.x→live.q, never the default exchange");
    assert_eq!(qplan.bindings[0].source, "live.x");
    assert_eq!(qplan.bindings[0].routing_key, "order.#");
    drv.publish("/", "live.x", "order.9", "nine", "string", json!({})).await.unwrap();
    drv.publish("/", "live.x", "audit.x", "not for live.q", "string", json!({})).await.unwrap();
    let qcopy = wait_ready(&drv, "/", &qtap, 1).await;
    assert_eq!(qcopy.len(), 1);
    assert_eq!(qcopy[0].payload, "nine", "the copy only sees what the queue itself would get");
    drv.delete_queue("/", &qtap).await.unwrap();

    // ---- headers + fanout: one binding gets everything --------------------------------
    drv.declare_exchange("/", "live.h", "headers", false, false, false).await.unwrap();
    let hplan = drv.prepare_live("s3", "watch", "/", None, Some("live.h"), &[]).await.unwrap();
    let htap = hplan.tap_queue.clone().unwrap();
    let hr = drv.publish("/", "live.h", "", "h1", "string", json!({"headers": {"k": "v"}})).await.unwrap();
    assert!(hr.routed, "an argument-less headers binding matches every message");
    wait_ready(&drv, "/", &htap, 1).await;
    drv.delete_queue("/", &htap).await.unwrap();

    drv.declare_exchange("/", "live.f", "fanout", false, false, false).await.unwrap();
    let fplan = drv.prepare_live("s4", "watch", "/", None, Some("live.f"), &["ignored".into()]).await.unwrap();
    assert!(drv.publish("/", "live.f", "anything", "f1", "string", json!({})).await.unwrap().routed);
    drv.delete_queue("/", fplan.tap_queue.as_ref().unwrap()).await.unwrap();

    // ---- refusals leave nothing behind ---------------------------------------------------
    drv.declare_exchange("/", "live.d", "direct", false, false, false).await.unwrap();
    assert!(drv.prepare_live("s5", "watch", "/", None, Some("live.d"), &[]).await.is_err());
    assert!(drv.prepare_live("s6", "watch", "/", None, Some(""), &[]).await.is_err());
    drv.declare_queue("/", "byname.q", "classic", false, false, json!({})).await.unwrap();
    let e = drv.prepare_live("s7", "watch", "/", Some("byname.q"), None, &[]).await.unwrap_err();
    assert!(e.message.contains("default exchange"), "{}", e.message);
    let leftover: Vec<String> = drv.queues("/").await.unwrap().into_iter().map(|q| q.name).filter(|n| n.starts_with(TAP_PREFIX)).collect();
    assert!(leftover.is_empty(), "no tap queue may survive a refused or finished watch: {leftover:?}");

    // ---- consume = ack, the messages leave the real queue ---------------------------------
    let cplan = drv.prepare_live("s8", "consume", "/", Some("live.q"), None, &[]).await.unwrap();
    assert_eq!(cplan.source, "live.q");
    assert!(cplan.tap_queue.is_none());
    let before = wait_ready(&drv, "/", "live.q", 4).await.len();
    let taken = drv.get_messages("/", &cplan.source, 200, "ack").await.unwrap();
    assert_eq!(taken.len(), before);
    assert!(drv.get_messages("/", "live.q", 50, "requeue").await.unwrap().is_empty());
    assert!(drv.prepare_live("s9", "consume", "/", Some("no.such.q"), None, &[]).await.is_err());
}

/// Users, permissions, topic permissions, policies and vhosts — each change is
/// checked by what the broker then ALLOWS, not just by reading the setting back.
#[tokio::test]
async fn rabbitmq_users_permissions_policies() {
    let (_c, port) = start().await;
    let admin = connect(port).await;

    let me = admin.whoami().await.unwrap();
    assert_eq!(me.name, USER);
    assert!(me.tags.iter().any(|t| t == "administrator"), "{:?}", me.tags);

    // ---- users ----------------------------------------------------------------------------
    admin.create_user("dev", "pw1", &["management".into()]).await.unwrap();
    let users = admin.users().await.unwrap();
    let dev = users.iter().find(|u| u.name == "dev").expect("created");
    assert_eq!(dev.tags, vec!["management"]);
    assert!(dev.has_password);
    let as_dev = |pw: &str| {
        let mut p = params(port, pw);
        p.user = "dev".into();
        p
    };
    RabbitDriver::connect(&as_dev("pw1")).await.expect("dev logs in");

    // tag change must NOT drop the password (PUT replaces the whole user)
    admin.set_user_tags("dev", &["management".into(), "monitoring".into()]).await.unwrap();
    assert!(RabbitDriver::connect(&as_dev("pw1")).await.is_ok(), "password survives a tag change");
    let dev_after = admin.users().await.unwrap().into_iter().find(|u| u.name == "dev").unwrap();
    assert_eq!(dev_after.tags, vec!["management", "monitoring"]);

    // password change keeps the tags
    admin.set_user_password("dev", "pw2").await.unwrap();
    assert!(RabbitDriver::connect(&as_dev("pw1")).await.is_err(), "old password refused");
    assert!(RabbitDriver::connect(&as_dev("pw2")).await.is_ok(), "new password accepted");
    assert_eq!(admin.users().await.unwrap().into_iter().find(|u| u.name == "dev").unwrap().tags.len(), 2);
    let dev_drv = RabbitDriver::connect(&as_dev("pw2")).await.unwrap();

    // ---- permissions: no permission → refused; full → allowed; removed → refused again --
    admin.declare_queue("/", "perm.q", "classic", false, false, json!({})).await.unwrap();
    assert!(dev_drv.publish("/", "", "perm.q", "x", "string", json!({})).await.is_err(), "no vhost permission yet");
    admin.set_permission("/", "dev", ".*", ".*", ".*").await.unwrap();
    let perms = admin.permissions().await.unwrap();
    let p = perms.iter().find(|p| p.user == "dev" && p.vhost == "/").expect("permission listed");
    assert_eq!((p.configure.as_str(), p.write.as_str(), p.read.as_str()), (".*", ".*", ".*"));
    assert!(dev_drv.publish("/", "", "perm.q", "x", "string", json!({})).await.unwrap().routed);

    // read-only: configure/write nothing, read everything
    admin.set_permission("/", "dev", "^$", "^$", ".*").await.unwrap();
    assert!(dev_drv.publish("/", "", "perm.q", "y", "string", json!({})).await.is_err(), "read-only cannot publish");
    assert!(!dev_drv.get_messages("/", "perm.q", 5, "requeue").await.unwrap().is_empty(), "read-only can read");

    admin.delete_permission("/", "dev").await.unwrap();
    assert!(!admin.permissions().await.unwrap().iter().any(|p| p.user == "dev"));
    assert!(dev_drv.get_messages("/", "perm.q", 5, "requeue").await.is_err(), "permission removed");

    // ---- topic permissions ----------------------------------------------------------------
    admin.set_topic_permission("/", "dev", "amq.topic", "^orders\\.", ".*").await.unwrap();
    let tps = admin.topic_permissions().await.unwrap();
    let tp = tps.iter().find(|t| t.user == "dev").expect("topic permission listed");
    assert_eq!(tp.exchange, "amq.topic");
    assert_eq!(tp.write, "^orders\\.");
    admin.delete_topic_permissions("/", "dev").await.unwrap();
    assert!(!admin.topic_permissions().await.unwrap().iter().any(|t| t.user == "dev"));

    // ---- policies: a max-length policy really caps the queue ------------------------------
    assert!(admin.set_policy("/", "empty", ".*", "queues", 0, json!({})).await.is_err(), "empty definition refused");
    admin.set_policy("/", "cap2", "^pol\\.", "queues", 7, json!({"max-length": 2})).await.unwrap();
    let pols = admin.policies("/").await.unwrap();
    let pol = pols.iter().find(|p| p.name == "cap2").expect("policy listed");
    assert_eq!(pol.apply_to, "queues");
    assert_eq!(pol.priority, 7);
    assert_eq!(pol.definition["max-length"], 2);
    admin.declare_queue("/", "pol.q", "classic", false, false, json!({})).await.unwrap();
    // policy application is asynchronous: wait until the queue reports it
    let deadline = Instant::now() + Duration::from_secs(20);
    while admin.queue("/", "pol.q").await.unwrap().policy != "cap2" {
        assert!(Instant::now() < deadline, "policy never applied to pol.q");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    for i in 0..5 {
        admin.publish("/", "", "pol.q", &format!("m{i}"), "string", json!({})).await.unwrap();
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let kept = admin.get_messages("/", "pol.q", 50, "requeue").await.unwrap();
    assert_eq!(kept.len(), 2, "max-length 2 keeps the newest two");
    assert_eq!(kept[0].payload, "m3");
    admin.delete_policy("/", "cap2").await.unwrap();
    assert!(!admin.policies("/").await.unwrap().iter().any(|p| p.name == "cap2"));

    // ---- vhosts ------------------------------------------------------------------------------
    admin.create_vhost("qa", "QA environment").await.unwrap();
    let vh = admin.vhost_list().await.unwrap();
    let qa = vh.iter().find(|v| v.name == "qa").expect("vhost listed");
    assert_eq!(qa.description, "QA environment");
    assert!(admin.delete_vhost("/").await.is_err(), "the connection's own vhost is protected");
    admin.delete_vhost("qa").await.unwrap();
    assert!(!admin.vhost_list().await.unwrap().iter().any(|v| v.name == "qa"));

    // ---- delete user (and never the one we are logged in as) -------------------------------
    assert!(admin.delete_user(USER).await.is_err(), "deleting the login user is refused");
    admin.delete_user("dev").await.unwrap();
    assert!(!admin.users().await.unwrap().iter().any(|u| u.name == "dev"));
    assert!(RabbitDriver::connect(&as_dev("pw2")).await.is_err(), "deleted user cannot log in");
}

/// A broker whose default vhost is not "/" (RABBITMQ_DEFAULT_VHOST=app — common in
/// docker deployments). The profile's Virtual host is left empty, which used to mean
/// "/", so every vhost-scoped call came back as a bare "Not found — Not Found" and
/// the explorer showed nothing. Reported from a real server.
#[tokio::test]
async fn rabbitmq_missing_default_vhost_is_resolved_not_a_raw_404() {
    let c = GenericImage::new("rabbitmq", "3.13-management-alpine")
        .with_exposed_port(15672.tcp())
        .with_env_var("RABBITMQ_DEFAULT_USER", USER)
        .with_env_var("RABBITMQ_DEFAULT_PASS", PASS)
        .with_env_var("RABBITMQ_DEFAULT_VHOST", "app")
        .start()
        .await
        .expect("start rabbitmq container");
    let port = c.get_host_port_ipv4(15672).await.unwrap();

    // (1) Virtual host left empty → the connection opens on the vhost that exists.
    let drv = connect(port).await;
    assert_eq!(drv.vhost(), "app", "an empty Virtual host must resolve to a vhost the broker has");
    let listed = drv.vhosts().await.unwrap();
    assert_eq!(listed, vec!["app".to_string()], "a vhost that does not exist must never be offered");
    assert!(drv.queues("app").await.is_ok());
    assert!(drv.exchanges("app").await.is_ok());
    assert_eq!(drv.overview().await.unwrap().vhost, "app");

    // (2) Asking for a vhost that is not there names it instead of a bare 404.
    let e = drv.queues("/").await.unwrap_err();
    assert!(e.message.contains("Virtual host '/'"), "{}", e.message);
    let e = drv.exchanges("/").await.unwrap_err();
    assert!(e.message.contains("Virtual host '/'"), "{}", e.message);

    // (3) A Virtual host typed explicitly that does not exist fails to connect,
    //     and says which ones do — Test connection reports the same.
    let mut p = params(port, PASS);
    p.vhost = "nope".into();
    let e = RabbitDriver::connect(&p).await.err().expect("missing explicit vhost must not connect");
    assert!(e.message.contains("'nope'") && e.message.contains("app"), "{}", e.message);
    let t = RabbitDriver::test(&p).await;
    assert!(!t.ok);
    assert!(t.error.as_deref().unwrap_or("").contains("app"), "{:?}", t.error);
    p.vhost = "app".into();
    assert_eq!(RabbitDriver::connect(&p).await.unwrap().vhost(), "app");
}

/// The create forms send typed arguments the way the management UI does: numbers
/// as numbers, booleans as booleans, lists as lists — and the broker must keep
/// those types (a TTL sent as the string "60000" is rejected or ignored). The
/// exchange form's "alternate-exchange" must really reroute unroutable messages.
#[tokio::test]
async fn rabbitmq_create_forms_send_typed_arguments() {
    let (_c, port) = start().await;
    let drv = connect(port).await;

    // exchange types come from the broker (the form's Type dropdown)
    let types = drv.overview().await.unwrap().exchange_types;
    for t in ["direct", "fanout", "headers", "topic"] {
        assert!(types.iter().any(|x| x == t), "{t} missing from {types:?}");
    }

    // classic queue, explicit type + typed arguments
    drv.declare_queue(
        "/",
        "args.q",
        "classic",
        true,
        false,
        json!({"x-message-ttl": 60000, "x-single-active-consumer": true, "x-max-length": 5, "x-overflow": "reject-publish"}),
    )
    .await
    .unwrap();
    let q = drv.queue("/", "args.q").await.unwrap();
    assert_eq!(q.arguments["x-queue-type"], "classic", "Classic is sent explicitly, like the UI");
    assert_eq!(q.arguments["x-message-ttl"], 60000, "number stays a number");
    assert_eq!(q.arguments["x-single-active-consumer"], true, "boolean stays a boolean");
    assert_eq!(q.arguments["x-overflow"], "reject-publish");
    // the arguments are live: x-max-length 5 + reject-publish refuses the 6th message
    for i in 0..5 {
        assert!(drv.publish("/", "", "args.q", &format!("m{i}"), "string", json!({})).await.unwrap().routed);
    }

    // quorum with delivery limit
    drv.declare_queue("/", "args.qq", "quorum", true, false, json!({"x-delivery-limit": 3})).await.unwrap();
    let qq = drv.queue("/", "args.qq").await.unwrap();
    assert_eq!(qq.queue_type, "quorum");
    assert_eq!(qq.arguments["x-delivery-limit"], 3);

    // "Default for virtual host" sends no x-queue-type at all
    drv.declare_queue("/", "args.default", "", true, false, json!({})).await.unwrap();
    assert!(drv.queue("/", "args.default").await.unwrap().arguments.get("x-queue-type").is_none());

    // exchange with alternate-exchange: an unroutable message lands in the AE's queue
    drv.declare_exchange("/", "ae", "fanout", true, false, false).await.unwrap();
    drv.declare_queue("/", "ae.q", "classic", true, false, json!({})).await.unwrap();
    drv.bind_queue("/", "ae", "ae.q", "", json!({})).await.unwrap();
    drv.declare_exchange_with("/", "with.ae", "direct", true, false, false, json!({"alternate-exchange": "ae"}))
        .await
        .unwrap();
    let ex = drv.exchanges("/").await.unwrap().into_iter().find(|e| e.name == "with.ae").unwrap();
    assert_eq!(ex.arguments["alternate-exchange"], "ae");
    let r = drv.publish("/", "with.ae", "no.binding", "lost?", "string", json!({})).await.unwrap();
    assert!(r.routed, "the alternate exchange catches what with.ae cannot route");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let got = drv.get_messages("/", "ae.q", 5, "requeue").await.unwrap();
        if got.iter().any(|m| m.payload == "lost?") {
            break;
        }
        assert!(Instant::now() < deadline, "the message never reached the alternate exchange's queue");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Logged in with only the 'management' tag (no 'administrator'): the broker answers
/// 401 "Not administrator user" on users / permissions / topic permissions — that must
/// read as "needs the administrator tag", NOT "Authentication failed", and what this
/// user CAN read (vhosts, policies) must keep working. Reported from a real server.
#[tokio::test]
async fn rabbitmq_non_admin_user_gets_a_tag_error_not_an_auth_error() {
    let (_c, port) = start().await;
    let admin = connect(port).await;
    admin.create_user("mg", "pw", &["management".into()]).await.unwrap();
    admin.set_permission("/", "mg", ".*", ".*", ".*").await.unwrap();
    let mut p = params(port, "pw");
    p.user = "mg".into();
    let mg = RabbitDriver::connect(&p).await.expect("mg logs in");
    assert_eq!(mg.whoami().await.unwrap().tags, vec!["management"]);

    for (what, e) in [
        ("users", mg.users().await.err()),
        ("permissions", mg.permissions().await.err()),
        ("topic permissions", mg.topic_permissions().await.err()),
    ] {
        let m = e.unwrap_or_else(|| panic!("{what} must be refused for a non-admin")).message;
        assert!(m.contains("'administrator' tag"), "{what}: {m}");
        assert!(!m.contains("Authentication failed"), "{what}: {m}");
    }
    // what a management user may read still works
    assert!(mg.vhost_list().await.unwrap().iter().any(|v| v.name == "/"));
    assert!(mg.policies("/").await.is_ok());
    // and a wrong password is still an authentication failure
    let mut bad = params(port, "nope");
    bad.user = "mg".into();
    assert!(RabbitDriver::connect(&bad).await.err().unwrap().message.contains("Authentication failed"));
}

// ---------------------------------------------------------------------------------------
// Cluster workspace (SPEC-RABBITMQ-WORKSPACE.md §2/§4): rates, nodes, connections,
// consumers. A real AMQP 0-9-1 client is needed to open a connection and register a
// consumer; the crate has no AMQP dependency, so the handful of frames involved are
// written by hand below (protocol header → Start/StartOk → Tune/TuneOk → Open →
// Channel.Open → Basic.Qos → Basic.Consume).
// ---------------------------------------------------------------------------------------

mod amqp {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    fn shortstr(b: &mut Vec<u8>, s: &str) {
        b.push(s.len() as u8);
        b.extend_from_slice(s.as_bytes());
    }
    fn longstr(b: &mut Vec<u8>, s: &[u8]) {
        b.extend_from_slice(&(s.len() as u32).to_be_bytes());
        b.extend_from_slice(s);
    }
    /// A field table of string values.
    fn table(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut body = Vec::new();
        for (k, v) in entries {
            shortstr(&mut body, k);
            body.push(b'S');
            longstr(&mut body, v.as_bytes());
        }
        let mut out = (body.len() as u32).to_be_bytes().to_vec();
        out.extend(body);
        out
    }
    fn method_frame(channel: u16, class: u16, method: u16, args: &[u8]) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.extend_from_slice(&class.to_be_bytes());
        payload.extend_from_slice(&method.to_be_bytes());
        payload.extend_from_slice(args);
        let mut f = vec![1u8];
        f.extend_from_slice(&channel.to_be_bytes());
        f.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        f.extend(payload);
        f.push(0xCE);
        f
    }

    /// Next frame: (type, channel, payload). `None` = the broker closed the socket.
    pub async fn read_frame(s: &mut TcpStream) -> Option<(u8, u16, Vec<u8>)> {
        let mut h = [0u8; 7];
        s.read_exact(&mut h).await.ok()?;
        let size = u32::from_be_bytes([h[3], h[4], h[5], h[6]]) as usize;
        let mut p = vec![0u8; size + 1];
        s.read_exact(&mut p).await.ok()?;
        assert_eq!(p[size], 0xCE, "frame end");
        p.truncate(size);
        Some((h[0], u16::from_be_bytes([h[1], h[2]]), p))
    }

    /// Wait for one method (skipping heartbeats); returns its arguments.
    async fn expect(s: &mut TcpStream, class: u16, method: u16) -> Vec<u8> {
        loop {
            let (ty, _ch, p) = read_frame(s).await.expect("broker closed the socket during the handshake");
            if ty == 8 {
                continue; // heartbeat
            }
            assert_eq!(ty, 1, "expected a method frame");
            let got = (u16::from_be_bytes([p[0], p[1]]), u16::from_be_bytes([p[2], p[3]]));
            if got == (10, 50) || got == (20, 40) {
                let text_len = p[6] as usize;
                panic!("broker closed: {}", String::from_utf8_lossy(&p[7..7 + text_len]));
            }
            assert_eq!(got, (class, method), "unexpected AMQP method");
            return p[4..].to_vec();
        }
    }

    /// Open an AMQP connection labelled `connection_name`, one channel with
    /// `prefetch` and one consumer on `queue`. Returns the socket (kept open by the caller).
    pub async fn consume(port: u16, user: &str, pass: &str, connection_name: &str, queue: &str, prefetch: u16) -> TcpStream {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.expect("AMQP port");
        s.write_all(b"AMQP\x00\x00\x09\x01").await.unwrap();
        expect(&mut s, 10, 10).await; // Connection.Start

        let mut args = table(&[("connection_name", connection_name), ("product", "dbstudio-it"), ("platform", "Rust")]);
        shortstr(&mut args, "PLAIN");
        longstr(&mut args, format!("\0{user}\0{pass}").as_bytes());
        shortstr(&mut args, "en_US");
        s.write_all(&method_frame(0, 10, 11, &args)).await.unwrap(); // StartOk

        let tune = expect(&mut s, 10, 30).await; // Connection.Tune
        let mut ok = tune[0..6].to_vec(); // channel-max (u16) + frame-max (u32) as proposed
        ok.extend_from_slice(&0u16.to_be_bytes()); // no heartbeats
        s.write_all(&method_frame(0, 10, 31, &ok)).await.unwrap(); // TuneOk

        let mut open = Vec::new();
        shortstr(&mut open, "/");
        shortstr(&mut open, "");
        open.push(0);
        s.write_all(&method_frame(0, 10, 40, &open)).await.unwrap();
        expect(&mut s, 10, 41).await; // OpenOk

        let mut ch = Vec::new();
        shortstr(&mut ch, "");
        s.write_all(&method_frame(1, 20, 10, &ch)).await.unwrap();
        expect(&mut s, 20, 11).await; // Channel.OpenOk

        let mut qos = 0u32.to_be_bytes().to_vec();
        qos.extend_from_slice(&prefetch.to_be_bytes());
        qos.push(0);
        s.write_all(&method_frame(1, 60, 10, &qos)).await.unwrap();
        expect(&mut s, 60, 11).await; // Basic.QosOk

        let mut cons = 0u16.to_be_bytes().to_vec();
        shortstr(&mut cons, queue);
        shortstr(&mut cons, "it-consumer");
        cons.push(0); // no-local / no-ack / exclusive / no-wait all false → acks required
        cons.extend_from_slice(&0u32.to_be_bytes()); // empty arguments table
        s.write_all(&method_frame(1, 60, 20, &cons)).await.unwrap();
        expect(&mut s, 60, 21).await; // Basic.ConsumeOk
        s
    }
}

async fn start_with_amqp() -> (ContainerAsync<GenericImage>, u16, u16) {
    let c = GenericImage::new("rabbitmq", "3.13-management-alpine")
        .with_exposed_port(15672.tcp())
        .with_exposed_port(5672.tcp())
        .with_env_var("RABBITMQ_DEFAULT_USER", USER)
        .with_env_var("RABBITMQ_DEFAULT_PASS", PASS)
        .start()
        .await
        .expect("start rabbitmq container (Docker daemon must be running)");
    let http = c.get_host_port_ipv4(15672).await.unwrap();
    let amqp = c.get_host_port_ipv4(5672).await.unwrap();
    (c, http, amqp)
}

/// Every new cluster-workspace command against a real broker: rates appear while
/// messages flow, nodes report memory/disk against their limits, a connection opened
/// by a client is listed with its application name and can be closed, a consumer
/// shows on its queue with its prefetch, and a user without the monitoring tag is
/// told which tag is missing (not "Authentication failed").
#[tokio::test]
async fn rabbitmq_cluster_workspace_rates_nodes_connections_consumers() {
    let (_c, port, amqp_port) = start_with_amqp().await;
    let drv = connect(port).await;
    drv.declare_queue("/", "ws.q", "classic", true, false, json!({})).await.unwrap();

    // ---- rates: publish continuously until the broker reports a rate > 0 ---------------
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        for i in 0..20 {
            drv.publish("/", "", "ws.q", &format!("m{i}"), "string", json!({})).await.unwrap();
        }
        let ov = drv.overview().await.unwrap();
        let q = drv.queue("/", "ws.q").await.unwrap();
        if ov.publish_rate.unwrap_or(0.0) > 0.0 && q.publish_rate.unwrap_or(0.0) > 0.0 {
            break;
        }
        assert!(Instant::now() < deadline, "no publish rate reported (overview {:?}, queue {:?})", ov.publish_rate, q.publish_rate);
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
    drv.purge_queue("/", "ws.q").await.unwrap();

    // ---- nodes ---------------------------------------------------------------------------
    let nodes = drv.nodes().await.unwrap();
    assert!(!nodes.is_empty(), "a broker has at least one node");
    let n = &nodes[0];
    assert!(n.running, "{n:?}");
    assert!(n.mem_used.unwrap_or(0) > 0 && n.mem_limit.unwrap_or(0) > 0, "memory against its limit: {n:?}");
    assert!(n.disk_free.unwrap_or(0) > 0 && n.disk_free_limit.unwrap_or(0) > 0, "disk against its margin: {n:?}");
    assert!(!n.mem_alarm && !n.disk_free_alarm, "a fresh broker raises no alarm: {n:?}");
    assert!(n.uptime_ms.unwrap_or(0) > 0);

    // ---- a client connection + a consumer ----------------------------------------------
    let mut sock = amqp::consume(amqp_port, USER, PASS, "dbstudio-it-app", "ws.q", 7).await;
    let deadline = Instant::now() + Duration::from_secs(45);
    let conn = loop {
        let list = drv.connections().await.unwrap();
        if let Some(c) = list.into_iter().find(|c| c.client_name == "dbstudio-it-app") {
            break c;
        }
        assert!(Instant::now() < deadline, "the client connection never appeared");
        tokio::time::sleep(Duration::from_millis(700)).await;
    };
    assert_eq!(conn.user, USER);
    assert_eq!(conn.vhost, "/");
    assert_eq!(conn.client_product, "dbstudio-it");
    assert!(!conn.ssl);
    assert!(!conn.peer_host.is_empty());

    let deadline = Instant::now() + Duration::from_secs(45);
    let consumer = loop {
        let list = drv.consumers("/").await.unwrap();
        if let Some(k) = list.into_iter().find(|k| k.queue == "ws.q") {
            break k;
        }
        assert!(Instant::now() < deadline, "the consumer never appeared");
        tokio::time::sleep(Duration::from_millis(700)).await;
    };
    assert_eq!(consumer.consumer_tag, "it-consumer");
    assert_eq!(consumer.prefetch_count, Some(7));
    assert!(consumer.ack_required);
    assert_eq!(consumer.connection_name, conn.name, "the consumer joins its connection by name");
    // and the queue counts it
    let deadline = Instant::now() + Duration::from_secs(30);
    while drv.queue("/", "ws.q").await.unwrap().consumers != Some(1) {
        assert!(Instant::now() < deadline, "queue never reported its consumer");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // ---- close it: the client is told, and the broker forgets it -----------------------
    drv.close_connection(&conn.name, "closed by the integration test").await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match amqp::read_frame(&mut sock).await {
                None => return "eof".to_string(),
                Some((1, _, p)) if u16::from_be_bytes([p[0], p[1]]) == 10 && u16::from_be_bytes([p[2], p[3]]) == 50 => {
                    let len = p[6] as usize;
                    return String::from_utf8_lossy(&p[7..7 + len]).to_string();
                }
                Some(_) => continue, // deliveries / heartbeats
            }
        }
    })
    .await
    .expect("the client was not disconnected");
    assert!(closed == "eof" || closed.contains("closed by the integration test"), "{closed}");
    let deadline = Instant::now() + Duration::from_secs(30);
    while drv.connections().await.unwrap().iter().any(|c| c.name == conn.name) {
        assert!(Instant::now() < deadline, "the closed connection is still listed");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(drv.consumers("/").await.unwrap().iter().all(|k| k.queue != "ws.q"), "its consumer went with it");
    // closing a connection that no longer exists is reported, not silent
    assert!(drv.close_connection(&conn.name, "").await.is_err());

    // ---- a user without the monitoring tag: the missing tag is named ------------------
    drv.create_user("mg2", "pw", &["management".into()]).await.unwrap();
    drv.set_permission("/", "mg2", ".*", ".*", ".*").await.unwrap();
    let mut p = params(port, "pw");
    p.user = "mg2".into();
    let mg = RabbitDriver::connect(&p).await.expect("mg2 logs in");
    let m = mg.nodes().await.err().expect("nodes need the monitoring tag").message;
    assert!(m.contains("'monitoring' tag"), "{m}");
    assert!(!m.contains("Authentication failed"), "{m}");
    // what a management user may read still works (its own connections, consumers)
    assert!(mg.connections().await.is_ok());
    assert!(mg.consumers("/").await.is_ok());
}
