import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, previewBox } from './helpers'

// Kafka: connecting does NOT open a cluster tab — topics live in the ObjectExplorer
// sidebar and clicking a topic opens its consumer.
test('kafka: connect opens no cluster tab; topics in explorer → consumer', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  // double-click sidebar Kafka connection → connect (but do NOT open a cluster tab)
  const row = page.getByRole('button', { name: /Events Kafka/ })
  await row.dblclick()
  await page.waitForTimeout(600)

  // no "cluster" tab is opened by connecting
  await expect(page.getByRole('tab', { name: /cluster/ })).toHaveCount(0)

  // topics render in the Explorer sidebar (demo: payments, enrollment.events)
  await expect(page.getByText('payments', { exact: true }).first()).toBeVisible({ timeout: 8000 })
  await expect(page.getByText('enrollment.events', { exact: true }).first()).toBeVisible()

  // clicking a topic opens its consumer tab
  await page.getByText('payments', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('tab', { name: /payments · consume/ }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Consume' })).toBeVisible()

  // consumer has a "Clear messages" button that purges the topic on Kafka, guarded
  // by a confirm popup (no per-row "Clear this message" button anymore)
  await page.getByRole('button', { name: 'Clear messages' }).click()
  await page.waitForTimeout(150)
  await expect(page.getByText(/Delete ALL messages of topic/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Paging: a topic can hold millions of records — the consumer reads ONE bounded
// window at a time instead of streaming the whole log.
test('kafka: topic messages are paged (Newest / Previous / Next)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /Events Kafka/ }).dblclick()
  await page.getByText('payments', { exact: true }).first().click()
  await page.waitForTimeout(400)

  // the newest page loaded on open — rows are visible, no "no messages" claim
  const rows = page.locator('tbody tr')
  await expect(rows.first()).toBeVisible({ timeout: 8000 })
  const firstCount = await rows.count()
  expect(firstCount).toBeGreaterThan(0)
  await expect(page.getByText('This topic has no messages.')).toHaveCount(0)

  // demo topic 'payments' holds 15200+ records; the page must read far fewer
  expect(firstCount).toBeLessThanOrEqual(100)
  await expect(page.getByText(/topic holds/)).toBeVisible()

  // Next moves on to older records: the top offset must decrease
  const topOffset = async () => Number(await rows.first().locator('td').nth(1).innerText())
  const before = await topOffset()
  await page.getByRole('button', { name: 'Next ▶' }).click()
  await page.waitForTimeout(500)
  const after = await topOffset()
  expect(after).toBeLessThan(before)

  // Previous walks back toward the newest records
  await page.getByRole('button', { name: '◀ Previous' }).click()
  await page.waitForTimeout(500)
  expect(await topOffset()).toBeGreaterThan(after)

  // page size is honoured
  await page.getByTitle(/How many records to read per page/).selectOption('50')
  await page.waitForTimeout(500)
  expect(await rows.count()).toBeLessThanOrEqual(50)

  // the value popup SHOWS the payload: a viewer whose box collapsed to a few
  // pixels still holds the text in its model, so height is part of the contract
  await rows.first().getByTitle('View value as JSON').click()
  await page.waitForTimeout(600)
  const payload = await previewBox(page, 'Payload')
  expect(payload.text, 'kafka payload viewer is empty').not.toBe('')
  expect(payload.height, `kafka payload viewer collapsed (${payload.height}px)`).toBeGreaterThan(100)
  expect(payload.rendered.trim(), 'kafka payload not rendered').not.toBe('')
  await page.getByRole('button', { name: 'Close' }).first().click()
  await page.waitForTimeout(200)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
