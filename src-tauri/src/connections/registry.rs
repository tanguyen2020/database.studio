//! Live-connection registry: one entry per connected profile, owning the
//! driver, optional SSH tunnel, and the currently-running statement (for
//! cancellation). Cancel semantics (per approved plan): abort the in-flight
//! statement task, stop the multi-statement chain, and transparently
//! reconnect the (possibly desynced) connection before the next statement.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;

use crate::connections::profile::ConnectionProfile;
use crate::connections::tunnel::{open_tunnel, TunnelHandle};
use crate::drivers::{cancel, Endpoint, LiveConnection};
use crate::error::{AppError, AppResult, QueryError};

struct LiveEntry {
    driver: Arc<tokio::sync::Mutex<LiveConnection>>,
    tunnel: Option<TunnelHandle>,
    profile: ConnectionProfile,
    /// Plaintext kept in memory only, for reconnect after cancel/save-reconnect.
    password: String,
    endpoint: Endpoint,
    running: Option<AbortHandle>,
    /// Cooperative cancel signal for the statement (and its chunked delivery)
    /// currently in flight. `cancel` fires it so drivers stop mid-row-loop
    /// instead of only at the next `.await`.
    cancel: Option<CancellationToken>,
    /// Server-side session identifier (PG backend pid / MySQL connection id),
    /// used to cancel the query *on the server* — aborting the client task
    /// leaves the server happily producing rows.
    session_id: Option<String>,
    poisoned: bool,
    latency_ms: Option<u64>,
}

/// Statement that cancels the *currently running query* of `session_id` on the
/// server, issued over a separate short-lived connection. Only engines with a
/// query-scoped cancel are listed: killing a session outright (MSSQL `KILL`)
/// would roll back an open transaction, so those engines rely on the socket
/// being dropped by the post-cancel reconnect instead.
fn kill_statement(system: &str, session_id: &str) -> Option<String> {
    match system {
        "postgres" => Some(format!("SELECT pg_cancel_backend({session_id})")),
        "mysql" | "mariadb" => Some(format!("KILL QUERY {session_id}")),
        _ => None,
    }
}

/// Query that returns the connection's own server-side session id, for engines
/// where [`kill_statement`] can use it. `None` → no probe (no extra round trip).
fn session_id_query(system: &str) -> Option<&'static str> {
    match system {
        "postgres" => Some("SELECT pg_backend_pid()"),
        "mysql" | "mariadb" => Some("SELECT CONNECTION_ID()"),
        _ => None,
    }
}

/// Reads the session id right after connecting (best effort — a failure only
/// means Cancel falls back to dropping the socket).
async fn probe_session_id(driver: &mut LiveConnection, system: &str) -> Option<String> {
    let sql = session_id_query(system)?;
    let outcome = driver.exec(sql).await.ok()?;
    let crate::drivers::types::StatementOutcome::Rows { result } = outcome else {
        return None;
    };
    let first = result.rows.first()?;
    let value = first.as_object()?.values().next()?;
    let id = match value {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        _ => return None,
    };
    // Guard against anything that isn't a plain integer — it goes into SQL text.
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
        Some(id)
    } else {
        None
    }
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

/// Same, with the cooperative cancel token installed for the whole statement so
/// driver row loops can bail out mid-decode.
async fn run_statement_cancellable(
    driver: Arc<tokio::sync::Mutex<LiveConnection>>,
    sql: String,
    token: CancellationToken,
) -> Result<crate::drivers::types::StatementOutcome, QueryError> {
    cancel::scope(token, run_statement(driver, sql)).await
}

/// True when an error message indicates the underlying socket was closed by the
/// server (idle timeout, restart, NAT/firewall drop, dropped SSH tunnel) rather
/// than a legitimate SQL error. Such a connection is dead and must be
/// reconnected before the statement can succeed.
///
/// Two families have to be covered, and only the first one used to be:
///   * **wire-level** errors from the socket itself (sqlx/tiberius report the
///     I/O failure: "expected to read N bytes, got 0 bytes at EOF",
///     "connection reset", Windows WSAECONNRESET 10054, …);
///   * **server-reported** disconnects, which arrive as a perfectly ordinary
///     database error and therefore look like a SQL failure. This is what an
///     idle tab hits in practice: MySQL answers a statement on a connection it
///     already reaped with 4031 "The client was disconnected by the server
///     because of inactivity" or 2006 "MySQL server has gone away", and Oracle
///     with ORA-02396 / ORA-03113. Missing those is why "run again after a long
///     pause" surfaced a raw, unrecoverable error instead of self-healing.
fn is_connection_lost(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    lost_before_send(&m) || lost_mid_statement(&m)
}

/// Dropped while the statement was in flight: recoverable, but not safely
/// repeatable for a write (see `exec_statement`). Takes a lowercased message.
fn lost_mid_statement(m: &str) -> bool {
    m.contains("lost connection")
        || m.contains("during query")
        || m.contains("ora-03113") // end-of-file on communication channel
        || m.contains("end-of-file on communication channel")
        || m.contains("communication link failure")
        || m.contains("transport error")
}

/// SQLSTATEs that mean *the server is closing this session*. PostgreSQL reports
/// these as an ordinary database error — with a SQLSTATE and a message — just
/// before it drops the socket, so a killed or idle-timed-out session never looks
/// like an I/O failure at all. The session is gone and whatever was running was
/// rolled back with it, which makes re-running safe.
fn lost_by_sqlstate(code: Option<&str>) -> bool {
    let Some(c) = code else { return false };
    let c = c.to_ascii_uppercase();
    c.starts_with("08")   // class 08 — connection exception
        || c == "57P01"   // admin shutdown: pg_terminate_backend, server restart
        || c == "57P02"   // crash shutdown
        || c == "57P03"   // cannot connect now (server still starting)
        || c == "57P05"   // idle_session_timeout — the idle-tab case
        || c == "25P03"   // idle-in-transaction session timeout
}

/// What a failed statement says about the connection underneath it.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Loss {
    /// A genuine SQL failure — the connection is fine.
    None,
    /// The connection was already gone when the statement was sent (or the
    /// server killed the session and rolled it back). Re-running is safe.
    BeforeSend,
    /// It died mid-flight: the server may already have applied the statement.
    MidStatement,
}

fn classify_loss(qe: &QueryError) -> Loss {
    let m = qe.message.to_ascii_lowercase();
    if lost_before_send(&m) || lost_by_sqlstate(qe.code.as_deref()) {
        Loss::BeforeSend
    } else if lost_mid_statement(&m) {
        Loss::MidStatement
    } else {
        Loss::None
    }
}

/// Subset of [`is_connection_lost`]: signals that the connection was **already
/// dead before the statement could reach the server**. Re-running the statement
/// after reconnecting therefore cannot apply a write twice.
///
/// Takes an already-lowercased message.
fn lost_before_send(m: &str) -> bool {
    m.contains("bytes at eof")
        || m.contains("expected to read")
        || m.contains("connection reset")
        || m.contains("broken pipe")
        || m.contains("connection closed")
        || m.contains("connection was closed")
        || m.contains("connection is closed")
        || m.contains("server closed the connection")
        || m.contains("no connection to the server")
        || m.contains("unexpected end of file")
        || m.contains("10054") // WSAECONNRESET
        || m.contains("10053") // WSAECONNABORTED
        || m.contains("os error 104") // ECONNRESET
        || m.contains("os error 32") // EPIPE
        // MySQL / MariaDB reap an idle connection and say so on the next use.
        || m.contains("server has gone away")
        || m.contains("disconnected by the server because of inactivity")
        // PostgreSQL says goodbye in words before closing the socket
        // (57P01 admin shutdown, 57P05 idle_session_timeout, shutdown/restart).
        || m.contains("terminating connection due to")
        || m.contains("database system is shutting down")
        // Oracle: idle-time profile limit, session killed, no longer logged on.
        || m.contains("ora-02396")
        || m.contains("ora-03114")
        || m.contains("ora-00028")
        || m.contains("ora-01012")
        || m.contains("dpi-1080")
}

/// Statements with no side effects, which are safe to re-run after *any* kind of
/// connection loss — including one that happened mid-statement, where we cannot
/// know whether the server had already applied it.
fn is_read_only(sql: &str) -> bool {
    matches!(
        crate::drivers::util::leading_verb(sql).as_str(),
        "SELECT" | "SHOW" | "EXPLAIN" | "DESCRIBE" | "DESC" | "PRAGMA"
    )
}

/// The error the UI gets when a connection is gone and could not be healed
/// behind the user's back. Carries the `CONNECTION_LOST` code so the frontend
/// can mark the connection closed and offer Reconnect, instead of showing a raw
/// wire message next to a still-green "connected" dot.
pub fn connection_lost_error(system: &str, raw: &str, mid_statement: bool) -> QueryError {
    let message = if mid_statement {
        "Connection lost while the statement was running — it may or may not have been applied. \
         Reconnect, check the data, then run it again."
    } else {
        "Connection lost — the server closed it (idle timeout, restart, or a dropped network/SSH \
         tunnel). Reconnect, then run again."
    };
    let mut qe = QueryError::new(system, message, raw);
    qe.code = Some("CONNECTION_LOST".into());
    qe
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
        // Already connected → no-op (idempotent) — but only if the socket is
        // actually alive. A registry entry outlives the connection the server
        // reaped underneath it, and returning that stale entry made "Reconnect"
        // a silent no-op that reported success while every statement kept
        // failing. Ping first; a dead entry is rebuilt in place.
        if self.is_connected(&profile.id) {
            if self.ping(&profile.id).await {
                return Ok(self.latency(&profile.id).unwrap_or(0));
            }
            let started = std::time::Instant::now();
            self.reconnect(&profile.id).await?;
            let latency = started.elapsed().as_millis() as u64;
            // Per-database (`{id}::db`) and per-tab (`{id}#tab-…`) connections
            // were dropped by the same idle timeout / restart; forget them so the
            // next use opens a fresh one instead of reviving a dead id.
            self.drop_derived(&profile.id).await;
            if let Some(e) = self.entries.lock().unwrap().get_mut(&profile.id) {
                e.latency_ms = Some(latency);
            }
            return Ok(latency);
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

        let mut driver = LiveConnection::connect(&profile, &endpoint, &password)
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
        let session_id = probe_session_id(&mut driver, profile.system.as_str()).await;

        let entry = LiveEntry {
            driver: Arc::new(tokio::sync::Mutex::new(driver)),
            tunnel,
            profile: profile.clone(),
            password,
            endpoint,
            running: None,
            cancel: None,
            session_id,
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

    /// Drops the connections derived from a base one: per-database
    /// (`{id}::db`, attach_database) and per-tab (`{id}#tab-…`) sockets. They
    /// share the base's fate — an idle timeout or a server restart kills them
    /// all — so they must not survive the base being rebuilt.
    pub async fn drop_derived(&self, id: &str) {
        let db_prefix = format!("{id}::");
        let tab_prefix = format!("{id}#");
        let derived: Vec<String> = self
            .connected_ids()
            .into_iter()
            .filter(|c| c.starts_with(&db_prefix) || c.starts_with(&tab_prefix))
            .collect();
        for sub in derived {
            let _ = self.disconnect(&sub).await;
        }
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
        let mut fresh = LiveConnection::connect(&profile, &endpoint, &password)
            .await
            .map_err(|e| AppError::Driver(e.message))?;
        let session_id = probe_session_id(&mut fresh, profile.system.as_str()).await;
        // Replacing the driver drops the old connection, which closes its socket.
        // That is also what makes the server abandon whatever it was still doing
        // for us on engines without a query-scoped cancel statement.
        *driver_arc.lock().await = fresh;
        if let Some(e) = self.entries.lock().unwrap().get_mut(id) {
            e.poisoned = false;
            e.session_id = session_id;
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
    /// connection is transparently reconnected and the statement retried once,
    /// so the common "came back to a tab hours later and pressed Run" case just
    /// works.
    ///
    /// The retry is deliberately not unconditional. It is safe when the
    /// connection was already dead before the statement was sent
    /// ([`lost_before_send`]) — the server never saw it — or when the statement
    /// has no side effects ([`is_read_only`]). A write that died *mid-flight*
    /// may already have been applied, so it is reported instead of silently
    /// replayed.
    ///
    /// Anything that cannot be healed comes back as `CONNECTION_LOST`, which the
    /// UI turns into a "Reconnect" affordance rather than a cryptic wire error.
    pub async fn exec_statement(
        &self,
        id: &str,
        sql: String,
    ) -> AppResult<Result<crate::drivers::types::StatementOutcome, QueryError>> {
        self.heal_if_poisoned(id).await?;
        let first = self.run_tracked(id, sql.clone()).await?;
        let Err(qe) = &first else { return Ok(first) };
        // A user cancellation poisons the connection on purpose (handled above).
        let loss = classify_loss(qe);
        if qe.code.as_deref() == Some("CANCELLED") || loss == Loss::None {
            return Ok(first);
        }

        let system = self.system_of(id).unwrap_or_else(|| "unknown".into());
        let raw = qe.message.clone();
        let mid_statement = loss == Loss::MidStatement;
        if (!mid_statement || is_read_only(&sql)) && self.reconnect(id).await.is_ok() {
            let second = self.run_tracked(id, sql).await?;
            return match &second {
                // Still dead after a fresh connection: the server/tunnel is down,
                // not just this socket. Say so plainly.
                Err(qe2) if classify_loss(qe2) != Loss::None => {
                    let raw2 = qe2.message.clone();
                    self.poison(id);
                    Ok(Err(connection_lost_error(&system, &raw2, false)))
                }
                _ => Ok(second),
            };
        }
        // Not retried (a write of unknown outcome), or the reconnect failed:
        // leave it poisoned so the next use reconnects first.
        self.poison(id);
        Ok(Err(connection_lost_error(&system, &raw, mid_statement)))
    }

    /// Runs one statement on the live connection with cancellation tracking.
    /// A cancel aborts the task, poisons the connection (mid-protocol) and
    /// returns a CANCELLED QueryError.
    ///
    /// The wait is on the cancel token as well as on the task: a task stuck in a
    /// synchronous section (building JSON out of a million rows) cannot be
    /// aborted at once, and the caller must not be kept waiting for it. Once the
    /// token fires we return CANCELLED immediately and let the orphaned task
    /// unwind on its own — it observes the same token and drops its partial
    /// result within a few hundred rows.
    async fn run_tracked(
        &self,
        id: &str,
        sql: String,
    ) -> AppResult<Result<crate::drivers::types::StatementOutcome, QueryError>> {
        let driver = self.driver_handle(id)?;
        let (system, armed) = {
            let map = self.entries.lock().unwrap();
            match map.get(id) {
                Some(e) => (e.profile.system.as_str(), e.cancel.clone()),
                None => ("unknown", None),
            }
        };
        // A run armed by the caller (`arm_cancel`, editor path) owns the token's
        // lifetime — it also covers chunked delivery after this returns. Anything
        // else gets a fresh token that only lives for this statement.
        let token = armed.clone().unwrap_or_default();

        let mut task = tokio::spawn(run_statement_cancellable(driver, sql, token.clone()));
        // Register the abort handle so `cancel` can reach it.
        {
            let mut map = self.entries.lock().unwrap();
            if let Some(e) = map.get_mut(id) {
                e.running = Some(task.abort_handle());
                if armed.is_none() {
                    e.cancel = Some(token.clone());
                }
            }
        }
        let joined = tokio::select! {
            joined = &mut task => Some(joined),
            _ = token.cancelled() => {
                task.abort();
                None
            }
        };
        {
            let mut map = self.entries.lock().unwrap();
            if let Some(e) = map.get_mut(id) {
                e.running = None;
                if armed.is_none() {
                    e.cancel = None;
                }
            }
        }
        let cancelled = || {
            // The connection may be mid-protocol — mark for reconnect.
            self.poison(id);
            Ok(Err(cancel::cancelled_error(system)))
        };
        match joined {
            None => cancelled(),
            Some(Ok(res)) => Ok(res),
            Some(Err(join_err)) if join_err.is_cancelled() => cancelled(),
            Some(Err(join_err)) => Err(AppError::Driver(join_err.to_string())),
        }
    }

    /// Arms cancellation for one editor run and returns its token. The token
    /// stays armed until [`disarm_cancel`], so it covers both the statement and
    /// the chunked delivery of its rows to the frontend.
    pub fn arm_cancel(&self, id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        if let Some(e) = self.entries.lock().unwrap().get_mut(id) {
            e.cancel = Some(token.clone());
        }
        token
    }

    /// Releases the token armed by [`arm_cancel`] (end of the run).
    pub fn disarm_cancel(&self, id: &str) {
        if let Some(e) = self.entries.lock().unwrap().get_mut(id) {
            e.cancel = None;
        }
    }

    /// Stops the statement currently running on this connection, if any.
    ///
    /// Three things have to happen for a Cancel to actually stop work, and the
    /// old implementation only did the first:
    ///   1. abort the client task (only lands at an `.await`),
    ///   2. fire the cooperative token so driver row loops bail out and the
    ///      caller stops waiting,
    ///   3. tell the *server* to stop, with a query-scoped cancel statement
    ///      issued over a second connection (`kill_statement`). Engines without
    ///      one stop when the poisoned connection is reconnected (its socket is
    ///      dropped) on the next statement.
    pub fn cancel(&self, id: &str) -> bool {
        let kill = {
            let mut map = self.entries.lock().unwrap();
            let Some(e) = map.get_mut(id) else { return false };
            let was_running = e.running.take().map(|h| h.abort()).is_some();
            let token_fired = match e.cancel.take() {
                Some(t) => {
                    t.cancel();
                    true
                }
                None => false,
            };
            if !was_running && !token_fired {
                return false;
            }
            if !was_running {
                // Only the armed token fired: the statement itself already
                // finished and we are cancelling the delivery of its rows. The
                // connection is clean — nothing to poison, nothing to kill.
                return true;
            }
            // Mid-protocol from here on: the next statement must reconnect.
            e.poisoned = true;
            let stmt = e
                .session_id
                .as_deref()
                .and_then(|sid| kill_statement(e.profile.system.as_str(), sid));
            (stmt, e.profile.clone(), e.endpoint.clone(), e.password.clone())
        };

        let (stmt, profile, endpoint, password) = kill;
        if let Some(sql) = stmt {
            // Detached: Cancel must return to the UI immediately, and opening the
            // side connection must not hold it up.
            tokio::spawn(async move {
                // A separate connection is required — the one running the query
                // cannot answer until that query is done.
                let side = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    LiveConnection::connect(&profile, &endpoint, &password),
                )
                .await;
                if let Ok(Ok(mut conn)) = side {
                    let _ =
                        tokio::time::timeout(std::time::Duration::from_secs(10), conn.exec(&sql))
                            .await;
                }
            });
        }
        true
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
        // then succeeds instead of failing forever on a dead connection. The
        // error is re-typed as CONNECTION_LOST so the UI offers Reconnect here
        // too (introspection after an idle pause hits exactly this path).
        match res {
            Err(qe) if classify_loss(&qe) != Loss::None => {
                self.poison(id);
                let system = self.system_of(id).unwrap_or_else(|| qe.system.clone());
                Ok(Err(connection_lost_error(&system, &qe.message, false)))
            }
            other => Ok(other),
        }
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
    use super::{
        classify_loss, connection_lost_error, is_connection_lost, is_read_only, kill_statement,
        lost_before_send, session_id_query, Loss,
    };
    use crate::error::QueryError;

    fn err(code: Option<&str>, message: &str) -> QueryError {
        let mut qe = QueryError::new("postgres", message, message);
        qe.code = code.map(|c| c.to_string());
        qe
    }

    #[test]
    fn cancels_the_query_not_the_session_where_possible() {
        // Query-scoped cancel: the session (and any open transaction) survives.
        assert_eq!(
            kill_statement("postgres", "4711").as_deref(),
            Some("SELECT pg_cancel_backend(4711)")
        );
        assert_eq!(kill_statement("mysql", "12").as_deref(), Some("KILL QUERY 12"));
        assert_eq!(kill_statement("mariadb", "12").as_deref(), Some("KILL QUERY 12"));
    }

    #[test]
    fn no_kill_statement_for_engines_without_a_query_scoped_cancel() {
        // These stop when the poisoned connection is reconnected (socket dropped);
        // MSSQL's `KILL` would take the whole session, transaction included.
        for system in ["mssql", "sqlite", "clickhouse", "oracle", "cassandra", "mongodb", "redis"] {
            assert!(kill_statement(system, "1").is_none(), "{system} must not be killed");
            assert!(session_id_query(system).is_none(), "{system} must not be probed");
        }
    }

    #[test]
    fn probes_a_session_id_only_where_it_is_used() {
        assert_eq!(session_id_query("postgres"), Some("SELECT pg_backend_pid()"));
        assert_eq!(session_id_query("mysql"), Some("SELECT CONNECTION_ID()"));
        assert_eq!(session_id_query("mariadb"), Some("SELECT CONNECTION_ID()"));
    }

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

    #[test]
    fn detects_the_disconnect_the_server_reports_as_a_plain_error() {
        // The idle-tab case: the server reaped the connection and answers the
        // next statement with an ordinary database error, not an I/O failure.
        // Missing these is what left the editor with an unrecoverable error
        // while the connection list still showed a green dot.
        for msg in [
            "The client was disconnected by the server because of inactivity. See wait_timeout \
             and interactive_timeout for configuring this behavior.",
            "MySQL server has gone away",
            "ORA-02396: exceeded maximum idle time, please connect again",
            "ORA-03114: not connected to ORACLE",
            "ORA-00028: your session has been killed",
            "DPI-1080: connection was closed by ORA-3113",
        ] {
            assert!(is_connection_lost(msg), "must be recognised: {msg}");
            // Dead before the statement was sent → replaying it is safe.
            assert!(lost_before_send(&msg.to_ascii_lowercase()), "must be safe to retry: {msg}");
        }
    }

    #[test]
    fn a_mid_statement_drop_is_recoverable_but_not_replayable() {
        // The server may already have applied the statement, so a write must be
        // reported rather than silently re-run (`exec_statement`).
        for msg in [
            "Lost connection to MySQL server during query",
            "ORA-03113: end-of-file on communication channel",
            "Communication link failure",
        ] {
            assert!(is_connection_lost(msg), "must be recognised: {msg}");
            assert!(!lost_before_send(&msg.to_ascii_lowercase()), "must not be replayed: {msg}");
        }
    }

    #[test]
    fn only_side_effect_free_statements_are_replayable_after_a_mid_query_drop() {
        assert!(is_read_only("SELECT * FROM students"));
        assert!(is_read_only("  -- comment\n  select 1"));
        assert!(is_read_only("SHOW TABLES"));
        assert!(is_read_only("EXPLAIN SELECT 1"));
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "CALL p_charge_customer(1)",
            "WITH x AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM x",
            "CREATE TABLE t (id int)",
        ] {
            assert!(!is_read_only(sql), "must not be replayed: {sql}");
        }
    }

    #[test]
    fn detects_the_session_the_server_terminates_with_a_sqlstate() {
        // PostgreSQL kills a session (pg_terminate_backend, restart,
        // idle_session_timeout) by sending a normal database error first — the
        // socket error never arrives. Found by the integration test: without
        // this the statement failed with a raw 57P01 instead of self-healing.
        for (code, msg) in [
            ("57P01", "terminating connection due to administrator command"),
            ("57P05", "terminating connection due to idle-session timeout"),
            ("25P03", "terminating connection due to idle-in-transaction session timeout"),
            ("08006", "connection failure"),
            ("08003", "connection does not exist"),
        ] {
            // The session is gone and its work was rolled back → safe to re-run.
            assert_eq!(classify_loss(&err(Some(code), msg)), Loss::BeforeSend, "{code}");
        }
        // The message alone is enough when the driver reports no SQLSTATE.
        assert_eq!(
            classify_loss(&err(None, "terminating connection due to administrator command")),
            Loss::BeforeSend
        );
    }

    #[test]
    fn classifies_a_plain_sql_error_as_no_loss() {
        assert_eq!(classify_loss(&err(Some("42P01"), "relation \"foo\" does not exist")), Loss::None);
        assert_eq!(classify_loss(&err(Some("23505"), "duplicate key value")), Loss::None);
        assert_eq!(
            classify_loss(&err(Some("HY000"), "Lost connection to MySQL server during query")),
            Loss::MidStatement
        );
    }

    #[test]
    fn connection_lost_error_is_typed_and_keeps_the_wire_text() {
        let qe = connection_lost_error("postgres", "expected to read 5 bytes, got 0 bytes at EOF", false);
        assert_eq!(qe.code.as_deref(), Some("CONNECTION_LOST"));
        assert!(qe.message.contains("Reconnect"), "{}", qe.message);
        assert!(qe.raw.contains("0 bytes at EOF"));
        // A write that died mid-flight says so instead of implying nothing ran.
        let mid = connection_lost_error("mysql", "Lost connection during query", true);
        assert!(mid.message.contains("may or may not have been applied"), "{}", mid.message);
    }
}
