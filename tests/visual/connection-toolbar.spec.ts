import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// The sidebar "View ER" + "Generate Scripts (DDL)" toolbar buttons are disabled until
// a schema/database node (public / dbo / a database) is selected in the Explorer, then
// they open the ER tab / Generate Scripts popup for that schema.
test('connections toolbar: ER + DDL enable only when a schema is selected', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select a Postgres connection — no schema picked yet → buttons disabled
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByTitle('View ER diagram (select a database or schema first)')).toBeVisible()
  await expect(page.getByTitle('Generate scripts (select a database or schema first)')).toBeVisible()
  // open the database node (the tree starts collapsed) to reach its schemas
  await openDatabaseNode(page)

  // pick the 'public' schema → both buttons enable (titles switch to the schema name)
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(200)
  const erBtn = page.getByTitle('View ER diagram of public')
  await expect(erBtn).toBeVisible()
  await expect(page.getByTitle('Generate scripts for public')).toBeVisible()

  // View ER → opens the ER tab for that schema
  await erBtn.click()
  await page.waitForTimeout(700)
  await expect(page.getByRole('tab', { name: /ER · public/ }).first()).toBeVisible()

  // Generate Scripts → opens the existing scripts popup for that schema
  await page.getByTitle('Generate scripts for public').click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('dialog').getByText(/Generate Scripts ·/)).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
