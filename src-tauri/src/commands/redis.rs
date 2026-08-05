//! IPC commands cho Redis (Phase 3 · T3+). Thao tác key đi qua Registry →
//! driver Redis. SCAN cursor-based (không KEYS *) cho Key Explorer.

use futures::StreamExt;
use tauri::{AppHandle, Emitter, State};

use crate::drivers::redis::{RedisDriver, RedisEditOp, RedisKeyValue, RedisScan};
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
