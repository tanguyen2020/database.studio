import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// AUDIT-5 item 7 — Explorer filter reveals matches (auto-expands folders).
test('explorer filter reveals matching tables + hides others', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)

  await page.getByPlaceholder(/Filter tree/).first().fill('students')
  await page.waitForTimeout(500)
  await expect(page.getByRole('treeitem', { name: /students/ }).first()).toBeVisible() // match auto-revealed
  await expect(page.getByRole('treeitem', { name: /courses/ })).toHaveCount(0) // non-match filtered out

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// AUDIT-5 item 2 — Result Grid has a "No." gutter column (row numbers).
test('result grid shows a No. gutter column', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('SELECT * FROM students')
  await page.getByRole('button', { name: 'Run' }).first().click()
  await page.waitForTimeout(500)

  // the No. gutter is the first cell of each row (row number, right-aligned)
  await expect(page.locator('.grid-row td:first-child').first()).toHaveText('1')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
