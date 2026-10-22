import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, wsSection } from './helpers'

// SPEC-STREAM-SHELL.md (W0) + the first Kafka sections of SPEC-KAFKA-WORKSPACE.md:
// the Explorer lists workspace sections under a Kafka connection; they open ONE
// cluster workspace tab per connection, written in plain language.

async function openKafka(page: Page, query = '') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  // connecting opens the cluster workspace tab — Kafka has no object tree
  await page.getByRole('button', { name: /Events Kafka/ }).first().dblclick()
  await expect(page.locator('[data-stream-shell="kafka"]')).toBeVisible({ timeout: 8000 })
  return errors
}

const workspaceTabs = (page: Page) => page.getByRole('tab', { name: /^Events Kafka/ })

test('kafka: connecting opens one workspace on the first topic\'s messages; the overview speaks plainly — no object tree', async ({ page }) => {
  const errors = await openKafka(page)
  // the connection opened exactly one workspace tab, and no tree / Explorer panel
  await expect(workspaceTabs(page)).toHaveCount(1)
  await expect(page.locator('[data-sidebar-panel="explorer"]')).toHaveCount(0)
  await expect(page.locator('[data-conn-tree]')).toHaveCount(0)

  const ws = page.locator('[data-stream-shell="kafka"]')
  const nav = ws.getByRole('navigation', { name: 'Sections' })
  for (const label of ['Overview', 'Brokers', 'Topics', 'Consumer groups', 'Schema Registry']) {
    await expect(nav.getByRole('button', { name: new RegExp('^' + label) })).toBeVisible()
  }
  // a new tab lands where messages are read: Topics, first topic (A→Z), its Messages
  await expect(nav.getByRole('button', { name: /^Topics/ })).toHaveAttribute('aria-current', 'page')
  await expect(ws.getByRole('grid', { name: 'Topics' }).locator('tbody tr[aria-selected="true"]')).toContainText('enrollment.events')
  await expect(ws.locator('[data-kafka-topic-view="enrollment.events"] tbody tr').first()).toBeVisible()
  await expect(ws.getByRole('tablist', { name: 'Topic details' }).getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true')

  await wsSection(page, 'overview')
  await expect(ws.getByRole('status')).toContainText('Everything looks healthy')
  await expect(ws.getByText('Missing copies', { exact: true })).toBeVisible()
  await expect(ws.getByText('Messages kept', { exact: true })).toBeVisible()
  // no raw metadata words on the overview (rule U1)
  await expect(ws.getByText(/\bISR\b|under-replicated|replication factor/i)).toHaveCount(0)

  // the section nav switches inside the same tab
  await nav.getByRole('button', { name: /^Brokers/ }).click()
  await expect(ws.getByRole('grid', { name: 'Brokers' })).toBeVisible()
  await expect(ws.getByRole('grid', { name: 'Brokers' }).locator('tbody tr').filter({ hasText: 'Broker 1' })).toContainText('Controller')
  await wsSection(page, 'topics')
  await expect(nav.getByRole('button', { name: /^Topics/ })).toHaveAttribute('aria-current', 'page')
  await expect(ws.getByRole('grid', { name: 'Topics' }).locator('tbody tr').filter({ hasText: 'enrollment.events' })).toBeVisible()

  // clicking the connection again does not open a second tab
  await page.getByRole('button', { name: /Events Kafka/ }).first().click()
  await expect(workspaceTabs(page)).toHaveCount(1)

  expect(errors, errors.join('\n')).toEqual([])
})

test('kafka: topics table filters, selects with the keyboard and shows details', async ({ page }) => {
  const errors = await openKafka(page)
  await wsSection(page, 'topics')
  const ws = page.locator('[data-stream-shell="kafka"]')
  const grid = ws.getByRole('grid', { name: 'Topics' })
  await expect(grid.locator('tbody tr')).toHaveCount(2)

  await ws.getByRole('textbox', { name: 'Filter topics…' }).fill('pay')
  await expect(grid.locator('tbody tr')).toHaveCount(1)
  await ws.getByRole('textbox', { name: 'Filter topics…' }).fill('')

  // keyboard: focus the grid, ArrowDown selects the first row, details open
  await grid.focus()
  await page.keyboard.press('ArrowDown')
  await expect(grid.locator('tbody tr[aria-selected="true"]')).toHaveCount(1)
  await page.keyboard.press('ArrowDown')
  await expect(grid.locator('tbody tr[aria-selected="true"]')).toContainText('payments')
  await expect(ws.getByText('All copies up to date')).toBeVisible()
  // raw ids stay behind "Advanced" (rule U3)
  await expect(ws.getByText('In-sync replicas (ISR)')).toHaveCount(0)
  await ws.getByRole('tablist', { name: 'Topic details' }).getByRole('tab', { name: 'Partitions' }).click()
  await ws.getByRole('button', { name: 'Advanced' }).click()
  await expect(ws.getByText('In-sync replicas (ISR)')).toBeVisible()

  // Enter shows the topic's messages inside its details — no tab of its own
  await grid.focus()
  await page.keyboard.press('Enter')
  await expect(ws.locator('[data-kafka-topic-view="payments"]')).toBeVisible()
  await expect(ws.getByRole('tablist', { name: 'Topic details' }).getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: /payments · consume/ })).toHaveCount(0)

  expect(errors, errors.join('\n')).toEqual([])
})

test('kafka: a copy that fell behind is explained in words and points to the topic', async ({ page }) => {
  const errors = await openKafka(page, '?kafkaMissingCopies=1')
  await wsSection(page, 'overview')
  const ws = page.locator('[data-stream-shell="kafka"]')
  const status = ws.getByRole('status')
  await expect(status).toContainText('1 partition of payments has fewer copies than configured')
  await expect(ws.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Topics/ })).toContainText('1 missing copies')

  // the broker that is behind is named on the Brokers section
  await ws.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Brokers/ }).click()
  await expect(ws.getByRole('grid', { name: 'Brokers' }).locator('tbody tr').filter({ hasText: 'Broker 3' }).locator('td').last()).toHaveText('1')

  // the status action leads to the topics, where the affected topic carries a warning
  // flag that says how many partitions miss a copy (no Copies / Up to date columns)
  await ws.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Overview/ }).click()
  await status.getByRole('button', { name: 'Show affected topics' }).click()
  const topics = ws.getByRole('grid', { name: 'Topics' })
  await expect(topics.getByRole('columnheader', { name: /Copies|Up to date/ })).toHaveCount(0)
  await expect(topics.locator('tbody tr').filter({ hasText: 'payments' }).getByRole('img', { name: '1 of 3 partitions missing copies' })).toBeVisible()
  await expect(topics.locator('tbody tr').filter({ hasText: 'enrollment.events' }).getByRole('img')).toHaveCount(0)

  expect(errors, errors.join('\n')).toEqual([])
})

test('kafka: the section explanation can be hidden and stays hidden', async ({ page }) => {
  await openKafka(page)
  await wsSection(page, 'brokers')
  const ws = page.locator('[data-stream-shell="kafka"]')
  await expect(ws.getByText(/Brokers are the servers of the cluster/)).toBeVisible()
  await ws.getByRole('button', { name: 'Hide this explanation' }).click()
  await expect(ws.getByText(/Brokers are the servers of the cluster/)).toHaveCount(0)
  await ws.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Overview/ }).click()
  await ws.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Brokers/ }).click()
  await expect(ws.getByText(/Brokers are the servers of the cluster/)).toHaveCount(0)
})

test('kafka: consumer groups — how far behind, change read position with a preview, delete', async ({ page }) => {
  const errors = await openKafka(page)
  await wsSection(page, 'overview')
  const ws = page.locator('[data-stream-shell="kafka"]')
  const nav = ws.getByRole('navigation', { name: 'Sections' })
  // overview counts what the groups have not read yet (demo: 111 + 0 + 111)
  await expect(ws.getByRole('button', { name: /Messages behind/ })).toContainText('222')
  await expect(nav.getByRole('button', { name: /^Consumer groups/ })).toContainText('222 behind')

  await nav.getByRole('button', { name: /^Consumer groups/ }).click()
  const grid = ws.getByRole('grid', { name: 'Consumer groups' })
  await expect(grid.locator('tbody tr')).toHaveCount(3)
  await expect(grid.locator('tbody tr').filter({ hasText: 'audit-log' })).toContainText('Stopped')
  await expect(grid.locator('tbody tr').filter({ hasText: 'audit-log' })).toContainText('Up to date')

  // a running group: the wizard previews but refuses to apply, and says why
  await grid.locator('tbody tr').filter({ hasText: 'payment-processor' }).click()
  await ws.getByRole('button', { name: 'Change read position…' }).click()
  let dlg = page.getByRole('dialog', { name: 'Change read position' })
  await expect(dlg.getByRole('alert')).toContainText('Stop the 2 consumers first')
  await expect(dlg.getByRole('button', { name: /^Move/ })).toBeDisabled()
  await dlg.getByRole('button', { name: 'Cancel' }).click()

  // a stopped group: preview every partition, then apply exactly that
  await grid.locator('tbody tr').filter({ hasText: 'audit-log' }).click()
  await ws.getByRole('button', { name: 'Change read position…' }).click()
  dlg = page.getByRole('dialog', { name: 'Change read position' })
  await dlg.getByText('From the oldest message').click()
  await expect(dlg.getByText('3 partitions will move · 30,701 messages will be read again.')).toBeVisible()
  await expect(dlg.locator('tbody tr')).toHaveCount(3)
  await expect(dlg.locator('tbody tr').nth(2)).toContainText('Not read yet')
  await dlg.getByRole('button', { name: 'Move 3 partitions' }).click()
  await expect(dlg).toHaveCount(0)
  await expect(grid.locator('tbody tr').filter({ hasText: 'audit-log' })).toContainText('30.7k')

  // deleting a running group is refused in words, inside the dialog
  await grid.locator('tbody tr').filter({ hasText: 'payment-processor' }).click()
  await ws.getByRole('button', { name: 'Delete group…' }).click()
  let confirm = page.getByRole('alertdialog', { name: 'Delete consumer group' })
  await confirm.getByRole('button', { name: 'Delete group' }).click()
  await expect(confirm.getByRole('alert')).toContainText('still has running consumers')
  await confirm.getByRole('button', { name: 'Cancel' }).click()

  // a stopped group is deleted
  await grid.locator('tbody tr').filter({ hasText: 'audit-log' }).click()
  await ws.getByRole('button', { name: 'Delete group…' }).click()
  confirm = page.getByRole('alertdialog', { name: 'Delete consumer group' })
  await confirm.getByRole('button', { name: 'Delete group' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(grid.locator('tbody tr')).toHaveCount(2)

  expect(errors, errors.join('\n')).toEqual([])
})

test('kafka: topic settings read in words and are edited as a form', async ({ page }) => {
  const errors = await openKafka(page)
  await wsSection(page, 'topics')
  const ws = page.locator('[data-stream-shell="kafka"]')
  await ws.getByRole('grid', { name: 'Topics' }).locator('tbody tr').filter({ hasText: 'payments' }).click()

  // who reads this topic
  await ws.getByRole('tab', { name: /^Consumers/ }).click()
  await expect(ws.getByRole('button', { name: 'payment-processor' })).toBeVisible()

  await ws.getByRole('tab', { name: 'Settings' }).click()
  const retention = ws.locator('.tc-row').filter({ hasText: 'Keep messages for' })
  await expect(retention).toContainText('7 days')
  await expect(retention).toContainText('Set on this topic')
  await expect(ws.locator('.tc-row').filter({ hasText: 'Size limit per partition' })).toContainText('No limit')
  // raw keys only in small print / behind Advanced
  await expect(retention).toContainText('retention.ms')

  await ws.getByRole('button', { name: 'Edit settings' }).click()
  await ws.getByRole('spinbutton', { name: 'Keep messages for' }).fill('3')
  await ws.getByRole('button', { name: 'Save changes' }).click()
  await expect(retention).toContainText('3 days')

  // a value that is not a number is refused in words, before anything is sent
  await ws.getByRole('button', { name: 'Edit settings' }).click()
  await ws.getByRole('spinbutton', { name: 'Keep messages for' }).fill('')
  await ws.getByRole('button', { name: 'Save changes' }).click()
  await expect(ws.getByRole('alert')).toContainText('needs a number greater than 0')

  expect(errors, errors.join('\n')).toEqual([])
})

test('kafka: messages can start at a date and time', async ({ page }) => {
  const errors = await openKafka(page)
  await wsSection(page, 'topics')
  await page.locator('[data-stream-shell="kafka"]').getByRole('grid', { name: 'Topics' }).locator('tbody tr').filter({ hasText: 'payments' }).click()
  await page.getByRole('tablist', { name: 'Topic details' }).getByRole('tab', { name: 'Messages' }).click()
  const view = page.locator('[data-kafka-topic-view="payments"]')
  await expect(view).toBeVisible()
  // demo log: the newest message (offset 15399) was written at T0; 30 s earlier = offset 15370
  const local = await page.evaluate(() => {
    const d = new Date(1_760_000_000_000 - 30_000)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  })
  await view.getByLabel('Go to date and time').fill(local)
  await view.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(view.getByText(/Messages from/)).toBeVisible()
  await expect(view.locator('.ds-meta').filter({ hasText: 'from offset' })).toContainText('15370')
  expect(errors, errors.join('\n')).toEqual([])
})
