import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Kafka topics + NATS streams/subjects render in the Explorer; clicking opens a
// messages view; context menus offer Clear/Delete.
test('explorer: Kafka topics list, click opens consumer, context menu', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Events Kafka/ }).first().click()
  await page.waitForTimeout(500)

  // topics appear in the Explorer tree (demo: payments, enrollment.events)
  await expect(page.getByText('payments', { exact: true }).first()).toBeVisible({ timeout: 8000 })
  await expect(page.getByText('enrollment.events', { exact: true }).first()).toBeVisible()

  // right-click a topic → Clear messages + Delete topic
  await page.getByText('payments', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await expect(page.getByText('Clear messages', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Delete topic', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  // click a topic → opens a consumer (messages) tab
  await page.getByText('payments', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('tab', { name: /payments · consume/ }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('explorer: NATS streams → subjects, click opens messages, context menu', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)

  // streams appear (demo: ORDERS, EVENTS); expand ORDERS → subjects (dbl-click)
  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible({ timeout: 8000 })
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await expect(page.getByText('orders.eu', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('orders.us', { exact: true }).first()).toBeVisible()

  // right-click a subject → Clear messages + Delete subject
  await page.getByText('orders.eu', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await expect(page.getByText('Clear messages', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Delete subject', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  // click subject → opens a messages tab that lists messages
  await page.getByText('orders.eu', { exact: true }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('tab', { name: /orders.eu · messages/ }).first()).toBeVisible()
  await expect(page.getByText(/message\(s\)/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// A stream must keep ≥1 subject: deleting the ONLY subject offers to delete the
// whole stream instead of failing with a raw "Cannot remove the last subject".
test('explorer: NATS delete-subject — last subject offers to delete the stream', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)

  // capture confirm dialogs and cancel (non-destructive)
  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })

  // EVENTS has a single subject (events.*) → deleting it warns about the stream
  await expect(page.getByText('EVENTS', { exact: true }).first()).toBeVisible({ timeout: 8000 })
  await page.getByText('EVENTS', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('events.*', { exact: true }).first().click({ button: 'right' })
  await page.getByText('Delete subject', { exact: true }).first().click()
  await page.waitForTimeout(200)
  expect(dialogs.join('\n')).toContain('entire stream')

  // ORDERS has two subjects → normal per-subject removal confirm
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('orders.eu', { exact: true }).first().click({ button: 'right' })
  await page.getByText('Delete subject', { exact: true }).first().click()
  await page.waitForTimeout(200)
  expect(dialogs.some((m) => m.startsWith('Remove subject'))).toBe(true)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
