import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// "Drop Database…" in the explorer context menu must CONFIRM (in-app dialog showing
// the exact statement) and then RUN the drop + re-read the connection's tree —
// it used to only open the DDL in a SQL tab for the user to execute by hand.
const calls = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls ?? {})

test('foreign database: Drop Database asks first, then drops and refreshes the tree', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  const foreign = page.getByRole('treeitem', { name: /analytics/ }).first()
  await expect(foreign).toBeVisible()
  // expand it so an attached sub-connection exists — the drop has to close that
  // session first (PostgreSQL refuses to drop a database that still has sessions)
  await foreign.dblclick()
  await page.waitForTimeout(800)

  await foreign.click({ button: 'right' })
  await page.waitForTimeout(200)
  const item = page.getByRole('menuitem', { name: 'Drop Database…' })
  await expect(item).toBeVisible()
  await item.click()
  await page.waitForTimeout(300)

  // a confirm dialog — NOT a SQL tab — and it states the statement verbatim
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Drop database')
  await expect(dialog).toContainText('DROP DATABASE IF EXISTS "analytics";')
  await expect(page.getByRole('tab', { name: /Drop database/ })).toHaveCount(0)

  // backdrop click must not confirm (project-wide rule for form/confirm popups)
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()

  // Cancel runs nothing
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await calls(page)).exec_statement ?? 0).toBe(0)
  await expect(page.getByRole('treeitem', { name: /analytics/ }).first()).toBeVisible()

  // Confirm → the DROP really runs and the tree is re-read from the server
  const schemasBefore = (await calls(page)).list_schemas ?? 0
  await foreign.click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: 'Drop Database…' }).click()
  await page.waitForTimeout(200)
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
  await page.waitForTimeout(1200)

  const after = await calls(page)
  expect(after.exec_statement ?? 0).toBe(1)
  expect(after.close_tab_connection ?? 0).toBeGreaterThan(0) // attached session closed first
  expect(after.list_databases ?? 0).toBeGreaterThan(0)
  expect(after.list_schemas ?? 0).toBeGreaterThan(schemasBefore) // tree reloaded
  // the dropped database is gone from the tree, the others remain
  await expect(page.getByRole('treeitem', { name: /analytics/ })).toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: /postgres/ }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('schema-as-database engines confirm and drop too (MySQL database node)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /MySQL localhost:3306/ }).first().click()
  await page.waitForTimeout(600)

  // MySQL/MariaDB/ClickHouse list databases as schemas → the schema node IS a database
  const db = page.getByRole('treeitem', { name: /public/ }).first()
  await expect(db).toBeVisible()
  await db.click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: 'Drop Database…' }).click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('DROP DATABASE IF EXISTS `public`;') // MySQL quoting
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await page.waitForTimeout(1200)

  expect((await calls(page)).exec_statement ?? 0).toBe(1)
  await expect(page.getByRole('treeitem', { name: /public/ })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
