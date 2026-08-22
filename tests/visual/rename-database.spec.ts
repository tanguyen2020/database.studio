import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// "Rename…" on a database in the explorer context menu opens a POPUP with the new
// name (focused on open) and runs the rename on Confirm — it used to park an
// `ALTER DATABASE … RENAME TO <db>_new` placeholder in a SQL tab.
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls ?? {})
const lastSql = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ipcLastSql?: string }).__ipcLastSql ?? '')

async function boot(page: Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
}

test('rename a database: popup, focused input, Confirm runs the ALTER', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres 10\.0\.1\.5/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  const foreign = page.getByRole('treeitem', { name: /analytics/ }).first()
  await foreign.click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.waitForTimeout(300)

  // a popup, not a SQL tab — and the input has focus so typing works right away
  const dialog = page.getByRole('dialog', { name: 'Rename database' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('tab', { name: /Rename database/ })).toHaveCount(0)
  const input = dialog.locator('#rn-db')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('analytics')

  // backdrop click does not close (rule chung for form popups)
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()

  // the same name cannot be confirmed; an existing one is refused by name
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toHaveAttribute('aria-disabled', 'true')
  await input.fill('postgres')
  await expect(dialog).toContainText('already exists on this server')
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toHaveAttribute('aria-disabled', 'true')

  // a free name shows the exact statement and enables Confirm
  await input.fill('analytics_2026')
  await expect(dialog).toContainText('ALTER DATABASE "analytics" RENAME TO "analytics_2026";')
  const confirm = dialog.getByRole('button', { name: 'Confirm' })
  await expect(confirm).toHaveAttribute('aria-disabled', 'false')
  await confirm.click()
  await page.waitForTimeout(1400)

  // it ran, and the tree was re-read from the server
  expect(await lastSql(page)).toContain('ALTER DATABASE "analytics" RENAME TO "analytics_2026"')
  expect((await calls(page)).list_databases ?? 0).toBeGreaterThan(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: /analytics_2026/ }).first()).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /^analytics$/ })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Cancel changes nothing, and engines without a rename only offer the SQL tab', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  // Cancel path (Postgres)
  await page.getByRole('button', { name: /Postgres 10\.0\.1\.5/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByRole('treeitem', { name: /analytics/ }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.waitForTimeout(300)
  await page.getByRole('dialog').locator('#rn-db').fill('nope')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await calls(page)).exec_statement ?? 0).toBe(0)

  // MySQL cannot rename a database: the popup says so and offers the SQL tab instead
  await page.getByRole('button', { name: /MySQL localhost:3306/ }).first().click()
  await page.waitForTimeout(600)
  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.waitForTimeout(300)
  const dialog = page.getByRole('dialog', { name: 'Rename database' })
  await expect(dialog).toContainText('cannot rename a database directly')
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Open in SQL tab' }).click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('tab', { name: /Rename database public/ }).first()).toBeVisible()
  expect((await calls(page)).exec_statement ?? 0).toBe(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
