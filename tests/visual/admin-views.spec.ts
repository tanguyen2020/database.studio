import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// T23 — Admin views. Session Monitor reads like a monitor: states in plain words
// with a summary that filters, background processes hidden by default, durations
// that flag a long query / an open transaction, the full query on demand, and
// Cancel query vs Terminate session — both confirmed. Other views are readable tables.

test('session monitor: summary, states, durations, query viewer, cancel vs terminate', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByTitle('Session Monitor').first().click()
  const admin = page.locator('[data-tab-pane][data-active="true"]')
  await expect(page.getByRole('tab', { name: /Admin ·/ }).first()).toBeVisible()
  await expect(admin.getByRole('tab', { name: 'Session Monitor' })).toHaveAttribute('aria-selected', 'true')

  // readable headers, not SQL column names
  for (const h of ['PID', 'User', 'Database', 'State', 'Waiting on', 'Duration', 'Query']) await expect(admin.getByRole('columnheader', { name: h, exact: true })).toBeVisible()
  await expect(admin.getByRole('columnheader', { name: 'pid', exact: true })).toHaveCount(0)

  // summary: 5 client sessions (2 background hidden) — 1 active, 1 waiting, 1 idle in tx, 1 idle…
  const summary = admin.getByRole('group', { name: 'Session states' })
  await expect(summary.locator('[data-state="all"]')).toContainText('5')
  await expect(summary.locator('[data-state="idle-tx"]')).toContainText('1')
  const rows = admin.locator('tbody tr.adm-row')
  await expect(rows).toHaveCount(5)
  await expect(admin.locator('tr[data-pid="44"]')).toHaveCount(0)
  // background processes on demand
  await admin.getByLabel(/Show background processes/).check()
  await expect(rows).toHaveCount(7)
  await expect(admin.locator('tr[data-pid="44"] [data-state]')).toHaveAttribute('data-state', 'background')
  await admin.getByLabel(/Show background processes/).uncheck()

  // states mapped from the engine's words
  await expect(admin.locator('tr[data-pid="4830"] [data-state]')).toHaveText('Waiting')
  await expect(admin.locator('tr[data-pid="4830"]')).toContainText('Lock · transactionid')
  await expect(admin.locator('tr[data-pid="4844"] [data-state]')).toHaveText('Idle in transaction')
  // durations: 95 s query warns, a 7-minute open transaction is a problem, idle is calm
  await expect(admin.locator('tr[data-pid="4821"] .adm-dur')).toHaveText('1m 35s')
  await expect(admin.locator('tr[data-pid="4821"] .adm-dur')).toHaveClass(/warn/)
  await expect(admin.locator('tr[data-pid="4844"] .adm-dur')).toHaveClass(/bad/)
  await expect(admin.locator('tr[data-pid="4850"] .adm-dur')).toHaveClass(/ok/)
  // the idle "waiting for client" noise is hidden
  await expect(admin.locator('tr[data-pid="4850"] .adm-wait')).toHaveText('—')

  // filter by clicking a count; search narrows the list
  await summary.locator('[data-state="idle-tx"]').click()
  await expect(rows).toHaveCount(1)
  await summary.locator('[data-state="idle-tx"]').click()
  await admin.getByLabel('Search sessions').fill('invoices')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-pid', '4830')
  await admin.getByLabel('Search sessions').fill('')

  // the app's own session is marked and offers no kill
  const self = admin.locator('tr[data-pid="4851"]')
  await expect(self).toContainText('This app')
  await self.hover()
  await expect(self.getByRole('button', { name: 'Terminate' })).toHaveCount(0)

  // full query in a viewer
  const q = admin.locator('tr[data-pid="4821"]')
  await q.click()
  await expect(q).toHaveClass(/sel/)
  await q.getByRole('button', { name: 'View the full query' }).click()
  const viewer = page.getByRole('dialog', { name: 'Session query' })
  await expect(viewer).toBeVisible()
  await expect(viewer).toContainText('Session 4821')
  await viewer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(viewer).toHaveCount(0)

  // Cancel query: confirmed, sends a cancel (the session stays)
  await q.getByRole('button', { name: 'Cancel query' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Cancel query' })
  await expect(confirm).toContainText('stays connected')
  await page.mouse.click(5, 5) // backdrop does not close it
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel query' }).click()
  await expect(confirm).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __ipcLastKill?: string }).__ipcLastKill)).toBe('cancel:4821')
  await expect(admin.locator('tr[data-pid="4821"]')).toHaveCount(1)

  // Terminate: confirmed, ends the session (gone from the list); "Keep it" backs out
  const idle = admin.locator('tr[data-pid="4850"]')
  await idle.hover()
  await idle.getByRole('button', { name: 'Terminate' }).click()
  const term = page.getByRole('alertdialog', { name: 'Terminate session' })
  await expect(term).toContainText('rolled back')
  await term.getByRole('button', { name: 'Keep it' }).click()
  await expect(term).toHaveCount(0)
  await idle.hover()
  await idle.getByRole('button', { name: 'Terminate' }).click()
  await page.getByRole('alertdialog', { name: 'Terminate session' }).getByRole('button', { name: 'Terminate session' }).click()
  expect(await page.evaluate(() => (window as unknown as { __ipcLastKill?: string }).__ipcLastKill)).toBe('terminate:4850')
  await expect(admin.locator('tr[data-pid="4850"]')).toHaveCount(0)

  // auto refresh is offered
  await expect(admin.getByLabel('Auto refresh')).toBeVisible()

  // other views: readable headers + Yes/No instead of true/false
  await admin.getByRole('tab', { name: 'Users & Privileges' }).click()
  await expect(admin.getByRole('columnheader', { name: 'Superuser' })).toBeVisible()
  await expect(admin.locator('.adm-bool.yes').first()).toHaveText('Yes')
  await admin.getByRole('tab', { name: 'Extensions', exact: true }).click()
  await expect(admin.getByText('plpgsql').first()).toBeVisible()
  await expect(admin.getByRole('columnheader', { name: 'Installed version' })).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('admin views: Redis memory analysis (CE-native)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select the Redis connection, then open admin → normalizes to Memory view
  await page.getByRole('button', { name: /Cache Redis/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByTitle('Session Monitor').first().click()
  await page.waitForTimeout(400)

  await expect(page.getByRole('tab', { name: 'Memory', exact: true }).first()).toBeVisible()
  await expect(page.getByText('used_memory').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
