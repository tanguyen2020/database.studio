//! IPC commands cho NATS (Phase 3 · T9). Core: info + subject subscriber (stream
//! qua event "nats-msg") + publish + request/reply. Tái dùng state.pubsub cho
//! AbortHandle của task subscribe (1 subscription / connection).

use futures::StreamExt;
use tauri::{AppHandle, Emitter, State};

use crate::drivers::nats::{JsConsumer, JsMessage, JsPage, JsStream, ObjInfo, SubjectStats, StreamSubjects};
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
    start_seq: Option<u64>,
) -> Result<Vec<JsMessage>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_subject_messages(&stream, &subject, limit, start_seq).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: ONE page of a subject's messages, newest-first. `end_seq` is the
/// cursor (omit for the newest page; pass `first seq of the current page - 1` for
/// the next, older page). Always returns up to `page_size` real messages of the
/// subject — no matter how sparsely it is spread across the stream.
#[tauri::command]
pub async fn nats_js_subject_page(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    subject: String,
    page_size: usize,
    end_seq: Option<u64>,
) -> Result<JsPage, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_subject_page(&stream, &subject, page_size, end_seq).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: subject NAMES under `filter` that start with `prefix`
/// (case-insensitive), with each one's message count. Reads the server's
/// per-subject index — a subject search that costs one API call, not a walk of
/// the messages. NATS filters are per token and case-sensitive, so this is the
/// only way a partial token (`_inbox.opjxo`) can find its subject.
#[tauri::command]
pub async fn nats_js_stream_subjects(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    filter: String,
    prefix: String,
    limit: usize,
) -> Result<StreamSubjects, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_stream_subjects(&stream, &filter, &prefix, limit).await,
                _ => Err(not_nats()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream: total retained messages + last sequence for a subject (pagination).
#[tauri::command]
pub async fn nats_js_subject_stats(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    subject: String,
) -> Result<SubjectStats, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_subject_stats(&stream, &subject).await,
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

/// JetStream: add a subject to a stream and publish an initial message to it.
#[tauri::command]
pub async fn nats_js_add_subject(
    state: State<'_, AppState>,
    conn_id: String,
    stream: String,
    subject: String,
    payload: String,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Nats(n) => n.js_add_subject(&stream, &subject, &payload).await,
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

// ---- stream-workspace:nats (W4) — account usage + KV versions / history / watch ----

use crate::drivers::nats::{KvCreate, KvEntries, KvEntry, KvStatus, NatsAccount};

/// Run one driver call on the NATS connection (shared plumbing of the W4 commands).
async fn with_nats<T, F, Fut>(state: &State<'_, AppState>, conn_id: &str, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(crate::drivers::nats::NatsDriver) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, QueryError>> + Send,
{
    let inner = state
        .registry
        .with_driver(conn_id, move |driver| async move {
            let client = {
                let d = driver.lock().await;
                match &*d {
                    LiveConnection::Nats(n) => n.client(),
                    _ => return Err(not_nats()),
                }
            };
            // the client is multiplexed: clone it and release the lock for the round trip
            f(crate::drivers::nats::NatsDriver { client }).await
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// JetStream usage + limits of the account (`enabled = false` when JetStream is off).
#[tauri::command]
pub async fn nats_account_info(state: State<'_, AppState>, conn_id: String) -> Result<NatsAccount, AppError> {
    with_nats(&state, &conn_id, |n| async move { n.account_info().await }).await
}

/// Settings + size of one key-value bucket.
#[tauri::command]
pub async fn nats_kv_status(state: State<'_, AppState>, conn_id: String, bucket: String) -> Result<KvStatus, AppError> {
    with_nats(&state, &conn_id, move |n| async move { n.kv_status(&bucket).await }).await
}

/// Every key-value bucket with its settings and size (one stream listing).
#[tauri::command]
pub async fn nats_kv_bucket_list(state: State<'_, AppState>, conn_id: String) -> Result<Vec<KvStatus>, AppError> {
    with_nats(&state, &conn_id, |n| async move { n.kv_bucket_list().await }).await
}

/// Latest value + version + time of every key in a bucket (deleted keys as markers).
#[tauri::command]
pub async fn nats_kv_entries(
    state: State<'_, AppState>,
    conn_id: String,
    bucket: String,
    limit: Option<usize>,
) -> Result<KvEntries, AppError> {
    with_nats(&state, &conn_id, move |n| async move { n.kv_entries(&bucket, limit.unwrap_or(2_000)).await }).await
}

/// Current entry of one key (value + version + time), `None` = never set.
#[tauri::command]
pub async fn nats_kv_entry(
    state: State<'_, AppState>,
    conn_id: String,
    bucket: String,
    key: String,
) -> Result<Option<KvEntry>, AppError> {
    with_nats(&state, &conn_id, move |n| async move { n.kv_entry(&bucket, &key).await }).await
}

/// Every version still kept for a key, oldest first, delete / purge markers included.
#[tauri::command]
pub async fn nats_kv_history(
    state: State<'_, AppState>,
    conn_id: String,
    bucket: String,
    key: String,
) -> Result<Vec<KvEntry>, AppError> {
    with_nats(&state, &conn_id, move |n| async move { n.kv_history(&bucket, &key).await }).await
}

/// Save a value as a new version; returns the version number.
#[tauri::command]
pub async fn nats_kv_put_version(
    state: State<'_, AppState>,
    conn_id: String,
    bucket: String,
    key: String,
    value: String,
) -> Result<u64, AppError> {
    with_nats(&state, &conn_id, move |n| async move { n.kv_put_version(&bucket, &key, value).await }).await
}

/// Remove a key and every earlier version of it.
#[tauri::command]
pub async fn nats_kv_purge(state: State<'_, AppState>, conn_id: String, bucket: String, key: String) -> Result<(), AppError> {
    with_nats(&state, &conn_id, move |n| async move { n.kv_purge(&bucket, &key).await }).await
}

/// Create a bucket with explicit settings; returns its status.
#[tauri::command]
pub async fn nats_kv_create_bucket(state: State<'_, AppState>, conn_id: String, config: KvCreate) -> Result<KvStatus, AppError> {
    with_nats(&state, &conn_id, move |n| async move { n.kv_create_bucket(config).await }).await
}

// Live watch: a background task streams every change of the bucket as
// "nats-kv-watch" events until the tab stops it, the connection closes, or the
// server ends the subscription ("nats-kv-watch-status" says which).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

fn kv_watches() -> &'static Mutex<HashMap<String, (u64, CancellationToken)>> {
    static WATCHES: OnceLock<Mutex<HashMap<String, (u64, CancellationToken)>>> = OnceLock::new();
    WATCHES.get_or_init(Default::default)
}
static KV_WATCH_GEN: AtomicU64 = AtomicU64::new(1);

#[derive(serde::Serialize, Clone)]
struct KvWatchEvent {
    session: String,
    entry: KvEntry,
}

#[derive(serde::Serialize, Clone)]
struct KvWatchStatus {
    session: String,
    /// "stopped" (ended normally / connection closed) | "error"
    state: &'static str,
    message: String,
}

/// Start watching a bucket (`pattern` = key filter, default every key). The same
/// `session` id replaces an earlier watch of that session.
#[tauri::command]
pub async fn nats_kv_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    session: String,
    bucket: String,
    pattern: Option<String>,
) -> Result<(), AppError> {
    let client = state.registry.nats_client(&conn_id).await?;
    let driver = crate::drivers::nats::NatsDriver { client };
    let mut watch = driver
        .kv_watch(&bucket, pattern.as_deref().unwrap_or(">"))
        .await
        .map_err(|e| AppError::Driver(e.message))?;
    let token = CancellationToken::new();
    let gen = KV_WATCH_GEN.fetch_add(1, Ordering::Relaxed);
    if let Some((_, old)) = kv_watches().lock().unwrap().insert(session.clone(), (gen, token.clone())) {
        old.cancel();
    }
    tokio::spawn(async move {
        let status = |state: &'static str, message: String| {
            let _ = app.emit("nats-kv-watch-status", KvWatchStatus { session: session.clone(), state, message });
        };
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                _ = tick.tick() => {
                    // a closed connection ends the watch instead of keeping a hidden client alive
                    if !app.state::<AppState>().registry.is_connected(&conn_id) {
                        status("stopped", "The connection was closed.".into());
                        break;
                    }
                }
                item = watch.next() => match item {
                    Some(Ok(e)) => {
                        let _ = app.emit("nats-kv-watch", KvWatchEvent {
                            session: session.clone(),
                            entry: crate::drivers::nats::kv_entry_from(e),
                        });
                    }
                    Some(Err(e)) => {
                        status("error", format!("Watching stopped: {e}"));
                        break;
                    }
                    None => {
                        status("stopped", "The server ended the watch.".into());
                        break;
                    }
                }
            }
        }
        let mut map = kv_watches().lock().unwrap();
        if map.get(&session).is_some_and(|(g, _)| *g == gen) {
            map.remove(&session);
        }
    });
    Ok(())
}

/// Stop a watch (tab closed, toggle off).
#[tauri::command]
pub async fn nats_kv_unwatch(session: String) -> Result<(), AppError> {
    if let Some((_, t)) = kv_watches().lock().unwrap().remove(&session) {
        t.cancel();
    }
    Ok(())
}
