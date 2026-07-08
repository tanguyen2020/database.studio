import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Redis key browser lives in the ObjectExplorer sidebar (no workspace tab on
// connect). Clicking a key opens a per-key viewer tab with View JSON + Copy.
test('redis: key browser in explorer, click key opens viewer with View JSON/Copy', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  // select the Redis connection — the key browser appears in the sidebar
  await page.getByRole('button', { name: /Cache Redis 10\.0\.1\.7/ }).dblclick()
  await page.waitForTimeout(700)

  // key browser header (SCAN count) + tree render in the sidebar
  await expect(page.getByText(/SCAN ·/).first()).toBeVisible({ timeout: 8000 })
  await expect(page.getByText('leaderboard').first()).toBeVisible()
  await expect(page.getByText('user', { exact: true }).first()).toBeVisible()

  // click a key → opens a redis-key viewer tab
  await page.getByText('leaderboard').first().click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('tab', { name: /leaderboard · key/ }).first()).toBeVisible()

  // value grid shows members + View JSON + Copy actions per value
  await expect(page.getByText('an', { exact: true }).first()).toBeVisible()
  await expect(page.getByTitle('View as JSON').first()).toBeVisible()
  await expect(page.getByTitle('Copy value').first()).toBeVisible()

  // open the JSON viewer popup, then close it
  await page.getByTitle('View as JSON').first().click()
  await page.waitForTimeout(150)
  await page.getByText('Close', { exact: true }).first().click()
  await page.waitForTimeout(150)

  // the "+ Add" button was removed
  await expect(page.getByText('+ Add', { exact: true })).toHaveCount(0)

  // Set TTL opens a form (dialog with an input), not a native prompt
  await page.getByText('Set TTL', { exact: true }).first().click()
  await page.waitForTimeout(150)
  const ttlDlg = page.getByRole('dialog')
  await expect(ttlDlg.getByText('Set TTL', { exact: true })).toBeVisible()
  await expect(ttlDlg.getByPlaceholder(/no expiry/)).toBeVisible()
  await ttlDlg.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForTimeout(150)

  // Delete shows an in-app confirm popup before deleting
  await page.getByText('Delete', { exact: true }).first().click()
  await page.waitForTimeout(150)
  await expect(page.getByRole('dialog').getByText('Delete key', { exact: true })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Add key dialog: pick type, enter name/data/TTL.
test('redis: add key dialog opens from the explorer header', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  await page.getByRole('button', { name: /Cache Redis 10\.0\.1\.7/ }).dblclick()
  await page.waitForTimeout(700)

  await page.getByText('＋ Key', { exact: true }).first().click()
  await page.waitForTimeout(150)
  await expect(page.getByText('Add key', { exact: true })).toBeVisible()
  await page.getByPlaceholder('key name (e.g. user:42)').fill('greeting')
  await expect(page.getByText('Create', { exact: true }).first()).toBeVisible()

  // global rule: clicking the backdrop (outside the form) must NOT close it
  await page.mouse.click(8, 8)
  await page.waitForTimeout(150)
  await expect(page.getByText('Add key', { exact: true })).toBeVisible()

  // close via the Cancel button, then Pub/Sub is reachable from the explorer header
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await page.waitForTimeout(150)
  await page.getByText('Pub/Sub ▸').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('Pub/Sub Monitor')).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
