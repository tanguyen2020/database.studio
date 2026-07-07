//! IPC commands cho NATS (Phase 3 · T9). Core: info + subject subscriber (stream
//! qua event "nats-msg") + publish + request/reply. Tái dùng state.pubsub cho
//! AbortHandle của task subscribe (1 subscription / connection).

use futures::StreamExt;
use tauri::{AppHandle, Emitter, State};

use crate::drivers::nats::{JsConsumer, JsMessage, JsStream, ObjInfo};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_nats() -> QueryError {
    QueryError::new("nats", "Connection is not NATS", "not a nats connection")
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

/// JetStream: list streams.
#[tauri::command]
pub async fn nats_js_streams(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<JsStream>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_streams().await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: list consumers của 1 stream.
#[tauri::command]
pub async fn nats_js_consumers(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
) -> Result<Vec<JsConsumer>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_consumers(&stream).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: tạo stream.
#[tauri::command]
pub async fn nats_js_create_stream(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    subjects: Vec<String>,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_create_stream(name, subjects).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: xóa stream.
#[tauri::command]
pub async fn nats_js_delete_stream(state: State<'_, AppState>, conn_id: String, name: String) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_delete_stream(&name).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: purge stream.
#[tauri::command]
pub async fn nats_js_purge_stream(state: State<'_, AppState>, conn_id: String, name: String) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_purge_stream(&name).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: tạo consumer.
#[tauri::command]
pub async fn nats_js_create_consumer(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    durable: String,
    filter: String,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_create_consumer(&stream, durable, filter).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: xóa consumer.
#[tauri::command]
pub async fn nats_js_delete_consumer(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    name: String,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_delete_consumer(&stream, &name).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: xóa message theo sequence.
#[tauri::command]
pub async fn nats_js_delete_message(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    seq: u64,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_delete_message(&stream, seq).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: peek message theo sequence.
#[tauri::command]
pub async fn nats_js_peek(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    seq: u64,
) -> Result<JsMessage, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_peek(&stream, seq).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: browse up to `limit` messages of a subject within a stream.
#[tauri::command]
pub async fn nats_js_subject_messages(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    subject: String,
    limit: usize,
) -> Result<Vec<JsMessage>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_subject_messages(&stream, &subject, limit).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: clear a subject's messages (purge with a subject filter).
#[tauri::command]
pub async fn nats_js_purge_subject(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    subject: String,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_purge_subject(&stream, &subject).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: remove a subject from a stream's config.
#[tauri::command]
pub async fn nats_js_remove_subject(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    subject: String,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_remove_subject(&stream, &subject).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

// ---- KV Store (T9) ----------------------------------------------------------

#[tauri::command]
pub async fn nats_kv_buckets(state: State<'_, AppState>, conn_id: String) -> Result<Vec<String>, AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.kv_buckets().await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_kv_create(state: State<'_, AppState>, conn_id: String, bucket: String) -> Result<(), AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.kv_create(bucket).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_kv_delete_bucket(state: State<'_, AppState>, conn_id: String, bucket: String) -> Result<(), AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.kv_delete_bucket(&bucket).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_kv_keys(state: State<'_, AppState>, conn_id: String, bucket: String) -> Result<Vec<String>, AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.kv_keys(&bucket).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_kv_get(state: State<'_, AppState>, conn_id: String, bucket: String, key: String) -> Result<Option<String>, AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.kv_get(&bucket, &key).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_kv_put(state: State<'_, AppState>, conn_id: String, bucket: String, key: String, value: String) -> Result<(), AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.kv_put(&bucket, &key, value).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_kv_delete(state: State<'_, AppState>, conn_id: String, bucket: String, key: String) -> Result<(), AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.kv_delete(&bucket, &key).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

// ---- Object Store (T9) ------------------------------------------------------

#[tauri::command]
pub async fn nats_obj_buckets(state: State<'_, AppState>, conn_id: String) -> Result<Vec<String>, AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.obj_buckets().await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_obj_create(state: State<'_, AppState>, conn_id: String, bucket: String) -> Result<(), AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.obj_create(bucket).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_obj_delete_bucket(state: State<'_, AppState>, conn_id: String, bucket: String) -> Result<(), AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.obj_delete_bucket(&bucket).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_obj_list(state: State<'_, AppState>, conn_id: String, bucket: String) -> Result<Vec<ObjInfo>, AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.obj_list(&bucket).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_obj_put_file(state: State<'_, AppState>, conn_id: String, bucket: String, name: String, path: String) -> Result<(), AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.obj_put_file(&bucket, name, &path).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_obj_get_file(state: State<'_, AppState>, conn_id: String, bucket: String, name: String, path: String) -> Result<(), AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.obj_get_file(&bucket, &name, &path).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn nats_obj_delete(state: State<'_, AppState>, conn_id: String, bucket: String, name: String) -> Result<(), AppError> {
    let inner = state.registry.with_driver(&conn_id, move |driver| async move {
        let d = driver.lock().await;
        match &*d { LiveConnection::Nats(n) => n.obj_delete(&bucket, &name).await, _ => Err(not_nats()) }
    }).await?;
    inner.map_err(|e| AppError::Driver(e.message))
}
