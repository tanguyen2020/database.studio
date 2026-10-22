//! stream-workspace:nats (W4) — integration tests for the NATS cluster workspace
//! backend (SPEC-NATS-WORKSPACE.md §4) on a real `nats -js` container:
//! account usage, KV status / entries / entry / history (with delete + purge
//! markers), put-returns-version, create-with-settings and live watch.
//!
//! Run (Docker must be up), serially:
//!   cargo test --test stream_nats_integration -- --nocapture --test-threads=1

use std::time::{Duration, Instant};

use database_studio_lib::drivers::nats::{KvCreate, NatsConnParams, NatsDriver};
use futures::StreamExt;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

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
                assert!(Instant::now() < deadline, "{what}: container not ready after 240s — last error: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

async fn start_nats(jetstream: bool) -> (ContainerAsync<GenericImage>, NatsDriver) {
    let img = GenericImage::new("nats", "2.10-alpine").with_exposed_port(4222.tcp());
    let c = if jetstream { img.with_cmd(vec!["-js"]).start().await } else { img.start().await }.expect("start nats container (Docker must be running)");
    let port = c.get_host_port_ipv4(4222).await.unwrap();
    let params = NatsConnParams { host: "localhost".into(), port, user: String::new(), password: String::new(), ssl: false };
    let drv = retry("nats", || NatsDriver::connect(&params)).await;
    (c, drv)
}

fn bucket(name: &str, history: i64, max_age_secs: u64, storage: &str) -> KvCreate {
    serde_json::from_value(serde_json::json!({
        "bucket": name,
        "description": "integration",
        "history": history,
        "max_age_secs": max_age_secs,
        "storage": storage,
        "max_bytes": 0,
        "replicas": 1
    }))
    .unwrap()
}

/// Account info reports JetStream on, the real stream / consumer counts and the
/// storage the account uses.
#[tokio::test]
async fn nats_account_info_counts_streams_and_storage() {
    use async_nats::jetstream;
    let (_c, drv) = start_nats(true).await;
    let before = drv.account_info().await.expect("account info");
    assert!(before.enabled, "JetStream is on (-js)");
    assert_eq!(before.streams, 0);

    let js = jetstream::new(drv.client());
    js.create_stream(jetstream::stream::Config { name: "ACC1".into(), subjects: vec!["acc1.>".into()], ..Default::default() })
        .await
        .unwrap();
    js.create_stream(jetstream::stream::Config { name: "ACC2".into(), subjects: vec!["acc2.>".into()], ..Default::default() })
        .await
        .unwrap();
    for _ in 0..20 {
        js.publish("acc1.x", bytes::Bytes::from(vec![b'x'; 512])).await.unwrap().await.unwrap();
    }
    let s = js.get_stream("ACC1").await.unwrap();
    s.create_consumer(jetstream::consumer::pull::Config { durable_name: Some("reader".into()), ..Default::default() })
        .await
        .unwrap();
    drv.kv_create_bucket(bucket("acc_kv", 1, 0, "file")).await.unwrap();

    let after = drv.account_info().await.unwrap();
    assert_eq!(after.streams, 3, "2 streams + the KV bucket's backing stream");
    assert_eq!(after.consumers, 1);
    assert!(after.storage >= 20 * 512, "storage used reflects the stored messages: {}", after.storage);
    assert_eq!(after.max_storage, None, "a default server sets no account limit");

    // the streams listing now carries the limits the Streams detail reads in words
    let streams = drv.js_streams().await.unwrap();
    let acc1 = streams.iter().find(|x| x.name == "ACC1").unwrap();
    assert_eq!(acc1.limits.last_seq, 20);
    assert_eq!(acc1.limits.max_msgs, -1);
    assert_eq!(acc1.limits.replicas, 1);
    assert!(!acc1.limits.last_time.is_empty());
}

/// Without -js the Overview must say "persistence off" instead of failing.
#[tokio::test]
async fn nats_account_info_without_jetstream_reports_disabled() {
    let (_c, drv) = start_nats(false).await;
    let a = drv.account_info().await.expect("not an error: persistence is simply off");
    assert!(!a.enabled);
    assert!(a.reason.is_some());
}

/// put 3× → history has 3 versions oldest-first; delete adds a DEL marker; purge
/// leaves only a PURGE marker; status reflects the bucket's configuration.
#[tokio::test]
async fn nats_kv_versions_history_markers_and_status() {
    let (_c, drv) = start_nats(true).await;
    let st = drv.kv_create_bucket(bucket("cfg", 10, 1800, "memory")).await.expect("create bucket");
    assert_eq!(st.bucket, "cfg");
    assert_eq!(st.history, 10);
    assert_eq!(st.max_age_ms, 1_800_000);
    assert_eq!(st.storage, "memory");
    assert_eq!(st.replicas, 1);
    assert_eq!(st.description.as_deref(), Some("integration"));

    let r1 = drv.kv_put_version("cfg", "feature.flags", "{\"v\":1}".into()).await.unwrap();
    let r2 = drv.kv_put_version("cfg", "feature.flags", "{\"v\":2}".into()).await.unwrap();
    let r3 = drv.kv_put_version("cfg", "feature.flags", "{\"v\":3}".into()).await.unwrap();
    assert!(r1 < r2 && r2 < r3, "every put is a new, higher version");
    drv.kv_put_version("cfg", "rate.limit", "600".into()).await.unwrap();

    let h = drv.kv_history("cfg", "feature.flags").await.unwrap();
    assert_eq!(h.iter().map(|e| e.revision).collect::<Vec<_>>(), vec![r1, r2, r3], "oldest first");
    assert_eq!(h.iter().map(|e| e.value.as_str()).collect::<Vec<_>>(), vec!["{\"v\":1}", "{\"v\":2}", "{\"v\":3}"]);
    assert!(h.iter().all(|e| e.operation == "put"));
    assert!(h.iter().all(|e| !e.created.is_empty()));

    let cur = drv.kv_entry("cfg", "feature.flags").await.unwrap().expect("current entry");
    assert_eq!((cur.revision, cur.value.as_str(), cur.operation.as_str()), (r3, "{\"v\":3}", "put"));
    assert!(drv.kv_entry("cfg", "never.set").await.unwrap().is_none());
    assert!(drv.kv_history("cfg", "never.set").await.unwrap().is_empty(), "no history, and no hang");

    // delete → a DEL marker on top of the history; the key reads as deleted
    drv.kv_delete("cfg", "feature.flags").await.unwrap();
    let h = drv.kv_history("cfg", "feature.flags").await.unwrap();
    assert_eq!(h.len(), 4);
    assert_eq!(h.last().unwrap().operation, "delete");
    assert_eq!(drv.kv_entry("cfg", "feature.flags").await.unwrap().unwrap().operation, "delete");

    // latest entry per key, deleted ones included as markers
    let all = drv.kv_entries("cfg", 100).await.unwrap();
    assert!(!all.truncated);
    let keys: Vec<(&str, &str)> = all.entries.iter().map(|e| (e.key.as_str(), e.operation.as_str())).collect();
    assert_eq!(keys, vec![("feature.flags", "delete"), ("rate.limit", "put")]);

    // purge → every earlier version gone, only the PURGE marker left
    drv.kv_purge("cfg", "feature.flags").await.unwrap();
    let h = drv.kv_history("cfg", "feature.flags").await.unwrap();
    assert_eq!(h.iter().map(|e| e.operation.as_str()).collect::<Vec<_>>(), vec!["purge"]);

    // status: keys / values / bytes from the server; list = same bucket
    let st = drv.kv_status("cfg").await.unwrap();
    assert_eq!(st.history, 10);
    assert!(st.values >= 2, "rate.limit + the purge marker: {}", st.values);
    assert!(st.bytes > 0);
    let list = drv.kv_bucket_list().await.unwrap();
    assert_eq!(list.iter().map(|b| b.bucket.as_str()).collect::<Vec<_>>(), vec!["cfg"]);
    assert_eq!(list[0].max_age_ms, 1_800_000);

    // history is capped by the bucket: versions kept = 2
    drv.kv_create_bucket(bucket("small", 2, 0, "file")).await.unwrap();
    for v in ["a", "b", "c", "d"] {
        drv.kv_put_version("small", "k", v.into()).await.unwrap();
    }
    let h = drv.kv_history("small", "k").await.unwrap();
    assert_eq!(h.iter().map(|e| e.value.as_str()).collect::<Vec<_>>(), vec!["c", "d"], "only the last 2 versions kept");

    // empty bucket → no entries, no hang
    drv.kv_create_bucket(bucket("empty", 1, 0, "file")).await.unwrap();
    assert!(drv.kv_entries("empty", 100).await.unwrap().entries.is_empty());
}

/// A watch hears new puts and deletes (from any client) — not the old values.
#[tokio::test]
async fn nats_kv_watch_receives_new_changes() {
    let (_c, drv) = start_nats(true).await;
    drv.kv_create_bucket(bucket("live", 5, 0, "file")).await.unwrap();
    drv.kv_put_version("live", "before", "old".into()).await.unwrap();

    let mut watch = drv.kv_watch("live", ">").await.expect("watch");
    // another client changes the bucket
    let other = NatsDriver { client: drv.client() };
    let rev = other.kv_put_version("live", "orders.count", "41".into()).await.unwrap();
    other.kv_delete("live", "orders.count").await.unwrap();

    let first = tokio::time::timeout(Duration::from_secs(10), watch.next()).await.expect("put arrives").unwrap().unwrap();
    assert_eq!(first.key, "orders.count");
    assert_eq!(first.revision, rev);
    assert_eq!(String::from_utf8_lossy(&first.value), "41");
    let second = tokio::time::timeout(Duration::from_secs(10), watch.next()).await.expect("delete arrives").unwrap().unwrap();
    assert_eq!(second.key, "orders.count");
    assert!(matches!(second.operation, async_nats::jetstream::kv::Operation::Delete));

    // a filtered watch only hears its keys
    let mut only = drv.kv_watch("live", "user.*").await.unwrap();
    drv.kv_put_version("live", "orders.count", "42".into()).await.unwrap();
    drv.kv_put_version("live", "user.7", "x".into()).await.unwrap();
    let e = tokio::time::timeout(Duration::from_secs(10), only.next()).await.expect("filtered put").unwrap().unwrap();
    assert_eq!(e.key, "user.7");
}
