// Where a column name is expected in a SQL statement.
//
// The editor only offers completions once the user has typed a character, because
// an explicit request in empty space dumps the whole catalog on screen. But right
// after `WHERE `, `SET `, `AND `, `ON `, `ORDER BY `, or a comma, a column is the
// ONLY thing that makes sense — so those positions are worth suggesting from with
// nothing typed yet. Shared by the completion source and the "columns just
// arrived, reopen the popup" hook so both agree on the same positions.

const KEYWORDS = [
  'where',
  'and',
  'or',
  'not',
  'on',
  'set',
  'select',
  'having',
  'by',
  'using',
  'returning',
]

/**
 * True when the text ending at the caret is a position that expects a column:
 * a column-introducing keyword (or a comma / open paren) followed by whitespace.
 */
export function expectsColumnHere(textBefore: string): boolean {
  // a comma or `(` then spaces — `SELECT a, ` / `INSERT INTO t (`
  if (/[,(]\s+$/.test(textBefore)) return true
  const m = /(^|[\s(,])([a-z_]+)\s+$/i.exec(textBefore)
  if (!m) return false
  return KEYWORDS.includes(m[2].toLowerCase())
}
