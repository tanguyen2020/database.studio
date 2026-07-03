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
    /// Dựng redis::Client từ params (dùng chung cho connection thường + pub/sub).
    pub fn client(p: &RedisConnParams) -> Result<redis::Client, QueryError> {
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
        if p.ssl && !p.ssl_ca.is_empty() {
            let ca = std::fs::read(&p.ssl_ca)
                .map_err(|e| err(format!("Không đọc được CA cert: {}", p.ssl_ca), e))?;
            redis::Client::build_with_tls(
                info,
                redis::TlsCertificates { client_tls: None, root_cert: Some(ca) },
            )
            .map_err(|e| err("Cấu hình TLS Redis lỗi", e))
        } else {
            redis::Client::open(info).map_err(|e| err("Redis connection info lỗi", e))
        }
    }

    async fn open(p: &RedisConnParams) -> Result<redis::aio::MultiplexedConnection, QueryError> {
        Self::client(p)?
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| err(format!("Không kết nối được Redis {}:{}", p.host, p.port), e))
    }

    /// Mở connection PUB/SUB riêng (redis pub/sub chiếm trọn 1 connection).
    pub async fn open_pubsub(p: &RedisConnParams) -> Result<redis::aio::PubSub, QueryError> {
        Self::client(p)?
            .get_async_pubsub()
            .await
            .map_err(|e| err("Không mở được Redis pub/sub", e))
    }

    /// PUBLISH channel message → số subscriber nhận.
    pub async fn publish(&mut self, channel: &str, message: &str) -> Result<i64, QueryError> {
        redis::cmd("PUBLISH")
            .arg(channel)
            .arg(message)
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("PUBLISH lỗi", e))
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

    /// Đọc key: TYPE + TTL + giá trị theo đúng kiểu (GET/HGETALL/LRANGE/SMEMBERS/
    /// ZRANGE WITHSCORES/XRANGE). Stream parse thủ công từ redis::Value.
    pub async fn get_value(&mut self, key: &str) -> Result<RedisKeyValue, QueryError> {
        let key_type: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("TYPE lỗi", e))?;
        let ttl: i64 = redis::cmd("TTL").arg(key).query_async(&mut self.conn).await.unwrap_or(-1);

        let value = match key_type.as_str() {
            "string" => RedisValue::String {
                value: redis::cmd("GET").arg(key).query_async(&mut self.conn).await.map_err(|e| err("GET lỗi", e))?,
            },
            "hash" => RedisValue::Hash {
                fields: redis::cmd("HGETALL").arg(key).query_async(&mut self.conn).await.map_err(|e| err("HGETALL lỗi", e))?,
            },
            "list" => RedisValue::List {
                items: redis::cmd("LRANGE").arg(key).arg(0).arg(-1).query_async(&mut self.conn).await.map_err(|e| err("LRANGE lỗi", e))?,
            },
            "set" => RedisValue::Set {
                members: redis::cmd("SMEMBERS").arg(key).query_async(&mut self.conn).await.map_err(|e| err("SMEMBERS lỗi", e))?,
            },
            "zset" => {
                // ZRANGE … WITHSCORES → [member, score, member, score, …]
                let flat: Vec<String> = redis::cmd("ZRANGE")
                    .arg(key).arg(0).arg(-1).arg("WITHSCORES")
                    .query_async(&mut self.conn).await.map_err(|e| err("ZRANGE lỗi", e))?;
                let mut members = Vec::new();
                let mut it = flat.into_iter();
                while let (Some(m), Some(s)) = (it.next(), it.next()) {
                    members.push((m, s.parse::<f64>().unwrap_or(0.0)));
                }
                RedisValue::Zset { members }
            }
            "stream" => {
                let raw: redis::Value = redis::cmd("XRANGE")
                    .arg(key).arg("-").arg("+")
                    .query_async(&mut self.conn).await.map_err(|e| err("XRANGE lỗi", e))?;
                RedisValue::Stream { entries: parse_stream(&raw) }
            }
            _ => RedisValue::None,
        };
        Ok(RedisKeyValue { key_type, ttl, value })
    }

    /// Xóa key (DEL) — trả số key đã xóa (0/1).
    pub async fn del(&mut self, key: &str) -> Result<u64, QueryError> {
        redis::cmd("DEL").arg(key).query_async(&mut self.conn).await.map_err(|e| err("DEL lỗi", e))
    }

    /// Sửa giá trị theo op (per-type). Chạy đúng lệnh Redis tương ứng.
    pub async fn apply_edit(&mut self, key: &str, op: RedisEditOp) -> Result<(), QueryError> {
        let c = &mut self.conn;
        match op {
            RedisEditOp::SetString { value } => {
                let _: () = redis::cmd("SET").arg(key).arg(value).query_async(c).await.map_err(|e| err("SET lỗi", e))?;
            }
            RedisEditOp::HSet { field, value } => {
                let _: i64 = redis::cmd("HSET").arg(key).arg(field).arg(value).query_async(c).await.map_err(|e| err("HSET lỗi", e))?;
            }
            RedisEditOp::HDel { field } => {
                let _: i64 = redis::cmd("HDEL").arg(key).arg(field).query_async(c).await.map_err(|e| err("HDEL lỗi", e))?;
            }
            RedisEditOp::RPush { value } => {
                let _: i64 = redis::cmd("RPUSH").arg(key).arg(value).query_async(c).await.map_err(|e| err("RPUSH lỗi", e))?;
            }
            RedisEditOp::LSet { index, value } => {
                let _: () = redis::cmd("LSET").arg(key).arg(index).arg(value).query_async(c).await.map_err(|e| err("LSET lỗi", e))?;
            }
            RedisEditOp::LRem { value } => {
                let _: i64 = redis::cmd("LREM").arg(key).arg(0).arg(value).query_async(c).await.map_err(|e| err("LREM lỗi", e))?;
            }
            RedisEditOp::SAdd { member } => {
                let _: i64 = redis::cmd("SADD").arg(key).arg(member).query_async(c).await.map_err(|e| err("SADD lỗi", e))?;
            }
            RedisEditOp::SRem { member } => {
                let _: i64 = redis::cmd("SREM").arg(key).arg(member).query_async(c).await.map_err(|e| err("SREM lỗi", e))?;
            }
            RedisEditOp::ZAdd { member, score } => {
                let _: i64 = redis::cmd("ZADD").arg(key).arg(score).arg(member).query_async(c).await.map_err(|e| err("ZADD lỗi", e))?;
            }
            RedisEditOp::ZRem { member } => {
                let _: i64 = redis::cmd("ZREM").arg(key).arg(member).query_async(c).await.map_err(|e| err("ZREM lỗi", e))?;
            }
            RedisEditOp::XAdd { fields } => {
                let mut cmd = redis::cmd("XADD");
                cmd.arg(key).arg("*");
                for (f, v) in fields {
                    cmd.arg(f).arg(v);
                }
                let _: String = cmd.query_async(c).await.map_err(|e| err("XADD lỗi", e))?;
            }
            RedisEditOp::XDel { id } => {
                let _: i64 = redis::cmd("XDEL").arg(key).arg(id).query_async(c).await.map_err(|e| err("XDEL lỗi", e))?;
            }
        }
        Ok(())
    }

    /// CLI console: chạy 1 lệnh Redis thô (args đã tách) → RESP format text.
    pub async fn command(&mut self, args: &[String]) -> Result<String, QueryError> {
        let Some(name) = args.first() else {
            return Err(err("Lệnh rỗng", "empty command"));
        };
        let mut cmd = redis::cmd(name);
        for a in &args[1..] {
            cmd.arg(a);
        }
        let v: redis::Value = cmd
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err(format!("{} lỗi", name.to_uppercase()), e))?;
        Ok(format_resp(&v))
    }

    /// MEMORY USAGE key → bytes (None nếu key không tồn tại).
    pub async fn memory_usage(&mut self, key: &str) -> Result<Option<u64>, QueryError> {
        redis::cmd("MEMORY")
            .arg("USAGE")
            .arg(key)
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("MEMORY USAGE lỗi", e))
    }

    /// FLUSHDB — xóa toàn bộ DB hiện tại.
    pub async fn flushdb(&mut self) -> Result<(), QueryError> {
        let _: () = redis::cmd("FLUSHDB")
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("FLUSHDB lỗi", e))?;
        Ok(())
    }

    /// Đặt TTL: secs > 0 → EXPIRE; secs <= 0 → PERSIST (bỏ hết hạn).
    pub async fn set_ttl(&mut self, key: &str, secs: i64) -> Result<(), QueryError> {
        if secs > 0 {
            let _: i64 = redis::cmd("EXPIRE").arg(key).arg(secs).query_async(&mut self.conn).await.map_err(|e| err("EXPIRE lỗi", e))?;
        } else {
            let _: i64 = redis::cmd("PERSIST").arg(key).query_async(&mut self.conn).await.map_err(|e| err("PERSIST lỗi", e))?;
        }
        Ok(())
    }
}

/// Parse mảng XRANGE (Array of [id, [f,v,…]]) → StreamEntry[].
fn parse_stream(raw: &redis::Value) -> Vec<StreamEntry> {
    let mut out = Vec::new();
    if let redis::Value::Array(entries) = raw {
        for e in entries {
            if let redis::Value::Array(pair) = e {
                if pair.len() == 2 {
                    let id = val_to_string(&pair[0]);
                    let mut fields = Vec::new();
                    if let redis::Value::Array(fv) = &pair[1] {
                        let mut it = fv.iter();
                        while let (Some(f), Some(v)) = (it.next(), it.next()) {
                            fields.push((val_to_string(f), val_to_string(v)));
                        }
                    }
                    out.push(StreamEntry { id, fields });
                }
            }
        }
    }
    out
}

/// Một key trong SCAN — tên + kiểu (string/hash/list/set/zset/stream) + TTL giây
/// (-1 = không hết hạn, -2 = không tồn tại).
#[derive(Debug, serde::Serialize)]
pub struct RedisKey {
    pub name: String,
    pub key_type: String,
    pub ttl: i64,
}

/// Một entry stream: ID + danh sách field/value.
#[derive(Debug, serde::Serialize)]
pub struct StreamEntry {
    pub id: String,
    pub fields: Vec<(String, String)>,
}

/// Giá trị key theo kiểu (tagged union cho frontend render đúng viewer).
#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RedisValue {
    String { value: String },
    Hash { fields: Vec<(String, String)> },
    List { items: Vec<String> },
    Set { members: Vec<String> },
    Zset { members: Vec<(String, f64)> },
    Stream { entries: Vec<StreamEntry> },
    None,
}

/// Kết quả đọc 1 key: kiểu + TTL + giá trị.
#[derive(Debug, serde::Serialize)]
pub struct RedisKeyValue {
    pub key_type: String,
    pub ttl: i64,
    pub value: RedisValue,
}

/// Thao tác sửa giá trị per-type (từ frontend). tag "op".
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum RedisEditOp {
    SetString { value: String },
    HSet { field: String, value: String },
    HDel { field: String },
    RPush { value: String },
    LSet { index: i64, value: String },
    LRem { value: String },
    SAdd { member: String },
    SRem { member: String },
    ZAdd { member: String, score: f64 },
    ZRem { member: String },
    XAdd { fields: Vec<(String, String)> },
    XDel { id: String },
}

/// Format redis::Value kiểu RESP cho CLI console (giống redis-cli gọn).
fn format_resp(v: &redis::Value) -> String {
    match v {
        redis::Value::Nil => "(nil)".into(),
        redis::Value::Int(i) => format!("(integer) {i}"),
        redis::Value::BulkString(b) => format!("\"{}\"", String::from_utf8_lossy(b)),
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::Okay => "OK".into(),
        redis::Value::Double(d) => format!("(double) {d}"),
        redis::Value::Boolean(b) => format!("(boolean) {b}"),
        redis::Value::Array(items) | redis::Value::Set(items) => {
            if items.is_empty() {
                "(empty)".into()
            } else {
                items
                    .iter()
                    .enumerate()
                    .map(|(i, it)| format!("{}) {}", i + 1, format_resp(it)))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }
        other => format!("{other:?}"),
    }
}

fn val_to_string(v: &redis::Value) -> String {
    match v {
        redis::Value::Nil => String::new(),
        redis::Value::Int(i) => i.to_string(),
        redis::Value::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::Double(d) => d.to_string(),
        redis::Value::Boolean(b) => b.to_string(),
        other => format!("{other:?}"),
    }
}

/// Kết quả 1 vòng SCAN gửi ra frontend.
#[derive(Debug, serde::Serialize)]
pub struct RedisScan {
    pub cursor: u64,
    pub keys: Vec<RedisKey>,
    pub dbsize: u64,
}
