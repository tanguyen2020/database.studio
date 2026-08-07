// Recognising "this connection is gone" on the frontend.
//
// The backend types the recoverable-connection case as a QueryError with
// `code: 'CONNECTION_LOST'` (registry.rs), which is the reliable signal. But not
// every failure arrives as a QueryError: a command can reject outright with an
// AppError string (`not connected: c1#tab-3`) before any statement runs, and
// paths that predate the typed error still surface the raw wire text. Both mean
// the same thing to the user — the connection must be reopened — so both must
// flip the UI into its "Disconnected · Reconnect" state instead of leaving a
// green dot next to a failing tab.

/** Wire/server messages that mean the socket is dead. Kept deliberately narrow:
 *  a false positive would mark a healthy connection closed. Mirrors
 *  `is_connection_lost` in src-tauri/src/connections/registry.rs. */
const LOST_PATTERNS = [
  'connection_lost',
  'not connected',
  'connection lost',
  'connection reset',
  'connection closed',
  'connection is closed',
  'connection was closed',
  'broken pipe',
  'bytes at eof',
  'server closed the connection',
  'server has gone away',
  'disconnected by the server because of inactivity',
  'end-of-file on communication channel',
  'communication link failure',
]

/** Shape of the pieces of a QueryError this check needs. */
export interface LostCandidate {
  code?: string | null
  message?: string | null
}

/** True when an error means the connection died (idle timeout, server restart,
 *  dropped network/SSH tunnel) rather than the statement being wrong.
 *  Accepts a QueryError-ish object or the string form of a thrown IPC error. */
export function isConnectionLost(err: LostCandidate | string | null | undefined): boolean {
  if (!err) return false
  if (typeof err !== 'string' && err.code === 'CONNECTION_LOST') return true
  const text = (typeof err === 'string' ? err : (err.message ?? '')).toLowerCase()
  if (!text) return false
  return LOST_PATTERNS.some((p) => text.includes(p))
}

/** Short reason shown on the connection row / Explorer, next to Reconnect. */
export function lostReason(err: LostCandidate | string | null | undefined): string {
  const text = typeof err === 'string' ? err : (err?.message ?? '')
  return text.trim() || 'Connection lost'
}
