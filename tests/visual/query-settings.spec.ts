import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Settings → Query / Data used to be dead UI: Continue on error, Default page size,
// NULL text, Datetime format and Timezone were saved but nothing read them. They
// now drive the Query Editor and the result grids. Plus two run-safety guards.

async function openSqlTab(page: Page, query = '') {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(700)
}

async function settingsSection(page: Page, section: string) {
  await page.keyboard.press('Control+,')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: section, exact: true }).first().click()
  await page.waitForTimeout(200)
}

async function closeSettings(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '×' }).first().click()
  await page.waitForTimeout(300)
}

async function setField(page: Page, label: string, value: string) {
  const input = page.getByText(label).locator('input')
  await input.fill(value)
  await input.dispatchEvent('change')
}

async function run(page: Page, sql: string) {
  await page.locator('.view-lines').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(sql)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Run' }).first().click()
}

const cell = (page: Page, row: number, col: number) => page.locator('.grid-row').nth(row).locator('td:not(:first-child)').nth(col)

test('NULL text, datetime format and timezone change what the grid shows — an edit still starts from the raw value', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openSqlTab(page)
  await settingsSection(page, 'Data')
  await setField(page, 'NULL display text', '(null)')
  await setField(page, 'Datetime format', 'dd/MM/yyyy HH:mm')
  await page.getByText('Timezone').locator('select').selectOption('utc')
  await closeSettings(page)

  await run(page, 'SELECT id, display_name, last_login FROM profiles')
  await expect(page.getByText(/Rows 1–2 of 2/).first()).toBeVisible({ timeout: 10_000 })
  await expect(cell(page, 0, 2)).toHaveText('30/06/2026 10:23')
  await expect(cell(page, 1, 2)).toHaveText('(null)')

  // the result is editable (single table + key): the editor starts from the
  // server's value, not from the formatted text
  await cell(page, 0, 2).dblclick()
  await expect(page.locator('input.rg-edit')).toHaveValue('2026-06-30T10:23:14+00:00')
  await page.keyboard.press('Escape')
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Continue on error runs the rest of the script and opens Messages', async ({ page }) => {
  await openSqlTab(page)
  // off (default): stops at the error
  await run(page, 'SELECT 1;\nSELEC 2;\nSELECT 3;')
  await expect(page.getByText(/1 statement after #2 was not run|not run/).first()).toBeVisible({ timeout: 10_000 })

  await settingsSection(page, 'Query')
  await page.getByText('Continue on error').locator('input').check()
  await closeSettings(page)
  await run(page, 'SELECT 1;\nSELEC 2;\nSELECT 3;')
  await expect(page.getByRole('tab', { name: /^≣ Messages/ })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 })
  const log = await page.evaluate(() => (window as unknown as { __ipcSqlLog?: string[] }).__ipcSqlLog ?? [])
  expect(log.slice(-3)).toEqual(['SELECT 1', 'SELEC 2', 'SELECT 3'])
  await expect(page.locator('.rm-headline')).toContainText('1 failed')
})

test('Default page size reaches Open Data and query results', async ({ page }) => {
  await openSqlTab(page)
  await settingsSection(page, 'Query')
  await setField(page, 'Default page size', '300')
  await closeSettings(page)

  await run(page, 'SELECT * FROM perf_rows_1000')
  await expect(page.getByText(/Rows 1–300 of 1,000/).first()).toBeVisible({ timeout: 15_000 })

  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByRole('treeitem', { name: /students/ }).first().dblclick()
  await expect(page.getByLabel('Page size').last()).toHaveValue('300', { timeout: 10_000 })
})

test('switching database while a transaction is open is refused', async ({ page }) => {
  await openSqlTab(page)
  await run(page, 'BEGIN')
  await expect(page.getByText('⚠ TXN open')).toBeVisible({ timeout: 10_000 })
  const db = page.locator('input[title="Database"]:visible')
  const before = await db.inputValue()
  await db.click()
  await db.fill('analy')
  await page.getByRole('option', { name: 'analytics' }).first().click()
  await expect(page.getByText(/open transaction — Commit or Roll back before switching database/)).toBeVisible()
  await expect(db).toHaveValue(before)
  await expect(page.getByText('⚠ TXN open')).toBeVisible()
})
