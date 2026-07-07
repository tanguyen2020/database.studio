import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Task 6: Redis workspace exposes a DB dropdown (default db0) to pick which
// logical database to view.
test('redis: DB dropdown defaults to db0 and lists databases', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // double-click connects + opens the Redis workspace
  await page.getByRole('button', { name: /Cache Redis/ }).first().dblclick()
  await page.waitForTimeout(700)

  const dbSelect = page.getByLabel('Redis database')
  await expect(dbSelect).toBeVisible({ timeout: 8000 })
  // default db0
  await expect(dbSelect).toHaveValue('0')
  // dropdown lists multiple databases (demo returns 16)
  const options = dbSelect.locator('option')
  expect(await options.count()).toBeGreaterThan(1)
  await expect(options.first()).toHaveText('db0')

  // switching DB is wired (select db1 → no page error)
  await dbSelect.selectOption('1')
  await page.waitForTimeout(300)
  await expect(dbSelect).toHaveValue('1')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
