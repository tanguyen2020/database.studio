import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Navicat-style editing on the editable (Table Viewer) grid:
//  - single-click SELECTS a cell (no editor),
//  - double-click / F2 / Enter enter edit mode,
//  - typing a printable character enters edit seeded with that character.
test('editable grid: single-click selects, double-click / type edits (Navicat-style)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  // double-click the table row → opens the editable Table Viewer grid
  await page.getByRole('treeitem', { name: /students/ }).first().dblclick()
  await expect(page.getByText('＋ Insert row', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(300)

  const cell = page.locator('.grid-row td:not(:first-child)').first()

  // single-click selects — no inline <input> appears
  await cell.click()
  await page.waitForTimeout(150)
  await expect(page.locator('.grid-row input')).toHaveCount(0)

  // double-click enters edit mode — an <input> appears
  await cell.dblclick()
  await page.waitForTimeout(150)
  await expect(page.locator('.grid-row input').first()).toBeVisible()

  // Escape cancels the editor
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  await expect(page.locator('.grid-row input')).toHaveCount(0)

  // select a cell then type a printable char → edit seeded with that char
  await cell.click()
  await page.waitForTimeout(100)
  await page.keyboard.press('z')
  await page.waitForTimeout(150)
  const input = page.locator('.grid-row input').first()
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('z')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// items 1–3: Tab moves to the next cell while editing; Insert row focuses a cell
// for immediate entry; pasting many rows appends them as new records.
test('editable grid: Tab moves cell, Insert row focuses, paste adds records', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByRole('treeitem', { name: /students/ }).first().dblclick()
  await expect(page.getByText('＋ Insert row', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(300)

  // item 1 — enter edit, Tab keeps the editor open on the next cell
  await page.locator('.grid-row td:not(:first-child)').first().dblclick()
  await expect(page.locator('.grid-row input').first()).toBeVisible()
  await page.keyboard.press('Tab')
  await page.waitForTimeout(150)
  await expect(page.locator('.grid-row input').first()).toBeVisible() // still editing, moved on

  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)

  // item 2 — clicking Insert row opens an editor on the new row straight away,
  // and the grid scrolls to the bottom so the new row is visible.
  await page.getByText('＋ Insert row', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await expect(page.locator('input:focus')).toBeVisible()
  const atBottom = await page.evaluate(() => {
    const el = document.querySelector('[role="grid"]') as HTMLElement | null
    if (!el) return false
    return el.scrollHeight - el.clientHeight - el.scrollTop <= 4
  })
  expect(atBottom, 'grid should be scrolled to the bottom after Insert row').toBe(true)

  // item 3a — paste a multi-column record straight into the new insert row
  // (editor is still focused on the row from item 2). Values spread across the
  // row's columns instead of dumping into one cell.
  await page.evaluate(() => navigator.clipboard.writeText('PXALPHA\tPXBETA\tPXGAMMA'))
  await page.keyboard.press('Control+v')
  await expect(page.getByText(/Pasted/).first()).toBeVisible({ timeout: 5000 })
  await expect(page.getByText('PXALPHA', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('PXBETA', { exact: true }).first()).toBeVisible()

  // item 3b — copy N rows → paste N rows: a multi-row clipboard pasted at a data
  // cell appends that many NEW rows (does not overwrite the loaded rows).
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  await page.evaluate(() =>
    navigator.clipboard.writeText('RZERO\tv0\nRONE\tv1\nRTWO\tv2\nRTHREE\tv3\nRFOUR\tv4'),
  )
  await page.locator('.grid-row td:not(:first-child)').first().click()
  await page.waitForTimeout(100)
  await page.keyboard.press('Control+v')
  await expect(page.getByText(/5 new record/).first()).toBeVisible({ timeout: 5000 })
  // all five copied rows landed as new rows (first & last visible)
  await expect(page.getByText('RZERO', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('RFOUR', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
