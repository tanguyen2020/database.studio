import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Right-side Object Properties panel: shows details of the object selected in the
// Explorer (columns for a table, type for a column, definition for a view).

test('properties panel shows selected table columns and column detail', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // Properties panel is hidden by default → open it via the collapsed handle
  await page.locator('[title="Show Properties panel"]').click()
  await expect(
    page.getByText('Select a table or column in the Explorer to view its properties'),
  ).toBeVisible()

  // connect + expand public → Tables
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)

  // select the `students` table → Properties shows a Columns section
  await page.getByRole('treeitem', { name: /students/ }).first().click()
  await page.waitForTimeout(300)
  const pp = page.locator('.pp')
  await expect(pp.getByText('Table', { exact: true })).toBeVisible()
  await expect(pp.getByText(/Columns/)).toBeVisible()
  await expect(pp.getByText('first_name')).toBeVisible()

  // expand the table, then select a column → Column detail (type) shows
  await page
    .getByRole('treeitem', { name: /students/ })
    .first()
    .getByRole('button')
    .first()
    .click()
  await page.waitForTimeout(300)
  await page.getByRole('treeitem', { name: /first_name/ }).first().click()
  await page.waitForTimeout(200)
  await expect(pp.getByText('Column', { exact: true }).first()).toBeVisible()
  await expect(pp.getByText('varchar(80)').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('properties panel shows a view definition', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.locator('[title="Show Properties panel"]').click()
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Views', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)

  // select a view → Definition section renders the fetched DDL
  await page.getByText(/vw_active_students/).first().click()
  await page.waitForTimeout(300)
  const pp = page.locator('.pp')
  await expect(pp.getByText('Definition', { exact: true })).toBeVisible()
  await expect(pp.locator('.pp-def')).toContainText('SELECT')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
