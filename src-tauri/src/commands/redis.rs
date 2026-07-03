//! IPC commands cho Redis (Phase 3 · T3+). Thao tác key đi qua Registry →
//! driver Redis. SCAN cursor-based (không KEYS *) cho Key Explorer.

use tauri::State;

use crate::drivers::redis::RedisScan;
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
