import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

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
  // expand the table's columns via its chevron
  await page.getByRole('treeitem', { name: /students/ }).first().getByRole('button').first().click()
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
  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible({ timeout: 8000 })
  await page.getByText('ORDERS', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByText('Delete stream', { exact: true }).first().click()
  await page.waitForTimeout(200)
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
})
