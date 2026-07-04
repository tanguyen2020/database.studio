import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('nats workspace opens with subscribe + publish/request forms', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  // double-click the sidebar NATS connection row → connect + open NATS workspace
  const row = page.getByRole('button', { name: /Messaging NATS/ })
  await row.dblclick()
  await page.waitForTimeout(600)
  await expect(page.getByRole('button', { name: 'Subscribe' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Request ▸' })).toBeVisible()
  // demo info line (server version) renders
  await expect(page.getByText(/NATS 2\.10/).first()).toBeVisible()

  // JetStream panel (T10): toggle → streams render, click stream → consumers
  await page.getByRole('button', { name: 'JetStream' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByText('ORDERS').first()).toBeVisible()
  await page.getByText('ORDERS').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('order-processor').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Peek' })).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
