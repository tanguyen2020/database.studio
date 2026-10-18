// Turns a driver error into something a person can act on: a short title that
// says WHAT went wrong ("Table or view not found"), one sentence of explanation,
// and a hint on how to fix it. The server's own message is never rewritten — it
// is shown verbatim underneath, because it names the exact object/value.
//
// Classification reads the error CODE first (SQLSTATE for PostgreSQL/MySQL/
// MariaDB, error number for SQL Server, ORA-nnnnn for Oracle) and falls back to
// well-known message patterns (SQLite, DuckDB, ClickHouse and errors that carry
// no code). Pure → unit-testable.

import type { QueryError } from '$lib/types'
import type { SplitStatement } from './statements'

export type ErrorCategory =
  | 'syntax'
  | 'missing-table'
  | 'missing-column'
  | 'missing-function'
  | 'missing-database'
  | 'already-exists'
  | 'permission'
  | 'unique'
  | 'foreign-key'
  | 'not-null'
  | 'check'
  | 'dependency'
  | 'data'
  | 'lock'
  | 'in-use'
  | 'connection'
  | 'cancelled'
  | 'timeout'
  | 'other'

export interface ErrorExplanation {
  category: ErrorCategory
  /** a few words: "Table or view not found" */
  title: string
  /** one sentence of plain explanation */
  summary: string
  /** how to fix it — the driver's own hint when it has one, else a generic one */
  hint?: string
  /** the server's message, cleaned of transport prefixes ("driver error: …") */
  message: string
}

interface Rule {
  category: ErrorCategory
  title: string
  summary: string
  hint: string
  /** error codes, compared case-insensitively (SQLSTATE, MSSQL number, ORA-nnnnn, MySQL errno) */
  codes?: string[]
  /** message patterns — used when no code matched */
  match?: RegExp
}

// Order matters: the first rule whose code OR pattern matches wins, so specific
// rules (unique, not-null) come before broad ones (data, syntax).
const RULES: Rule[] = [
  {
    category: 'cancelled',
    title: 'Query cancelled',
    summary: 'The statement was stopped before it finished.',
    hint: 'Nothing after the cancelled statement was run. Run it again when you are ready.',
    codes: ['CANCELLED', '57014', 'ORA-01013'],
    match: /\b(cancell?ed|canceling statement|interrupted)\b/i,
  },
  {
    category: 'connection',
    title: 'Connection lost',
    summary: 'The connection to the server was closed while running this statement.',
    hint: 'Reconnect, then run the statement again. A write that failed this way may or may not have been applied.',
    codes: ['CONNECTION_LOST', '08000', '08003', '08006', '08001', '57P01', '57P05', 'ORA-03113', 'ORA-03114', '2006', '2013'],
    match: /\b(connection (was )?(lost|reset|closed|refused)|forcibly closed|server has gone away|broken pipe|not connected)\b/i,
  },
  {
    category: 'timeout',
    title: 'Timed out',
    summary: 'The server did not answer in time.',
    hint: 'Narrow the query (WHERE, LIMIT, an index on the filtered column) or try again when the server is less busy.',
    codes: ['HYT00'],
    match: /\b(timed? ?out|timeout expired|statement timeout)\b/i,
  },
  {
    category: 'lock',
    title: 'Blocked by another transaction',
    summary: 'Another session holds a lock this statement needs, or the two sessions deadlocked.',
    hint: 'Retry the statement. If it keeps happening, look for a long open transaction (Sessions) and commit or roll it back.',
    codes: ['40P01', '40001', '55P03', '1205', '1222', 'ORA-00060', 'ORA-00054', '1213'],
    match: /\b(deadlock|lock wait timeout|could not obtain lock|could not serialize)\b/i,
  },
  {
    category: 'in-use',
    title: 'Object is in use',
    summary: 'Other sessions are using this object, so the server refused the change.',
    hint: 'Close the other sessions (Session Monitor) and run it again.',
    codes: ['55006', '3702', 'ORA-01940'],
    match: /\b(is being accessed by other users|currently in use)\b/i,
  },
  {
    category: 'unique',
    title: 'Duplicate value',
    summary: 'A row with the same key already exists — a UNIQUE or PRIMARY KEY constraint refused it.',
    hint: 'Use a different value, update the existing row instead, or use the engine\'s upsert (ON CONFLICT / ON DUPLICATE KEY / MERGE).',
    codes: ['23505', '2627', '2601', 'ORA-00001', '1062', '1586'],
    match: /\b(duplicate (key|entry)|unique constraint|UNIQUE constraint failed|violates unique)\b/i,
  },
  {
    category: 'foreign-key',
    title: 'Foreign key violation',
    summary: 'The row points to a parent row that does not exist, or other rows still point to the row being removed.',
    hint: 'Insert the parent row first, or delete/update the child rows that reference it.',
    codes: ['23503', '547', 'ORA-02291', 'ORA-02292', '1451', '1452', '1216', '1217'],
    match: /\b(foreign key|FOREIGN KEY constraint failed|REFERENCE constraint)\b/i,
  },
  {
    category: 'not-null',
    title: 'Missing required value',
    summary: 'A NOT NULL column was left empty.',
    hint: 'Give the column a value (or a DEFAULT in the table definition).',
    codes: ['23502', '515', 'ORA-01400', '1048', '1364'],
    match: /\b(not[- ]null (constraint|violation)|NOT NULL constraint failed|cannot be null|cannot insert the value NULL|null value in column)\b/i,
  },
  {
    category: 'check',
    title: 'Check constraint violation',
    summary: 'A value broke a CHECK rule defined on the table.',
    hint: 'Look at the table\'s CHECK constraints and change the value so it satisfies them.',
    codes: ['23514', 'ORA-02290', '3819'],
    match: /\b(check constraint|CHECK constraint failed)\b/i,
  },
  {
    category: 'dependency',
    title: 'Other objects depend on it',
    summary: 'The object cannot be removed while other objects still depend on it.',
    hint: 'Drop or change the dependent objects first, or use CASCADE where the engine supports it.',
    codes: ['2BP01', '3729', 'ORA-02449'],
    match: /\b(depend(s)? on it|because other objects depend|is referenced by)\b/i,
  },
  {
    category: 'permission',
    title: 'Permission denied',
    summary: 'The user of this connection is not allowed to do this.',
    hint: 'Ask an administrator for the privilege, or connect as a user that has it (Users & Privileges).',
    codes: ['42501', '229', '262', '297', '300', '1142', '1143', '1044', '1227', 'ORA-01031', 'ORA-01749'],
    match: /\b(permission denied|access denied|insufficient privileges?|not authori[sz]ed|is not allowed|command denied)\b/i,
  },
  {
    category: 'missing-column',
    title: 'Column not found',
    summary: 'A column named in the statement does not exist in the table.',
    hint: 'Check the column name and its table alias; Explorer → table → Columns lists the real names.',
    codes: ['42703', '42S22', '207', 'ORA-00904', '1054'],
    match: /\b(column .* does not exist|no such column|unknown column|invalid column name|Referenced column .* not found|UNKNOWN_IDENTIFIER)\b/i,
  },
  {
    category: 'missing-table',
    title: 'Table or view not found',
    summary: 'The table or view named in the statement does not exist — or is in another schema/database.',
    hint: 'Check the spelling, qualify it with the schema (schema.table), or pick the right database/schema in the toolbar.',
    codes: ['42P01', '42S02', '208', 'ORA-00942', '1146', '1051'],
    match: /\b(relation .* does not exist|no such table|table .* (does not exist|doesn't exist|not found)|unknown table|invalid object name|Table with name .* does not exist|UNKNOWN_TABLE)\b/i,
  },
  {
    category: 'missing-function',
    title: 'Function not found',
    summary: 'The function does not exist, or no version of it accepts these argument types.',
    hint: 'Check the function name and cast the arguments to the expected types.',
    codes: ['42883', '195', '4121', '1305'],
    match: /\b(function .* does not exist|no such function|is not a recognized (built-in )?function|Unknown function|UNKNOWN_FUNCTION)\b/i,
  },
  {
    category: 'missing-database',
    title: 'Database or schema not found',
    summary: 'The database or schema named in the statement does not exist.',
    hint: 'Check the name, or pick an existing database/schema in the toolbar.',
    codes: ['3D000', '3F000', '4060', '2760', '1049', 'ORA-01918'],
    match: /\b((database|schema) .* does not exist|unknown database|cannot open database|UNKNOWN_DATABASE)\b/i,
  },
  {
    category: 'already-exists',
    title: 'Object already exists',
    summary: 'An object with this name already exists.',
    hint: 'Use a different name, drop the existing object first, or use IF NOT EXISTS / CREATE OR REPLACE.',
    codes: ['42P07', '42P06', '42710', '42723', '42P04', '2714', '1050', '1007', 'ORA-00955'],
    match: /\b(already exists|There is already an object named)\b/i,
  },
  {
    category: 'data',
    title: 'Invalid data value',
    summary: 'A value does not fit the column\'s type, is out of range, or could not be converted.',
    hint: 'Check the value against the column type (length, number range, date format) and cast it explicitly if needed.',
    codes: [
      '22001', '22003', '22007', '22008', '22012', '22P02', '22023', '22004', '22018',
      '8152', '2628', '245', '8114', '8134', '241', '242',
      'ORA-01722', 'ORA-01476', 'ORA-12899', 'ORA-01438', 'ORA-01843', 'ORA-01861',
      '1264', '1265', '1366', '1406', '1292', '1365',
    ],
    match: /\b(invalid input syntax|value too long|out of range|division by zero|divide by zero|data too long|conversion failed|invalid number|incorrect .* value|string or binary data would be truncated|cannot be cast)\b/i,
  },
  {
    category: 'syntax',
    title: 'Syntax error',
    summary: 'The server could not parse the statement.',
    hint: 'Look at the marked position: a typo, a missing comma or parenthesis, or a keyword this database does not support (e.g. LIMIT vs TOP).',
    codes: ['42601', '42000', '102', '156', '170', '105', '1064', 'ORA-00900', 'ORA-00933', 'ORA-00936', 'ORA-00923', 'ORA-00907', 'ORA-00906', 'ORA-00921', 'Parser', 'SYNTAX_ERROR', '62'],
    match: /\b(syntax error|incorrect syntax|parse error|parser error|you have an error in your sql syntax|unexpected (token|end))\b/i,
  },
]

const RULE_BY_CODE = new Map<string, Rule>()
for (const r of RULES) for (const c of r.codes ?? []) if (!c.endsWith('?') && !RULE_BY_CODE.has(c.toUpperCase())) RULE_BY_CODE.set(c.toUpperCase(), r)

/** Strip transport prefixes the user never needs to read ("driver error: error
 *  returned from database: …", a leading "Error: " from a rejected IPC call). */
export function cleanErrorMessage(message: string): string {
  let m = message.trim()
  for (;;) {
    const next = m
      .replace(/^error:\s*/i, '')
      .replace(/^driver error:\s*/i, '')
      .replace(/^error returned from database:\s*/i, '')
      .replace(/^error communicating with database:\s*/i, '')
      .replace(/^database error:\s*/i, '')
      .trim()
    if (next === m) return m
    m = next
  }
}

/** Code as the rule table spells it: ORA-00942 stays ORA-00942, "ORA-942" pads. */
function normCode(code: string | undefined, message: string): string | undefined {
  const c = code?.trim()
  if (c) {
    const ora = /^ORA-?(\d+)$/i.exec(c)
    return ora ? `ORA-${ora[1].padStart(5, '0')}` : c.toUpperCase()
  }
  // Oracle and a few drivers keep the code only inside the message text.
  const inMsg = /\b(ORA-\d{5})\b/.exec(message)
  return inMsg?.[1]
}

export function explainQueryError(err: QueryError): ErrorExplanation {
  const message = cleanErrorMessage(err.message || err.raw || 'Unknown error')
  const code = normCode(err.code, `${err.message} ${err.raw ?? ''}`)
  let rule = code ? RULE_BY_CODE.get(code) : undefined
  // A code we do not know, or a code shared by several meanings (MySQL 42000 =
  // syntax OR access): let a clear message pattern decide.
  if (!rule || code === '42000') {
    const byMsg = RULES.find((r) => r.match?.test(message))
    if (byMsg) rule = byMsg
  }
  if (!rule && code) rule = byClass(code)
  if (!rule) {
    return { category: 'other', title: 'Statement failed', summary: 'The server returned an error.', hint: err.hint || undefined, message }
  }
  return { category: rule.category, title: rule.title, summary: rule.summary, hint: err.hint || rule.hint, message }
}

/** SQLSTATE class fallback (first 2 chars) for a code no rule lists. */
function byClass(code: string): Rule | undefined {
  if (!/^[0-9A-Z]{5}$/.test(code)) return undefined
  const cls = code.slice(0, 2)
  const pick = (c: ErrorCategory) => RULES.find((r) => r.category === c)
  switch (cls) {
    case '22':
      return pick('data')
    case '23':
      return pick('check')
    case '28':
      return pick('permission')
    case '42':
      return pick('syntax')
    case '40':
      return pick('lock')
    case '08':
      return pick('connection')
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Excerpt — the statement lines around the error, with the error line marked
// ---------------------------------------------------------------------------

export interface ExcerptLine {
  /** line number in the EDITOR document */
  line: number
  text: string
  /** this is the line the server reported */
  error: boolean
  /** 1-based column of the caret within `text` (only when the server gave a real column) */
  caret?: number
}

/** Up to `context` lines either side of the reported error line, numbered as in
 *  the editor. Null when the server gave no position (nothing to point at).
 *  Drivers that only know the LINE (MySQL "at line N", SQL Server, Oracle) report
 *  column 1 — that line is marked, but no caret is drawn at a guessed column. */
export function errorExcerpt(stmt: SplitStatement, err: QueryError, context = 1): ExcerptLine[] | null {
  const pos = err.position
  if (!pos || pos.line < 1) return null
  const lines = stmt.sql.replace(/\r\n?/g, '\n').split('\n')
  const at = pos.line - 1
  if (at >= lines.length) return null
  const from = Math.max(0, at - context)
  const to = Math.min(lines.length - 1, at + context)
  const out: ExcerptLine[] = []
  for (let i = from; i <= to; i++) {
    const text = lines[i]
    // keep the excerpt tidy: skip blank context lines, never the error line
    if (i !== at && !text.trim()) continue
    const e: ExcerptLine = { line: stmt.startLine + i, text: text.replace(/\t/g, '  '), error: i === at }
    if (i === at && pos.col > 1 && pos.col <= text.length + 1) {
      // tabs became 2 spaces — move the caret accordingly
      const before = text.slice(0, pos.col - 1)
      e.caret = before.replace(/\t/g, '  ').length + 1
    }
    out.push(e)
  }
  return out
}
