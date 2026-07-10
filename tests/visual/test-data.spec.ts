import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T26 — Generate Test Data: per-column generators + preview + run. (Constraint
// handling — NOT NULL / UNIQUE / FK-from-pool — is unit-tested in
// testdata/generate.test.ts + the PG integration test.)
test('generate test data: preview + run', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('students').first().click({ button: 'right' })
  await page.getByText('Generate Test Data…').first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Generate test data · students/)).toBeVisible()
  await expect(dialog.getByText(/Preview/)).toBeVisible()

  // the identity PK is shown as AUTO and excluded by default (DB assigns it)…
  await expect(dialog.getByText(/id\s+int4 PK AUTO/)).toBeVisible()
  // …so it is absent from the generated (preview) columns, while others remain
  const headers = dialog.locator('table.mono thead th')
  await expect(headers.filter({ hasText: /^id$/ })).toHaveCount(0)
  await expect(headers.filter({ hasText: 'first_name' })).toHaveCount(1)
  await expect(headers.filter({ hasText: 'is_active' })).toHaveCount(1)

  // a boolean column offers an explicit value list (true/false or 0/1/2…)
  await expect(dialog.getByPlaceholder('true, false')).toBeVisible()

  await dialog.getByText('Generate', { exact: true }).click()
  await page.waitForTimeout(400)
  await expect(dialog.getByText(/generated .* rows/)).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
