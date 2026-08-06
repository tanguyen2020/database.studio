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

/** One token: an identifier (bare or quoted, already unquoted) or punctuation. */
interface Tok {
  v: string
  /** identifier vs `.` `,` `(` `)` */
  ident: boolean
  /** written inside `` ` ``, `"` or `[ ]` — so it's a NAME even if it reads as a keyword */
  quoted: boolean
}

const PUNCT: Tok = { v: '', ident: false, quoted: false }

function isName(tok: Tok | undefined): boolean {
  return !!tok?.ident
}

function isStop(tok: Tok | undefined): boolean {
  // A quoted identifier is never a clause keyword: FROM "order" o names a table.
  return !!tok && tok.ident && !tok.quoted && STOP.has(tok.v.toLowerCase())
}

function eq(tok: Tok | undefined, punct: string): boolean {
  return !!tok && !tok.ident && tok.v === punct
}

/**
 * Tokenize the identifiers and punctuation that matter for FROM/JOIN parsing.
 * Quoted identifiers are unquoted here, which is what makes names that aren't
 * bare-legal work: `` `ismart-eco`.`course_test` ``, `"Order"`, `[dbo].[students]`,
 * and databases whose name contains dots. Reading them as bare words split them
 * apart (`ismart-eco` became table `ismart` + alias `eco`), so the reference never
 * resolved and the table's columns were never suggested.
 */
function tokenize(sql: string): Tok[] {
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // string literals: their words must not become tables/aliases. Handles both
    // escape styles ('' everywhere, \' in MySQL) so a literal never swallows the
    // rest of the statement.
    .replace(/'(?:''|\\.|[^'\\])*'/g, ' ')
  const re =
    /`((?:[^`]|``)*)`|"((?:[^"]|"")*)"|\[((?:[^\]]|\]\])*)\]|([a-zA-Z_][\w$]*)|([.,()])/g
  const toks: Tok[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned))) {
    if (m[1] !== undefined) toks.push({ v: m[1].replace(/``/g, '`'), ident: true, quoted: true })
    else if (m[2] !== undefined) toks.push({ v: m[2].replace(/""/g, '"'), ident: true, quoted: true })
    else if (m[3] !== undefined) toks.push({ v: m[3].replace(/\]\]/g, ']'), ident: true, quoted: true })
    else if (m[4] !== undefined) toks.push({ v: m[4], ident: true, quoted: false })
    else toks.push({ ...PUNCT, v: m[5] })
  }
  return toks
}

/** Read one `schema.table [AS] alias` reference starting at `words[i]`. */
function readOneTable(words: Tok[], start: number, out: TableRef[]): number {
  let i = start
  if (i >= words.length) return i
  // A subquery / derived table — can't introspect it; skip the token.
  if (!isName(words[i]) || isStop(words[i])) return i
  let schema: string | undefined
  let table = words[i].v
  i++
  if (eq(words[i], '.') && i + 1 < words.length && isName(words[i + 1])) {
    schema = table
    table = words[i + 1].v
    i += 2
  }
  let alias: string | undefined
  if (words[i]?.ident && !words[i].quoted && words[i].v.toLowerCase() === 'as') {
    i++
    if (isName(words[i])) {
      alias = words[i].v
      i++
    }
  } else if (isName(words[i]) && !isStop(words[i])) {
    alias = words[i].v
    i++
  }
  out.push({ schema, table, alias })
  return i
}

/** Read a comma-separated FROM list: `a x, b.c y, d`. */
function readTableList(words: Tok[], start: number, out: TableRef[]): number {
  let i = start
  while (i < words.length) {
    const before = out.length
    i = readOneTable(words, i, out)
    if (out.length === before) break
    if (eq(words[i], ',')) {
      i++
      continue
    }
    break
  }
  return i
}

/**
 * Extract every table reference in a statement's FROM / JOIN clauses.
 * Comments and string literals are stripped first; subqueries (parenthesised) are
 * skipped. Quoted identifiers keep their real name (see tokenize).
 */
export function parseTableRefs(sql: string): TableRef[] {
  const words = tokenize(sql)
  const refs: TableRef[] = []
  let i = 0
  while (i < words.length) {
    const tok = words[i]
    const w = tok.ident && !tok.quoted ? tok.v.toLowerCase() : ''
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
