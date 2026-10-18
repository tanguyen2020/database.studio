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
  const editor = page.locator('.view-lines').first()
  await editor.click()
  await page.keyboard.type('SELECT * FROM enrollments WHERE status = 5')
  await page.getByRole('button', { name: 'Explain' }).first().click()
  await page.waitForTimeout(500)

  // Plan shows in the SAME tab's Result panel (a "Query Plan" sub-tab), not a new
  // editor tab — the SQL editor stays visible below/above the plan.
  await expect(page.getByRole('tab', { name: /Query Plan/ }).first()).toBeVisible()
  await expect(page.locator('.view-lines').first()).toBeVisible()
  // Steps are named in plain words (not planner identifiers), numbered in run order.
  await expect(page.getByText('Hash join', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Full table scan', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Reads every row of enrollments to find the matches.').first()).toBeVisible()
  await expect(page.locator('[data-step="1"]').getByText('Full table scan')).toBeVisible()
  await expect(page.locator('[data-step="3"]').getByText('Hash join')).toBeVisible()
  await expect(page.getByText('Hotspot', { exact: true }).first()).toBeVisible()
  // The warning is explained (what + how to fix) and the engine's own message is kept.
  await expect(page.getByText('Reads the whole enrollments table').first()).toBeVisible()
  await expect(page.getByText(/How to fix:/).first()).toBeVisible()
  await expect(page.getByText(/Seq Scan on enrollments/).first()).toBeVisible()
  // Engine details fold out per step.
  await page.locator('[data-step="1"]').getByRole('button', { name: 'Show details' }).click()
  await expect(page.locator('[data-step="1"]').getByText("(status = 'active')")).toBeVisible()

  // P1.1: Postgres supports EXPLAIN ANALYZE → Actual toggle is shown
  await expect(page.getByRole('button', { name: 'Actual' }).first()).toBeVisible()
  // Explain defaults to Actual on engines that support it → Actual is the pressed
  // half of the Estimate/Actual switch and the mode badge says so.
  await expect(page.getByRole('button', { name: 'Actual' }).first()).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Estimate' }).first()).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('Actual run', { exact: true }).first()).toBeVisible()

  // P3.1: steps show their share of the cost (self-cost percentage, SSMS-style)
  await expect(page.getByText(/74\.2% of cost/).first()).toBeVisible()

  // P3.2: the verdict leads with the missing index; the card carries the DDL + Copy
  await expect(page.getByText(/An index could cut the cost by ~92\.5%/).first()).toBeVisible()
  await expect(page.getByText('Suggested index', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/~92\.5% lower cost/).first()).toBeVisible()
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
  await page.locator('.view-lines').first().click()
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
  const editor = page.locator('.view-lines').first()
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
  await page.locator('.view-lines').first().click()
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
  const editor = page.locator('.view-lines').first()
  await editor.click()
  await page.keyboard.type('SELECT * FROM t WHERE v = 1 ALLOW FILTERING')
  await page.getByRole('button', { name: 'Explain' }).first().click()
  await page.waitForTimeout(500)

  // P1.3: tracing is labeled diagnostics (not "ACTUAL"), and no Actual toggle
  await expect(page.getByRole('tab', { name: /Query Plan/ }).first()).toBeVisible()
  await expect(page.getByText('Trace · diagnostics', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Actual' })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
