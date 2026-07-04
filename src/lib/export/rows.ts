// Export helpers (Phase 5 · T5 + T7b) — CSV / JSON / SQL INSERT. Thuần → test được.

/** Escape 1 ô CSV (RFC 4180): bọc "" nếu chứa , " newline; nhân đôi ". */
export function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Sinh CSV từ headers + rows (mỗi row là object keyed theo header). */
export function toCsv(headers: string[], rows: Record<string, unknown>[], delimiter = ','): string {
  const head = headers.map(csvCell).join(delimiter)
  const body = rows.map((r) => headers.map((h) => csvCell(r[h])).join(delimiter)).join('\n')
  return body ? `${head}\n${body}` : head
}

export function toJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2)
}

/** Sinh câu INSERT (quoting literal cơ bản). Dùng cho export "SQL INSERT". */
export function toSqlInsert(table: string, headers: string[], rows: Record<string, unknown>[]): string {
  const cols = headers.map((h) => `"${h}"`).join(', ')
  return rows
    .map((r) => {
      const vals = headers.map((h) => sqlLiteral(r[h])).join(', ')
      return `INSERT INTO "${table}" (${cols}) VALUES (${vals});`
    })
    .join('\n')
}

function sqlLiteral(v: unknown): string {
  if (v == null) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return `'${s.replace(/'/g, "''")}'`
}

/** Trigger download 1 blob text trong browser (dùng ở component). */
export function download(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
