//! IPC commands cho Kafka (Phase 4). Metadata (cluster + topics) + admin
//! (create/delete topic). Consumer/producer/groups ở các task sau.

use tauri::{AppHandle, Emitter, State};

use crate::drivers::kafka::{
    borrowed_to_message, KafkaCluster, KafkaGroup, KafkaLag, KafkaMessage, KafkaTopic,
};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_kafka() -> QueryError {
    QueryError::new("kafka", "Connection is not Kafka", "not a kafka connection")
}

/// Event "kafka-msg" gửi ra frontend (1 message consume được).
#[derive(serde::Serialize, Clone)]
struct KafkaMsgEvent {
    conn_id: String,
    #[serde(flatten)]
    msg: KafkaMessage,
}

/// Event "kafka-status": librdkafka errors/warnings + consume lifecycle, so the
/// consumer UI can show WHY a browse produced no messages instead of failing
/// silently. `level` = "error" | "warn" | "info".
#[derive(serde::Serialize, Clone)]
struct KafkaStatusEvent {
    conn_id: String,
    level: String,
    message: String,
}

/// ConsumerContext that pipes librdkafka's error/log callbacks (connection
/// refused, fetch failures, unknown partition, …) out to the frontend. Without
/// this, those errors only reach librdkafka's internal log and the poll loop
/// sees `None`, so the grid stays empty with no explanation.
struct BrowseContext {
    app: AppHandle,
    conn_id: String,
}

impl BrowseContext {
    fn emit(&self, level: &str, message: String) {
        let _ = self.app.emit(
            "kafka-status",
            KafkaStatusEvent { conn_id: self.conn_id.clone(), level: level.into(), message },
        );
    }
}

impl rdkafka::client::ClientContext for BrowseContext {
    fn error(&self, error: rdkafka::error::KafkaError, reason: &str) {
        use rdkafka::error::RDKafkaErrorCode;
        // PartitionEOF ("reached end of partition / no more messages") is informational,
        // not a failure — librdkafka raises it via the error callback too when
        // enable.partition.eof is on. Don't surface it as an error toast. Match by code
        // AND by text (the callback may wrap it as KafkaError::Global, whose code may
        // not resolve on every rdkafka version).
        let display = format!("{error}");
        let is_eof = error.rdkafka_error_code() == Some(RDKafkaErrorCode::PartitionEOF)
            || display.contains("PartitionEOF")
            || reason.contains("reached end of partition");
        if is_eof {
            return;
        }
        self.emit("error", format!("{display}: {reason}"));
    }
    fn log(&self, level: rdkafka::config::RDKafkaLogLevel, fac: &str, log_message: &str) {
        use rdkafka::config::RDKafkaLogLevel::*;
        // Forward only notable levels — debug/info would flood the UI.
        if matches!(level, Emerg | Alert | Critical | Error | Warning) {
            self.emit("warn", format!("[{fac}] {log_message}"));
        }
    }
}

impl rdkafka::consumer::ConsumerContext for BrowseContext {}

/// Kết quả produce.
#[derive(serde::Serialize)]
pub struct ProduceResult {
    partition: i32,
    offset: i64,
}

/// Cluster overview: brokers, controller, tổng topic/partition.
#[tauri::command]
pub async fn kafka_cluster(state: State<'_, AppState>, conn_id: String) -> Result<KafkaCluster, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.cluster_info().await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// List topics + partitions + offsets/lag.
#[tauri::command]
pub async fn kafka_topics(state: State<'_, AppState>, conn_id: String) -> Result<Vec<KafkaTopic>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.topics().await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn kafka_create_topic(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    partitions: i32,
    replication: i32,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.create_topic(&name, partitions, replication).await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

#[tauri::command]
pub async fn kafka_delete_topic(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.delete_topic(&name).await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Clear a topic's messages (delete records up to the high watermark) — keeps
/// the topic itself.
#[tauri::command]
pub async fn kafka_purge_topic(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.purge_topic(&name).await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Delete records in one partition up to (and including) `offset` — Kafka's only
/// per-message deletion (truncates the log prefix; removes this record + all older
/// ones in that partition).
#[tauri::command]
pub async fn kafka_delete_records(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    partition: i32,
    offset: i64,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.delete_records_upto(&name, partition, offset).await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// List consumer groups + members.
#[tauri::command]
pub async fn kafka_consumer_groups(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<KafkaGroup>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.consumer_groups().await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Lag per topic-partition của 1 group.
#[tauri::command]
pub async fn kafka_group_lag(
    state: State<'_, AppState>,
    conn_id: String,
    group: String,
) -> Result<Vec<KafkaLag>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.group_lag(group).await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Reset offset của group cho 1 topic-partition.
#[tauri::command]
pub async fn kafka_reset_offset(
    state: State<'_, AppState>,
    conn_id: String,
    group: String,
    topic: String,
    partition: i32,
    target: String,
    offset: i64,
) -> Result<(), AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.reset_group_offset(group, topic, partition, target, offset).await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Consume topic (từ earliest/latest/offset) → stream message qua event "kafka-msg".
/// Chạy poll loop trong OS thread riêng (rdkafka BaseConsumer phải drop trong chính
/// thread poll của nó, tránh deadlock async). Dừng qua cờ AtomicBool trong state.kafka_stops.
#[tauri::command]
pub async fn kafka_consume(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    topic: String,
    from: String,
    offset: i64,
    partition: Option<i32>,
) -> Result<(), AppError> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    let ctx = BrowseContext { app: app.clone(), conn_id: conn_id.clone() };
    let consumer = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.browse_consumer(&topic, &from, offset, partition, ctx),
                _ => Err(not_kafka()),
            }
        })
        .await?
        .map_err(|e| AppError::Driver(e.message))?;

    let stop = Arc::new(AtomicBool::new(false));
    state.kafka_stops.set(conn_id.clone(), stop.clone());
    let cid = conn_id;
    std::thread::spawn(move || {
        use rdkafka::error::KafkaError;
        let mut last_err = String::new();
        while !stop.load(Ordering::Relaxed) {
            match consumer.poll(Duration::from_millis(400)) {
                Some(Ok(m)) => {
                    let _ = app.emit(
                        "kafka-msg",
                        KafkaMsgEvent { conn_id: cid.clone(), msg: borrowed_to_message(&m) },
                    );
                }
                // Reached the end of a partition — normal, means "all read / empty".
                Some(Err(KafkaError::PartitionEOF(_))) => {}
                // Real fetch/partition error — surface it (dedup consecutive repeats).
                Some(Err(e)) => {
                    let msg = e.to_string();
                    if msg != last_err {
                        last_err = msg.clone();
                        let _ = app.emit(
                            "kafka-status",
                            KafkaStatusEvent {
                                conn_id: cid.clone(),
                                level: "error".into(),
                                message: msg,
                            },
                        );
                    }
                }
                None => {}
            }
        }
        // consumer drop TRONG thread poll này → close sạch, không deadlock.
        drop(consumer);
    });
    Ok(())
}

/// Dừng consumer của connection (bật cờ → thread poll thoát + drop consumer sạch).
#[tauri::command]
pub async fn kafka_stop_consume(state: State<'_, AppState>, conn_id: String) -> Result<(), AppError> {
    state.kafka_stops.stop(&conn_id);
    Ok(())
}

/// Produce 1 message → partition + offset đã land.
#[tauri::command]
pub async fn kafka_produce(
    state: State<'_, AppState>,
    conn_id: String,
    topic: String,
    key: String,
    value: String,
    partition: Option<i32>,
) -> Result<ProduceResult, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.produce(&topic, &key, &value, partition).await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner
        .map(|(partition, offset)| ProduceResult { partition, offset })
        .map_err(|e| AppError::Driver(e.message))
}

// ===== Schema Registry (T7) — read-only browser over the Confluent REST API =====

use crate::drivers::schema_registry::{SchemaRegistryClient, SrSchema, SrSubject};

fn sr_client(state: &State<'_, AppState>, conn_id: &str) -> Result<SchemaRegistryClient, AppError> {
    let params = state.registry.schema_registry_params(conn_id)?;
    SchemaRegistryClient::new(params).map_err(|e| AppError::Driver(e.message))
}

/// List subjects (name + format + latest version + compatibility).
#[tauri::command]
pub async fn kafka_sr_subjects(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<SrSubject>, AppError> {
    let client = sr_client(&state, &conn_id)?;
    client.subjects().await.map_err(|e| AppError::Driver(e.message))
}

/// Version numbers registered for a subject.
#[tauri::command]
pub async fn kafka_sr_versions(
    state: State<'_, AppState>,
    conn_id: String,
    subject: String,
) -> Result<Vec<i32>, AppError> {
    let client = sr_client(&state, &conn_id)?;
    client.versions(&subject).await.map_err(|e| AppError::Driver(e.message))
}

/// A specific registered schema version.
#[tauri::command]
pub async fn kafka_sr_schema(
    state: State<'_, AppState>,
    conn_id: String,
    subject: String,
    version: i32,
) -> Result<SrSchema, AppError> {
    let client = sr_client(&state, &conn_id)?;
    client.schema(&subject, version).await.map_err(|e| AppError::Driver(e.message))
}
