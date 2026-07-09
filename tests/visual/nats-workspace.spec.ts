import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('nats workspace opens with JetStream selected; toggling shows publish/request forms', async ({ page }) => {
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
  // JetStream panel is auto-selected on open (double-click connection) → streams table renders.
  // Scope to the workspace stream row (the sidebar explorer also lists an ORDERS stream).
  const streamRow = page.getByRole('button', { name: /ORDERS orders\.eu/ })
  await expect(streamRow).toBeVisible()
  // header controls + demo info line (server version) still render
  await expect(page.getByRole('button', { name: 'Subscribe' })).toBeVisible()
  await expect(page.getByText(/NATS 2\.10/).first()).toBeVisible()

  // click a stream → consumers + peek control
  await streamRow.click()
  await page.waitForTimeout(300)
  await expect(page.getByText('order-processor').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Peek' })).toBeVisible()

  // toggle JetStream off → monitor view with publish/request forms
  await page.getByRole('button', { name: 'JetStream' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Request ▸' })).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
