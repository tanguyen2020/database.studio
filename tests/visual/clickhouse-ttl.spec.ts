import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('clickhouse: engine badge + TTL Policy viewer', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select the ClickHouse connection (single click → Explorer loads its tree)
  await page.getByRole('button', { name: /Analytics ClickHouse/ }).first().click()
  await page.waitForTimeout(500)

  // expand schema → Tables → engine badge on a table row (MergeTree)
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText('students').first()).toBeVisible()
  await expect(page.getByText('MergeTree').first()).toBeVisible()

  // right-click a table → TTL Policy… → modal with DELETE + MOVE rules
  await page.getByText('students').first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('TTL Policy…').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText(/TTL Policy —/).first()).toBeVisible()
  await expect(page.getByText('DELETE').first()).toBeVisible()
  await expect(page.getByText('MOVE').first()).toBeVisible()
  await expect(page.getByText('MATERIALIZE TTL').first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
