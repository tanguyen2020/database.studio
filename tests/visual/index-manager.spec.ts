import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T29 — Index/FK Manager tab: lists indexes + FKs, and the create-index form
// builds a live DDL preview. (Engine-aware DDL is unit-tested in sql/indexes.test.ts;
// real CRUD runs against PG + MySQL in integration.)
test('index/FK manager: lists indexes + live CREATE INDEX preview', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByText('Tables', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByText('students').first().click({ button: 'right' })
  await page.getByText('Manage Indexes & FKs…').first().click()
  await page.waitForTimeout(400)

  await expect(page.getByText('Indexes & Foreign Keys · students')).toBeVisible()
  await expect(page.getByText('idx_students_gpa')).toBeVisible() // existing index listed

  // pick a column in the create-index form → live CREATE INDEX preview
  await page.locator('label:has-text("first_name") input[type="checkbox"]').first().check()
  await page.waitForTimeout(150)
  await expect(page.getByText(/CREATE INDEX/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
