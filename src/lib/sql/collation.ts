// MySQL/MariaDB collation unification (data-driven). Pure → unit-testable.
//
// A MySQL schema can end up mixing collations (e.g. utf8mb4_0900_ai_ci and
// utf8mb4_general_ci) — comparing two columns of different collation then throws
// "Illegal mix of collations" at runtime, in every client. The fix is
// server-side: converge the whole database on ONE target collation.
//
// This module builds the audit query (find tables/columns not on the target)
// and the ALTER statements to unify them. Scope is TABLES + COLUMNS only —
// `ALTER DATABASE … COLLATE` + `ALTER TABLE … CONVERT TO CHARACTER SET … COLLATE`.
// Stored procedures / functions / views / triggers are deliberately NOT touched:
// their collation is baked at CREATE time and recreating them is out of scope by
// request ("không được phép chỉnh sửa script đã tồn tại"). Only base tables are
// converted; the statements are wrapped in SET FOREIGN_KEY_CHECKS = 0/1 so a
// referenced column's collation can change without a transient FK mismatch.
import { quoteIdent } from './dialect'

/** Collation unification applies to MySQL and MariaDB only. */
export function isMysqlFamily(system: string): boolean {
  return system === 'mysql' || system === 'mariadb'
}

/** MySQL charset names carry no underscore, so the charset is the prefix before
 *  the first underscore of the collation (utf8mb4_0900_ai_ci → utf8mb4). */
export function charsetOf(collation: string): string {
  const c = collation.trim()
  const us = c.indexOf('_')
  return us > 0 ? c.slice(0, us) : c
}

/** Escape a value for a single-quoted MySQL string literal (backslash + quote). */
function sqlStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/** One base table's collation state, as returned by the audit query. */
export interface TableCollationRow {
  table_name: string
  /** the table's default collation */
  table_collation: string
  /** comma-separated DISTINCT column collations (GROUP_CONCAT); may be empty */
  column_collations?: string | null
}

/** Distinct column collations of a row, normalized to a trimmed non-empty list. */
export function columnCollations(row: TableCollationRow): string[] {
  return (row.column_collations ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** True when the table default OR any text column differs from the target. */
export function needsConvert(row: TableCollationRow, target: string): boolean {
  if (row.table_collation && row.table_collation !== target) return true
  return columnCollations(row).some((c) => c !== target)
}

/** Names of the tables that must be converted to reach the target collation. */
export function tablesToConvert(rows: TableCollationRow[], target: string): string[] {
  return rows.filter((r) => needsConvert(r, target)).map((r) => r.table_name)
}

/** Every distinct collation currently present across the audited tables. */
export function distinctCollations(rows: TableCollationRow[]): string[] {
  const set = new Set<string>()
  for (const r of rows) {
    if (r.table_collation) set.add(r.table_collation)
    for (const c of columnCollations(r)) set.add(c)
  }
  return [...set].sort()
}

// MySQL 8 types many information_schema string columns as the *binary* charset
// (VARBINARY), which the generic exec path hex-encodes. CAST(... AS CHAR) forces
// a text column so the values decode as plain strings on every server.

/** Audit query: per base table, its default collation + distinct column
 *  collations. Views are excluded (TABLE_TYPE = 'BASE TABLE'). Runs read-only. */
export function buildAuditQuery(db: string): string {
  return `SELECT CAST(t.TABLE_NAME AS CHAR) AS table_name,
       CAST(t.TABLE_COLLATION AS CHAR) AS table_collation,
       CAST(GROUP_CONCAT(DISTINCT c.COLLATION_NAME ORDER BY c.COLLATION_NAME) AS CHAR) AS column_collations
FROM information_schema.TABLES t
LEFT JOIN information_schema.COLUMNS c
  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
 AND c.TABLE_NAME = t.TABLE_NAME
 AND c.COLLATION_NAME IS NOT NULL
WHERE t.TABLE_SCHEMA = ${sqlStr(db)}
  AND t.TABLE_TYPE = 'BASE TABLE'
GROUP BY t.TABLE_NAME, t.TABLE_COLLATION
ORDER BY t.TABLE_NAME`
}

/** List the collations available for a charset (feeds the target dropdown). */
export function buildCollationsQuery(charset = 'utf8mb4'): string {
  return `SELECT CAST(COLLATION_NAME AS CHAR) AS name, IS_DEFAULT AS is_default
FROM information_schema.COLLATIONS
WHERE CHARACTER_SET_NAME = ${sqlStr(charset)}
ORDER BY COLLATION_NAME`
}

/** The database's current default charset + collation (dropdown default). */
export function buildDefaultCollationQuery(db: string): string {
  return `SELECT CAST(DEFAULT_CHARACTER_SET_NAME AS CHAR) AS charset, CAST(DEFAULT_COLLATION_NAME AS CHAR) AS collation
FROM information_schema.SCHEMATA
WHERE SCHEMA_NAME = ${sqlStr(db)}`
}

export interface UnifyOptions {
  /** wrap in SET FOREIGN_KEY_CHECKS = 0/1 (default true) so FK columns can change */
  disableFkChecks?: boolean
  /** also set the database default collation (default true) */
  alterDatabase?: boolean
}

/** The ordered ALTER statements that converge `db` on `target`. Empty for a
 *  non-MySQL system. Tables/columns only — routines/views/triggers untouched. */
export function buildUnifyStatements(
  system: string,
  db: string,
  target: string,
  tables: string[],
  opts: UnifyOptions = {},
): string[] {
  if (!isMysqlFamily(system) || !db || !target) return []
  const q = (n: string) => quoteIdent(system, n)
  const cs = charsetOf(target)
  const fk = opts.disableFkChecks !== false
  const out: string[] = []
  if (fk) out.push('SET FOREIGN_KEY_CHECKS = 0;')
  if (opts.alterDatabase !== false) {
    out.push(`ALTER DATABASE ${q(db)} CHARACTER SET ${cs} COLLATE ${target};`)
  }
  for (const t of tables) {
    out.push(`ALTER TABLE ${q(db)}.${q(t)} CONVERT TO CHARACTER SET ${cs} COLLATE ${target};`)
  }
  if (fk) out.push('SET FOREIGN_KEY_CHECKS = 1;')
  return out
}

/** Full reviewable script (header comment + statements) for the SQL tab/preview. */
export function buildUnifySql(
  system: string,
  db: string,
  target: string,
  tables: string[],
  opts?: UnifyOptions,
): string {
  const stmts = buildUnifyStatements(system, db, target, tables, opts)
  if (!stmts.length) {
    return `-- Collation unification is available for MySQL/MariaDB only (system: ${system}).`
  }
  const header = [
    `-- Unify collation of database \`${db}\` → ${target}`,
    `-- ${tables.length} table(s) will be converted. Stored procedures/functions/views/triggers are NOT modified.`,
    `-- Back up the database and review before running on production.`,
    '',
  ].join('\n')
  return header + stmts.join('\n') + '\n'
}
