import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Execute a function/procedure: the dialog collects args by signature, and the
// "Execute" button runs the CALL/SELECT immediately (result grid shows output).
// (Call builders are unit-tested in sql/routines.test.ts; execution runs against
// real engines in integration.)
test('execute routine: dialog by signature → Execute runs and shows results', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('Functions', { exact: true }).first().dblclick()
  await page.waitForTimeout(200)
  await page.getByText('add_one').first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('Execute…').first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Execute function add_one/)).toBeVisible()
  await dialog.locator('input').first().fill('41')
  // button is now "Execute" (was "Open in SQL tab")
  await expect(dialog.getByText('Execute', { exact: true })).toBeVisible()
  await dialog.getByText('Execute', { exact: true }).click()
  await page.waitForTimeout(600)

  // a SQL tab opened holding the SELECT add_one(41) AND it auto-ran → result grid
  await expect(page.getByRole('tab', { name: /add_one/ }).first()).toBeVisible()
  await expect(page.locator('.cm-content').first()).toContainText('add_one')
  // the result region shows the executed output (demo exec returns rows)
  await expect(page.getByText(/Single Row/).first()).toBeVisible({ timeout: 8000 })

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
