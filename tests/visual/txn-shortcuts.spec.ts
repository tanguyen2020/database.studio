import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// AUDIT-2 item 6 — transaction buttons removed from the SQL toolbar.
// Pooling/retry settings section still present (T21).

test('no transaction buttons in SQL toolbar + Connections settings (pool/retry)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  // bound SQL tab (Postgres) → BEGIN/COMMIT/ROLLBACK buttons must NOT exist
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(300)
  await page.getByTitle('New SQL tab (Ctrl+T)').first().click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('button', { name: 'BEGIN', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'COMMIT', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ROLLBACK', exact: true })).toHaveCount(0)

  // Settings → Connections → pool/retry fields
  await page.keyboard.press('Control+,')
  await page.waitForTimeout(200)
  const dialog = page.getByRole('dialog')
  await dialog.getByText('Connections', { exact: true }).first().click()
  await page.waitForTimeout(150)
  await expect(dialog.getByText(/Pool max size/).first()).toBeVisible()
  await expect(dialog.getByText(/Connect retry attempts/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
