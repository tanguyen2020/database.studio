//! Live-connection registry: one entry per connected profile, owning the
//! driver, optional SSH tunnel, and the currently-running statement (for
//! cancellation). Cancel semantics (per approved plan): abort the in-flight
//! statement task, stop the multi-statement chain, and transparently
//! reconnect the (possibly desynced) connection before the next statement.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::task::AbortHandle;

use crate::connections::profile::ConnectionProfile;
use crate::connections::tunnel::{open_tunnel, TunnelHandle};
use crate::drivers::{Endpoint, LiveConnection};
use crate::error::{AppError, AppResult, QueryError};

struct LiveEntry {
    driver: Arc<tokio::sync::Mutex<LiveConnection>>,
    tunnel: Option<TunnelHandle>,
    profile: ConnectionProfile,
    /// Plaintext kept in memory only, for reconnect after cancel/save-reconnect.
    password: String,
    endpoint: Endpoint,
    running: Option<AbortHandle>,
    poisoned: bool,
    latency_ms: Option<u64>,
}

#[derive(Default)]
pub struct Registry {
    entries: Mutex<HashMap<String, LiveEntry>>,
}

/// Named future for tokio::spawn — an inline async block here trips a
/// compiler limitation ("implementation of Executor is not general enough")
/// with sqlx's lifetime-parameterized Executor impls.
async fn run_statement(
    driver: Arc<tokio::sync::Mutex<LiveConnection>>,
    sql: String,
) -> Result<crate::drivers::types::StatementOutcome, QueryError> {
    let mut d = driver.lock().await;
    d.exec(&sql).await
}

impl Registry {
    pub fn is_connected(&self, id: &str) -> bool {
        self.entries.lock().unwrap().contains_key(id)
    }

    pub fn latency(&self, id: &str) -> Option<u64> {
        self.entries.lock().unwrap().get(id).and_then(|e| e.latency_ms)
    }

    pub fn connected_ids(&self) -> Vec<String> {
        self.entries.lock().unwrap().keys().cloned().collect()
    }

    /// Opens tunnel (if configured) + driver connection and registers it.
    pub async fn connect(
        &self,
        profile: ConnectionProfile,
        password: String,
        ssh_password: String,
    ) -> AppResult<u64> {
        // Already connected → no-op (idempotent).
        if self.is_connected(&profile.id) {
            return Ok(self.latency(&profile.id).unwrap_or(0));
        }

        let started = std::time::Instant::now();
        let (endpoint, tunnel) = if profile.ssh.enabled {
            let tunnel = open_tunnel(&profile.ssh, &ssh_password, &profile.host, profile.port).await?;
            (
                Endpoint { host: "127.0.0.1".into(), port: tunnel.local_port },
                Some(tunnel),
            )
        } else {
            (Endpoint { host: profile.host.clone(), port: profile.port }, None)
        };

        let driver = LiveConnection::connect(&profile, &endpoint, &password)
            .await
            .map_err(|e| AppError::Driver(e.message))?;
        let latency = started.elapsed().as_millis() as u64;

        let entry = LiveEntry {
            driver: Arc::new(tokio::sync::Mutex::new(driver)),
            tunnel,
            profile: profile.clone(),
            password,
            endpoint,
            running: None,
            poisoned: false,
            latency_ms: Some(latency),
        };
        self.entries.lock().unwrap().insert(profile.id.clone(), entry);
        Ok(latency)
    }

    pub async fn disconnect(&self, id: &str) -> AppResult<()> {
        let entry = self.entries.lock().unwrap().remove(id);
        if let Some(mut entry) = entry {
            if let Some(h) = entry.running.take() {
                h.abort();
            }
            if let Some(tunnel) = entry.tunnel.take() {
                tunnel.shutdown().await;
            }
        }
        Ok(())
    }

    pub async fn disconnect_all(&self) {
        let ids = self.connected_ids();
        for id in ids {
            let _ = self.disconnect(&id).await;
        }
    }

    fn driver_handle(&self, id: &str) -> AppResult<Arc<tokio::sync::Mutex<LiveConnection>>> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .map(|e| Arc::clone(&e.driver))
            .ok_or_else(|| AppError::NotConnected(id.to_string()))
    }

    /// Reconnects the driver in place when a previous cancel poisoned it.
    async fn heal_if_poisoned(&self, id: &str) -> AppResult<()> {
        let needs = {
            let map = self.entries.lock().unwrap();
            map.get(id).map(|e| e.poisoned).unwrap_or(false)
        };
        if !needs {
            return Ok(());
        }
        let (driver_arc, profile, endpoint, password) = {
            let map = self.entries.lock().unwrap();
            let e = map.get(id).ok_or_else(|| AppError::NotConnected(id.to_string()))?;
            (Arc::clone(&e.driver), e.profile.clone(), e.endpoint.clone(), e.password.clone())
        };
        let fresh = LiveConnection::connect(&profile, &endpoint, &password)
            .await
            .map_err(|e| AppError::Driver(e.message))?;
        *driver_arc.lock().await = fresh;
        if let Some(e) = self.entries.lock().unwrap().get_mut(id) {
            e.poisoned = false;
        }
        Ok(())
    }

    /// Executes one statement with cancellation support.
    pub async fn exec_statement(
        &self,
        id: &str,
        sql: String,
    ) -> AppResult<Result<crate::drivers::types::StatementOutcome, QueryError>> {
        self.heal_if_poisoned(id).await?;
        let driver = self.driver_handle(id)?;
        let system = {
            let map = self.entries.lock().unwrap();
            map.get(id)
                .map(|e| e.profile.system.as_str())
                .unwrap_or("unknown")
        };

        let task = tokio::spawn(run_statement(driver, sql));
        // Register the abort handle so `cancel` can reach it.
        {
            let mut map = self.entries.lock().unwrap();
            if let Some(e) = map.get_mut(id) {
                e.running = Some(task.abort_handle());
            }
        }
        let joined = task.await;
        {
            let mut map = self.entries.lock().unwrap();
            if let Some(e) = map.get_mut(id) {
                e.running = None;
            }
        }
        match joined {
            Ok(res) => Ok(res),
            Err(join_err) if join_err.is_cancelled() => {
                // The connection may be mid-protocol — mark for reconnect.
                if let Some(e) = self.entries.lock().unwrap().get_mut(id) {
                    e.poisoned = true;
                }
                let mut qe = QueryError::new(system, "Query đã bị hủy", "cancelled by user");
                qe.code = Some("CANCELLED".into());
                Ok(Err(qe))
            }
            Err(join_err) => Err(AppError::Driver(join_err.to_string())),
        }
    }

    /// Aborts the statement currently running on this connection, if any.
    pub fn cancel(&self, id: &str) -> bool {
        let mut map = self.entries.lock().unwrap();
        if let Some(e) = map.get_mut(id) {
            if let Some(h) = e.running.take() {
                h.abort();
                return true;
            }
        }
        false
    }

    /// Runs an introspection closure against the live driver.
    pub async fn with_driver<T, F, Fut>(&self, id: &str, f: F) -> AppResult<Result<T, QueryError>>
    where
        F: FnOnce(Arc<tokio::sync::Mutex<LiveConnection>>) -> Fut,
        Fut: std::future::Future<Output = Result<T, QueryError>>,
    {
        self.heal_if_poisoned(id).await?;
        let driver = self.driver_handle(id)?;
        Ok(f(driver).await)
    }

    /// Pings the live connection (used by the status bar / reconnect banner).
    pub async fn ping(&self, id: &str) -> bool {
        let Ok(driver) = self.driver_handle(id) else {
            return false;
        };
        let mut d = driver.lock().await;
        d.ping().await
    }
}
