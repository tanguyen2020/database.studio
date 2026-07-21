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

/// True when an error message indicates the underlying socket was closed by the
/// server (idle timeout, restart, NAT/firewall drop, dropped SSH tunnel) rather
/// than a legitimate SQL error. Such a connection is dead and must be
/// reconnected before the statement can succeed. Matches the sqlx/tiberius/etc.
/// wire-level messages ("expected to read N bytes, got 0 bytes at EOF",
/// "connection reset", Windows WSAECONNRESET 10054, …).
fn is_connection_lost(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("bytes at eof")
        || m.contains("expected to read")
        || m.contains("connection reset")
        || m.contains("broken pipe")
        || m.contains("connection closed")
        || m.contains("connection was closed")
        || m.contains("connection is closed")
        || m.contains("server closed the connection")
        || m.contains("unexpected end of file")
        || m.contains("10054") // WSAECONNRESET
        || m.contains("10053") // WSAECONNABORTED
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

    /// System (engine) of a live connection — works for sub-connections
    /// (`{base}::{db}`) and ephemeral/quick connects that aren't in storage.
    pub fn system_of(&self, id: &str) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .map(|e| e.profile.system.as_str().to_string())
    }

    /// Profile + plaintext password of a live connection (for "open database" on
    /// ephemeral connections that aren't in storage). SSH password isn't retained.
    pub fn live_credentials(&self, id: &str) -> Result<(ConnectionProfile, String), AppError> {
        let entries = self.entries.lock().unwrap();
        let e = entries
            .get(id)
            .ok_or_else(|| AppError::Driver("Connection is not open".into()))?;
        Ok((e.profile.clone(), e.password.clone()))
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
            // Kafka: run the tunnel as a metadata-rewriting proxy so librdkafka's
            // post-bootstrap reconnects (to advertised.listeners) loop back
            // through this tunnel instead of dialing an unreachable address.
            let kafka = profile.system.as_str() == "kafka";
            let tunnel =
                open_tunnel(&profile.ssh, &ssh_password, &profile.host, profile.port, kafka).await?;
            (
                Endpoint { host: "127.0.0.1".into(), port: tunnel.local_port },
                Some(tunnel),
            )
        } else {
            (Endpoint { host: profile.host.clone(), port: profile.port }, None)
        };

        let driver = LiveConnection::connect(&profile, &endpoint, &password)
            .await
            .map_err(|e| {
                let mut msg = e.message;
                // Kafka over an SSH tunnel: the bootstrap connection is forwarded,
                // but librdkafka then dials the broker's advertised.listeners
                // DIRECTLY (bypassing the tunnel). If that address isn't reachable
                // from this machine, connect/metadata fails. Make the cause explicit.
                if profile.system.as_str() == "kafka" && profile.ssh.enabled {
                    msg.push_str(
                        "\n\nKafka over SSH tunnel: this app already rewrites the broker's advertised.listeners to route \
                         through the tunnel, so no server-side advertised.listeners change is needed. A failure here usually \
                         means one of: (1) the SSH server itself can't reach the broker at the host:port you entered — verify \
                         with `nc -zv <host> <port>` ON the SSH server; (2) the broker needs SASL/SSL that isn't configured; \
                         or (3) it's a multi-broker cluster (the rewrite currently supports a single broker).",
                    );
                }
                AppError::Driver(msg)
            })?;
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

    /// Reconnects the driver in place (same profile/endpoint/password) and
    /// clears the poisoned flag. Used to heal a connection that a cancel left
    /// mid-protocol, or that the server closed underneath us.
    async fn reconnect(&self, id: &str) -> AppResult<()> {
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

    /// Reconnects the driver in place when a previous cancel poisoned it.
    async fn heal_if_poisoned(&self, id: &str) -> AppResult<()> {
        let needs = {
            let map = self.entries.lock().unwrap();
            map.get(id).map(|e| e.poisoned).unwrap_or(false)
        };
        if !needs {
            return Ok(());
        }
        self.reconnect(id).await
    }

    /// Marks a connection for reconnect on its next use.
    fn poison(&self, id: &str) {
        if let Some(e) = self.entries.lock().unwrap().get_mut(id) {
            e.poisoned = true;
        }
    }

    /// Executes one statement with cancellation support.
    ///
    /// If the statement fails because the server closed the connection (idle
    /// timeout / restart / dropped tunnel — see `is_connection_lost`), the dead
    /// connection is transparently reconnected and the statement retried once.
    /// An idle connection the server dropped never received the statement, so
    /// the single retry cannot double-apply a write.
    pub async fn exec_statement(
        &self,
        id: &str,
        sql: String,
    ) -> AppResult<Result<crate::drivers::types::StatementOutcome, QueryError>> {
        self.heal_if_poisoned(id).await?;
        let first = self.run_tracked(id, sql.clone()).await?;
        if let Err(qe) = &first {
            // Do not retry a user cancellation (poisoned + handled above).
            if qe.code.as_deref() != Some("CANCELLED") && is_connection_lost(&qe.message) {
                if self.reconnect(id).await.is_ok() {
                    return self.run_tracked(id, sql).await;
                }
                // Reconnect failed — leave it poisoned so the next use retries.
                self.poison(id);
            }
        }
        Ok(first)
    }

    /// Runs one statement on the live connection with cancellation tracking.
    /// A cancel aborts the task, poisons the connection (mid-protocol) and
    /// returns a CANCELLED QueryError.
    async fn run_tracked(
        &self,
        id: &str,
        sql: String,
    ) -> AppResult<Result<crate::drivers::types::StatementOutcome, QueryError>> {
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
                self.poison(id);
                let mut qe = QueryError::new(system, "Query was cancelled", "cancelled by user");
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
        let res = f(driver).await;
        // The closure is FnOnce (can't retry in place), but if the socket died
        // we poison the connection so the next call reconnects first — a Refresh
        // then succeeds instead of failing forever on a dead connection.
        if let Err(qe) = &res {
            if is_connection_lost(&qe.message) {
                self.poison(id);
            }
        }
        Ok(res)
    }

    /// Params để mở connection Redis phụ (pub/sub) — lấy endpoint/password/db/ssl
    /// từ live entry. Dùng endpoint (đã qua tunnel nếu có).
    pub fn redis_params(&self, id: &str) -> AppResult<crate::drivers::redis::RedisConnParams> {
        let map = self.entries.lock().unwrap();
        let e = map
            .get(id)
            .ok_or_else(|| AppError::Driver("Connection does not exist / not connected".into()))?;
        Ok(crate::drivers::redis::RedisConnParams {
            host: e.endpoint.host.clone(),
            port: e.endpoint.port,
            password: e.password.clone(),
            db: e.profile.database.trim().parse::<i64>().unwrap_or(0),
            ssl: e.profile.ssl,
            ssl_ca: e.profile.ssl_ca.clone(),
        })
    }

    /// Schema Registry endpoint + basic auth cho một Kafka connection. Lấy
    /// `schema_registry_url` từ profile; user/password tái dùng SASL creds.
    pub fn schema_registry_params(
        &self,
        id: &str,
    ) -> AppResult<crate::drivers::schema_registry::SchemaRegistryParams> {
        let map = self.entries.lock().unwrap();
        let e = map
            .get(id)
            .ok_or_else(|| AppError::Driver("Connection does not exist / not connected".into()))?;
        let base_url = e.profile.schema_registry_url.trim().to_string();
        if base_url.is_empty() {
            return Err(AppError::Driver(
                "Connection has no Schema Registry URL configured".into(),
            ));
        }
        Ok(crate::drivers::schema_registry::SchemaRegistryParams {
            base_url,
            user: e.profile.user.clone(),
            password: e.password.clone(),
        })
    }

    /// Clone NATS client của live connection (client multiplexed, dùng cho
    /// subscribe stream ở task nền độc lập với lock của registry).
    pub async fn nats_client(&self, id: &str) -> AppResult<async_nats::Client> {
        let driver = self.driver_handle(id)?;
        let d = driver.lock().await;
        match &*d {
            LiveConnection::Nats(n) => Ok(n.client()),
            _ => Err(AppError::Driver("Connection is not NATS".into())),
        }
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

#[cfg(test)]
mod tests {
    use super::is_connection_lost;

    #[test]
    fn detects_server_dropped_connection() {
        // The exact message from the reported bug (PostgreSQL 5-byte header).
        assert!(is_connection_lost(
            "error communicating with database: expected to read 5 bytes, got 0 bytes at EOF"
        ));
        assert!(is_connection_lost("Connection reset by peer"));
        assert!(is_connection_lost("broken pipe"));
        assert!(is_connection_lost("server closed the connection unexpectedly"));
        assert!(is_connection_lost("Os { code: 10054, kind: ConnectionReset }".into()));
    }

    #[test]
    fn ignores_real_sql_errors() {
        assert!(!is_connection_lost("relation \"foo\" does not exist"));
        assert!(!is_connection_lost("syntax error at or near \"slect\""));
        assert!(!is_connection_lost("permission denied for table students"));
        assert!(!is_connection_lost("duplicate key value violates unique constraint"));
    }
}
