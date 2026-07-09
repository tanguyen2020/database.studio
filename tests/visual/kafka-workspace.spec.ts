import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

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
