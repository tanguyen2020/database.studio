import { describe, it, expect } from 'vitest'
import { toXlsx, crc32, colName, cellXml, sheetName, xmlText, numericColumns, bytesToBase64, zip, XLSX_MAX_ROWS } from './xlsx'
import { toCsv, withBom, CSV_BOM } from './rows'

/** Minimal independent ZIP reader: walks the central directory, inflates/copies
 *  each entry and verifies its CRC — the same checks Excel does on open. */
async function unzip(buf: Uint8Array): Promise<Record<string, string>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = buf.length - 22
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--
  expect(eocd).toBeGreaterThanOrEqual(0)
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50)
    const method = dv.getUint16(p + 10, true)
    const crc = dv.getUint32(p + 16, true)
    const csize = dv.getUint32(p + 20, true)
    const usize = dv.getUint32(p + 24, true)
    const nlen = dv.getUint16(p + 28, true)
    const xlen = dv.getUint16(p + 30, true)
    const clen = dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen))
    expect(dv.getUint32(local, true)).toBe(0x04034b50)
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
    const raw = buf.subarray(start, start + csize)
    const data =
      method === 8
        ? new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
        : raw
    expect(data.length).toBe(usize)
    expect(crc32(data)).toBe(crc)
    out[name] = new TextDecoder().decode(data)
    p += 46 + nlen + xlen + clen
  }
  return out
}

describe('xlsx export', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('column letters', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA'])
  })

  it('builds a valid workbook package (stored and deflated)', async () => {
    for (const compress of [false, true]) {
      const bytes = await toXlsx(['id', 'name'], [{ id: 1, name: 'Nguyễn Văn A' }], { sheet: 'students', compress })
      expect(bytes[0]).toBe(0x50) // "PK"
      const files = await unzip(bytes)
      expect(Object.keys(files).sort()).toEqual([
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
      ])
      expect(files['xl/workbook.xml']).toContain('<sheet name="students"')
      const sheet = files['xl/worksheets/sheet1.xml']
      expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">id</t></is></c>')
      expect(sheet).toContain('<c r="A2"><v>1</v></c>')
      expect(sheet).toContain('Nguyễn Văn A') // UTF-8 survives
      expect(sheet).toContain('<autoFilter ref="A1:B2"/>')
    }
  })

  it('writes numbers, booleans, NULL and JSON the Excel way', () => {
    expect(cellXml('A1', 3.5)).toBe('<c r="A1"><v>3.5</v></c>')
    expect(cellXml('A1', true)).toBe('<c r="A1" t="b"><v>1</v></c>')
    expect(cellXml('A1', null)).toBe('')
    expect(cellXml('A1', { a: 1 })).toContain('{&quot;a&quot;:1}')
    // a DECIMAL that arrives as text: number only when the column is numeric
    expect(cellXml('A1', '12.50', true)).toBe('<c r="A1"><v>12.5</v></c>')
    expect(cellXml('A1', '12.50', false)).toContain('t="inlineStr"')
    // precision would be lost / codes would lose their leading zeros → stay text
    expect(cellXml('A1', '123456789012345678', true)).toContain('t="inlineStr"')
    expect(cellXml('A1', '00123', true)).toContain('t="inlineStr"')
    expect(cellXml('A1', 12345678901234567890n)).toContain('t="inlineStr"')
  })

  it('strips characters XML forbids and escapes the rest', () => {
    expect(xmlText('a\u0000b<c>&"')).toBe('ab&lt;c&gt;&amp;&quot;')
  })

  it('sanitizes sheet names', () => {
    expect(sheetName('a/b:c?*[x]')).toBe('a_b_c___x_')
    expect(sheetName('x'.repeat(40))).toHaveLength(31)
    expect(sheetName('  ')).toBe('Sheet1')
  })

  it('detects numeric columns from declared types', () => {
    const n = numericColumns([['id', 'int4'], ['price', 'numeric(10,2)'], ['name', 'varchar'], ['ok', 'boolean']])
    expect([...n].sort()).toEqual(['id', 'price'])
  })

  it('refuses more rows than an Excel sheet holds instead of truncating', async () => {
    const rows = { length: XLSX_MAX_ROWS } as unknown as Record<string, unknown>[]
    await expect(toXlsx(['a'], rows)).rejects.toThrow(/at most/)
  })

  it('base64 round-trips large binary', async () => {
    const big = await zip([{ name: 'x.txt', data: new Uint8Array(200_000).fill(65) }], false)
    const back = Uint8Array.from(atob(bytesToBase64(big)), (c) => c.charCodeAt(0))
    expect(back).toEqual(big)
  })
})

describe('CSV UTF-8 with BOM', () => {
  it('prefixes the BOM exactly once', () => {
    const csv = withBom(toCsv(['name'], [{ name: 'Đà Nẵng' }]))
    expect(csv.startsWith(CSV_BOM)).toBe(true)
    expect(withBom(csv)).toBe(csv)
    expect([...new TextEncoder().encode(csv).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })
})
