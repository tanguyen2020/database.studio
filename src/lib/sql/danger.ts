// Dangerous-statement detection for the query editor: a DELETE with no WHERE
// clause, or a TRUNCATE, wipes a whole table. Before running such a statement
// the editor asks the user to confirm. Pure + unit-tested; the confirm UI lives
// in SqlWorkspace. Applies to relational SQL dialects (PG/MySQL/MariaDB/MSSQL/
// SQLite/ClickHouse/Oracle/DuckDB).

import { lexRules, type SqlLexRules } from './statements'

export type DangerKind = 'delete' | 'truncate'

export interface DangerStmt {
  /** index of the statement in the executed batch */
  index: number
  kind: DangerKind
  /** the original (untouched) statement text, for display */
  sql: string
}

/** Strip comments and string/identifier literals (with the dialect's own rules)
 *  so keyword scanning below can't be fooled by a `WHERE` inside a string, a
 *  `--` comment or a `$$ … $$` body. Literal bodies become a space. */
function stripSql(sql: string, rules: SqlLexRules): string {
  let out = ''
  const len = sql.length
  let i = 0
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'backtick' | 'bracket' | 'dollar'
  let mode: Mode = 'code'
  let esc = false
  let depth = 0
  let tag = ''
  while (i < len) {
    const ch = sql[i]
    const next = sql[i + 1]
    switch (mode) {
      case 'code': {
        if (ch === '-' && next === '-') { mode = 'line'; i += 2; continue }
        if (ch === '#' && rules.hashComments) { mode = 'line'; i++; continue }
        if (ch === '/' && next === '*') { mode = 'block'; depth = 1; i += 2; continue }
        if (ch === "'") {
          const prev = sql[i - 1]
          esc = rules.backslashEscapes || (rules.eStrings && (prev === 'E' || prev === 'e') && !/[\w$]/.test(sql[i - 2] ?? ''))
          mode = 'single'; out += ' '; i++; continue
        }
        if (ch === '"') { mode = 'double'; out += ' '; i++; continue }
        if (ch === '`') { mode = 'backtick'; out += ' '; i++; continue }
        if (ch === '[') { mode = 'bracket'; out += ' '; i++; continue }
        if (ch === '$' && rules.dollarQuotes) {
          const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i, i + 64))
          if (m) { tag = m[0]; mode = 'dollar'; out += ' '; i += tag.length; continue }
        }
        out += ch
        i++
        break
      }
      case 'line':
        if (ch === '\n') { mode = 'code'; out += ch }
        i++
        break
      case 'block':
        if (rules.nestedComments && ch === '/' && next === '*') { depth++; i += 2; continue }
        if (ch === '*' && next === '/') {
          depth--
          i += 2
          if (depth <= 0 || !rules.nestedComments) { mode = 'code'; out += ' ' }
          continue
        }
        i++
        break
      case 'single':
        if (esc && ch === '\\') { i += 2; continue }
        if (ch === "'" && next === "'") { i += 2; continue }
        if (ch === "'") mode = 'code'
        i++
        break
      case 'double':
        if (rules.doubleQuoteBackslash && ch === '\\') { i += 2; continue }
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
        if (ch === ']' && next === ']') { i += 2; continue }
        if (ch === ']') mode = 'code'
        i++
        break
      case 'dollar':
        if (sql.startsWith(tag, i)) { mode = 'code'; i += tag.length; continue }
        i++
        break
    }
  }
  return out
}

/** Words before `delete` that make it something other than a DELETE statement:
 *  `ON DELETE CASCADE`, a trigger event (`AFTER INSERT OR DELETE`, `FOR DELETE`),
 *  a privilege (`GRANT SELECT, DELETE`), a MERGE branch (`THEN DELETE`). */
const NOT_A_DELETE_STATEMENT = new Set(['on', 'for', 'after', 'before', 'instead', 'of', 'grant', 'revoke', ',', 'or', 'then'])

/** Words that begin the next statement when T-SQL runs them without a `;`. */
const NEXT_STATEMENT = new Set([
  'delete', 'insert', 'update', 'merge', 'select', 'truncate', 'drop', 'create', 'alter',
  'if', 'begin', 'end', 'exec', 'execute', 'declare', 'commit', 'rollback', 'print', 'return', 'go',
])

/** Classify a single statement, or null when it's not dangerous. */
export function classifyDanger(sql: string, system?: string): DangerKind | null {
  const s = stripSql(sql, lexRules(system)).toLowerCase()
  const toks = s.match(/[a-z_][a-z0-9_$]*|[(),;]/g) ?? []
  // EXPLAIN without ANALYZE only plans the statement — nothing is deleted
  if (toks[0] === 'explain' && !/^\s*explain\s*(\([^)]*\banalyze\b|\s+analyze\b)/.test(s)) return null
  // TRUNCATE always wipes the table — there is no WHERE variant. (Not the
  // privilege: `GRANT TRUNCATE ON t`.)
  if (toks.some((t, i) => t === 'truncate' && !NOT_A_DELETE_STATEMENT.has(toks[i - 1] ?? ''))) return 'truncate'
  // DELETE without its own WHERE deletes every row — wherever the DELETE sits:
  // the head of the statement, inside a CTE (`WITH d AS (DELETE …)`), after a CTE
  // (`WITH x AS (…) DELETE …`), after EXPLAIN ANALYZE, or after another T-SQL
  // statement with no `;`. A WHERE inside a subquery (`USING (… WHERE …)`) is
  // not the DELETE's own.
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== 'delete' || NOT_A_DELETE_STATEMENT.has(toks[i - 1] ?? '')) continue
    let d = 0
    let hasWhere = false
    for (let j = i + 1; j < toks.length; j++) {
      const u = toks[j]
      if (u === '(') d++
      else if (u === ')') {
        if (d === 0) break // the DELETE was inside parentheses that end here
        d--
      } else if (d === 0) {
        if (u === ';') break
        if (u === 'where') {
          hasWhere = true
          break
        }
        if (NEXT_STATEMENT.has(u) && u !== 'delete') break
        if (u === 'delete' && !NOT_A_DELETE_STATEMENT.has(toks[j - 1] ?? '')) break
      }
    }
    if (!hasWhere) return 'delete'
  }
  return null
}

/** Flag every dangerous statement in an executed batch. */
export function dangerousStatements(statements: { sql: string }[], system?: string): DangerStmt[] {
  const out: DangerStmt[] = []
  statements.forEach((stmt, index) => {
    const kind = classifyDanger(stmt.sql, system)
    if (kind) out.push({ index, kind, sql: stmt.sql })
  })
  return out
}
