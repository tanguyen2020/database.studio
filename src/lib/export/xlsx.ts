// Real Excel export (.xlsx, Office Open XML) without a dependency.
//
// An .xlsx file is a ZIP of a handful of XML parts. We write the minimum Excel
// accepts without a repair prompt: [Content_Types].xml, _rels/.rels,
// xl/workbook.xml (+ its rels), xl/styles.xml (bold header) and one worksheet
// with inline strings (no sharedStrings part needed). The ZIP is deflated with
// the platform's CompressionStream when available, otherwise STORED — both
// are valid ZIP entries.

/** Excel's hard limits (Office spec): rows per sheet and characters per cell. */
export const XLSX_MAX_ROWS = 1_048_576
export const XLSX_MAX_CELL_CHARS = 32_767

import { classifyType } from '$lib/copy/types'

const enc = new TextEncoder()
const NUMERIC_FAMILIES = new Set(['int', 'bigint', 'float', 'decimal'])

// ── XML helpers ────────────────────────────────────────────────────────────────

/** Escape for XML text and drop characters XML 1.0 forbids (control chars other
 *  than tab/newline/CR) — one stray \u0000 in a DB value otherwise corrupts the file. */
export function xmlText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 0 → A, 25 → Z, 26 → AA … (column letters). */
export function colName(i: number): string {
  let s = ''
  let n = i + 1
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// Plain decimal/scientific; ≤15 significant digits so Excel's double keeps the
// exact value (an 18-digit id would otherwise silently become …000).
const NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
function safeNumber(s: string): number | null {
  if (!NUMERIC_RE.test(s)) return null
  const digits = s.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '').replace(/^0+/, '')
  if (digits.length > 15) return null
  // "007" is a code, not a number — keep leading zeros as text.
  if (/^-?0\d/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** One cell's XML. Numbers (JS numbers, or numeric strings in a numeric column)
 *  become real Excel numbers; booleans become TRUE/FALSE; NULL is an empty cell;
 *  everything else is an inline string. */
export function cellXml(ref: string, v: unknown, numeric = false, style = 0): string {
  const s = style ? ` s="${style}"` : ''
  if (v == null || v === '') return ''
  if (typeof v === 'number') {
    return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : inlineStr(ref, String(v), s)
  }
  if (typeof v === 'bigint') {
    const n = safeNumber(v.toString())
    return n == null ? inlineStr(ref, v.toString(), s) : `<c r="${ref}"${s}><v>${n}</v></c>`
  }
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (numeric) {
    const n = safeNumber(text.trim())
    if (n != null) return `<c r="${ref}"${s}><v>${n}</v></c>`
  }
  return inlineStr(ref, text, s)
}

function inlineStr(ref: string, text: string, s: string): string {
  const t = text.length > XLSX_MAX_CELL_CHARS ? text.slice(0, XLSX_MAX_CELL_CHARS) : text
  // xml:space="preserve" keeps leading/trailing spaces Excel would otherwise trim.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(t)}</t></is></c>`
}

/** The worksheet XML for headers + rows. Header row is bold (style 1) and frozen. */
export function sheetXml(
  headers: string[],
  rows: Record<string, unknown>[],
  numericCols: ReadonlySet<string> = new Set(),
): string {
  const refs = headers.map((_, i) => colName(i))
  const numeric = headers.map((h) => numericCols.has(h))
  const out: string[] = []
  out.push(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    '<sheetData>',
  )
  out.push(`<row r="1">${headers.map((h, i) => inlineStr(`${refs[i]}1`, h, ' s="1"')).join('')}</row>`)
  for (let r = 0; r < rows.length; r++) {
    const n = r + 2
    const row = rows[r]
    let cells = ''
    for (let c = 0; c < headers.length; c++) cells += cellXml(`${refs[c]}${n}`, row[headers[c]], numeric[c])
    out.push(`<row r="${n}">${cells}</row>`)
  }
  out.push('</sheetData>')
  if (headers.length) out.push(`<autoFilter ref="A1:${refs[headers.length - 1]}${rows.length + 1}"/>`)
  out.push('</worksheet>')
  return out.join('')
}

/** Sheet names: ≤31 chars, none of : \ / ? * [ ] (Excel rejects the file otherwise). */
export function sheetName(name: string): string {
  const s = name.replace(/[:\\/?*[\]]/g, '_').trim().slice(0, 31)
  return s || 'Sheet1'
}

function staticParts(name: string): Record<string, string> {
  return {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${xmlText(sheetName(name))}" sheetId="1" r:id="rId1"/></sheets>` +
      '</workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
    'xl/styles.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '</styleSheet>',
  }
}

// ── ZIP writer ─────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null // older engine without 'deflate-raw' → store
  }
}

/** Build a ZIP archive. Entries are deflated when the platform can, else stored. */
export async function zip(files: { name: string; data: Uint8Array }[], compress = true): Promise<Uint8Array> {
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.data)
    const deflated = compress ? await deflateRaw(f.data) : null
    const body = deflated ?? f.data
    const method = deflated ? 8 : 0
    const lh = new Uint8Array(30 + name.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0x0800, true) // UTF-8 names
    lv.setUint16(8, method, true)
    lv.setUint16(10, 0, true) // time
    lv.setUint16(12, 0x21, true) // date 1980-01-01
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, f.data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    lh.set(name, 30)

    const ch = new Uint8Array(46 + name.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, f.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    ch.set(name, 46)

    local.push(lh, body)
    central.push(ch)
    offset += lh.length + body.length
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const out = new Uint8Array(offset + cdSize + end.length)
  let p = 0
  for (const part of [...local, ...central, end]) {
    out.set(part, p)
    p += part.length
  }
  return out
}

// ── Public API ─────────────────────────────────────────────────────────────────

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Build a complete .xlsx workbook (one sheet). Throws if the result exceeds
 *  Excel's row limit — silently truncating a data export is worse than refusing. */
export async function toXlsx(
  headers: string[],
  rows: Record<string, unknown>[],
  opts: { sheet?: string; numericCols?: ReadonlySet<string>; compress?: boolean } = {},
): Promise<Uint8Array> {
  if (rows.length + 1 > XLSX_MAX_ROWS) {
    throw new Error(
      `Excel holds at most ${XLSX_MAX_ROWS.toLocaleString()} rows per sheet; this export has ${rows.length.toLocaleString()}. Use CSV instead.`,
    )
  }
  const parts = staticParts(opts.sheet ?? 'Sheet1')
  const files = Object.entries(parts).map(([name, xml]) => ({ name, data: enc.encode(xml) }))
  files.push({ name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml(headers, rows, opts.numericCols)) })
  return zip(files, opts.compress ?? true)
}

/** Base64 of binary data, chunked so a multi-MB workbook doesn't blow the
 *  argument limit of String.fromCharCode. */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

/** Columns whose declared type is numeric — their string values (DECIMAL,
 *  BIGINT from drivers that return text) are written as real Excel numbers. */
export function numericColumns(cols: [string, string][]): Set<string> {
  const out = new Set<string>()
  for (const [name, type] of cols) if (NUMERIC_FAMILIES.has(classifyType(type ?? ''))) out.add(name)
  return out
}
