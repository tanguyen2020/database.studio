import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('redis key explorer renders keys from demo scan', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)
  // double-click the sidebar Redis connection row (accessible name has host)
  const row = page.getByRole('button', { name: /Cache Redis 10\.0\.1\.7/ })
  await row.dblclick()
  await page.waitForTimeout(800)
  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
  // SCAN count header + a prefix folder ('user') should render
  await expect(page.getByText(/SCAN ·/).first()).toBeVisible()
  await expect(page.getByText('leaderboard').first()).toBeVisible()
  await expect(page.getByText('user', { exact: true }).first()).toBeVisible()
})
