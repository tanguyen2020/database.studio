import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, kafkaTopicView, openKafkaTopic, previewText, wsSection } from './helpers'

// Message tools every commercial broker client has: Kafka "Value as Hex" and
// "Copy to Produce", NATS "Open message by sequence" (SPEC-KAFKA-WORKSPACE K3,
// SPEC-NATS-WORKSPACE "Còn thiếu").

async function boot(page: Page, query = '') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  return errors
}

const dialog = (page: Page) => page.getByRole('dialog', { name: /^Message/ })

test('kafka: values read as hex in the grid and in the viewer', async ({ page }) => {
  const errors = await boot(page)
  await openKafkaTopic(page, 'payments')
  const view = kafkaTopicView(page)
  const firstRow = view.locator('tbody tr').first()
  await expect(firstRow).toBeVisible({ timeout: 8000 })

  await view.getByLabel('Decode').selectOption('hex')
  // {"messageId":… in bytes
  await expect(firstRow.locator('.km-hex')).toHaveText(/^7b 22 6d 65 73 73 61 67/)

  await firstRow.getByTitle('View value as JSON').click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: 'Hex' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => previewText(page, 'Payload')).toMatch(/^00000000 {2}7b 22 6d 65 73 73 61 67 {2}65 49 64 22 3a 22 30 31 {2}\|\{"messageId":"01\|/)
  // back to the text: a JSON value opens as its tree / formatted views again
  await dialog(page).getByRole('button', { name: 'Formatted' }).click()
  await expect.poll(() => previewText(page, 'Payload')).toContain('"messageId"')
  expect(errors, errors.join('\n')).toEqual([])
})

test('kafka: a binary value is shown as hex, never as garbled text', async ({ page }) => {
  const errors = await boot(page, '?kafkaBinary=1')
  await openKafkaTopic(page, 'payments')
  const view = kafkaTopicView(page)
  await expect(view.locator('tbody tr').first()).toBeVisible({ timeout: 8000 })
  // decode stays UTF-8, but the binary record still reads as its bytes
  const binRow = view.locator('tbody tr').filter({ has: page.locator('.km-hex', { hasText: 'ff 00 01 fe' }) }).first()
  await expect(binRow).toBeVisible()
  await expect(binRow.locator('.km-hex')).toHaveAttribute('title', 'Binary value — not valid UTF-8')

  await binRow.getByTitle('View value as JSON').click()
  await expect(dialog(page).getByRole('button', { name: 'Hex' })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog(page).getByText('Binary — not valid UTF-8')).toBeVisible()
  await expect.poll(() => previewText(page, 'Payload')).toMatch(/^00000000 {2}ff 00 01 fe/)
  await expect(dialog(page).getByText('4 B', { exact: true })).toBeVisible()

  // Copy to Produce says what Produce cannot send exactly
  await dialog(page).getByRole('button', { name: 'Copy to Produce' }).click()
  const copied = page.locator('[data-produce-copied]')
  await expect(copied).toContainText('This value is binary')
  await expect(copied).toContainText('Its header is not sent')
  expect(errors, errors.join('\n')).toEqual([])
})

test('kafka: Copy to Produce opens Produce filled with the message', async ({ page }) => {
  const errors = await boot(page)
  const ws = await openKafkaTopic(page, 'payments')
  const view = kafkaTopicView(page)
  const firstRow = view.locator('tbody tr').first()
  await expect(firstRow).toBeVisible({ timeout: 8000 })
  const offset = (await firstRow.locator('td').nth(1).innerText()).trim()
  const key = (await firstRow.locator('.ds-key').innerText()).trim()

  await firstRow.getByRole('button', { name: 'Copy to Produce' }).click()
  const tablist = ws.getByRole('tablist', { name: 'Topic details' })
  await expect(tablist.getByRole('tab', { name: 'Produce' })).toHaveAttribute('aria-selected', 'true')
  const produce = ws.locator('[data-kafka-produce-view="payments"]')
  await expect(produce.locator('[data-produce-copied]')).toContainText(`offset ${offset}`)
  await expect(produce.locator('[data-produce-copied]')).not.toContainText('binary')
  await expect(produce.getByLabel(/^Key/)).toHaveValue(key)
  await expect(produce.getByLabel('Value')).toHaveValue(new RegExp(`"seq":${offset}`))
  // the copy goes to the topic it came from; the partition stays automatic
  await expect(produce.getByLabel('Topic')).toHaveValue('payments')
  await expect(produce.getByLabel(/^Partition/)).toHaveValue('')

  // leaving Produce drops the copy: coming back is a clean form
  await tablist.getByRole('tab', { name: 'Messages' }).click()
  await tablist.getByRole('tab', { name: 'Produce' }).click()
  await expect(produce.locator('[data-produce-copied]')).toHaveCount(0)
  await expect(produce.getByLabel('Value')).toHaveValue('')
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: open a stream message by its sequence number', async ({ page }) => {
  const errors = await boot(page)
  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  const ws = page.locator('[data-stream-shell="nats"]')
  await expect(ws).toBeVisible({ timeout: 8000 })
  await wsSection(page, 'streams')
  await ws.getByRole('grid', { name: 'Streams' }).locator('tbody tr[data-kind="stream"]').filter({ hasText: 'ORDERS' }).click()

  const box = ws.getByLabel('Message sequence number')
  const open = ws.getByRole('button', { name: 'Open message' })
  await expect(open).toBeDisabled()

  // not a number: said in words, nothing asked of the server
  await box.fill('abc')
  await open.click()
  await expect(ws.getByRole('alert')).toHaveText('A sequence is a whole number, like 1042.')
  // typing again clears the complaint
  await box.fill('42')
  await expect(ws.getByRole('alert')).toHaveCount(0)

  await box.press('Enter')
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page)).toHaveAccessibleName('Message #42')
  await expect(dialog(page).getByText('orders.us')).toBeVisible()
  // a JSON object opens as its tree; Formatted shows the document
  await dialog(page).getByRole('button', { name: 'Formatted' }).click()
  await expect.poll(() => previewText(page, 'Payload')).toContain('"id": 42')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)

  // a sequence the stream no longer holds: the server's refusal, in a sentence
  await box.fill('13')
  await open.click()
  await expect(ws.getByRole('alert')).toContainText('There is no message #13 in ORDERS. It was deleted or expired')

  // another stream: the box and its message start over
  await ws.getByRole('grid', { name: 'Streams' }).locator('tbody tr[data-kind="stream"]').filter({ hasText: 'EVENTS' }).click()
  await expect(ws.getByLabel('Message sequence number')).toHaveValue('')
  await expect(ws.getByRole('alert')).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})

async function openNatsStreams(page: Page, query = '') {
  const errors = await boot(page, query)
  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  const ws = page.locator('[data-stream-shell="nats"]')
  await expect(ws).toBeVisible({ timeout: 8000 })
  await wsSection(page, 'streams')
  return { ws, errors }
}
const statsCalls = (page: Page) => page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.nats_js_subject_stats ?? 0)

test('nats: each subject in the Streams tree shows its own message count', async ({ page }) => {
  const { ws, errors } = await openNatsStreams(page)
  const grid = ws.getByRole('grid', { name: 'Streams' })
  const subjectRow = (s: string) => grid.locator('tbody tr[data-kind="subject"]').filter({ hasText: s })

  // the count sits in the Messages column of the subject's own row
  const count = subjectRow('orders.eu').locator('[data-subject-count="orders.eu"]')
  await expect(count).toHaveText('250')
  await expect(count).toHaveAttribute('title', '250 messages on orders.eu')
  // a filter subject counts every message under it — the same total the grid pages through
  await expect(subjectRow('events.>').locator('[data-subject-count="events.>"]')).toHaveText('250')

  // counted once: folding a stream and opening it again does not ask the server again
  const asked = await statsCalls(page)
  expect(asked).toBeGreaterThan(0)
  const ordersRow = grid.locator('tbody tr[data-kind="stream"]').filter({ hasText: 'ORDERS' })
  await ordersRow.getByRole('button', { name: 'Collapse ORDERS' }).click()
  await expect(subjectRow('orders.eu')).toHaveCount(0)
  await ordersRow.getByRole('button', { name: 'Expand ORDERS' }).click()
  await expect(count).toHaveText('250')
  expect(await statsCalls(page)).toBe(asked)

  // the messages of that subject agree with the count
  await subjectRow('orders.eu').click()
  await expect(ws.locator('[data-nats-subject-view="orders.eu"]').getByText('250 records').first()).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('nats: a subject that cannot be counted says so instead of showing 0', async ({ page }) => {
  const { ws, errors } = await openNatsStreams(page, '?subjectStatsFail=1')
  const cell = ws.getByRole('grid', { name: 'Streams' }).locator('[data-subject-count="orders.eu"]')
  await expect(cell).toHaveText('?')
  await expect(cell).toHaveAttribute('title', /^Could not count: permissions violation/)
  expect(errors, errors.join('\n')).toEqual([])
})
