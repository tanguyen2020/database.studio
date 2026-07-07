import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('query plan: Explain opens normalized tree + hotspot + summary', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // open a SQL editor on a Postgres connection
  await page.getByRole('button', { name: /Postgres/ }).first().dblclick()
  await page.waitForTimeout(500)
  // type a query then click Explain toolbar button
  const editor = page.locator('.cm-content').first()
  await editor.click()
  await page.keyboard.type('SELECT * FROM enrollments WHERE status = 5')
  await page.getByRole('button', { name: 'Explain' }).first().click()
  await page.waitForTimeout(500)

  // query-plan tab renders normalized nodes + hotspot + summary
  await expect(page.getByRole('tab', { name: /Query Plan/ }).first()).toBeVisible()
  await expect(page.getByText('HashJoin').first()).toBeVisible()
  await expect(page.getByText('SeqScan').first()).toBeVisible()
  await expect(page.getByText('HOTSPOT').first()).toBeVisible()
  await expect(page.getByText(/Seq Scan on enrollments/).first()).toBeVisible()

  // View raw toggles to raw JSON
  await page.getByRole('button', { name: 'View raw' }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/"Node Type"/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
