import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// A column/table whose name is a reserved word (here `order`) must be inserted
// QUOTED by autocomplete, or the query/JOIN is a syntax error. Postgres → "order".
test('autocomplete quotes a reserved-word column on insert', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(600)

  const content = page.locator('.cm-content').first()
  await content.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  // reference the table via an alias so the `alias.` column completion kicks in
  await page.keyboard.type('SELECT * FROM students s WHERE s.or')
  await page.waitForTimeout(600)

  const tip = page.locator('.cm-tooltip-autocomplete')
  await expect(tip).toBeVisible({ timeout: 3000 })
  const option = tip.getByText('order', { exact: true }).first()
  await expect(option).toBeVisible()
  // accept the completion → should insert the QUOTED identifier
  await option.click()
  await page.waitForTimeout(200)

  await expect(content).toContainText('s."order"')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
