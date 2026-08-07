import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// The foreign-database subtree (PG/MSSQL "other databases", browsed through an
// internal sub-connection) must belong to the connection currently selected in the
// sidebar. Two servers can host databases with the SAME name (`analytics` here), so
// a sub-connection cache keyed by database name alone hands connection B a
// sub-connection that still points at connection A → the subtree, and "Open Data"
// on it, read the wrong server. Regression guard for that.
test('foreign database subtree follows the selected connection (Open Data hits the right server)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  const publics = () => page.getByRole('treeitem', { name: /public/ })

  // --- connection A: expand the foreign database `analytics` -----------------
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByRole('treeitem', { name: /analytics/ }).first().dblclick()
  await page.waitForTimeout(800)
  expect(await publics().count()).toBeGreaterThan(1) // A's own public + analytics' public

  // --- switch to connection B (a different Postgres server) ------------------
  await page.getByRole('button', { name: /Staging Postgres/ }).first().click()
  await page.waitForTimeout(700)
  await openDatabaseNode(page)

  // Expand `analytics` on B. Whatever the collapse/expand bookkeeping, the node
  // must end up open — and open on B's OWN sub-connection.
  const foreignB = page.getByRole('treeitem', { name: /analytics/ }).first()
  for (let i = 0; i < 3 && (await publics().count()) < 2; i++) {
    await foreignB.dblclick()
    await page.waitForTimeout(900)
  }
  expect(await publics().count(), 'foreign database did not expand on connection B').toBeGreaterThan(1)

  const attaches = await page.evaluate(() => (window as unknown as { __ipcAttach?: string[] }).__ipcAttach ?? [])
  expect(attaches.some((a) => a.startsWith('c7:')), `attach_database calls: ${attaches.join(' | ')}`).toBe(true)

  // Open Data on a table inside B's `analytics` → the viewer must be bound to B.
  await publics().last().dblclick()
  await page.waitForTimeout(700)
  await page.getByRole('treeitem', { name: /Tables/ }).last().dblclick()
  await page.waitForTimeout(700)
  const tbl = page.getByRole('treeitem', { name: /students/ }).last()
  await tbl.scrollIntoViewIfNeeded()
  await tbl.click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.getByText('Open Data', { exact: true }).first().click()
  await page.waitForTimeout(900)

  // The Table Viewer toolbar names the connection it reads from.
  await expect(page.getByTitle('Connection', { exact: true }).first()).toHaveText('Staging Postgres')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Disconnecting drops every `{id}::db` sub-connection in the backend, so the tree
// must not keep browsing (or opening data on) one afterwards: re-expanding a foreign
// database has to attach it again.
test('disconnecting forgets the per-database sub-connections it opened', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  const publics = () => page.getByRole('treeitem', { name: /public/ })
  const attachCount = async () =>
    await page.evaluate(() => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.attach_database ?? 0)

  const conn = page.getByRole('button', { name: /Postgres/ }).first()
  await conn.click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByRole('treeitem', { name: /analytics/ }).first().dblclick()
  await page.waitForTimeout(800)
  expect(await publics().count()).toBeGreaterThan(1)
  const attachesBefore = await attachCount()

  // disconnect → reconnect
  await conn.click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Disconnect', { exact: true }).first().click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: /^Connect$/ }).first().click()
  await page.waitForTimeout(900)

  // the foreign subtree is gone (its sub-connection died with the connection)…
  expect(await publics().count()).toBe(1)
  // …and re-expanding attaches a fresh one instead of reusing the dead id
  await page.getByRole('treeitem', { name: /analytics/ }).first().dblclick()
  await page.waitForTimeout(900)
  expect(await publics().count()).toBeGreaterThan(1)
  expect(await attachCount()).toBeGreaterThan(attachesBefore)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
