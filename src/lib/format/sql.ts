// Lightweight SQL syntax tokenizer for read-only display (the compare migration
// preview). Pure → unit-testable. Colors keywords / strings / comments / numbers
// with the app's --syntax-* tokens; adjacent same-kind tokens are merged so the UI
// renders few spans.
export type SqlTokenKind = 'keyword' | 'string' | 'comment' | 'number' | 'plain'
export interface SqlToken {
  text: string
  kind: SqlTokenKind
}

const KEYWORDS = new Set([
  'ADD', 'ALTER', 'AND', 'AS', 'ASC', 'BEGIN', 'BY', 'CASCADE', 'CHECK', 'COLUMN', 'COMMIT',
  'CONSTRAINT', 'CREATE', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'END', 'EXISTS',
  'FOREIGN', 'FROM', 'FUNCTION', 'IF', 'IN', 'INDEX', 'INSERT', 'INTO', 'IS', 'KEY', 'MODIFY',
  'NO', 'NOT', 'NULL', 'ON', 'OR', 'ORDER', 'OUTPUT', 'PRIMARY', 'PROCEDURE', 'REFERENCES',
  'RENAME', 'REPLACE', 'RESTRICT', 'RETURNS', 'SELECT', 'SEQUENCE', 'SET', 'TABLE', 'TO',
  'TRIGGER', 'TYPE', 'UNIQUE', 'UPDATE', 'USING', 'VALUES', 'VIEW', 'WHERE', 'WITH', 'ACTION',
  // common data types (so they read as keywords in DDL)
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'SERIAL', 'TEXT', 'VARCHAR', 'CHAR',
  'NVARCHAR', 'BOOLEAN', 'BOOL', 'TIMESTAMP', 'TIMESTAMPTZ', 'DATETIME', 'DATE', 'TIME',
  'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL', 'UUID', 'JSON', 'JSONB', 'BYTEA', 'BLOB',
])

// comment | single-quoted string | number | word | any single other char
const TOKEN_RE = /(--[^\n]*)|('(?:''|\\.|[^'])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g

export function highlightSql(sql: string): SqlToken[] {
  const out: SqlToken[] = []
  const push = (text: string, kind: SqlTokenKind) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ text, kind })
  }
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(sql)) !== null) {
    if (m[1] != null) push(m[1], 'comment')
    else if (m[2] != null) push(m[2], 'string')
    else if (m[3] != null) push(m[3], 'number')
    else if (m[4] != null) push(m[4], KEYWORDS.has(m[4].toUpperCase()) ? 'keyword' : 'plain')
    else push(m[5], 'plain')
  }
  return out
}

/** CSS color (an app --syntax-* var, or neutral text) for a token kind. */
export function sqlTokenColor(kind: SqlTokenKind): string {
  switch (kind) {
    case 'keyword':
      return 'var(--syntax-keyword)'
    case 'string':
      return 'var(--syntax-string)'
    case 'comment':
      return 'var(--syntax-comment)'
    case 'number':
      return 'var(--syntax-number)'
    default:
      return 'var(--text)'
  }
}
