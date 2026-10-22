import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode, wsSection } from './helpers'

// Rule: every ObjectExplorer context menu offers Refresh; and clear/delete
// confirm popups open with Cancel focused by default.

async function boot(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
}

test('leaf (column) context menu offers Refresh', async ({ page }) => {
  await boot(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  // expand the table, then its Columns folder (columns live in a folder like Indexes)
  await page.getByRole('treeitem', { name: /students/ }).first().getByRole('button').first().click()
  await page.waitForTimeout(300)
  await page.getByRole('treeitem', { name: /Columns/ }).first().getByRole('button').first().click()
  await page.waitForTimeout(300)
  await page.getByText('id', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  // menu has both the existing item and the new Refresh
  await expect(page.getByText('Set as Filter').first()).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Refresh' }).first()).toBeVisible()
})

test('NATS delete-stream confirm opens with Cancel focused', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  // NATS has no object tree: the connection opens its workspace; streams are a table there
  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await wsSection(page, 'streams')
  const ws = page.locator('[data-stream-shell="nats"]')
  await ws.getByRole('grid', { name: 'Streams' }).locator('tbody tr[data-kind="stream"]').filter({ hasText: 'ORDERS' }).click()
  await ws.getByRole('button', { name: 'Delete stream…' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete stream' })
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
})
