//! IPC commands for Elasticsearch (REST API). Each command clones the
//! connection's HTTP client out of the registry (`es_driver`) and makes its round
//! trip without holding the connection lock.
//!
//! `es_request` is the generic, full-surface call (Dev Tools console and every
//! management screen are built on it); the typed reads below are what the
//! explorer needs on each refresh.

use tauri::State;

use crate::drivers::elasticsearch::{EsIndex, EsOverview, EsResponse};
use crate::error::{AppError, QueryError};
use crate::state::AppState;

fn map(e: QueryError) -> AppError {
    AppError::Driver(e.message)
}

/// Any REST call on the cluster: `method` + path relative to the cluster
/// (`/_cat/indices?v`), optional JSON / NDJSON body. A non-2xx answer is returned
/// as-is (status + Elasticsearch's error document), not as an error.
#[tauri::command]
pub async fn es_request(
    state: State<'_, AppState>,
    conn_id: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<EsResponse, AppError> {
    let d = state.registry.es_driver(&conn_id).await?;
    d.request(&method, &path, body).await.map_err(map)
}

#[tauri::command]
pub async fn es_overview(state: State<'_, AppState>, conn_id: String) -> Result<EsOverview, AppError> {
    let d = state.registry.es_driver(&conn_id).await?;
    d.overview().await.map_err(map)
}

#[tauri::command]
pub async fn es_indices(state: State<'_, AppState>, conn_id: String) -> Result<Vec<EsIndex>, AppError> {
    let d = state.registry.es_driver(&conn_id).await?;
    d.indices().await.map_err(map)
}

/// `(dotted.field.path, type)` of an index (or pattern) mapping.
#[tauri::command]
pub async fn es_mapping_fields(
    state: State<'_, AppState>,
    conn_id: String,
    index: String,
) -> Result<Vec<(String, String)>, AppError> {
    let d = state.registry.es_driver(&conn_id).await?;
    d.mapping_fields(&index).await.map_err(map)
}

/// Which server a REST connection talks to — Elasticsearch or OpenSearch — and its
/// version (SPEC-OPENSEARCH.md §2). The flavor is written back to the saved profile
/// (`cassandra_flavor` is the profile's generic "server flavor" field) so the right
/// logo / sidebar group / screens show before the next connect. Quick-connect ids
/// are not in storage and are skipped.
#[derive(serde::Serialize)]
pub struct EsServerInfo {
    /// "elasticsearch" | "opensearch"
    pub flavor: String,
    /// empty when the user may not read `GET /` (least-privilege login)
    pub version: String,
    /// "OpenSearch 3.9.0" / "Elasticsearch 8.15.3" (just the product when the version is hidden)
    pub label: String,
}

pub fn server_info_of(info: &crate::drivers::elasticsearch::EsInfo) -> EsServerInfo {
    let os = info.distribution == "opensearch";
    let product = if os { "OpenSearch" } else { "Elasticsearch" };
    EsServerInfo {
        flavor: if os { "opensearch" } else { "elasticsearch" }.into(),
        version: info.version.clone(),
        label: if info.version.is_empty() { product.into() } else { format!("{product} {}", info.version) },
    }
}

#[tauri::command]
pub async fn es_server_info(state: State<'_, AppState>, conn_id: String) -> Result<EsServerInfo, AppError> {
    let d = state.registry.es_driver(&conn_id).await?;
    let info = server_info_of(d.info());
    let base = {
        let no_tab = conn_id.split('#').next().unwrap_or(&conn_id);
        no_tab.split("::").next().unwrap_or(no_tab).to_string()
    };
    if let Ok(mut p) = state.storage.get_connection(&base) {
        if p.system == crate::drivers::types::SystemType::Elasticsearch && p.cassandra_flavor != info.flavor {
            p.cassandra_flavor = info.flavor.clone();
            state.storage.save_connection(&p)?;
        }
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::elasticsearch::EsInfo;

    #[test]
    fn server_info_names_the_product() {
        let os = EsInfo { distribution: "opensearch".into(), version: "3.9.0".into(), ..Default::default() };
        let i = server_info_of(&os);
        assert_eq!((i.flavor.as_str(), i.label.as_str()), ("opensearch", "OpenSearch 3.9.0"));
        let es = EsInfo { distribution: "elasticsearch".into(), version: "8.15.3".into(), ..Default::default() };
        assert_eq!(server_info_of(&es).label, "Elasticsearch 8.15.3");
        // least-privilege login: no version, product still known
        let hidden = EsInfo { distribution: "opensearch".into(), ..Default::default() };
        assert_eq!(server_info_of(&hidden).label, "OpenSearch");
        assert_eq!(server_info_of(&EsInfo::default()).flavor, "elasticsearch");
    }
}
