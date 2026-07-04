//! NATS driver (Phase 3) — async-nats. Không phải SQL: pub/sub + request/reply +
//! JetStream (T9/T10). Ở đây: connect/test/ping. Client multiplexed (clone rẻ).

use std::time::Instant;

use crate::drivers::types::TestResult;
use crate::error::QueryError;

pub struct NatsDriver {
    pub client: async_nats::Client,
}

pub struct NatsConnParams {
    pub host: String,
    pub port: u16,
    /// Auth username/password (rỗng = no-auth).
    pub user: String,
    pub password: String,
    pub ssl: bool,
}

fn err(msg: impl Into<String>, raw: impl std::fmt::Display) -> QueryError {
    QueryError::new("nats", msg.into(), raw.to_string())
}

impl NatsDriver {
    async fn open(p: &NatsConnParams) -> Result<async_nats::Client, QueryError> {
        let mut opts = async_nats::ConnectOptions::new();
        if !p.user.is_empty() {
            opts = opts.user_and_password(p.user.clone(), p.password.clone());
        }
        if p.ssl {
            opts = opts.require_tls(true);
        }
        let url = format!("nats://{}:{}", p.host, p.port);
        opts.connect(&url)
            .await
            .map_err(|e| err(format!("Không kết nối được NATS {url}"), e))
    }

    pub async fn connect(p: &NatsConnParams) -> Result<Self, QueryError> {
        Ok(Self { client: Self::open(p).await? })
    }

    pub async fn test(p: &NatsConnParams) -> TestResult {
        let started = Instant::now();
        match Self::open(p).await {
            Ok(client) => {
                let version = {
                    let info = client.server_info();
                    if info.version.is_empty() { None } else { Some(format!("NATS {}", info.version)) }
                };
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: version,
                    error: None,
                }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    pub async fn ping(&mut self) -> bool {
        matches!(self.client.connection_state(), async_nats::connection::State::Connected)
    }

    /// Subscribe subject/wildcard (`>`, `*`) → Subscriber stream (task nền đọc).
    pub async fn subscribe(&self, subject: String) -> Result<async_nats::Subscriber, QueryError> {
        self.client
            .subscribe(subject)
            .await
            .map_err(|e| err("Subscribe lỗi", e))
    }

    /// Publish payload lên subject (kèm reply-to tùy chọn), flush để chắc chắn gửi.
    pub async fn publish(
        &self,
        subject: String,
        payload: String,
        reply: Option<String>,
    ) -> Result<(), QueryError> {
        let bytes = bytes::Bytes::from(payload.into_bytes());
        match reply {
            Some(r) => self
                .client
                .publish_with_reply(subject, r, bytes)
                .await
                .map_err(|e| err("Publish lỗi", e))?,
            None => self.client.publish(subject, bytes).await.map_err(|e| err("Publish lỗi", e))?,
        }
        self.client.flush().await.map_err(|e| err("Flush lỗi", e))?;
        Ok(())
    }

    /// Request/Reply với timeout → payload trả về (UTF-8) hoặc lỗi timeout.
    pub async fn request(
        &self,
        subject: String,
        payload: String,
        timeout_ms: u64,
    ) -> Result<String, QueryError> {
        let fut = self.client.request(subject, bytes::Bytes::from(payload.into_bytes()));
        let msg = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), fut)
            .await
            .map_err(|_| err("Request timeout", "no reply within timeout"))?
            .map_err(|e| err("Request lỗi", e))?;
        Ok(String::from_utf8_lossy(&msg.payload).into_owned())
    }

    pub fn server_info(&self) -> async_nats::ServerInfo {
        self.client.server_info()
    }

    pub fn client(&self) -> async_nats::Client {
        self.client.clone()
    }

    // ---- JetStream (T10) ----------------------------------------------------

    /// List streams + config/state cơ bản.
    pub async fn js_streams(&self) -> Result<Vec<JsStream>, QueryError> {
        use futures::TryStreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let mut out = Vec::new();
        let mut infos = js.streams();
        while let Some(info) = infos.try_next().await.map_err(|e| err("List streams lỗi", e))? {
            out.push(JsStream {
                name: info.config.name,
                subjects: info.config.subjects,
                retention: format!("{:?}", info.config.retention),
                storage: format!("{:?}", info.config.storage),
                messages: info.state.messages,
                bytes: info.state.bytes,
                consumers: info.state.consumer_count as u64,
            });
        }
        Ok(out)
    }

    /// List consumers của 1 stream.
    pub async fn js_consumers(&self, stream: &str) -> Result<Vec<JsConsumer>, QueryError> {
        use futures::TryStreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Get stream lỗi", e))?;
        let mut out = Vec::new();
        let mut cons = s.consumers();
        while let Some(ci) = cons.try_next().await.map_err(|e| err("List consumers lỗi", e))? {
            out.push(JsConsumer {
                name: ci.name,
                deliver_policy: format!("{:?}", ci.config.deliver_policy),
                ack_policy: format!("{:?}", ci.config.ack_policy),
                filter_subject: ci.config.filter_subject,
                num_pending: ci.num_pending,
                num_ack_pending: ci.num_ack_pending as u64,
            });
        }
        Ok(out)
    }

    /// Peek message theo sequence number.
    pub async fn js_peek(&self, stream: &str, seq: u64) -> Result<JsMessage, QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Get stream lỗi", e))?;
        let raw = s.get_raw_message(seq).await.map_err(|e| err(format!("Peek seq {seq} lỗi"), e))?;
        Ok(JsMessage {
            seq: raw.sequence,
            subject: raw.subject.to_string(),
            payload: String::from_utf8_lossy(&raw.payload).into_owned(),
            time: raw.time.to_string(),
        })
    }
}

#[derive(Debug, serde::Serialize)]
pub struct JsStream {
    pub name: String,
    pub subjects: Vec<String>,
    pub retention: String,
    pub storage: String,
    pub messages: u64,
    pub bytes: u64,
    pub consumers: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct JsConsumer {
    pub name: String,
    pub deliver_policy: String,
    pub ack_policy: String,
    pub filter_subject: String,
    pub num_pending: u64,
    pub num_ack_pending: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct JsMessage {
    pub seq: u64,
    pub subject: String,
    pub payload: String,
    pub time: String,
}
