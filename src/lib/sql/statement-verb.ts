// What kind of statement this is, in the words a person would use: "SELECT",
// "INSERT", "CREATE TABLE", "DROP INDEX"… Used by the Messages view of the Result
// panel to label each executed statement. Heuristic and display-only — it never
// decides how a statement is executed.

const OBJECT_WORDS = new Set([
  'TABLE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'SEQUENCE', 'FUNCTION', 'PROCEDURE', 'PROC',
  'TRIGGER', 'TYPE', 'USER', 'ROLE', 'EXTENSION', 'DOMAIN', 'MATERIALIZED', 'KEYSPACE',
  'DICTIONARY', 'MACRO', 'EVENT', 'LOGIN', 'SYNONYM', 'PACKAGE', 'COLLECTION', 'PARTITION',
])
const WITH_OBJECT = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT'])

/** Remove leading comments / whitespace / opening parentheses. */
function head(sql: string): string {
  let s = sql
  for (;;) {
    const t = s.replace(/^[\s(]+/, '')
    if (t.startsWith('--')) s = t.replace(/^--[^\n]*\n?/, '')
    else if (t.startsWith('/*')) s = t.replace(/^\/\*[\s\S]*?(\*\/|$)/, '')
    else return t
  }
}

export function statementVerb(sql: string): string {
  const words = head(sql)
    .slice(0, 400)
    .split(/[^A-Za-z_]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase())
  if (!words.length) return 'STATEMENT'
  let [first] = words
  if (first === 'WITH') {
    // the CTE bodies sit in parentheses — drop them so their SELECTs don't count
    let outer = head(sql)
    for (let prev = ''; prev !== outer; ) {
      prev = outer
      outer = outer.replace(/\([^()]*\)/g, ' ')
    }
    const main = outer
      .split(/[^A-Za-z_]+/)
      .map((w) => w.toUpperCase())
      .find((w) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(w))
    return main ?? 'SELECT'
  }
  if (first === 'EXEC') first = 'EXECUTE'
  if (!WITH_OBJECT.has(first)) return first
  // CREATE [OR REPLACE] [UNIQUE|TEMP|…] TABLE → "CREATE TABLE"
  const obj = words.slice(1, 6).find((w) => OBJECT_WORDS.has(w))
  if (!obj) return first
  if (obj === 'MATERIALIZED') return `${first} MATERIALIZED VIEW`
  return `${first} ${obj === 'PROC' ? 'PROCEDURE' : obj}`
}

/** One line of the statement for a list: whitespace collapsed, comments dropped. */
export function statementPreview(sql: string, max = 140): string {
  const flat = head(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
