import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Redpanda = a flavor of the Kafka engine (SPEC-REDPANDA.md): its own card, logo and
// sidebar band; the Kafka workspace gains what Redpanda's Admin API knows (health,
// version, disks, license, balancer, broker maintenance, cluster configuration,
// SASL users, roles, data transforms) and Kafka ACLs (on Apache Kafka too).
// The demo connection is opt-in (`?redpanda=1`) so every other spec keeps its list.

async function open(page: Page, params: Record<string, string> = { redpanda: '1' }) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  return errors
}

const shell = (page: Page) => page.locator('[data-stream-shell="kafka"]')
const section = (page: Page, name: RegExp) => shell(page).getByRole('navigation', { name: 'Sections' }).getByRole('button', { name })

async function openRedpanda(page: Page, sec?: RegExp) {
  await page.getByText('Orders Redpanda').first().click()
  await expect(shell(page)).toBeVisible()
  // a new tab opens on Topics (the messages of the first topic) — go where the test looks
  await section(page, sec ?? /^Overview/).click()
}

test('picker has a Redpanda card; the form asks for the Admin API', async ({ page }) => {
  const errors = await open(page, {})
  await page.getByTitle('New connection').first().click()
  const card = page.locator('.picker-card[title="Redpanda"]')
  await expect(card.locator('svg[data-logo="redpanda"]')).toBeVisible()
  await expect(page.locator('.picker-card[title="Kafka"] svg[data-logo="kafka"]')).toBeVisible()
  await card.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('radio', { name: 'Redpanda' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByLabel('Admin API URL')).toBeVisible()
  await expect(dialog.getByTestId('rp-hint')).toBeVisible()
  // back to Apache Kafka: no Admin API field
  await dialog.getByRole('radio', { name: 'Apache Kafka' }).click()
  await expect(dialog.getByLabel('Admin API URL')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('overview: version, disk, balancer and license from the Admin API', async ({ page }) => {
  const errors = await open(page)
  await openRedpanda(page)
  await expect(shell(page).locator('svg[data-logo="redpanda"]').first()).toBeVisible()
  await expect(shell(page)).toContainText('Redpanda v26.2.6')
  await expect(shell(page)).toContainText('Everything looks healthy')
  for (const t of ['Version', 'v26.2.6', 'Fullest disk', '87%', 'Partition balancer', 'Balanced', 'License', 'Trial']) await expect(shell(page)).toContainText(t)
  // sections only Redpanda has
  for (const s of [/^Security/, /^Configuration/, /^Transforms/]) await expect(section(page, s)).toBeVisible()
  expect(errors).toEqual([])
})

test('a broker that is down makes the cluster ask for attention', async ({ page }) => {
  await open(page, { redpanda: 'down' })
  await openRedpanda(page)
  await expect(shell(page)).toContainText('The cluster needs attention')
  await expect(shell(page)).toContainText('Down: broker 3')
  await section(page, /^Brokers/).click()
  const row = shell(page).getByRole('row').filter({ hasText: 'Broker 3' })
  await expect(row).toContainText('Down')
})

test('brokers: maintenance on, refused for a second broker, then off', async ({ page }) => {
  const errors = await open(page)
  await openRedpanda(page, /^Brokers/)
  const row = (id: number) => shell(page).getByRole('row').filter({ hasText: `Broker ${id}` })
  await expect(row(2)).toContainText('v26.2.6')
  await row(2).getByRole('button', { name: 'Maintenance…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Start maintenance' })
  await expect(dlg).toContainText('Put broker 2 into maintenance?')
  await dlg.getByRole('button', { name: 'Start maintenance' }).click()
  await expect(row(2)).toContainText('In maintenance')
  // Redpanda allows one broker in maintenance at a time — the refusal stays in the dialog
  await row(3).getByRole('button', { name: 'Maintenance…' }).click()
  await page.getByRole('dialog', { name: 'Start maintenance' }).getByRole('button', { name: 'Start maintenance' }).click()
  await expect(page.getByRole('dialog', { name: 'Start maintenance' })).toContainText('Another node is already in maintenance mode')
  await page.getByRole('dialog', { name: 'Start maintenance' }).getByRole('button', { name: 'Cancel' }).click()
  await row(2).getByRole('button', { name: 'End maintenance' }).click()
  await page.getByRole('dialog', { name: 'End maintenance' }).getByRole('button', { name: 'End maintenance' }).click()
  await expect(row(2)).toContainText('Running')
  expect(errors).toEqual([])
})

test('security: create a user, grant access in words, delete with its ACLs', async ({ page }) => {
  const errors = await open(page)
  await openRedpanda(page, /^Security/)
  await expect(page.getByRole('table', { name: 'Users' })).toContainText('analytics')
  await page.getByRole('button', { name: 'Create user' }).click()
  const dlg = page.getByRole('dialog', { name: 'Create user' })
  await dlg.getByLabel('User name').fill('analytics')
  await expect(dlg).toContainText('already exists')
  await dlg.getByLabel('User name').fill('reporting')
  await dlg.getByRole('button', { name: /Generate/ }).click()
  await expect(dlg.getByRole('textbox', { name: 'Password' })).not.toHaveValue('')
  await dlg.getByRole('button', { name: 'SCRAM-SHA-512' }).click()
  await dlg.getByLabel('readers').check()
  await dlg.getByRole('button', { name: 'Create user' }).click()

  // creating a user goes straight to "what may they do"
  const grant = page.getByRole('dialog', { name: 'Grant access' })
  await expect(grant.getByLabel('User name')).toHaveValue('reporting')
  await grant.getByText('Produce to a topic').click()
  await grant.getByLabel('Resource name').fill('payments')
  await expect(grant.getByRole('list', { name: 'ACLs to create' })).toContainText('Allow reporting — write on topic payments')
  await grant.getByRole('button', { name: 'Grant 2 permissions' }).click()
  await expect(grant).toHaveCount(0)

  const users = page.getByRole('table', { name: 'Users' })
  const me = users.getByRole('row').filter({ hasText: 'reporting' })
  await expect(me).toContainText('readers')
  await expect(me.getByRole('cell').nth(2)).toHaveText('2')

  await me.getByRole('button', { name: 'Delete user reporting' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete user reporting?' })
  await expect(confirm.getByRole('checkbox')).toBeChecked()
  await confirm.getByRole('button', { name: 'Delete user' }).click()
  await expect(users).not.toContainText('reporting')
  await page.getByRole('tab', { name: /^ACLs/ }).click()
  await expect(page.getByRole('table', { name: 'ACLs' })).not.toContainText('reporting')
  expect(errors).toEqual([])
})

test('security: roles and ACL deletion', async ({ page }) => {
  const errors = await open(page)
  await openRedpanda(page, /^Security/)
  await page.getByRole('tab', { name: /^Roles/ }).click()
  await page.getByRole('button', { name: 'Create role' }).click()
  const dlg = page.getByRole('dialog', { name: 'Create role' })
  await dlg.getByLabel('Role name').fill('readers')
  await expect(dlg).toContainText('already exists')
  await dlg.getByLabel('Role name').fill('auditors')
  await dlg.getByRole('button', { name: 'Create role' }).click()
  const detail = page.getByRole('region', { name: 'Role auditors' })
  await detail.getByLabel('Add a member').selectOption('billing-svc')
  await detail.getByRole('button', { name: 'Add' }).click()
  await expect(detail).toContainText('billing-svc')
  await detail.getByRole('button', { name: 'Remove billing-svc from auditors' }).click()
  await expect(detail).toContainText('No members yet')
  await detail.getByRole('button', { name: 'Delete role…' }).click()
  await page.getByRole('dialog', { name: 'Delete role auditors?' }).getByRole('button', { name: 'Delete role' }).click()
  await expect(page.getByRole('list', { name: 'Roles' })).not.toContainText('auditors')

  await page.getByRole('tab', { name: /^ACLs/ }).click()
  const table = page.getByRole('table', { name: 'ACLs' })
  await page.getByLabel('Filter ACLs').fill('orders')
  await expect(table.getByRole('row')).toHaveCount(3) // header + 2
  for (const box of await table.getByRole('checkbox').all()) await box.check()
  await page.getByRole('button', { name: 'Delete 2 selected' }).click()
  await page.getByRole('dialog', { name: 'Delete 2 ACLs?' }).getByRole('button', { name: 'Delete 2 ACLs' }).click()
  await expect(table).toHaveCount(0)
  await expect(shell(page)).toContainText('No ACL matches the filter')
  expect(errors).toEqual([])
})

test('configuration: search, change with a live preview, refuse bad input, reset', async ({ page }) => {
  const errors = await open(page)
  await openRedpanda(page, /^Configuration/)
  await page.getByLabel('Search settings').fill('retention')
  const row = shell(page).locator('[data-key="log_retention_ms"]')
  await expect(row).toContainText('3 days')
  await expect(row).toContainText('Changed')
  await row.getByRole('button', { name: 'Edit Log retention' }).click()
  const input = row.getByLabel('Log retention')
  await input.fill('two days')
  await expect(row).toContainText('needs a number')
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  await input.fill('172800000')
  await expect(row).toContainText('= 2 days')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(row).toContainText('2 days')
  await expect(page.getByRole('region', { name: 'Unsaved settings' })).toHaveCount(0)
  // back to the default
  await row.getByRole('button', { name: 'Use default' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(row).toContainText('7 days')
  await expect(row).not.toContainText('Changed')

  // a setting that needs a restart says so once saved
  await page.getByLabel('Search settings').fill('transactions')
  const tx = shell(page).locator('[data-key="enable_transactions"]')
  await expect(tx).toContainText('Restart')
  await tx.getByRole('checkbox', { name: 'Enable transactions' }).uncheck()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(shell(page)).toContainText('Restart needed')
  expect(errors).toEqual([])
})

test('transforms: listed with their state; removable; switched off says how to switch on', async ({ page }) => {
  const errors = await open(page)
  await openRedpanda(page, /^Transforms/)
  const t = page.getByRole('table', { name: 'Transforms' })
  await expect(t).toContainText('redact-pii')
  await expect(t).toContainText('orders-clean')
  await expect(t).toContainText('Running')
  await t.getByRole('button', { name: 'Remove…' }).click()
  await page.getByRole('dialog', { name: 'Remove transform' }).getByRole('button', { name: 'Remove transform' }).click()
  await expect(shell(page)).toContainText('No transforms deployed')
  expect(errors).toEqual([])
})

test('transforms switched off', async ({ page }) => {
  await open(page, { redpanda: '1', redpandaTransforms: 'off' })
  await openRedpanda(page, /^Transforms/)
  await expect(shell(page)).toContainText('Data transforms are switched off')
  await page.getByRole('button', { name: 'Switch on data transforms' }).click()
  await expect(shell(page)).toContainText('Restart the brokers')
})

test('Apache Kafka keeps its workspace and gains ACLs only', async ({ page }) => {
  const errors = await open(page, {})
  await page.getByText('Events Kafka').first().click()
  await expect(shell(page)).toBeVisible()
  await expect(section(page, /^Configuration/)).toHaveCount(0)
  await expect(section(page, /^Transforms/)).toHaveCount(0)
  await section(page, /^Security/).click()
  await expect(page.getByRole('tab', { name: /^Users/ })).toHaveCount(0)
  await expect(shell(page)).toContainText('Users themselves are managed by your Kafka setup')
  await page.getByRole('button', { name: 'Grant access' }).click()
  const grant = page.getByRole('dialog', { name: 'Grant access' })
  // no Redpanda roles on Apache Kafka
  await expect(grant.getByRole('button', { name: 'Role' })).toHaveCount(0)
  await grant.getByLabel('User name').fill('etl')
  await grant.getByRole('button', { name: 'Exact permissions' }).click()
  await grant.getByText('Cluster', { exact: true }).click()
  await grant.getByText('Create', { exact: true }).click()
  await expect(grant.getByRole('list', { name: 'ACLs to create' })).toContainText('Allow etl — create on the cluster')
  await grant.getByRole('button', { name: /^Grant/ }).click()
  await expect(page.getByRole('table', { name: 'ACLs' })).toContainText('etl')
  expect(errors).toEqual([])
})
