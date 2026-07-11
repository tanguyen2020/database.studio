import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('query plan: Explain opens normalized tree + hotspot + summary', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // open a SQL editor on a Postgres connection
  await page.getByRole('button', { name: /Postgres/ }).first().dblclick()
  await page.waitForTimeout(500)
  // type a query then click Explain toolbar button
  const editor = page.locator('.cm-content').first()
  await editor.click()
  await page.keyboard.type('SELECT * FROM enrollments WHERE status = 5')
  await page.getByRole('button', { name: 'Explain' }).first().click()
  await page.waitForTimeout(500)

  // Plan shows in the SAME tab's Result panel (a "Query Plan" sub-tab), not a new
  // editor tab — the SQL editor stays visible below/above the plan.
  await expect(page.getByRole('tab', { name: /Query Plan/ }).first()).toBeVisible()
  await expect(page.locator('.cm-content').first()).toBeVisible()
  await expect(page.getByText('HashJoin').first()).toBeVisible()
  await expect(page.getByText('SeqScan').first()).toBeVisible()
  await expect(page.getByText('HOTSPOT').first()).toBeVisible()
  await expect(page.getByText(/Seq Scan on enrollments/).first()).toBeVisible()

  // P1.1: Postgres supports EXPLAIN ANALYZE → Actual toggle is shown
  await expect(page.getByRole('button', { name: 'Actual' }).first()).toBeVisible()

  // P3.1: nodes show "Cost N%" (self-cost percentage, SSMS-style)
  await expect(page.getByText(/Cost 74\.2%/).first()).toBeVisible()

  // P3.2: missing-index banner with the suggested DDL + Copy button
  await expect(page.getByText(/Missing index \(Impact ~92\.5%\)/).first()).toBeVisible()
  await expect(page.getByText(/CREATE INDEX ix_enrollments_status/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy DDL' }).first()).toBeVisible()

  // Fix: Explain resolves the SAME per-tab connection Run uses (open_tab_connection),
  // so it targets the picked database/schema — not the base connection's default DB.
  const otc = await page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.open_tab_connection ?? 0)
  expect(otc).toBeGreaterThan(0)

  // View raw toggles to raw JSON
  await page.getByRole('button', { name: 'View raw' }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/"Node Type"/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('query plan: Run closes the plan and focuses results; Explain reopens it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().dblclick()
  await page.waitForTimeout(500)
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM students')

  // Explain → the "Query Plan" sub-tab appears
  await page.getByRole('button', { name: 'Explain' }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('tab', { name: /Query Plan/ })).toHaveCount(1)

  // Run → the plan sub-tab closes and results are focused
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByRole('tab', { name: /Query Plan/ })).toHaveCount(0)

  // Explain again → the plan reopens
  await page.getByRole('button', { name: 'Explain' }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('tab', { name: /Query Plan/ })).toHaveCount(1)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('query plan: Actual toggle hidden for engines without EXPLAIN ANALYZE (ClickHouse)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // open a query console bound to the ClickHouse connection (actual_kind='none')
  // via its context menu (the generic New-SQL-tab button binds to the active tab).
  await page.getByText('10.0.4.2:8123', { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(700)
  const editor = page.locator('.cm-content').first()
  await editor.click()
  await page.keyboard.type('SELECT * FROM events')
  await page.getByRole('button', { name: 'Explain' }).first().click()
  await page.waitForTimeout(500)

  // plan shows, but the Actual toggle must NOT be offered (ClickHouse has no actual)
  await expect(page.getByRole('tab', { name: /Query Plan/ }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Actual' })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('query plan: MySQL now offers the Actual toggle (EXPLAIN ANALYZE)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByText('localhost:3306', { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(700)
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM books')
  await page.getByRole('button', { name: 'Explain' }).first().click()
  await page.waitForTimeout(500)

  // P3.3 — MySQL supports actual now → the Actual toggle IS shown.
  await expect(page.getByRole('tab', { name: /Query Plan/ }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Actual' }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('query plan: Cassandra is shown as TRACING/diagnostics, not an Actual plan', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // open a query console bound to the Cassandra connection (host:port is unique)
  await page.getByText('10.0.5.3:9042', { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(700)
  const editor = page.locator('.cm-content').first()
  await editor.click()
  await page.keyboard.type('SELECT * FROM t WHERE v = 1 ALLOW FILTERING')
  await page.getByRole('button', { name: 'Explain' }).first().click()
  await page.waitForTimeout(500)

  // P1.3: tracing is labeled diagnostics (not "ACTUAL"), and no Actual toggle
  await expect(page.getByRole('tab', { name: /Query Plan/ }).first()).toBeVisible()
  await expect(page.getByText(/TRACING · DIAGNOSTICS/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Actual' })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
