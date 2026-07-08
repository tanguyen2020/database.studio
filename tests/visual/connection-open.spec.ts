import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Item 5 — opening a saved connection: a disconnected connection shows a clear
// "Not connected" state with a Connect action; after connecting, the Explorer
// reveals its structure. (The demo backend always connects successfully, so the
// transient "Connecting…" and the failure message are exercised by unit coverage.)
test('explorer: disconnected connection shows Not connected, connecting reveals the tree', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // MSSQL (c3) is disconnected in the demo — single click selects it.
  await page.getByText('MSSQL', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText('Not connected.').first()).toBeVisible()

  // Connect → demo connects → Explorer shows the tree (the "Not connected" state clears).
  await page.getByText('Connect', { exact: true }).first().click()
  await page.waitForTimeout(600)
  await expect(page.getByText('Not connected.')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
