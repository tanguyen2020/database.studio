import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// ScyllaDB = a flavor of the Cassandra engine (SPEC-SCYLLADB.md): its own card in
// the picker, its own logo / sidebar band, a CDC log shown under its base table,
// the tablets/vnodes mode on the keyspace, and ScyllaDB's own CQL words in the
// editor. The demo connection is opt-in (`?scylla=1`) so every other spec keeps
// its connection list.

async function open(page: Page, scylla = true) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  if (scylla) url.searchParams.set('scylla', '1')
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  return errors
}

const treeRow = (page: Page, name: string | RegExp) => page.getByRole('treeitem').filter({ hasText: name })

test('picker has a ScyllaDB card that opens a Cassandra-engine form wearing the ScyllaDB brand', async ({ page }) => {
  const errors = await open(page, false)
  await page.getByTitle('New connection').first().click()
  const card = page.locator('.picker-card[title="ScyllaDB"]')
  await expect(card).toBeVisible()
  await expect(card.locator('svg[data-logo="scylladb"]')).toBeVisible()
  // the plain Cassandra card is still there and still Cassandra
  await expect(page.locator('.picker-card[title="Cassandra"] svg[data-logo="cassandra"]')).toBeVisible()
  // search finds it
  await page.getByLabel('Search database types').fill('scylla')
  await expect(page.locator('.picker-card')).toHaveCount(1)
  await card.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('New connection', { exact: true })).toBeVisible()
  await expect(dialog.locator('.cm-tile svg[data-logo="scylladb"]')).toBeVisible()
  await expect(dialog.locator('.cm-subtitle')).toContainText('ScyllaDB')
  await expect(dialog.getByRole('radio', { name: 'ScyllaDB' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('radio', { name: 'Apache Cassandra' })).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.getByPlaceholder('datacenter1')).toBeVisible()
  // picking Apache Cassandra switches the brand in place
  await dialog.getByRole('radio', { name: 'Apache Cassandra' }).click()
  await expect(dialog.locator('.cm-tile svg[data-logo="cassandra"]')).toBeVisible()
  await expect(dialog.locator('.cm-subtitle')).toContainText('Cassandra')
  expect(errors).toEqual([])
})

test('picking Cassandra opens the form with Apache Cassandra already chosen', async ({ page }) => {
  const errors = await open(page, false)
  await page.getByTitle('New connection').first().click()
  await page.locator('.picker-card[title="Cassandra"]').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('radio', { name: 'Apache Cassandra' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('radio', { name: 'ScyllaDB' })).toHaveAttribute('aria-checked', 'false')
  // switching engines keeps exactly one card chosen
  await dialog.getByRole('radio', { name: 'ScyllaDB' }).click()
  await expect(dialog.getByRole('radio', { name: 'ScyllaDB' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('radio', { name: 'Apache Cassandra' })).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.locator('.cm-tile svg[data-logo="scylladb"]')).toBeVisible()
  expect(errors).toEqual([])
})

test('an existing Cassandra connection opens its edit form with Apache Cassandra chosen', async ({ page }) => {
  const errors = await open(page, false)
  // the demo Cassandra profile has no detected flavor yet
  await page.getByRole('button', { name: /Profiles Cassandra/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Edit/ }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('radio', { name: 'Apache Cassandra' })).toHaveAttribute('aria-checked', 'true')
  expect(errors).toEqual([])
})

test('a ScyllaDB connection gets its own sidebar band and logo; Cassandra keeps its own', async ({ page }) => {
  const errors = await open(page)
  const band = page.locator('.grp-head', { hasText: 'ScyllaDB' })
  await expect(band).toBeVisible()
  await expect(band.locator('svg[data-logo="scylladb"]')).toBeVisible()
  await expect(band.locator('.grp-count')).toHaveText('1')
  const cass = page.locator('.grp-head', { hasText: 'Cassandra' })
  await expect(cass.locator('svg[data-logo="cassandra"]')).toBeVisible()
  await expect(cass.locator('.grp-count')).toHaveText('1')
  // the ScyllaDB band comes right after the Cassandra one
  const order = await page.locator('.grp-label').allTextContents()
  expect(order.indexOf('ScyllaDB')).toBe(order.indexOf('Cassandra') + 1)
  expect(errors).toEqual([])
})

test('explorer: CDC log sits under its base table, keyspace shows vnodes/tablets', async ({ page }) => {
  const errors = await open(page)
  await page.getByRole('button', { name: /Orders ScyllaDB/ }).dblclick()
  await expect(page.locator('svg[data-logo="scylladb"]').first()).toBeVisible()
  await treeRow(page, 'campus_ks').first().dblclick()
  // replication and data distribution read in plain words, not raw CQL maps
  const repl = treeRow(page, 'Replication').first()
  await expect(repl).toContainText('3 copies')
  await expect(repl).toHaveAttribute('title', /3 copies in datacenter1/)
  await expect(treeRow(page, 'Distribution').first()).toContainText('Token ring')

  await treeRow(page, /^\s*Tables/).first().dblclick()
  // the CDC log is NOT a top-level table: the folder counts 2 (orders, page_hits)
  await expect(treeRow(page, /^\s*Tables/).first()).toContainText('2')
  await expect(treeRow(page, 'orders_scylla_cdc_log')).toHaveCount(0)
  const orders = treeRow(page, /^\s*orders\s*change log/).first()
  await expect(orders).toBeVisible()
  // Properties names the object — never the raw tree key
  await orders.click()
  await expect(page.getByText('keyspace: campus_ks')).toBeVisible()
  await expect(page.getByText('t:campus_ks:orders')).toHaveCount(0)
  // the chevron expands a table (a double-click opens its data)
  await orders.locator('span[role="button"]').first().click()
  const log = treeRow(page, 'Change log (CDC)').first()
  await expect(log).toHaveAttribute('title', /orders_scylla_cdc_log/)
  // the log has the usual table actions
  await log.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'View DDL (CQL)' })).toBeVisible()
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

/** Colour of the first span whose text is `word`, and the keyword token colour. */
async function paint(page: Page, word: string) {
  return page.evaluate((w) => {
    const spans = [...document.querySelectorAll('[data-tab-pane][data-active="true"] .view-lines span')]
    const hit = spans.find((s) => s.textContent?.trim() === w)
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;left:-9999px;color:var(--syntax-keyword)'
    document.body.appendChild(probe)
    const keyword = getComputedStyle(probe).color
    probe.remove()
    return { color: hit ? getComputedStyle(hit).color : null, keyword }
  }, word)
}

async function typeCql(page: Page, host: string, cql: string) {
  await page.getByText(host, { exact: false }).first().click({ button: 'right' })
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(700)
  await page.locator('[data-tab-pane][data-active="true"] .view-lines').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(cql)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
}

test('editor: BYPASS CACHE is a keyword on ScyllaDB, not on Cassandra', async ({ page }) => {
  const errors = await open(page)
  await typeCql(page, '10.0.5.9', 'SELECT * FROM orders BYPASS CACHE')
  // the tab wears the ScyllaDB logo
  await expect(page.getByRole('tab', { selected: true }).locator('svg[data-logo="scylladb"]')).toBeVisible()
  const sc = await paint(page, 'BYPASS')
  expect(sc.color, 'BYPASS was not tokenized on its own').toBe(sc.keyword)

  await typeCql(page, '10.0.5.3', 'SELECT * FROM orders BYPASS CACHE')
  await expect(page.getByRole('tab', { selected: true }).locator('svg[data-logo="cassandra"]')).toBeVisible()
  const cs = await page.evaluate(() => {
    const pane = document.querySelector('[data-tab-pane][data-active="true"]')!
    const hit = [...pane.querySelectorAll('.view-lines span')].find((s) => s.textContent?.trim() === 'BYPASS')
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;left:-9999px;color:var(--syntax-keyword)'
    document.body.appendChild(probe)
    const keyword = getComputedStyle(probe).color
    probe.remove()
    return { color: hit ? getComputedStyle(hit).color : null, keyword }
  })
  expect(cs.color, 'Cassandra must not paint a ScyllaDB-only word as a keyword').not.toBe(cs.keyword)
  expect(errors).toEqual([])
})
