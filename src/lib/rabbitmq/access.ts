// RabbitMQ access management helpers (users · permissions · policies). Pure — the
// User Manager UI and its unit tests share them.

import type { RabbitPermission } from '$lib/ipc'

/** Built-in user tags and what each one unlocks in the management API / UI. */
export const KNOWN_TAGS: { tag: string; hint: string }[] = [
  { tag: 'administrator', hint: 'Everything: users, vhosts, permissions, policies' },
  { tag: 'monitoring', hint: 'Read every vhost, connection and node metric' },
  { tag: 'policymaker', hint: 'Manage policies and parameters in its vhosts' },
  { tag: 'management', hint: 'Use the management API for its own vhosts' },
  { tag: 'impersonator', hint: 'Publish with a user-id other than its own' },
]

export type PermissionPresetKey = 'full' | 'read-only' | 'publish-only' | 'custom'

/** Permission presets. Each field is a regex over resource names; `^$` matches
 *  nothing. configure = declare/delete, write = publish/bind into, read = consume. */
export const PERMISSION_PRESETS: { key: Exclude<PermissionPresetKey, 'custom'>; label: string; hint: string; configure: string; write: string; read: string }[] = [
  { key: 'full', label: 'Full access', hint: 'Declare, publish and consume anything', configure: '.*', write: '.*', read: '.*' },
  { key: 'read-only', label: 'Read only', hint: 'Consume from any queue; no publishing, no declaring', configure: '^$', write: '^$', read: '.*' },
  { key: 'publish-only', label: 'Publish only', hint: 'Publish to any exchange; no consuming, no declaring', configure: '^$', write: '.*', read: '^$' },
]

/** Which preset a permission matches, or 'custom'. */
export function presetOf(p: Pick<RabbitPermission, 'configure' | 'write' | 'read'>): PermissionPresetKey {
  const norm = (s: string) => (s === '' ? '^$' : s) // the broker treats "" as "match nothing"
  const hit = PERMISSION_PRESETS.find(
    (x) => x.configure === norm(p.configure) && x.write === norm(p.write) && x.read === norm(p.read),
  )
  return hit?.key ?? 'custom'
}

/** Plain-language reading of one permission field. */
export function describeRegex(re: string): string {
  if (re === '.*') return 'everything'
  if (re === '' || re === '^$') return 'nothing'
  return `names matching ${re}`
}

/** Validate a permission / policy regex as far as the browser can (RabbitMQ uses
 *  Erlang PCRE, which accepts everything JS does for the patterns people write). */
export function regexError(re: string): string | null {
  try {
    new RegExp(re)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export const APPLY_TO = ['queues', 'exchanges', 'all', 'classic_queues', 'quorum_queues', 'streams'] as const

/** Common policy keys with a sample value, offered as quick inserts. */
export const POLICY_KEYS: { key: string; sample: unknown; hint: string }[] = [
  { key: 'max-length', sample: 10000, hint: 'Max ready messages; oldest dropped (or rejected — see overflow)' },
  { key: 'max-length-bytes', sample: 104857600, hint: 'Max total body size of ready messages' },
  { key: 'overflow', sample: 'reject-publish', hint: 'drop-head · reject-publish · reject-publish-dlx' },
  { key: 'message-ttl', sample: 60000, hint: 'Messages expire after this many ms' },
  { key: 'expires', sample: 1800000, hint: 'Delete the queue after this many ms unused' },
  { key: 'dead-letter-exchange', sample: 'dlx', hint: 'Where rejected / expired messages go' },
  { key: 'dead-letter-routing-key', sample: 'dead', hint: 'Routing key used when dead-lettering' },
  { key: 'delivery-limit', sample: 5, hint: 'Quorum queues: redeliveries before dead-lettering' },
  { key: 'max-age', sample: '7D', hint: 'Streams: retention (Y M D h m s)' },
  { key: 'alternate-exchange', sample: 'unrouted', hint: 'Exchanges: where unroutable messages go' },
]

export type ParsedDefinition = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

/** Parse the policy definition text: must be a non-empty JSON object. */
export function parsePolicyDefinition(text: string): ParsedDefinition {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Definition is not valid JSON — ${(e as Error).message}` }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'Definition must be a JSON object' }
  if (!Object.keys(v as object).length) return { ok: false, error: 'Definition needs at least one key, e.g. {"max-length": 10000}' }
  return { ok: true, value: v as Record<string, unknown> }
}

/** Add (or replace) one key in the definition text, keeping the rest. */
export function withPolicyKey(text: string, key: string, sample: unknown): string {
  let obj: Record<string, unknown> = {}
  try {
    const v = JSON.parse(text)
    if (v && typeof v === 'object' && !Array.isArray(v)) obj = v as Record<string, unknown>
  } catch {
    // unparsable draft: start from an empty object rather than lose the click
  }
  return JSON.stringify({ ...obj, [key]: obj[key] ?? sample }, null, 2)
}

/** One-line summary of a definition: `max-length=10000 · message-ttl=60000`. */
export function policySummary(def: Record<string, unknown>): string {
  return Object.entries(def)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ')
}

/** Random password (letters + digits + a few symbols safe in any shell or URL). */
export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.~'
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  return Array.from(arr, (n) => alphabet[n % alphabet.length]).join('')
}
