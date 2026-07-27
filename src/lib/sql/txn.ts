// Transaction tracking for the Query Editor.
//
// A connection left inside an open transaction is the ONE way a healthy driver
// still serves "cached" results: under REPEATABLE READ (MySQL/InnoDB, or a PG
// server configured that way) the snapshot is pinned for the whole transaction,
// and the writes made inside it are invisible to everyone else until COMMIT.
// The editor therefore tracks whether the statements it ran left a transaction
// open, so the workspace can SHOW it and offer Commit / Rollback.
//
// Pure + per-dialect → unit-tested.

export type TxnEffect = 'begin' | 'end' | null

/** Strip leading comments/whitespace so `-- note\nBEGIN` is still a BEGIN. */
function head(sql: string): string {
  let s = sql
  // repeatedly drop leading whitespace, line comments and block comments
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    s = s.replace(/^--[^\n]*\n?/, '')
    s = s.replace(/^\/\*[\s\S]*?\*\//, '')
    if (s === before) break
  }
  return s.toUpperCase()
}

/** DDL that implicitly commits the open transaction (MySQL/MariaDB/Oracle/MSSQL). */
function isImplicitCommitDdl(h: string): boolean {
  return /^(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/.test(h)
}

/**
 * What running `sql` does to the connection's transaction state:
 * 'begin' opened one, 'end' closed one, null leaves it as it was.
 */
export function txnEffect(sql: string, system: string): TxnEffect {
  const h = head(sql)
  if (!h) return null

  // Oracle: `BEGIN … END;` is a PL/SQL block, NOT a transaction statement, and
  // the driver runs the editor in autocommit — so neither opens nor closes one.
  if (system === 'oracle') {
    if (/^(COMMIT|ROLLBACK)\b/.test(h)) return 'end'
    if (isImplicitCommitDdl(h)) return 'end'
    return null
  }

  if (/^START\s+TRANSACTION\b/.test(h)) return 'begin'
  if (/^BEGIN\s+(WORK|TRANSACTION|TRAN)\b/.test(h)) return 'begin'
  // bare BEGIN (PG/SQLite/MySQL/MSSQL) — `BEGIN` alone or `BEGIN;`
  if (/^BEGIN\s*;?\s*$/.test(h)) return 'begin'
  if (/^BEGIN\s+(ISOLATION|READ|DEFERRED|IMMEDIATE|EXCLUSIVE)\b/.test(h)) return 'begin'
  if (/^SAVEPOINT\b/.test(h)) return 'begin'

  if (/^(COMMIT|ROLLBACK)\b/.test(h)) {
    // ROLLBACK TO SAVEPOINT keeps the transaction open.
    if (/^ROLLBACK\s+(TO|WORK\s+TO)\b/.test(h)) return null
    return 'end'
  }
  // PG/SQLite: END [TRANSACTION] is COMMIT.
  if (/^END\s*(TRANSACTION|WORK)?\s*;?\s*$/.test(h)) return 'end'

  // Engines without transactional DDL close the transaction on any DDL.
  if ((system === 'mysql' || system === 'mariadb' || system === 'mssql') && isImplicitCommitDdl(h)) {
    return 'end'
  }
  return null
}

/** Engines where the editor tracks transactions at all (no txn → no badge). */
export function supportsTxn(system: string): boolean {
  return ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'oracle'].includes(system)
}
