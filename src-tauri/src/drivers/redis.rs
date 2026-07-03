//! Redis driver (Phase 3) — redis-rs async multiplexed connection.
//! Không phải SQL: các thao tác đi qua lệnh Redis chuyên biệt (SCAN/TYPE/TTL/…)
//! thêm ở T3+. Ở đây: connect/test/ping + chọn DB index + TLS (rediss).

use std::time::Instant;

use redis::{ConnectionAddr, ConnectionInfo, ProtocolVersion, RedisConnectionInfo};

use crate::drivers::types::TestResult;
use crate::error::QueryError;

pub struct RedisDriver {
    conn: redis::aio::MultiplexedConnection,
}

pub struct RedisConnParams {
    pub host: String,
    pub port: u16,
    /// Empty = no AUTH.
    pub password: String,
    /// DB index 0–15.
    pub db: i64,
    pub ssl: bool,
    /// Optional CA cert (PEM) path for self-signed rediss servers.
    pub ssl_ca: String,
}

fn err(msg: impl Into<String>, raw: impl std::fmt::Display) -> QueryError {
    QueryError::new("redis", msg.into(), raw.to_string())
}

impl RedisDriver {
    async fn open(p: &RedisConnParams) -> Result<redis::aio::MultiplexedConnection, QueryError> {
        let addr = if p.ssl {
            ConnectionAddr::TcpTls {
                host: p.host.clone(),
                port: p.port,
                insecure: false,
                tls_params: None,
            }
        } else {
            ConnectionAddr::Tcp(p.host.clone(), p.port)
        };
        let info = ConnectionInfo {
            addr,
            redis: RedisConnectionInfo {
                db: p.db,
                username: None,
                password: if p.password.is_empty() { None } else { Some(p.password.clone()) },
                protocol: ProtocolVersion::RESP2,
            },
        };
        // CA tùy chọn cho self-signed rediss → build_with_tls; còn lại webpki roots.
        let client = if p.ssl && !p.ssl_ca.is_empty() {
            let ca = std::fs::read(&p.ssl_ca)
                .map_err(|e| err(format!("Không đọc được CA cert: {}", p.ssl_ca), e))?;
            redis::Client::build_with_tls(
                info,
                redis::TlsCertificates { client_tls: None, root_cert: Some(ca) },
            )
            .map_err(|e| err("Cấu hình TLS Redis lỗi", e))?
        } else {
            redis::Client::open(info).map_err(|e| err("Redis connection info lỗi", e))?
        };
        client
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| err(format!("Không kết nối được Redis {}:{}", p.host, p.port), e))
    }

    pub async fn connect(p: &RedisConnParams) -> Result<Self, QueryError> {
        let mut conn = Self::open(p).await?;
        // Xác nhận handshake bằng PING (bắt sai password/DB sớm).
        let _: String = redis::cmd("PING")
            .query_async(&mut conn)
            .await
            .map_err(|e| err("Redis PING thất bại (sai password?)", e))?;
        Ok(Self { conn })
    }

    pub async fn test(p: &RedisConnParams) -> TestResult {
        let started = Instant::now();
        match Self::open(p).await {
            Ok(mut conn) => {
                let pong: Result<String, _> = redis::cmd("PING").query_async(&mut conn).await;
                if let Err(e) = pong {
                    return TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.to_string()) };
                }
                // INFO server → phiên bản (best-effort).
                let version = redis::cmd("INFO")
                    .arg("server")
                    .query_async::<String>(&mut conn)
                    .await
                    .ok()
                    .and_then(|info| {
                        info.lines()
                            .find_map(|l| l.strip_prefix("redis_version:").map(|v| format!("Redis {}", v.trim())))
                    });
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
        redis::cmd("PING").query_async::<String>(&mut self.conn).await.is_ok()
    }

    /// Số key trong DB hiện tại (DBSIZE).
    pub async fn dbsize(&mut self) -> Result<u64, QueryError> {
        redis::cmd("DBSIZE")
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("DBSIZE lỗi", e))
    }

    /// SCAN cursor-based (KHÔNG dùng KEYS *) + TYPE + TTL cho từng key.
    /// Trả (cursor kế tiếp, keys). cursor = 0 nghĩa là hết vòng.
    pub async fn scan(
        &mut self,
        pattern: &str,
        cursor: u64,
        count: usize,
    ) -> Result<(u64, Vec<RedisKey>), QueryError> {
        let pat = if pattern.is_empty() { "*" } else { pattern };
        let (next, names): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pat)
            .arg("COUNT")
            .arg(count.max(1))
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("SCAN lỗi", e))?;

        let mut keys = Vec::with_capacity(names.len());
        for name in names {
            let key_type: String = redis::cmd("TYPE")
                .arg(&name)
                .query_async(&mut self.conn)
                .await
                .unwrap_or_else(|_| "none".into());
            let ttl: i64 = redis::cmd("TTL").arg(&name).query_async(&mut self.conn).await.unwrap_or(-1);
            keys.push(RedisKey { name, key_type, ttl });
        }
        Ok((next, keys))
    }
}

/// Một key trong SCAN — tên + kiểu (string/hash/list/set/zset/stream) + TTL giây
/// (-1 = không hết hạn, -2 = không tồn tại).
#[derive(Debug, serde::Serialize)]
pub struct RedisKey {
    pub name: String,
    pub key_type: String,
    pub ttl: i64,
}

/// Kết quả 1 vòng SCAN gửi ra frontend.
#[derive(Debug, serde::Serialize)]
pub struct RedisScan {
    pub cursor: u64,
    pub keys: Vec<RedisKey>,
    pub dbsize: u64,
}
