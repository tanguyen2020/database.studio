import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// The desktop app opens with every Connections group collapsed (an overview of
// engines + counts). The browser build keeps them open for the demo/e2e, so this
// spec opts into the desktop behaviour with ?collapsedStart=1.

const startCollapsed = APP_URL.replace(/\/?$/, '/') + '?collapsedStart=1'

test('connections: groups start collapsed, open on demand, and reveal a connection picked elsewhere', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(startCollapsed)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(500)

  // every engine group is there, collapsed — no connection row yet
  const groups = page.locator('.grp-head')
  expect(await groups.count()).toBeGreaterThan(3)
  await expect(page.locator('.conn-row')).toHaveCount(0)
  for (const g of await groups.all()) await expect(g).toHaveAttribute('aria-expanded', 'false')

  // opening a group shows its connections; closing it takes them away again
  const pg = groups.filter({ hasText: 'PostgreSQL' }).first()
  await pg.click()
  await expect(pg).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('10.0.1.5:5432')).toBeVisible()
  await pg.click()
  await expect(pg).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.conn-row')).toHaveCount(0) // after the collapse motion

  // a connection picked from the Command Palette opens its (collapsed) group
  await page.keyboard.press('Control+p')
  const input = page.getByPlaceholder('Type a command or search…')
  await expect(input).toBeVisible()
  await input.fill('Cache Redis')
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await expect(page.getByText('10.0.1.7:6379')).toBeVisible()
  await expect(groups.filter({ hasText: 'Redis' }).first()).toHaveAttribute('aria-expanded', 'true')
  // …and only that one — the others stay collapsed
  await expect(pg).toHaveAttribute('aria-expanded', 'false')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('connections: the browser build still opens with every group expanded', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(500)
  await expect(page.getByText('10.0.1.5:5432')).toBeVisible()
})
