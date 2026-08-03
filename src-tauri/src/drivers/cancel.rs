//! Cooperative cancellation for the statement currently running on a connection.
//!
//! `AbortHandle::abort()` on its own cannot stop a statement. Aborting a tokio
//! task only takes effect at an `.await`, and for a large result the expensive
//! part — turning driver rows into `serde_json::Value` objects — is one *fully
//! synchronous* loop with no await points. A Cancel arriving there used to be
//! ignored until the whole result had been built (tens of seconds on a wide
//! million-row table), which is why Cancel looked like it did nothing.
//!
//! Drivers therefore read a task-local token inside their row loops and bail out
//! as soon as it is cancelled, which stops the work and frees the memory
//! immediately. The token is installed by the registry around the spawned
//! statement task (`scope`); paths that run outside that scope (introspection,
//! grid apply, …) simply see "not cancelled".

use tokio_util::sync::CancellationToken;

use crate::error::QueryError;

tokio::task_local! {
    static TOKEN: CancellationToken;
}

/// How often a row loop should call [`check`]. The atomic load is cheap but not
/// free, so amortise it over a batch of rows.
pub const CHECK_EVERY: usize = 512;

/// Runs `fut` with `token` visible to [`check`] anywhere below it on the stack.
pub async fn scope<F>(token: CancellationToken, fut: F) -> F::Output
where
    F: std::future::Future,
{
    TOKEN.scope(token, fut).await
}

/// True when the user cancelled the statement this task belongs to.
pub fn is_cancelled() -> bool {
    TOKEN.try_with(|t| t.is_cancelled()).unwrap_or(false)
}

/// The CANCELLED error, shaped exactly like the one the registry returns so the
/// frontend's `code === 'CANCELLED'` branch handles both identically.
pub fn cancelled_error(system: &str) -> QueryError {
    let mut qe = QueryError::new(system, "Query was cancelled", "cancelled by user");
    qe.code = Some("CANCELLED".into());
    qe
}

/// Bails out of a row-decoding loop when the user pressed Cancel.
pub fn check(system: &str) -> Result<(), QueryError> {
    if is_cancelled() {
        Err(cancelled_error(system))
    } else {
        Ok(())
    }
}

/// Called every [`CHECK_EVERY`] rows from a driver's decode loop. Bails out on
/// Cancel **and** hands the runtime back.
///
/// The yield is not cosmetic. Decoding a large result is a tight CPU + allocation
/// loop, and while it held its worker without ever awaiting, everything else was
/// delayed: a plain 1.2s timer measured 4.8s on an idle 8-core machine, and other
/// tabs' commands — `cancel_query` included — queued behind it. That is why one
/// tab's big query froze the rest of the app and Cancel appeared dead. Yielding
/// every few hundred rows keeps the runtime responsive and gives `abort()` an
/// await point to land on. Cost is negligible: a few thousand yields per million
/// rows.
pub async fn tick(system: &str) -> Result<(), QueryError> {
    check(system)?;
    tokio::task::yield_now().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_not_cancelled_outside_any_scope() {
        assert!(!is_cancelled());
        assert!(check("postgres").is_ok());
    }

    #[tokio::test]
    async fn sees_the_token_state_inside_the_scope() {
        let token = CancellationToken::new();
        scope(token.clone(), async {
            assert!(!is_cancelled());
            token.cancel();
            assert!(is_cancelled());
            let err = check("postgres").expect_err("must bail once cancelled");
            assert_eq!(err.code.as_deref(), Some("CANCELLED"));
        })
        .await;
    }
}
