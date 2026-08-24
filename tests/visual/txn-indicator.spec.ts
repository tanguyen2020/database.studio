import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// A connection left inside an open transaction keeps ONE snapshot of the data
// (REPEATABLE READ) and hides its writes from other sessions — the state that
// makes the editor look "cached". Running BEGIN must therefore raise a visible
// TXN badge with Commit / Rollback, and ending the transaction must clear it.
test('query editor: open transaction shows a badge until commit/rollback', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(400)

  // Query console bound to the Postgres connection (unique host text).
  await page.getByText('10.0.1.5', { exact: false }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByText('New Query Console', { exact: true }).first().click()
  await page.waitForTimeout(600)

  const badge = page.getByText('⚠ TXN open')
  await expect(badge).toHaveCount(0)

  const editor = page.locator('.view-lines').first()
  await editor.click()
  await page.keyboard.type('BEGIN;')
  await page.keyboard.press('F5')
  await page.waitForTimeout(600)
  await expect(badge).toBeVisible()

  // A plain SELECT inside the transaction keeps the badge up.
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('SELECT 1;')
  await page.keyboard.press('F5')
  await page.waitForTimeout(600)
  await expect(badge).toBeVisible()

  // Rollback from the badge ends the transaction → badge disappears.
  await page.getByRole('button', { name: 'Rollback' }).first().click()
  await page.waitForTimeout(600)
  await expect(badge).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
