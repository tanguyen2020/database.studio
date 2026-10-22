import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, ONE_SIDEBAR } from './helpers'

// The one sidebar (the app's default layout): every connection opens IN PLACE into
// its own object tree — several at a time — like DataGrip's Database Explorer. The
// selected connection's Properties + toolbar are pinned at the bottom. Redis · Kafka ·
// NATS · RabbitMQ have no tree: picking them opens their workspace tab.

test.use({ storageState: ONE_SIDEBAR })

const row = (p: Page, id: string) => p.locator(`[data-conn-id="${id}"]`)
const tree = (p: Page, id: string) => p.locator(`[data-conn-tree="${id}"]`)
const calls = (p: Page, cmd: string) =>
  p.evaluate((c) => (window as unknown as { __ipcCalls?: Record<string, number> }).__ipcCalls?.[c] ?? 0, cmd)

async function boot(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  return errors
}

test('a connection opens in place into its own tree; several stay open at once', async ({ page }) => {
  const errors = await boot(page)
  // no separate Explorer panel in this layout
  await expect(page.locator('[data-sidebar-panel="stacked"]')).toBeVisible()
  await expect(page.locator('[data-sidebar-panel="explorer"]')).toHaveCount(0)
  // every tree starts closed
  await expect(page.locator('[data-conn-tree]')).toHaveCount(0)
  await expect(row(page, 'c1')).toHaveAttribute('aria-expanded', 'false')

  // picking a connected connection opens its tree right under its row
  await row(page, 'c1').click()
  await expect(tree(page, 'c1')).toBeVisible()
  await expect(row(page, 'c1')).toHaveAttribute('aria-expanded', 'true')
  await expect(tree(page, 'c1').getByRole('treeitem', { name: /^app\b/ }).first()).toBeVisible()
  const r = (await row(page, 'c1').boundingBox())!
  const t = (await tree(page, 'c1').boundingBox())!
  expect(t.y).toBeGreaterThanOrEqual(r.y + r.height - 1)
  expect(t.x).toBeGreaterThan(r.x) // nested: indented under its connection

  // a second connection opens too — the first one stays open
  await row(page, 'c2').click()
  await expect(tree(page, 'c2')).toBeVisible()
  await expect(tree(page, 'c1')).toBeVisible()
  // each tree belongs to its own connection
  await expect(tree(page, 'c2').getByRole('treeitem', { name: /^public\b/ }).first()).toBeVisible()

  // the chevron closes a tree without touching the other
  await row(page, 'c1').locator('.conn-chev').click()
  await expect(tree(page, 'c1')).toHaveCount(0)
  await expect(tree(page, 'c2')).toBeVisible()
  await row(page, 'c1').locator('.conn-chev').click()
  await expect(tree(page, 'c1')).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('the footer (Properties + toolbar) follows the connection being worked in', async ({ page }) => {
  const errors = await boot(page)
  await row(page, 'c1').click()
  await row(page, 'c2').click()
  const host = page.locator('[data-explorer-footer-host]')
  // exactly one footer, pinned at the bottom, and it is MySQL's (selected last)
  await expect(host.locator('[data-explorer-footer]')).toHaveCount(1)
  await expect(host.locator('[data-explorer-footer="c2"]')).toBeVisible()
  // clicking inside Postgres's tree makes Postgres the selected connection
  await tree(page, 'c1').getByRole('treeitem', { name: /^app\b/ }).first().click()
  await expect(row(page, 'c1')).toHaveClass(/selected/)
  await expect(host.locator('[data-explorer-footer="c1"]')).toBeVisible()
  await expect(host.locator('[data-explorer-footer]')).toHaveCount(1)
  // the footer stays at the bottom of the sidebar, below every tree
  const f = (await host.boundingBox())!
  const aside = (await page.locator('[data-sidebar-panel="stacked"]').boundingBox())!
  expect(f.y + f.height).toBeGreaterThan(aside.y + aside.height - 4)
  expect(errors, errors.join('\n')).toEqual([])
})

test('keys: arrows move the highlight without opening trees; ←/→ close and open', async ({ page }) => {
  const errors = await boot(page)
  await row(page, 'c1').click()
  await expect(tree(page, 'c1')).toBeVisible()
  await page.getByRole('tree', { name: 'Connections' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(tree(page, 'c1')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(tree(page, 'c1')).toBeVisible()
  // moving the highlight to the next connection does not open its tree
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-conn-tree]')).toHaveCount(1)
  expect(errors, errors.join('\n')).toEqual([])
})

test('row shortcuts: New query opens an editor on that connection; Refresh re-reads its tree', async ({ page }) => {
  const errors = await boot(page)
  await row(page, 'c1').click()
  await expect(tree(page, 'c1')).toBeVisible()
  await page.waitForTimeout(500)
  const before = await calls(page, 'list_schemas')
  await row(page, 'c1').locator('.conn-act[title^="Refresh"]').click()
  await expect.poll(() => calls(page, 'list_schemas')).toBeGreaterThan(before)
  await expect(tree(page, 'c1')).toBeVisible() // still open after the re-read

  const tabsBefore = await page.getByRole('tab').count()
  await row(page, 'c1').locator('.conn-act[title="New query"]').click()
  await expect(page.getByRole('tab')).toHaveCount(tabsBefore + 1)
  await expect(page.locator('input[title="Database"]:visible')).toBeVisible()
  expect(errors, errors.join('\n')).toEqual([])
})

test('Redis · Kafka · NATS · RabbitMQ have no tree: picking them opens their workspace', async ({ page }) => {
  const errors = await boot(page)
  for (const [id, shell] of [['c5', 'kafka'], ['c4', 'redis'], ['c6', 'nats']] as const) {
    await expect(row(page, id).locator('.conn-chev')).toHaveCount(0)
    await expect(row(page, id)).not.toHaveAttribute('aria-expanded', /.*/)
    await row(page, id).click()
    await expect(page.locator(`[data-stream-shell="${shell}"]`)).toBeVisible()
    await expect(tree(page, id)).toHaveCount(0)
  }
  expect(errors, errors.join('\n')).toEqual([])
})

test('names are never cut: long names widen the list, which scrolls sideways', async ({ page }) => {
  const errors = await boot(page)
  await row(page, 'c1').click()
  const t = tree(page, 'c1')
  await t.getByRole('treeitem', { name: /^app\b/ }).first().dblclick()
  await t.getByText('public', { exact: true }).first().dblclick()
  await t.getByText('Tables', { exact: true }).first().dblclick()
  await expect(t.getByText('students', { exact: true }).first()).toBeVisible()
  // no connection name / host / path and no tree name ends in an ellipsis
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll('.conn-name, .conn-sub, [data-embedded-tree] [role="treeitem"] span')]
      .filter((e) => (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 1)
      .map((e) => e.textContent),
  )
  expect(clipped, `cut names: ${clipped.join(', ')}`).toEqual([])
  // the SQLite path is longer than the panel: the list scrolls instead of cutting it
  const list = page.getByRole('tree', { name: 'Connections' })
  expect(await list.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
  await expect(page.locator('.conn-sub').filter({ hasText: '/data/attendance.db' })).toHaveText('/data/attendance.db')
  expect(errors, errors.join('\n')).toEqual([])
})

test('the connections search is a framed field with an icon and a clear button', async ({ page }) => {
  const errors = await boot(page)
  await page.getByTitle('Filter connections (Ctrl+Shift+K)').click()
  const box = page.getByRole('textbox', { name: 'Search connections by name, host or database' })
  await expect(box).toBeFocused()
  await expect(box).toHaveAttribute('placeholder', 'Search connections')
  await box.fill('kafka')
  await expect(row(page, 'c5')).toBeVisible()
  await expect(row(page, 'c1')).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear the search' }).click()
  await expect(box).toHaveValue('')
  await expect(box).toBeFocused()
  await expect(row(page, 'c1')).toBeVisible()
  await box.press('Escape')
  await expect(box).toHaveCount(0)
  expect(errors, errors.join('\n')).toEqual([])
})

// The chevron is a small target: double-clicking the connection opens or closes its tree,
// and the chevron itself covers the row's whole left gutter.
test('double-click a connection to open or close its tree; the chevron is a big target', async ({ page }) => {
  const errors = await boot(page)
  // a double-click on a connection not picked yet: the first click opens the tree, the
  // double-click must not close it straight away
  await row(page, 'c1').dblclick()
  await expect(tree(page, 'c1')).toBeVisible()
  await page.waitForTimeout(700) // keep the next double-click separate from this one
  await row(page, 'c1').locator('.conn-name').dblclick()
  await expect(tree(page, 'c1')).toHaveCount(0)
  await expect(row(page, 'c1')).toHaveAttribute('aria-expanded', 'false')
  await page.waitForTimeout(700)
  await row(page, 'c1').locator('.conn-name').dblclick()
  await expect(tree(page, 'c1')).toBeVisible()

  const chev = (await row(page, 'c1').locator('.conn-chev').boundingBox())!
  const rowBox = (await row(page, 'c1').boundingBox())!
  expect(chev.width, 'the chevron is at least 22px wide').toBeGreaterThanOrEqual(22)
  expect(chev.height, 'the chevron spans the row height').toBeGreaterThanOrEqual(rowBox.height - 1)
  expect(errors, errors.join('\n')).toEqual([])
})
