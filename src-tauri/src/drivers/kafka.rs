//! Kafka driver (Phase 4) — rdkafka bọc librdkafka. Không phải SQL: metadata +
//! consume/produce + consumer groups + admin. librdkafka build KHÔNG có SSL nên
//! chỉ PLAINTEXT + SASL/PLAIN (SASL_SSL/SCRAM là hạn chế đã ghi nhận).
//!
//! Các lệnh metadata/admin của rdkafka là blocking → bọc spawn_blocking.

use std::sync::Arc;
use std::time::{Duration, Instant};

use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, TopicReplication};
use rdkafka::client::DefaultClientContext;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::message::{Headers, Message};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::{Offset, TopicPartitionList};

use crate::drivers::types::TestResult;
use crate::error::QueryError;

const META_TIMEOUT: Duration = Duration::from_secs(10);

pub struct KafkaDriver {
    /// Consumer dùng cho metadata + (sau) consume. Arc để clone vào spawn_blocking.
    consumer: Arc<BaseConsumer>,
    /// Config gốc để tạo producer / admin client khi cần.
    config: ClientConfig,
}

pub struct KafkaConnParams {
    /// bootstrap servers, phân tách bởi dấu phẩy: host:port,host:port
    pub bootstrap: String,
    /// "" (none) | "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512"
    pub sasl_mechanism: String,
    pub user: String,
    pub password: String,
    pub ssl: bool,
}

fn err(msg: impl Into<String>, raw: impl std::fmt::Display) -> QueryError {
    QueryError::new("kafka", msg.into(), raw.to_string())
}

impl KafkaDriver {
    pub fn build_config(p: &KafkaConnParams) -> ClientConfig {
        let mut c = ClientConfig::new();
        c.set("bootstrap.servers", &p.bootstrap);
        // security.protocol theo auth/ssl (SSL thật cần librdkafka có OpenSSL — hạn chế)
        if !p.sasl_mechanism.is_empty() {
            c.set("security.protocol", if p.ssl { "SASL_SSL" } else { "SASL_PLAINTEXT" });
            c.set("sasl.mechanism", &p.sasl_mechanism);
            c.set("sasl.username", &p.user);
            c.set("sasl.password", &p.password);
        } else if p.ssl {
            c.set("security.protocol", "SSL");
        }
        c
    }

    pub async fn connect(p: &KafkaConnParams) -> Result<Self, QueryError> {
        let config = Self::build_config(p);
        let consumer: BaseConsumer = config
            .create()
            .map_err(|e| err("Failed to create Kafka consumer", e))?;
        let consumer = Arc::new(consumer);
        // xác nhận broker bằng fetch_metadata (blocking → spawn_blocking)
        let c = consumer.clone();
        tokio::task::spawn_blocking(move || c.fetch_metadata(None, META_TIMEOUT))
            .await
            .map_err(|e| err("spawn_blocking error", e))?
            .map_err(|e| err("Failed to fetch metadata (broker unreachable?)", e))?;
        Ok(Self { consumer, config })
    }

    pub async fn test(p: &KafkaConnParams) -> TestResult {
        let started = Instant::now();
        match Self::connect(p).await {
            Ok(mut drv) => {
                let brokers = drv.broker_count().await.unwrap_or(0);
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: Some(format!("Kafka · {brokers} broker(s)")),
                    error: None,
                }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    pub async fn ping(&mut self) -> bool {
        let c = self.consumer.clone();
        tokio::task::spawn_blocking(move || c.fetch_metadata(None, Duration::from_secs(5)))
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    async fn broker_count(&mut self) -> Result<usize, QueryError> {
        let c = self.consumer.clone();
        let md = tokio::task::spawn_blocking(move || c.fetch_metadata(None, META_TIMEOUT))
            .await
            .map_err(|e| err("spawn_blocking error", e))?
            .map_err(|e| err("fetch_metadata error", e))?;
        Ok(md.brokers().len())
    }

    /// Consumer + config để các thao tác Phase 4 sau dùng lại.
    pub fn consumer(&self) -> Arc<BaseConsumer> {
        self.consumer.clone()
    }
    pub fn config(&self) -> ClientConfig {
        self.config.clone()
    }

    // ---- cluster overview (T2) ----------------------------------------------

    /// Broker list + tổng topic/partition (controller = orig broker của metadata).
    pub async fn cluster_info(&self) -> Result<KafkaCluster, QueryError> {
        let c = self.consumer.clone();
        let md = tokio::task::spawn_blocking(move || c.fetch_metadata(None, META_TIMEOUT))
            .await
            .map_err(|e| err("spawn_blocking error", e))?
            .map_err(|e| err("fetch_metadata error", e))?;
        let brokers: Vec<KafkaBroker> = md
            .brokers()
            .iter()
            .map(|b| KafkaBroker { id: b.id(), host: b.host().to_string(), port: b.port() as i32 })
            .collect();
        let topics: Vec<_> = md.topics().iter().filter(|t| t.error().is_none()).collect();
        let partition_count: usize = topics.iter().map(|t| t.partitions().len()).sum();
        Ok(KafkaCluster {
            brokers,
            controller_id: md.orig_broker_id(),
            topic_count: topics.len(),
            partition_count,
        })
    }

    // ---- topic browser (T3) -------------------------------------------------

    /// List topics + partitions (leader/replicas/isr) + watermark offsets + lag.
    pub async fn topics(&self) -> Result<Vec<KafkaTopic>, QueryError> {
        let c = self.consumer.clone();
        let out = tokio::task::spawn_blocking(move || -> Result<Vec<KafkaTopic>, String> {
            let md = c.fetch_metadata(None, META_TIMEOUT).map_err(|e| e.to_string())?;
            let mut topics = Vec::new();
            for t in md.topics() {
                if t.error().is_some() {
                    continue;
                }
                let mut parts = Vec::new();
                for p in t.partitions() {
                    // watermark offsets (earliest/latest) → lag
                    let (low, high) = c
                        .fetch_watermarks(t.name(), p.id(), Duration::from_secs(5))
                        .unwrap_or((0, 0));
                    parts.push(KafkaPartition {
                        id: p.id(),
                        leader: p.leader(),
                        replicas: p.replicas().to_vec(),
                        isr: p.isr().to_vec(),
                        low,
                        high,
                        lag: (high - low).max(0),
                    });
                }
                let internal = t.name().starts_with("__");
                topics.push(KafkaTopic {
                    name: t.name().to_string(),
                    partitions: parts,
                    internal,
                });
            }
            Ok(topics)
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("List topics error", e))?;
        Ok(out)
    }
}

impl KafkaDriver {
    /// Tạo BaseConsumer để DUYỆT message: assign trực tiếp partitions (KHÔNG
    /// subscribe consumer-group). Dùng BaseConsumer + poll trong OS thread riêng
    /// (StreamConsumer async close deadlock nếu ngừng poll — rdkafka gotcha).
    /// from: "earliest" | "latest" | "offset". partition None = tất cả partitions.
    pub fn browse_consumer(
        &self,
        topic: &str,
        from: &str,
        offset: i64,
        partition: Option<i32>,
    ) -> Result<BaseConsumer, QueryError> {
        let mut cfg = self.config.clone();
        cfg.set("group.id", format!("dbstudio-browse-{}", uuid::Uuid::new_v4()));
        cfg.set("enable.auto.commit", "false");
        let consumer: BaseConsumer = cfg.create().map_err(|e| err("Failed to create BaseConsumer", e))?;

        let partitions: Vec<i32> = match partition {
            Some(p) => vec![p],
            None => {
                let md = self
                    .consumer
                    .fetch_metadata(Some(topic), META_TIMEOUT)
                    .map_err(|e| err("fetch_metadata (partitions) error", e))?;
                md.topics()
                    .iter()
                    .find(|t| t.name() == topic)
                    .map(|t| t.partitions().iter().map(|p| p.id()).collect())
                    .unwrap_or_default()
            }
        };
        let off = match from {
            "offset" => Offset::Offset(offset),
            "latest" => Offset::End,
            _ => Offset::Beginning,
        };
        let mut tpl = TopicPartitionList::new();
        for p in partitions {
            tpl.add_partition_offset(topic, p, off).map_err(|e| err("TPL error", e))?;
        }
        consumer.assign(&tpl).map_err(|e| err("assign error", e))?;
        Ok(consumer)
    }

    /// Produce 1 message → (partition, offset) đã land.
    pub async fn produce(
        &self,
        topic: &str,
        key: &str,
        value: &str,
        partition: Option<i32>,
    ) -> Result<(i32, i64), QueryError> {
        let producer: FutureProducer =
            self.config.create().map_err(|e| err("Failed to create producer", e))?;
        let mut record = FutureRecord::to(topic).payload(value);
        if !key.is_empty() {
            record = record.key(key);
        }
        if let Some(p) = partition {
            record = record.partition(p);
        }
        producer
            .send(record, Duration::from_secs(15))
            .await
            .map(|d| (d.partition, d.offset))
            .map_err(|(e, _)| err("Produce error", e))
    }

    // ---- consumer groups (T6) -----------------------------------------------

    /// List consumer groups + members (id/client/host).
    pub async fn consumer_groups(&self) -> Result<Vec<KafkaGroup>, QueryError> {
        let c = self.consumer.clone();
        let out = tokio::task::spawn_blocking(move || -> Result<Vec<KafkaGroup>, String> {
            let gl = c.fetch_group_list(None, META_TIMEOUT).map_err(|e| e.to_string())?;
            let mut groups = Vec::new();
            for g in gl.groups() {
                let members = g
                    .members()
                    .iter()
                    .map(|m| KafkaMember {
                        member_id: m.id().to_string(),
                        client_id: m.client_id().to_string(),
                        host: m.client_host().to_string(),
                    })
                    .collect();
                groups.push(KafkaGroup {
                    name: g.name().to_string(),
                    state: g.state().to_string(),
                    protocol: g.protocol().to_string(),
                    members,
                });
            }
            Ok(groups)
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("fetch_group_list error", e))?;
        Ok(out)
    }

    /// Lag per topic-partition của 1 group: committed offset vs high watermark.
    /// Chỉ trả các partition group đã commit (committed >= 0).
    pub async fn group_lag(&self, group: String) -> Result<Vec<KafkaLag>, QueryError> {
        let cfg = self.config.clone();
        let meta = self.consumer.clone();
        let out = tokio::task::spawn_blocking(move || -> Result<Vec<KafkaLag>, String> {
            // TPL tất cả partition của topic non-internal
            let md = meta.fetch_metadata(None, META_TIMEOUT).map_err(|e| e.to_string())?;
            let mut tpl = TopicPartitionList::new();
            for t in md.topics() {
                if t.name().starts_with("__") {
                    continue;
                }
                for p in t.partitions() {
                    tpl.add_partition(t.name(), p.id());
                }
            }
            // consumer với group.id = group để lấy committed offsets
            let mut gcfg = cfg;
            gcfg.set("group.id", &group);
            let gc: BaseConsumer = gcfg.create().map_err(|e| e.to_string())?;
            let committed = gc.committed_offsets(tpl, META_TIMEOUT).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for elem in committed.elements() {
                let off = match elem.offset() {
                    rdkafka::Offset::Offset(o) => o,
                    _ => continue, // group chưa commit partition này
                };
                let (_low, high) = gc
                    .fetch_watermarks(elem.topic(), elem.partition(), Duration::from_secs(5))
                    .unwrap_or((0, off));
                out.push(KafkaLag {
                    topic: elem.topic().to_string(),
                    partition: elem.partition(),
                    committed: off,
                    high,
                    lag: (high - off).max(0),
                });
            }
            Ok(out)
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("group_lag error", e))?;
        Ok(out)
    }

    /// Reset offset của group cho 1 topic-partition → target (earliest/latest/offset).
    /// Chỉ chạy được khi group KHÔNG có member active (Kafka từ chối commit lúc active).
    pub async fn reset_group_offset(
        &self,
        group: String,
        topic: String,
        partition: i32,
        target: String,
        offset: i64,
    ) -> Result<(), QueryError> {
        let cfg = self.config.clone();
        let meta = self.consumer.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            // xác định offset đích
            let target_off = match target.as_str() {
                "offset" => offset,
                "latest" => {
                    let (_l, h) = meta
                        .fetch_watermarks(&topic, partition, Duration::from_secs(5))
                        .map_err(|e| e.to_string())?;
                    h
                }
                _ => {
                    let (l, _h) = meta
                        .fetch_watermarks(&topic, partition, Duration::from_secs(5))
                        .map_err(|e| e.to_string())?;
                    l
                }
            };
            let mut gcfg = cfg;
            gcfg.set("group.id", &group);
            let gc: BaseConsumer = gcfg.create().map_err(|e| e.to_string())?;
            let mut tpl = TopicPartitionList::new();
            tpl.add_partition_offset(&topic, partition, rdkafka::Offset::Offset(target_off))
                .map_err(|e| e.to_string())?;
            gc.commit(&tpl, rdkafka::consumer::CommitMode::Sync).map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("reset offset error (group active?)", e))?;
        Ok(())
    }

    /// Tạo topic (admin) — partitions + replication factor.
    pub async fn create_topic(&self, name: &str, partitions: i32, replication: i32) -> Result<(), QueryError> {
        let admin: AdminClient<DefaultClientContext> =
            self.config.create().map_err(|e| err("Failed to create admin client", e))?;
        let nt = NewTopic::new(name, partitions, TopicReplication::Fixed(replication));
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(30)));
        let res = admin
            .create_topics([&nt], &opts)
            .await
            .map_err(|e| err("create_topics error", e))?;
        for r in res {
            r.map_err(|(t, e)| err(format!("Failed to create topic '{t}'"), e))?;
        }
        Ok(())
    }

    /// Clear a topic's messages WITHOUT dropping the topic: delete every record
    /// up to each partition's high watermark (KIP-107 DeleteRecords). Keeps the
    /// topic, its partitions, config and ACLs intact — just empties it.
    pub async fn purge_topic(&self, name: &str) -> Result<(), QueryError> {
        let consumer = self.consumer.clone();
        let topic = name.to_string();
        // fetch partitions + high watermark (blocking rdkafka calls)
        let tpl = tokio::task::spawn_blocking(move || -> Result<TopicPartitionList, String> {
            let md = consumer.fetch_metadata(Some(&topic), META_TIMEOUT).map_err(|e| e.to_string())?;
            let t = md
                .topics()
                .iter()
                .find(|t| t.name() == topic)
                .ok_or_else(|| format!("topic '{topic}' not found"))?;
            if t.partitions().is_empty() {
                return Err(format!("topic '{topic}' has no partitions"));
            }
            let mut tpl = TopicPartitionList::new();
            for p in t.partitions() {
                let (_low, high) = consumer
                    .fetch_watermarks(&topic, p.id(), Duration::from_secs(5))
                    .map_err(|e| e.to_string())?;
                // DeleteRecords deletes everything BEFORE this offset → high == all.
                tpl.add_partition_offset(&topic, p.id(), Offset::Offset(high))
                    .map_err(|e| e.to_string())?;
            }
            Ok(tpl)
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("Failed to read topic watermarks", e))?;

        let admin: AdminClient<DefaultClientContext> =
            self.config.create().map_err(|e| err("Failed to create admin client", e))?;
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(30)));
        admin.delete_records(&tpl, &opts).await.map_err(|e| err("delete_records error", e))?;
        Ok(())
    }

    /// Xóa topic (admin).
    pub async fn delete_topic(&self, name: &str) -> Result<(), QueryError> {
        let admin: AdminClient<DefaultClientContext> =
            self.config.create().map_err(|e| err("Failed to create admin client", e))?;
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(30)));
        let res = admin
            .delete_topics(&[name], &opts)
            .await
            .map_err(|e| err("delete_topics error", e))?;
        for r in res {
            r.map_err(|(t, e)| err(format!("Failed to delete topic '{t}'"), e))?;
        }
        Ok(())
    }
}

/// Message consume được (value/key decode UTF-8 lossy; frontend tự pretty JSON).
#[derive(Debug, serde::Serialize, Clone)]
pub struct KafkaMessage {
    pub partition: i32,
    pub offset: i64,
    pub timestamp: i64,
    pub key: String,
    pub value: String,
    pub headers: Vec<(String, String)>,
}

/// Convert 1 BorrowedMessage (từ StreamConsumer.recv) → KafkaMessage.
pub fn borrowed_to_message(m: &rdkafka::message::BorrowedMessage) -> KafkaMessage {
    let key = m.key().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
    let value = m.payload().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
    let mut headers = Vec::new();
    if let Some(hs) = m.headers() {
        for i in 0..hs.count() {
            let h = hs.get(i);
            let v = h.value.map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
            headers.push((h.key.to_string(), v));
        }
    }
    KafkaMessage {
        partition: m.partition(),
        offset: m.offset(),
        timestamp: m.timestamp().to_millis().unwrap_or(0),
        key,
        value,
        headers,
    }
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaMember {
    pub member_id: String,
    pub client_id: String,
    pub host: String,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaGroup {
    pub name: String,
    pub state: String,
    pub protocol: String,
    pub members: Vec<KafkaMember>,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaLag {
    pub topic: String,
    pub partition: i32,
    pub committed: i64,
    pub high: i64,
    pub lag: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaBroker {
    pub id: i32,
    pub host: String,
    pub port: i32,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaCluster {
    pub brokers: Vec<KafkaBroker>,
    pub controller_id: i32,
    pub topic_count: usize,
    pub partition_count: usize,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaPartition {
    pub id: i32,
    pub leader: i32,
    pub replicas: Vec<i32>,
    pub isr: Vec<i32>,
    pub low: i64,
    pub high: i64,
    pub lag: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaTopic {
    pub name: String,
    pub partitions: Vec<KafkaPartition>,
    pub internal: bool,
}
