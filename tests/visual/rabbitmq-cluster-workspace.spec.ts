import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// SPEC-RABBITMQ-WORKSPACE.md (W2): a RabbitMQ connection opens ONE cluster workspace tab
// (RabbitMQ has no object tree), written in plain language
// (SPEC-STREAM-SHELL.md §1b). Runs against the stateful demo broker (`?rabbitmq=1`).

async function openRabbit(page: Page, extra: Record<string, string> = {}) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  url.searchParams.set('rabbitmq', '1')
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /RabbitMQ 10\.0\.9\.4:15672/ }).dblclick()
  // RabbitMQ has no object tree — connecting opens its workspace tab
  await expect(page.locator('[data-stream-shell="rabbitmq"]')).toContainText('RabbitMQ 3.13.7', { timeout: 8000 })
  return errors
}

const section = (page: Page, id: string) =>
  page.locator(`[data-stream-shell="rabbitmq"] nav[aria-label="Sections"] [data-section="${id}"]`)
const workspaceTabs = (page: Page) => page.getByRole('tab', { name: /^RabbitMQ/ })
const shell = (page: Page) => page.locator('[data-stream-shell="rabbitmq"]')
const nav = (page: Page, label: RegExp) => shell(page).getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: label })

test('rabbitmq workspace: connecting opens one workspace (no tree); overview speaks plainly and charts the flow', async ({ page }) => {
  const errors = await openRabbit(page)
  // connecting opens exactly one workspace tab; its nav lists the sections
  await expect(workspaceTabs(page)).toHaveCount(1)
  for (const id of ['overview', 'queues', 'exchanges', 'connections', 'nodes', 'access']) await expect(section(page, id)).toBeVisible()
  await expect(section(page, 'queues')).toContainText('need attention')
  await expect(page.locator('[data-sidebar-panel="explorer"]')).toHaveCount(0) // no object tree for RabbitMQ

  await section(page, 'overview').click()
  await expect(workspaceTabs(page)).toHaveCount(1)
  const ws = shell(page)
  // one status sentence with the reason and an action (rule U2)
  const status = ws.getByRole('status').first()
  await expect(status).toContainText('3 queues need attention')
  await expect(status.getByRole('button', { name: 'Show queues' })).toBeVisible()
  // plain labels, never the API field names (rule U1)
  for (const label of ['Waiting', 'In progress', 'Consumers', 'Connections', 'Alarms']) {
    await expect(ws.locator('.sc-label', { hasText: label }).first()).toBeVisible()
  }
  await expect(ws.getByText(/messages_ready|messages_unacknowledged|\bUnacked\b/)).toHaveCount(0)

  // rate chart: Incoming / Delivered / Confirmed per second, with a live latest value
  const chart = ws.getByRole('img', { name: /Messages per second/ })
  await expect(chart).toBeVisible()
  for (const k of ['Incoming', 'Delivered', 'Confirmed']) await expect(ws.locator('.rc-key', { hasText: k })).toContainText('/s')

  // queues needing attention: reason in words + an action
  const attn = ws.getByTestId('queues-attention')
  await expect(attn).toContainText('orders.dlq')
  await expect(attn).toContainText('2 failed messages waiting in this dead-letter queue.')
  await expect(attn).toContainText('No consumers — 1 message waiting.')
  await expect(attn).toContainText('1,240 messages in progress for 1 consumer')
  // nodes summary
  await expect(ws.locator('.rw-panel', { hasText: 'Nodes' }).first()).toContainText('rabbit@demo')

  // the status action opens the Queues section in the same tab
  await status.getByRole('button', { name: 'Show queues' }).click()
  await expect(nav(page, /^Queues/)).toHaveAttribute('aria-current', 'page')
  await expect(workspaceTabs(page)).toHaveCount(1)

  // the overview samples the rate every 5 s while it is on screen
  await nav(page, /^Overview/).click()
  const before = await page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.rabbit_overview ?? 0)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.rabbit_overview ?? 0), { timeout: 20_000 }).toBeGreaterThan(before)
  expect(errors, errors.join('\n')).toEqual([])
})

test('rabbitmq workspace: queues table → details with plain counts, readable rules and a Consumers tab', async ({ page }) => {
  const errors = await openRabbit(page)
  await section(page, 'queues').click()
  const ws = shell(page)
  const grid = ws.getByRole('grid', { name: 'Queues' })
  await expect(grid.locator('tbody tr').filter({ hasText: 'orders.created' })).toBeVisible()
  // plain headers with a one-sentence tooltip
  await expect(grid.locator('th', { hasText: 'Waiting' })).toHaveAttribute('title', 'Messages no consumer has picked up yet.')
  await expect(grid.locator('th', { hasText: 'In progress' })).toBeVisible()
  // a queue whose counts are not reported shows "?", not 0
  await expect(grid.locator('tbody tr').filter({ hasText: 'billing.invoices' })).toContainText('?')
  // full-word feature chips
  await expect(grid.locator('tbody tr').filter({ hasText: 'orders.created' })).toContainText('Durable')

  // filter, then select with the keyboard
  await ws.getByLabel('Filter queues…').fill('orders')
  await expect(grid.locator('tbody tr')).toHaveCount(2)
  await ws.getByLabel('Filter queues…').fill('')
  await grid.locator('tbody tr').filter({ hasText: 'orders.created' }).click()
  const detail = page.locator('[data-rabbit-queue="orders.created"]')
  await expect(detail).toBeVisible()
  await expect(detail.locator('[data-stat="Ready"]')).toContainText('Waiting')
  await expect(detail.locator('[data-stat="Ready"]')).toContainText('4')
  await expect(detail.locator('[data-stat="Unacked"]')).toContainText('In progress')

  // Consumers sub-tab: the application, the machine, messages held at once
  await detail.getByRole('tab', { name: /Consumers/ }).click()
  const consumers = detail.getByTestId('queue-consumers')
  await expect(consumers).toContainText('orders-api')
  await expect(consumers).toContainText('10.0.4.21')
  await expect(consumers).toContainText('Messages held at once')
  await expect(consumers.locator('tbody tr').first()).toContainText('10')
  // consumer tags stay behind Advanced (rule U3)
  await expect(consumers.getByText('amq.ctag-Xb3k9Q1')).toHaveCount(0)
  await consumers.getByRole('button', { name: 'Advanced' }).click()
  await expect(consumers.getByText('amq.ctag-Xb3k9Q1')).toBeVisible()

  // Details: arguments as sentences; the raw x-* only under Advanced
  await detail.getByRole('tab', { name: 'Details' }).click()
  const rules = detail.getByTestId('queue-rules')
  await expect(rules).toContainText('Messages expire after 1 day')
  await expect(rules).toContainText('Keeps at most 10,000 messages — when full, new messages are refused')
  await expect(rules).toContainText('Failed messages go to orders.dlx')
  await expect(detail.getByText('x-message-ttl')).toHaveCount(0)
  await detail.getByRole('button', { name: /Advanced/ }).click()
  await expect(detail.getByRole('textbox').or(detail.locator('[data-codeview], .cv-box')).first()).toBeVisible()

  // "See consumers" from the overview lands on the Consumers tab of that queue
  await nav(page, /^Overview/).click()
  await ws.getByTestId('queues-attention').locator('li', { hasText: 'payments.process' }).getByRole('button', { name: 'See consumers' }).click()
  const pay = page.locator('[data-rabbit-queue="payments.process"]')
  await expect(pay.getByTestId('queue-consumers')).toContainText('billing-worker')
  await expect(pay.getByTestId('queue-consumers').locator('tbody tr').first()).toContainText('No limit')
  expect(errors, errors.join('\n')).toEqual([])
})

test('rabbitmq workspace: purge and delete name the consequence; the create form previews the result', async ({ page }) => {
  const errors = await openRabbit(page)
  await section(page, 'queues').click()
  const ws = shell(page)
  await ws.getByRole('grid', { name: 'Queues' }).locator('tbody tr').filter({ hasText: 'orders.created' }).click()
  const detail = page.locator('[data-rabbit-queue="orders.created"]')

  // purge: the dialog says how many, the button repeats the number (rule U8)
  await detail.getByRole('button', { name: 'Purge…' }).click()
  const purge = page.getByRole('dialog', { name: 'Purge queue' })
  await expect(purge).toContainText('Remove 4 waiting messages from "orders.created"')
  await page.mouse.click(8, 8) // backdrop does not close it
  await expect(purge).toBeVisible()
  await purge.getByText('Purge 4 messages', { exact: true }).click()
  await expect(purge).toHaveCount(0)
  await expect(detail.locator('[data-stat="Ready"]')).toContainText('0')

  // create a queue from the workspace: the form shows what will be created
  await ws.getByRole('button', { name: '+ Create queue' }).click()
  const dlg = page.getByRole('dialog', { name: 'Add a new queue' })
  await dlg.getByLabel('Name', { exact: true }).fill('ws.retry')
  await dlg.getByLabel('Type', { exact: true }).selectOption('quorum')
  await dlg.getByTestId('arg-helpers').getByText('Delivery limit', { exact: true }).click()
  await dlg.getByLabel('Argument 1 value').fill('5')
  const preview = dlg.getByTestId('create-preview')
  await expect(preview).toContainText('A durable quorum queue “ws.retry” in virtual host /.')
  await expect(preview).toContainText('Max 5 delivery attempts')
  await expect(preview).toContainText('Messages reach it only when published to it by name')
  await dlg.getByText('Add queue', { exact: true }).click()
  await expect(dlg).toHaveCount(0)
  // the new queue opens in the details of the same workspace tab
  await expect(page.locator('[data-rabbit-queue="ws.retry"]')).toBeVisible()
  await expect(workspaceTabs(page)).toHaveCount(1)

  // delete it: the dialog names what goes with it; the details close and the row goes
  const created = page.locator('[data-rabbit-queue="ws.retry"]')
  await created.getByRole('button', { name: 'Delete queue…' }).click()
  const del = page.getByRole('dialog', { name: 'Delete queue' })
  await expect(del).toContainText('Delete queue "ws.retry"')
  await del.getByRole('button', { name: 'Delete queue', exact: true }).click()
  await expect(created).toHaveCount(0)
  await expect(ws.getByRole('grid', { name: 'Queues' }).locator('tbody tr').filter({ hasText: 'ws.retry' })).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})

test('rabbitmq workspace: exchanges, connections (close with a confirm), nodes and users', async ({ page }) => {
  const errors = await openRabbit(page)
  await section(page, 'exchanges').click()
  const ws = shell(page)
  const xs = ws.getByRole('grid', { name: 'Exchanges' })
  await xs.locator('tbody tr').filter({ hasText: /^orders/ }).first().click()
  const x = page.locator('[data-rabbit-exchange="orders"]')
  await expect(x).toContainText('topic exchange')
  await x.getByRole('tab', { name: 'Details' }).click()
  await expect(x.getByTestId('exchange-rules')).toContainText('Topic — delivers by pattern')
  // a binding row links to its queue in the same workspace
  await x.getByRole('tab', { name: /Bindings/ }).click()
  await x.getByRole('button', { name: 'orders.created' }).click()
  await expect(nav(page, /^Queues/)).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('[data-rabbit-queue="orders.created"]')).toBeVisible()

  // connections: application names, machines, encryption in words
  await section(page, 'connections').click()
  const grid = ws.getByRole('grid', { name: 'Connections' })
  await expect(grid.locator('tbody tr')).toHaveCount(3)
  await expect(grid.locator('tbody tr').filter({ hasText: 'orders-api' })).toContainText('Yes (TLS)')
  await grid.locator('tbody tr').filter({ hasText: 'orders-api' }).click()
  const detail = ws.getByTestId('connection-detail')
  await expect(detail).toContainText('RabbitMQ 5.20.0 · Java')
  await detail.getByRole('button', { name: 'Close connection…' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Close connection' })
  await expect(confirm).toContainText('its 2 channels close, its consumers stop receiving')
  await page.mouse.click(8, 8)
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Close connection of orders-api' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(grid.locator('tbody tr')).toHaveCount(2)
  await expect(grid.locator('tbody tr').filter({ hasText: 'orders-api' })).toHaveCount(0)
  // …and the queue it consumed from has no consumer any more
  await section(page, 'queues').click()
  await expect(ws.getByRole('grid', { name: 'Queues' }).locator('tbody tr').filter({ hasText: 'orders.created' })).toContainText('None')

  // nodes: memory against the limit, free disk against the safety margin; fds behind Advanced
  await section(page, 'nodes').click()
  const node = ws.locator('[data-node="rabbit@demo"]')
  await expect(node).toContainText('Healthy')
  await expect(node).toContainText('Memory used')
  await expect(node).toContainText('of 1.6 GB')
  await expect(node).toContainText('margin 47.7 MB')
  await expect(node.getByText('File descriptors')).toHaveCount(0)
  await node.getByRole('button', { name: 'Advanced' }).click()
  await expect(node.getByText('File descriptors')).toBeVisible()

  // users & access is part of the workspace
  await section(page, 'access').click()
  await expect(nav(page, /^Users & access/)).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('option').filter({ hasText: 'studio' })).toContainText('you')
  expect(errors, errors.join('\n')).toEqual([])
})

test('rabbitmq workspace: a user without the monitoring tag is told so (not a blank page)', async ({ page }) => {
  const errors = await openRabbit(page, { rabbitNoMonitor: '1' })
  await section(page, 'nodes').click()
  const ws = shell(page)
  const alert = ws.getByRole('alert').filter({ hasText: 'Node details are not available' })
  await expect(alert).toContainText("'monitoring' tag")
  await expect(ws.getByText('Authentication failed')).toHaveCount(0)
  // the overview still works and says the node details are unknown
  await section(page, 'overview').click()
  await expect(ws.locator('.sc-card', { hasText: 'Alarms' })).toContainText('node details unavailable')
  expect(errors, errors.join('\n')).toEqual([])
})

// Numbers sit one step below the names, and a cell that shows only a zero steps back
// further — so the queues that hold something stand out without extra colour.
test('rabbitmq workspace: numbers are quieter than names, zeros quieter still', async ({ page }) => {
  await openRabbit(page)
  await section(page, 'queues').click()
  const grid = shell(page).getByRole('grid', { name: 'Queues' })
  const row = grid.locator('tbody tr', { hasText: 'payments.process' }).first()
  await expect(row).toBeVisible()
  const colors = await row.evaluate((tr) => {
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const tone = (v: string) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color }
    const out = {
      text: tone('--tbl-name'), text2: tone('--tbl-cell'), muted: tone('--tbl-zero'),
      name: getComputedStyle(tr.querySelector('.ds-name')!).color,
      zero: [...tr.querySelectorAll('td[data-zero]')].map((td) => (td.textContent ?? '').trim()),
      consumers: '' as string,
      zeroColor: '' as string,
    }
    const cells = [...tr.querySelectorAll('td.right')] as HTMLElement[]
    const one = cells.find((td) => (td.textContent ?? '').trim() === '1')
    out.consumers = one ? getComputedStyle(one).color : ''
    const z = tr.querySelector('td[data-zero]') as HTMLElement | null
    out.zeroColor = z ? getComputedStyle(z.firstElementChild ?? z).color : ''
    probe.remove()
    return out
  })
  expect(colors.name, 'queue name reads in the soft table-name colour').toBe(colors.text)
  expect(colors.consumers, 'a non-zero number is one step quieter').toBe(colors.text2)
  expect(colors.zero, 'the "0" waiting and "0/s" delivered cells are marked').toEqual(['0', '0/s'])
  expect(colors.zeroColor, 'zeros step back to the table zero colour').toBe(colors.muted)
})
