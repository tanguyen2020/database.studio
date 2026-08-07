import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Open Data (Table Data Viewer): the footer shows the record + page count in
// English, and the toolbar Refresh button carries a "Refresh" label (not just ⟳).
test('table viewer: footer shows records + pages (English) and Refresh has a label', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  // reach a table's data via the Objects tab (double-click schema → right-click row → Open Data)
  await page.getByRole('treeitem', { name: /public/ }).first().dblclick()
  await page.waitForTimeout(600)
  await page.getByRole('cell', { name: 'students', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open Data', exact: true }).click()
  await page.waitForTimeout(600)

  // toolbar Refresh button shows the word "Refresh"
  await expect(page.getByRole('button', { name: /Refresh/ }).first()).toBeVisible()

  // toolbar shows which database this viewer is bound to
  await expect(page.getByTitle('Database').first()).toBeVisible()

  // footer: total record count + total pages, all in English (demo COUNT(*) = 3,842)
  await expect(page.getByText(/of 3,842 records/)).toBeVisible()
  await expect(page.getByText(/Page 1 of/)).toBeVisible()
  // no leftover Vietnamese "trang"
  await expect(page.getByText(/trang/i)).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
