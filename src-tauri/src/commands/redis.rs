//! IPC commands cho Redis (Phase 3 · T3+). Thao tác key đi qua Registry →
//! driver Redis. SCAN cursor-based (không KEYS *) cho Key Explorer.

use tauri::State;

use crate::drivers::redis::{RedisEditOp, RedisKeyValue, RedisScan};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_redis() -> QueryError {
    QueryError::new("redis", "Connection không phải Redis", "not a redis connection")
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
                    let (next, keys) = r.scan(&pattern, cursor, count).await?;
                    let dbsize = r.dbsize().await?;
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
