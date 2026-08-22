import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// AUDIT-5 items 1 + 10 — Query Editor shows a database dropdown; picking a DB
// updates the toolbar label (the tab now targets that database).
test('query editor database dropdown selects a database', async ({ page }) => {
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
  await page.waitForTimeout(300)

  // the database combobox is visible next to the connection dropdown
  const dbChip = page.getByTitle('Database', { exact: true }).first()
  await expect(dbChip).toBeVisible()
  await dbChip.click()
  await page.waitForTimeout(150)
  // demo list_databases → app / analytics / postgres. Pick via the combobox option
  // (role=option is unique to the open menu, unlike the sidebar text).
  await page.getByRole('option', { name: 'analytics' }).first().click()
  await page.waitForTimeout(150)
  await expect(dbChip).toHaveValue('analytics')

  // Running against the picked database must NOT report "Tab has no connection":
  // the run resolves through an attached sub-connection (base::analytics).
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)
  await expect(page.locator('.grid-row').first()).toBeVisible()
  await expect(page.getByText('Tab has no connection', { exact: true })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Bug report (post-batch-2) — context menus on the database node and foreign-db
// tables were missing for PG/MSSQL. Right-clicking a foreign database now opens a
// menu (New Query / Refresh …).
test('foreign database node has a context menu', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  // demo list_databases: current 'app' → foreign 'analytics','postgres' listed as
  // database nodes in the tree. Right-click one → context menu.
  await page.getByRole('treeitem', { name: /analytics database/ }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await expect(page.getByText('New Query', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Copy Name', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Rename…', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// User request — Views/Procedures/Functions/Triggers folders each expose a
// "Create <type>…" context menu.
test('object folders offer Create <type>', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick() // expand schema → folders appear
  await page.waitForTimeout(400)

  await page.getByText('Stored Procedures', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await expect(page.getByText('Create Procedure…', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// User request — Design Table shows the connection + database it targets.
test('table designer header shows connection and database', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().click({ button: 'right' }) // schema menu
  await page.waitForTimeout(200)
  await page.getByText('New Table…', { exact: true }).first().click()
  await page.waitForTimeout(400)

  // header shows the connection name (demo 'Postgres') and the schema
  await expect(page.getByRole('tab', { name: /new_table/ }).first()).toBeVisible()
  await expect(page.getByText('Postgres', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// User request — Rename in the context menu for database and table names. It opens
// a popup (focused input + live statement), not a SQL tab; see rename-database.spec.
test('rename database from the current-db header context menu', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  await page.getByRole('treeitem', { name: /app current/ }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Rename…', { exact: true }).first().click()
  await page.waitForTimeout(300)
  // a popup with the new name focused, showing the exact ALTER it will run
  const dialog = page.getByRole('dialog', { name: 'Rename database' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#rn-db')).toBeFocused()
  await expect(dialog).toContainText('ALTER DATABASE')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// AUDIT-5 item 2 — Result Grid has a "No." gutter column (row numbers).
test('result grid shows a No. gutter column', async ({ page }) => {
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
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)

  // the No. gutter is the first cell of each row (row number, right-aligned)
  await expect(page.locator('.grid-row td:first-child').first()).toHaveText('1')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
