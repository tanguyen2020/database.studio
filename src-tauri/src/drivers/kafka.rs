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
            .map_err(|e| err("Tạo Kafka consumer lỗi", e))?;
        let consumer = Arc::new(consumer);
        // xác nhận broker bằng fetch_metadata (blocking → spawn_blocking)
        let c = consumer.clone();
        tokio::task::spawn_blocking(move || c.fetch_metadata(None, META_TIMEOUT))
            .await
            .map_err(|e| err("spawn_blocking lỗi", e))?
            .map_err(|e| err("Không lấy được metadata (broker không tới được?)", e))?;
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
            .map_err(|e| err("spawn_blocking lỗi", e))?
            .map_err(|e| err("fetch_metadata lỗi", e))?;
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
            .map_err(|e| err("spawn_blocking lỗi", e))?
            .map_err(|e| err("fetch_metadata lỗi", e))?;
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
        .map_err(|e| err("spawn_blocking lỗi", e))?
        .map_err(|e| err("List topics lỗi", e))?;
        Ok(out)
    }
}

impl KafkaDriver {
    /// Tạo topic (admin) — partitions + replication factor.
    pub async fn create_topic(&self, name: &str, partitions: i32, replication: i32) -> Result<(), QueryError> {
        let admin: AdminClient<DefaultClientContext> =
            self.config.create().map_err(|e| err("Tạo admin client lỗi", e))?;
        let nt = NewTopic::new(name, partitions, TopicReplication::Fixed(replication));
        let res = admin
            .create_topics([&nt], &AdminOptions::new())
            .await
            .map_err(|e| err("create_topics lỗi", e))?;
        for r in res {
            r.map_err(|(t, e)| err(format!("Tạo topic '{t}' lỗi"), e))?;
        }
        Ok(())
    }

    /// Xóa topic (admin).
    pub async fn delete_topic(&self, name: &str) -> Result<(), QueryError> {
        let admin: AdminClient<DefaultClientContext> =
            self.config.create().map_err(|e| err("Tạo admin client lỗi", e))?;
        let res = admin
            .delete_topics(&[name], &AdminOptions::new())
            .await
            .map_err(|e| err("delete_topics lỗi", e))?;
        for r in res {
            r.map_err(|(t, e)| err(format!("Xóa topic '{t}' lỗi"), e))?;
        }
        Ok(())
    }
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
