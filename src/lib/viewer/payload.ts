// What a message payload IS, for the payload viewer: valid JSON or not, its pretty
// and compact forms, and the numbers worth showing (size, lines, keys / items).
// Pure → unit-testable; the dialog only renders it.

export type PayloadShape = 'object' | 'array' | 'value' | 'text' | 'empty'

export interface PayloadInfo {
  isJson: boolean
  shape: PayloadShape
  /** pretty-printed JSON (2-space), or the raw text when it is not JSON */
  pretty: string
  /** the payload exactly as received */
  raw: string
  /** size in bytes (UTF-8) */
  bytes: number
  /** lines of the text the viewer shows by default (pretty) */
  lines: number
  /** top-level keys of an object / items of an array */
  count?: number
}

export function analyzePayload(raw: string): PayloadInfo {
  const bytes = new TextEncoder().encode(raw).length
  if (raw.trim() === '') {
    return { isJson: false, shape: 'empty', pretty: raw, raw, bytes, lines: raw ? raw.split('\n').length : 0 }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { isJson: false, shape: 'text', pretty: raw, raw, bytes, lines: raw.split('\n').length }
  }
  const pretty = JSON.stringify(parsed, null, 2)
  const shape: PayloadShape = Array.isArray(parsed)
    ? 'array'
    : parsed !== null && typeof parsed === 'object'
      ? 'object'
      : 'value'
  const count =
    shape === 'array' ? (parsed as unknown[]).length : shape === 'object' ? Object.keys(parsed as object).length : undefined
  return { isJson: true, shape, pretty, raw, bytes, lines: pretty.split('\n').length, count }
}

/** 1 B · 12.4 KB · 3.1 MB — the viewer's size chip. */
export function payloadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "3 keys" / "12 items" / "" — what the JSON holds at its top level. */
export function payloadCount(info: PayloadInfo): string {
  if (info.count === undefined) return ''
  if (info.shape === 'object') return `${info.count} key${info.count === 1 ? '' : 's'}`
  return `${info.count} item${info.count === 1 ? '' : 's'}`
}
