import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, natsSubjectView, openKafkaTopic, previewText, showFormatted, wsSection } from './helpers'

// The create / clear / delete actions the old Kafka + NATS sidebar trees offered, now
// in their workspaces (Kafka · NATS have no object tree: a connection opens its
// workspace tab). The demo brokers are stateful, so a delete really stays gone.

async function boot(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  return errors
}

async function openOrders(page: Page) {
  await page.getByRole('button', { name: /Messaging NATS/ }).first().dblclick()
  const ws = page.locator('[data-stream-shell="nats"]')
  await expect(ws).toBeVisible({ timeout: 8000 })
  await wsSection(page, 'streams')
  const grid = ws.getByRole('grid', { name: 'Streams' })
  await grid.locator('tbody tr[data-kind="stream"]').filter({ hasText: 'ORDERS' }).click()
  await expect(natsSubjectView(page)).toHaveAttribute('data-nats-subject-view', 'orders.eu')
  return { ws, grid }
}

test('kafka: Create topic adds it to the Topics table; Delete topic confirms and it stays gone', async ({ page }) => {
  const errors = await boot(page)
  const ws = await openKafkaTopic(page, 'payments')
  const rows = ws.getByRole('grid', { name: 'Topics' }).locator('tbody tr')

  await ws.getByRole('button', { name: '+ Create topic' }).first().click()
  const add = page.getByRole('dialog')
  await add.getByPlaceholder('e.g. orders.events').fill('demo.new.topic')
  await add.getByRole('button', { name: 'Create' }).click()
  await expect(rows.filter({ hasText: 'demo.new.topic' })).toBeVisible()

  // Delete topic… names the consequence; the backdrop does not dismiss it
  await rows.filter({ hasText: 'demo.new.topic' }).click()
  await ws.getByRole('button', { name: 'Delete topic…' }).click()
  const del = page.getByRole('alertdialog', { name: 'Delete topic' })
  await expect(del).toContainText('This cannot be undone')
  await page.mouse.click(6, 6)
  await expect(del).toBeVisible()
  await del.getByRole('button', { name: 'Delete topic', exact: true }).click()
  await expect(del).toHaveCount(0)
  await expect(rows.filter({ hasText: 'demo.new.topic' })).toHaveCount(0)
  await expect(rows.filter({ hasText: 'payments' })).toBeVisible()

  // …and it STAYS gone after a re-read from the broker
  await ws.getByRole('button', { name: /^Refresh/ }).first().click()
  await expect(rows.filter({ hasText: 'payments' })).toBeVisible()
  await expect(rows.filter({ hasText: 'demo.new.topic' })).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: the streams filter finds a stream by its name or one of its subjects', async ({ page }) => {
  const errors = await boot(page)
  const { ws, grid } = await openOrders(page)
  const filter = ws.getByRole('textbox', { name: 'Filter streams and subjects…' })
  const row = (name: string) => grid.locator('tbody tr[data-kind="stream"]').filter({ hasText: name })

  await filter.fill('order')
  await expect(row('ORDERS')).toBeVisible()
  await expect(row('EVENTS')).toHaveCount(0)
  // "eu" is only in the subject orders.eu → the ORDERS stream, not EVENTS
  await filter.fill('eu')
  await expect(row('ORDERS')).toBeVisible()
  await expect(row('EVENTS')).toHaveCount(0)
  // nothing matching says so, with a way back
  await filter.fill('zzz-none')
  await expect(ws.getByText('No matches')).toBeVisible()
  await ws.getByRole('button', { name: 'Clear the filter' }).click()
  await expect(row('ORDERS')).toBeVisible()
  await expect(row('EVENTS')).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: Add subject… publishes on a new subject; the grid ＋ Add prefills the subject', async ({ page }) => {
  const errors = await boot(page)
  const { ws } = await openOrders(page)

  await ws.getByRole('button', { name: '+ Add subject…' }).click()
  const dlg = page.getByRole('dialog')
  await expect(dlg.getByText('Add subject')).toBeVisible()
  await dlg.getByPlaceholder('e.g. orders.eu').fill('orders.apac')
  await dlg.getByPlaceholder(/"id"/).fill('{"id":9001}')
  // backdrop click must NOT close the form
  await page.mouse.click(6, 6)
  await expect(page.getByRole('dialog').getByText('Add subject')).toBeVisible()
  await page.getByRole('dialog').getByText('Publish', { exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // the subject grid's ＋ Add → "Add message" with the open subject prefilled
  await natsSubjectView(page).getByText('＋ Add', { exact: true }).first().click()
  const msg = page.getByRole('dialog')
  await expect(msg.getByText('Add message')).toBeVisible()
  await expect(msg.getByPlaceholder('e.g. orders.eu')).toHaveValue('orders.eu')
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: Remove subject and Delete stream are separate confirms; a deleted stream stays gone', async ({ page }) => {
  const errors = await boot(page)
  const { ws, grid } = await openOrders(page)

  // Remove orders.eu… — its own confirm; it never talks about dropping the stream
  await ws.getByRole('button', { name: /^Remove orders\.eu/ }).click()
  const sub = page.getByRole('alertdialog', { name: 'Remove subject' })
  await expect(sub).toContainText('The stream and its other subjects stay')
  await expect(sub.getByText(/Delete ORDERS/)).toHaveCount(0)
  await sub.getByRole('button', { name: 'Cancel' }).click()
  await expect(sub).toHaveCount(0)

  // Delete stream… names what is lost
  await ws.getByRole('button', { name: 'Delete stream…' }).click()
  const del = page.getByRole('alertdialog', { name: 'Delete stream' })
  await expect(del).toContainText('Delete ORDERS with its')
  await page.mouse.click(6, 6) // the backdrop does not dismiss it
  await expect(del).toBeVisible()
  await del.getByRole('button', { name: 'Delete stream', exact: true }).click()
  await expect(del).toHaveCount(0)
  await expect(grid.locator('tbody tr[data-kind="stream"]').filter({ hasText: 'ORDERS' })).toHaveCount(0)
  await expect(grid.locator('tbody tr[data-kind="stream"]').filter({ hasText: 'EVENTS' })).toBeVisible()

  // …and it STAYS gone after a re-read from the server
  await ws.getByRole('button', { name: /^Refresh/ }).first().click()
  await expect(grid.locator('tbody tr[data-kind="stream"]').filter({ hasText: 'EVENTS' })).toBeVisible()
  await expect(grid.locator('tbody tr[data-kind="stream"]').filter({ hasText: 'ORDERS' })).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: Clear messages of a subject asks first; the messages view stays open', async ({ page }) => {
  const errors = await boot(page)
  await openOrders(page)
  const view = natsSubjectView(page)
  await view.getByText('Clear messages', { exact: true }).click()
  const dlg = page.getByRole('dialog').filter({ hasText: 'Clear all messages of subject' })
  await expect(dlg).toBeVisible()
  // backdrop click must NOT confirm/close
  await page.mouse.click(6, 6)
  await expect(dlg).toBeVisible()
  await dlg.getByRole('button', { name: 'Confirm' }).click()
  await expect(dlg).toHaveCount(0)
  await expect(view).toHaveAttribute('data-nats-subject-view', 'orders.eu')
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: subject messages show Subject and Key columns; a payload opens as a tree', async ({ page }) => {
  const errors = await boot(page)
  await openOrders(page)
  const view = natsSubjectView(page)
  await expect(view.getByRole('columnheader', { name: 'Subject', exact: true })).toBeVisible()
  await expect(view.getByRole('columnheader', { name: 'Key', exact: true })).toBeVisible()

  await view.getByTitle('View payload as JSON').first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('tree', { name: 'Payload tree' })).toBeVisible()
  await showFormatted(page)
  await expect.poll(() => previewText(page, 'Payload'), { timeout: 10_000 }).toContain('"id":')
  await dialog.getByText('Close', { exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})
