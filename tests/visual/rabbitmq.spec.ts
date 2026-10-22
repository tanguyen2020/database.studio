import { expect, test, type Locator, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, previewBox, previewText, showFormatted } from './helpers'

// RabbitMQ (Management HTTP API). Since the cluster workspace (SPEC-RABBITMQ-WORKSPACE.md)
// the sidebar lists the workspace SECTIONS (Overview · Queues · Exchanges · …); queues
// and exchanges are tables in the one workspace tab of the connection, and a queue /
// exchange opens in the details panel next to its table (peek / consume / publish /
// bind / purge / delete / live). Every check below is the one the per-queue tabs had,
// reached through the workspace. Runs against the stateful demo broker
// (src/lib/rabbitmq/demo.ts), enabled with `?rabbitmq=1`.

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  url.searchParams.set('rabbitmq', '1')
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /RabbitMQ 10\.0\.9\.4:15672/ }).dblclick()
  // RabbitMQ has no object tree — connecting opens its workspace tab
  await expect(page.locator('[data-stream-shell="rabbitmq"]')).toContainText('RabbitMQ 3.13.7', { timeout: 8000 })
  return errors
}

const section = (page: Page, id: string) =>
  page.locator(`[data-stream-shell="rabbitmq"] nav[aria-label="Sections"] [data-section="${id}"]`)
const shell = (page: Page) => page.locator('[data-stream-shell="rabbitmq"]')
const queueGrid = (page: Page) => shell(page).getByRole('grid', { name: 'Queues' })
const exchangeGrid = (page: Page) => shell(page).getByRole('grid', { name: 'Exchanges' })
const gridRow = (grid: Locator, name: string | RegExp) => grid.locator('tbody tr').filter({ hasText: name })
const queueDetail = (page: Page, name: string) => page.locator(`[data-rabbit-queue="${name}"]`)
const exchangeDetail = (page: Page, name: string) => page.locator(`[data-rabbit-exchange="${name}"]`)

/** The cell of `rowName` under the column titled `header` (header text, not position). */
async function cell(grid: Locator, rowName: string, header: string): Promise<Locator> {
  const heads = await grid.locator('thead th').allInnerTexts()
  const i = heads.findIndex((h) => h.replace(/[↑↓]/g, '').trim() === header)
  expect(i, `column "${header}" in ${heads.join(' | ')}`).toBeGreaterThanOrEqual(0)
  return gridRow(grid, rowName).first().locator('td').nth(i)
}

async function openQueue(page: Page, name: string) {
  await section(page, 'queues').click()
  await gridRow(queueGrid(page), name).first().click()
  await expect(queueDetail(page, name)).toBeVisible()
  return queueDetail(page, name)
}

async function openExchange(page: Page, name: string) {
  await section(page, 'exchanges').click()
  await gridRow(exchangeGrid(page), new RegExp(`^${name.replace(/[.()]/g, '\\$&')}`)).first().click()
  await expect(exchangeDetail(page, name)).toBeVisible()
  return exchangeDetail(page, name)
}

test('rabbitmq: connecting opens the workspace (no tree); it lists queues + exchanges, filters, follows the vhost, and opens no SQL tab', async ({ page }) => {
  const errors = await open(page)

  // the workspace lists its sections; queues are a table, not a tree
  for (const id of ['overview', 'queues', 'exchanges', 'connections', 'nodes', 'access']) {
    await expect(section(page, id)).toBeVisible()
  }
  await expect(page.locator('[data-sidebar-panel="explorer"]')).toHaveCount(0) // no object tree for RabbitMQ

  await section(page, 'queues').click()
  await expect(gridRow(queueGrid(page), 'orders.created').first()).toBeVisible()
  await expect(gridRow(queueGrid(page), 'orders.dlq')).toBeVisible()
  // count comes from the broker; a queue without stats says "?" instead of 0
  await expect(await cell(queueGrid(page), 'orders.created', 'Waiting')).toHaveText('4')
  await expect(await cell(queueGrid(page), 'billing.invoices', 'Waiting')).toHaveText('?')

  // the filter narrows the table
  await shell(page).getByLabel('Filter queues…').fill('audit')
  await expect(gridRow(queueGrid(page), 'events.audit')).toBeVisible()
  await expect(gridRow(queueGrid(page), 'orders.created')).toHaveCount(0)
  await shell(page).getByLabel('Filter queues…').fill('')

  await section(page, 'exchanges').click()
  await expect(gridRow(exchangeGrid(page), '(AMQP default)')).toBeVisible()
  await expect(gridRow(exchangeGrid(page), 'amq.topic')).toBeVisible()
  await shell(page).getByLabel('Filter exchanges…').fill('amq.top')
  await expect(gridRow(exchangeGrid(page), 'amq.topic')).toBeVisible()
  await expect(gridRow(exchangeGrid(page), '(AMQP default)')).toHaveCount(0)
  await shell(page).getByLabel('Filter exchanges…').fill('')

  // the workspace's virtual host picker picks what the sections show
  await shell(page).getByLabel('Workspace virtual host').selectOption('staging')
  await section(page, 'queues').click()
  await expect(gridRow(queueGrid(page), 'orders.dlq')).toHaveCount(0)
  await expect(gridRow(queueGrid(page), 'orders.created')).toHaveCount(1)

  // connecting a broker opens no query tab (it is not SQL)
  await expect(page.getByRole('tab', { name: /Untitled/ })).toHaveCount(0)

  // the connection's context menu has no "New Query Console"
  await page.getByRole('button', { name: /RabbitMQ 10\.0\.9\.4:15672/ }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Edit Connection…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'New Query Console' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  expect(errors).toEqual([])
})

test('rabbitmq: queue details — peek keeps messages, consume removes, payload viewer shows them', async ({ page }) => {
  const errors = await open(page)
  const q = await openQueue(page, 'orders.created')
  const ready = q.locator('[data-stat="Ready"]')
  await expect(ready).toContainText('4')

  // peek (default mode): 4 rows, then peek again → same 4, now marked redelivered
  await q.getByRole('button', { name: 'Get messages' }).click()
  const rows = q.locator('tr.rq-row')
  await expect(rows).toHaveCount(4)
  await expect(rows.first()).toContainText('order.created.eu')
  await expect(rows.first()).toContainText('Nguyễn Văn An')
  await expect(rows.nth(3)).toContainText('(binary · base64)')
  await expect(ready).toContainText('4')
  await q.getByRole('button', { name: 'Get messages' }).click()
  await expect(rows).toHaveCount(4)
  await expect(rows.first().locator('td').nth(3)).toHaveText('yes')

  // payload viewer: pretty JSON, really rendered (not just in the model)
  await rows.first().getByTitle('View payload').click()
  await showFormatted(page)
  // Monaco loads lazily — wait for the viewer's model before measuring it
  await expect.poll(async () => (await previewBox(page, 'Payload')).text, { timeout: 10_000 }).toContain('"order_id": 1042')
  const box = await previewBox(page, 'Payload')
  expect(box.height, `payload viewer collapsed (${box.height}px)`).toBeGreaterThan(100)
  expect(box.rendered.trim()).not.toBe('')
  await page.getByRole('dialog', { name: 'Message payload' }).getByText('Close', { exact: true }).click()

  // consume is destructive → asks first; the backdrop does not dismiss the dialog
  await q.getByLabel('Get mode').selectOption('ack')
  await q.getByLabel('Message count').fill('1')
  await q.getByRole('button', { name: 'Get messages' }).click()
  const confirm = page.getByRole('dialog', { name: 'Consume messages' })
  await expect(confirm).toBeVisible()
  await page.mouse.click(8, 8)
  await expect(confirm).toBeVisible()
  await confirm.getByText('Consume', { exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(ready).toContainText('3')
  // …and the queue table follows
  await expect(await cell(queueGrid(page), 'orders.created', 'Waiting')).toHaveText('3')

  expect(errors).toEqual([])
})

test('rabbitmq: publish reports routed vs dropped, bindings route topic keys', async ({ page }) => {
  const errors = await open(page)
  const q = await openQueue(page, 'orders.created')
  await q.getByRole('tab', { name: 'Publish' }).click()

  // default exchange + routing key = queue name → routed, count goes up
  await q.getByRole('button', { name: 'Publish message' }).click()
  await expect(q.getByTestId('publish-result')).toContainText('Routed')
  await expect(q.locator('[data-stat="Ready"]')).toContainText('5')

  // topic exchange with a key no binding matches → the broker drops it
  await q.getByLabel('Exchange', { exact: true }).selectOption('orders')
  await q.getByLabel('Routing key', { exact: true }).fill('invoice.paid')
  await q.getByRole('button', { name: 'Publish message' }).click()
  await expect(q.getByTestId('publish-result')).toContainText('Not routed')

  // bad headers are caught before anything is sent
  await q.getByLabel('Headers', { exact: true }).fill('[1,2]')
  await q.getByRole('button', { name: 'Publish message' }).click()
  await expect(q.getByRole('alert').filter({ hasText: 'Headers must be' })).toContainText('JSON object')
  await q.getByLabel('Headers', { exact: true }).fill('')

  // add a binding for that key, publish again → routed now
  await q.getByRole('tab', { name: /Bindings/ }).click()
  await expect(q.locator('tr.rq-row').filter({ hasText: 'order.created.*' })).toBeVisible()
  await q.getByLabel('Bind from exchange').selectOption('orders')
  await q.getByLabel('Binding routing key').fill('invoice.#')
  await q.getByRole('button', { name: 'Bind', exact: true }).click()
  await expect(q.locator('tr.rq-row').filter({ hasText: 'invoice.#' })).toBeVisible()
  await q.getByRole('tab', { name: 'Publish' }).click()
  await q.getByLabel('Exchange', { exact: true }).selectOption('orders')
  await q.getByLabel('Routing key', { exact: true }).fill('invoice.paid')
  await q.getByRole('button', { name: 'Publish message' }).click()
  await expect(q.getByTestId('publish-result')).toContainText('Routed')

  // unbind it again
  await q.getByRole('tab', { name: /Bindings/ }).click()
  await q.locator('tr.rq-row').filter({ hasText: 'invoice.#' }).getByText('Unbind').click()
  await page.getByRole('dialog', { name: 'Remove binding' }).getByText('Unbind', { exact: true }).click()
  await expect(q.locator('tr.rq-row').filter({ hasText: 'invoice.#' })).toHaveCount(0)

  expect(errors).toEqual([])
})

test('rabbitmq: declare, purge and delete — the workspace follows the broker', async ({ page }) => {
  const errors = await open(page)

  // + Create queue → "Add a new queue" (backdrop does not close it) → Add queue opens it in the workspace
  await shell(page).getByRole('button', { name: '+ Create queue' }).click()
  const dlg = page.getByRole('dialog', { name: 'Add a new queue' })
  await expect(dlg).toBeVisible()
  await page.mouse.click(8, 8)
  await expect(dlg).toBeVisible()
  await dlg.getByLabel('Name', { exact: true }).fill('orders.created')
  await expect(dlg).toContainText('already exists')
  await dlg.getByLabel('Name', { exact: true }).fill('payments.q')
  await dlg.getByLabel('Type', { exact: true }).selectOption('quorum')
  await expect(dlg).toContainText('always durable')
  await dlg.getByText('Add queue', { exact: true }).click()
  await expect(dlg).toHaveCount(0)
  const created = queueDetail(page, 'payments.q')
  await expect(created).toBeVisible()
  await expect(gridRow(queueGrid(page), 'payments.q')).toBeVisible()

  // delete it from its details → the details close and the table drops it; the
  // confirm names the consequence
  await created.getByRole('button', { name: 'Delete queue…' }).click()
  const del = page.getByRole('dialog', { name: 'Delete queue' })
  await expect(del).toContainText('This cannot be undone')
  await del.getByRole('button', { name: 'Delete queue', exact: true }).click()
  await expect(created).toHaveCount(0)
  await expect(gridRow(queueGrid(page), 'payments.q')).toHaveCount(0)

  // purge — the button says how many messages go
  const q = await openQueue(page, 'orders.created')
  await q.getByRole('button', { name: 'Purge…' }).click()
  const purge = page.getByRole('dialog', { name: 'Purge queue' })
  await purge.getByRole('button', { name: 'Purge 4 messages' }).click()
  await expect(purge).toHaveCount(0)
  await expect(await cell(queueGrid(page), 'orders.created', 'Waiting')).toHaveText('0')

  // exchanges: user exchange can be deleted, built-ins cannot
  const topic = await openExchange(page, 'amq.topic')
  await expect(topic.getByRole('button', { name: 'Delete exchange…' })).toHaveCount(0)
  const orders = await openExchange(page, 'orders')
  await expect(orders.locator('tr.rx-row').filter({ hasText: 'orders.created' })).toBeVisible()
  // the bind picker starts on a real queue, never blank
  await expect(orders.locator('select[aria-label="Bind to queue"]:visible')).not.toHaveValue('')
  await orders.getByRole('button', { name: 'Delete exchange…' }).click()
  await page.getByRole('dialog', { name: 'Delete exchange' }).getByText('Delete exchange', { exact: true }).last().click()
  await expect(orders).toHaveCount(0)
  await expect(gridRow(exchangeGrid(page), /^orders\b/)).toHaveCount(0)

  expect(errors).toEqual([])
})

test('rabbitmq: connection form asks for the management port and the vhost', async ({ page }) => {
  const errors = await open(page)
  await page.getByRole('button', { name: /RabbitMQ 10\.0\.9\.4:15672/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Connection…' }).click()
  await expect(page.getByLabel('Virtual host', { exact: true })).toHaveValue('/')
  await expect(page.getByTestId('rabbit-port-hint')).toContainText('Management HTTP API')
  await expect(page.getByTestId('rabbit-port-hint')).toContainText('5672')
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------------------------------
// Live listening
// ---------------------------------------------------------------------------------------

const ipcCalls = (page: Page, cmd: string) =>
  page.evaluate((c) => ((window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls ?? {})[c] ?? 0, cmd)

test('rabbitmq live: watching an exchange shows new messages and takes nothing', async ({ page }) => {
  const errors = await open(page)
  const x = await openExchange(page, 'orders')
  await x.getByRole('tab', { name: 'Live' }).click()

  // topic exchange → routing-key patterns may be given; empty = everything (#)
  await expect(x.getByLabel('Routing keys to watch')).toBeVisible()
  await x.getByRole('button', { name: '▶ Start listening' }).click()
  const state = x.getByTestId('live-state').filter({ visible: true })
  await expect(state).toContainText('Listening · 0 received')
  await expect(x.getByTestId('live-bindings').filter({ visible: true })).toContainText('orders · #')

  // publish from the same details → it appears live, without any refresh
  await x.getByRole('tab', { name: 'Publish' }).click()
  await x.getByLabel('Routing key', { exact: true }).fill('order.created.jp')
  await x.getByRole('button', { name: 'Publish message' }).click()
  await x.getByRole('tab', { name: 'Live' }).click()
  const rows = x.getByTestId('live-rows').filter({ visible: true }).locator('tbody tr')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('order.created.jp')
  await expect(state).toContainText('Listening · 1 received')

  // a watched message opens in the viewer
  await rows.first().getByTitle('View payload').click()
  await expect(page.getByRole('dialog', { name: 'Message payload' })).toBeVisible()
  await page.getByRole('dialog', { name: 'Message payload' }).getByText('Close', { exact: true }).click()

  const stopsBefore = await ipcCalls(page, 'rabbit_live_stop')
  await x.getByRole('button', { name: '■ Stop' }).click()
  await expect(state).toContainText('Stopped · 1 received')
  expect(await ipcCalls(page, 'rabbit_live_stop')).toBe(stopsBefore + 1)

  // watching copied the message: the queue bound to the exchange still got it
  await section(page, 'queues').click()
  await expect(await cell(queueGrid(page), 'orders.created', 'Waiting')).toHaveText('5')
  expect(errors).toEqual([])
})

test('rabbitmq live: consume asks first, drains the queue, then takes new messages as they land', async ({ page }) => {
  const errors = await open(page)
  const q = await openQueue(page, 'orders.created')
  await q.getByRole('tab', { name: 'Live' }).click()
  await q.getByLabel('Live mode').selectOption('consume')
  await q.getByRole('button', { name: '▶ Start listening' }).click()

  // destructive → confirm; the backdrop does not dismiss it
  const confirm = page.getByRole('dialog', { name: 'Consume messages live' })
  await expect(confirm).toBeVisible()
  await page.mouse.click(8, 8)
  await expect(confirm).toBeVisible()
  await confirm.getByText('Consume', { exact: true }).click()

  const rows = q.getByTestId('live-rows').filter({ visible: true }).locator('tbody tr')
  await expect(rows).toHaveCount(4) // what was already waiting
  await expect(await cell(queueGrid(page), 'orders.created', 'Waiting')).toHaveText('0')

  // a message published now is taken the moment it lands — the queue stays empty
  await q.getByRole('tab', { name: 'Publish' }).click()
  await q.getByRole('button', { name: 'Publish message' }).click()
  await q.getByRole('tab', { name: 'Live' }).click()
  await expect(rows).toHaveCount(5)
  await expect(q.getByTestId('live-state').filter({ visible: true })).toContainText('5 received')
  await expect(q.locator('[data-stat="Ready"]')).toContainText('0')

  // switching sub-tabs does not stop the session; closing the details does
  await q.getByRole('tab', { name: 'Details' }).click()
  await q.getByRole('tab', { name: 'Live' }).click()
  await expect(q.getByTestId('live-state').filter({ visible: true })).toContainText('Listening')
  const stopsBefore = await ipcCalls(page, 'rabbit_live_stop')
  await q.getByRole('button', { name: 'Close details' }).click()
  await expect.poll(() => ipcCalls(page, 'rabbit_live_stop')).toBe(stopsBefore + 1)
  expect(errors).toEqual([])
})

test('rabbitmq live: a queue reached only by name cannot be watched (said, not silent)', async ({ page }) => {
  const errors = await open(page)
  const q = await openQueue(page, 'billing.invoices')
  await q.getByRole('tab', { name: 'Live' }).click()
  await q.getByRole('button', { name: '▶ Start listening' }).click()
  await expect(q.getByRole('alert').filter({ hasText: 'default exchange' })).toBeVisible()
  await expect(q.getByTestId('live-state').filter({ visible: true })).toContainText('Not listening')
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------------------------------
// Users · permissions · policies · vhosts (the "Users & access" section)
// ---------------------------------------------------------------------------------------

async function openUsers(page: Page) {
  await section(page, 'access').click()
  await expect(shell(page).getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Users & access/ })).toHaveAttribute('aria-current', 'page')
  // the user list (the sidebar vhost <select> also has options — wait for a real user)
  await expect(page.getByRole('option').filter({ hasText: 'studio' })).toBeVisible()
}

test('rabbitmq users: create with access, change tags, edit from the matrix', async ({ page }) => {
  const errors = await open(page)
  await openUsers(page)

  const list = page.getByRole('option')
  await expect(list.filter({ hasText: 'studio' })).toContainText('you')
  await expect(list.filter({ hasText: 'monitor' })).toContainText('monitoring')

  // the login user cannot be deleted from here
  await list.filter({ hasText: 'studio' }).click()
  await expect(page.getByText('Delete user', { exact: true })).toHaveAttribute('aria-disabled', 'true')

  // monitor = read only; app = a custom set
  await list.filter({ hasText: 'monitor' }).click()
  await expect(page.getByRole('region', { name: 'Virtual host access' }).locator('tbody tr').first()).toContainText('Read only')
  await list.filter({ hasText: /^app/ }).click()
  await expect(page.getByRole('region', { name: 'Virtual host access' }).locator('tbody tr').first()).toContainText('Custom')

  // new user with full access to "/" — the backdrop does not close the dialog
  await page.getByText('＋ New user', { exact: true }).click()
  const dlg = page.getByRole('dialog', { name: 'New user' })
  await expect(dlg).toBeVisible()
  await expect(dlg.getByLabel('User name')).toBeFocused()
  await page.mouse.click(8, 8)
  await expect(dlg).toBeVisible()
  await dlg.getByLabel('User name').fill('app')
  await expect(dlg).toContainText('already exists')
  await dlg.getByLabel('User name').fill('svc')
  await dlg.getByLabel('Initial virtual host').selectOption('/')
  await dlg.getByLabel('Initial access').selectOption('full')
  await dlg.getByText('Create user', { exact: true }).click()
  await expect(dlg).toHaveCount(0)
  await expect(list.filter({ hasText: 'svc' })).toHaveAttribute('aria-selected', 'true')
  const access = page.getByRole('region', { name: 'Virtual host access' })
  await expect(access.locator('tbody tr').first()).toContainText('Full access')

  // tags: add monitoring, save → the list shows it
  await page.getByRole('region', { name: 'Tags' }).getByLabel('monitoring').check()
  await page.getByText('Save tags', { exact: true }).click()
  await expect(list.filter({ hasText: 'svc' })).toContainText('management, monitoring')

  // permissions matrix → click svc × staging → editor opens on that vhost
  await page.getByRole('tab', { name: 'Permissions' }).click()
  const matrix = page.getByRole('table', { name: 'Permission matrix' })
  const svcRow = matrix.locator('tbody tr').filter({ hasText: 'svc' })
  await svcRow.locator('td').nth(2).click()
  await expect(page.getByLabel('Access virtual host')).toHaveValue('staging')
  await page.getByRole('radio', { name: 'Read only' }).click()
  await page.getByText('Save access', { exact: true }).click()
  await page.getByRole('tab', { name: 'Permissions' }).click()
  await expect(svcRow.locator('td').nth(2)).toHaveText('Read only')
  await expect(svcRow.locator('td').nth(1)).toHaveText('Full access')

  // custom regexes are validated before anything is sent
  await svcRow.locator('td').nth(2).click()
  await page.getByRole('radio', { name: 'Custom' }).click()
  await page.getByLabel('read', { exact: true }).fill('([')
  await expect(page.getByRole('alert').filter({ hasText: 'read:' })).toBeVisible()
  await expect(page.getByText('Save access', { exact: true })).toHaveCSS('pointer-events', 'none')
  expect(errors).toEqual([])
})

test('rabbitmq users: policies and virtual hosts', async ({ page }) => {
  const errors = await open(page)
  await openUsers(page)

  await page.getByRole('tab', { name: 'Policies' }).click()
  const table = page.getByRole('table', { name: 'Policies' })
  await expect(table).toContainText('dlx-orders')
  await expect(table).toContainText('dead-letter-exchange=orders.dlx')

  await page.getByText('＋ New policy', { exact: true }).click()
  const dlg = page.getByRole('dialog', { name: 'New policy' })
  await dlg.getByLabel('Policy name').fill('ttl-events')
  await dlg.getByLabel('Policy pattern').fill('^events\\.')
  await dlg.getByText('＋ message-ttl', { exact: true }).click()
  await expect(dlg.getByLabel('Policy definition')).toHaveValue(/"message-ttl": 60000/)
  await expect(dlg.getByLabel('Policy definition')).toHaveValue(/"max-length": 10000/)
  // broken JSON blocks Save
  await dlg.getByLabel('Policy definition').fill('{oops')
  await expect(dlg.getByRole('alert')).toContainText('not valid JSON')
  await dlg.getByLabel('Policy definition').fill('{"message-ttl": 60000}')
  await dlg.getByText('Save policy', { exact: true }).click()
  await expect(dlg).toHaveCount(0)
  await expect(table.locator('tbody tr').filter({ hasText: 'ttl-events' })).toContainText('message-ttl=60000')

  await table.locator('tbody tr').filter({ hasText: 'ttl-events' }).getByText('Delete').click()
  await page.getByRole('dialog', { name: 'Delete policy' }).getByText('Delete', { exact: true }).click()
  await expect(table.locator('tbody tr').filter({ hasText: 'ttl-events' })).toHaveCount(0)

  // virtual hosts: create, the connection's own one is protected, delete
  await page.getByRole('tab', { name: /Virtual hosts/ }).click()
  const vt = page.getByRole('table', { name: 'Virtual hosts' })
  await expect(vt.locator('tbody tr').filter({ hasText: /^\// }).getByText('Delete')).toHaveAttribute('aria-disabled', 'true')
  await page.getByLabel('New virtual host name').fill('qa')
  await page.getByLabel('New virtual host description').fill('QA env')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(vt.locator('tbody tr').filter({ hasText: 'qa' })).toContainText('QA env')
  await vt.locator('tbody tr').filter({ hasText: 'qa' }).getByText('Delete').click()
  await page.getByRole('dialog', { name: 'Delete virtual host' }).getByText('Delete', { exact: true }).click()
  await expect(vt.locator('tbody tr').filter({ hasText: 'qa' })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('rabbitmq: a broker without the "/" vhost opens on the vhost it has (no bare Not found)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  url.searchParams.set('rabbitmq', '1')
  url.searchParams.set('rabbitNoRoot', '1')
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /RabbitMQ 10\.0\.9\.4:15672/ }).dblclick()

  // the workspace follows the vhost the connection really opened on, and says so
  await expect(page.getByTestId('workspace-vhost-note')).toContainText("Virtual host '/' does not exist on this broker — showing 'staging'")
  await expect(page.locator('[data-stream-shell="rabbitmq"]').getByLabel('Workspace virtual host')).toHaveValue('staging')
  await expect(page.locator('[data-stream-shell="rabbitmq"]').getByLabel('Workspace virtual host').locator('option')).toHaveText(['staging'])
  await section(page, 'queues').click()
  await expect(gridRow(queueGrid(page), 'orders.created')).toBeVisible()
  await expect(page.getByText(/Not found — Not Found/)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('rabbitmq: the create forms look and behave like the management UI', async ({ page }) => {
  const errors = await open(page)

  // ---- Add a new queue ----------------------------------------------------------------
  await shell(page).getByRole('button', { name: '+ Create queue' }).click()
  const q = page.getByRole('dialog', { name: 'Add a new queue' })
  for (const label of ['Virtual host:', 'Type:', 'Name:', 'Durability:', 'Auto delete:', 'Arguments:']) {
    await expect(q.locator('.rc-label', { hasText: label }).first()).toBeVisible()
  }
  await expect(q.getByLabel('Name', { exact: true })).toBeFocused()
  await expect(q.getByLabel('Type', { exact: true })).toHaveValue('') // Default for virtual host
  await expect(q.getByLabel('Durability')).toHaveValue('true')
  await expect(q.getByLabel('Auto delete')).toHaveValue('false')

  // quick "Add" links follow the queue type, like the UI
  const helpers = q.getByTestId('arg-helpers')
  await expect(helpers).toContainText('Maximum priority')
  await expect(helpers).not.toContainText('Delivery limit')
  await q.getByLabel('Type', { exact: true }).selectOption('quorum')
  await expect(helpers).toContainText('Delivery limit')
  await expect(q.getByLabel('Durability')).toHaveCount(0) // quorum: always durable
  await q.getByLabel('Type', { exact: true }).selectOption('classic')

  await q.getByLabel('Name', { exact: true }).fill('typed.q')
  await helpers.getByText('Message TTL', { exact: true }).click()
  await expect(q.getByLabel('Argument 1 name')).toHaveValue('x-message-ttl')
  await expect(q.getByLabel('Argument 1 type')).toHaveValue('number')
  // a number argument that is not a number blocks Add, with a reason
  await q.getByLabel('Argument 1 value').fill('one minute')
  await expect(q.getByRole('alert')).toContainText('x-message-ttl must be a number')
  await expect(q.getByText('Add queue', { exact: true })).toHaveAttribute('aria-disabled', 'true')
  await q.getByLabel('Argument 1 value').fill('60000')
  await helpers.getByText('Single active consumer', { exact: true }).click()
  await expect(q.getByLabel('Argument 2 value')).toHaveValue('true')
  // a free row with a typed value
  await q.getByLabel('Argument 3 name').fill('x-custom')
  await q.getByLabel('Argument 3 value').fill('a, b')
  await q.getByLabel('Argument 3 type').selectOption('list')
  await expect(q.getByTestId('arg-row')).toHaveCount(4) // one blank row kept at the end
  await q.getByText('Add queue', { exact: true }).click()
  await expect(q).toHaveCount(0)
  const typed = queueDetail(page, 'typed.q')
  await expect(typed).toBeVisible()
  // the broker received typed values (raw arguments sit behind Advanced)
  await typed.getByRole('tab', { name: 'Details' }).click()
  await typed.getByRole('button', { name: /Advanced/ }).click()
  // the arguments viewer is a Monaco surface that loads on demand — wait for its text
  await expect.poll(() => previewText(page, 'Queue arguments'), { timeout: 15_000 }).not.toBe('')
  const args = await previewText(page, 'Queue arguments')
  expect(JSON.parse(args)).toEqual({ 'x-message-ttl': 60000, 'x-single-active-consumer': true, 'x-custom': ['a', 'b'], 'x-queue-type': 'classic' })

  // ---- Add a new exchange --------------------------------------------------------------
  await section(page, 'exchanges').click()
  await shell(page).getByRole('button', { name: '+ Create exchange' }).click()
  const x = page.getByRole('dialog', { name: 'Add a new exchange' })
  for (const label of ['Virtual host:', 'Name:', 'Type:', 'Durability:', 'Auto delete:', 'Internal:', 'Arguments:']) {
    await expect(x.locator('.rc-label', { hasText: label }).first()).toBeVisible()
  }
  // an empty name is not "taken" (the default exchange's name is '')
  await expect(x).not.toContainText('already exists')
  // the types the broker offers, plugin types included
  await expect(x.getByLabel('Type', { exact: true }).locator('option')).toHaveText(['direct', 'fanout', 'headers', 'topic', 'x-delayed-message'])
  await x.getByLabel('Name', { exact: true }).fill('with.ae')
  await x.getByLabel('Type', { exact: true }).selectOption('topic')
  await x.getByLabel('Internal').selectOption('true')
  await x.getByTestId('arg-helpers').getByText('Alternate exchange', { exact: true }).click()
  await x.getByLabel('Argument 1 value').fill('events')
  await x.getByText('Add exchange', { exact: true }).click()
  await expect(x).toHaveCount(0)
  const ae = exchangeDetail(page, 'with.ae')
  await expect(ae).toBeVisible()
  await ae.getByRole('tab', { name: 'Details' }).click()
  const adv = ae.getByRole('button', { name: /Advanced/ })
  if (await adv.count()) await adv.click()
  expect(JSON.parse(await previewText(page, 'Exchange arguments'))).toEqual({ 'alternate-exchange': 'events' })
  expect(errors).toEqual([])
})

test('rabbitmq: "Add a new queue" can bind the queue with a routing key right away', async ({ page }) => {
  const errors = await open(page)
  await shell(page).getByRole('button', { name: '+ Create queue' }).click()
  const q = page.getByRole('dialog', { name: 'Add a new queue' })
  await q.getByLabel('Name', { exact: true }).fill('retry.q')
  await expect(q.getByTestId('bind-row')).toHaveCount(0) // optional: none until asked

  // topic exchange + routing key pattern
  await q.getByText('＋ Add binding', { exact: true }).click()
  await q.getByLabel('Binding 1 exchange').selectOption('orders')
  await expect(q.getByTestId('bind-hint').first()).toContainText('# matches zero or more')
  await q.getByLabel('Binding 1 routing key').fill('order.retry.#')
  // fanout: the routing key does not apply, so it is not asked for
  await q.getByText('＋ Add binding', { exact: true }).click()
  await q.getByLabel('Binding 2 exchange').selectOption('events')
  await expect(q.getByLabel('Binding 2 routing key')).toBeDisabled()
  await expect(q.getByTestId('bind-hint').nth(1)).toContainText('routing key is ignored')
  // a row left without an exchange is simply not created
  await q.getByText('＋ Add binding', { exact: true }).click()
  await q.getByText('Add queue', { exact: true }).click()
  await expect(q).toHaveCount(0)

  // the queue details show both bindings with their routing keys
  const retry = queueDetail(page, 'retry.q')
  await expect(retry).toBeVisible()
  await retry.getByRole('tab', { name: /Bindings/ }).click()
  const rows = retry.locator('tr.rq-row')
  await expect(rows.filter({ hasText: 'order.retry.#' })).toContainText('orders')
  await expect(rows.filter({ hasText: 'events' })).toHaveCount(1)
  await expect(retry.getByRole('tab', { name: 'Bindings (3)', exact: true })).toBeVisible() // + the default-exchange one

  // and the binding routes: publish to orders with a matching key → it lands in retry.q
  await retry.getByRole('tab', { name: 'Publish' }).click()
  await retry.getByLabel('Exchange', { exact: true }).selectOption('orders')
  await retry.getByLabel('Routing key', { exact: true }).fill('order.retry.42')
  await retry.getByRole('button', { name: 'Publish message' }).click()
  await expect(retry.getByTestId('publish-result')).toContainText('Routed')
  await expect(retry.locator('[data-stat="Ready"]')).toContainText('1')
  expect(errors).toEqual([])
})

test('rabbitmq users: a user without the administrator tag is told so, and the rest still loads', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  url.searchParams.set('rabbitmq', '1')
  url.searchParams.set('rabbitNoAdmin', '1')
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /RabbitMQ 10.0.9.4:15672/ }).dblclick()
  await expect(page.locator('[data-stream-shell="rabbitmq"]')).toBeVisible()
  await section(page, 'access').click()

  // the real reason, not "Authentication failed"
  const err = page.getByTestId('users-error')
  await expect(err).toContainText("'administrator' tag")
  await expect(err).toContainText('Logged in as studio (management)')
  await expect(page.getByText('Authentication failed')).toHaveCount(0)
  await expect(page.getByRole('note').filter({ hasText: 'administrator tag' })).toContainText('does not have the administrator tag')

  // what this user can read still loads
  await page.getByRole('tab', { name: 'Policies' }).click()
  await expect(page.getByRole('table', { name: 'Policies' })).toContainText('dlx-orders')
  await page.getByRole('tab', { name: /Virtual hosts/ }).click()
  await expect(page.getByRole('table', { name: 'Virtual hosts' })).toContainText('staging')
  expect(errors).toEqual([])
})
