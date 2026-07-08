// Parse table references (with optional schema qualifier + alias) from the
// FROM / JOIN clauses of a SQL statement, so the editor can offer column
// completions for `alias.` and `table.` — the built-in lang-sql completion only
// resolves aliases when every table's columns are already loaded, which they
// aren't (the Explorer loads columns lazily). This drives a completion source
// that maps the typed prefix back to a real table, then loads its columns.

export interface TableRef {
  schema?: string
  table: string
  alias?: string
}

// Words that end a table reference / start another clause — never an alias.
const STOP = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'intersect',
  'except', 'on', 'using', 'set', 'values', 'returning', 'window', 'fetch',
  'for', 'into', 'select', 'and', 'or', 'not', 'when', 'then', 'else', 'end',
  'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'outer',
  'lateral', 'straight_join', 'with', 'as',
])

function isName(tok: string): boolean {
  return /^[a-zA-Z_][\w$]*$/.test(tok)
}

function isStop(tok: string): boolean {
  return STOP.has(tok.toLowerCase())
}

/** Read one `schema.table [AS] alias` reference starting at `words[i]`. */
function readOneTable(words: string[], start: number, out: TableRef[]): number {
  let i = start
  if (i >= words.length) return i
  // A subquery / derived table — can't introspect it; skip the token.
  if (!isName(words[i]) || isStop(words[i])) return i
  let schema: string | undefined
  let table = words[i]
  i++
  if (words[i] === '.' && i + 1 < words.length && isName(words[i + 1])) {
    schema = table
    table = words[i + 1]
    i += 2
  }
  let alias: string | undefined
  if (words[i]?.toLowerCase() === 'as') {
    i++
    if (isName(words[i] ?? '')) {
      alias = words[i]
      i++
    }
  } else if (isName(words[i] ?? '') && !isStop(words[i])) {
    alias = words[i]
    i++
  }
  out.push({ schema, table, alias })
  return i
}

/** Read a comma-separated FROM list: `a x, b.c y, d`. */
function readTableList(words: string[], start: number, out: TableRef[]): number {
  let i = start
  while (i < words.length) {
    const before = out.length
    i = readOneTable(words, i, out)
    if (out.length === before) break
    if (words[i] === ',') {
      i++
      continue
    }
    break
  }
  return i
}

/**
 * Extract every table reference in a statement's FROM / JOIN clauses.
 * Comments are stripped first; subqueries (parenthesised) are skipped.
 */
export function parseTableRefs(sql: string): TableRef[] {
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  const words = cleaned.match(/[a-zA-Z_][\w$]*|[.,()]/g) ?? []
  const refs: TableRef[] = []
  let i = 0
  while (i < words.length) {
    const w = words[i].toLowerCase()
    if (w === 'from') {
      i = readTableList(words, i + 1, refs)
      continue
    }
    if (w === 'join') {
      i = readOneTable(words, i + 1, refs)
      continue
    }
    i++
  }
  return refs
}

/**
 * Resolve a typed prefix (`u` / `users`) to its table reference: an alias match
 * wins over a bare table-name match. Case-insensitive.
 */
export function resolveRef(refs: TableRef[], prefix: string): TableRef | undefined {
  const p = prefix.toLowerCase()
  return (
    refs.find((r) => r.alias?.toLowerCase() === p) ??
    refs.find((r) => !r.alias && r.table.toLowerCase() === p) ??
    refs.find((r) => r.table.toLowerCase() === p)
  )
}
