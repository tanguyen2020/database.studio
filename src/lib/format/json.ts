// Lightweight JSON syntax tokenizer for read-only display. Pure → unit-testable.
// Returns a flat list of tokens the UI paints with the app's --syntax-* colors.
// Keys are split from their trailing colon so the colon renders as punctuation.
export type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'plain'
export interface JsonToken {
  text: string
  kind: JsonTokenKind
}

// A string (with escapes) optionally acting as a key (trailing colon), a keyword
// literal (true/false/null), or a number. Everything else falls through as plain.
const TOKEN_RE = /"(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
const KEY_RE = /^("(?:\\.|[^"\\])*")(\s*:)$/

export function highlightJson(text: string): JsonToken[] {
  const out: JsonToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), kind: 'plain' })
    const tok = m[0]
    if (tok[0] === '"') {
      const key = KEY_RE.exec(tok)
      if (key) {
        out.push({ text: key[1], kind: 'key' })
        out.push({ text: key[2], kind: 'plain' }) // the ` :` punctuation
      } else {
        out.push({ text: tok, kind: 'string' })
      }
    } else if (tok === 'true' || tok === 'false') {
      out.push({ text: tok, kind: 'boolean' })
    } else if (tok === 'null') {
      out.push({ text: tok, kind: 'null' })
    } else {
      out.push({ text: tok, kind: 'number' })
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'plain' })
  return out
}

/** CSS color (an app --syntax-* var, or a neutral) for a token kind. */
export function jsonTokenColor(kind: JsonTokenKind): string {
  switch (kind) {
    case 'key':
      return 'var(--syntax-function)'
    case 'string':
      return 'var(--syntax-string)'
    case 'number':
      return 'var(--syntax-number)'
    case 'boolean':
      return 'var(--syntax-keyword)'
    case 'null':
      return 'var(--syntax-comment)'
    default:
      return 'var(--text2)'
  }
}
