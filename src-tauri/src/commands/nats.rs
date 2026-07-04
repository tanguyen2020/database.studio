//! IPC commands cho NATS (Phase 3 · T9). Core: info + subject subscriber (stream
//! qua event "nats-msg") + publish + request/reply. Tái dùng state.pubsub cho
//! AbortHandle của task subscribe (1 subscription / connection).

use futures::StreamExt;
use tauri::{AppHandle, Emitter, State};

use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_nats() -> QueryError {
    QueryError::new("nats", "Connection không phải NATS", "not a nats connection")
}

/// Message emit ra frontend qua event "nats-msg".
#[derive(serde::Serialize, Clone)]
struct NatsMsg {
    conn_id: String,
    subject: String,
    reply: String,
    payload: String,
}

/// Thông tin server (info tab).
#[derive(serde::Serialize)]
pub struct NatsInfo {
    version: String,
    server_name: String,
    host: String,
    port: u16,
    max_payload: u64,
    client_id: u64,
    go: String,
}

#[tauri::command]
pub async fn nats_info(state: State<'_, AppState>, conn_id: String) -> Result<NatsInfo, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => {
                    let i = n.server_info();
                    Ok(NatsInfo {
                        version: i.version,
                        server_name: i.server_name,
                        host: i.host,
                        port: i.port,
                        max_payload: i.max_payload as u64,
                        client_id: i.client_id,
                        go: i.go,
                    })
                }
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Subscribe subject/wildcard → stream message qua event "nats-msg".
#[tauri::command]
pub async fn nats_subscribe(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    subject: String,
) -> Result<(), AppError> {
    let client = state.registry.nats_client(&conn_id).await?;
    let mut sub = client
        .subscribe(subject)
        .await
        .map_err(|e| AppError::Driver(e.to_string()))?;
    let cid = conn_id.clone();
    let handle = tokio::spawn(async move {
        while let Some(msg) = sub.next().await {
            let _ = app.emit(
                "nats-msg",
                NatsMsg {
                    conn_id: cid.clone(),
                    subject: msg.subject.to_string(),
                    reply: msg.reply.map(|r| r.to_string()).unwrap_or_default(),
                    payload: String::from_utf8_lossy(&msg.payload).into_owned(),
                },
            );
        }
    });
    state.pubsub.replace(conn_id, handle.abort_handle());
    Ok(())
}

/// Dừng subscription NATS của connection.
#[tauri::command]
pub async fn nats_unsubscribe(state: State<'_, AppState>, conn_id: String) -> Result<(), AppError> {
    state.pubsub.abort(&conn_id);
    Ok(())
}

/// Publish payload lên subject (reply-to tùy chọn).
#[tauri::command]
pub async fn nats_publish(
    state: State<'_, AppState>,
    conn_id: String,
    subject: String,
    payload: String,
    reply: Option<String>,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.publish(subject, payload, reply).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Request/Reply với timeout (ms) → payload trả về hoặc lỗi timeout.
#[tauri::command]
pub async fn nats_request(
    state: State<'_, AppState>,
    conn_id: String,
    subject: String,
    payload: String,
    timeout_ms: u64,
) -> Result<String, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.request(subject, payload, timeout_ms).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}
