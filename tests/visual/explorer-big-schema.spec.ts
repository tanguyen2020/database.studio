import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// A schema with thousands of tables used to take seconds to open and to collapse,
// freezing the window. Two causes, both pinned here structurally (timings vary
// by machine; the structure is what made it slow):
//   1. every tree row built its OWN context menu (a bits-ui Root + Trigger, plus
//      the menu body) — 3,000 tables = 3,000 menus before anything was clicked;
//   2. every row ran the enter animation — 3,000 CSS animations, each its own
//      compositing layer, restyled every frame.
// The Objects tab (opened by double-clicking the schema) had the same per-row menu.

const N = 3000

async function dblclickRow(page: Page, title: string) {
  // dispatch directly: a role+name locator over 3,000 rows is slow in itself
  await page.evaluate((t) => {
    const el = document.querySelector(`[role=treeitem][title="${t}"]`) as HTMLElement
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  }, title)
}

test('a schema with thousands of tables opens with one shared menu and no per-row animation', async ({ page }) => {
  test.setTimeout(180_000)
  await blockRemoteFonts(page)
  await page.goto(APP_URL + `?bigSchema=${N}`)
  await page.waitForSelector('#app > *', { timeout: 30_000 })
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await openDatabaseNode(page)
  await page.waitForSelector('[role=treeitem][title="public"]')
  // the Explorer tree (the container that holds the schema row)
  const tree = page.locator('[role=tree]').filter({ has: page.locator('[role=treeitem][title="public"]') }).last()

  await dblclickRow(page, 'public')
  await page.waitForSelector('[role=treeitem][title="Tables"]')
  const t0 = Date.now()
  await dblclickRow(page, 'Tables')
  await page.waitForSelector(`[role=treeitem][title="tbl_${N - 1}"]`, { state: 'attached', timeout: 120_000 })
  console.log(`open ${N} tables: ${Date.now() - t0} ms`)

  // (1) one menu for the whole tree — not one per row
  expect(await tree.locator('[data-slot="context-menu-trigger"]').count()).toBe(1)
  // (2) only the first rows of the batch animate
  const marked = await tree.locator('[data-noanim]').count()
  expect(marked).toBeGreaterThanOrEqual(N - 40)

  // the shared menu still opens on ANY row — the very last one included — with
  // that row's own items, and they act on that row
  const last = tree.locator(`[role=treeitem][title="tbl_${N - 1}"]`)
  await last.scrollIntoViewIfNeeded()
  await last.click({ button: 'right' })
  const openData = page.getByRole('menuitem', { name: 'Open Data' })
  await expect(openData).toBeVisible()
  await openData.click()
  await expect(page.getByRole('tab', { name: new RegExp(`tbl_${N - 1}`) })).toBeVisible()

  // a different row gets ITS menu (the shared menu follows the row right-clicked)
  const other = tree.locator('[role=treeitem][title="tbl_7"]')
  await other.scrollIntoViewIfNeeded()
  await other.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open Data' }).click()
  await expect(page.getByRole('tab', { name: /tbl_7\b/ })).toBeVisible()

  // collapsing removes the folder (most rows without an outro)
  const t1 = Date.now()
  await dblclickRow(page, 'Tables')
  await page.waitForSelector(`[role=treeitem][title="tbl_${N - 1}"]`, { state: 'detached', timeout: 60_000 })
  console.log(`collapse ${N} tables: ${Date.now() - t1} ms`)
})

test('the Objects tab lists thousands of tables with one shared menu', async ({ page }) => {
  test.setTimeout(180_000)
  await blockRemoteFonts(page)
  await page.goto(APP_URL + `?bigSchema=${N}`)
  await page.waitForSelector('#app > *', { timeout: 30_000 })
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await openDatabaseNode(page)
  await page.waitForSelector('[role=treeitem][title="public"]')
  await dblclickRow(page, 'public') // double-clicking a schema opens the Objects tab
  const table = page.getByRole('table', { name: 'Database objects' })
  await expect(table.locator('[role=row]')).toHaveCount(N + 1, { timeout: 60_000 }) // + header
  expect(await table.locator('[data-slot="context-menu-trigger"]').count()).toBe(0)

  const row = table.locator('[role=row]').filter({ hasText: `tbl_${N - 1}` })
  await row.scrollIntoViewIfNeeded()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open Data' }).click()
  await expect(page.getByRole('tab', { name: new RegExp(`tbl_${N - 1}`) })).toBeVisible()
})
