import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// "Objects" tab — the pinned, non-closable singleton at index 0 listing a schema's
// tables (# · Table Name · Data Length · Rows). For schema-based systems (PG/MSSQL)
// it opens by double-clicking a SCHEMA (scoped to it) — NOT the database node.
// Schema-as-database systems (MySQL/MariaDB/ClickHouse) open it via their database.

async function openPg(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
}

test('Objects tab: double-click a schema opens the pinned singleton scoped to it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openPg(page)

  // double-click the "public" schema → Objects scoped to that schema
  await page.getByRole('treeitem', { name: /public/ }).first().dblclick()
  await page.waitForTimeout(700)

  // pinned at index 0, titled "Objects"
  await expect(page.getByRole('tab').first()).toContainText('Objects')
  // header shows connection / database / schema
  await expect(page.getByTitle(/Postgres \/ .+ \/ public/)).toBeVisible()

  // 4-column grid + demo data; views excluded from the Objects grid
  await expect(page.getByRole('columnheader', { name: '#', exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Table Name' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Data Length' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Rows', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'students', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: '1.1 MB' })).toBeVisible() // students = 1114112 bytes
  await expect(page.getByRole('cell', { name: '3,842' })).toBeVisible() // students rows
  await expect(page.getByRole('cell', { name: 'vw_active_students', exact: true })).toHaveCount(0)

  // clicking a row selects it (blue) — aria-selected reflects the selection
  const studentsRow = page.getByRole('row').filter({ hasText: 'students' }).first()
  await studentsRow.click()
  await expect(studentsRow).toHaveAttribute('aria-selected', 'true')

  // right-click a row shows the FULL relational table context menu (rule chung)
  await page.getByRole('cell', { name: 'students', exact: true }).click({ button: 'right' })
  for (const item of ['Open Data', 'Design Table', 'Generate SQL', 'Manage Indexes & FKs…', 'Copy DDL', 'Truncate', 'Drop']) {
    await expect(page.getByRole('menuitem', { name: item, exact: true })).toBeVisible()
  }
  await page.keyboard.press('Escape')

  // the Objects tab has NO close (×) button
  const objTab = page.getByRole('tab').filter({ hasText: 'Objects' }).first()
  await expect(objTab.getByTitle('Close (Ctrl+W)')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Objects tab: double-clicking the DATABASE node does NOT open Objects (PG)', async ({ page }) => {
  await openPg(page)

  // double-clicking the current-database header only collapses/expands it — it must
  // NOT open an all-schemas Objects tab
  await page.getByRole('treeitem', { name: /current/ }).first().dblclick()
  await page.waitForTimeout(500)
  await expect(page.getByRole('tab').filter({ hasText: 'Objects' })).toHaveCount(0)
  await openDatabaseNode(page) // that dblclick collapsed it — reopen to reach the schemas

  // …but double-clicking a schema DOES open it (scoped to the schema)
  await page.getByRole('treeitem', { name: /public/ }).first().dblclick()
  await page.waitForTimeout(600)
  await expect(page.getByRole('tab').filter({ hasText: 'Objects' })).toHaveCount(1)
  await expect(page.getByRole('tab').first()).toContainText('Objects')
})

test('Objects tab: Refresh re-queries the backend', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openPg(page)

  await page.getByRole('treeitem', { name: /public/ }).first().dblclick()
  await page.waitForTimeout(700)
  await expect(page.getByRole('cell', { name: 'students', exact: true })).toBeVisible()

  // clicking Refresh must fire another list_tables call (genuine re-fetch, no cache)
  const before = await page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.list_tables ?? 0)
  await page.getByRole('button', { name: 'Refresh objects' }).click()
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.list_tables ?? 0)
  expect(after).toBeGreaterThan(before)

  await expect(page.getByRole('cell', { name: 'students', exact: true })).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
