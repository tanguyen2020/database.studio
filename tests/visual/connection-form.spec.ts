import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// Audit: New-connection form — buttons must work (no effect loop), no Group field,
// English text.
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

  // #4-audit: Group field removed
  await expect(dialog.getByText('Group', { exact: true })).toHaveCount(0)

  // buttons work: SSH toggle → SSH panel shows
  await dialog.getByText('SSH Tunnel').first().click()
  await page.waitForTimeout(150)
  await expect(dialog.getByText(/Auth|Jump|SSH Host|Password/i).first()).toBeVisible()

  // Test connection button clickable (no thrown error)
  await dialog.getByText('Test connection', { exact: true }).first().click()
  await page.waitForTimeout(150)

  // Cancel closes the form
  await dialog.getByText('Cancel', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByRole('dialog').getByText('New connection', { exact: true })).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Kafka connect via IP + Port: the form must offer a Host and a Port field (not a
// single bootstrap box) with the default 9092 port prefilled.
test('connection form: Kafka has Host + Port fields (default 9092)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)

  await page.getByTitle('New connection').first().click()
  await page.waitForTimeout(200)
  await page.locator('.picker-card').filter({ hasText: 'Kafka' }).first().click()
  await page.waitForTimeout(300)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Host / Bootstrap')).toBeVisible()
  await expect(dialog.getByText('Port', { exact: true })).toBeVisible()
  // port field prefilled with the Kafka default
  await expect(dialog.locator('input[type="number"]').first()).toHaveValue('9092')

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
