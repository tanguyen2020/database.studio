import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, previewText } from './helpers'

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

  // Filter topics narrows the list (task 1)
  const topicFilter = page.getByPlaceholder('Filter topics…')
  await expect(topicFilter).toBeVisible()
  await topicFilter.fill('pay')
  await page.waitForTimeout(150)
  await expect(page.getByText('payments', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('enrollment.events', { exact: true })).toHaveCount(0)
  await topicFilter.fill('')
  await page.waitForTimeout(150)
  await expect(page.getByText('enrollment.events', { exact: true }).first()).toBeVisible()

  // Add topic (task 1): button below the filter opens a dialog; created topic appears
  await page.getByRole('button', { name: 'Add topic' }).click()
  const addDlg = page.getByRole('dialog')
  await expect(addDlg.getByPlaceholder('e.g. orders.events')).toBeVisible()
  await addDlg.getByPlaceholder('e.g. orders.events').fill('demo.new.topic')
  await addDlg.getByRole('button', { name: 'Create' }).click()
  await page.waitForTimeout(250)
  await expect(page.getByText('demo.new.topic', { exact: true }).first()).toBeVisible()

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
  await expect(page.getByText(/record/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Per-stream subject filter (Filter subjects… + Clear filter) narrows a stream's
// subjects; Add subject… / Add message… open the publish dialog.
test('explorer: NATS stream subject filter + Add subject dialog', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible({ timeout: 8000 })

  // right-click ORDERS → Filter subjects… → input appears; both subjects visible
  await page.getByText('ORDERS', { exact: true }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Filter subjects…' }).click()
  await page.waitForTimeout(200)
  const filterInput = page.getByPlaceholder('Filter subjects…')
  await expect(filterInput).toBeVisible()
  await expect(page.getByText('orders.eu', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('orders.us', { exact: true }).first()).toBeVisible()

  // type "eu" → orders.us is filtered out
  await filterInput.fill('eu')
  await page.waitForTimeout(200)
  await expect(page.getByText('orders.eu', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('orders.us', { exact: true })).toHaveCount(0)

  // clear the filter via the × → both visible again
  await page.getByTitle('Clear filter').first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText('orders.us', { exact: true }).first()).toBeVisible()

  // right-click ORDERS → Add subject… → publish dialog (subject empty for a new subject)
  await page.getByText('ORDERS', { exact: true }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add subject…' }).click()
  await page.waitForTimeout(200)
  const dlg = page.getByRole('dialog')
  await expect(dlg.getByText('Add subject')).toBeVisible()
  await dlg.getByPlaceholder('e.g. orders.eu').fill('orders.apac')
  await dlg.getByPlaceholder(/"id"/).fill('{"id":9001}')
  // backdrop click must NOT close the form
  await page.mouse.click(6, 6)
  await page.waitForTimeout(150)
  await expect(page.getByRole('dialog').getByText('Add subject')).toBeVisible()
  // publish → dialog closes (demo accepts)
  await page.getByRole('dialog').getByText('Publish', { exact: true }).click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// A filter funnel on the right of each NATS stream row opens the subject filter
// directly (no need for the context menu), and toggles it closed again.
test('explorer: NATS stream funnel icon opens/closes the subject filter', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible({ timeout: 8000 })

  // the ORDERS stream row (before expanding, only stream rows contain "orders")
  const ordersRow = page.locator('[role="treeitem"]').filter({ hasText: 'ORDERS' }).first()
  // click the funnel on its right → the subject filter box appears + both subjects
  await ordersRow.getByTitle('Filter', { exact: true }).click()
  await page.waitForTimeout(200)
  const filterInput = page.getByPlaceholder('Filter subjects…')
  await expect(filterInput).toBeVisible()
  // the funnel focuses the input immediately so you can type right away
  await expect(filterInput).toBeFocused()
  await expect(page.getByText('orders.us', { exact: true }).first()).toBeVisible()

  // type "eu" → orders.us filtered out
  await filterInput.fill('eu')
  await page.waitForTimeout(200)
  await expect(page.getByText('orders.eu', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('orders.us', { exact: true })).toHaveCount(0)

  // funnel now highlighted (Clear filter) → clicking it again closes the box
  await ordersRow.getByTitle('Clear filter', { exact: true }).click()
  await page.waitForTimeout(200)
  await expect(filterInput).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// The subject-messages grid has an ＋ Add button that opens the publish dialog with
// the current subject prefilled (Add message).
test('explorer: NATS subject grid ＋ Add opens publish dialog', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('orders.eu', { exact: true }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('tab', { name: /orders.eu · messages/ }).first()).toBeVisible()

  // ＋ Add in the grid header → dialog "Add message" with the subject prefilled
  await page.getByText('＋ Add', { exact: true }).first().click()
  await page.waitForTimeout(200)
  const dlg = page.getByRole('dialog')
  await expect(dlg.getByText('Add message')).toBeVisible()
  await expect(dlg.getByPlaceholder('e.g. orders.eu')).toHaveValue('orders.eu')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Delete subject only ever removes the subject (never the stream); deleting the
// stream is a separate action on the stream node's context menu.
test('explorer: NATS delete-subject removes the subject, delete-stream is its own menu', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)

  // stream node → "Delete stream" in its context menu → in-app confirm popup
  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible({ timeout: 8000 })
  await page.getByText('ORDERS', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await expect(page.getByText('Delete stream', { exact: true }).first()).toBeVisible()
  await page.getByText('Delete stream', { exact: true }).first().click()
  await page.waitForTimeout(200)
  const streamDlg = page.getByRole('dialog')
  await expect(streamDlg.getByText('Delete stream', { exact: true })).toBeVisible()
  await expect(streamDlg.getByText(/drops the stream and all/)).toBeVisible()
  await streamDlg.getByRole('button', { name: 'Cancel' }).click() // non-destructive
  await page.waitForTimeout(150)

  // subject → "Delete subject" confirm is a SEPARATE action; body never mentions
  // dropping the whole stream (must not affect / trigger Delete stream)
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('orders.eu', { exact: true }).first().click({ button: 'right' })
  await page.getByText('Delete subject', { exact: true }).first().click()
  await page.waitForTimeout(200)
  const subDlg = page.getByRole('dialog')
  await expect(subDlg.getByText('Delete subject', { exact: true })).toBeVisible()
  await expect(subDlg.getByText(/drops the stream and all/)).toHaveCount(0)
  await subDlg.getByRole('button', { name: 'Cancel' }).click()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Item 2: confirming "Delete stream" removes it on the server — it must NOT reappear
// after a Refresh (the demo stream list is stateful, mirroring the real backend which
// is covered by the js_delete_stream integration assertion).
test('explorer: NATS delete-stream removes it and it stays gone after Refresh', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible({ timeout: 8000 })

  // Delete stream → Confirm (destructive)
  await page.getByText('ORDERS', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByText('Delete stream', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
  await page.waitForTimeout(500)

  // gone from the tree; the sibling stream survives
  await expect(page.getByText('ORDERS', { exact: true })).toHaveCount(0)
  await expect(page.getByText('EVENTS', { exact: true }).first()).toBeVisible()

  // and it STAYS gone after an explicit Refresh (re-fetch from the server)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForTimeout(500)
  await expect(page.getByText('ORDERS', { exact: true })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Clear messages (subject) → in-app confirm popup; confirming purges and refreshes
// the open subject-messages tab.
test('explorer: NATS clear-messages shows a confirm popup and refreshes the tab', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible({ timeout: 8000 })
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)

  // open the subject's messages tab first (this is the focused tab that must refresh)
  await page.getByText('orders.eu', { exact: true }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('tab', { name: /orders.eu · messages/ }).first()).toBeVisible()

  // sidebar → right-click subject → Clear messages (the context-menu item, not the
  // tab header's own Clear button) → confirm popup
  await page.getByText('orders.eu', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByRole('menuitem', { name: 'Clear messages' }).click()
  await page.waitForTimeout(150)
  const dlg = page.getByRole('dialog')
  await expect(dlg.getByText('Clear messages', { exact: true })).toBeVisible()
  // backdrop click must NOT confirm/close
  await page.mouse.click(6, 6)
  await page.waitForTimeout(150)
  await expect(page.getByRole('dialog').getByText('Clear messages', { exact: true })).toBeVisible()
  // confirm → runs without error, tab stays open
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('tab', { name: /orders.eu · messages/ }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// The subject-messages tab lists per-message Subject (and Key when present).
test('explorer: NATS subject messages show Subject and Key columns', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)

  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible({ timeout: 8000 })
  await page.getByText('ORDERS', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('orders.eu', { exact: true }).first().click()
  await page.waitForTimeout(400)

  await expect(page.getByRole('columnheader', { name: 'Subject', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Key', exact: true }).first()).toBeVisible()

  // the row "View" action opens a JSON viewer with the pretty-printed payload
  await page.getByTitle('View payload as JSON').first().click()
  await page.waitForTimeout(200)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // the payload viewer is a read-only Monaco surface — read it from the model
  expect(await previewText(page, 'Payload')).toContain('"id":')
  await dialog.getByText('Close', { exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// The NATS explorer filter matches stream names only (not subjects).
test('explorer: NATS filter narrows streams by name', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Messaging NATS/ }).first().click()
  await page.waitForTimeout(500)

  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible({ timeout: 8000 })
  await expect(page.getByText('EVENTS', { exact: true }).first()).toBeVisible()

  const filter = page.getByPlaceholder('Filter streams…')
  await expect(filter).toBeVisible()

  // filter by stream name → only ORDERS remains
  await filter.fill('order')
  await page.waitForTimeout(200)
  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('EVENTS', { exact: true })).toHaveCount(0)

  // a subject-only substring ("eu" is in orders.eu, in no stream name) matches nothing
  await filter.fill('eu')
  await page.waitForTimeout(200)
  await expect(page.getByText('ORDERS', { exact: true })).toHaveCount(0)
  await expect(page.getByText('EVENTS', { exact: true })).toHaveCount(0)
  await expect(page.getByText('No streams match the filter').first()).toBeVisible()

  // clearing restores all streams
  await filter.fill('')
  await page.waitForTimeout(200)
  await expect(page.getByText('ORDERS', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('EVENTS', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
