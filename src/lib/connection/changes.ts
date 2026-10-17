// Did an edit change WHERE / HOW a connection connects? Then everything the app
// cached from the old session (the Explorer tree: schemas, tables, databases…)
// describes a different server/database and must be re-read. Name, group and
// environment are labels only — renaming must not throw the tree away.
import type { ConnectionProfile } from '$lib/types'

/** Fields that never affect the session itself. */
export const COSMETIC_KEYS = new Set<string>(['id', 'name', 'group', 'env'])

/** Keys present on a profile returned by the backend but not part of the saved
 *  configuration (live state / client-only flags). */
const LIVE_KEYS = new Set<string>(['has_password', 'connected', 'latency_ms', 'ephemeral'])

/** True when `after` connects differently from `before`. Every config key counts
 *  (engine-specific ones included — Kafka SASL, Cassandra DC, SSH, TLS…), so a new
 *  field is covered without touching this list; only labels are ignored. A typed
 *  password (or SSH password) always counts: it changes who we log in as. */
export function connectionChanged(
  before: Partial<ConnectionProfile> | null | undefined,
  after: Partial<ConnectionProfile>,
  opts: { password?: string | null; sshPassword?: string | null } = {},
): boolean {
  if (!before) return false
  if (opts.password != null || opts.sshPassword != null) return true
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const k of keys) {
    if (COSMETIC_KEYS.has(k) || LIVE_KEYS.has(k)) continue
    const a = (before as Record<string, unknown>)[k]
    const b = (after as Record<string, unknown>)[k]
    if (a === undefined && b === undefined) continue
    // one side missing a key the other has at its empty default is not a change
    if ((a === undefined || b === undefined) && isEmptyValue(a ?? b)) continue
    if (JSON.stringify(a) !== JSON.stringify(b)) return true
  }
  return false
}

function isEmptyValue(v: unknown): boolean {
  return v === '' || v === null || v === false || v === 0
}
