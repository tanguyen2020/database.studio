import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

test('cassandra: CQL editor + keyspace tree + Ring topology', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  // double-click sidebar Cassandra connection → connect + open CQL editor
  const row = page.getByRole('button', { name: /Profiles Cassandra/ })
  await row.dblclick()
  await page.waitForTimeout(600)

  // CQL editor tab title "Untitled CQL"
  await expect(page.getByRole('tab', { name: /Untitled CQL/ }).first()).toBeVisible()
  // Ring button chỉ hiện cho Cassandra
  await expect(page.getByRole('button', { name: 'Ring' }).first()).toBeVisible()

  // keyspace tree: campus_ks + Tables + partition/clustering meta
  await expect(page.getByText('campus_ks').first()).toBeVisible()
  await page.getByText('campus_ks').first().click()
  await page.waitForTimeout(200)
  await page.getByText('Tables', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText('students_by_id').first()).toBeVisible()
  await page.getByText('grades_by_student').first().click()
  await page.waitForTimeout(200)
  // clustering column meta " · CK"
  await expect(page.getByText(/· CK/).first()).toBeVisible()

  // Ring Topology: open + real nodes render (dùng text riêng của workspace body)
  await page.getByRole('button', { name: 'Ring' }).first().click()
  await page.waitForTimeout(500)
  await expect(page.getByText(/nodes UP/).first()).toBeVisible()
  await expect(page.getByText(/dc1\(2\)/).first()).toBeVisible()
  await expect(page.getByText('10.0.5.1').last()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
