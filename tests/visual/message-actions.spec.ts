import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Fixed timezone so the localized Time column renders deterministically.
test.use({ timezoneId: 'America/New_York' })

// Task 1: per-message Copy + Clear in the streaming message views. NATS subject
// messages load via IPC (demo: 250, server-paginated newest-first), so the actions
// are exercisable here; Kafka consumer and Redis pub/sub use the same per-row
// Copy (⧉) + Clear (×).
test('nats subject messages: per-message copy + clear (delete by seq)', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('orders.eu', { exact: true }).first().click()
  await page.waitForTimeout(400)

  // server-paginated newest-first: 250 total, page 1 = the newest 100 (seq 151..250)
  await expect(page.getByText('250 records').first()).toBeVisible()
  const copyBtns = page.locator('[title="Copy full payload"]')
  const clearBtns = page.locator('[title="Delete this message (by sequence)"]')
  await expect(copyBtns).toHaveCount(100)
  await expect(clearBtns).toHaveCount(100)

  // newest first: top row is seq 250; Time is localized (America/New_York = UTC-4)
  const firstRow = page.locator('tbody tr').first()
  await expect(firstRow.locator('td').first()).toHaveText('250')
  await expect(firstRow.locator('td').nth(1)).toHaveText('2026-06-30 06:04:10')

  // copy first message → clipboard holds its payload
  await copyBtns.first().click()
  await page.waitForTimeout(150)
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('{"id"')

  // delete one message → confirm popup appears; cancel keeps all 3
  await clearBtns.first().click()
  await page.waitForTimeout(150)
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Delete this message').first()).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForTimeout(150)
  await expect(page.locator('[title="Delete this message (by sequence)"]')).toHaveCount(100)

  // delete again → Confirm this time → row count drops by one
  await clearBtns.first().click()
  await page.waitForTimeout(150)
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
  await page.waitForTimeout(300)
  await expect(page.locator('[title="Delete this message (by sequence)"]')).toHaveCount(99)

  // "Clear messages" also opens a confirm popup
  await page.getByText('Clear messages', { exact: true }).first().click()
  await page.waitForTimeout(150)
  await expect(page.getByRole('dialog').getByText('Clear messages').first()).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
