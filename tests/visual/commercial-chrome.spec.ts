import { expect, test, type Locator, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Rule chung for app chrome (menus, toolbars, pagers): UI font — never monospace —
// a drawn icon per action instead of Unicode glyphs (▾ « ‹ › » ⏮ ＋ 🗑 Σ), and
// descriptions / shortcuts as quiet secondary text.

const isMono = (l: Locator) => l.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase().includes('mono'))
const GLYPHS = /[▾«‹›»⏮⏭◀▶＋🗑Σ]/

async function boot(page: Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
}

test('result Export menu: icons, a description per format, the UI font', async ({ page }) => {
  await boot(page)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  const exportBtn = page.getByRole('button', { name: 'Export', exact: true }).first()
  await expect(exportBtn).toBeVisible({ timeout: 10_000 })
  expect(await exportBtn.locator('svg').count()).toBe(2) // download + chevron
  await expect(exportBtn).not.toHaveText(GLYPHS)
  await exportBtn.click()
  await expect(exportBtn).toHaveAttribute('aria-expanded', 'true')
  const menu = page.getByRole('menu', { name: 'Export as' })
  await expect(menu).toBeVisible()
  expect(await isMono(menu)).toBe(false)
  await expect(menu).toContainText(/Export \d+ rows? as/)
  const items = menu.getByRole('menuitem')
  await expect(items).toHaveCount(6) // 5 formats + Custom…
  for (let i = 0; i < 6; i++) expect(await items.nth(i).locator('svg').count(), `item ${i} has an icon`).toBe(1)
  await expect(items.filter({ hasText: 'Excel (.xlsx)' })).toContainText('numbers stay numbers')
  await expect(items.filter({ hasText: 'CSV' }).first()).toContainText('.csv')
})

test('Open Data: toolbar, filters, sort and pager follow the rule', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByRole('treeitem', { name: /public/ }).first().dblclick()
  await page.waitForTimeout(600)
  await page.getByRole('cell', { name: 'students', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open Data', exact: true }).click()
  const pane = page.locator('[data-tab-pane][data-active="true"]')
  await expect(pane.locator('.grid-row').first()).toBeVisible({ timeout: 10_000 })

  // grid edit bar: icons, Delete disabled until rows are selected
  const insert = pane.getByRole('button', { name: 'Insert row', exact: true })
  expect(await insert.locator('svg').count()).toBe(1)
  const del = pane.getByRole('button', { name: 'Delete row', exact: true })
  await expect(del).toHaveAttribute('aria-disabled', 'true')

  // Filters: icon + chevron, opens the builder; the builder uses the shared controls
  const filters = pane.getByRole('button', { name: /^Filters/ })
  await expect(filters).not.toHaveText(GLYPHS)
  await filters.click()
  await expect(filters).toHaveAttribute('aria-expanded', 'true')
  await pane.getByRole('button', { name: 'Add condition' }).click()
  await expect(pane.getByRole('combobox', { name: 'Column' })).toBeVisible()
  expect(await isMono(pane.getByRole('combobox', { name: 'Column' }))).toBe(false)
  await expect(filters.locator('.ds-tbtn-badge')).toHaveText('1')
  await pane.getByRole('button', { name: 'Remove this condition' }).click()

  // sort chips read in the UI font and say which one is active
  const gpa = pane.locator('.tv-sort', { hasText: 'gpa' })
  expect(await isMono(gpa)).toBe(false)
  await gpa.click()
  await expect(gpa).toHaveAttribute('aria-pressed', 'true')

  // pager: drawn icons with names, no « ‹ › » characters, "Page 1 of 39" in the UI font
  for (const name of ['First page', 'Previous page', 'Next page', 'Last page']) {
    const b = pane.getByRole('button', { name, exact: true }).last()
    await expect(b).toBeVisible()
    expect(await b.locator('svg').count(), `${name} is an icon`).toBe(1)
  }
  await expect(pane.getByRole('button', { name: 'First page', exact: true }).last()).toHaveAttribute('aria-disabled', 'true')
  const label = pane.locator('.ds-pager-label').last()
  await expect(label).toHaveText(/Page 1 of 39/)
  expect(await isMono(label)).toBe(false)
  const footer = pane.locator('.tv-foot')
  await expect(footer).not.toHaveText(GLYPHS)
})
