//! IPC commands cho Kafka (Phase 4). Metadata (cluster + topics) + admin
//! (create/delete topic). Consumer/producer/groups ở các task sau.

use tauri::{AppHandle, Emitter, State};

use crate::drivers::kafka::{borrowed_to_message, KafkaCluster, KafkaMessage, KafkaTopic};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_kafka() -> QueryError {
    QueryError::new("kafka", "Connection không phải Kafka", "not a kafka connection")
}

/// Event "kafka-msg" gửi ra frontend (1 message consume được).
#[derive(serde::Serialize, Clone)]
struct KafkaMsgEvent {
    conn_id: String,
    #[serde(flatten)]
    msg: KafkaMessage,
}

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
    use rdkafka::consumer::Consumer;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    let consumer = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.browse_consumer(&topic, &from, offset, partition),
                _ => Err(not_kafka()),
            }
        })
        .await?
        .map_err(|e| AppError::Driver(e.message))?;

    let stop = Arc::new(AtomicBool::new(false));
    state.kafka_stops.set(conn_id.clone(), stop.clone());
    let cid = conn_id;
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            if let Some(Ok(m)) = consumer.poll(Duration::from_millis(400)) {
                let _ = app.emit("kafka-msg", KafkaMsgEvent { conn_id: cid.clone(), msg: borrowed_to_message(&m) });
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
