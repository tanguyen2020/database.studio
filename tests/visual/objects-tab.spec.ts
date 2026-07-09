import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// "Objects" tab — double-clicking a database name in the Explorer opens a pinned,
// non-closable singleton tab at index 0 that lists the database's tables in a
// 3-column grid (Table Name · Data Length · Rows). The double-click must ALSO keep
// the original expand/collapse behavior, and double-clicking another database only
// refreshes the same tab (no second Objects tab).

test('Objects tab: double-click database opens pinned singleton at index 0', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)

  // regression: double-clicking a database still expands it (a second "public" appears)
  const foreign = page.getByRole('treeitem', { name: /analytics/ }).first()
  await expect(foreign).toBeVisible()
  const before = await page.getByRole('treeitem', { name: /public/ }).count()
  await foreign.dblclick()
  await page.waitForTimeout(800)
  expect(await page.getByRole('treeitem', { name: /public/ }).count()).toBeGreaterThan(before)

  // the Objects tab opened, pinned at index 0, titled "Objects"
  const firstTab = page.getByRole('tab').first()
  await expect(firstTab).toContainText('Objects')

  // 4-column grid with the expected headers (# + Table Name + Data Length + Rows)
  await expect(page.getByRole('columnheader', { name: '#', exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Table Name' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Data Length' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Rows', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'students', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: '1.1 MB' })).toBeVisible() // students = 1114112 bytes
  await expect(page.getByRole('cell', { name: '3,842' })).toBeVisible() // students rows
  // views are excluded from the Objects grid
  await expect(page.getByRole('cell', { name: 'vw_active_students', exact: true })).toHaveCount(0)

  // subtitle shows the target database
  await expect(page.getByTitle('Postgres / analytics')).toBeVisible()

  // clicking a row selects it (blue) — aria-selected reflects the selection
  const studentsRow = page.getByRole('row').filter({ hasText: 'students' }).first()
  await studentsRow.click()
  await expect(studentsRow).toHaveAttribute('aria-selected', 'true')

  // right-click a row shows the FULL relational table context menu (rule chung)
  await page.getByRole('cell', { name: 'students', exact: true }).click({ button: 'right' })
  for (const item of ['Open Data', 'Design Table', 'Generate SQL · SELECT', 'Manage Indexes & FKs…', 'Copy DDL', 'Truncate', 'Drop']) {
    await expect(page.getByRole('menuitem', { name: item, exact: true })).toBeVisible()
  }
  await page.keyboard.press('Escape')

  // the Objects tab has NO close (×) button
  const objTab = page.getByRole('tab').filter({ hasText: 'Objects' }).first()
  await expect(objTab.getByTitle('Close (Ctrl+W)')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Objects tab: double-clicking another database refreshes the same singleton tab', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)

  // open Objects for the foreign database
  await page.getByRole('treeitem', { name: /analytics/ }).first().dblclick()
  await page.waitForTimeout(600)
  await expect(page.getByTitle('Postgres / analytics')).toBeVisible()
  const objTabsBefore = await page.getByRole('tab').filter({ hasText: 'Objects' }).count()
  expect(objTabsBefore).toBe(1)

  // double-click the current-database header → retarget the SAME tab (content refresh)
  await page.getByRole('treeitem', { name: /current/ }).first().dblclick()
  await page.waitForTimeout(600)
  await expect(page.getByTitle(/Postgres \/ (app|sis_prod)/)).toBeVisible()

  // still exactly one Objects tab, still at index 0
  expect(await page.getByRole('tab').filter({ hasText: 'Objects' }).count()).toBe(1)
  await expect(page.getByRole('tab').first()).toContainText('Objects')
})

test('Objects tab: double-click a schema (PG) scopes Objects to that schema', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)

  // Postgres splits a database into schemas → double-clicking the "public" schema
  // node opens the Objects tab scoped to that schema (not the whole database).
  await page.getByRole('treeitem', { name: /public/ }).first().dblclick()
  await page.waitForTimeout(700)

  const firstTab = page.getByRole('tab').first()
  await expect(firstTab).toContainText('Objects')
  // header shows connection / database / schema
  await expect(page.getByTitle(/Postgres \/ .+ \/ public/)).toBeVisible()
  await expect(page.getByRole('cell', { name: 'students', exact: true })).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('Objects tab: Refresh re-queries the backend', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByRole('treeitem', { name: /analytics/ }).first().dblclick()
  await page.waitForTimeout(600)
  await expect(page.getByRole('cell', { name: 'students', exact: true })).toBeVisible()

  // clicking Refresh must fire another list_tables call (genuine re-fetch, no cache)
  const before = await page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.list_tables ?? 0)
  await page.getByRole('button', { name: 'Refresh objects' }).click()
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.list_tables ?? 0)
  expect(after).toBeGreaterThan(before)

  // the grid is still rendered after the refresh completes (no crash)
  await expect(page.getByRole('cell', { name: 'students', exact: true })).toBeVisible()
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
