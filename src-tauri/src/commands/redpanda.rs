//! IPC commands for Redpanda (SPEC-REDPANDA.md) and Kafka ACLs.
//!
//! `redpanda_admin_request` is the generic Admin API call every Redpanda screen is
//! built on (health, brokers, maintenance, cluster config, users, roles, transforms);
//! `redpanda_server_info` detects the flavor on connect and remembers it in the saved
//! profile. The ACL commands use the Kafka protocol, so they also serve Apache Kafka.

use tauri::State;

use crate::drivers::kafka_acl::{AclFilter, KafkaAcl};
use crate::drivers::redpanda::{RpAdmin, RpResponse, RpServerInfo};
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn not_kafka() -> QueryError {
    QueryError::new("kafka", "Connection is not Kafka / Redpanda", "not a kafka connection")
}

fn base_id(conn_id: &str) -> String {
    let no_tab = conn_id.split('#').next().unwrap_or(conn_id);
    no_tab.split("::").next().unwrap_or(no_tab).to_string()
}

/// Any Redpanda Admin API call; a non-2xx answer is returned as-is (status + message).
#[tauri::command]
pub async fn redpanda_admin_request(
    state: State<'_, AppState>,
    conn_id: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<RpResponse, AppError> {
    let params = state.registry.redpanda_admin_params(&base_id(&conn_id))?;
    let admin = RpAdmin::new(&params).map_err(|e| AppError::Driver(e.message))?;
    admin.request(&method, &path, body).await.map_err(|e| AppError::Driver(e.message))
}

/// Is this Kafka-engine connection a Redpanda cluster? Asks the Admin API; the answer
/// is written back to the saved profile (`cassandra_flavor` = the generic "server
/// flavor" field) so the logo and sidebar group are right before the next connect.
/// "kafka" when no Admin API answers.
#[tauri::command]
pub async fn redpanda_server_info(state: State<'_, AppState>, conn_id: String) -> Result<RpServerInfo, AppError> {
    let base = base_id(&conn_id);
    let params = state.registry.redpanda_admin_params(&base)?;
    let admin = RpAdmin::new(&params).map_err(|e| AppError::Driver(e.message))?;
    let info = match tokio::time::timeout(std::time::Duration::from_secs(4), admin.server_info()).await {
        Ok(Ok(i)) => i,
        _ => RpServerInfo { flavor: "kafka".into(), version: String::new(), label: "Apache Kafka".into(), brokers: 0 },
    };
    if let Ok(mut p) = state.storage.get_connection(&base) {
        if p.system == crate::drivers::types::SystemType::Kafka && p.cassandra_flavor != info.flavor {
            p.cassandra_flavor = info.flavor.clone();
            state.storage.save_connection(&p)?;
        }
    }
    Ok(info)
}

/// ACL bindings matching `filter` (Kafka DescribeAcls).
#[tauri::command]
pub async fn kafka_acls(state: State<'_, AppState>, conn_id: String, filter: Option<AclFilter>) -> Result<Vec<KafkaAcl>, AppError> {
    let f = filter.unwrap_or_default();
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.acls(f).await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Create ACL bindings (Kafka CreateAcls); returns how many were created.
#[tauri::command]
pub async fn kafka_create_acls(state: State<'_, AppState>, conn_id: String, acls: Vec<KafkaAcl>) -> Result<usize, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.create_acls(acls).await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}

/// Delete the ACL bindings matching each filter (Kafka DeleteAcls); returns what was removed.
#[tauri::command]
pub async fn kafka_delete_acls(state: State<'_, AppState>, conn_id: String, filters: Vec<AclFilter>) -> Result<Vec<KafkaAcl>, AppError> {
    let inner = state
        .registry
        .with_driver(&conn_id, move |driver| async move {
            let d = driver.lock().await;
            match &*d {
                LiveConnection::Kafka(k) => k.delete_acls(filters).await,
                _ => Err(not_kafka()),
            }
        })
        .await?;
    inner.map_err(|e| AppError::Driver(e.message))
}
