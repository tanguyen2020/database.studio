import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Redis · Kafka · NATS · RabbitMQ open straight into their workspace tab (no object
// tree), so that tab has to show the state of the connection: connecting (how long it
// has been trying), why it failed (in words + what to check + the server's message,
// with Retry / Edit connection), or "Not connected" with a Connect button. The row in
// Connections shows a spinner + "Connecting…" and "Couldn't connect".
// Demo seams: ?slowConnect=<ms>, ?connectFail=<id>, ?connectFailOnce=<id>, ?connectFailMsg=

async function open(page: Page, query = '') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  return errors
}

const row = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(name) }).first()

async function disconnect(page: Page, name: string) {
  await row(page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Disconnect/ }).click()
  await expect(row(page, name).locator('.conn-connecting')).toHaveCount(0)
}

test('connecting shows in the tab and on the row, then the workspace opens', async ({ page }) => {
  const errors = await open(page, '?slowConnect=1500')
  await disconnect(page, 'Cache Redis')
  await row(page, 'Cache Redis').dblclick()

  // the tab is there at once, saying what is happening
  const state = page.locator('[data-conn-state="connecting"]')
  await expect(state).toBeVisible()
  await expect(state).toContainText('Connecting…')
  await expect(state).toContainText('Cache Redis')
  await expect(state).toContainText('10.0.1.7:6379')
  await expect(state.getByRole('status')).toHaveAttribute('aria-busy', 'true')
  // and so is the row: a spinner + "Connecting…" instead of the address
  await expect(row(page, 'Cache Redis').locator('.conn-connecting')).toBeVisible()
  await expect(row(page, 'Cache Redis').locator('[data-conn-sub]')).toHaveText('Connecting…')

  // connected → the workspace replaces the card
  await expect(page.locator('[data-stream-shell="redis"]')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('[data-conn-state]')).toHaveCount(0)
  await expect(row(page, 'Cache Redis').locator('[data-conn-sub]')).toHaveText('10.0.1.7:6379')
  expect(errors).toEqual([])
})

test('a failed connect is explained in the tab, with what to check and the server message', async ({ page }) => {
  const msg = encodeURIComponent('driver error: Meta data fetch error: BrokerTransportFailure (Local: Broker transport failure)')
  const errors = await open(page, `?connectFail=c5&connectFailMsg=${msg}`)
  await disconnect(page, 'Events Kafka')
  await row(page, 'Events Kafka').dblclick()

  const failed = page.locator('[data-conn-state="failed"]')
  await expect(failed).toBeVisible()
  await expect(failed).toContainText('Could not reach the Kafka brokers')
  await expect(failed).toContainText('kafka-1:9092')
  await expect(failed.getByText('What to check')).toBeVisible()
  await expect(failed).toContainText('advertised.listeners')
  // the raw text is one click away, without the transport prefix
  await expect(failed.locator('pre')).toHaveCount(0)
  await failed.getByRole('button', { name: 'Show details' }).click()
  await expect(failed.locator('pre')).toHaveText('Meta data fetch error: BrokerTransportFailure (Local: Broker transport failure)')
  // the row says it too
  await expect(row(page, 'Events Kafka').locator('[data-conn-sub]')).toHaveText("Couldn't connect · kafka-1:9092")

  // Retry runs again (still failing here) — the card stays, nothing crashes
  await failed.getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('[data-conn-state="failed"]')).toBeVisible()
  // Edit connection opens the form for this connection
  await page.locator('[data-conn-state="failed"]').getByRole('button', { name: 'Edit connection' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  const nameField = page.getByRole('dialog').locator('.cm-label', { hasText: 'Connection name' }).first().locator('xpath=..').locator('.cm-input').first()
  await expect(nameField).toHaveValue('Events Kafka')
  expect(errors).toEqual([])
})

test('Retry after a failure opens the workspace', async ({ page }) => {
  const msg = encodeURIComponent('driver error: nats: Authorization Violation')
  const errors = await open(page, `?connectFailOnce=c6&connectFailMsg=${msg}`)
  await disconnect(page, 'Messaging NATS')
  await row(page, 'Messaging NATS').dblclick()
  const failed = page.locator('[data-conn-state="failed"]')
  await expect(failed).toContainText('Sign-in was rejected')
  await failed.getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('[data-stream-shell="nats"]')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('[data-conn-state]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('picking a closed connection shows "Not connected" with a Connect button', async ({ page }) => {
  const errors = await open(page)
  await disconnect(page, 'Cache Redis')
  // a single click selects it — the workspace tab opens and says it is closed
  await row(page, 'Cache Redis').click()
  const idle = page.locator('[data-conn-state="idle"]')
  await expect(idle).toBeVisible()
  await expect(idle).toContainText('Not connected')
  await idle.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('[data-stream-shell="redis"]')).toBeVisible({ timeout: 8000 })
  expect(errors).toEqual([])
})

test('New connection form: Connect saves AND connects — one click, the workspace opens', async ({ page }) => {
  const errors = await open(page, '?slowConnect=800')
  // ?slowConnect also delays list_connections — wait for the list before adding one
  await expect(row(page, 'Events Kafka')).toBeVisible()
  await page.getByTitle('New connection').first().click()
  await page.getByLabel('Search database types').fill('kafka')
  await page.locator('.picker-card[title="Kafka"]').click()
  const form = page.getByRole('dialog')
  const nameField = form.locator('.cm-label', { hasText: 'Connection name' }).first().locator('xpath=..').locator('.cm-input').first()
  await nameField.fill('Orders Kafka')
  const calls = () => page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.connect ?? 0)
  const before = await calls()
  await form.getByRole('button', { name: 'Connect', exact: true }).click()

  // the form closes, the workspace tab opens straight away and shows the attempt…
  await expect(form).toHaveCount(0)
  await expect(page.locator('[data-conn-state="connecting"]')).toContainText('Orders Kafka')
  // …and the connection opens without a second click
  await expect(page.locator('[data-stream-shell="kafka"]')).toBeVisible({ timeout: 8000 })
  expect(await calls()).toBe(before + 1)
  await expect(row(page, 'Orders Kafka').locator('[data-conn-sub]')).not.toHaveText(/Connecting|Couldn't/)
  expect(errors).toEqual([])
})
