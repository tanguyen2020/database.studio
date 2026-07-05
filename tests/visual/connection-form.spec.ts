import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Audit: New-connection form — buttons phải hoạt động (no effect loop), bỏ Group,
// text tiếng Anh.
test('connection form: buttons work, no Group field, English', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByTitle('New connection').first().click()
  await page.waitForTimeout(200)
  await page.locator('.picker-card').first().click() // PostgreSQL
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('New connection', { exact: true })).toBeVisible()

  // #4-audit: Group field đã bỏ
  await expect(dialog.getByText('Group', { exact: true })).toHaveCount(0)

  // buttons hoạt động: SSH toggle → panel SSH hiện
  await dialog.getByText('SSH Tunnel').first().click()
  await page.waitForTimeout(150)
  await expect(dialog.getByText(/Auth|Jump|SSH Host|Password/i).first()).toBeVisible()

  // Test button clickable (không văng lỗi)
  await dialog.getByText('Test', { exact: true }).first().click()
  await page.waitForTimeout(150)

  // Cancel đóng form
  await dialog.getByText('Cancel', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByRole('dialog').getByText('New connection', { exact: true })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
