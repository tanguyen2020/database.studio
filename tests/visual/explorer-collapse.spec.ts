import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The tree starts fully collapsed, every launch: expansion is session state only
// (never persisted), and the schema list hangs off the current-database node. Nodes
// open one at a time — by double-click or by their chevron; the header offers no
// bulk expand/collapse.

async function boot(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
}

test('explorer starts collapsed and stays collapsed after a restart', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(600)

  // the current database shows as a CLOSED node — its schemas are hidden
  const curDb = page.getByRole('treeitem', { name: /current/ }).first()
  await expect(curDb).toBeVisible()
  await expect(curDb).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('treeitem', { name: /public/ })).toHaveCount(0)

  // opening it reveals the schemas
  await curDb.dblclick()
  await page.waitForTimeout(400)
  await expect(curDb).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('treeitem', { name: /public/ }).first()).toBeVisible()

  // reload = relaunch: back to collapsed, nothing remembered
  await page.reload()
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(600)
  await expect(page.getByRole('treeitem', { name: /current/ }).first()).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('treeitem', { name: /public/ })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('explorer header has no bulk expand/collapse — nodes open one at a time', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  // schema-as-database engine: databases sit at the root, collapsed
  await page.getByRole('button', { name: /MySQL localhost:3306/ }).first().click()
  await page.waitForTimeout(600)

  // Refresh is the only header action left
  await expect(page.getByRole('button', { name: 'Expand all' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Collapse all' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Refresh', exact: true }).first()).toBeVisible()

  const db = page.getByRole('treeitem', { name: /public/ }).first()
  await expect(db).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('treeitem', { name: /Tables/ })).toHaveCount(0)

  // double-click opens the database, then its Tables folder
  await db.dblclick()
  await page.waitForTimeout(600)
  await expect(db).toHaveAttribute('aria-expanded', 'true')
  const tables = page.getByRole('treeitem', { name: /Tables/ }).first()
  await expect(tables).toBeVisible()
  await tables.dblclick()
  await page.waitForTimeout(400)
  await expect(page.getByRole('treeitem', { name: /students/ }).first()).toBeVisible()

  // the chevron closes it again
  await db.locator('span[role="button"]').first().click()
  await page.waitForTimeout(300)
  await expect(db).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('treeitem', { name: /Tables/ })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
