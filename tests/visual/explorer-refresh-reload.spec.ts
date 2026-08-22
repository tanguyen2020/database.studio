import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// The Explorer header "⟳ Refresh" must RELOAD the selected connection's data — every
// row that is on screen comes back from the server. It used to only re-read the schema
// LIST and drop each schema's children, so open folders went blank (and the database
// list was never re-read at all, because loadDatabases was called without `force`).
const counts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls ?? {})
const conns = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => (window as unknown as { __ipcConns?: Record<string, string[]> }).__ipcConns?.[c] ?? [],
    cmd,
  )

async function boot(page: Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
}

test('header Refresh re-reads the open schema, its tables and the database list', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  // open schema → Tables folder → a table's columns
  await page.getByRole('treeitem', { name: /public/ }).first().dblclick()
  await page.waitForTimeout(600)
  await page.getByRole('treeitem', { name: /Tables/ }).first().dblclick()
  await page.waitForTimeout(600)
  const students = page.getByRole('treeitem', { name: /students/ }).first()
  await students.getByRole('button').first().click() // chevron → columns
  await page.waitForTimeout(600)
  await expect(page.getByText('first_name').first()).toBeVisible()

  const before = await counts(page)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForTimeout(1500)
  const after = await counts(page)

  // the rows that were on screen are still there — Refresh RELOADS, never empties
  // (before the fix the schema's children were dropped: the Tables folder and its
  // rows vanished until the node was clicked again)
  await expect(page.getByRole('treeitem', { name: /Tables/ })).toHaveCount(1)
  await expect(page.getByRole('treeitem', { name: /students/ })).toHaveCount(1)
  await expect(page.getByText('first_name').first()).toBeVisible()

  // …and each of them came back from the server: schema list, database list,
  // the open schema's objects and the open table's detail
  expect(after.list_schemas ?? 0).toBeGreaterThan(before.list_schemas ?? 0)
  expect(after.list_databases ?? 0).toBeGreaterThan(before.list_databases ?? 0)
  expect(after.list_tables ?? 0).toBeGreaterThan(before.list_tables ?? 0)
  expect(after.list_columns ?? 0).toBeGreaterThan(before.list_columns ?? 0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('header Refresh also reloads an expanded foreign database (its own sub-connection)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  const foreign = page.getByRole('treeitem', { name: /analytics/ }).first()
  await foreign.dblclick() // attach + load its schemas
  await page.waitForTimeout(900)
  await page.getByRole('treeitem', { name: /reporting/ }).first().dblclick() // a schema of THAT database
  await page.waitForTimeout(700)
  await page.getByRole('treeitem', { name: /Tables/ }).last().dblclick()
  await page.waitForTimeout(700)
  await expect(page.getByRole('treeitem', { name: /report_daily/ }).first()).toBeVisible()

  const before = (await conns(page, 'list_tables')).filter((c) => c.includes('::analytics')).length
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForTimeout(1800)
  const after = (await conns(page, 'list_tables')).filter((c) => c.includes('::analytics')).length

  // the attached database was re-read over its own sub-connection, not skipped
  expect(after).toBeGreaterThan(before)
  await expect(page.getByRole('treeitem', { name: /report_daily/ }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('header Refresh keeps an expanded Cassandra keyspace loaded', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Profiles Cassandra/ }).dblclick()
  await page.waitForTimeout(700)
  await page.getByText('library_ks').first().dblclick() // NOT the default keyspace
  await page.waitForTimeout(400)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  const rows = await page.getByRole('treeitem').count()

  const before = await counts(page)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForTimeout(1200)

  // loadCass drops every keyspace subtree, so the open keyspace must be re-read
  expect((await counts(page)).cassandra_tree ?? 0).toBeGreaterThan(before.cassandra_tree ?? 0)
  await expect(page.getByText('library_ks').first()).toBeVisible()
  expect(await page.getByRole('treeitem').count()).toBe(rows) // nothing collapsed away

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('header Refresh keeps the MongoDB tree open and re-reads it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  await page.getByRole('button', { name: /Events MongoDB/ }).first().click()
  await page.waitForTimeout(1100)
  await page.getByText('analytics', { exact: true }).first().dblclick() // a NON-default database
  await page.waitForTimeout(700)
  const open = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('span,div')].find((e) => e.textContent?.trim() === 'analytics')
      let p: Element | null = el ?? null
      for (let i = 0; i < 4 && p; i++) {
        p = p.parentElement
        if (p?.textContent?.includes('▾') || p?.textContent?.includes('▸')) break
      }
      return !!p?.textContent?.includes('▾')
    })
  expect(await open()).toBe(true)

  const before = await counts(page)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForTimeout(1600)

  // re-read from the server AND still open (it used to collapse the whole tree)
  expect((await counts(page)).list_databases ?? 0).toBeGreaterThan(before.list_databases ?? 0)
  expect((await counts(page)).list_tables ?? 0).toBeGreaterThan(before.list_tables ?? 0)
  expect(await open()).toBe(true)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
