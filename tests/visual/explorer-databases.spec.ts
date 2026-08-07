import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// AUDIT-4 item 2 — relational Explorer shows every database: the connected one
// as a "current" header (its schemas nest under it), and other databases as
// expandable tree nodes browsed via an internal sub-connection (no duplicate
// sidebar connection). Expanding a foreign database loads its own schema tree.
test('explorer per-database tree: current header + foreign database expands', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  // current-database header (meta "current") + a foreign database tree node
  await expect(page.getByText('current').first()).toBeVisible()
  const foreign = page.getByRole('treeitem', { name: /analytics/ })
  await expect(foreign.first()).toBeVisible()

  // expanding the foreign database loads ITS schema tree (a second "public")
  const before = await page.getByRole('treeitem', { name: /public/ }).count()
  await foreign.first().dblclick() // expand (single-click only selects)
  await page.waitForTimeout(1000)
  expect(await page.getByRole('treeitem', { name: /public/ }).count()).toBeGreaterThan(before)

  // no duplicate connection was added to the sidebar
  await expect(page.getByRole('button', { name: /· analytics/ })).toHaveCount(0)

  // item 4 — a table inside the FOREIGN database must expand to its columns too
  // (previously only the current database's tables did; PG/MSSQL app DBs are foreign).
  await page.getByRole('treeitem', { name: /public/ }).last().dblclick() // foreign public schema
  await page.waitForTimeout(600)
  await page.getByRole('treeitem', { name: /Tables/ }).last().dblclick() // Tables folder
  await page.waitForTimeout(600)
  const tbl = page.getByRole('treeitem', { name: /students/ }).last()
  await tbl.scrollIntoViewIfNeeded()
  await tbl.getByRole('button').first().click() // chevron → expand to columns
  await page.waitForTimeout(600)
  const col = page.getByText('first_name').first()
  await expect(col).toBeVisible()

  // foreign-database columns must have the same context menu as MySQL's
  await col.click({ button: 'right' })
  await page.waitForTimeout(200)
  await expect(page.getByText('Copy as table.column', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Set as Filter', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
