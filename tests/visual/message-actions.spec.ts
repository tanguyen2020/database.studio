import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Task 1: per-message Copy + Clear in the streaming message views. NATS subject
// messages load via IPC (demo returns 3), so the actions are exercisable here;
// Kafka consumer and Redis pub/sub use the same per-row Copy (⧉) + Clear (×).
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

  // 3 demo messages → 3 payload rows
  await expect(page.getByText(/message\(s\)/).first()).toBeVisible()
  const copyBtns = page.locator('[title="Copy message"]')
  const clearBtns = page.locator('[title="Delete this message (by sequence)"]')
  await expect(copyBtns).toHaveCount(3)
  await expect(clearBtns).toHaveCount(3)

  // copy first message → clipboard holds its payload
  await copyBtns.first().click()
  await page.waitForTimeout(150)
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('{"id"')

  // clear (delete) one message → row count drops to 2
  await clearBtns.first().click()
  await page.waitForTimeout(300)
  await expect(page.locator('[title="Delete this message (by sequence)"]')).toHaveCount(2)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
