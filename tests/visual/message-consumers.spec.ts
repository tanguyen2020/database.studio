import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, kafkaTopicView, natsSubjectView, openKafkaTopic } from './helpers'

// A topic / subject tab has two screens — Messages and Consumer groups (Kafka) /
// Consumers (NATS) — and each loads ITS OWN data only when opened. "View
// messages" on a consumer goes back to Messages seen through that consumer: a
// Status column + Processed / Not processed.

async function boot(page: Page, query = '') {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
}
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.[c] ?? 0, cmd)
const pane = (page: Page) => page.locator('[data-tab-pane][data-active="true"]')
const states = (page: Page) => pane(page).locator('tbody [data-state]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))

async function openNatsSubject(page: Page) {
  await page.getByRole('button', { name: /Messaging NATS/ }).dblclick()
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.getByText('orders.eu', { exact: true }).first().click()
  const rows = natsSubjectView(page).locator('tbody tr')
  await expect(rows.first()).toBeVisible({ timeout: 8000 })
  return rows
}

test('kafka: Messages and Consumer groups are separate screens, each loading its own data', async ({ page }) => {
  await boot(page)
  await openKafkaTopic(page, 'payments')
  const view = kafkaTopicView(page)
  const viewStates = () => view.locator('tbody [data-state]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
  const rows = view.locator('tbody tr')
  await expect(rows.first()).toBeVisible({ timeout: 8000 })
  // the workspace around the topic reads the group list once for its own
  // Consumers tab; the Messages screen must not add a single call to it
  await page.waitForTimeout(300)
  const groupsBase = await calls(page, 'kafka_consumer_groups')
  const lagBase = await calls(page, 'kafka_group_lag')

  // the Messages screen reads messages only — not a single consumer-group call
  expect(await calls(page, 'kafka_consumer_groups')).toBe(groupsBase)
  expect(await calls(page, 'kafka_group_lag')).toBe(lagBase)
  await expect(view.getByRole('columnheader', { name: 'Status' })).toHaveCount(0)
  await expect(view.getByTestId('consumer-groups')).toHaveCount(0)

  // Consumer groups screen: ONE list call, names + what it already carries
  await view.getByRole('tab', { name: /Consumer groups/ }).click()
  await expect(view.getByRole('tab', { name: /Consumer groups/ })).toHaveAttribute('aria-selected', 'true')
  const list = view.locator('tbody')
  await expect(list.locator('[data-group="payment-processor"]')).toBeVisible()
  expect(await calls(page, 'kafka_consumer_groups')).toBe(groupsBase + 1)
  expect(await calls(page, 'kafka_group_lag')).toBe(lagBase)
  expect(await calls(page, 'kafka_group_topic_lag')).toBe(0)
  // "Reading this topic" = the group whose running members are assigned payments
  await expect(list.locator('[data-group]')).toHaveCount(1)
  await expect(list.locator('[data-group="payment-processor"]')).toContainText('payments')
  // All groups: the idle one and the one on another topic too
  await view.getByRole('button', { name: /^All groups/ }).click()
  await expect(list.locator('[data-group]')).toHaveCount(3)
  await expect(list.locator('[data-group="audit-log"]')).toContainText('idle')
  // the message grid is not on this screen
  await expect(view.getByRole('columnheader', { name: 'Offset' })).toHaveCount(0)
  // switching back and forth does not reload the list
  await view.getByRole('tab', { name: 'Messages' }).click()
  await view.getByRole('tab', { name: /Consumer groups/ }).click()
  expect(await calls(page, 'kafka_consumer_groups')).toBe(groupsBase + 1)

  // View messages on payment-processor → Messages through its eyes; reads its
  // offsets on THIS topic only
  await list.locator('[data-group="payment-processor"]').getByRole('button', { name: 'View messages ›' }).click()
  await expect(view.getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true')
  const bar = view.getByTestId('consumer-groups')
  await expect(bar).toContainText('payment-processor')
  await expect(bar).toContainText('behind')
  expect(await calls(page, 'kafka_group_topic_lag')).toBe(1)
  expect(await calls(page, 'kafka_group_lag')).toBe(lagBase)
  await expect(view.getByRole('columnheader', { name: 'Status' })).toBeVisible()
  // committed 15100 on p0 → the newest messages are not processed yet
  await expect(rows.first().locator('[data-state]')).toHaveAttribute('data-state', 'pending')
  const all = await rows.count()
  await bar.getByRole('button', { name: 'Processed', exact: true }).click()
  await expect(view.getByText('Nothing here for payment-processor')).toBeVisible()
  await bar.getByRole('button', { name: 'Not processed', exact: true }).click()
  await expect(rows).toHaveCount(all)
  expect((await viewStates()).every((s) => s === 'pending')).toBe(true)

  // the value viewer states the group's verdict
  await rows.first().getByTitle('View value as JSON').click()
  const dialog = page.getByRole('dialog', { name: 'Message' })
  await expect(dialog.getByText('payment-processor', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Not processed', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()

  // audit-log (idle, committed 15400) — opened from All groups, it has read everything
  await view.getByRole('tab', { name: /Consumer groups/ }).click()
  await list.locator('[data-group="audit-log"]').getByRole('button', { name: 'View messages ›' }).click()
  await expect(bar).toContainText('audit-log')
  await expect.poll(async () => (await viewStates()).every((s) => s === 'processed')).toBe(true)

  // × stops viewing as the group
  await bar.getByRole('button', { name: 'Stop viewing as this group' }).click()
  await expect(view.getByTestId('consumer-groups')).toHaveCount(0)
  await expect(view.getByRole('columnheader', { name: 'Status' })).toHaveCount(0)
})

test('nats: Consumers screen lists the subject’s consumers; View messages shows acked / in flight / pending', async ({ page }) => {
  await boot(page)
  const rows = await openNatsSubject(page)
  // the stream details next to it count the stream's consumers once; the subject's
  // Messages screen itself asks for none
  const consumerCalls = await calls(page, 'nats_js_consumers')

  await natsSubjectView(page).getByRole('tab', { name: /Subject consumers/ }).click()
  const list = natsSubjectView(page).locator('tbody')
  await expect(list.locator('[data-consumer="eu-fulfilment"]')).toContainText('orders.eu')
  await expect(list.locator('[data-consumer="audit"]')).toContainText('whole stream')
  // order-processor filters orders.new → not a consumer of orders.eu
  await expect(list.locator('[data-consumer="order-processor"]')).toHaveCount(0)
  await expect(pane(page)).toContainText('1 other consumer(s) of ORDERS')
  // opening the Subject consumers screen is what loads them (once)
  expect(await calls(page, 'nats_js_consumers')).toBe(consumerCalls + 1)

  // double-click a row = View messages
  await list.locator('[data-consumer="eu-fulfilment"]').dblclick()
  await expect(page.getByTestId('subject-consumers')).toContainText('eu-fulfilment')
  // acked up to #980, delivered up to #996
  const pairs = await rows.evaluateAll((trs) => trs.map((tr) => [Number(tr.querySelector('td')?.textContent), tr.querySelector('[data-state]')?.getAttribute('data-state')]))
  for (const [seq, st] of pairs) {
    const want = (seq as number) <= 980 ? 'processed' : (seq as number) <= 996 ? 'in-flight' : 'pending'
    expect(st, `seq ${seq}`).toBe(want)
  }
  const bar = page.getByTestId('subject-consumers')
  await bar.getByRole('button', { name: 'Not processed', exact: true }).click()
  expect((await states(page)).every((s) => s === 'pending' || s === 'in-flight')).toBe(true)
  await bar.getByRole('button', { name: 'Processed', exact: true }).click()
  expect((await states(page)).every((s) => s === 'processed')).toBe(true)
  expect(await rows.count()).toBeGreaterThan(0)
})

test('nats: dozens of consumers live on their own screen, searchable', async ({ page }) => {
  await boot(page, '?manyConsumers=60')
  await openNatsSubject(page)
  // the Messages screen carries no consumer list at all
  await expect(natsSubjectView(page).locator('[data-consumer]')).toHaveCount(0)
  await natsSubjectView(page).getByRole('tab', { name: /Subject consumers/ }).click()
  const list = natsSubjectView(page).locator('tbody')
  await expect(list.locator('[data-consumer]')).toHaveCount(62) // 60 + eu-fulfilment + audit
  await expect(natsSubjectView(page).getByRole('tab', { name: /Subject consumers/ })).toContainText('62')
  await pane(page).getByRole('textbox', { name: 'Search consumers' }).fill('service-42')
  await expect(list.locator('[data-consumer]')).toHaveCount(1)
  await expect(pane(page)).toContainText('1 of 62 consumers')
  await list.locator('[data-consumer="service-42-worker"]').getByRole('button', { name: 'View messages ›' }).click()
  await expect(page.getByTestId('subject-consumers')).toContainText('service-42-worker')
  await expect(page.getByRole('columnheader', { name: 'Status' })).toBeVisible()
})
