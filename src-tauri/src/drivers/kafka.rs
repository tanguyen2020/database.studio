//! Kafka driver (Phase 4) — rdkafka bọc librdkafka. Không phải SQL: metadata +
//! consume/produce + consumer groups + admin. librdkafka build KHÔNG có SSL nên
//! chỉ PLAINTEXT + SASL/PLAIN (SASL_SSL/SCRAM là hạn chế đã ghi nhận).
//!
//! Các lệnh metadata/admin của rdkafka là blocking → bọc spawn_blocking.

use std::sync::Arc;
use std::time::{Duration, Instant};

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
}
