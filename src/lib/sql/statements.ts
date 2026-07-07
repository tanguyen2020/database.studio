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

export function splitStatements(doc: string): SplitStatement[] {
  const out: SplitStatement[] = []
  const len = doc.length
  let i = 0
  let stmtStart = 0

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

  const push = (endExclusive: number) => {
    const raw = doc.slice(stmtStart, endExclusive)
    if (raw.trim().length > 0) {
      // trim leading whitespace but keep offsets accurate
      let from = stmtStart
      while (from < endExclusive && /\s/.test(doc[from])) from++
      let to = endExclusive
      while (to > from && /\s/.test(doc[to - 1])) to--
      const { line, col } = offsetToLineCol(doc, from)
      out.push({ sql: doc.slice(from, to), from, to, startLine: line, startCol: col })
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
            if (beginDepth > 0 || /\bCREATE\b[\s\S]*\b(FUNCTION|PROCEDURE|TRIGGER|EVENT)\b/i.test(doc.slice(stmtStart, i))) {
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
        if (ch === '-' && next === '-') mode = 'line-comment'
        else if (ch === '/' && next === '*') mode = 'block-comment'
        else if (ch === "'") mode = 'single'
        else if (ch === '"') mode = 'double'
        else if (ch === '`') mode = 'backtick'
        else if (ch === '[') mode = 'bracket'
        else if (ch === ';' && beginDepth === 0) {
          push(i)
          stmtStart = i + 1
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

export function offsetToLineCol(doc: string, offset: number): { line: number; col: number } {
  let line = 1
  let col = 1
  for (let i = 0; i < offset && i < doc.length; i++) {
    if (doc[i] === '\n') {
      line++
      col = 1
    } else {
      col++
    }
  }
  return { line, col }
}

export function lineColToOffset(doc: string, line: number, col: number): number {
  let curLine = 1
  let i = 0
  while (i < doc.length && curLine < line) {
    if (doc[i] === '\n') curLine++
    i++
  }
  return Math.min(i + Math.max(0, col - 1), doc.length)
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
