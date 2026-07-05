import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// T22 — Backup & Restore dialog from the Explorer toolbar.

test('backup dialog: tool status + backup now + history', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(400)
  await page.getByTitle('Backup & Restore').first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Backup & Restore ·/)).toBeVisible()
  await expect(dialog.getByText(/Công cụ:/).first()).toBeVisible()
  await expect(dialog.getByText('Destination file')).toBeVisible()

  await dialog.getByRole('button', { name: 'Backup now' }).click()
  await page.waitForTimeout(300)
  await expect(dialog.getByText(/backup →/).first()).toBeVisible()
  // history entry recorded
  await expect(dialog.getByText('History')).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
