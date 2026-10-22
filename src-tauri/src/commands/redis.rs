//! IPC commands cho Redis (Phase 3 · T3+). Thao tác key đi qua Registry →
//! driver Redis. SCAN cursor-based (không KEYS *) cho Key Explorer.

use futures::StreamExt;
use tauri::{AppHandle, Emitter, State};

use crate::drivers::redis::{RedisDriver, RedisEditOp, RedisKeyMeta, RedisKeyValue, RedisScan, RedisSlowlog};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

/// Message pub/sub emit ra frontend qua event "redis-pubsub".
#[derive(serde::Serialize, Clone)]
struct PubSubMsg {
    conn_id: String,
    channel: String,
    payload: String,
}

fn not_redis() -> QueryError {
    QueryError::new("redis", "Connection is not Redis", "not a redis connection")
}

/// Một vòng SCAN: trả cursor kế tiếp (0 = hết) + keys (type/ttl) + dbsize.
#[tauri::command]
pub async fn redis_scan(
    state: State<'_, AppState>,
    conn_id: String,
    pattern: String,
    cursor: u64,
    count: usize,
) -> Result<RedisScan, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => {
                    // scan_page = SCAN + một pipeline (TYPE/TTL cả batch + DBSIZE) =
                    // 2 round-trip/vòng, thay cho SCAN + 2·N + DBSIZE tuần tự.
                    let (next, keys, dbsize) = r.scan_page(&pattern, cursor, count).await?;
                    Ok(RedisScan { cursor: next, keys, dbsize })
                }
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Đọc 1 key: kiểu + TTL + giá trị theo kiểu (viewer).
#[tauri::command]
pub async fn redis_get(
    state: State<'_, AppState>,
    conn_id: String,
    key: String,
) -> Result<RedisKeyValue, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.get_value(&key).await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Xóa key (DEL) — trả số key đã xóa.
#[tauri::command]
pub async fn redis_del(
    state: State<'_, AppState>,
    conn_id: String,
    key: String,
) -> Result<u64, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.del(&key).await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Đặt/gỡ TTL: secs > 0 → EXPIRE; secs <= 0 → PERSIST.
#[tauri::command]
pub async fn redis_set_ttl(
    state: State<'_, AppState>,
    conn_id: String,
    key: String,
    secs: i64,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.set_ttl(&key, secs).await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// CLI console: chạy 1 lệnh thô (args đã tách) → RESP text.
#[tauri::command]
pub async fn redis_command(
    state: State<'_, AppState>,
    conn_id: String,
    args: Vec<String>,
) -> Result<String, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.command(&args).await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// MEMORY USAGE key → bytes (null nếu không tồn tại).
#[tauri::command]
pub async fn redis_memory_usage(
    state: State<'_, AppState>,
    conn_id: String,
    key: String,
) -> Result<Option<u64>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.memory_usage(&key).await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Switch the active logical DB (SELECT n) — the key explorer then reloads.
#[tauri::command]
pub async fn redis_select_db(state: State<'_, AppState>, conn_id: String, db: i64) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.select_db(db).await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Number of logical databases (for the DB dropdown; default 16).
#[tauri::command]
pub async fn redis_database_count(state: State<'_, AppState>, conn_id: String) -> Result<i64, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.database_count().await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// FLUSHDB — xóa toàn bộ DB hiện tại (UI phải confirm gõ tên DB).
#[tauri::command]
pub async fn redis_flushdb(state: State<'_, AppState>, conn_id: String) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.flushdb().await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Subscribe channels/patterns → stream message qua event "redis-pubsub".
/// Mở connection pub/sub RIÊNG (redis pub/sub chiếm trọn connection); task nền
/// lưu AbortHandle trong state.pubsub (subscribe mới hủy cái cũ của cùng conn).
#[tauri::command]
pub async fn redis_subscribe(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    channels: Vec<String>,
    patterns: Vec<String>,
) -> Result<(), AppError> {
    let params = state.registry.redis_params(&conn_id)?;
    let mut pubsub = RedisDriver::open_pubsub(&params)
        .await
        .map_err(|e| AppError::Driver(e.message))?;
    for ch in &channels {
        pubsub.subscribe(ch).await.map_err(|e| AppError::Driver(e.to_string()))?;
    }
    for p in &patterns {
        pubsub.psubscribe(p).await.map_err(|e| AppError::Driver(e.to_string()))?;
    }

    let cid = conn_id.clone();
    let handle = tokio::spawn(async move {
        let mut stream = pubsub.on_message();
        while let Some(msg) = stream.next().await {
            let channel = msg.get_channel_name().to_string();
            let payload: String = msg.get_payload().unwrap_or_default();
            let _ = app.emit("redis-pubsub", PubSubMsg { conn_id: cid.clone(), channel, payload });
        }
    });
    state.pubsub.replace(conn_id, handle.abort_handle());
    Ok(())
}

/// Dừng subscription pub/sub của connection.
#[tauri::command]
pub async fn redis_unsubscribe(state: State<'_, AppState>, conn_id: String) -> Result<(), AppError> {
    state.pubsub.abort(&conn_id);
    Ok(())
}

/// PUBLISH channel message → số subscriber nhận (qua connection chính).
#[tauri::command]
pub async fn redis_publish(
    state: State<'_, AppState>,
    conn_id: String,
    channel: String,
    message: String,
) -> Result<i64, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.publish(&channel, &message).await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Sửa giá trị theo op per-type (SET/HSET/HDEL/RPUSH/LSET/LREM/SADD/SREM/ZADD/ZREM/XADD/XDEL).
#[tauri::command]
pub async fn redis_edit(
    state: State<'_, AppState>,
    conn_id: String,
    key: String,
    op: RedisEditOp,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.apply_edit(&key, op).await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

// ---- stream-workspace:redis (SPEC-REDIS-BROWSER.md §2–§3) --------------------

/// One INFO section ("Server", "Memory", …) with its `metric: value` lines in order.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RedisInfoSection {
    pub name: String,
    pub entries: Vec<(String, String)>,
}

#[derive(Debug, serde::Serialize)]
pub struct RedisInfo {
    pub sections: Vec<RedisInfoSection>,
}

/// Split INFO text on its `# Section` headers; each section's lines are parsed by
/// the same `parse_redis_info` the Session Monitor's Redis memory view uses, so the
/// two never disagree on what a line means. Lines before any header (should not
/// happen) land in a section named "General".
pub fn info_sections(text: &str) -> Vec<RedisInfoSection> {
    let mut chunks: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_prefix('#') {
            chunks.push((name.trim().to_string(), String::new()));
            continue;
        }
        if t.is_empty() {
            continue;
        }
        if chunks.is_empty() {
            chunks.push(("General".to_string(), String::new()));
        }
        let body = &mut chunks.last_mut().expect("pushed above").1;
        body.push_str(t);
        body.push('\n');
    }
    chunks
        .into_iter()
        .map(|(name, body)| {
            let rows = crate::commands::admin::parse_redis_info(&body).rows;
            let entries = rows
                .iter()
                .map(|r| {
                    let get = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    (get("metric"), get("value"))
                })
                .collect();
            RedisInfoSection { name, entries }
        })
        .filter(|s| !s.entries.is_empty())
        .collect()
}

/// `INFO`, grouped by section (Server info view + header stats).
#[tauri::command]
pub async fn redis_info(state: State<'_, AppState>, conn_id: String) -> Result<RedisInfo, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.info().await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    let text = inner.map_err(|e| AppError::Driver(e.message))?;
    Ok(RedisInfo { sections: info_sections(&text) })
}

/// `SLOWLOG GET count` + the server's current threshold (Slow commands view).
#[tauri::command]
pub async fn redis_slowlog(state: State<'_, AppState>, conn_id: String, count: usize) -> Result<RedisSlowlog, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.slowlog(count.min(1000)).await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Size + encoding of the keys currently shown in the Browser (one pipeline).
#[tauri::command]
pub async fn redis_key_meta(state: State<'_, AppState>, conn_id: String, keys: Vec<String>) -> Result<Vec<RedisKeyMeta>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let mut d = driver.lock().await;
            match &mut *d {
                LiveConnection::Redis(r) => r.key_meta(&keys).await,
                _ => Err(not_redis()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_is_grouped_by_section_in_server_order() {
        let text = "# Server\r\nredis_version:7.2.4\r\nuptime_in_seconds:3600\r\n\r\n# Clients\r\nconnected_clients:3\r\n\r\n# Memory\r\nused_memory:1048576\r\nused_memory_human:1.00M\r\nmaxmemory:0\r\n\r\n# Keyspace\r\ndb0:keys=12,expires=2,avg_ttl=0\r\n";
        let s = info_sections(text);
        let names: Vec<&str> = s.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["Server", "Clients", "Memory", "Keyspace"]);
        assert_eq!(s[0].entries[0], ("redis_version".to_string(), "7.2.4".to_string()));
        assert_eq!(s[2].entries.len(), 3);
        // a value containing ':' keeps everything after the FIRST colon
        assert_eq!(s[3].entries[0], ("db0".to_string(), "keys=12,expires=2,avg_ttl=0".to_string()));
    }

    #[test]
    fn info_sections_match_the_flat_parse_used_by_the_session_monitor() {
        let text = "# Memory\nused_memory:10\nmaxmemory:0\n# Stats\ninstantaneous_ops_per_sec:4\n";
        let flat = crate::commands::admin::parse_redis_info(text).rows.len();
        let grouped: usize = info_sections(text).iter().map(|s| s.entries.len()).sum();
        assert_eq!(flat, grouped);
        // empty sections (e.g. "# Modules" with nothing under it) are dropped
        assert!(info_sections("# Modules\n\n# Server\nredis_mode:standalone\n").iter().all(|s| s.name != "Modules"));
    }
}
