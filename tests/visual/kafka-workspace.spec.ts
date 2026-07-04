import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('kafka workspace: cluster overview + topic browser render', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  // double-click sidebar Kafka connection → connect + open Kafka workspace
  const row = page.getByRole('button', { name: /Events Kafka/ })
  await row.dblclick()
  await page.waitForTimeout(600)
  // cluster header (broker count) + topic list from demo
  await expect(page.getByText(/3 brokers/).first()).toBeVisible()
  await expect(page.getByText('payments').first()).toBeVisible()
  // expand topic → partition table (Leader column)
  await page.getByText('payments').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('Leader').first()).toBeVisible()

  // Open Consumer (T4) → consumer tab với nút Consume
  await page.getByTitle('Open Consumer').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('button', { name: 'Consume' })).toBeVisible()

  // Produce (T5): mở workspace lại → Open Producer
  await page.getByRole('tab', { name: /cluster/ }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle('Open Producer').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('button', { name: 'Produce' })).toBeVisible()

  // Consumer Groups (T6): back to cluster tab → toggle groups → group + lag
  await page.getByRole('tab', { name: /cluster/ }).first().click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: 'Consumer Groups' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByText('payment-processor').first()).toBeVisible()
  await page.getByText('payment-processor').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('Lag per partition').first()).toBeVisible()

  // Schema Registry (T7): open from header → subjects list + schema pane
  await page.getByRole('button', { name: 'Schema Registry' }).click()
  await page.waitForTimeout(400)
  await expect(page.getByText('enrollment.events-value').first()).toBeVisible()
  // version toggles + compatibility footer from selected subject
  await expect(page.getByText(/Compatibility:/).first()).toBeVisible()
  await expect(page.getByText('EnrollmentEvent').first()).toBeVisible()
  // switch subject → different schema renders
  await page.getByText('payment.received-value').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('PaymentReceived').first()).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
