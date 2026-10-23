import { expect, test, type Locator, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, kafkaTopicView, openKafkaTopic, wsSection } from './helpers'

// The row under the pointer in a broker list (topics, streams, subjects, queues, keys,
// messages) lifts off its neighbours: an accent wash plus an accent bar on the left.

async function boot(page: Page, query = '') {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
}
const look = (row: Locator) =>
  row.evaluate((el) => {
    const s = getComputedStyle(el)
    return { bg: s.backgroundColor, shadow: s.boxShadow }
  })

async function expectLift(page: Page, row: Locator) {
  await page.mouse.move(2, 2)
  const rest = await look(row)
  await row.hover()
  await expect.poll(async () => (await look(row)).shadow).toContain('inset')
  const hot = await look(row)
  expect(hot.bg, 'the hovered row changes its background').not.toBe(rest.bg)
  expect(rest.shadow, 'no bar while resting').toBe('none')
}

test('kafka: topic rows and message rows lift on hover', async ({ page }) => {
  await boot(page)
  await openKafkaTopic(page, 'payments')
  const topics = page.locator('[data-tab-pane][data-active="true"]').getByRole('grid').first()
  await expectLift(page, topics.locator('tbody tr').filter({ hasText: 'enrollment.events' }))
  const msg = kafkaTopicView(page).locator('tbody tr').nth(2)
  await expect(msg).toBeVisible({ timeout: 8000 })
  await expectLift(page, msg)
})

test('nats: stream and subject rows lift on hover', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await wsSection(page, 'streams')
  const grid = page.locator('[data-stream-shell="nats"]').getByRole('grid', { name: 'Streams' })
  await expectLift(page, grid.locator('tbody tr[data-kind="stream"]').first())
  await expectLift(page, grid.locator('tbody tr[data-kind="subject"]').first())
})
