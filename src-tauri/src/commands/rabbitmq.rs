//! IPC commands for RabbitMQ (Management HTTP API). Each command clones the
//! connection's HTTP client out of the registry (`rabbit_driver`) and makes its
//! round trip without holding the connection lock.

use serde_json::Value;
use tauri::State;

use crate::drivers::rabbitmq::{
    RabbitBinding, RabbitExchange, RabbitMessage, RabbitOverview, RabbitPublishResult, RabbitQueue,
};
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn map(e: QueryError) -> AppError {
    AppError::Driver(e.message)
}

#[tauri::command]
pub async fn rabbit_overview(state: State<'_, AppState>, conn_id: String) -> Result<RabbitOverview, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.overview().await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_vhosts(state: State<'_, AppState>, conn_id: String) -> Result<Vec<String>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.vhosts().await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_queues(state: State<'_, AppState>, conn_id: String, vhost: String) -> Result<Vec<RabbitQueue>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.queues(&vhost).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_queue(state: State<'_, AppState>, conn_id: String, vhost: String, queue: String) -> Result<RabbitQueue, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.queue(&vhost, &queue).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_exchanges(state: State<'_, AppState>, conn_id: String, vhost: String) -> Result<Vec<RabbitExchange>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.exchanges(&vhost).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_queue_bindings(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    queue: String,
) -> Result<Vec<RabbitBinding>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.queue_bindings(&vhost, &queue).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_exchange_bindings(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    exchange: String,
) -> Result<Vec<RabbitBinding>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.exchange_bindings(&vhost, &exchange).await.map_err(map)
}

/// `mode`: "requeue" (peek — messages stay in the queue) | "ack" | "reject".
#[tauri::command]
pub async fn rabbit_get_messages(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    queue: String,
    count: u32,
    mode: String,
) -> Result<Vec<RabbitMessage>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.get_messages(&vhost, &queue, count, &mode).await.map_err(map)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rabbit_publish(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    exchange: String,
    routing_key: String,
    payload: String,
    payload_encoding: Option<String>,
    properties: Option<Value>,
) -> Result<RabbitPublishResult, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.publish(
        &vhost,
        &exchange,
        &routing_key,
        &payload,
        payload_encoding.as_deref().unwrap_or("string"),
        properties.unwrap_or(Value::Null),
    )
    .await
    .map_err(map)
}

#[tauri::command]
pub async fn rabbit_purge_queue(state: State<'_, AppState>, conn_id: String, vhost: String, queue: String) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.purge_queue(&vhost, &queue).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_delete_queue(state: State<'_, AppState>, conn_id: String, vhost: String, queue: String) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.delete_queue(&vhost, &queue).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_delete_exchange(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    exchange: String,
) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.delete_exchange(&vhost, &exchange).await.map_err(map)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rabbit_declare_queue(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    name: String,
    queue_type: String,
    durable: bool,
    auto_delete: bool,
    arguments: Option<Value>,
) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.declare_queue(&vhost, &name, &queue_type, durable, auto_delete, arguments.unwrap_or(Value::Null))
        .await
        .map_err(map)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rabbit_declare_exchange(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    name: String,
    exchange_type: String,
    durable: bool,
    auto_delete: bool,
    internal: bool,
    arguments: Option<Value>,
) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.declare_exchange_with(&vhost, &name, &exchange_type, durable, auto_delete, internal, arguments.unwrap_or(Value::Null))
        .await
        .map_err(map)
}

#[tauri::command]
pub async fn rabbit_bind_queue(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    exchange: String,
    queue: String,
    routing_key: String,
) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.bind_queue(&vhost, &exchange, &queue, &routing_key, Value::Null).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_unbind_queue(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    exchange: String,
    queue: String,
    properties_key: String,
) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.unbind_queue(&vhost, &exchange, &queue, &properties_key).await.map_err(map)
}

// ---------------------------------------------------------------------------
// Live listening — a background task polls the queue (consume) or the session's
// tap queue (watch) and streams what it gets as batched "rabbit-live" events.
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

use crate::drivers::rabbitmq::{
    idle_poll_delay, LivePlan, RabbitDriver, RabbitPermission, RabbitPolicy, RabbitTopicPermission, RabbitUser,
    RabbitVhost, RabbitWhoami,
};

/// Messages taken per poll. The management API's basic.get is per-message on the
/// broker side, so a few hundred per call keeps up with bursts without one call
/// holding the HTTP connection for long.
const LIVE_BATCH: u32 = 200;
/// Consecutive failed polls after which a session gives up (the error is shown).
const LIVE_MAX_ERRORS: u32 = 5;

fn live_sessions() -> &'static Mutex<HashMap<String, (u64, CancellationToken)>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, (u64, CancellationToken)>>> = OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}
static LIVE_GEN: AtomicU64 = AtomicU64::new(1);

#[derive(serde::Deserialize)]
pub struct LiveRequest {
    pub session: String,
    /// "watch" (non-destructive copy) | "consume" (ack — removes from the queue)
    pub mode: String,
    pub vhost: String,
    pub queue: Option<String>,
    pub exchange: Option<String>,
    #[serde(default)]
    pub routing_keys: Vec<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct LiveInfo {
    pub session: String,
    pub mode: String,
    #[serde(flatten)]
    pub plan: LivePlan,
}

#[derive(serde::Serialize, Clone)]
struct LiveBatch {
    session: String,
    msgs: Vec<RabbitMessage>,
    received: u64,
}

#[derive(serde::Serialize, Clone)]
struct LiveStatus {
    session: String,
    /// "warn" (transient, still running) | "error" (stopped) | "stopped"
    state: &'static str,
    message: String,
}

#[tauri::command]
pub async fn rabbit_live_start(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    request: LiveRequest,
) -> Result<LiveInfo, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    let plan = d
        .prepare_live(
            &request.session,
            &request.mode,
            &request.vhost,
            request.queue.as_deref(),
            request.exchange.as_deref(),
            &request.routing_keys,
        )
        .await
        .map_err(map)?;
    let token = CancellationToken::new();
    let gen = LIVE_GEN.fetch_add(1, Ordering::Relaxed);
    if let Some((_, old)) = live_sessions().lock().unwrap().insert(request.session.clone(), (gen, token.clone())) {
        old.cancel();
    }
    tokio::spawn(run_live(
        app,
        conn_id,
        request.session.clone(),
        request.vhost.clone(),
        plan.clone(),
        d,
        gen,
        token,
    ));
    Ok(LiveInfo { session: request.session, mode: request.mode, plan })
}

#[tauri::command]
pub async fn rabbit_live_stop(session: String) -> Result<(), AppError> {
    if let Some((_, t)) = live_sessions().lock().unwrap().remove(&session) {
        t.cancel();
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_live(
    app: AppHandle,
    conn_id: String,
    session: String,
    vhost: String,
    plan: LivePlan,
    first: RabbitDriver,
    gen: u64,
    token: CancellationToken,
) {
    let status = |state: &'static str, message: String| {
        let _ = app.emit("rabbit-live-status", LiveStatus { session: session.clone(), state, message });
    };
    let mut driver = first;
    let mut received: u64 = 0;
    let mut idle: u32 = 0;
    let mut errors: u32 = 0;
    loop {
        if token.is_cancelled() {
            break;
        }
        // Re-acquire each round: a reconnect swaps the client, and a disconnect must
        // stop the session instead of polling a connection the user closed.
        match app.state::<AppState>().registry.rabbit_driver(&conn_id).await {
            Ok(d) => driver = d,
            Err(_) => {
                status("error", "The connection was closed — live listening stopped".into());
                break;
            }
        }
        let fetched = tokio::select! {
            _ = token.cancelled() => break,
            r = driver.get_messages(&vhost, &plan.source, LIVE_BATCH, "ack") => r,
        };
        match fetched {
            Ok(msgs) if !msgs.is_empty() => {
                received += msgs.len() as u64;
                idle = 0;
                errors = 0;
                let _ = app.emit("rabbit-live", LiveBatch { session: session.clone(), msgs, received });
                continue; // drain a burst without waiting
            }
            Ok(_) => {
                errors = 0;
                let wait = idle_poll_delay(idle);
                idle = idle.saturating_add(1);
                tokio::select! {
                    _ = token.cancelled() => break,
                    _ = tokio::time::sleep(wait) => {}
                }
            }
            Err(e) => {
                if e.message.starts_with("Not found") {
                    status("error", format!("'{}' no longer exists — live listening stopped", plan.source));
                    break;
                }
                errors += 1;
                if errors >= LIVE_MAX_ERRORS {
                    status("error", e.message);
                    break;
                }
                status("warn", e.message);
                tokio::select! {
                    _ = token.cancelled() => break,
                    _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
                }
            }
        }
    }
    if let Some(tap) = &plan.tap_queue {
        let _ = driver.delete_queue(&vhost, tap).await;
    }
    {
        let mut map = live_sessions().lock().unwrap();
        if map.get(&session).map(|(g, _)| *g == gen).unwrap_or(false) {
            map.remove(&session);
        }
    }
    status("stopped", format!("{received} message(s) received"));
}

// ---------------------------------------------------------------------------
// Users · permissions · topic permissions · policies · vhosts
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn rabbit_whoami(state: State<'_, AppState>, conn_id: String) -> Result<RabbitWhoami, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.whoami().await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_vhost_list(state: State<'_, AppState>, conn_id: String) -> Result<Vec<RabbitVhost>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.vhost_list().await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_create_vhost(state: State<'_, AppState>, conn_id: String, name: String, description: String) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.create_vhost(&name, &description).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_delete_vhost(state: State<'_, AppState>, conn_id: String, name: String) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.delete_vhost(&name).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_users(state: State<'_, AppState>, conn_id: String) -> Result<Vec<RabbitUser>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.users().await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_create_user(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    password: String,
    tags: Vec<String>,
) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.create_user(&name, &password, &tags).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_set_user_password(state: State<'_, AppState>, conn_id: String, name: String, password: String) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.set_user_password(&name, &password).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_set_user_tags(state: State<'_, AppState>, conn_id: String, name: String, tags: Vec<String>) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.set_user_tags(&name, &tags).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_delete_user(state: State<'_, AppState>, conn_id: String, name: String) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.delete_user(&name).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_permissions(state: State<'_, AppState>, conn_id: String) -> Result<Vec<RabbitPermission>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.permissions().await.map_err(map)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rabbit_set_permission(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    user: String,
    configure: String,
    write: String,
    read: String,
) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.set_permission(&vhost, &user, &configure, &write, &read).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_delete_permission(state: State<'_, AppState>, conn_id: String, vhost: String, user: String) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.delete_permission(&vhost, &user).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_topic_permissions(state: State<'_, AppState>, conn_id: String) -> Result<Vec<RabbitTopicPermission>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.topic_permissions().await.map_err(map)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rabbit_set_topic_permission(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    user: String,
    exchange: String,
    write: String,
    read: String,
) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.set_topic_permission(&vhost, &user, &exchange, &write, &read).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_delete_topic_permissions(state: State<'_, AppState>, conn_id: String, vhost: String, user: String) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.delete_topic_permissions(&vhost, &user).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_policies(state: State<'_, AppState>, conn_id: String, vhost: String) -> Result<Vec<RabbitPolicy>, AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.policies(&vhost).await.map_err(map)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rabbit_set_policy(
    state: State<'_, AppState>,
    conn_id: String,
    vhost: String,
    name: String,
    pattern: String,
    apply_to: String,
    priority: i64,
    definition: Value,
) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.set_policy(&vhost, &name, &pattern, &apply_to, priority, definition).await.map_err(map)
}

#[tauri::command]
pub async fn rabbit_delete_policy(state: State<'_, AppState>, conn_id: String, vhost: String, name: String) -> Result<(), AppError> {
    let d = state.registry.rabbit_driver(&conn_id).await?;
    d.delete_policy(&vhost, &name).await.map_err(map)
}
