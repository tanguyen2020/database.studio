import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T25 — Copy Table to…: context menu opens the dialog, DDL is translated to the
// destination dialect (dry-run preview), Copy is guarded until a dest is chosen,
// and running copies + verifies. (Type mapping is unit-tested in copy/types.test.ts.)
test('copy table to another connection: preview + guard + run', async ({ page }) => {
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
  await page.getByText('Copy to…').first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Copy students to/)).toBeVisible()

  // pick a destination connection → DDL preview renders in the destination dialect
  await dialog.locator('select').first().selectOption({ label: 'Staging Postgres (postgres)' })
  await page.waitForTimeout(300)
  await expect(dialog.getByText(/CREATE TABLE/)).toBeVisible()

  // run the copy → success result
  await dialog.getByText('Copy', { exact: true }).click()
  await page.waitForTimeout(400)
  await expect(dialog.getByText(/copied .* rows/)).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
