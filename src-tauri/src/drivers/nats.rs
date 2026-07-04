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
}
