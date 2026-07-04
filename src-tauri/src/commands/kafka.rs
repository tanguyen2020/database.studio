//! IPC commands cho Kafka (Phase 4). Metadata (cluster + topics) + admin
//! (create/delete topic). Consumer/producer/groups ở các task sau.

use tauri::State;

use crate::drivers::kafka::{KafkaCluster, KafkaTopic};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_kafka() -> QueryError {
    QueryError::new("kafka", "Connection không phải Kafka", "not a kafka connection")
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
