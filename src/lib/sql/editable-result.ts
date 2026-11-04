// Can a Query Editor result be edited in place? Only when every row maps back to
// exactly one row of one table — the rule DataGrip uses. The statement must be a
// plain SELECT from a single table whose select list is real columns (no
// expressions, no aliases), and the result must carry the table's whole primary
// key, so each change targets its row by key and nothing else. Anything this parser
// is not sure about stays read-only, with the reason shown to the user.

/** Engines whose grid edits go through apply_grid / ClickHouse mutations. */
const EDITABLE_SYSTEMS = new Set(['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'oracle', 'duckdb', 'clickhouse'])

export function supportsResultEditing(system: string): boolean {
  return EDITABLE_SYSTEMS.has(system)
}

export interface EditableSource {
  /** schema written in the statement — null when the table is unqualified, so the
   *  change resolves the table the same way the SELECT did (same session) */
  schema: string | null
  table: string
}

export type SourceCheck = { ok: true; source: EditableSource } | { ok: false; reason: string }

export const NOT_A_SELECT = 'Only the result of a SELECT from one table can be edited.'

interface Tok {
  v: string
  kind: 'word' | 'quoted' | 'punct' | 'other'
}

function tokenize(sql: string): Tok[] {
  const re =
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'\\])*'|`((?:[^`]|``)*)`|"((?:[^"]|"")*)"|\[((?:[^\]]|\]\])*)\]|([a-zA-Z_][\w$#]*)|([.,()*;])|\d+(?:\.\d+)?|(\S)/g
  const out: Tok[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    const s = m[0]
    if (s.startsWith('--') || s.startsWith('/*')) continue
    if (s.startsWith("'")) out.push({ v: s, kind: 'other' })
    else if (m[1] !== undefined) out.push({ v: m[1].replace(/``/g, '`'), kind: 'quoted' })
    else if (m[2] !== undefined) out.push({ v: m[2].replace(/""/g, '"'), kind: 'quoted' })
    else if (m[3] !== undefined) out.push({ v: m[3].replace(/\]\]/g, ']'), kind: 'quoted' })
    else if (m[4] !== undefined) out.push({ v: m[4], kind: 'word' })
    else if (m[5] !== undefined) out.push({ v: m[5], kind: 'punct' })
    else out.push({ v: s, kind: 'other' })
  }
  // a trailing `;` is not part of the statement
  while (out.length && out[out.length - 1].kind === 'punct' && out[out.length - 1].v === ';') out.pop()
  return out
}

const kw = (t: Tok | undefined, ...words: string[]) => !!t && t.kind === 'word' && words.includes(t.v.toLowerCase())
const punct = (t: Tok | undefined, p: string) => !!t && t.kind === 'punct' && t.v === p
const isName = (t: Tok | undefined) => !!t && (t.kind === 'word' || t.kind === 'quoted')

/** How the engine stores an unquoted name: PostgreSQL folds to lower case, Oracle
 *  to upper case; the others keep what was written. */
function fold(t: Tok, system: string): string {
  if (t.kind === 'quoted') return t.v
  if (system === 'postgres') return t.v.toLowerCase()
  if (system === 'oracle') return t.v.toUpperCase()
  return t.v
}

/** Words that can follow the table (or its alias) and keep the result one row per
 *  table row. */
const AFTER_TABLE = new Set(['where', 'order', 'limit', 'offset', 'fetch', 'for', 'with', 'final', 'prewhere', 'sample', 'settings'])

/** Top-level words that make a result stop mapping 1:1 to table rows. */
const BREAKS: Record<string, string> = {
  join: 'A result that joins tables cannot be edited.',
  inner: 'A result that joins tables cannot be edited.',
  left: 'A result that joins tables cannot be edited.',
  right: 'A result that joins tables cannot be edited.',
  full: 'A result that joins tables cannot be edited.',
  cross: 'A result that joins tables cannot be edited.',
  natural: 'A result that joins tables cannot be edited.',
  straight_join: 'A result that joins tables cannot be edited.',
  apply: 'A result that joins tables cannot be edited.',
  group: 'A grouped result cannot be edited — its rows are not table rows.',
  having: 'A grouped result cannot be edited — its rows are not table rows.',
  union: 'A result that combines queries (UNION / INTERSECT / EXCEPT) cannot be edited.',
  intersect: 'A result that combines queries (UNION / INTERSECT / EXCEPT) cannot be edited.',
  except: 'A result that combines queries (UNION / INTERSECT / EXCEPT) cannot be edited.',
  minus: 'A result that combines queries (UNION / INTERSECT / EXCEPT) cannot be edited.',
  into: 'SELECT … INTO writes a new table; its result cannot be edited.',
  pivot: 'A pivoted result cannot be edited.',
  unpivot: 'A pivoted result cannot be edited.',
}

const COMPUTED = 'Only plain columns can be edited — remove computed columns, functions and aliases (AS) from the SELECT.'

/**
 * Find the single table a SELECT reads, or say why its result is not editable.
 * Conservative on purpose: an unrecognised shape is read-only, never guessed.
 */
export function editableSource(sql: string, system: string): SourceCheck {
  if (!supportsResultEditing(system)) return { ok: false, reason: 'Results from this engine cannot be edited here.' }
  const t = tokenize(sql)
  if (kw(t[0], 'with')) return { ok: false, reason: 'A query with WITH (a common table expression) cannot be edited.' }
  if (!kw(t[0], 'select')) return { ok: false, reason: NOT_A_SELECT }
  let i = 1
  if (kw(t[i], 'all')) i++
  if (kw(t[i], 'distinct', 'distinctrow', 'unique')) return { ok: false, reason: 'A DISTINCT result cannot be edited — its rows are not table rows.' }
  // SQL Server TOP n / TOP (n) [PERCENT] [WITH TIES]
  if (kw(t[i], 'top')) {
    i++
    if (punct(t[i], '(')) {
      while (i < t.length && !punct(t[i], ')')) i++
      i++
    } else i++
    if (kw(t[i], 'percent')) i++
    if (kw(t[i], 'with') && kw(t[i + 1], 'ties')) i += 2
  }

  // ---- select list: items up to the top-level FROM
  const qualifiers: string[][] = []
  let item: Tok[] = []
  const items: Tok[][] = []
  let depth = 0
  for (; i < t.length; i++) {
    const tok = t[i]
    if (punct(tok, '(')) depth++
    else if (punct(tok, ')')) depth--
    if (depth === 0 && kw(tok, 'from')) break
    if (depth === 0 && punct(tok, ',')) {
      items.push(item)
      item = []
      continue
    }
    item.push(tok)
  }
  items.push(item)
  if (i >= t.length) return { ok: false, reason: NOT_A_SELECT }
  for (const it of items) {
    // `*` · `name` · `q.name` · `q.*` · `s.q.name` — names separated by dots
    if (it.length === 1 && punct(it[0], '*')) continue
    if (it.length === 0 || it.length % 2 === 0) return { ok: false, reason: COMPUTED }
    for (let k = 0; k < it.length; k++) {
      const ok = k % 2 === 1 ? punct(it[k], '.') : isName(it[k]) || (k === it.length - 1 && punct(it[k], '*'))
      if (!ok) return { ok: false, reason: COMPUTED }
    }
    if (it.length > 5) return { ok: false, reason: COMPUTED }
    if (it.length > 1) qualifiers.push(it.filter((_, k) => k % 2 === 0 && k < it.length - 1).map((q) => fold(q, system)))
  }

  // ---- FROM <table> [[AS] alias]
  i++ // past FROM
  if (punct(t[i], '(')) return { ok: false, reason: 'A result read from a subquery cannot be edited.' }
  const parts: Tok[] = []
  if (!isName(t[i])) return { ok: false, reason: NOT_A_SELECT }
  parts.push(t[i++])
  while (punct(t[i], '.') && isName(t[i + 1])) {
    parts.push(t[i + 1])
    i += 2
  }
  if (punct(t[i], '(')) return { ok: false, reason: 'A result read from a table function cannot be edited.' }
  if (parts.length > 2) return { ok: false, reason: 'A table in another database cannot be edited from this tab — switch the tab to that database.' }
  const table = fold(parts[parts.length - 1], system)
  const schema = parts.length === 2 ? fold(parts[0], system) : null
  let alias: string | null = null
  if (kw(t[i], 'as') && isName(t[i + 1])) {
    alias = fold(t[i + 1], system)
    i += 2
  } else if (t[i]?.kind === 'quoted' || (t[i]?.kind === 'word' && !AFTER_TABLE.has(t[i].v.toLowerCase()) && !(t[i].v.toLowerCase() in BREAKS))) {
    alias = fold(t[i], system)
    i++
  }

  // a comma right after the table reference is a second table (FROM a, b); commas
  // later on belong to ORDER BY a, b / LIMIT 10, 20 and are fine
  if (punct(t[i], ',')) return { ok: false, reason: 'A result that reads more than one table cannot be edited.' }

  // ---- the rest: nothing at top level may join, group or combine
  depth = 0
  for (; i < t.length; i++) {
    const tok = t[i]
    if (punct(tok, '(')) depth++
    else if (punct(tok, ')')) depth--
    if (depth !== 0) continue
    // a word followed by `(` is a function call — RIGHT(name, 1), LEFT(…)
    if (tok.kind === 'word' && tok.v.toLowerCase() in BREAKS && !punct(t[i + 1], '(')) {
      return { ok: false, reason: BREAKS[tok.v.toLowerCase()] }
    }
    if (kw(tok, 'array') && kw(t[i + 1], 'join')) return { ok: false, reason: BREAKS.join }
  }

  // every qualifier in the select list must name this table
  const same = (a: string, b: string) => (system === 'postgres' || system === 'oracle' ? a === b : a.toLowerCase() === b.toLowerCase())
  for (const q of qualifiers) {
    const name = q[q.length - 1]
    const okName = alias ? same(name, alias) : same(name, table)
    const okSchema = q.length === 1 || (schema !== null && same(q[0], schema)) || (alias === null && schema === null)
    if (!okName || (q.length > 1 && !okSchema)) return { ok: false, reason: 'A column in the SELECT comes from another table — only one table can be edited.' }
  }
  return { ok: true, source: { schema, table } }
}

/** Engines that treat column names case-insensitively, quoted or not. */
const CI_COLUMNS = new Set(['mysql', 'mariadb', 'mssql', 'sqlite', 'duckdb'])

export type ColumnCheck = { ok: true; pkCols: string[] } | { ok: false; reason: string }

/**
 * Match the result's columns to the table's real columns. Every result column must
 * be a column of the table (so a change writes the right column), and the table's
 * primary key must be in the result (so a change finds exactly its row). Returns
 * the key columns under the names the RESULT uses.
 */
export function matchResultColumns(
  resultCols: string[],
  tableCols: { name: string; is_pk: boolean }[],
  system: string,
): ColumnCheck {
  if (tableCols.length === 0) return { ok: false, reason: 'The table could not be read, so this result cannot be edited.' }
  const ci = CI_COLUMNS.has(system)
  const norm = (s: string) => (ci ? s.toLowerCase() : s)
  const seen = new Set<string>()
  for (const c of resultCols) {
    if (seen.has(norm(c))) return { ok: false, reason: `The result has two columns named ${c}, so a change cannot tell which one it means.` }
    seen.add(norm(c))
  }
  const real = new Map(tableCols.map((c) => [norm(c.name), c]))
  const unknown = resultCols.filter((c) => !real.has(norm(c)))
  if (unknown.length) return { ok: false, reason: `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a column' : 'are not columns'} of the table, so the result cannot be edited.` }
  const pk = tableCols.filter((c) => c.is_pk)
  if (pk.length === 0) return { ok: false, reason: 'The table has no primary key, so a changed row cannot be identified safely. Use Open Data to edit it.' }
  const byNorm = new Map(resultCols.map((c) => [norm(c), c]))
  const missing = pk.filter((c) => !byNorm.has(norm(c.name))).map((c) => c.name)
  if (missing.length) return { ok: false, reason: `Add the primary key (${missing.join(', ')}) to the SELECT to edit this result.` }
  return { ok: true, pkCols: pk.map((c) => byNorm.get(norm(c.name))!) }
}
