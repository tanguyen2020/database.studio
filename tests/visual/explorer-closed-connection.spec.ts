import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// A closed connection has no live catalog: the Explorer's Expand all / Collapse all /
// Refresh actions and the Properties readout are disabled, and the pinned Objects tab
// (which lists a live catalog) is closed with the connection.

test('explorer: closing the connection disables its tree actions and Properties', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  const conn = page.getByRole('button', { name: /Postgres/ }).first()
  await conn.click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  const expandAll = page.getByRole('button', { name: 'Expand all' })
  const collapseAll = page.getByRole('button', { name: 'Collapse all' })
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true }).first()

  // connected: all three act on the tree
  await expect(expandAll).toHaveAttribute('aria-disabled', 'false')
  await expect(collapseAll).toHaveAttribute('aria-disabled', 'false')
  await expect(refresh).toHaveAttribute('aria-disabled', 'false')

  // select the schema → the Properties readout describes it
  await page.getByRole('treeitem', { name: /public/ }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByText('Properties', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Schema', { exact: true }).first()).toBeVisible()

  const beforeRefresh = await page.evaluate(
    () => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.list_schemas ?? 0,
  )

  // disconnect
  await conn.click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Disconnect', { exact: true }).first().click()
  await page.waitForTimeout(700)
  await expect(page.getByText('Not connected.').first()).toBeVisible()

  // every tree action is disabled…
  await expect(expandAll).toHaveAttribute('aria-disabled', 'true')
  await expect(collapseAll).toHaveAttribute('aria-disabled', 'true')
  await expect(refresh).toHaveAttribute('aria-disabled', 'true')
  // …and clicking Refresh really does nothing (no catalog re-read)
  await refresh.click({ force: true })
  await page.waitForTimeout(600)
  const afterRefresh = await page.evaluate(
    () => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.list_schemas ?? 0,
  )
  expect(afterRefresh).toBe(beforeRefresh)

  // Properties is gone (nothing live to describe)
  await expect(page.getByText('Properties', { exact: true })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
})

test('Objects tab closes when its connection is closed', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  const conn = page.getByRole('button', { name: /Postgres/ }).first()
  await conn.click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)

  // open the pinned Objects tab on the "public" schema
  await page.getByRole('treeitem', { name: /public/ }).first().dblclick()
  await page.waitForTimeout(700)
  await expect(page.getByRole('tab').first()).toContainText('Objects')

  await conn.click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Disconnect', { exact: true }).first().click()
  await page.waitForTimeout(800)

  // the tab is gone — it listed a catalog nobody can reach any more
  await expect(page.getByRole('tab', { name: /Objects/ })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
})
