import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('index scanner: table + health flags + filter', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select Postgres → Explorer → right-click schema → Scan Indexes
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Scan Indexes').first().click()
  await page.waitForTimeout(400)

  await expect(page.getByRole('tab', { name: /Indexes · public/ }).first()).toBeVisible()
  // rows + health badges
  await expect(page.getByText('students_pkey').first()).toBeVisible()
  await expect(page.getByText('unused').first()).toBeVisible()
  await expect(page.getByText('redundant').first()).toBeVisible()

  // T17 — missing-index suggestions section
  await expect(page.getByText(/Missing-index suggestions/).first()).toBeVisible()

  // filter to Unused → only the unused index row remains
  await page.getByRole('button', { name: /Unused 1/ }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText('idx_students_name').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
