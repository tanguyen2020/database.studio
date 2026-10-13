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

export function sqlLiteral(v: unknown): string {
  if (v == null) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return `'${s.replace(/'/g, "''")}'`
}

/** Parse CSV (RFC 4180: quoted fields, "" escape, \n/\r\n) → headers + rows.
 *  Thuần → unit-test được. Dùng cho Import wizard. */
export function parseCsv(
  text: string,
  delimiter = ',',
): { headers: string[]; rows: string[][] } {
  const records: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let i = 0
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    records.push(row)
    row = []
  }
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  while (i < s.length) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
    } else if (ch === '"') {
      inQuotes = true
      i++
    } else if (ch === delimiter) {
      pushField()
      i++
    } else if (ch === '\n') {
      pushRow()
      i++
    } else {
      field += ch
      i++
    }
  }
  if (field.length > 0 || row.length > 0) pushRow()
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0].trim() === ''))
  const headers = nonEmpty.shift() ?? []
  return { headers, rows: nonEmpty }
}

/** UTF-8 byte-order mark. Exported CSV is "CSV UTF-8 (with BOM)": without it
 *  Excel decodes the file as the local ANSI code page and Vietnamese / CJK text
 *  turns into mojibake. */
export const CSV_BOM = '\uFEFF'

/** Prefix the BOM exactly once (a caller may already have added it). */
export function withBom(csv: string): string {
  return csv.startsWith(CSV_BOM) ? csv : CSV_BOM + csv
}

/** Trigger download 1 blob text trong browser (dùng ở component). */
export function download(filename: string, content: string | Uint8Array, mime = 'text/plain') {
  const blob = new Blob([content as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a) // a detached anchor's download can be dropped by Chromium
  a.click()
  a.remove()
  // Revoking synchronously races the browser's fetch of the blob and can cancel
  // the download; release it once the download has surely started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
