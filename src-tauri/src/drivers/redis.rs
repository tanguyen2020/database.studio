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
                // INFO server → "Redis 7.2.4" / "Valkey 8.1.10" (best-effort). Valkey
                // keeps redis_version at 7.2.4 for old clients, so read its own field.
                let version = redis::cmd("INFO")
                    .arg("server")
                    .query_async::<String>(&mut conn)
                    .await
                    .ok()
                    .and_then(|info| server_identity(&info).label);
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
            RedisEditOp::LSetAt { index, expected, value } => {
                let n: i64 = redis::cmd("EVAL").arg(LSET_AT).arg(1).arg(key).arg(index).arg(expected).arg(value).query_async(c).await.map_err(|e| err("LSET error", e))?;
                item_result(n)?;
            }
            RedisEditOp::LDelAt { index, expected } => {
                let n: i64 = redis::cmd("EVAL").arg(LDEL_AT).arg(1).arg(key).arg(index).arg(expected).arg(LIST_TOMBSTONE).query_async(c).await.map_err(|e| err("LREM error", e))?;
                item_result(n)?;
            }
            RedisEditOp::HReplace { from, to, value } => {
                let n: i64 = redis::cmd("EVAL").arg(H_REPLACE).arg(1).arg(key).arg(from).arg(to).arg(value).query_async(c).await.map_err(|e| err("HSET error", e))?;
                item_result(n)?;
            }
            RedisEditOp::SReplace { from, to } => {
                let n: i64 = redis::cmd("EVAL").arg(S_REPLACE).arg(1).arg(key).arg(from).arg(to).query_async(c).await.map_err(|e| err("SADD error", e))?;
                item_result(n)?;
            }
            RedisEditOp::ZReplace { from, to, score } => {
                let n: i64 = redis::cmd("EVAL").arg(Z_REPLACE).arg(1).arg(key).arg(from).arg(to).arg(score).query_async(c).await.map_err(|e| err("ZADD error", e))?;
                item_result(n)?;
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

    // ---- stream-workspace:redis (SPEC-REDIS-BROWSER.md §3) --------------------

    /// `SLOWLOG GET count` plus the server's current threshold / history length
    /// (`CONFIG GET` — managed Redis may hide it, then those stay `None`).
    pub async fn slowlog(&mut self, count: usize) -> Result<RedisSlowlog, QueryError> {
        let raw: redis::Value = redis::cmd("SLOWLOG")
            .arg("GET")
            .arg(count.max(1))
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("SLOWLOG GET error", e))?;
        let threshold_us = self.config_int("slowlog-log-slower-than").await;
        let max_len = self.config_int("slowlog-max-len").await;
        Ok(RedisSlowlog { entries: parse_slowlog(&raw), threshold_us, max_len })
    }

    /// One integer setting from `CONFIG GET name` (None when hidden / not a number).
    async fn config_int(&mut self, name: &str) -> Option<i64> {
        let pairs: Vec<String> = redis::cmd("CONFIG").arg("GET").arg(name).query_async(&mut self.conn).await.ok()?;
        pairs.get(1)?.trim().parse().ok()
    }

    /// `INFO` text (the default sections: server, clients, memory, persistence,
    /// stats, replication, cpu, keyspace…). The command layer groups it.
    pub async fn info(&mut self) -> Result<String, QueryError> {
        redis::cmd("INFO").query_async(&mut self.conn).await.map_err(|e| err("INFO error", e))
    }

    /// Which server this is — Redis or Valkey — from `INFO server` (SPEC-VALKEY.md §1).
    pub async fn server_info(&mut self) -> Result<RedisServerInfo, QueryError> {
        let text: String = redis::cmd("INFO")
            .arg("server")
            .query_async(&mut self.conn)
            .await
            .map_err(|e| err("INFO error", e))?;
        Ok(server_identity(&text))
    }

    /// Size + encoding of the keys currently on screen: ONE pipeline of
    /// `MEMORY USAGE k` + `OBJECT ENCODING k` per key. A missing key → both None.
    /// Some servers forbid one of the two commands (managed Redis); then each is
    /// retried on its own so the other still comes back.
    pub async fn key_meta(&mut self, keys: &[String]) -> Result<Vec<RedisKeyMeta>, QueryError> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let mut pipe = redis::pipe();
        for k in keys {
            pipe.cmd("MEMORY").arg("USAGE").arg(k);
            pipe.cmd("OBJECT").arg("ENCODING").arg(k);
        }
        let both: Result<Vec<redis::Value>, _> = pipe.query_async(&mut self.conn).await;
        if let Ok(replies) = both {
            return Ok(zip_key_meta(keys, &replies));
        }
        // Fallback: one command kind per pipeline, each tolerated on its own.
        let mut mem = redis::pipe();
        let mut enc = redis::pipe();
        for k in keys {
            mem.cmd("MEMORY").arg("USAGE").arg(k);
            enc.cmd("OBJECT").arg("ENCODING").arg(k);
        }
        let mem: Vec<redis::Value> = mem.query_async(&mut self.conn).await.unwrap_or_default();
        let enc: Vec<redis::Value> = enc.query_async(&mut self.conn).await.unwrap_or_default();
        let mut interleaved = Vec::with_capacity(keys.len() * 2);
        for i in 0..keys.len() {
            interleaved.push(mem.get(i).cloned().unwrap_or(redis::Value::Nil));
            interleaved.push(enc.get(i).cloned().unwrap_or(redis::Value::Nil));
        }
        Ok(zip_key_meta(keys, &interleaved))
    }
}

/// Which server speaks the Redis protocol on this connection (SPEC-VALKEY.md §1).
/// Valkey is a fork of Redis 7.2.4 with the same protocol and commands; the driver
/// treats both the same and only the brand shown to the user differs.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RedisServerInfo {
    /// "redis" | "valkey"
    pub flavor: String,
    /// The server's own version: `valkey_version` on Valkey, `redis_version` on Redis.
    pub version: Option<String>,
    /// "Valkey 8.1.10" / "Redis 7.2.4" — None when INFO reported no version.
    pub label: Option<String>,
}

/// Read the product and version out of `INFO server` text. Measured on Valkey 8.1:
/// it still reports `redis_version:7.2.4` (frozen for old clients) and adds
/// `server_name:valkey` + `valkey_version:8.1.10`.
pub fn server_identity(info: &str) -> RedisServerInfo {
    let field = |name: &str| {
        info.lines()
            .find_map(|l| l.trim().strip_prefix(name).and_then(|r| r.strip_prefix(':')).map(|v| v.trim().to_string()))
            .filter(|v| !v.is_empty())
    };
    let valkey_version = field("valkey_version");
    let is_valkey = valkey_version.is_some() || field("server_name").is_some_and(|n| n.eq_ignore_ascii_case("valkey"));
    let (flavor, product, version) = if is_valkey {
        ("valkey", "Valkey", valkey_version.or_else(|| field("redis_version")))
    } else {
        ("redis", "Redis", field("redis_version"))
    };
    RedisServerInfo { flavor: flavor.into(), label: version.as_ref().map(|v| format!("{product} {v}")), version }
}

/// One `SLOWLOG GET` entry.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SlowlogEntry {
    pub id: i64,
    /// Unix time (seconds) the command was logged.
    pub timestamp: i64,
    /// Execution time in microseconds.
    pub duration_us: i64,
    pub args: Vec<String>,
    /// "ip:port" of the client (Redis 4.0+; empty before).
    pub client: String,
    /// CLIENT SETNAME of the client (Redis 4.0+; often empty).
    pub client_name: String,
}

#[derive(Debug, serde::Serialize)]
pub struct RedisSlowlog {
    pub entries: Vec<SlowlogEntry>,
    /// `slowlog-log-slower-than` in µs (-1 = disabled, 0 = log everything).
    pub threshold_us: Option<i64>,
    /// `slowlog-max-len` — how many entries the server keeps.
    pub max_len: Option<i64>,
}

/// Size and internal encoding of one key (None = key gone / command refused).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RedisKeyMeta {
    pub key: String,
    pub bytes: Option<u64>,
    pub encoding: Option<String>,
}

/// Parse the `SLOWLOG GET` reply: an array of
/// `[id, timestamp, duration_us, [args…], client_addr?, client_name?]`.
/// Malformed entries are skipped rather than reported with invented values.
fn parse_slowlog(raw: &redis::Value) -> Vec<SlowlogEntry> {
    let redis::Value::Array(entries) = raw else { return Vec::new() };
    entries
        .iter()
        .filter_map(|e| {
            let redis::Value::Array(f) = e else { return None };
            let id = as_i64(f.first()?)?;
            let timestamp = as_i64(f.get(1)?)?;
            let duration_us = as_i64(f.get(2)?)?;
            let args = match f.get(3) {
                Some(redis::Value::Array(a)) => a.iter().map(val_to_string).collect(),
                _ => Vec::new(),
            };
            let client = f.get(4).map(val_to_string).unwrap_or_default();
            let client_name = f.get(5).map(val_to_string).unwrap_or_default();
            Some(SlowlogEntry { id, timestamp, duration_us, args, client, client_name })
        })
        .collect()
}

/// Pair each key with `(MEMORY USAGE, OBJECT ENCODING)` at replies (2i, 2i+1).
/// Nil / missing / non-numeric → None (never a made-up 0).
fn zip_key_meta(keys: &[String], replies: &[redis::Value]) -> Vec<RedisKeyMeta> {
    keys.iter()
        .enumerate()
        .map(|(i, key)| {
            let bytes = replies.get(i * 2).and_then(as_i64).filter(|n| *n >= 0).map(|n| n as u64);
            let encoding = match replies.get(i * 2 + 1) {
                None | Some(redis::Value::Nil) => None,
                Some(redis::Value::ServerError(_)) => None,
                Some(v) => Some(val_to_string(v)).filter(|s| !s.is_empty()),
            };
            RedisKeyMeta { key: key.clone(), bytes, encoding }
        })
        .collect()
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

// ---- single-item edit scripts (one EVAL each, so a rename never leaves both the old and
// the new item, nor neither). Reply: 1 = done, -1 = the new name already exists,
// -2 = the item is no longer where/what it was when read (someone else changed it).
const LSET_AT: &str = "if redis.call('LINDEX', KEYS[1], ARGV[1]) ~= ARGV[2] then return -2 end redis.call('LSET', KEYS[1], ARGV[1], ARGV[3]) return 1";
const LDEL_AT: &str = "if redis.call('LINDEX', KEYS[1], ARGV[1]) ~= ARGV[2] then return -2 end redis.call('LSET', KEYS[1], ARGV[1], ARGV[3]) redis.call('LREM', KEYS[1], 1, ARGV[3]) return 1";
/// Placeholder written into the slot being removed, then removed (count 1) — never a
/// value an application would store.
const LIST_TOMBSTONE: &str = "__database_studio_removed_item__";
const H_REPLACE: &str = "if ARGV[1] ~= ARGV[2] and redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1 then return -1 end if ARGV[1] ~= ARGV[2] and redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return -2 end redis.call('HSET', KEYS[1], ARGV[2], ARGV[3]) if ARGV[1] ~= ARGV[2] then redis.call('HDEL', KEYS[1], ARGV[1]) end return 1";
const S_REPLACE: &str = "if ARGV[1] == ARGV[2] then return 1 end if redis.call('SISMEMBER', KEYS[1], ARGV[2]) == 1 then return -1 end if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then return -2 end redis.call('SADD', KEYS[1], ARGV[2]) redis.call('SREM', KEYS[1], ARGV[1]) return 1";
const Z_REPLACE: &str = "if ARGV[1] ~= ARGV[2] and redis.call('ZSCORE', KEYS[1], ARGV[2]) then return -1 end if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return -2 end redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2]) if ARGV[1] ~= ARGV[2] then redis.call('ZREM', KEYS[1], ARGV[1]) end return 1";

/// Turn an item-script reply into a plain-language error.
fn item_result(n: i64) -> Result<(), QueryError> {
    match n {
        1 => Ok(()),
        -1 => Err(QueryError::new("redis", "That name is already used in this key. Pick another one.", "item exists")),
        _ => Err(QueryError::new("redis", "This item changed on the server since it was read. Refresh the key and try again.", "item changed")),
    }
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
    // ---- single-item edits from the Browser panel (atomic Lua, see ITEM_SCRIPTS) ----
    /// Change one list item, but only if it still holds `expected` (the list may have
    /// shifted since it was read — then nothing changes and the user is told).
    LSetAt { index: i64, expected: String, value: String },
    /// Remove ONE list item by position (LREM by value would remove every duplicate).
    LDelAt { index: i64, expected: String },
    /// Set a hash field, renaming it from `from` (refused if `to` already exists).
    HReplace { from: String, to: String, value: String },
    /// Replace a set member (refused if `to` is already a member).
    SReplace { from: String, to: String },
    /// Replace a sorted-set member and/or its score (refused if `to` already exists).
    ZReplace { from: String, to: String, score: f64 },
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
    fn server_identity_tells_valkey_from_redis() {
        // INFO server as measured on valkey/valkey:8.1 (CRLF, redis_version frozen at 7.2.4)
        let valkey = "# Server\r\nredis_version:7.2.4\r\nserver_name:valkey\r\nvalkey_version:8.1.10\r\nserver_mode:standalone\r\n";
        let v = server_identity(valkey);
        assert_eq!(v.flavor, "valkey");
        assert_eq!(v.version.as_deref(), Some("8.1.10"));
        assert_eq!(v.label.as_deref(), Some("Valkey 8.1.10"));

        let redis = "# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n";
        let r = server_identity(redis);
        assert_eq!(r.flavor, "redis");
        assert_eq!(r.label.as_deref(), Some("Redis 7.2.4"));

        // server_name alone is enough; a missing valkey_version falls back to redis_version
        let named = server_identity("server_name:valkey\nredis_version:7.2.4\n");
        assert_eq!((named.flavor.as_str(), named.label.as_deref()), ("valkey", Some("Valkey 7.2.4")));
        // a field whose name only starts with the key is not read
        assert_eq!(server_identity("redis_version_extra:9\n").version, None);
        assert_eq!(server_identity("").label, None);
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

    fn bulk(s: &str) -> Value {
        Value::BulkString(s.as_bytes().to_vec())
    }

    #[test]
    fn slowlog_entries_are_read_field_by_field() {
        let raw = Value::Array(vec![
            Value::Array(vec![
                Value::Int(14),
                Value::Int(1_700_000_000),
                Value::Int(15_234),
                Value::Array(vec![bulk("KEYS"), bulk("*")]),
                bulk("127.0.0.1:58217"),
                bulk("worker-1"),
            ]),
            // Redis < 4.0: no client fields
            Value::Array(vec![Value::Int(13), Value::Int(1_699_999_999), Value::Int(12), Value::Array(vec![bulk("GET"), bulk("a")])]),
            // malformed → skipped, never reported with invented numbers
            Value::Array(vec![bulk("oops")]),
        ]);
        let e = parse_slowlog(&raw);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].id, 14);
        assert_eq!(e[0].timestamp, 1_700_000_000);
        assert_eq!(e[0].duration_us, 15_234);
        assert_eq!(e[0].args, vec!["KEYS".to_string(), "*".to_string()]);
        assert_eq!(e[0].client, "127.0.0.1:58217");
        assert_eq!(e[0].client_name, "worker-1");
        assert_eq!((e[1].client.as_str(), e[1].client_name.as_str()), ("", ""));
        assert!(parse_slowlog(&Value::Nil).is_empty());
    }

    #[test]
    fn key_meta_pairs_size_and_encoding_and_keeps_missing_keys_unknown() {
        let keys = vec!["a".to_string(), "gone".to_string(), "c".to_string()];
        let replies = vec![Value::Int(72), bulk("embstr"), Value::Nil, Value::Nil, Value::Int(1024), Value::SimpleString("listpack".into())];
        let m = zip_key_meta(&keys, &replies);
        assert_eq!(m[0], RedisKeyMeta { key: "a".into(), bytes: Some(72), encoding: Some("embstr".into()) });
        assert_eq!(m[1], RedisKeyMeta { key: "gone".into(), bytes: None, encoding: None });
        assert_eq!(m[2].bytes, Some(1024));
        assert_eq!(m[2].encoding.as_deref(), Some("listpack"));
        // short reply (pipeline cut) still yields one row per key, unknown values
        let short = zip_key_meta(&keys, &[Value::Int(5)]);
        assert_eq!(short.len(), 3);
        assert_eq!((short[0].bytes, short[0].encoding.as_deref()), (Some(5), None));
        assert_eq!(short[2].bytes, None);
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
