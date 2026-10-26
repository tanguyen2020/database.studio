import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, previewText } from './helpers'

// OpenSearch = a flavor of the Elasticsearch engine (SPEC-OPENSEARCH.md): its own
// card, logo and sidebar band, and every screen on OpenSearch's own APIs — PPL + SQL
// plugins, ISM, Snapshot Management, transforms, rollups, Alerting, the security
// plugin. The demo (src/lib/elastic/os-demo.ts) behaves like OpenSearch 3.9 was
// measured to: updates without if_seq_no are refused, X-Pack routes are missing, the
// password policy applies. Opt-in with `?opensearch=1`.

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  url.searchParams.set('opensearch', '1')
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  return errors
}

async function openConnection(page: Page) {
  await page.getByRole('button', { name: /Search OpenSearch 10\.0\.14\.3:9200/ }).click()
  await expect(page.getByTestId('es-summary')).toContainText('OpenSearch 3.9.0', { timeout: 8000 })
}

const tree = (page: Page, name: string | RegExp) => page.getByTestId('es-explorer').getByRole('treeitem').filter({ hasText: name })
const toast = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast], .toast, [role="status"]').filter({ hasText: text }).first()

test('picker and form: an OpenSearch card, Elasticsearch / OpenSearch engine cards, OpenSearch hints', async ({ page }) => {
  const errors = await open(page)
  await page.getByTitle('New connection').first().click()
  const card = page.locator('.picker-card[title="OpenSearch"]')
  await expect(card.locator('svg[data-logo="opensearch"]')).toBeVisible()
  await expect(page.locator('.picker-card[title="Elasticsearch"]')).toBeVisible()
  await page.getByLabel('Search database types').fill('opensearch')
  await expect(page.locator('.picker-card')).toHaveCount(1)
  await card.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.cm-tile svg[data-logo="opensearch"]')).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'OpenSearch' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByTestId('es-port-hint')).toContainText('OpenSearch Dashboards')
  // Elastic API keys do not exist on OpenSearch
  const auth = dialog.getByLabel('OpenSearch authentication')
  await expect(auth.locator('option[value="apikey"]')).toHaveCount(0)
  await expect(auth.locator('option[value="bearer"]')).toHaveText('Bearer token (JWT)')
  // switching to Elasticsearch brings its own options back
  await dialog.getByRole('radio', { name: 'Elasticsearch' }).click()
  await expect(dialog.getByLabel('Elasticsearch authentication').locator('option[value="apikey"]')).toHaveCount(1)
  await expect(dialog.getByTestId('es-port-hint')).toContainText('Kibana')
  expect(errors).toEqual([])
})

test('explorer: OpenSearch band and logo, OpenSearch management pages, PPL instead of ES|QL', async ({ page }) => {
  const errors = await open(page)
  const band = page.locator('.grp-head', { hasText: 'OpenSearch' })
  await expect(band.locator('svg[data-logo="opensearch"]')).toBeVisible()
  await openConnection(page)
  for (const name of ['Index State Management policies', 'Snapshot policies', 'Transforms', 'Rollups', 'Alerting monitors']) await expect(tree(page, name)).toBeVisible()
  for (const name of ['Index lifecycle policies', 'Watcher', 'Enrich policies', 'Snapshot lifecycle policies']) await expect(tree(page, name)).toHaveCount(0)
  await expect(tree(page, 'PPL query')).toBeVisible()
  await expect(tree(page, 'ES|QL query')).toHaveCount(0)
  // security sections follow the security plugin
  await page.getByTestId('es-explorer').locator('.esx-row.head', { hasText: 'Security' }).click()
  for (const name of ['Internal users', 'Action groups', 'Tenants']) await expect(tree(page, name)).toBeVisible()
  await expect(tree(page, 'API keys')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('query: PPL and SQL run through the plugins, Explain shows the plan', async ({ page }) => {
  const errors = await open(page)
  await openConnection(page)
  await tree(page, 'PPL query').click()
  const q = page.getByTestId('es-query')
  await expect(q.getByRole('button', { name: 'PPL', pressed: true })).toBeVisible()
  await expect(q.getByRole('button', { name: 'ES|QL' })).toHaveCount(0)
  await q.getByRole('button', { name: /Run query/ }).click()
  await expect(q.getByTestId('es-query-meta')).toContainText('rows')
  await q.getByRole('button', { name: /Explain/ }).click()
  await expect(q.getByText('Execution plan')).toBeVisible()
  await expect(q.getByRole('button', { name: 'Open in console' })).toHaveCount(0)
  await q.getByRole('button', { name: 'SQL' }).click()
  await q.getByRole('button', { name: /Run query/ }).click()
  await expect(q.getByTestId('es-query-meta')).toContainText('rows')
  expect(errors).toEqual([])
})

test('ISM: create a policy, then save an edit — the app sends the version OpenSearch requires', async ({ page }) => {
  const errors = await open(page)
  await openConnection(page)
  await tree(page, 'Index State Management policies').click()
  const m = page.getByTestId('es-manage')
  await m.getByRole('button', { name: 'Create ISM policy' }).first().click()
  await page.getByRole('dialog').getByLabel('Name').fill('nightly-cleanup')
  await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click()
  await m.getByRole('button', { name: 'Create ISM policy' }).last().click()
  await expect(m.getByRole('option', { name: /nightly-cleanup/ })).toBeVisible()
  // an edit of an existing policy: without if_seq_no the demo (like OpenSearch) answers 409
  await expect.poll(() => previewText(page, 'ISM policy definition')).toContain('Roll over hot indices daily')
  await page.evaluate(() => {
    type Ed = { getModel(): { getValue(): string; setValue(v: string): void } | null; getRawOptions(): { ariaLabel?: string } }
    const ed = ((window as unknown as { __dsViews?: Ed[] }).__dsViews ?? []).filter((e) => e.getRawOptions().ariaLabel === 'ISM policy definition').at(-1)
    const model = ed?.getModel()
    if (!model) throw new Error('editor not found')
    model.setValue(model.getValue().replace('Roll over hot indices daily, delete them after 30 days', 'edited from the app'))
  })
  await expect(m.getByText('unsaved changes')).toBeVisible()
  await m.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(m.getByText('unsaved changes')).toHaveCount(0)
  await expect(m.locator('.es-callout.danger')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('index lifecycle tab: apply an ISM policy, see it attached, remove it', async ({ page }) => {
  const errors = await open(page)
  await openConnection(page)
  await tree(page, 'orders').first().click()
  await page.getByRole('tab', { name: /Lifecycle/ }).click()
  const card = page.getByTestId('es-ism')
  await expect(card).toContainText('No ISM policy manages this index.')
  await card.getByRole('button', { name: 'Apply policy' }).click()
  await expect(card).toContainText('logs-hot-delete', { timeout: 8000 })
  await expect(card.locator('.es-badge')).toHaveText(/managed|waiting for first run/)
  await card.getByRole('button', { name: 'Remove policy' }).click()
  await expect(card).toContainText('No ISM policy manages this index.', { timeout: 8000 })
  expect(errors).toEqual([])
})

test('security: create a user with a role, weak passwords refused with the reason, built-in roles read-only', async ({ page }) => {
  const errors = await open(page)
  await openConnection(page)
  await page.getByTestId('es-explorer').locator('.esx-row.head', { hasText: 'Security' }).click()
  await tree(page, 'Internal users').click()
  const sec = page.getByTestId('os-security')
  await expect(sec.getByTestId('os-users')).toContainText('admin')
  // effective roles come through role mappings (analyst → orders_reader via backend role)
  await expect(sec.getByTestId('os-users').locator('tr', { hasText: 'analyst' })).toContainText('orders_reader')

  await sec.getByRole('button', { name: 'Create user' }).click()
  const dlg = page.getByRole('dialog', { name: 'Create user' })
  await dlg.getByLabel('User name').fill('maria')
  await dlg.getByLabel('Password', { exact: true }).fill('weakpass')
  await dlg.getByLabel('Confirm password').fill('weakpass')
  await dlg.getByRole('button', { name: 'Create user' }).click()
  await expect(dlg.getByRole('alert')).toContainText('Weak password')
  await dlg.getByRole('button', { name: 'Generate a strong password' }).click()
  await dlg.locator('label', { hasText: 'orders_reader' }).click()
  await dlg.getByRole('button', { name: 'Create user' }).click()
  await expect(dlg).toHaveCount(0)
  await expect(sec.getByTestId('os-users').locator('tr', { hasText: 'maria' })).toContainText('orders_reader')

  // built-in roles open read-only
  await sec.getByRole('tab', { name: /Roles/ }).click()
  await sec.getByTestId('os-roles').locator('tr', { hasText: 'all_access' }).getByRole('button', { name: 'View' }).click()
  const role = page.getByRole('dialog', { name: /all_access/ })
  await expect(role.getByText('built-in — read only')).toBeVisible()
  await expect(role.getByRole('button', { name: 'Save role' })).toHaveCount(0)
  await role.getByRole('button', { name: 'Close' }).click()

  // a role with a broken DLS query is not sent
  await sec.getByRole('button', { name: 'Create role' }).click()
  const nr = page.getByRole('dialog', { name: 'Create role' })
  await nr.getByLabel('Role name').fill('broken')
  await nr.getByLabel('Index patterns 1').fill('orders')
  await nr.locator('summary').first().click()
  await nr.locator('textarea').first().fill('{not json')
  await nr.getByRole('button', { name: 'Create role' }).click()
  await expect(nr.getByRole('alert')).toContainText('not valid JSON')
  await nr.getByRole('button', { name: 'Cancel' }).click()
  expect(errors).toEqual([])
})

test('alerting: create a monitor (generated id) and edit it', async ({ page }) => {
  const errors = await open(page)
  await openConnection(page)
  await tree(page, 'Alerting monitors').click()
  const m = page.getByTestId('es-manage')
  await expect(m.getByRole('option', { name: /Payment errors/ })).toBeVisible()
  await m.getByRole('button', { name: 'Create monitor' }).first().click()
  await page.getByRole('dialog').getByLabel('Name').fill('slow-checkout')
  await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click()
  await expect(m.getByText('POST /_plugins/_alerting/monitors')).toBeVisible()
  await m.getByRole('button', { name: 'Create monitor' }).last().click()
  const row = m.getByRole('option', { name: /slow-checkout/ })
  await expect(row).toBeVisible()
  await row.click()
  // existing monitor: addressed by its generated id
  await expect(m.getByText(/PUT \/_plugins\/_alerting\/monitors\/mon-/)).toBeVisible()
  await m.getByRole('button', { name: 'Run now (dry run)' }).click()
  await expect(m.getByTestId('es-action-result')).toContainText('OK')
  expect(errors).toEqual([])
})
