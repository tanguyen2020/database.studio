import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('schema compare: pick source/target + diff view + sync script', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // open via Command Palette → Compare schemas…
  await page.keyboard.press('Control+p')
  await page.waitForTimeout(150)
  await page.getByPlaceholder('Type a command or search…').fill('compare')
  await page.waitForTimeout(150)
  await page.getByText('Compare schemas…').first().click()
  await page.waitForTimeout(300)

  await expect(page.getByRole('tab', { name: /Schema Compare/ }).first()).toBeVisible()
  // pick two same-system (postgres) connections
  const selects = page.locator('select')
  await selects.nth(0).selectOption({ label: 'Postgres (postgres)' })
  await page.waitForTimeout(200)
  await selects.nth(1).selectOption({ label: 'Staging Postgres (postgres)' })
  await page.waitForTimeout(500)

  // diff toolbar badges render (add/changed/delete counts)
  await expect(page.getByText(/add$/).first()).toBeVisible()
  await expect(page.getByText(/changed$/).first()).toBeVisible()
  // Sync Script mode shows migration pre
  await page.getByText('Sync Script', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Migration đồng bộ TARGET/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
