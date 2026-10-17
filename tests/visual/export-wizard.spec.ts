import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// T14 — Export wizard: table mode (from Explorer context) + result custom mode.

async function boot(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
}

test('Table Export wizard: format/columns/WHERE/limit/filename → download', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  // scope to the Explorer tree: a kept-alive (hidden) Objects tab also lists 'students'
  await page.getByRole('treeitem', { name: /students/ }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: 'Export Data…' }).click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  // header now shows the qualified target (db.schema.table)
  await expect(dialog.getByText(/Export .*students/)).toBeVisible()
  await expect(dialog.getByText(/Columns \(/)).toBeVisible()
  await expect(dialog.getByText('WHERE (optional)')).toBeVisible()
  await expect(dialog.getByText('Filename')).toBeVisible()

  // run export → CSV file download
  const dl = page.waitForEvent('download', { timeout: 8000 })
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  const download = await dl
  expect(download.suggestedFilename()).toContain('students')
  // CSV UTF-8 with BOM (Excel decodes non-ASCII correctly only with it)
  expect([...(await readFile((await download.path())!)).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  await expect(dialog.getByText(/exported \d+ rows/)).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Result Export ▾ offers XML and downloads an .xml file', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(300)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(300)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT id, gpa FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await expect(page.getByText('Single Row', { exact: true }).first()).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Export', exact: true }).first().click()
  await page.waitForTimeout(150)
  // XML is listed alongside CSV/JSON/SQL/Excel
  await expect(page.getByText('XML', { exact: true }).first()).toBeVisible()

  const dl = page.waitForEvent('download', { timeout: 8000 })
  await page.getByText('XML', { exact: true }).first().click()
  const download = await dl
  expect(download.suggestedFilename()).toMatch(/\.xml$/)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Result custom Export: run query → Export ▾ → Custom → download', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(300)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(300)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT id, gpa FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await expect(page.getByText('Single Row', { exact: true }).first()).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Export', exact: true }).first().click()
  await page.waitForTimeout(150)
  await page.getByText(/Custom…/).first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Export result')).toBeVisible()
  await expect(dialog.getByText(/Columns \(/)).toBeVisible()
  // result mode has no WHERE (rows already materialized)
  await expect(dialog.getByText('WHERE (optional)')).toHaveCount(0)

  const dl = page.waitForEvent('download', { timeout: 8000 })
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  const download = await dl
  expect(download.suggestedFilename()).toContain('result')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

/** Read a downloaded ZIP: entry name → { method, text } (inflating deflated entries). */
function unzipEntries(buf: Buffer): Record<string, { method: number; text: string }> {
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: Record<string, { method: number; text: string }> = {}
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nlen = buf.readUInt16LE(p + 28)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + csize)
    out[name] = { method, text: (method === 8 ? inflateRawSync(raw) : raw).toString('utf8') }
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return out
}

test('Excel export is a real .xlsx workbook; CSV is UTF-8 with BOM', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(300)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(300)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT id, gpa FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await expect(page.getByText('Single Row', { exact: true }).first()).toBeVisible({ timeout: 10_000 })

  // Export ▾ → Excel (.xlsx)
  await page.getByRole('button', { name: 'Export', exact: true }).first().click()
  await expect(page.getByText('Excel (.xls)', { exact: true })).toHaveCount(0)
  let dl = page.waitForEvent('download', { timeout: 8000 })
  await page.getByText('Excel (.xlsx)', { exact: true }).first().click()
  let download = await dl
  expect(download.suggestedFilename()).toBe('result.xlsx')
  const xlsx = await readFile((await download.path())!)
  expect(xlsx.subarray(0, 2).toString('latin1')).toBe('PK') // a ZIP, not an HTML table
  const parts = unzipEntries(xlsx)
  expect(Object.keys(parts)).toContain('xl/worksheets/sheet1.xml')
  expect(parts['[Content_Types].xml'].text).toContain('spreadsheetml.sheet.main+xml')
  const sheet = parts['xl/worksheets/sheet1.xml']
  expect(sheet.method).toBe(8) // deflated in the browser engine
  expect(sheet.text).toContain('<t xml:space="preserve">gpa</t>')
  expect(sheet.text).toMatch(/<c r="C2"><v>[\d.]+<\/v><\/c>/) // numeric gpa column → real number
  if (process.env.XLSX_OUT) await writeFile(process.env.XLSX_OUT, xlsx)

  // Export ▾ → CSV starts with the UTF-8 BOM
  await page.getByRole('button', { name: 'Export', exact: true }).first().click()
  dl = page.waitForEvent('download', { timeout: 8000 })
  await page.getByText('CSV', { exact: true }).first().click()
  download = await dl
  const csv = await readFile((await download.path())!)
  expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  expect(csv.subarray(3).toString('utf8').startsWith('id,')).toBe(true)

  // Custom… wizard offers Excel (.xlsx) and names the file accordingly
  await page.getByRole('button', { name: 'Export', exact: true }).first().click()
  await page.getByText(/Custom…/).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('Excel (.xlsx)').click()
  await expect(dialog.locator('input.mono').last()).toHaveValue('result.xlsx')
  dl = page.waitForEvent('download', { timeout: 8000 })
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  download = await dl
  expect(download.suggestedFilename()).toBe('result.xlsx')
  expect((await readFile((await download.path())!)).subarray(0, 2).toString('latin1')).toBe('PK')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
