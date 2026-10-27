import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// New Connection picker: a Close button in the footer dismisses it (same action
// as the × / Escape), without touching the card-grid selection flow.
test('new connection picker: footer Close button dismisses it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByTitle('New connection').first().click()
  await page.waitForTimeout(150)

  const dialog = page.getByRole('dialog', { name: 'New Connection' })
  await expect(dialog).toBeVisible()
  // "Choose database type" is unique to the picker (the connection form has no such heading)
  await expect(page.getByText('Choose database type')).toBeVisible()

  // the footer Close button is present and dismisses the picker
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  await expect(close).toBeVisible()
  await close.click()
  await page.waitForTimeout(150)
  await expect(page.getByText('Choose database type')).toHaveCount(0)

  // reopening still works, and a card still opens the connection form (unaffected)
  await page.getByTitle('New connection').first().click()
  await page.waitForTimeout(150)
  await expect(page.getByText('Choose database type')).toBeVisible()
  await page.getByRole('dialog', { name: 'New Connection' }).getByText('PostgreSQL', { exact: true }).click()
  await page.waitForTimeout(200)
  // picker replaced by the connection form — its heading is gone
  await expect(page.getByText('Choose database type')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Commercial picker: grouped cards that lift on hover, and a search box (Enter opens
// the form when exactly one type matches).
test('new connection picker: cards lift on hover, search narrows and Enter picks', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByTitle('New connection').first().click()
  const dialog = page.getByRole('dialog', { name: 'New Connection' })
  await expect(dialog.getByText('Relational databases')).toBeVisible()
  await expect(dialog.getByText('Message brokers & streaming')).toBeVisible()

  const card = dialog.locator('.picker-card[title="MySQL"]')
  const lift = () => card.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42)
  const shadow = () => card.evaluate((el) => getComputedStyle(el).boxShadow)
  const restShadow = await shadow()
  expect(await lift()).toBe(0)
  await card.hover()
  await expect.poll(lift).toBeLessThan(0) // moved up
  expect(await shadow()).not.toBe(restShadow) // and casts a bigger shadow

  // search: the box has focus; typing narrows the cards
  const search = dialog.getByLabel('Search database types')
  await expect(search).toBeFocused()
  await search.fill('broker')
  await expect(dialog.locator('.picker-card')).toHaveCount(4) // Kafka, Redpanda, NATS, RabbitMQ
  await expect(dialog.locator('.picker-card[title="Redpanda"]')).toBeVisible()
  await search.fill('zzzz')
  await expect(dialog.getByText(/Nothing matches/)).toBeVisible()
  await search.fill('duck')
  await expect(dialog.locator('.picker-card')).toHaveCount(1)
  await search.press('Enter')
  await expect(page.getByText('Choose database type')).toHaveCount(0)
  await expect(page.getByRole('dialog').getByText('New connection', { exact: true })).toBeVisible()
})

// The picker is wide enough for four cards a row with every description in full
// (the old 740px grid cut "open-source SQL…", "no ZooKeep…").
test('new connection picker: wide enough that no description is cut off', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByTitle('New connection').first().click()
  const dialog = page.getByRole('dialog', { name: 'New Connection' })
  await expect(dialog).toBeVisible()
  expect((await dialog.boundingBox())!.width).toBeGreaterThanOrEqual(1150)

  // four cards per row
  const tops = await dialog.locator('.pk-grid').first().locator('.picker-card').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
  expect(tops.filter((t) => t === tops[0]).length).toBe(4)

  const cut = await dialog.locator('.pk-desc').evaluateAll((els) =>
    els.filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent),
  )
  expect(cut, `descriptions cut off: ${cut.join(' | ')}`).toEqual([])
  if (process.env.SHOT_DIR) await dialog.screenshot({ path: `${process.env.SHOT_DIR}/picker.png` })

  // a narrow window still fits the picker, with fewer columns
  await page.setViewportSize({ width: 800, height: 800 })
  const narrow = (await dialog.boundingBox())!
  expect(narrow.x).toBeGreaterThanOrEqual(0)
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(800)
})
