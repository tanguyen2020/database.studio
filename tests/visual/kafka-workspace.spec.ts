import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, kafkaTopicView, openKafkaTopic, previewBox, showFormatted } from './helpers'

// Kafka: connecting opens ONE workspace tab (Kafka has no object tree); a topic's
// messages show inside its details in that workspace — never a tab per topic.
test('kafka: connect opens the workspace; Topics → a topic shows its messages in place', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  // connecting opens the workspace tab — and no Explorer tree for Kafka
  const ws = await openKafkaTopic(page, 'payments')
  await expect(page.getByRole('tab', { name: /^Events Kafka/ })).toHaveCount(1)
  await expect(page.locator('[data-sidebar-panel="explorer"]')).toHaveCount(0)

  // the Topics table lists the demo topics (payments, enrollment.events)
  const grid = ws.getByRole('grid', { name: 'Topics' })
  await expect(grid.locator('tbody tr').filter({ hasText: 'enrollment.events' })).toBeVisible()

  // the topic's messages show in its details — no tab per topic
  const view = kafkaTopicView(page)
  await expect(view).toHaveAttribute('data-kafka-topic-view', 'payments')
  await expect(page.getByRole('tab', { name: /payments · consume/ })).toHaveCount(0)
  await expect(view.getByRole('button', { name: 'Consume' })).toBeVisible()

  // consumer has a "Clear messages" button that purges the topic on Kafka, guarded
  // by a confirm popup (no per-row "Clear this message" button anymore)
  await view.getByRole('button', { name: 'Clear messages' }).click()
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
  await openKafkaTopic(page, 'payments')

  // the newest page loaded on open — rows are visible, no "no messages" claim
  const view = kafkaTopicView(page)
  const rows = view.locator('tbody tr')
  await expect(rows.first()).toBeVisible({ timeout: 8000 })
  const firstCount = await rows.count()
  expect(firstCount).toBeGreaterThan(0)
  await expect(view.getByText('This topic has no messages.')).toHaveCount(0)

  // demo topic 'payments' holds 15200+ records; the page must read far fewer
  expect(firstCount).toBeLessThanOrEqual(100)
  await expect(view.getByText(/topic holds/)).toBeVisible()

  // Next moves on to older records: the top offset must decrease
  const topOffset = async () => Number(await rows.first().locator('td').nth(1).innerText())
  const before = await topOffset()
  await view.getByRole('button', { name: 'Next ▶' }).click()
  await page.waitForTimeout(500)
  const after = await topOffset()
  expect(after).toBeLessThan(before)

  // Previous walks back toward the newest records
  await view.getByRole('button', { name: '◀ Previous' }).click()
  await page.waitForTimeout(500)
  expect(await topOffset()).toBeGreaterThan(after)

  // page size is honoured
  await view.getByTitle(/How many records to read per page/).selectOption('50')
  await page.waitForTimeout(500)
  expect(await rows.count()).toBeLessThanOrEqual(50)

  // the value popup SHOWS the payload: a viewer whose box collapsed to a few
  // pixels still holds the text in its model, so height is part of the contract
  await rows.first().getByTitle('View value as JSON').click()
  await page.waitForTimeout(600)
  await showFormatted(page)
  await page.waitForTimeout(600)
  const payload = await previewBox(page, 'Payload')
  expect(payload.text, 'kafka payload viewer is empty').not.toBe('')
  expect(payload.height, `kafka payload viewer collapsed (${payload.height}px)`).toBeGreaterThan(100)
  expect(payload.rendered.trim(), 'kafka payload not rendered').not.toBe('')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.waitForTimeout(200)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// The message table fits its panel: Key / Value shorten (full text on hover) and the
// row actions — View as JSON, Copy — are always in view, no sideways scroll needed.
test('kafka: message actions are in view without scrolling sideways', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await openKafkaTopic(page, 'payments')
  const view = kafkaTopicView(page)
  const first = view.locator('tbody tr').first()
  await expect(first).toBeVisible({ timeout: 8000 })
  const box = (await view.boundingBox())!
  for (const title of ['View value as JSON', 'Copy message']) {
    const b = (await first.getByTitle(title).boundingBox())!
    expect(b.x + b.width, `${title} sits inside the panel`).toBeLessThanOrEqual(box.x + box.width + 1)
  }
  const table = view.locator('table').first()
  expect(await table.evaluate((t) => (t.parentElement as HTMLElement).scrollWidth <= (t.parentElement as HTMLElement).clientWidth + 1)).toBe(true)
  expect(errors, errors.join('\n')).toEqual([])
})
