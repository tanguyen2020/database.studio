import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, previewText } from './helpers'

// Elasticsearch — Kibana-style workspace over the REST API. Runs against the
// stateful in-memory cluster (src/lib/elastic/demo.ts), enabled with
// `?elasticsearch=1` so the connection list of every other spec stays as it is.

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  const url = new URL(APP_URL)
  url.searchParams.set('elasticsearch', '1')
  await page.goto(url.toString())
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.getByRole('button', { name: /Elasticsearch 10\.0\.12\.7:9200/ }).click()
  await expect(page.getByTestId('es-summary')).toContainText('Elasticsearch 8.15.3', { timeout: 8000 })
  return errors
}

const tree = (page: Page, name: string | RegExp) => page.getByTestId('es-explorer').getByRole('treeitem').filter({ hasText: name })

/** Replace the console text and put the caret on a line (1-based). */
async function setConsole(page: Page, text: string, line: number) {
  await page.waitForFunction(() => !!(window as unknown as { __esConsole?: unknown }).__esConsole)
  await page.evaluate(
    ([t, l]) => {
      const ed = (window as unknown as { __esConsole: { setValue(v: string): void; setPosition(p: { lineNumber: number; column: number }): void; focus(): void } }).__esConsole
      ed.setValue(t as string)
      ed.setPosition({ lineNumber: l as number, column: 1 })
      ed.focus()
    },
    [text, line],
  )
}

test('elasticsearch: official logo, explorer tree, health, no SQL tab on connect', async ({ page }) => {
  const errors = await open(page)
  // the connection icon is the official Elastic UI asset, not a redrawn mark
  await expect(page.locator('svg.sys-es-logo path[fill="#FEC514"]').first()).toBeAttached()
  await expect(page.locator('svg.sys-es-logo path[fill="#00BFB3"]').first()).toBeAttached()
  await expect(page.getByTestId('es-health')).toHaveText('Warning')
  await expect(tree(page, 'orders').first()).toContainText('240')
  await expect(tree(page, 'archive-2023')).toContainText('closed')
  // hidden / system and backing indices only with "Hidden"
  await expect(tree(page, '.kibana_8.15.3_001')).toHaveCount(0)
  await page.getByRole('checkbox', { name: /Hidden/ }).click()
  await expect(tree(page, '.kibana_8.15.3_001')).toHaveCount(1)
  await page.getByRole('checkbox', { name: /Hidden/ }).click()
  await expect(tree(page, 'logs-app-default')).toBeVisible()
  // filter
  await page.getByLabel('Filter indices').fill('prod')
  await expect(tree(page, 'products')).toBeVisible()
  await expect(tree(page, 'orders')).toHaveCount(0)
  await page.getByLabel('Filter indices').fill('')
  // glyphs come from EUI (data-eui = original file name)
  await expect(page.getByTestId('es-explorer').locator('svg[data-eui="index"]').first()).toBeAttached()
  // connecting opens no SQL tab
  await expect(page.getByRole('tab', { name: /Untitled/ })).toHaveCount(0)
  // the connection context menu offers the ES tools
  await page.getByRole('button', { name: /Elasticsearch 10\.0\.12\.7:9200/ }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Dev Tools Console' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'New ES|QL Query' })).toBeVisible()
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

test('elasticsearch: Discover — KQL, filters, top values, sort, paging, document CRUD', async ({ page }) => {
  const errors = await open(page)
  await tree(page, 'orders').first().click()
  const view = page.getByTestId('es-index-view')
  await expect(view.getByTestId('es-hits')).toContainText('240 hits')
  // histogram + field list with EUI tokens
  await expect(view.getByRole('img', { name: 'Hits over time' })).toBeVisible()
  await expect(view.getByLabel('Fields').locator('[data-type="keyword"] svg[data-eui="token_keyword"]').first()).toBeAttached()

  // KQL
  const q = view.getByLabel('Search query')
  await q.fill('status:paid and amount >= 100')
  await q.press('Enter')
  const paid = Number((await view.getByTestId('es-hits').textContent())!.replace(/\D/g, ''))
  expect(paid).toBeGreaterThan(0)
  expect(paid).toBeLessThan(240)
  // bad KQL is reported, not sent
  await q.fill('status:')
  await q.press('Enter')
  await expect(view.getByRole('alert')).toContainText('KQL syntax error')
  await q.fill('')
  await q.press('Enter')
  await expect(view.getByTestId('es-hits')).toContainText('240 hits')

  // top values → filter for a value
  await view.getByLabel('Fields').getByRole('button', { name: 'status', exact: true }).click()
  await expect(view.getByTestId('es-top-values')).toContainText('paid')
  await view.getByRole('button', { name: 'Filter for paid' }).click()
  await expect(view.getByText('status: paid')).toBeVisible()
  const onlyPaid = Number((await view.getByTestId('es-hits').textContent())!.replace(/\D/g, ''))
  expect(onlyPaid).toBeLessThan(240)
  // invert, then remove
  await view.getByRole('button', { name: 'Invert filter' }).click()
  await expect(view.getByText('NOT status: paid')).toBeVisible()
  const notPaid = Number((await view.getByTestId('es-hits').textContent())!.replace(/\D/g, ''))
  expect(onlyPaid + notPaid).toBe(240)
  await view.getByRole('button', { name: /Remove filter/ }).click()
  await expect(view.getByTestId('es-hits')).toContainText('240 hits')

  // columns + sort
  await view.getByRole('button', { name: 'Add column amount' }).click()
  await view.locator('th', { hasText: 'amount' }).click()
  const first = Number(await view.getByTestId('es-doc-grid').locator('tbody tr').first().locator('td').nth(2).textContent())
  const second = Number(await view.getByTestId('es-doc-grid').locator('tbody tr').nth(1).locator('td').nth(2).textContent())
  expect(first).toBeGreaterThanOrEqual(second)

  // paging
  await expect(view.getByTestId('es-range')).toHaveText('1–50 of 240')
  await view.getByRole('button', { name: 'Next page' }).click()
  await expect(view.getByTestId('es-range')).toHaveText('51–100 of 240')

  // add a document
  await view.getByRole('button', { name: 'Add document' }).click()
  const fly = page.getByRole('dialog', { name: 'New document' })
  await fly.getByLabel(/Document id/).fill('e2e-1')
  await page.evaluate(() => {
    const v = (window as unknown as { __dsViews: { getModel(): { getValue(): string }; setValue(t: string): void }[] }).__dsViews
    v[v.length - 1].setValue('{"order_id":"E2E","status":"paid","amount":1}')
  })
  await fly.getByRole('button', { name: 'Add document' }).click()
  await expect(fly).toHaveCount(0)
  await expect(view.getByTestId('es-hits')).toContainText('241 hits')

  // find it, edit it, delete it
  await q.fill('order_id:E2E')
  await q.press('Enter')
  await expect(view.getByTestId('es-hits')).toContainText('1 hits')
  await view.getByRole('button', { name: 'Inspect document e2e-1' }).click()
  const doc = page.getByRole('dialog', { name: 'Document' })
  await expect(doc.getByTestId('es-doc-table')).toContainText('E2E')
  await doc.getByRole('button', { name: 'Edit' }).click()
  await page.evaluate(() => {
    const v = (window as unknown as { __dsViews: { setValue(t: string): void }[] }).__dsViews
    v[v.length - 1].setValue('{"order_id":"E2E","status":"refunded","amount":2}')
  })
  await doc.getByRole('button', { name: 'Save document' }).click()
  await expect(doc).toHaveCount(0)
  await view.getByRole('button', { name: 'Inspect document e2e-1' }).click()
  await expect(page.getByRole('dialog', { name: 'Document' }).getByTestId('es-doc-table')).toContainText('refunded')
  await page.getByRole('dialog', { name: 'Document' }).getByRole('button', { name: 'Delete document' }).click()
  await page.getByRole('dialog', { name: /Delete document/ }).getByRole('button', { name: 'Delete document' }).click()
  await expect(view.getByTestId('es-hits')).toContainText('0 hits')
  await expect(view.getByText('No results match your search criteria')).toBeVisible()
  expect(errors).toEqual([])
})

test('elasticsearch: create index → mappings, settings, aliases, stats, close/open, delete', async ({ page }) => {
  const errors = await open(page)
  await page.getByTestId('es-explorer').getByRole('button', { name: 'Index' }).click()
  const dlg = page.getByRole('dialog', { name: 'Create index' })
  await dlg.getByLabel('Index name').fill('Bad Name')
  await expect(dlg.getByText('Index names must be lowercase')).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Create index' })).toBeDisabled()
  await dlg.getByLabel('Index name').fill('e2e-books')
  await dlg.getByLabel('Field name 2').fill('title')
  await dlg.getByLabel('Field type 2').selectOption('text')
  await dlg.getByLabel('Replicas').fill('0')
  await expect.poll(() => previewText(page, 'Create index request')).toContain('"number_of_replicas": 0')
  await dlg.getByRole('button', { name: 'Create index' }).click()
  const view = page.getByTestId('es-index-view')
  await expect(view.locator('.es-title')).toHaveText('e2e-books')
  await expect(tree(page, 'e2e-books')).toBeVisible()
  await expect(view.getByTestId('es-index-health')).toHaveText(/Healthy/)

  // mappings: text got a .keyword multi-field; add a field; type change refused
  await view.getByRole('tab', { name: 'Mappings' }).click()
  await expect(view.getByTestId('es-mapping-table')).toContainText('title.keyword')
  await view.getByLabel('New field name').fill('pages')
  await view.getByLabel('New field type').selectOption('integer')
  await view.getByRole('button', { name: 'Add field' }).click()
  await expect(view.getByTestId('es-mapping-table')).toContainText('pages')

  // settings
  await view.getByRole('tab', { name: 'Settings' }).click()
  await view.getByLabel('Refresh interval').fill('30s')
  await view.getByRole('button', { name: 'Save settings' }).click()
  await expect(view.getByTestId('es-settings-table')).toContainText('30s')

  // aliases
  await view.getByRole('tab', { name: 'Aliases' }).click()
  await view.getByLabel('Alias name').fill('books-current')
  await view.getByRole('button', { name: 'Add alias' }).click()
  await expect(view.getByRole('cell', { name: 'books-current' }).first()).toBeVisible()
  await view.getByRole('button', { name: 'Remove alias books-current' }).click()
  await expect(view.getByText('No aliases point at this index.')).toBeVisible()

  // stats
  await view.getByRole('tab', { name: 'Statistics' }).click()
  await expect(view.getByTestId('es-index-stats')).toContainText('Documents')

  // close → open
  await view.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('dialog', { name: /Close index/ }).getByRole('button', { name: 'Close index' }).click()
  await expect(view.getByTestId('es-index-health')).toHaveText(/Closed/)
  await view.getByRole('button', { name: 'Open index' }).click()
  await expect(view.getByTestId('es-index-health')).toHaveText(/Healthy/)

  // delete needs the name typed
  await view.getByRole('button', { name: 'Delete' }).click()
  const del = page.getByRole('dialog', { name: /Delete index e2e-books/ })
  await expect(del.getByRole('button', { name: 'Delete' })).toBeDisabled()
  await del.getByLabel(/to confirm/).fill('e2e-books')
  await del.getByRole('button', { name: 'Delete' }).click()
  await expect(tree(page, 'e2e-books')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('elasticsearch: Dev Tools console — run at caret, bulk NDJSON, errors, variables, cURL', async ({ page }) => {
  const errors = await open(page)
  await page.getByTestId('es-explorer').getByRole('button', { name: 'Console' }).click()
  const c = page.getByTestId('es-console')
  await setConsole(page, 'GET _cluster/health\n\nGET /orders/_count\n', 3)
  await c.getByRole('button', { name: 'Send request' }).click()
  await expect(c.getByTestId('es-status-badge')).toHaveText(/200/)
  await expect.poll(() => previewText(page, 'Console response')).toContain('"count": 240')

  // bulk spread over lines → NDJSON
  await setConsole(page, 'POST _bulk\n{ "index": { "_index": "e2e-log" } }\n{ "msg": "a" }\n{ "index": { "_index": "e2e-log" } }\n{ "msg": "b" }\n', 1)
  await page.keyboard.press('Control+Enter')
  await expect(c.getByTestId('es-status-badge')).toHaveText(/200/)
  await expect.poll(() => previewText(page, 'Console response')).toContain('"errors": false')

  // an error document is shown (not thrown)
  await setConsole(page, 'GET /missing/_search\n', 1)
  await page.keyboard.press('Control+Enter')
  await expect(c.getByTestId('es-status-badge')).toHaveText(/404/)
  await expect.poll(() => previewText(page, 'Console response')).toContain('index_not_found_exception')

  // variables
  await c.getByRole('button', { name: /Variables/ }).click()
  await c.getByRole('button', { name: 'Add variable' }).click()
  await c.getByLabel('Variable name 1').fill('idx')
  await c.getByLabel('Variable value 1').fill('products')
  await setConsole(page, 'GET /${idx}/_count\n', 1)
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => previewText(page, 'Console response')).toContain('"count": 6')

  // _cat text output, a selection runs every request it touches
  await setConsole(page, 'GET _cat/indices?v\nGET _cluster/health\n', 1)
  await page.evaluate(() => {
    const ed = (window as unknown as { __esConsole: { setSelection(r: object): void } }).__esConsole
    ed.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 5 })
  })
  await c.getByRole('button', { name: 'Send request' }).click()
  await expect.poll(() => previewText(page, 'Console response')).toContain('# GET /_cat/indices?v 200')
  await expect.poll(() => previewText(page, 'Console response')).toContain('# GET /_cluster/health 200')

  // history
  await c.getByRole('button', { name: 'History' }).click()
  await expect(c.getByText('/_cluster/health').first()).toBeVisible()
  expect(errors).toEqual([])
})

test('elasticsearch: Stack Management — templates, pipelines (simulate), snapshots (take/restore)', async ({ page }) => {
  const errors = await open(page)
  await tree(page, 'Index templates').click()
  const m = page.getByTestId('es-manage')
  await expect(m.getByRole('option', { name: /logs-app/ })).toBeVisible()
  await m.getByRole('button', { name: 'Create index template' }).click()
  await page.getByLabel('Name').fill('e2e-tpl')
  await page.getByRole('button', { name: 'Continue' }).click()
  await m.getByRole('button', { name: 'Create index template' }).last().click()
  await expect(m.getByRole('option', { name: /e2e-tpl/ })).toBeVisible()
  await m.getByRole('button', { name: 'Preview' }).click()
  await expect(m.getByTestId('es-action-result')).toBeVisible()
  await m.getByRole('button', { name: 'Delete index template' }).click()
  await page.getByRole('dialog', { name: /Delete index template/ }).getByRole('button', { name: 'Delete' }).click()
  await expect(m.getByRole('option', { name: /e2e-tpl/ })).toHaveCount(0)

  // ingest pipeline simulate
  await tree(page, 'Ingest pipelines').click()
  await m.getByRole('option', { name: /orders-enrich/ }).click()
  await m.getByRole('button', { name: 'Simulate' }).click()
  await expect.poll(() => previewText(page, 'Simulate result')).toContain('"status": "paid"')

  // snapshots
  await tree(page, 'Snapshot repositories').click()
  await m.getByRole('option', { name: /nightly/ }).click()
  await expect(m.getByTestId('es-snapshots')).toContainText('snap-2026.10.14')
  await m.getByRole('button', { name: 'Take snapshot' }).click()
  await m.getByLabel('Snapshot name').fill('e2e-snap')
  await m.getByLabel('Snapshot indices').fill('products')
  await m.getByRole('button', { name: 'Take', exact: true }).click()
  await expect(m.getByTestId('es-snapshots')).toContainText('e2e-snap')
  expect(errors).toEqual([])
})

test('elasticsearch: cluster pages, ES|QL + SQL (translate), security users / API keys', async ({ page }) => {
  const errors = await open(page)
  await tree(page, 'Cluster').first().click()
  await tree(page, 'Overview').click()
  const cl = page.getByTestId('es-cluster')
  await expect(cl.getByTestId('es-cluster-stats')).toContainText('Unassigned shards')
  await cl.getByRole('tab', { name: 'Nodes' }).click()
  await expect(cl.getByTestId('es-nodes')).toContainText('es-node-1')
  await cl.getByRole('tab', { name: 'Shards & allocation' }).click()
  await cl.getByRole('button', { name: 'Why?' }).first().click()
  await expect(cl.getByText('Allocation explanation')).toBeVisible()
  await cl.getByRole('tab', { name: 'Tasks' }).click()
  await cl.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('dialog', { name: 'Cancel task?' }).getByRole('button', { name: 'Cancel task' }).click()
  await expect(cl.getByText('No running tasks')).toBeVisible()

  // ES|QL
  await page.getByTestId('es-explorer').getByRole('button', { name: 'Query' }).click()
  const qv = page.getByTestId('es-query')
  await page.evaluate(() => {
    const v = (window as unknown as { __dsViews: { setValue(t: string): void }[] }).__dsViews
    v[v.length - 1].setValue('FROM orders | STATS n = COUNT(*) BY status | SORT n DESC | LIMIT 10')
  })
  await qv.getByRole('button', { name: 'Run query' }).click()
  await expect(qv.getByTestId('es-query-meta')).toContainText('rows · 2 columns')
  // SQL + translate
  await qv.getByRole('button', { name: 'SQL', exact: true }).click()
  await page.evaluate(() => {
    const v = (window as unknown as { __dsViews: { setValue(t: string): void }[] }).__dsViews
    v[v.length - 1].setValue("SELECT * FROM orders WHERE status = 'paid' LIMIT 5")
  })
  await qv.getByRole('button', { name: 'Run query' }).click()
  await expect(qv.getByTestId('es-query-meta')).toContainText('5 rows')
  await qv.getByRole('button', { name: 'Translate to Query DSL' }).click()
  await expect.poll(() => previewText(page, 'Translated Query DSL')).toContain('"term"')

  // security
  await tree(page, 'Security').first().click()
  await tree(page, 'Users').click()
  const sec = page.getByTestId('es-security')
  await expect(sec.getByTestId('es-users')).toContainText('analyst')
  await sec.getByRole('button', { name: 'Create user' }).click()
  const u = page.getByRole('dialog', { name: 'Create user' })
  await u.getByLabel('Username').fill('e2e_user')
  await u.getByRole('button', { name: 'Generate' }).click()
  await u.getByText('viewer', { exact: true }).click()
  await u.getByRole('button', { name: 'Create user' }).click()
  await expect(sec.getByTestId('es-users')).toContainText('e2e_user')
  await sec.getByRole('tab', { name: /API keys/ }).click()
  await sec.getByRole('button', { name: 'Create API key' }).click()
  await page.getByRole('dialog', { name: 'Create API key' }).getByLabel('Name').fill('e2e-key')
  await page.getByRole('dialog', { name: 'Create API key' }).getByRole('button', { name: 'Create API key' }).click()
  await expect(sec.getByTestId('es-new-key')).toContainText('e2e-key')
  await expect(sec.getByTestId('es-api-keys')).toContainText('e2e-key')
  expect(errors).toEqual([])
})

test('elasticsearch: connection form — auth methods and REST port hint', async ({ page }) => {
  const errors = await open(page)
  await page.getByRole('button', { name: /Elasticsearch 10\.0\.12\.7:9200/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Connection…' }).click()
  await expect(page.getByTestId('es-port-hint')).toContainText('REST API')
  const auth = page.getByLabel('Elasticsearch authentication')
  await expect(auth).toHaveValue('basic')
  await expect(page.getByText('User', { exact: true })).toBeVisible()
  await auth.selectOption('apikey')
  await expect(page.getByText('User', { exact: true })).toHaveCount(0)
  await expect(page.locator('.cm-label', { hasText: /^API key/ })).toBeVisible()
  await auth.selectOption('none')
  await expect(page.locator('.cm-label', { hasText: /^API key/ })).toHaveCount(0)
  // no Database field for Elasticsearch
  await expect(page.getByText('Database', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('elasticsearch: Dev Tools — Search Profiler, Grok Debugger, Painless Lab, Analyzer', async ({ page }) => {
  const errors = await open(page)
  await tree(page, 'Search Profiler').click()
  const dt = page.getByTestId('es-devtools')
  await dt.getByLabel('Index').fill('orders')
  await dt.getByRole('button', { name: 'Profile' }).click()
  await expect(dt.getByTestId('es-profile')).toContainText('MatchAllDocsQuery')

  await dt.getByRole('tab', { name: 'Grok Debugger' }).click()
  await dt.getByRole('button', { name: 'Simulate' }).click()
  await expect.poll(() => previewText(page, 'Grok output')).toContain('"client": "55.3.244.1"')
  await dt.getByLabel('Grok pattern').fill('%{WORD:only}')
  await dt.getByRole('button', { name: 'Simulate' }).click()
  await expect(dt.getByRole('alert')).toContainText('do not match')

  await dt.getByRole('tab', { name: 'Painless Lab' }).click()
  await dt.getByRole('button', { name: 'Run' }).click()
  await expect(dt.getByTestId('es-painless-result')).toContainText('43')

  await dt.getByRole('tab', { name: 'Analyzer' }).click()
  await dt.getByRole('button', { name: 'Analyze' }).click()
  await expect(dt.getByTestId('es-tokens')).toContainText('quick')
  expect(errors).toEqual([])
})

test('elasticsearch: index operations — inspect, reindex, clone, delete by query', async ({ page }) => {
  const errors = await open(page)
  await tree(page, 'products').click()
  const view = page.getByTestId('es-index-view')
  await expect(view.getByTestId('es-hits')).toContainText('6 hits')
  // Inspect the request Discover sent
  await view.getByRole('button', { name: 'Inspect', exact: true }).click()
  await expect.poll(() => previewText(page, 'Inspect request')).toContain('"track_total_hits": true')
  await page.getByRole('dialog', { name: 'Inspect' }).getByRole('button', { name: 'Response' }).click()
  await expect.poll(() => previewText(page, 'Inspect response')).toContain('"hits"')
  await page.getByRole('dialog', { name: 'Inspect' }).getByRole('button', { name: 'Close' }).click()

  // Clone (blocks writes, copies, lifts the block)
  await view.getByRole('button', { name: 'Manage index' }).click()
  await page.getByRole('menuitem', { name: 'Clone…' }).click()
  const clone = page.getByRole('dialog', { name: 'Clone index' })
  await expect.poll(() => previewText(page, 'Index operation request')).toContain('/products/_clone/products-clone')
  await clone.getByRole('button', { name: 'Clone index' }).click()
  await expect(tree(page, 'products-clone')).toBeVisible()
  const cv = page.getByTestId('es-index-view').filter({ has: page.locator('.es-title', { hasText: /^products-clone$/ }) })
  await expect(cv.getByTestId('es-hits')).toContainText('6 hits')

  // Delete by query on the clone: counts first, then deletes
  await cv.getByRole('button', { name: 'Manage index' }).click()
  await page.getByRole('menuitem', { name: 'Delete by query…' }).click()
  const dbq = page.getByRole('dialog', { name: 'Delete by query' })
  await dbq.getByLabel(/Documents matching/).fill('stock < 200')
  await expect(dbq.getByTestId('es-op-matched')).toBeVisible()
  const n = Number((await dbq.getByTestId('es-op-matched').textContent())!.replace(/\D/g, ''))
  await dbq.getByRole('button', { name: 'Delete by query' }).click()
  await expect(cv.getByTestId('es-hits')).toContainText(`${6 - n} hits`)

  // Reindex products → a new index
  const pv = page.getByTestId('es-index-view').filter({ has: page.locator('.es-title', { hasText: /^products$/ }) })
  await page.getByRole('tab', { name: /^products$/ }).click()
  await pv.getByRole('button', { name: 'Manage index' }).click()
  await page.getByRole('menuitem', { name: 'Reindex…' }).click()
  const ri = page.getByRole('dialog', { name: 'Reindex' })
  await ri.getByLabel('Destination index').fill('products-v2')
  await ri.getByRole('button', { name: 'Reindex' }).click()
  await expect(tree(page, 'products-v2')).toBeVisible()
  expect(errors).toEqual([])
})
