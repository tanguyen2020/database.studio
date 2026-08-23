// Editing a JSON cell in the Result Grid: which cells qualify, what the editor
// shows, and what value gets written back.
//
// A one-line inline <input> is unusable for a JSON document, so a JSON cell opens
// a dedicated editor instead. Two shapes reach the grid:
//   - the driver decoded a real JSON column into an object/array
//     (Postgres json/jsonb, MySQL/MariaDB JSON) → write the PARSED value back so
//     the backend binds a document (Postgres also casts it: `$1::jsonb`);
//   - the engine has no JSON type and the document lives in text
//     (MSSQL nvarchar, SQLite text) → write the TEXT back verbatim, because that
//     column stores exactly what it is given.
// Anything else (a pg text[] array, a composite) stays view-only: guessing a
// literal for it would produce an invalid statement.

/** Declared column type is a JSON type (the engine accepts a JSON document). */
export function isJsonType(type?: string | null): boolean {
  if (!type) return false
  const t = type.toLowerCase()
  if (/jsonpath|json_path/.test(t)) return false // pg jsonpath is not a document
  return /\bjsonb?\b/.test(t) // json, jsonb, Nullable(JSON), JSON NOT NULL…
}

/** `text` parses as a JSON object or array (a document, not a bare scalar). */
export function isJsonDocument(text: string): boolean {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return false
  try {
    const v = JSON.parse(t)
    return typeof v === 'object' && v !== null
  } catch {
    return false
  }
}

/** 'json' → write a parsed document · 'text' → write the text · 'none' → view only. */
export type JsonCellMode = 'json' | 'text' | 'none'

export function jsonCellMode(type: string | undefined | null, value: unknown): JsonCellMode {
  if (isJsonType(type)) return 'json'
  if (typeof value === 'string' && isJsonDocument(value)) return 'text'
  return 'none'
}

/** Show the `{ }` badge: a decoded document, or any non-null JSON column. */
export function hasJsonBadge(type: string | undefined | null, value: unknown): boolean {
  if (typeof value === 'object' && value !== null) return true
  return value !== null && value !== undefined && isJsonType(type)
}

/** Text the editor opens with. A json column is pretty-printed; a text column is
 *  shown exactly as stored, so saving never reformats it behind the user's back
 *  (the Format button is the explicit way to do that). */
export function toEditorText(value: unknown, mode: JsonCellMode): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    if (mode === 'json' && isJsonDocument(value)) return formatJson(value) ?? value
    return value
  }
  return JSON.stringify(value, null, 2)
}

/** Pretty-print `text`; null when it is not valid JSON. */
export function formatJson(text: string): string | null {
  const t = text.trim()
  if (t === '') return null
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return null
  }
}

/** Collapse `text` to one line; null when it is not valid JSON. */
export function minifyJson(text: string): string | null {
  const t = text.trim()
  if (t === '') return null
  try {
    return JSON.stringify(JSON.parse(t))
  } catch {
    return null
  }
}

export type JsonParse = { ok: true; value: unknown } | { ok: false; error: string }

/** Validate the editor text and produce the value to store. Empty → NULL. */
export function parseEditorText(text: string, mode: JsonCellMode): JsonParse {
  const t = text.trim()
  if (t === '') return { ok: true, value: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  // A text column keeps the user's own formatting — it stores the string as typed.
  return { ok: true, value: mode === 'text' ? t : parsed }
}

/** The stored value differs from the original (drives "unsaved change"). */
export function jsonValueChanged(next: unknown, original: unknown): boolean {
  return JSON.stringify(next ?? null) !== JSON.stringify(original ?? null)
}
