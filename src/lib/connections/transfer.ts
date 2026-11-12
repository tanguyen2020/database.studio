// Export / Import Connections — the decisions the dialogs make, kept pure so
// they are unit-tested: is a connection in the file already here, what to call
// it so names do not clash, and whether a file password is good enough.
//
// The file format and every secret live in the backend (connections/transfer.rs);
// this module only ever sees profiles without passwords.

import type { ConnectionProfile } from '$lib/types'

export const MIN_FILE_PASSWORD = 8

/** What to do with one connection of the file. */
export type ImportAction = 'add' | 'replace' | 'skip'

/** One connection read from a file (as `inspect_connections_file` returns it). */
export interface ImportFileItem {
  profile: ConnectionProfile
  has_password: boolean
  has_ssh_password: boolean
  missing_files: string[]
}

export interface ImportRow {
  index: number
  item: ImportFileItem
  /** The saved connection that points at the same server, database and user. */
  match: { id: string; name: string } | null
  action: ImportAction
  /** Name it is saved under when added (renamed when the name is taken). */
  name: string
}

/** Where a profile connects: two profiles with the same target are the same connection. */
export function targetKey(p: Pick<ConnectionProfile, 'system' | 'host' | 'port' | 'database' | 'user' | 'sqlite_path'>): string {
  const embedded = p.system === 'sqlite' || p.system === 'duckdb'
  if (embedded) return `${p.system}|file|${(p.sqlite_path ?? '').trim().replace(/\\/g, '/').toLowerCase()}`
  return [p.system, (p.host ?? '').trim().toLowerCase(), p.port ?? 0, (p.database ?? '').trim(), (p.user ?? '').trim()].join('|')
}

/** `name`, or `name (2)`, `name (3)`… — the first one not in `taken` (case-insensitive). */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  const base = name.trim() || 'Connection'
  if (!lower.has(base.toLowerCase())) return base
  const stem = base.replace(/\s\(\d+\)$/, '')
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * First plan for a file: a connection already here (same target) is skipped
 * by default — unless the file brings a password the saved one lacks, then it
 * is replaced so the password lands. New connections are added under a name
 * that does not clash with saved ones or with each other.
 */
export function planImport(
  items: ImportFileItem[],
  existing: (Pick<ConnectionProfile, 'id' | 'name' | 'system' | 'host' | 'port' | 'database' | 'user' | 'sqlite_path'> & { has_password?: boolean })[],
): ImportRow[] {
  const byTarget = new Map<string, (typeof existing)[number]>()
  for (const e of existing) if (!byTarget.has(targetKey(e))) byTarget.set(targetKey(e), e)
  const names = existing.map((e) => e.name)
  return items.map((item, index) => {
    const hit = byTarget.get(targetKey(item.profile)) ?? null
    const match = hit ? { id: hit.id, name: hit.name } : null
    let action: ImportAction = 'add'
    if (hit) action = item.has_password && !hit.has_password ? 'replace' : 'skip'
    const name = action === 'add' ? uniqueName(item.profile.name, names) : item.profile.name
    if (action === 'add') names.push(name)
    return { index, item, match, action, name }
  })
}

/** Re-number the added rows' names after the user changes an action. */
export function renameAdded(rows: ImportRow[], existingNames: string[]): ImportRow[] {
  const names = [...existingNames]
  return rows.map((r) => {
    if (r.action !== 'add') return { ...r, name: r.item.profile.name }
    const name = uniqueName(r.item.profile.name, names)
    names.push(name)
    return { ...r, name }
  })
}

/** Why a file password cannot be used yet, or null when it is fine. */
export function filePasswordProblem(password: string, confirm: string): string | null {
  if (!password) return 'Choose a password for the file.'
  if ([...password].length < MIN_FILE_PASSWORD) return `Use at least ${MIN_FILE_PASSWORD} characters.`
  if (password !== confirm) return 'The two passwords do not match.'
  return null
}

/** Default file name: `database-studio-connections-2026-11-07.json`. */
export function exportFileName(now = new Date()): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `database-studio-connections-${d}.json`
}

/** One line under an imported connection: where it points. */
export function targetLabel(p: ConnectionProfile): string {
  if (p.system === 'sqlite' || p.system === 'duckdb') return p.sqlite_path || 'In-memory'
  const hostPort = p.port ? `${p.host}:${p.port}` : p.host
  const who = p.user ? `${p.user} @ ` : ''
  return `${who}${hostPort}${p.database ? ` / ${p.database}` : ''}`
}
