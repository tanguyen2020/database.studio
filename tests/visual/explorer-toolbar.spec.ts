import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// The Explorer bottom toolbar (Query / Import / Backup / Sessions / Users — 5 .xbtn
// buttons) is disabled until a relational schema/database node is selected, then acts
// on THAT schema. Non-relational connections never expose such a node → the whole
// toolbar stays disabled. Exception: "New query console" only needs a database/schema
// NAME, so it also enables when an object (table/view/routine) row is selected.
test('explorer bottom toolbar: enabled only when a relational schema is selected', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)

  // connection selected but no schema node picked → all 5 toolbar buttons disabled
  await expect(page.locator('.xbtn.off')).toHaveCount(5)
  await expect(page.getByTitle('Select a schema / database first').first()).toBeVisible()

  // the tree starts collapsed — open the database node to reach its schemas
  await openDatabaseNode(page)

  // pick the 'public' schema → toolbar enables and reflects the target
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await expect(page.locator('.xbtn.off')).toHaveCount(0)
  await expect(page.getByTitle(/Import data:/)).toBeVisible()

  // selecting an OBJECT inside the schema keeps the schema-scoped tools disabled but
  // leaves "New query console" live (it binds that object's database + schema)
  await page.getByRole('treeitem', { name: /public/ }).first().getByRole('button').first().click() // expand schema
  await page.waitForTimeout(500)
  await page.getByRole('treeitem', { name: /Tables/ }).first().getByRole('button').first().click()
  await page.waitForTimeout(500)
  await page.getByRole('treeitem', { name: /\bstudents\b/ }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByTitle('Query console: app.public')).toBeVisible()
  await expect(page.locator('.xbtn.off')).toHaveCount(4)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('explorer bottom toolbar: disabled for a non-relational (Kafka) connection', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Events Kafka/ }).first().click()
  await page.waitForTimeout(500)

  // no relational schema node exists for Kafka → all 5 toolbar buttons stay disabled
  await expect(page.locator('.xbtn.off')).toHaveCount(5)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
