import { expect, test, type Locator } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Font rule for the message-broker screens: monospace ONLY for raw content (key,
// value / payload, subject). Numbers (partition, offset, seq) and times use the UI
// font with tabular figures, so they line up without reading like code.
const isMono = (l: Locator) => l.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase().includes('mono'))
const tabular = (l: Locator) => l.evaluate((el) => getComputedStyle(el).fontVariantNumeric.includes('tabular-nums'))

test('kafka + nats: mono only for raw content, numbers in the UI font', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // Kafka consumer: Partition · Offset · Time · Key · Value
  await page.getByRole('button', { name: /Events Kafka/ }).dblclick()
  await page.getByText('payments', { exact: true }).first().click()
  const k = page.locator('tbody tr').first().locator('td')
  await expect(k.first()).toBeVisible({ timeout: 8000 })
  for (const i of [0, 1, 2]) {
    expect(await isMono(k.nth(i)), `kafka column ${i} should use the UI font`).toBe(false)
    expect(await tabular(k.nth(i)), `kafka column ${i} should use tabular figures`).toBe(true)
  }
  expect(await isMono(k.nth(3).locator('.ds-key')), 'kafka key stays monospaced').toBe(true)
  expect(await isMono(k.nth(4).locator('.pp-v').first()), 'kafka value data stays monospaced').toBe(true)
  expect(await isMono(k.nth(4).locator('.pp-k').first()), 'kafka value keys read in the UI font').toBe(false)
  // time is not bold any more
  expect(Number(await k.nth(2).evaluate((el) => getComputedStyle(el).fontWeight))).toBeLessThan(600)
  // counts in the tree get thousands separators and the UI font
  const meta = page.getByText(/\d part · [\d,]+ msg/).first()
  await expect(meta).toBeVisible()
  expect(await isMono(meta)).toBe(false)
  await expect(page.getByText(/[\d]{4,} msg/)).toHaveCount(0)

  // NATS subject: Seq · Time · Subject · Key · Payload
  await page.getByRole('button', { name: /Messaging NATS/ }).dblclick()
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.getByText('orders.eu', { exact: true }).first().click()
  const n = page.locator('tbody tr').first().locator('td')
  await expect(n.first()).toBeVisible({ timeout: 8000 })
  for (const i of [0, 1]) expect(await isMono(n.nth(i)), `nats column ${i} should use the UI font`).toBe(false)
  expect(await isMono(n.nth(2)), 'nats subject stays monospaced').toBe(true)
  expect(await isMono(n.nth(3).locator('.ds-key')), 'nats key stays monospaced').toBe(true)
  expect(await isMono(n.nth(4).locator('.pp-v').first()), 'nats payload data stays monospaced').toBe(true)
})
