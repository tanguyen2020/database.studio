import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, previewBox } from './helpers'

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

  // cursor-paginated newest-first: 250 total, page 1 = the newest 100 (the subject is
  // sparse in the stream: one message every 4th sequence, so seq 604..1000)
  await expect(page.getByText('250 records').first()).toBeVisible()
  const copyBtns = page.locator('[title="Copy full payload"]')
  const clearBtns = page.locator('[title="Delete this message (by sequence)"]')
  await expect(copyBtns).toHaveCount(100)
  await expect(clearBtns).toHaveCount(100)

  // newest first: top row is the subject's last seq (1000); Time is localized (UTC-4)
  const firstRow = page.locator('tbody tr').first()
  await expect(firstRow.locator('td').first()).toHaveText('1000')
  await expect(firstRow.locator('td').nth(1)).toHaveText('2026-06-30 06:16:40')

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

// Item 3: selecting a record highlights it (blue, Result-Grid style) WITHOUT hiding
// the three per-row action icons — they flip to white so they stay visible/clickable.
test('nats subject messages: selecting a row keeps the 3 action icons visible', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
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

  const row = page.locator('tbody tr').first()
  // click a data cell (not an icon) to select the record
  await row.locator('td').nth(1).click()
  await expect(row).toHaveAttribute('aria-selected', 'true')

  // all three icons remain present + visible on the selected (blue) row
  const view = row.locator('[title="View payload as JSON"]')
  const copy = row.locator('[title="Copy full payload"]')
  const del = row.locator('[title="Delete this message (by sequence)"]')
  await expect(view).toBeVisible()
  await expect(copy).toBeVisible()
  await expect(del).toBeVisible()

  // the payload popup shows the JSON — visibly, not only in the model
  await view.click()
  await page.waitForTimeout(600)
  const natsView = await previewBox(page, 'Payload')
  expect(natsView.text).toContain('"id"')
  expect(natsView.height, `payload viewer collapsed (${natsView.height}px)`).toBeGreaterThan(100)
  expect(natsView.rendered).toContain('"id"')
  await page.getByRole('button', { name: 'Close' }).first().click()
  await page.waitForTimeout(200)
  // they turn white on selection (contrast with the blue highlight = not hidden)
  expect(await copy.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)')
  expect(await del.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
