import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, previewBox, previewText, showFormatted } from './helpers'

// RabbitMQ (Management HTTP API) — browsed from the ObjectExplorer sidebar: vhost →
// Queues / Exchanges; a queue tab peeks / consumes / publishes / binds / purges.
// Runs against the stateful demo broker (src/lib/rabbitmq/demo.ts), enabled with
// `?rabbitmq=1` so the connection list of every other spec stays as it is.

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  url.searchParams.set('rabbitmq', '1')
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /RabbitMQ 10\.0\.9\.4:15672/ }).dblclick()
  await expect(page.getByTestId('rabbit-summary')).toContainText('RabbitMQ 3.13.7', { timeout: 8000 })
  return errors
}

const sidebarRow = (page: Page, name: string | RegExp) =>
  page.getByRole('treeitem').filter({ hasText: name })

test('rabbitmq: explorer lists queues + exchanges, filters, and opens no SQL tab', async ({ page }) => {
  const errors = await open(page)

  await expect(sidebarRow(page, 'orders.created').first()).toBeVisible()
  await expect(sidebarRow(page, 'orders.dlq')).toBeVisible()
  await expect(sidebarRow(page, '(AMQP default)')).toBeVisible()
  await expect(sidebarRow(page, 'amq.topic')).toBeVisible()
  // count meta comes from the broker; a queue without stats says "?" instead of 0
  await expect(sidebarRow(page, 'orders.created').first()).toContainText('4 msg')
  await expect(sidebarRow(page, 'billing.invoices')).toContainText('? msg')

  // the name filter narrows both folders
  await page.getByLabel('Filter queues and exchanges').fill('audit')
  await expect(sidebarRow(page, 'events.audit')).toBeVisible()
  await expect(sidebarRow(page, 'orders.created')).toHaveCount(0)
  await expect(sidebarRow(page, '(AMQP default)')).toHaveCount(0)
  await page.getByLabel('Filter queues and exchanges').fill('')

  // vhost switch re-reads the lists for that vhost
  await page.getByLabel('RabbitMQ virtual host').selectOption('staging')
  await expect(sidebarRow(page, 'orders.dlq')).toHaveCount(0)
  await expect(sidebarRow(page, 'orders.created')).toHaveCount(1)

  // connecting a broker opens no query tab (it is not SQL)
  await expect(page.getByRole('tab', { name: /Untitled/ })).toHaveCount(0)

  // the connection's context menu has no "New Query Console"
  await page.getByRole('button', { name: /RabbitMQ 10\.0\.9\.4:15672/ }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Edit Connection…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'New Query Console' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  expect(errors).toEqual([])
})

test('rabbitmq: queue tab — peek keeps messages, consume removes, payload viewer shows them', async ({ page }) => {
  const errors = await open(page)
  await sidebarRow(page, 'orders.created').first().click()
  await expect(page.getByRole('tab', { name: /orders\.created · queue/ })).toBeVisible()
  const ready = page.locator('[data-stat="Ready"]')
  await expect(ready).toContainText('4')

  // peek (default mode): 4 rows, then peek again → same 4, now marked redelivered
  await page.getByRole('button', { name: 'Get messages' }).click()
  const rows = page.locator('tr.rq-row')
  await expect(rows).toHaveCount(4)
  await expect(rows.first()).toContainText('order.created.eu')
  await expect(rows.first()).toContainText('Nguyễn Văn An')
  await expect(rows.nth(3)).toContainText('(binary · base64)')
  await expect(ready).toContainText('4')
  await page.getByRole('button', { name: 'Get messages' }).click()
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
  await page.getByLabel('Get mode').selectOption('ack')
  await page.getByLabel('Message count').fill('1')
  await page.getByRole('button', { name: 'Get messages' }).click()
  const confirm = page.getByRole('dialog', { name: 'Consume messages' })
  await expect(confirm).toBeVisible()
  await page.mouse.click(8, 8)
  await expect(confirm).toBeVisible()
  await confirm.getByText('Consume', { exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(ready).toContainText('3')
  // …and the sidebar count follows
  await expect(sidebarRow(page, 'orders.created').first()).toContainText('3 msg')

  expect(errors).toEqual([])
})

test('rabbitmq: publish reports routed vs dropped, bindings route topic keys', async ({ page }) => {
  const errors = await open(page)
  await sidebarRow(page, 'orders.created').first().click()
  await page.getByRole('tab', { name: 'Publish' }).click()

  // default exchange + routing key = queue name → routed, count goes up
  await page.getByRole('button', { name: 'Publish message' }).click()
  await expect(page.getByTestId('publish-result')).toContainText('Routed')
  await expect(page.locator('[data-stat="Ready"]')).toContainText('5')

  // topic exchange with a key no binding matches → the broker drops it
  await page.getByLabel('Exchange', { exact: true }).selectOption('orders')
  await page.getByLabel('Routing key', { exact: true }).fill('invoice.paid')
  await page.getByRole('button', { name: 'Publish message' }).click()
  await expect(page.getByTestId('publish-result')).toContainText('Not routed')

  // bad headers are caught before anything is sent
  await page.getByLabel('Headers', { exact: true }).fill('[1,2]')
  await page.getByRole('button', { name: 'Publish message' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Headers must be' })).toContainText('JSON object')
  await page.getByLabel('Headers', { exact: true }).fill('')

  // add a binding for that key, publish again → routed now
  await page.getByRole('tab', { name: /Bindings/ }).click()
  await expect(page.locator('tr.rq-row').filter({ hasText: 'order.created.*' })).toBeVisible()
  await page.getByLabel('Bind from exchange').selectOption('orders')
  await page.getByLabel('Binding routing key').fill('invoice.#')
  await page.getByRole('button', { name: 'Bind', exact: true }).click()
  await expect(page.locator('tr.rq-row').filter({ hasText: 'invoice.#' })).toBeVisible()
  await page.getByRole('tab', { name: 'Publish' }).click()
  await page.getByLabel('Exchange', { exact: true }).selectOption('orders')
  await page.getByLabel('Routing key', { exact: true }).fill('invoice.paid')
  await page.getByRole('button', { name: 'Publish message' }).click()
  await expect(page.getByTestId('publish-result')).toContainText('Routed')

  // unbind it again
  await page.getByRole('tab', { name: /Bindings/ }).click()
  await page.locator('tr.rq-row').filter({ hasText: 'invoice.#' }).getByText('Unbind').click()
  await page.getByRole('dialog', { name: 'Remove binding' }).getByText('Unbind', { exact: true }).click()
  await expect(page.locator('tr.rq-row').filter({ hasText: 'invoice.#' })).toHaveCount(0)

  expect(errors).toEqual([])
})

test('rabbitmq: declare, purge and delete — the tree follows the broker', async ({ page }) => {
  const errors = await open(page)

  // ＋ Queue → "Add a new queue" (backdrop does not close it) → Add queue opens its tab
  await page.getByText('＋ Queue', { exact: true }).click()
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
  await expect(page.getByRole('tab', { name: /payments\.q · queue/ })).toBeVisible()
  await expect(sidebarRow(page, 'payments.q')).toBeVisible()

  // delete it from its tab → the tab closes and the tree drops it
  await page.getByText('Delete queue', { exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete queue' }).getByText('Delete', { exact: true }).click()
  await expect(page.getByRole('tab', { name: /payments\.q · queue/ })).toHaveCount(0)
  await expect(sidebarRow(page, 'payments.q')).toHaveCount(0)

  // purge from the sidebar context menu
  await sidebarRow(page, 'orders.created').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Purge messages…' }).click()
  await page.getByRole('dialog', { name: 'Purge queue' }).getByText('Purge', { exact: true }).click()
  await expect(sidebarRow(page, 'orders.created').first()).toContainText('0 msg')

  // exchanges: user exchange can be deleted, built-ins cannot
  await sidebarRow(page, 'amq.topic').click()
  await expect(page.getByRole('tab', { name: /amq\.topic · exchange/ })).toBeVisible()
  await expect(page.getByText('Delete exchange', { exact: true })).toHaveCount(0)
  await sidebarRow(page, /^X\s*orders\s*topic/).click()
  await expect(page.getByRole('tab', { name: /orders · exchange/ })).toBeVisible()
  await expect(page.locator('tr.rx-row').filter({ hasText: 'orders.created' })).toBeVisible()
  // the bind picker starts on a real queue, never blank
  await expect(page.locator('select[aria-label="Bind to queue"]:visible')).not.toHaveValue('')
  await page.getByText('Delete exchange', { exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete exchange' }).getByText('Delete', { exact: true }).click()
  await expect(page.getByRole('tab', { name: /orders · exchange/ })).toHaveCount(0)
  await expect(sidebarRow(page, /^X\s*orders\s*topic/)).toHaveCount(0)

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
  await sidebarRow(page, /^X\s*orders\s*topic/).click()
  await expect(page.getByRole('tab', { name: /orders · exchange/ })).toBeVisible()
  await page.getByRole('tab', { name: 'Live' }).click()

  // topic exchange → routing-key patterns may be given; empty = everything (#)
  await expect(page.getByLabel('Routing keys to watch')).toBeVisible()
  await page.getByRole('button', { name: '▶ Start listening' }).click()
  const state = page.getByTestId('live-state').filter({ visible: true })
  await expect(state).toContainText('Listening · 0 received')
  await expect(page.getByTestId('live-bindings').filter({ visible: true })).toContainText('orders · #')

  // publish from the same tab → it appears live, without any refresh
  await page.getByRole('tab', { name: 'Publish' }).click()
  await page.getByLabel('Routing key', { exact: true }).fill('order.created.jp')
  await page.getByRole('button', { name: 'Publish message' }).click()
  await page.getByRole('tab', { name: 'Live' }).click()
  const rows = page.getByTestId('live-rows').filter({ visible: true }).locator('tbody tr')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('order.created.jp')
  await expect(state).toContainText('Listening · 1 received')

  // watching copied the message: the queue bound to the exchange still got it
  await expect(sidebarRow(page, 'orders.created').first()).toContainText('5 msg')

  // a watched message opens in the viewer
  await rows.first().getByTitle('View payload').click()
  await expect(page.getByRole('dialog', { name: 'Message payload' })).toBeVisible()
  await page.getByRole('dialog', { name: 'Message payload' }).getByText('Close', { exact: true }).click()

  const stopsBefore = await ipcCalls(page, 'rabbit_live_stop')
  await page.getByRole('button', { name: '■ Stop' }).click()
  await expect(state).toContainText('Stopped · 1 received')
  expect(await ipcCalls(page, 'rabbit_live_stop')).toBe(stopsBefore + 1)
  expect(errors).toEqual([])
})

test('rabbitmq live: consume asks first, drains the queue, then takes new messages as they land', async ({ page }) => {
  const errors = await open(page)
  await sidebarRow(page, 'orders.created').first().click()
  await page.getByRole('tab', { name: 'Live' }).click()
  await page.getByLabel('Live mode').selectOption('consume')
  await page.getByRole('button', { name: '▶ Start listening' }).click()

  // destructive → confirm; the backdrop does not dismiss it
  const confirm = page.getByRole('dialog', { name: 'Consume messages live' })
  await expect(confirm).toBeVisible()
  await page.mouse.click(8, 8)
  await expect(confirm).toBeVisible()
  await confirm.getByText('Consume', { exact: true }).click()

  const rows = page.getByTestId('live-rows').filter({ visible: true }).locator('tbody tr')
  await expect(rows).toHaveCount(4) // what was already waiting
  await expect(sidebarRow(page, 'orders.created').first()).toContainText('0 msg')

  // a message published now is taken the moment it lands — the queue stays empty
  await page.getByRole('tab', { name: 'Publish' }).click()
  await page.getByRole('button', { name: 'Publish message' }).click()
  await page.getByRole('tab', { name: 'Live' }).click()
  await expect(rows).toHaveCount(5)
  await expect(page.getByTestId('live-state').filter({ visible: true })).toContainText('5 received')
  await expect(page.locator('[data-stat="Ready"]')).toContainText('0')

  // switching sections does not stop the session; closing the tab does
  await page.getByRole('tab', { name: 'Details' }).click()
  await page.getByRole('tab', { name: 'Live' }).click()
  await expect(page.getByTestId('live-state').filter({ visible: true })).toContainText('Listening')
  const stopsBefore = await ipcCalls(page, 'rabbit_live_stop')
  await page.getByRole('tab', { name: /orders\.created · queue/ }).getByTitle('Close (Ctrl+W)').click()
  await expect.poll(() => ipcCalls(page, 'rabbit_live_stop')).toBe(stopsBefore + 1)
  expect(errors).toEqual([])
})

test('rabbitmq live: a queue reached only by name cannot be watched (said, not silent)', async ({ page }) => {
  const errors = await open(page)
  await sidebarRow(page, 'billing.invoices').click()
  await page.getByRole('tab', { name: 'Live' }).click()
  await page.getByRole('button', { name: '▶ Start listening' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'default exchange' })).toBeVisible()
  await expect(page.getByTestId('live-state').filter({ visible: true })).toContainText('Not listening')
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------------------------------
// Users · permissions · policies · vhosts
// ---------------------------------------------------------------------------------------

async function openUsers(page: Page) {
  await page.getByText('Users ▸', { exact: true }).click()
  await expect(page.getByRole('tab', { name: /Users · RabbitMQ/ })).toBeVisible()
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

  // the explorer follows the vhost the connection really opened on, and says so
  await expect(page.getByTestId('rabbit-vhost-note')).toContainText("Virtual host '/' does not exist on this broker — showing 'staging'")
  await expect(page.getByLabel('RabbitMQ virtual host')).toHaveValue('staging')
  await expect(page.getByLabel('RabbitMQ virtual host').locator('option')).toHaveText(['staging'])
  await expect(sidebarRow(page, 'orders.created')).toBeVisible()
  await expect(page.getByText(/Not found — Not Found/)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('rabbitmq: the create forms look and behave like the management UI', async ({ page }) => {
  const errors = await open(page)

  // ---- Add a new queue ----------------------------------------------------------------
  await page.getByText('＋ Queue', { exact: true }).click()
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
  await expect(page.getByRole('tab', { name: /typed.q · queue/ })).toBeVisible()
  // the broker received typed values
  await page.getByRole('tab', { name: 'Details' }).click()
  const args = await previewText(page, 'Queue arguments')
  expect(JSON.parse(args)).toEqual({ 'x-message-ttl': 60000, 'x-single-active-consumer': true, 'x-custom': ['a', 'b'], 'x-queue-type': 'classic' })

  // ---- Add a new exchange --------------------------------------------------------------
  await page.getByText('＋ Exchange', { exact: true }).click()
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
  await expect(page.getByRole('tab', { name: /with.ae · exchange/ })).toBeVisible()
  await page.getByRole('tab', { name: 'Details' }).click()
  expect(JSON.parse(await previewText(page, 'Exchange arguments'))).toEqual({ 'alternate-exchange': 'events' })
  expect(errors).toEqual([])
})

test('rabbitmq: "Add a new queue" can bind the queue with a routing key right away', async ({ page }) => {
  const errors = await open(page)
  await page.getByText('＋ Queue', { exact: true }).click()
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

  // the queue tab shows both bindings with their routing keys
  await expect(page.getByRole('tab', { name: /retry.q · queue/ })).toBeVisible()
  await page.getByRole('tab', { name: /Bindings/ }).click()
  const rows = page.locator('tr.rq-row')
  await expect(rows.filter({ hasText: 'order.retry.#' })).toContainText('orders')
  await expect(rows.filter({ hasText: 'events' })).toHaveCount(1)
  await expect(page.getByRole('tab', { name: 'Bindings (3)', exact: true })).toBeVisible() // + the default-exchange one

  // and the binding routes: publish to orders with a matching key → it lands in retry.q
  await page.getByRole('tab', { name: 'Publish' }).click()
  await page.getByLabel('Exchange', { exact: true }).selectOption('orders')
  await page.getByLabel('Routing key', { exact: true }).fill('order.retry.42')
  await page.getByRole('button', { name: 'Publish message' }).click()
  await expect(page.getByTestId('publish-result')).toContainText('Routed')
  await expect(page.locator('[data-stat="Ready"]')).toContainText('1')
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
  await expect(page.getByTestId('rabbit-summary')).toBeVisible()
  await openUsers(page)

  // the real reason, not "Authentication failed"
  const err = page.getByTestId('users-error')
  await expect(err).toContainText("'administrator' tag")
  await expect(err).toContainText('Logged in as studio (management)')
  await expect(page.getByText('Authentication failed')).toHaveCount(0)
  await expect(page.getByRole('note')).toContainText('does not have the administrator tag')

  // what this user can read still loads
  await page.getByRole('tab', { name: 'Policies' }).click()
  await expect(page.getByRole('table', { name: 'Policies' })).toContainText('dlx-orders')
  await page.getByRole('tab', { name: /Virtual hosts/ }).click()
  await expect(page.getByRole('table', { name: 'Virtual hosts' })).toContainText('staging')
  expect(errors).toEqual([])
})
