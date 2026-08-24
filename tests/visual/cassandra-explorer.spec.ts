import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Phase C2 — Explorer lists EVERY keyspace (not just one) and offers "View DDL"
// for any object kind (reconstructed CQL), plus Copy Name.
test('cassandra: multi-keyspace tree + View DDL', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  await page.getByRole('button', { name: /Profiles Cassandra/ }).dblclick()
  await page.waitForTimeout(600)

  // both keyspaces render (multi-keyspace, not just the default)
  await expect(page.getByText('campus_ks').first()).toBeVisible()
  await expect(page.getByText('library_ks').first()).toBeVisible()

  // expand default keyspace → Tables → a table
  await page.getByText('campus_ks').first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await expect(page.getByText('students_by_id').first()).toBeVisible()

  // right-click table → View DDL (CQL) → opens a DDL tab with CREATE TABLE
  await page.getByText('students_by_id').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'View DDL (CQL)' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('tab', { name: /students_by_id DDL/ }).first()).toBeVisible()
  await expect(page.locator('.view-lines').first()).toContainText('CREATE TABLE')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
