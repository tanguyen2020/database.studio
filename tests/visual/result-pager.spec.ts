import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// AUDIT item 1 — Result Grid shows a pager (row range + page-size selector).
test('result grid pager: row range + page size', async ({ page }) => {
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

  // demo returns 3 rows → "Rows 1–3 of 3" + a page-size selector
  await expect(page.getByText(/Rows 1–3 of 3/).first()).toBeVisible()
  await expect(page.getByText('Page size').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
