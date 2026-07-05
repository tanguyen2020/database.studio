import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('clickhouse ops: table context menu → generated SQL editor', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // ClickHouse connection → Explorer → expand schema/Tables
  await page.getByRole('button', { name: /Analytics ClickHouse/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)

  // right-click a table → advanced ops menu
  await page.getByText('students').first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await expect(page.getByText('Optimize Table (FINAL)').first()).toBeVisible()
  await expect(page.getByText('Show Partitions').first()).toBeVisible()
  await expect(page.getByText('Show Mutations').first()).toBeVisible()
  await expect(page.getByText('Drop Partition…').first()).toBeVisible()

  // click Optimize → SQL editor tab with OPTIMIZE ... FINAL
  await page.getByText('Optimize Table (FINAL)').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText(/OPTIMIZE TABLE/).first()).toBeVisible()

  // Dictionaries node (§3 clickhouseTree) → expand → Show Definition
  await page.getByText('Dictionaries', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await expect(page.getByText('geo_regions').first()).toBeVisible()
  await page.getByText('geo_regions').first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await expect(page.getByText('Show Definition').first()).toBeVisible()
  await page.getByText('Show Definition').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByText(/SHOW CREATE DICTIONARY/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
