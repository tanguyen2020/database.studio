import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('table designer: columns grid + DDL preview + add column', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // select a Postgres connection so Explorer loads, then "New table" bottom button
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByTitle('New table').first().click()
  await page.waitForTimeout(300)

  // designer tab open with columns grid (seeded id PK row)
  await expect(page.getByRole('tab', { name: /new_table · design/ }).first()).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Column' }).first()).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Nullable' }).first()).toBeVisible()

  // add a column
  await page.getByText('＋ Add column').first().click()
  await page.waitForTimeout(150)

  // Scripts mode → DDL preview shows CREATE TABLE
  await page.getByText('Scripts', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/CREATE TABLE/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
