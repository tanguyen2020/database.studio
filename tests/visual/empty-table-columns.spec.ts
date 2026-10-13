import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Open Data on a table that holds NO rows must still show the columns of the
// table. The drivers used to read the column headers off the FIRST ROW of the
// result, so an empty table came back with `cols: []` and the viewer rendered
// nothing but the "#" row-number gutter (fixed in the pg/mysql/mssql
// `exec_params` paths; pinned on real engines by
// `*_empty_table_still_reports_its_columns` in drivers_integration.rs).
//
// This spec pins the UI half of that contract: given columns and zero rows, the
// grid draws the header and says the table is empty.
test('table viewer: an empty table still shows its columns', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(`${APP_URL}?emptyTable=1`)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  // Open Data via the Objects tab (double-click schema → right-click row)
  await page.getByRole('treeitem', { name: /public/ }).first().dblclick()
  await page.waitForTimeout(600)
  await page.getByRole('cell', { name: 'students', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open Data', exact: true }).click()
  await page.waitForTimeout(700)

  // every column of the table is in the grid header, with its type
  const head = page.locator('thead').last()
  for (const col of ['id', 'first_name', 'gpa', 'config', 'prefs_text']) {
    await expect(head.getByText(col, { exact: false }).first()).toBeVisible()
  }
  // …and the header carries more than the row-number gutter alone (the bug)
  const headerCells = await head.locator('th').count()
  expect(headerCells, 'gutter + one th per column').toBe(6)

  // no rows, said plainly, and the footer agrees
  await expect(page.getByText('0 rows', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/of 0 rows/)).toBeVisible()

  // the columns feed the rest of the viewer: sort bar + filter column picker
  await expect(page.getByRole('button', { name: /^first_name/ }).first()).toBeVisible()

  // and a row can be added to the empty table — the insert row has real columns
  await page.getByRole('button', { name: /Insert row/ }).first().click()
  await page.waitForTimeout(200)
  const insertCells = await page.locator('tbody tr').last().locator('td').count()
  expect(insertCells, 'gutter + one cell per column on the pending insert row').toBe(6)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
