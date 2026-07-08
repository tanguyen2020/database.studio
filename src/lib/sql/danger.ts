// Dangerous-statement detection for the query editor: a DELETE with no WHERE
// clause, or a TRUNCATE, wipes a whole table. Before running such a statement
// the editor asks the user to confirm. Pure + unit-tested; the confirm UI lives
// in SqlWorkspace. Applies to relational SQL dialects (PG/MySQL/MariaDB/MSSQL/
// SQLite/ClickHouse).

export type DangerKind = 'delete' | 'truncate'

export interface DangerStmt {
  /** index of the statement in the executed batch */
  index: number
  kind: DangerKind
  /** the original (untouched) statement text, for display */
  sql: string
}

/** Strip comments and string/identifier literals so keyword scanning below
 *  can't be fooled by a `WHERE` inside a string or a `--` comment. Replaces
 *  literal bodies with spaces to keep the rest of the text intact. */
function stripSql(sql: string): string {
  let out = ''
  const len = sql.length
  let i = 0
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'backtick' | 'bracket'
  let mode: Mode = 'code'
  while (i < len) {
    const ch = sql[i]
    const next = sql[i + 1]
    switch (mode) {
      case 'code':
        if (ch === '-' && next === '-') { mode = 'line'; i += 2; continue }
        if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue }
        if (ch === "'") { mode = 'single'; i++; continue }
        if (ch === '"') { mode = 'double'; i++; continue }
        if (ch === '`') { mode = 'backtick'; i++; continue }
        if (ch === '[') { mode = 'bracket'; i++; continue }
        out += ch
        i++
        break
      case 'line':
        if (ch === '\n') { mode = 'code'; out += ch }
        i++
        break
      case 'block':
        if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue }
        i++
        break
      case 'single':
        if (ch === '\\' && next === "'") { i += 2; continue }
        if (ch === "'" && next === "'") { i += 2; continue }
        if (ch === "'") mode = 'code'
        i++
        break
      case 'double':
        if (ch === '"' && next === '"') { i += 2; continue }
        if (ch === '"') mode = 'code'
        i++
        break
      case 'backtick':
        if (ch === '`' && next === '`') { i += 2; continue }
        if (ch === '`') mode = 'code'
        i++
        break
      case 'bracket':
        if (ch === ']') mode = 'code'
        i++
        break
    }
  }
  return out
}

/** Classify a single statement, or null when it's not dangerous. */
export function classifyDanger(sql: string): DangerKind | null {
  const s = stripSql(sql).replace(/\s+/g, ' ').trim().toLowerCase()
  // TRUNCATE always wipes the table — there is no WHERE variant.
  if (/^truncate\b/.test(s)) return 'truncate'
  // DELETE without a WHERE clause deletes every row. Any DELETE form counts
  // (DELETE FROM t, MySQL's DELETE t FROM …, DELETE … USING …).
  if (/^delete\b/.test(s) && !/\bwhere\b/.test(s)) return 'delete'
  return null
}

/** Flag every dangerous statement in an executed batch. */
export function dangerousStatements(statements: { sql: string }[]): DangerStmt[] {
  const out: DangerStmt[] = []
  statements.forEach((stmt, index) => {
    const kind = classifyDanger(stmt.sql)
    if (kind) out.push({ index, kind, sql: stmt.sql })
  })
  return out
}
