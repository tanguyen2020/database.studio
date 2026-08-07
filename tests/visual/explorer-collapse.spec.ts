import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// 1) The tree starts fully collapsed, every launch: expansion is session state only
//    (never persisted), and the schema list hangs off the current-database node, so
//    a fresh window shows closed nodes only.
// 2) Header icons next to Refresh expand / collapse the whole tree in one click.

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

test('explorer header: Expand all opens databases/schemas/folders, Collapse all closes everything', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(600)

  const expandAll = page.getByRole('button', { name: 'Expand all' })
  const collapseAll = page.getByRole('button', { name: 'Collapse all' })
  await expect(expandAll).toBeVisible()
  await expect(collapseAll).toBeVisible()

  await expandAll.click()
  await page.waitForTimeout(900)
  // current database + schema + object folders + the objects inside them
  await expect(page.getByRole('treeitem', { name: /current/ }).first()).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('treeitem', { name: /public/ }).first()).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /Tables/ }).first()).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /Views/ }).first()).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /students/ }).first()).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /vw_active_students/ }).first()).toBeVisible()

  await collapseAll.click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('treeitem', { name: /current/ }).first()).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('treeitem', { name: /public/ })).toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: /students/ })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('explorer header: MySQL databases collapse/expand the same way', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  // schema-as-database engine: databases sit at the root, collapsed
  await page.getByRole('button', { name: /MySQL localhost:3306/ }).first().click()
  await page.waitForTimeout(600)
  const db = page.getByRole('treeitem', { name: /public/ }).first()
  await expect(db).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('treeitem', { name: /Tables/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Expand all' }).click()
  await page.waitForTimeout(900)
  await expect(page.getByRole('treeitem', { name: /Tables/ }).first()).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /students/ }).first()).toBeVisible()

  await page.getByRole('button', { name: 'Collapse all' }).click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('treeitem', { name: /Tables/ })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('explorer header: Expand all is disabled where the header does not own the tree (Redis)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Cache Redis/ }).first().click()
  await page.waitForTimeout(600)
  await expect(page.getByRole('button', { name: 'Expand all' })).toHaveAttribute(
    'title',
    /not available/,
  )

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
