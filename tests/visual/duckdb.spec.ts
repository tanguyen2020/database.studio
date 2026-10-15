import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// DuckDB — an embedded analytical database (a .duckdb file or :memory:). The
// Explorer shows it like PostgreSQL (current database → schemas), ATTACHed files
// as other databases, macros under Functions, and no Stored Procedures / Triggers
// (DuckDB has neither). Demo answers come from src/lib/duckdb/demo.ts, enabled
// with `?duckdb=1` so every other spec keeps its connection list.

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  url.searchParams.set('duckdb', '1')
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  return errors
}

const treeRow = (page: Page, name: string | RegExp) => page.getByRole('treeitem').filter({ hasText: name })

test('duckdb: sidebar entry shows the file, explorer shows database → schemas → DuckDB folders', async ({ page }) => {
  const errors = await open(page)

  const conn = page.getByRole('button', { name: /Warehouse DuckDB/ })
  await expect(conn).toBeVisible()
  await expect(conn).toContainText('/data/warehouse.duckdb')
  await conn.click()

  // current database node (the opened file) + the ATTACHed one beside it
  await expect(page.getByRole('treeitem', { name: /warehouse.*current$/ })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /lake database$/ })).toBeVisible()
  await openDatabaseNode(page)
  await expect(treeRow(page, 'main').first()).toBeVisible()
  await expect(treeRow(page, 'staging')).toBeVisible()

  await treeRow(page, 'main').first().dblclick()
  await expect(treeRow(page, 'Tables').first()).toBeVisible()
  await expect(treeRow(page, 'Views').first()).toBeVisible()
  await expect(treeRow(page, 'Functions').first()).toBeVisible()
  await expect(treeRow(page, 'Sequences').first()).toBeVisible()
  // DuckDB has no stored procedures and no triggers
  await expect(treeRow(page, 'Stored Procedures')).toHaveCount(0)
  await expect(treeRow(page, 'Triggers')).toHaveCount(0)

  await treeRow(page, 'Tables').first().dblclick()
  await expect(treeRow(page, 'events').first()).toBeVisible()
  await treeRow(page, 'Functions').first().dblclick()
  await expect(treeRow(page, 'add_tax').first()).toBeVisible()

  // a database is an attached file: Detach, no New Database
  await page.getByRole('treeitem', { name: /warehouse.*current$/ }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Detach Database…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Drop Database…' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'New Database…' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'New Schema…' })).toBeVisible()
  await page.keyboard.press('Escape')

  // the attached database expands through its own sub-connection
  await page.getByRole('treeitem', { name: /lake database$/ }).dblclick()
  await expect(page.getByRole('treeitem', { name: /lake database$/ })).toHaveAttribute('aria-expanded', 'true')
  await expect(treeRow(page, 'trips')).toHaveCount(0) // its schema is still collapsed
  expect(errors).toEqual([])
})

test('duckdb: a query tab gets the Database + Schema pickers and runs', async ({ page }) => {
  const errors = await open(page)
  await page.getByRole('button', { name: /Warehouse DuckDB/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New Query Console' }).click()
  await expect(page.locator('input[title="Database"]:visible')).toBeVisible()
  await expect(page.locator('input[title="Schema"]:visible')).toBeVisible()
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT 1')
  await page.keyboard.press('F5')
  await expect(page.getByText(/Rows 1–/).first()).toBeVisible({ timeout: 8000 })
  expect(errors).toEqual([])
})

test('duckdb: new connection form asks for a file + mode, not a server login', async ({ page }) => {
  await open(page)
  await page.getByTitle('New connection').first().click()
  await page.locator('.picker-card[title="DuckDB"]').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.cm-label', { hasText: 'Database file' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /Browse/ })).toBeVisible()
  await expect(dialog.locator('.cm-label', { hasText: /^Mode$/ })).toBeVisible()
  await expect(dialog.getByText(/DuckDB is an embedded analytical database/)).toBeVisible()
  // no user / password / database fields — DuckDB has no server login
  await expect(dialog.locator('.cm-label', { hasText: /^User$/ })).toHaveCount(0)
  await expect(dialog.locator('.cm-label', { hasText: /^Password/ })).toHaveCount(0)
  await expect(dialog.locator('.cm-label', { hasText: /^Database$/ })).toHaveCount(0)
  // in-memory disables the path
  await dialog.locator('.cm-label', { hasText: /^Mode$/ }).locator('xpath=..').locator('select').selectOption('in-memory')
  await expect(dialog.locator('input[placeholder="/data/analytics.duckdb"]')).toBeDisabled()
})
