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
                .map_err(|e| err(format!("Failed to read CA cert: {}", p.ssl_ca), e))?;
            redis::Client::build_with_tls(
                info,
                redis::TlsCertificates { client_tls: None, root_cert: Some(ca) },
            )
            .map_err(|e| err("Redis TLS configuration error", e))
        } else {
            redis::Client::open(info).map_err(|e| err("Redis connection info error", e))
        }
    }

    async fn open(p: &RedisConnParams) -> Result<redis::aio::MultiplexedConnection, QueryError> {
        Self::client(p)?
            .get_multiplexed_async_connection()
            .await
            .map_err(|e| err(format!("Failed to connect to Redis {}:{}", p.host, p.port), e))
    }

    /// Mở connection PUB/SUB riêng (redis pub/sub chiếm trọn 1 connection).
    pub async fn open_pubsub(p: &RedisConnParams) -> Result<redis::aio::PubSub, QueryError> {
        Self::client(p)?
            .get_async_pubsub()
            .await
            .map_err(|e| err("Failed to open Redis pub/sub", e))
    }

    /// PUBLISH channel message → số subscriber nhận.
    pub async fn publish(&mut self, channel: &str, message: &str) -> Result<i64, QueryError> {
        redis::cmd("PUBLISH")
            .arg(channel)
            .arg(message)
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("PUBLISH error", e))
    }

    pub async fn connect(p: &RedisConnParams) -> Result<Self, QueryError> {
        let mut conn = Self::open(p).await?;
        // Xác nhận handshake bằng PING (bắt sai password/DB sớm).
        let _: String = redis::cmd("PING")
            .query_async(&mut conn)
            .await
            .map_err(|e| err("Redis PING failed (wrong password?)", e))?;
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
            .map_err(|e| err("DBSIZE error", e))
    }

    /// Một vòng SCAN thô: chỉ tên key (1 round-trip).
    async fn scan_names(
        &mut self,
        pattern: &str,
        cursor: u64,
        count: usize,
    ) -> Result<(u64, Vec<String>), QueryError> {
        let pat = if pattern.is_empty() { "*" } else { pattern };
        redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pat)
            .arg("COUNT")
            .arg(count.max(1))
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("SCAN error", e))
    }

    /// TYPE + TTL cho CẢ batch key trong MỘT round-trip (redis pipeline).
    /// Trước đây mỗi key tốn 2 round-trip tuần tự (2N cho N key) → key explorer
    /// chậm tuyến tính theo latency; nay là 1 bất kể N.
    /// `extra` là các lệnh phụ nối vào cuối cùng pipeline (vd DBSIZE) để không
    /// tốn thêm round-trip; reply của chúng trả ở đuôi Vec.
    async fn type_ttl_pipeline(
        &mut self,
        names: &[String],
        extra: &[&str],
    ) -> Result<Vec<redis::Value>, QueryError> {
        if names.is_empty() && extra.is_empty() {
            return Ok(Vec::new());
        }
        let mut pipe = redis::pipe();
        for name in names {
            pipe.cmd("TYPE").arg(name);
            pipe.cmd("TTL").arg(name);
        }
        for c in extra {
            pipe.cmd(*c);
        }
        pipe.query_async(&mut self.conn)
            .await
            .map_err(|e| err("SCAN metadata (TYPE/TTL) error", e))
    }

    /// SCAN cursor-based (KHÔNG dùng KEYS *) + TYPE + TTL cho từng key.
    /// Trả (cursor kế tiếp, keys). cursor = 0 nghĩa là hết vòng.
    /// 2 round-trip/vòng (SCAN + 1 pipeline), không phụ thuộc số key.
    pub async fn scan(
        &mut self,
        pattern: &str,
        cursor: u64,
        count: usize,
    ) -> Result<(u64, Vec<RedisKey>), QueryError> {
        let (next, names) = self.scan_names(pattern, cursor, count).await?;
        let replies = self.type_ttl_pipeline(&names, &[]).await?;
        Ok((next, zip_type_ttl(names, &replies)))
    }

    /// Như [`Self::scan`] nhưng DBSIZE đi kèm trong CÙNG pipeline (miễn phí một
    /// round-trip) — đúng thứ mà key explorer cần mỗi vòng.
    pub async fn scan_page(
        &mut self,
        pattern: &str,
        cursor: u64,
        count: usize,
    ) -> Result<(u64, Vec<RedisKey>, u64), QueryError> {
        let (next, names) = self.scan_names(pattern, cursor, count).await?;
        let replies = self.type_ttl_pipeline(&names, &["DBSIZE"]).await?;
        // DBSIZE là reply cuối; phần đầu là các cặp (TYPE, TTL).
        let (meta, tail) = replies.split_at(replies.len().saturating_sub(1));
        let dbsize = tail.first().and_then(as_i64).unwrap_or(0).max(0) as u64;
        Ok((next, zip_type_ttl(names, meta), dbsize))
    }

    /// Đọc key: TYPE + TTL + giá trị theo đúng kiểu (GET/HGETALL/LRANGE/SMEMBERS/
    /// ZRANGE WITHSCORES/XRANGE). Stream parse thủ công từ redis::Value.
    pub async fn get_value(&mut self, key: &str) -> Result<RedisKeyValue, QueryError> {
        let key_type: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("TYPE error", e))?;
        let ttl: i64 = redis::cmd("TTL").arg(key).query_async(&mut self.conn).await.unwrap_or(-1);

        let value = match key_type.as_str() {
            "string" => RedisValue::String {
                value: redis::cmd("GET").arg(key).query_async(&mut self.conn).await.map_err(|e| err("GET error", e))?,
            },
            "hash" => RedisValue::Hash {
                fields: redis::cmd("HGETALL").arg(key).query_async(&mut self.conn).await.map_err(|e| err("HGETALL error", e))?,
            },
            "list" => RedisValue::List {
                items: redis::cmd("LRANGE").arg(key).arg(0).arg(-1).query_async(&mut self.conn).await.map_err(|e| err("LRANGE error", e))?,
            },
            "set" => RedisValue::Set {
                members: redis::cmd("SMEMBERS").arg(key).query_async(&mut self.conn).await.map_err(|e| err("SMEMBERS error", e))?,
            },
            "zset" => {
                // ZRANGE … WITHSCORES → [member, score, member, score, …]
                let flat: Vec<String> = redis::cmd("ZRANGE")
                    .arg(key).arg(0).arg(-1).arg("WITHSCORES")
                    .query_async(&mut self.conn).await.map_err(|e| err("ZRANGE error", e))?;
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
                    .query_async(&mut self.conn).await.map_err(|e| err("XRANGE error", e))?;
                RedisValue::Stream { entries: parse_stream(&raw) }
            }
            _ => RedisValue::None,
        };
        Ok(RedisKeyValue { key_type, ttl, value })
    }

    /// Xóa key (DEL) — trả số key đã xóa (0/1).
    pub async fn del(&mut self, key: &str) -> Result<u64, QueryError> {
        redis::cmd("DEL").arg(key).query_async(&mut self.conn).await.map_err(|e| err("DEL error", e))
    }

    /// Sửa giá trị theo op (per-type). Chạy đúng lệnh Redis tương ứng.
    pub async fn apply_edit(&mut self, key: &str, op: RedisEditOp) -> Result<(), QueryError> {
        let c = &mut self.conn;
        match op {
            RedisEditOp::SetString { value } => {
                let _: () = redis::cmd("SET").arg(key).arg(value).query_async(c).await.map_err(|e| err("SET error", e))?;
            }
            RedisEditOp::HSet { field, value } => {
                let _: i64 = redis::cmd("HSET").arg(key).arg(field).arg(value).query_async(c).await.map_err(|e| err("HSET error", e))?;
            }
            RedisEditOp::HDel { field } => {
                let _: i64 = redis::cmd("HDEL").arg(key).arg(field).query_async(c).await.map_err(|e| err("HDEL error", e))?;
            }
            RedisEditOp::RPush { value } => {
                let _: i64 = redis::cmd("RPUSH").arg(key).arg(value).query_async(c).await.map_err(|e| err("RPUSH error", e))?;
            }
            RedisEditOp::LSet { index, value } => {
                let _: () = redis::cmd("LSET").arg(key).arg(index).arg(value).query_async(c).await.map_err(|e| err("LSET error", e))?;
            }
            RedisEditOp::LRem { value } => {
                let _: i64 = redis::cmd("LREM").arg(key).arg(0).arg(value).query_async(c).await.map_err(|e| err("LREM error", e))?;
            }
            RedisEditOp::SAdd { member } => {
                let _: i64 = redis::cmd("SADD").arg(key).arg(member).query_async(c).await.map_err(|e| err("SADD error", e))?;
            }
            RedisEditOp::SRem { member } => {
                let _: i64 = redis::cmd("SREM").arg(key).arg(member).query_async(c).await.map_err(|e| err("SREM error", e))?;
            }
            RedisEditOp::ZAdd { member, score } => {
                let _: i64 = redis::cmd("ZADD").arg(key).arg(score).arg(member).query_async(c).await.map_err(|e| err("ZADD error", e))?;
            }
            RedisEditOp::ZRem { member } => {
                let _: i64 = redis::cmd("ZREM").arg(key).arg(member).query_async(c).await.map_err(|e| err("ZREM error", e))?;
            }
            RedisEditOp::XAdd { fields } => {
                let mut cmd = redis::cmd("XADD");
                cmd.arg(key).arg("*");
                for (f, v) in fields {
                    cmd.arg(f).arg(v);
                }
                let _: String = cmd.query_async(c).await.map_err(|e| err("XADD error", e))?;
            }
            RedisEditOp::XDel { id } => {
                let _: i64 = redis::cmd("XDEL").arg(key).arg(id).query_async(c).await.map_err(|e| err("XDEL error", e))?;
            }
        }
        Ok(())
    }

    /// CLI console: chạy 1 lệnh Redis thô (args đã tách) → RESP format text.
    pub async fn command(&mut self, args: &[String]) -> Result<String, QueryError> {
        let Some(name) = args.first() else {
            return Err(err("Empty command", "empty command"));
        };
        let mut cmd = redis::cmd(name);
        for a in &args[1..] {
            cmd.arg(a);
        }
        let v: redis::Value = cmd
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err(format!("{} error", name.to_uppercase()), e))?;
        Ok(format_resp(&v))
    }

    /// MEMORY USAGE key → bytes (None nếu key không tồn tại).
    pub async fn memory_usage(&mut self, key: &str) -> Result<Option<u64>, QueryError> {
        redis::cmd("MEMORY")
            .arg("USAGE")
            .arg(key)
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("MEMORY USAGE error", e))
    }

    /// Switch the active logical database on this connection (Redis `SELECT n`).
    pub async fn select_db(&mut self, db: i64) -> Result<(), QueryError> {
        let _: () = redis::cmd("SELECT")
            .arg(db)
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err(format!("SELECT {db} error"), e))?;
        Ok(())
    }

    /// Number of logical databases (`CONFIG GET databases`; default 16 if the
    /// server hides it, e.g. some managed Redis).
    pub async fn database_count(&mut self) -> Result<i64, QueryError> {
        let pairs: Vec<String> = redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async(&mut self.conn)
            .await
            .unwrap_or_default();
        Ok(pairs.get(1).and_then(|v| v.parse::<i64>().ok()).filter(|n| *n > 0).unwrap_or(16))
    }

    /// FLUSHDB — xóa toàn bộ DB hiện tại.
    pub async fn flushdb(&mut self) -> Result<(), QueryError> {
        let _: () = redis::cmd("FLUSHDB")
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("FLUSHDB error", e))?;
        Ok(())
    }

    /// Đặt TTL: secs > 0 → EXPIRE; secs <= 0 → PERSIST (bỏ hết hạn).
    pub async fn set_ttl(&mut self, key: &str, secs: i64) -> Result<(), QueryError> {
        if secs > 0 {
            let _: i64 = redis::cmd("EXPIRE").arg(key).arg(secs).query_async(&mut self.conn).await.map_err(|e| err("EXPIRE error", e))?;
        } else {
            let _: i64 = redis::cmd("PERSIST").arg(key).query_async(&mut self.conn).await.map_err(|e| err("PERSIST error", e))?;
        }
        Ok(())
    }
}

/// Đọc số nguyên từ reply (TTL/DBSIZE trả Int; một số proxy trả bulk string).
fn as_i64(v: &redis::Value) -> Option<i64> {
    match v {
        redis::Value::Int(i) => Some(*i),
        redis::Value::BulkString(b) => std::str::from_utf8(b).ok()?.trim().parse().ok(),
        redis::Value::SimpleString(s) => s.trim().parse().ok(),
        redis::Value::Double(d) => Some(*d as i64),
        _ => None,
    }
}

/// Ghép tên key với reply của pipeline `[TYPE k1, TTL k1, TYPE k2, TTL k2, …]`.
/// Pipeline trả reply THEO ĐÚNG THỨ TỰ lệnh gửi, nên key thứ i lấy cặp (2i, 2i+1).
/// Reply thiếu/không đọc được → giữ đúng fallback của bản tuần tự cũ: kiểu
/// "none", TTL -1 (không hết hạn).
fn zip_type_ttl(names: Vec<String>, replies: &[redis::Value]) -> Vec<RedisKey> {
    names
        .into_iter()
        .enumerate()
        .map(|(i, name)| {
            let key_type = match replies.get(i * 2) {
                Some(redis::Value::Nil) | None => "none".into(),
                Some(v) => {
                    let s = val_to_string(v);
                    if s.is_empty() { "none".into() } else { s }
                }
            };
            let ttl = replies.get(i * 2 + 1).and_then(as_i64).unwrap_or(-1);
            RedisKey { name, key_type, ttl }
        })
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    use redis::Value;

    fn ty(s: &str) -> Value {
        Value::SimpleString(s.into())
    }

    #[test]
    fn zip_type_ttl_maps_each_key_to_its_own_pair_in_order() {
        // Pipeline reply = [TYPE a, TTL a, TYPE b, TTL b, TYPE c, TTL c]
        let names = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let replies = vec![
            ty("string"),
            Value::Int(-1),
            ty("hash"),
            Value::Int(100),
            ty("zset"),
            Value::Int(-2),
        ];
        let keys = zip_type_ttl(names, &replies);
        assert_eq!(keys.len(), 3);
        assert_eq!((keys[0].name.as_str(), keys[0].key_type.as_str(), keys[0].ttl), ("a", "string", -1));
        assert_eq!((keys[1].name.as_str(), keys[1].key_type.as_str(), keys[1].ttl), ("b", "hash", 100));
        assert_eq!((keys[2].name.as_str(), keys[2].key_type.as_str(), keys[2].ttl), ("c", "zset", -2));
    }

    #[test]
    fn zip_type_ttl_falls_back_like_the_old_sequential_path() {
        // Missing / nil / unreadable replies must not shift the mapping or panic:
        // type → "none", ttl → -1 (same as the per-key unwrap_or before pipelining).
        let names = vec!["a".to_string(), "b".to_string()];
        let replies = vec![Value::Nil, Value::Nil]; // only a's pair, both unusable
        let keys = zip_type_ttl(names, &replies);
        assert_eq!((keys[0].key_type.as_str(), keys[0].ttl), ("none", -1));
        assert_eq!((keys[1].key_type.as_str(), keys[1].ttl), ("none", -1), "missing tail still yields a row");
    }

    #[test]
    fn zip_type_ttl_on_empty_batch_is_empty() {
        assert!(zip_type_ttl(Vec::new(), &[]).is_empty());
    }

    #[test]
    fn as_i64_reads_the_integer_shapes_ttl_and_dbsize_come_back_as() {
        assert_eq!(as_i64(&Value::Int(42)), Some(42));
        assert_eq!(as_i64(&Value::BulkString(b"7".to_vec())), Some(7));
        assert_eq!(as_i64(&Value::SimpleString("-1".into())), Some(-1));
        assert_eq!(as_i64(&Value::Nil), None);
        assert_eq!(as_i64(&Value::Okay), None);
    }
}
