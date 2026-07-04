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
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
