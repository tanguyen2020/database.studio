import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The query editor's autocomplete must suggest the tables of the ACTIVE
// database — including after the database is switched in the toolbar dropdown
// (suggestions repoint to the picked database's tables).

async function openSqlTab(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(600)
}

async function completionsFor(page: import('@playwright/test').Page, text: string) {
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
  await page.waitForTimeout(500)
  const tip = page.locator('.cm-tooltip-autocomplete')
  await expect(tip).toBeVisible({ timeout: 3000 })
  return tip.innerText()
}

test('suggests tables of the connected database', async ({ page }) => {
  await openSqlTab(page)
  const list = await completionsFor(page, 'SELECT * FROM stu')
  expect(list).toContain('students')
  // the suggestion is explicit: the table's schema/database shows as a qualifier,
  // right-aligned to the edge of a comfortably wide popup.
  const row = page.locator('.cm-tooltip-autocomplete li').first()
  const detail = row.locator('.cm-completionDetail')
  await expect(detail).toHaveText('public')
  const labelBox = await row.locator('.cm-completionLabel').boundingBox()
  const detailBox = await detail.boundingBox()
  // the qualifier sits well to the right of the label (a real gap, not adjacent)
  expect(detailBox!.x).toBeGreaterThan(labelBox!.x + labelBox!.width + 40)
})

test('suggests tables after switching the database', async ({ page }) => {
  await openSqlTab(page)
  // switch to another database via the searchable combobox: type to filter, pick
  const dbInput = page.getByTitle('Database', { exact: true })
  await dbInput.click()
  await page.waitForTimeout(200)
  await dbInput.fill('analy')
  await page.waitForTimeout(200)
  await page.getByRole('option', { name: 'analytics' }).first().click()
  await page.waitForTimeout(900)
  const list = await completionsFor(page, 'SELECT * FROM stu')
  expect(list).toContain('students')
})

// ---- reserved-word aware quoting on accept (Tab/Enter) ----------------------
// A suggested table/column whose name collides with a keyword must insert with
// the dialect's quote char: PG/SQLite "…", MySQL/MariaDB/ClickHouse `…`, MSSQL […].

// Open a query tab bound to a SPECIFIC connection (via the connection's
// "New Query Console" context item), identified by its unique host text — the
// generic New-SQL-tab button binds to the active tab's connection instead.
async function newTabFor(page: import('@playwright/test').Page, hostText: string) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByText(hostText, { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(700)
}

/** Type text, wait for the popup, accept with Tab, return the editor contents. */
async function acceptAndRead(page: import('@playwright/test').Page, text: string) {
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
  await page.waitForTimeout(500)
  await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible({ timeout: 3000 })
  await page.keyboard.press('Tab')
  await page.waitForTimeout(200)
  return page.locator('.cm-content').first().innerText()
}

test('MySQL: reserved/keyword table names are backtick-quoted on accept', async ({ page }) => {
  await newTabFor(page, 'localhost:3306') // MySQL connection (unique host:port)
  // the reported case: `schedule` is a MySQL keyword
  expect(await acceptAndRead(page, 'SELECT * FROM sched')).toContain('`schedule`')
  // and a word reserved everywhere
  expect(await acceptAndRead(page, 'SELECT * FROM ord')).toContain('`order`')
})

test('PostgreSQL: reserved word double-quoted, MySQL-only keyword left bare', async ({ page }) => {
  await newTabFor(page, '10.0.1.5') // Postgres connection (unique host)
  // `order` is reserved in PG → double-quoted
  expect(await acceptAndRead(page, 'SELECT * FROM ord')).toContain('"order"')
  // `schedule` is NOT a PG keyword → inserted bare (dialect-aware)
  const scheduled = await acceptAndRead(page, 'SELECT * FROM sched')
  expect(scheduled).toContain('schedule')
  expect(scheduled).not.toContain('"schedule"')
})

// ---- column completion: the FROM table's columns must be suggested -----------
// Columns load lazily, so the pattern is: type up to the trigger (kicks off the
// load), wait, then type one more char to reopen the popup with columns cached.
async function columnPopup(page: import('@playwright/test').Page, text: string, extra: string) {
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
  await page.waitForTimeout(700) // lazy column load kicks off + resolves
  await page.keyboard.type(extra) // re-open the popup, columns now cached
  await page.waitForTimeout(500)
  const tip = page.locator('.cm-tooltip-autocomplete')
  await expect(tip).toBeVisible({ timeout: 3000 })
  return tip.innerText()
}

// ---- function completion: full per-dialect catalog (not just the curated ~11) --

test('PostgreSQL: suggests functions from the live server catalog (list_functions)', async ({ page }) => {
  await openSqlTab(page)
  await page.waitForTimeout(500) // let the function catalog load + reconfigure
  // date_trunc is NOT in the curated set — it comes from the introspected catalog
  const list = await completionsFor(page, 'SELECT date_tr')
  expect(list).toContain('date_trunc')
})

test('MySQL: suggests built-in functions from the static catalog', async ({ page }) => {
  await newTabFor(page, 'localhost:3306') // MySQL — built-ins are not introspectable
  const list = await completionsFor(page, 'SELECT json_ex')
  expect(list).toContain('json_extract')
})

test('catalog function suggestions are not duplicated, and carry a signature', async ({ page }) => {
  await newTabFor(page, 'localhost:3306') // MySQL — has the biggest static catalog
  await completionsFor(page, 'SELECT json_ext') // json_extract: a function, NOT a keyword
  // exactly one row — from the catalog, with its signature — no bare twin.
  const rows = page.locator('.cm-tooltip-autocomplete li')
  const labels = await rows.locator('.cm-completionLabel').allInnerTexts()
  expect(labels.filter((l) => l === 'json_extract')).toHaveLength(1)
  const row = rows.filter({ hasText: 'json_extract' }).first()
  await expect(row.locator('.cm-completionDetail')).toContainText('json_extract')
})

test('known function calls are colour-highlighted in the editor', async ({ page }) => {
  await openSqlTab(page) // Postgres
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type('SELECT date_trunc(x) FROM t')
  await page.waitForTimeout(400)
  // the decoration wraps the function name in a .cm-sql-fn span
  const fn = page.locator('.cm-content .cm-sql-fn', { hasText: 'date_trunc' })
  await expect(fn).toBeVisible()
})

test('MSSQL: keyword-named functions (GETDATE/DATEADD) are coloured', async ({ page }) => {
  await newTabFor(page, '10.0.2.9') // MSSQL connection
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT DATEADD(day, 1, GETDATE());')
  await page.waitForTimeout(400)
  // both are T-SQL functions AND dialect keywords — they must still colour (the
  // colour set is driven by the function catalog, with no keyword subtraction).
  const coloured = await page.locator('.cm-content .cm-sql-fn').allInnerTexts()
  expect(coloured).toContain('DATEADD')
  expect(coloured).toContain('GETDATE')
})

test('suggests a table\'s columns after `table.`', async ({ page }) => {
  await openSqlTab(page)
  const list = await columnPopup(page, 'SELECT * FROM students WHERE students.', 'f')
  expect(list).toContain('first_name')
})

test('suggests the FROM table columns for a bare identifier (no qualifier)', async ({ page }) => {
  await openSqlTab(page)
  // a bare word in the statement — with `FROM students` present — offers its columns
  const list = await columnPopup(page, 'SELECT * FROM students WHERE fi', 'r')
  expect(list).toContain('first_name')
})
