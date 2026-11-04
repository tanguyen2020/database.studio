// Statement splitter — splits an editor buffer into statements on `;`,
// respecting strings, quoted identifiers, and comments. Tracks each
// statement's position so execution errors map back to the document
// (QUERY_EDITOR_ERROR_HANDLING_ADDENDUM §2.3).

export interface SplitStatement {
  sql: string
  /** 0-based character offset of the statement's first char in the document */
  from: number
  /** 0-based exclusive end offset */
  to: number
  /** 1-based line of the statement's first char */
  startLine: number
  /** 1-based column of the statement's first char */
  startCol: number
}

/** True when the char at `i` is a `/` that is alone on its line (Oracle PL/SQL
 *  block terminator: `/` on its own line runs the preceding block). */
function isLoneSlash(doc: string, i: number): boolean {
  for (let a = i - 1; a >= 0 && doc[a] !== '\n'; a--) if (!/\s/.test(doc[a])) return false
  for (let b = i + 1; b < doc.length && doc[b] !== '\n'; b++) if (!/\s/.test(doc[b])) return false
  return true
}

/** How one SQL dialect writes strings, comments and script separators. A statement
 *  boundary found with the wrong rules runs the wrong thing — e.g. a PostgreSQL
 *  `'C:\'` read MySQL-style swallowed the `DELETE` after it into one statement
 *  that the delete-confirm then never saw. */
export interface SqlLexRules {
  /** `\` escapes the next char inside '…' (MySQL/MariaDB/ClickHouse) */
  backslashEscapes: boolean
  /** "…" is a string with `\` escapes (MySQL/MariaDB) — not an identifier */
  doubleQuoteBackslash: boolean
  /** `$$ … $$` / `$tag$ … $tag$` bodies (PostgreSQL/DuckDB) */
  dollarQuotes: boolean
  /** `E'…'` strings honour `\` escapes (PostgreSQL/DuckDB) */
  eStrings: boolean
  /** `# …` line comments (MySQL/MariaDB) */
  hashComments: boolean
  /** `/* /* … *\/ *\/` nest (PostgreSQL/DuckDB) */
  nestedComments: boolean
}

/** Lexical rules per engine. No system → the historical behaviour (MySQL-style
 *  `\` escapes and dollar quotes both on), kept for callers that don't know it. */
export function lexRules(system?: string): SqlLexRules {
  const s = system ?? ''
  const mysqlish = s === 'mysql' || s === 'mariadb'
  const pgish = s === 'postgres' || s === 'duckdb'
  return {
    backslashEscapes: !s || mysqlish || s === 'clickhouse',
    doubleQuoteBackslash: mysqlish,
    dollarQuotes: !s || pgish,
    eStrings: pgish,
    hashComments: mysqlish,
    nestedComments: pgish,
  }
}

/** Text left once comments are removed is only whitespace — a statement made of
 *  comments alone (a trailing `-- done`) must not be sent to the server. */
function onlyComments(text: string, rules: SqlLexRules): boolean {
  let s = text
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    s = s.replace(/^--[^\n]*(\n|$)/, '')
    if (rules.hashComments) s = s.replace(/^#[^\n]*(\n|$)/, '')
    s = s.replace(/^\/\*[\s\S]*?\*\//, '')
    if (s === before) break
  }
  return s.length === 0
}

/** The text with every comment and string literal replaced by spaces (newlines
 *  kept), so offsets still match the original. Quoted IDENTIFIERS stay — they are
 *  names. For keyword scans that must not read `-- from archive` as a table. */
export function maskCommentsAndStrings(text: string, rules: SqlLexRules): string {
  const out = text.split('')
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  const len = text.length
  let i = 0
  while (i < len) {
    const ch = text[i]
    const next = text[i + 1]
    if ((ch === '-' && next === '-') || (ch === '#' && rules.hashComments)) {
      let k = i
      while (k < len && text[k] !== '\n') k++
      blank(i, k)
      i = k
    } else if (ch === '/' && next === '*') {
      let k = i + 2
      let depth = 1
      while (k < len && depth > 0) {
        if (rules.nestedComments && text[k] === '/' && text[k + 1] === '*') {
          depth++
          k += 2
        } else if (text[k] === '*' && text[k + 1] === '/') {
          depth--
          k += 2
        } else k++
      }
      blank(i, k)
      i = k
    } else if (ch === "'") {
      const prev = text[i - 1]
      const esc = rules.backslashEscapes || (rules.eStrings && (prev === 'E' || prev === 'e') && !/[\w$]/.test(text[i - 2] ?? ''))
      let k = i + 1
      while (k < len) {
        if (esc && text[k] === '\\') k += 2
        else if (text[k] === "'" && text[k + 1] === "'") k += 2
        else if (text[k] === "'") break
        else k++
      }
      blank(i, k + 1)
      i = k + 1
    } else if (ch === '$' && rules.dollarQuotes) {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i, i + 64))
      if (!m) {
        i++
        continue
      }
      const end = text.indexOf(m[0], i + m[0].length)
      const k = end < 0 ? len : end + m[0].length
      blank(i, k)
      i = k
    } else if (ch === '"' || ch === '`' || ch === '[') {
      // quoted identifier: skip over it untouched
      const close = ch === '[' ? ']' : ch
      let k = i + 1
      while (k < len && !(text[k] === close && text[k + 1] !== close)) k += text[k] === close ? 2 : 1
      i = k + 1
    } else i++
  }
  return out.join('')
}

/** Leading comments and whitespace removed — "what the statement starts with". */
export function stripLeadingComments(text: string): string {
  let s = text
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    s = s.replace(/^--[^\n]*(\n|$)/, '')
    s = s.replace(/^#[^\n]*(\n|$)/, '')
    s = s.replace(/^\/\*[\s\S]*?\*\//, '')
    if (s === before) return s
  }
}

/** An Oracle statement whose body is PL/SQL (ended by `/`, not by `;`). Anchored
 *  at the statement head: `CREATE TABLE t (type VARCHAR2(10))` is NOT one. */
const ORACLE_PLSQL_HEAD =
  /^(DECLARE|BEGIN)\b|^CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b/i

/** A routine whose body is a BEGIN…END block (`;` inside does not end it). */
const ROUTINE_HEAD =
  /^(CREATE|ALTER)\s+(OR\s+(REPLACE|ALTER)\s+)?(DEFINER\s*=\s*\S+\s+)?((NON)?EDITIONABLE\s+)?((TEMP|TEMPORARY)\s+)?(FUNCTION|PROCEDURE|PROC|TRIGGER|EVENT|PACKAGE|TYPE)\b/i

export function splitStatements(doc: string, system?: string): SplitStatement[] {
  const out: SplitStatement[] = []
  const len = doc.length
  let i = 0
  let stmtStart = 0
  const rules = lexRules(system)
  // Oracle-only additions (a `/` line terminator + anonymous DECLARE/BEGIN blocks +
  // PACKAGE/TYPE bodies). Gated so every other engine keeps the exact prior behavior.
  const oracle = system === 'oracle'
  const mssql = system === 'mssql'
  const mysqlish = system === 'mysql' || system === 'mariadb'

  type Mode = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'backtick' | 'bracket' | 'dollar'
  let mode: Mode = 'code'
  // PostgreSQL dollar-quoted string body ($$…$$ or $tag$…$tag$). Everything inside
  // is opaque — semicolons there (e.g. a function body) must NOT split.
  let dollarTag = ''
  // `\` escapes inside the string being read (decided when it opened)
  let singleEsc = false
  // nesting of /* */ (PostgreSQL/DuckDB allow /* /* */ */)
  let commentDepth = 0
  // Depth of BEGIN…END blocks in a routine body (CREATE FUNCTION/PROCEDURE/TRIGGER/
  // EVENT). While > 0, `;` does NOT split — otherwise a compound statement gets
  // chopped at its internal semicolons and every fragment is a syntax error.
  let beginDepth = 0
  // Open CASE expressions/statements: their END is not the end of a BEGIN block.
  let caseDepth = 0
  const BLOCK_END_KW = new Set(['IF', 'CASE', 'LOOP', 'WHILE', 'REPEAT'])
  // MySQL client `DELIMITER $$`: until the next DELIMITER line, `$$` ends a
  // statement and `;` does not.
  let delim = ';'

  // Line index for this document, built once. Held locally (not via the memo in
  // offsetToLineCol) so the per-statement conversion below stays O(log n) even if
  // another caller passes a different document in between.
  const starts = lineStarts(doc)

  const push = (endExclusive: number) => {
    const raw = doc.slice(stmtStart, endExclusive)
    if (raw.trim().length > 0 && !onlyComments(raw, rules)) {
      // trim leading whitespace but keep offsets accurate
      let from = stmtStart
      while (from < endExclusive && /\s/.test(doc[from])) from++
      let to = endExclusive
      while (to > from && /\s/.test(doc[to - 1])) to--
      const li = lineOf(starts, from)
      out.push({ sql: doc.slice(from, to), from, to, startLine: li + 1, startCol: from - starts[li] + 1 })
    }
  }
  /** end the statement at `end` and start the next one at `next` */
  const cut = (end: number, next: number) => {
    push(end)
    stmtStart = next
    beginDepth = 0
    caseDepth = 0
  }
  const atLineStart = (p: number) => p === 0 || doc[p - 1] === '\n'
  const lineEnd = (p: number) => {
    let k = p
    while (k < len && doc[k] !== '\n') k++
    return k < len ? k + 1 : k
  }

  while (i < len) {
    const ch = doc[i]
    const next = doc[i + 1]
    switch (mode) {
      case 'code': {
        if (atLineStart(i)) {
          // SQL Server batch separator: a line that is just `GO` (or `GO 5`).
          if (mssql) {
            const g = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*(?:--[^\n]*)?\r?(?:\n|$)/i.exec(doc.slice(i, lineEnd(i)))
            if (g) {
              cut(i, i + g[0].length)
              i += g[0].length
              continue
            }
          }
          // MySQL client command: `DELIMITER <token>` on its own line.
          if (mysqlish) {
            const d = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*\r?(?:\n|$)/i.exec(doc.slice(i, lineEnd(i)))
            if (d) {
              cut(i, i + d[0].length)
              delim = d[1]
              i += d[0].length
              continue
            }
          }
        }
        // a custom delimiter ends the statement wherever it appears in code
        if (delim !== ';' && doc.startsWith(delim, i)) {
          cut(i, i + delim.length)
          i += delim.length
          continue
        }
        // Keyword scan (word boundary) for BEGIN…END block tracking.
        if (/[A-Za-z_]/.test(ch)) {
          let j = i
          while (j < len && /[A-Za-z0-9_]/.test(doc[j])) j++
          const word = doc.slice(i, j).toUpperCase()
          // PostgreSQL E'…' string: `\` escapes inside it
          if ((word === 'E' || word === 'e') && rules.eStrings && doc[j] === "'") {
            mode = 'single'
            singleEsc = true
            i = j + 1
            continue
          }
          if (word === 'BEGIN') {
            let k = j
            while (k < len && /\s/.test(doc[k])) k++
            let m = k
            while (m < len && /[A-Za-z]/.test(doc[m])) m++
            const after = doc.slice(k, m).toUpperCase()
            // `BEGIN TRAN` / `BEGIN TRANSACTION` / `BEGIN WORK` open a transaction,
            // not a block — inside a body they have no matching END.
            const txnBegin = ['TRAN', 'TRANSACTION', 'WORK', 'DISTRIBUTED'].includes(after)
            if (!txnBegin) {
              // Only a routine body starts a suppressing block (not a `BEGIN;` txn).
              const head = stripLeadingComments(doc.slice(stmtStart, i))
              const isRoutine = ROUTINE_HEAD.test(head)
              // Oracle: anonymous blocks that start with DECLARE or BEGIN (nothing
              // meaningful before the BEGIN) also suppress `;`.
              const isOracleBlock = oracle && (head === '' || /^DECLARE\b/i.test(head))
              // SQL Server: any BEGIN…END block (IF … BEGIN … END, TRY/CATCH) is
              // one statement; a bare `BEGIN;` is not T-SQL.
              const isTsqlBlock = mssql && after !== '' && doc[k] !== ';'
              if (beginDepth > 0 || isRoutine || isOracleBlock || isTsqlBlock) beginDepth++
            }
          } else if (word === 'CASE') {
            caseDepth++
          } else if (word === 'END') {
            let k = j
            while (k < len && /\s/.test(doc[k])) k++
            let m = k
            while (m < len && /[A-Za-z]/.test(doc[m])) m++
            const after = doc.slice(k, m).toUpperCase()
            if (BLOCK_END_KW.has(after)) {
              // `END IF/CASE/LOOP/WHILE/REPEAT` close a sub-block, not the BEGIN
              // block; consume the keyword so `END CASE` doesn't reopen a CASE.
              if (after === 'CASE' && caseDepth > 0) caseDepth--
              i = m
              continue
            }
            // the END of a CASE expression (… ELSE 2 END) closes the CASE
            if (caseDepth > 0) caseDepth--
            else if (beginDepth > 0) beginDepth--
          }
          i = j
          continue
        }
        // PostgreSQL dollar-quote opener: $tag$ (tag optional). Enter opaque mode.
        if (ch === '$' && rules.dollarQuotes) {
          const m = /^\$[A-Za-z_0-9]*\$/.exec(doc.slice(i, i + 64))
          if (m) {
            dollarTag = m[0]
            mode = 'dollar'
            i += m[0].length
            continue
          }
        }
        // Oracle: a `/` alone on its line terminates the current (PL/SQL) statement.
        // Not a block-comment opener (next !== '*'); requires the slash be isolated.
        if (oracle && ch === '/' && next !== '*' && isLoneSlash(doc, i)) {
          const k = lineEnd(i)
          cut(i, k)
          i = k
          continue
        }
        if (ch === '-' && next === '-') mode = 'line-comment'
        else if (ch === '#' && rules.hashComments) mode = 'line-comment'
        else if (ch === '/' && next === '*') {
          mode = 'block-comment'
          commentDepth = 1
          i++
        } else if (ch === "'") {
          mode = 'single'
          singleEsc = rules.backslashEscapes
        } else if (ch === '"') mode = 'double'
        else if (ch === '`') mode = 'backtick'
        else if (ch === '[') mode = 'bracket'
        else if (ch === ';' && delim === ';' && beginDepth === 0) {
          // Oracle: a `;` does NOT terminate a PL/SQL block (DECLARE/BEGIN or a
          // CREATE routine/package/type) — only a `/` line does. So the trailing
          // `END;` and every inner `;` stay part of the one statement.
          const skip = oracle && ORACLE_PLSQL_HEAD.test(stripLeadingComments(doc.slice(stmtStart, i)))
          if (!skip) cut(i, i + 1)
        }
        break
      }
      case 'line-comment':
        if (ch === '\n') mode = 'code'
        break
      case 'block-comment':
        if (rules.nestedComments && ch === '/' && next === '*') {
          commentDepth++
          i++
        } else if (ch === '*' && next === '/') {
          commentDepth--
          i++
          if (commentDepth <= 0 || !rules.nestedComments) mode = 'code'
        }
        break
      case 'single':
        if (singleEsc && ch === '\\') i++ // `\x` — skip the escaped char (incl. `\\`)
        else if (ch === "'" && next === "'") i++ // doubled quote
        else if (ch === "'") mode = 'code'
        break
      case 'double':
        if (rules.doubleQuoteBackslash && ch === '\\') i++
        else if (ch === '"' && next === '"') i++
        else if (ch === '"') mode = 'code'
        break
      case 'backtick':
        if (ch === '`' && next === '`') i++
        else if (ch === '`') mode = 'code'
        break
      case 'bracket':
        if (ch === ']' && next === ']') i++ // `]]` is an escaped `]`
        else if (ch === ']') mode = 'code'
        break
      case 'dollar':
        // opaque until the matching closing tag reappears
        if (doc.startsWith(dollarTag, i)) {
          mode = 'code'
          i += dollarTag.length
          continue
        }
        break
    }
    i++
  }
  push(len)
  return out
}

// ---- line index -------------------------------------------------------------
// offset ↔ line/col used to be a scan from the start of the document on EVERY
// call. That is O(n) per call, so any caller in a loop became O(n²): the editor's
// completion source ran splitStatements on each keystroke, which converted the
// start of every statement — a 10k-line script froze the UI for ~190ms per
// keystroke. The same shape lurked in showErrors/toCmDiagnostics (one conversion
// per diagnostic).
//
// The fix is structural rather than local: both conversions go through a line-start
// index built in ONE pass and memoised for the last document, then answered by
// binary search / direct lookup. Every current AND future caller is O(log n), so
// the quadratic pattern cannot be reintroduced by calling these in a loop.
// `statements.perf.test.ts` locks the scaling in.
let idxDoc: string | null = null
let idxStarts: number[] = [0]

/** Offsets where each line begins (index 0 = line 1). One O(n) pass, memoised
 *  for the most recent document — the hot callers all pass the same string. */
export function lineStarts(doc: string): number[] {
  if (idxDoc === doc) return idxStarts
  const starts = [0]
  for (let i = 0; i < doc.length; i++) if (doc.charCodeAt(i) === 10 /* \n */) starts.push(i + 1)
  idxDoc = doc
  idxStarts = starts
  return starts
}

/** Largest index whose start is <= offset (binary search over line starts). */
function lineOf(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function offsetToLineCol(doc: string, offset: number): { line: number; col: number } {
  const pos = Math.max(0, Math.min(offset, doc.length))
  const starts = lineStarts(doc)
  const i = lineOf(starts, pos)
  return { line: i + 1, col: pos - starts[i] + 1 }
}

export function lineColToOffset(doc: string, line: number, col: number): number {
  const starts = lineStarts(doc)
  // past the last line → clamp to the end of the document (previous behaviour)
  const start = line <= 1 ? 0 : line - 1 < starts.length ? starts[line - 1] : doc.length
  return Math.min(start + Math.max(0, col - 1), doc.length)
}

/** Statement containing the (0-based) cursor offset — for Ctrl+Enter. Split with
 *  the tab's own dialect: without it an Oracle PL/SQL block was cut at its inner
 *  `;` and Ctrl+Enter ran one UPDATE out of the block. */
export function statementAtOffset(doc: string, offset: number, system?: string): SplitStatement | null {
  const statements = splitStatements(doc, system)
  for (const s of statements) {
    // include trailing region up to the next statement's start
    if (offset >= s.from && offset <= s.to) return s
  }
  // cursor in whitespace between statements → nearest preceding
  let best: SplitStatement | null = null
  for (const s of statements) {
    if (s.to <= offset) best = s
    else break
  }
  return best ?? statements[0] ?? null
}
