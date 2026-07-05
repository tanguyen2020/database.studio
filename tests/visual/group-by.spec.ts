import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T27 — Result Grid Group By popover: pick columns + aggregate → collapsible
// group tree with a grand total. (Multi-column grouping + aggregates are covered
// exhaustively by the pure unit tests in grid/groupby.test.ts.)
test('result grid group by: popover groups rows with a grand total', async ({ page }) => {
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

  // open the Group By popover in the pager and group by the first column
  await page.getByText(/Group by/).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.waitForTimeout(200)

  // grouped view: grand total over all 3 demo rows
  await expect(page.getByText('Σ Grand total')).toBeVisible()
  await expect(page.getByText(/3 rows/).first()).toBeVisible()

  // clearing grouping returns to the table
  await page.getByText('✕').first().click()
  await page.waitForTimeout(150)
  await expect(page.getByText('Σ Grand total')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
