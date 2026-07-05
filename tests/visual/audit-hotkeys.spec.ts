import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Item 1 — Ctrl/Cmd+N opens a new Query Editor tab.
test('Ctrl+N opens a new query editor tab', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  const before = await page.getByRole('tab').count()
  await page.keyboard.press('Control+n')
  await page.waitForTimeout(300)
  const after = await page.getByRole('tab').count()
  expect(after).toBe(before + 1)
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Item 2 — selecting a statement and pressing Run executes only that statement.
test('Run executes the selected statement only', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT 1;\nSELECT 2;')
  // select the second line only
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)
  // exactly one statement ran (single result, no #1/#2 multi-tabs for two stmts)
  await expect(page.locator('.grid-row').first()).toBeVisible()
  await expect(page.getByText('#2', { exact: false })).toHaveCount(0)
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Item 3 — New Query on a MySQL object targets its schema-as-database.
test('MySQL New Query selects the schema database in the tab', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  // click the MySQL connection row (localhost:3306 is unique to it — /MySQL/ alone
  // would also match the system group header).
  await page.getByText('localhost:3306', { exact: false }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().dblclick() // expand db(schema)
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('students', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query', { exact: true }).first().click()
  await page.waitForTimeout(300)
  // the Query Editor database chip shows the schema (== database for MySQL)
  await expect(page.getByTitle('Database').first()).toContainText('public')
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Item 5 — View/Proc/Function/Trigger/Sequence context menus expose Alter/Drop
// (and Execute where applicable).
test('function context menu has Execute, Alter, Drop', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Functions', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText(/add_one/).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await expect(page.getByText('Execute…', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Alter…', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Drop', { exact: true }).first()).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Item 4 — closing a query-editor tab with unsaved changes prompts to save.
test('closing a dirty query tab prompts to save', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT 1')
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+w') // close active tab
  await page.waitForTimeout(200)
  await expect(page.getByText('Save changes before closing?').first()).toBeVisible()
  await page.getByRole('button', { name: "Don't Save" }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText('Save changes before closing?')).toHaveCount(0)
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
