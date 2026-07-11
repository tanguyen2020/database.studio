import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// SSMS-style folder filter: hidden until "Filter…" is picked from the folder
// context menu; typing narrows the folder; and a Clear Filter control restores
// the full list afterwards.

async function openExplorer(page: import('@playwright/test').Page) {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
}

test('folder filter: reveal via context menu, narrow, then Clear restores list', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openExplorer(page)
  await page.getByText('Functions', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await expect(page.getByText('add_one').first()).toBeVisible()
  await expect(page.getByText('current_load').first()).toBeVisible()

  // no box until the context-menu action
  await expect(page.getByPlaceholder('Filter…')).toHaveCount(0)
  await page.getByText('Functions', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByText('Filter…', { exact: true }).first().click()
  await page.waitForTimeout(150)

  const box = page.getByPlaceholder('Filter…').first()
  await expect(box).toBeVisible()
  await box.fill('add')
  await page.waitForTimeout(150)
  await expect(page.getByText('add_one').first()).toBeVisible()
  await expect(page.getByText('current_load')).toHaveCount(0)

  // MANDATORY clear: the "Clear" control removes the filter and restores the list
  await page.locator('[title="Clear filter"]').first().click()
  await page.waitForTimeout(150)
  await expect(page.getByPlaceholder('Filter…')).toHaveCount(0)
  await expect(page.getByText('add_one').first()).toBeVisible()
  await expect(page.getByText('current_load').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('folder filter: funnel icon on the folder header reveals the box, then clears', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await openExplorer(page)
  await page.getByText('Functions', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await expect(page.getByText('add_one').first()).toBeVisible()
  await expect(page.getByText('current_load').first()).toBeVisible()

  // no box until the funnel icon is clicked (no right-click needed)
  await expect(page.getByPlaceholder('Filter…')).toHaveCount(0)
  const fnRow = page.getByRole('treeitem').filter({ hasText: 'Functions' }).first()
  await fnRow.getByLabel('Filter items').click()
  await page.waitForTimeout(150)

  const box = page.getByPlaceholder('Filter…').first()
  await expect(box).toBeVisible()
  await box.fill('add')
  await page.waitForTimeout(150)
  await expect(page.getByText('add_one').first()).toBeVisible()
  await expect(page.getByText('current_load')).toHaveCount(0)

  // clicking the icon again (now titled "Clear filter") clears + hides the box
  await fnRow.getByLabel('Filter items').click()
  await page.waitForTimeout(150)
  await expect(page.getByPlaceholder('Filter…')).toHaveCount(0)
  await expect(page.getByText('add_one').first()).toBeVisible()
  await expect(page.getByText('current_load').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Clear works in every object folder the user named: Views, Stored Procedures,
// Functions, Triggers. Each demo folder has two items; filtering hides one and
// clearing (context-menu "Clear Filter") restores both.
const FOLDERS: { folder: string; query: string; kept: string; hidden: string }[] = [
  { folder: 'Views', query: 'active', kept: 'vw_active_students', hidden: 'vw_recent_enrollments' },
  { folder: 'Stored Procedures', query: 'refresh', kept: 'refresh_stats', hidden: 'recompute_ranks' },
  { folder: 'Functions', query: 'add', kept: 'add_one', hidden: 'current_load' },
  { folder: 'Triggers', query: 'audit', kept: 'trg_audit', hidden: 'trg_updated_at' },
]

for (const f of FOLDERS) {
  test(`folder filter clear: ${f.folder}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await openExplorer(page)
    await page.getByText(f.folder, { exact: true }).first().dblclick()
    await page.waitForTimeout(200)
    await expect(page.getByText(f.kept).first()).toBeVisible()
    await expect(page.getByText(f.hidden).first()).toBeVisible()

    // Filter…
    await page.getByText(f.folder, { exact: true }).first().click({ button: 'right' })
    await page.waitForTimeout(150)
    await page.getByText('Filter…', { exact: true }).first().click()
    await page.waitForTimeout(150)
    await page.getByPlaceholder('Filter…').first().fill(f.query)
    await page.waitForTimeout(150)
    await expect(page.getByText(f.kept).first()).toBeVisible()
    await expect(page.getByText(f.hidden)).toHaveCount(0)

    // Clear Filter via the folder context menu → both restored
    await page.getByText(f.folder, { exact: true }).first().click({ button: 'right' })
    await page.waitForTimeout(150)
    await page.getByText('Clear Filter', { exact: true }).first().click()
    await page.waitForTimeout(150)
    await expect(page.getByText(f.kept).first()).toBeVisible()
    await expect(page.getByText(f.hidden).first()).toBeVisible()

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
  })
}
