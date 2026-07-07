import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// SSMS-style folder filter: the search box is hidden until "Filter…" is picked
// from the folder's context menu; typing narrows the folder's items; "Remove
// Filter" clears it.
test('explorer: Functions folder context-menu Filter reveals input and narrows items', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('Functions', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)

  // demo functions: add_one, current_load (both visible before filtering)
  await expect(page.getByText('add_one').first()).toBeVisible()
  await expect(page.getByText('current_load').first()).toBeVisible()

  // no filter box until the context-menu action
  await expect(page.getByPlaceholder('Filter…')).toHaveCount(0)

  // right-click the Functions folder → Filter…
  await page.getByText('Functions', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(150)
  await page.getByText('Filter…', { exact: true }).first().click()
  await page.waitForTimeout(150)

  // input appears (focused) → type to narrow
  const box = page.getByPlaceholder('Filter…').first()
  await expect(box).toBeVisible()
  await box.fill('add')
  await page.waitForTimeout(150)
  await expect(page.getByText('add_one').first()).toBeVisible()
  await expect(page.getByText('current_load')).toHaveCount(0)

  // Remove Filter via the × restores the full list
  await page.locator('[title="Remove filter"]').first().click()
  await page.waitForTimeout(150)
  await expect(page.getByPlaceholder('Filter…')).toHaveCount(0)
  await expect(page.getByText('current_load').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
