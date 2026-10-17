import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Query Editor result grid: the page-size selector topped out at 1000, so a
// bigger result could only be walked page by page. "All (N)" shows every
// fetched row on one page — the grid is virtualised, so it still only renders
// what is on screen.
test('result grid: Page size "All" shows every fetched row on one page', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(200)
  await openDatabaseNode(page)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(200)
  await page.locator('.view-lines').first().click()
  await page.keyboard.type('SELECT * FROM perf_rows_5000')
  await page.getByRole('button', { name: 'Run' }).first().click()

  await expect(page.getByText(/Rows 1–200 of 5,000/).first()).toBeVisible({ timeout: 15_000 })
  const size = page.locator('select').filter({ has: page.locator('option', { hasText: 'All (5,000)' }) }).first()
  await expect(size).toBeVisible()
  // the old ceiling is still an option, and is no longer the maximum
  await expect(size.locator('option')).toHaveText(['100', '200', '500', '1000', 'All (5,000)'])

  await size.selectOption({ label: 'All (5,000)' })
  await expect(page.getByText(/Rows 1–5,000 of 5,000/).first()).toBeVisible()
  // one page → no pager buttons
  await expect(page.getByText(/Page \d+ \//)).toHaveCount(0)

  // virtualised: only a screenful of rows is in the DOM, yet the last row is reachable
  const rendered = await page.locator('tbody tr').count()
  expect(rendered).toBeLessThan(200)
  await page.locator('tbody').first().evaluate((tb) => {
    let el: HTMLElement | null = tb.parentElement
    while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement
    if (el) el.scrollTop = el.scrollHeight
  })
  await expect(page.locator('tbody td', { hasText: /^5000$/ }).first()).toBeVisible({ timeout: 5000 })

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
