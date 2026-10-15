// Sessions that keep a DROP DATABASE from running — normalized from the
// `database_sessions` command (same aliases on every engine) for the dialog.

export interface DbSession {
  pid: number
  username: string
  client: string
  program: string
  state: string
  started: string
  /** MySQL/MariaDB report seconds in the current state instead of a start time. */
  seconds: number | null
  query: string
  /** Holds a lock on the database. Only meaningful on MySQL/MariaDB, where an idle
   *  `USE db` session does NOT block DROP DATABASE but a metadata lock does. */
  holdsLock: boolean
}

function pick(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key]
  // Oracle folds unquoted aliases to UPPERCASE — accept either spelling.
  const up = key.toUpperCase()
  return up in row ? row[up] : undefined
}

function text(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v).trim()
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isFinite(n) ? n : null
}

/** Rows → sessions. A row without a usable pid cannot be killed, so it is dropped. */
export function toDbSessions(rows: Record<string, unknown>[]): DbSession[] {
  const out: DbSession[] = []
  for (const r of rows) {
    const pid = num(pick(r, 'pid'))
    if (pid === null) continue
    const lock = pick(r, 'holds_lock')
    out.push({
      pid,
      username: text(pick(r, 'username')),
      client: text(pick(r, 'client')),
      program: text(pick(r, 'program')),
      state: text(pick(r, 'state')),
      started: text(pick(r, 'started')),
      seconds: num(pick(r, 'seconds')),
      query: text(pick(r, 'query')),
      holdsLock: lock === true || num(lock) === 1,
    })
  }
  return out
}

/** Engines where the dialog can list and kill the sessions holding a database. */
export function canKillDatabaseSessions(system: string): boolean {
  return ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle'].includes(system)
}

/** One line explaining WHY the drop is blocked, in the engine's own terms. */
export function inUseExplanation(system: string, db: string, n: number): string {
  const who = n === 1 ? '1 other session' : `${n} other sessions`
  switch (system) {
    case 'mysql':
    case 'mariadb':
      return `"${db}" is locked by ${who} — DROP DATABASE waited for their locks and timed out.`
    case 'oracle':
      return `User "${db}" is logged in from ${who}; Oracle will not drop a connected user.`
    default:
      return `"${db}" is being used by ${who}; the server will not drop it while they are connected.`
  }
}
