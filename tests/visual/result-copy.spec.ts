import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// AUDIT-3 item 5 — Result Grid right-click "Copy as ▸" offers all 6 formats.
test('result grid copy menu: raw + 6 extract formats', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)

  // right-click a data cell (skip the No. gutter at :first-child) → copy menu
  await page.locator('.grid-row td:not(:first-child)').first().click({ button: 'right' })
  await page.waitForTimeout(150)

  for (const label of ['Copy cell', 'Copy row', 'Copy column', 'Tab-separated', 'CSV', 'JSON', 'SQL INSERT', 'SQL UPDATE', 'Markdown table', 'XML']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible()
  }

  // the context menu uses DataGrip's font (bundled JetBrains Mono, via .mono)
  const fontFamily = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => d.textContent?.trim() === 'Copy cell')
    return el ? getComputedStyle(el).fontFamily : ''
  })
  expect(fontFamily).toContain('JetBrains Mono')

  // Copy XML actually writes well-formed XML to the clipboard (menu → formatClipboard
  // → navigator.clipboard). Read it back and parse it to prove the copy path works.
  await page.getByText('XML', { exact: true }).first().click()
  await page.waitForTimeout(200)
  const xml = await page.evaluate(() => navigator.clipboard.readText())
  expect(xml.startsWith('<?xml')).toBe(true)
  const shape = await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    return {
      err: !!doc.querySelector('parsererror'),
      rows: doc.querySelectorAll('rows > row').length,
      cols: doc.querySelectorAll('rows > row:first-child > col[name]').length,
    }
  }, xml)
  expect(shape.err).toBe(false)
  expect(shape.rows).toBeGreaterThan(0)
  expect(shape.cols).toBeGreaterThan(0)

  // right-clicking the No. (#) gutter opens the same copy menu (scoped to the row)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  await page.locator('.grid-row td:first-child').first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await expect(page.getByText('Copy row', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// The copy menu is tall (11 items). Because the result grid sits in the bottom
// panel, right-clicking a row opens the menu low on screen — it must clamp so the
// whole menu stays on screen (the last items, "XML", used to be clipped off).
test('result grid copy menu: stays fully inside the viewport', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)

  await page.locator('.grid-row td:not(:first-child)').last().click({ button: 'right' })
  await page.waitForTimeout(150)

  // the menu container (parent of the "Copy cell" item) fits entirely on screen
  const menu = page.getByText('Copy cell', { exact: true }).first().locator('..')
  const box = await menu.boundingBox()
  const vh = await page.evaluate(() => window.innerHeight)
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh)
  // the last item is visible (was clipped before)
  await expect(page.getByText('XML', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
