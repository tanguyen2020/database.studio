import { expect, test, type Locator } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openKafkaTopic } from './helpers'

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
  const ws = await openKafkaTopic(page, 'payments')
  const k = page.locator('[data-kafka-topic-view="payments"] tbody tr').first().locator('td')
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
  // counts in the Topics table read in the UI font, compact (15.2K), never a raw 15200
  const counts = ws.getByRole('grid', { name: 'Topics' }).locator('.kc-num')
  await expect(counts.first()).toBeVisible()
  expect(await isMono(counts.first())).toBe(false)
  for (const t of await counts.allInnerTexts()) expect(t, 'topic count is compact').not.toMatch(/\d{4,}/)

  // NATS subject: Seq · Time · Subject · Key · Payload
  await page.getByRole('button', { name: /Messaging NATS/ }).dblclick()
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.getByText('orders.eu', { exact: true }).first().click()
  const n = page.locator('[data-nats-subject-view] tbody tr').first().locator('td')
  await expect(n.first()).toBeVisible({ timeout: 8000 })
  for (const i of [0, 1]) expect(await isMono(n.nth(i)), `nats column ${i} should use the UI font`).toBe(false)
  expect(await isMono(n.nth(2)), 'nats subject stays monospaced').toBe(true)
  expect(await isMono(n.nth(3).locator('.ds-key')), 'nats key stays monospaced').toBe(true)
  expect(await isMono(n.nth(4).locator('.pp-v').first()), 'nats payload data stays monospaced').toBe(true)
})

// Names in the broker lists (topic, stream, queue, key) read as plain text: UI font,
// the normal text colour (no link blue), bolder when their row is selected, and the
// selected row is a neutral highlight rather than a blue fill.
test('broker lists: names are plain text, the selected row is neutral', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  const ws = await openKafkaTopic(page, 'payments')
  const grid = ws.getByRole('grid', { name: 'Topics' })
  const row = grid.locator('tbody tr', { hasText: 'payments' }).first()
  const name = row.locator('.ds-name')
  await expect(row).toHaveAttribute('aria-selected', 'true')
  const s = await name.evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--tbl-name)'
    document.body.appendChild(probe)
    const p = getComputedStyle(probe)
    const out = {
      color: getComputedStyle(el).color,
      text: p.color,
      font: getComputedStyle(el).fontFamily.toLowerCase(),
      weight: Number(getComputedStyle(el).fontWeight),
      rowBg: getComputedStyle(el.closest('tr')!).backgroundColor,
    }
    probe.remove()
    return out
  })
  expect(s.font, 'a name uses the UI font').not.toContain('mono')
  expect(s.color, 'a name uses the soft table-name colour, not link blue').toBe(s.text)
  expect(s.weight, 'the selected name is bolder').toBeGreaterThanOrEqual(600)
  // neutral: red, green and blue channels of the highlight stay close together
  // color-mix() comes back as color(srgb 0–1 …), rgb() as 0–255
  const scale = s.rowBg.startsWith('color(') ? 255 : 1
  const [r, g, b] = (s.rowBg.replace(/^color\(srgb/, '').match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => Number(v) * scale)
  expect(Math.max(r, g, b) - Math.min(r, g, b), `selected row ${s.rowBg} is not tinted`).toBeLessThan(12)
  // an unselected name is regular weight
  const other = grid.locator('tbody tr', { hasText: 'enrollment.events' }).first().locator('.ds-name')
  const otherWeight = Number(await other.evaluate((el) => getComputedStyle(el).fontWeight))
  expect(otherWeight, 'an unselected name is a regular-to-medium weight').toBeGreaterThanOrEqual(400)
  expect(otherWeight, 'an unselected name is lighter than the selected one').toBeLessThan(s.weight)
})
