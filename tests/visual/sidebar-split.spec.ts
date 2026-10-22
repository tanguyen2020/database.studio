import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Two title-bar layout buttons (next to Sessions) pick the sidebar layout:
// Connections | Explorer as two panels, or the one sidebar where every connection
// opens in place into its own tree. The pick is remembered and re-applied on the
// next start. This spec starts from a fresh install (no saved layout), so it sees
// the app's real default.

const LEFT = 'Connections left'
const STACKED = 'One sidebar'

const conn = (p: Page) => p.locator('[data-sidebar-panel="connections"]')
const expl = (p: Page) => p.locator('[data-sidebar-panel="explorer"]')
const stackedPanel = (p: Page) => p.locator('[data-sidebar-panel="stacked"]')

test.use({ storageState: { cookies: [], origins: [] } })

async function boot(page: Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
}

test('sidebar layout: two modes, panel order, and it survives a restart', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await boot(page)

  // both buttons live in the title bar, next to Sessions — and the dropped
  // "Connections right" mode is not offered any more
  const bar = page.getByRole('radiogroup', { name: 'Sidebar layout' })
  await expect(bar.getByRole('radio')).toHaveCount(2)
  await expect(bar.getByRole('radio', { name: 'Connections right' })).toHaveCount(0)
  const sessions = (await page.getByRole('button', { name: 'Sessions', exact: true }).boundingBox())!
  const group = (await bar.boundingBox())!
  expect(Math.abs(group.y - sessions.y)).toBeLessThan(6) // same row
  expect(group.x).toBeLessThan(sessions.x) // immediately before it

  // a fresh install starts in the one sidebar, and that button reads as the active one
  await expect(stackedPanel(page)).toBeVisible()
  await expect(conn(page)).toHaveCount(0)
  await expect(bar.getByRole('radio', { name: STACKED })).toHaveAttribute('aria-checked', 'true')

  // ---- Connections left | Explorer right
  await bar.getByRole('radio', { name: LEFT }).click()
  await page.waitForTimeout(200)
  await expect(stackedPanel(page)).toHaveCount(0)
  await expect(conn(page)).toBeVisible()
  await expect(expl(page)).toBeVisible()
  await expect(bar.getByRole('radio', { name: LEFT })).toHaveAttribute('aria-checked', 'true')
  {
    const c = (await conn(page).boundingBox())!
    const e = (await expl(page).boundingBox())!
    expect(e.x).toBeGreaterThan(c.x + c.width - 1) // Explorer to the right
    expect(Math.abs(e.height - c.height)).toBeLessThan(2) // both full height
    // the connection tree fills its panel instead of the fixed stacked height
    const tree = (await conn(page).getByRole('tree', { name: 'Connections' }).boundingBox())!
    expect(tree.height).toBeGreaterThan(c.height / 2)
  }
  // each panel keeps its own header, and the tree still drives the Explorer
  await expect(conn(page).getByText('Connections', { exact: true })).toBeVisible()
  await expect(expl(page).getByText('Explorer', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await expect(expl(page).getByText(/Postgres/).first()).toBeVisible()

  // ---- remembered across a restart (reload)
  await page.reload()
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await expect(stackedPanel(page)).toHaveCount(0)
  {
    const c = (await conn(page).boundingBox())!
    const e = (await expl(page).boundingBox())!
    expect(e.x).toBeGreaterThan(c.x + c.width - 1) // still Connections | Explorer
  }
  await expect(
    page.getByRole('radiogroup', { name: 'Sidebar layout' }).getByRole('radio', { name: LEFT }),
  ).toHaveAttribute('aria-checked', 'true')

  // ---- back to one sidebar: no separate Explorer — the connection opens in place
  await page.getByRole('radiogroup', { name: 'Sidebar layout' }).getByRole('radio', { name: STACKED }).click()
  await page.waitForTimeout(200)
  await expect(stackedPanel(page)).toBeVisible()
  await expect(conn(page)).toHaveCount(0)
  await expect(page.getByText('Explorer', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /Postgres 10\.0\.1\.5/ }).first().click()
  const pgTree = stackedPanel(page).locator('[data-conn-tree="c1"]')
  await expect(pgTree).toBeVisible()
  {
    const row = (await page.locator('[data-conn-id="c1"]').boundingBox())!
    const t = (await pgTree.boundingBox())!
    expect(t.y).toBeGreaterThanOrEqual(row.y + row.height - 1) // right under its row
  }

  // and that is remembered too
  await page.reload()
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await expect(page.locator('[data-sidebar-panel="stacked"]')).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('the layout is driven only by the title bar (no split icon in the panels)', async ({ page }) => {
  await boot(page)
  await expect(page.getByRole('button', { name: /Split sidebar|Merge sidebar/ })).toHaveCount(0)
  await page
    .getByRole('radiogroup', { name: 'Sidebar layout' })
    .getByRole('radio', { name: LEFT })
    .click()
  await page.waitForTimeout(200)
  await expect(conn(page)).toBeVisible()
  await expect(page.getByRole('button', { name: /Split sidebar|Merge sidebar/ })).toHaveCount(0)
})
