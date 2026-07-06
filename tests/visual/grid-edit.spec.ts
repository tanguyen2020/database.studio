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
