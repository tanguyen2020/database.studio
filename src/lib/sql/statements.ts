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

export function splitStatements(doc: string, system?: string): SplitStatement[] {
  const out: SplitStatement[] = []
  const len = doc.length
  let i = 0
  let stmtStart = 0
  // Oracle-only additions (a `/` line terminator + anonymous DECLARE/BEGIN blocks +
  // PACKAGE/TYPE bodies). Gated so every other engine keeps the exact prior behavior.
  const oracle = system === 'oracle'

  type Mode = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'backtick' | 'bracket' | 'dollar'
  let mode: Mode = 'code'
  // PostgreSQL dollar-quoted string body ($$…$$ or $tag$…$tag$). Everything inside
  // is opaque — semicolons there (e.g. a function body) must NOT split.
  let dollarTag = ''
  // Depth of BEGIN…END blocks in a routine body (CREATE FUNCTION/PROCEDURE/TRIGGER/
  // EVENT). While > 0, `;` does NOT split — otherwise a compound statement gets
  // chopped at its internal semicolons and every fragment is a syntax error.
  let beginDepth = 0
  const BLOCK_END_KW = new Set(['IF', 'CASE', 'LOOP', 'WHILE', 'REPEAT'])

  // Line index for this document, built once. Held locally (not via the memo in
  // offsetToLineCol) so the per-statement conversion below stays O(log n) even if
  // another caller passes a different document in between.
  const starts = lineStarts(doc)

  const push = (endExclusive: number) => {
    const raw = doc.slice(stmtStart, endExclusive)
    if (raw.trim().length > 0) {
      // trim leading whitespace but keep offsets accurate
      let from = stmtStart
      while (from < endExclusive && /\s/.test(doc[from])) from++
      let to = endExclusive
      while (to > from && /\s/.test(doc[to - 1])) to--
      const li = lineOf(starts, from)
      out.push({ sql: doc.slice(from, to), from, to, startLine: li + 1, startCol: from - starts[li] + 1 })
    }
  }

  while (i < len) {
    const ch = doc[i]
    const next = doc[i + 1]
    switch (mode) {
      case 'code':
        // Keyword scan (word boundary) for BEGIN…END block tracking.
        if (/[A-Za-z_]/.test(ch)) {
          let j = i
          while (j < len && /[A-Za-z0-9_]/.test(doc[j])) j++
          const word = doc.slice(i, j).toUpperCase()
          if (word === 'BEGIN') {
            // Only a routine body starts a suppressing block (not a `BEGIN;` txn).
            const pre = doc.slice(stmtStart, i)
            const isRoutine = /\bCREATE\b[\s\S]*\b(FUNCTION|PROCEDURE|TRIGGER|EVENT)\b/i.test(pre)
            // Oracle: CREATE PACKAGE/TYPE bodies, and anonymous blocks that start with
            // DECLARE or BEGIN (nothing meaningful before the BEGIN) also suppress `;`.
            const isOracleBlock =
              oracle && (/\bCREATE\b[\s\S]*\b(PACKAGE|TYPE)\b/i.test(pre) || /^\s*(DECLARE\b[\s\S]*)?$/i.test(pre))
            if (beginDepth > 0 || isRoutine || isOracleBlock) {
              beginDepth++
            }
          } else if (word === 'END' && beginDepth > 0) {
            let k = j
            while (k < len && /\s/.test(doc[k])) k++
            let m = k
            while (m < len && /[A-Za-z]/.test(doc[m])) m++
            // `END IF/CASE/LOOP/WHILE/REPEAT` close a sub-block, not the BEGIN block.
            if (!BLOCK_END_KW.has(doc.slice(k, m).toUpperCase())) beginDepth--
          }
          i = j
          continue
        }
        // PostgreSQL dollar-quote opener: $tag$ (tag optional). Enter opaque mode.
        if (ch === '$') {
          const m = /^\$[A-Za-z_0-9]*\$/.exec(doc.slice(i))
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
          push(i)
          let k = i + 1
          while (k < len && doc[k] !== '\n') k++
          if (k < len) k++ // consume the newline
          stmtStart = k
          beginDepth = 0
          i = k
          continue
        }
        if (ch === '-' && next === '-') mode = 'line-comment'
        else if (ch === '/' && next === '*') mode = 'block-comment'
        else if (ch === "'") mode = 'single'
        else if (ch === '"') mode = 'double'
        else if (ch === '`') mode = 'backtick'
        else if (ch === '[') mode = 'bracket'
        else if (ch === ';' && beginDepth === 0) {
          // Oracle: a `;` does NOT terminate a PL/SQL block (DECLARE/BEGIN or a
          // CREATE routine/package/type) — only a `/` line does. So the trailing
          // `END;` and every inner `;` stay part of the one statement.
          const skip =
            oracle &&
            (/^\s*(DECLARE|BEGIN)\b/i.test(doc.slice(stmtStart, i)) ||
              /\bCREATE\b[\s\S]*\b(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b/i.test(doc.slice(stmtStart, i)))
          if (!skip) {
            push(i)
            stmtStart = i + 1
          }
        }
        break
      case 'line-comment':
        if (ch === '\n') mode = 'code'
        break
      case 'block-comment':
        if (ch === '*' && next === '/') {
          mode = 'code'
          i++
        }
        break
      case 'single':
        if (ch === '\\' && next === "'") i++ // MySQL-style escape
        else if (ch === "'" && next === "'") i++ // doubled quote
        else if (ch === "'") mode = 'code'
        break
      case 'double':
        if (ch === '"' && next === '"') i++
        else if (ch === '"') mode = 'code'
        break
      case 'backtick':
        if (ch === '`' && next === '`') i++
        else if (ch === '`') mode = 'code'
        break
      case 'bracket':
        if (ch === ']') mode = 'code'
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

/** Statement containing the (0-based) cursor offset — for Ctrl+Enter. */
export function statementAtOffset(doc: string, offset: number): SplitStatement | null {
  const statements = splitStatements(doc)
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
